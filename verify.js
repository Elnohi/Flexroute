/*
 * FlexRoute — Domain Verification Function
 * Copyright © 2026 FlexRoute. All rights reserved.
 *
 * Deployed at: flexrouteapp.com/.netlify/functions/verify
 *
 * Verifies that the app is running on an authorized domain.
 * Returns { ok: true } for authorized origins, { ok: false } otherwise.
 */

const AUTHORIZED_ORIGINS = [
  'flexrouteapp.com',
  'www.flexrouteapp.com',
];

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://flexrouteapp.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, reason: 'method_not_allowed' })
    };
  }

  // Extract the requesting origin/host
  const origin  = (event.headers['origin']  || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  const referer = (event.headers['referer'] || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

  // Parse the body for the host claim
  let bodyClaim = '';
  try {
    const body = JSON.parse(event.body || '{}');
    bodyClaim = (body.host || '').toLowerCase();
  } catch(e) {}

  const candidates = [origin, referer, bodyClaim].filter(Boolean);

  const authorized = candidates.some(c =>
    AUTHORIZED_ORIGINS.some(a => c === a || c.endsWith('.' + a))
  );

  // Log unauthorized attempts (visible in Netlify function logs)
  if (!authorized) {
    console.warn('[FlexRoute] Unauthorized deployment attempt:', {
      origin, referer, bodyClaim,
      ip: event.headers['x-forwarded-for'] || 'unknown',
      time: new Date().toISOString()
    });
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: authorized,
      ...(authorized ? {} : { reason: 'unauthorized_origin' })
    })
  };
};
