// /netlify/functions/_originCheck.js
// FlexRoute — shared origin/referer gate for paid/costed backend functions.
//
// Why this exists:
//   ocr.js (Google Vision, billed per call) and geocode.js (Nominatim/Census,
//   rate-limited per IP) are reachable by anyone who finds the endpoint URL —
//   which is visible in any browser's Network tab. verify.js only protects
//   the *frontend UI*; a cloned copy of flexroute.html with that check deleted
//   could still call these two functions directly and run up our Vision bill
//   or burn our shared Nominatim rate-limit bucket. This closes that gap by
//   checking Origin/Referer server-side, where a clone can't bypass it by
//   editing client-side JS.
//
// This is NOT meant to replace verify.js — it's meant to make the backend
// functions themselves refuse to serve a clone, even if the clone's frontend
// never calls verify.js or ignores its result.
//
// Usage in a handler:
//   const { isAuthorizedOrigin } = require('./_originCheck');
//   if (!isAuthorizedOrigin(event)) {
//     return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
//   }
//
// ── Developer bypass ─────────────────────────────────────────────────────────
// To review/test the app on melodious-strudel without touching the origin
// whitelist, set the Netlify env var DEV_BYPASS_KEY to any secret string.
// The app reads ?devkey=<value> from the URL, stores it in sessionStorage,
// and sends it as X-Dev-Key on every fetch call to Netlify functions.
// _originCheck.js then allows the request if the header matches DEV_BYPASS_KEY.
//
// To permanently remove the bypass after production:
//   1. Delete DEV_BYPASS_KEY from Netlify env vars
//   2. Delete the <!-- DEV BYPASS --> block from flexroute.html (marked below)
// The check below is completely inert if DEV_BYPASS_KEY is not set.
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORIZED_ORIGINS = [
  'flexrouteapp.com',
  'www.flexrouteapp.com',
];

// Allow localhost / 127.0.0.1 so local development isn't broken.
const DEV_HOSTS = ['localhost', '127.0.0.1'];

function hostFromHeader(raw) {
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
}

function isAuthorizedHost(host) {
  if (!host) return false;
  if (DEV_HOSTS.includes(host)) return true;
  return AUTHORIZED_ORIGINS.some(a => host === a || host.endsWith('.' + a));
}

// Dev bypass — checks X-Dev-Key header against DEV_BYPASS_KEY env var.
// Returns true only if both sides are non-empty and match exactly.
// Completely inert when DEV_BYPASS_KEY env var is not set.
function isDevBypass(event) {
  const envKey = process.env.DEV_BYPASS_KEY;
  if (!envKey) return false;
  const headers = event.headers || {};
  const sentKey = headers['x-dev-key'] || headers['X-Dev-Key'] || '';
  return sentKey.length > 0 && sentKey === envKey;
}

function isAuthorizedOrigin(event) {
  if (isDevBypass(event)) return true;
  const headers = event.headers || {};
  const origin  = hostFromHeader(headers.origin  || headers.Origin);
  const referer  = hostFromHeader(headers.referer || headers.Referer);
  return isAuthorizedHost(origin) || isAuthorizedHost(referer);
}

function logRejected(fnName, event) {
  console.warn('[FlexRoute] Rejected origin for ' + fnName + ':', {
    origin:  event.headers && (event.headers.origin  || event.headers.Origin)  || '',
    referer: event.headers && (event.headers.referer || event.headers.Referer) || '',
    ip:      event.headers && event.headers['x-forwarded-for'] || 'unknown',
    time:    new Date().toISOString()
  });
}

module.exports = { isAuthorizedOrigin, logRejected, AUTHORIZED_ORIGINS };
