// /netlify/functions/geocode.js
// FlexRoute geocoding proxy — handles Nominatim AND Census Bureau
//
// Why this exists:
//   Browsers can't call Nominatim or Census Bureau directly because those
//   services return 429/403 responses without CORS headers when rate-limited.
//   By proxying through this Netlify function:
//     - Server-to-server requests bypass CORS entirely
//     - Each Netlify deploy has a different IP than end users (separate rate
//       limit bucket from the user's home IP)
//     - We can centralize identifying User-Agent (Nominatim requires this)
//
// Origin gate: a clone hot-linking this endpoint would burn our shared
// Nominatim/Census rate-limit bucket for every real user — see
// _originCheck.js for why this exists alongside verify.js.
//
// Contract:
//   POST /.netlify/functions/geocode
//   Body: {
//     provider: "nominatim" | "census",
//     query: "<address string>",
//     countrycodes: "us" (nominatim only, optional),
//     viewbox: "minLon,maxLat,maxLon,minLat" (nominatim only, optional),
//     state: "IN" (census only, optional — added if address lacks a state)
//   }
//   Response (200): { results: [{ lat, lon, display_name }] }   // 0+ results
//   Response (4xx/5xx): { error, code }

const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CENSUS_URL    = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
// Per-provider timeouts:
//   Nominatim: 3s. When it works, it answers in <300ms. When it rate-limits
//     us (429), it returns immediately. The only slow case is genuine network
//     latency, where 3s is plenty. Was 10s — that was wasting ~7s per failed
//     call during rapid scan bursts (37 stops = many failures = >2 min wasted).
//   Census Bureau: 8s. This one occasionally takes 4-6s for rare/rural
//     addresses but is the workhorse for rescue, so we let it breathe.
const TIMEOUT_NOMINATIM = 3000;
const TIMEOUT_CENSUS    = 8000;
// Nominatim usage policy requires identifying User-Agent with contact info.
// https://operations.osmfoundation.org/policies/nominatim/
const USER_AGENT    = 'FlexRoute/1.0 (https://flexrouteapp.com; flexrouteapp@gmail.com)';

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }};
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed', code: 'METHOD' }) };
  }

  // Reject requests not coming from flexrouteapp.com BEFORE calling Nominatim
  // or Census (shared rate-limit bucket, paid-in-effort to keep healthy).
  // A cloned frontend with verify.js stripped out would still hit this check.
  if (!isAuthorizedOrigin(event)) {
    logRejected('geocode', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const provider = body.provider;
  const query    = (body.query || '').trim();
  if (!query) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing query', code: 'NO_QUERY' }) };
  if (provider !== 'nominatim' && provider !== 'census') {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid provider', code: 'BAD_PROVIDER' }) };
  }

  // Build upstream URL based on provider
  let url, headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
  if (provider === 'nominatim') {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '5',
      'accept-language': 'en'
    });
    if (body.countrycodes) params.set('countrycodes', body.countrycodes);
    if (body.viewbox)      params.set('viewbox', body.viewbox);
    url = NOMINATIM_URL + '?' + params.toString();
  } else {
    // Census Bureau: build one-line address. If state provided AND query
    // doesn't already include a 2-letter state, append it.
    let addrForCensus = query;
    if (body.state && !/,\s*[A-Z]{2}\b/.test(addrForCensus)) {
      addrForCensus = addrForCensus + ', ' + body.state;
    }
    const params = new URLSearchParams({
      address: addrForCensus,
      benchmark: 'Public_AR_Current',
      format: 'json'
    });
    url = CENSUS_URL + '?' + params.toString();
  }

  // Call upstream with timeout
  const ctrl = new AbortController();
  // Pick timeout based on provider (Nominatim short, Census longer)
  const timeoutMs = provider === 'census' ? TIMEOUT_CENSUS : TIMEOUT_NOMINATIM;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { headers, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const code = (e && e.name === 'AbortError') ? 'TIMEOUT' : 'UPSTREAM';
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Geocoder unreachable', code, provider }) };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    // Pass 429 back as 429 (not 502) so the Netlify dashboard can distinguish
    // rate-limit hits from genuine upstream failures, and so callers can
    // differentiate "try again later" from "geocoder is down".
    const outStatus = resp.status === 429 ? 429 : 502;
    return {
      statusCode: outStatus,
      headers: cors,
      body: JSON.stringify({
        error: 'Geocoder error',
        code: resp.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM_' + resp.status,
        provider,
        upstream_status: resp.status
      })
    };
  }

  let data;
  try { data = await resp.json(); }
  catch (e) { return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Bad JSON from geocoder', code: 'PARSE', provider }) }; }

  // Normalize response so client doesn't care which provider was used
  let results = [];
  if (provider === 'nominatim') {
    // Nominatim returns an array of {lat, lon, display_name, ...}
    if (Array.isArray(data)) {
      results = data.map(r => ({
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        display_name: r.display_name || ''
      })).filter(r => isFinite(r.lat) && isFinite(r.lon));
    }
  } else {
    // Census Bureau: data.result.addressMatches[]
    const matches = data && data.result && data.result.addressMatches;
    if (Array.isArray(matches)) {
      results = matches.map(m => ({
        lat: m.coordinates && m.coordinates.y,
        lon: m.coordinates && m.coordinates.x,
        display_name: m.matchedAddress || ''
      })).filter(r => isFinite(r.lat) && isFinite(r.lon));
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ results, provider }) };
};
