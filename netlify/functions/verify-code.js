// /netlify/functions/verify-code.js
// FlexRoute — verifies a one-time code and issues a session token.
//
// Session tokens are opaque random strings, stored server-side (Blobs,
// store "sessions") mapped to the verified email, with a long expiry
// (180 days) since re-verifying mid-shift is the worst possible moment for
// a driver to need to stop and check email. The token itself is what the
// client persists in localStorage ('fr_session_token') — losing it just
// means re-verifying via email again, not losing paid status (Stripe is
// still the source of truth for that, keyed by email).

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }

async function handleVerifyCode(body, otpStore, sessionStore) {
  const email = normalizeEmail(body.email);
  const code = (body.code || '').trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return { statusCode: 400, body: { error: 'Invalid request', code: 'BAD_INPUT' } };
  }

  let record;
  try { record = await otpStore.get(email, { type: 'json' }); }
  catch (e) {
    console.error('[FlexRoute] verify-code read error:', e && e.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }

  if (!record) {
    return { statusCode: 400, body: { error: 'No code requested for this email', code: 'NO_CODE' } };
  }
  if (Date.now() > record.expiresAt) {
    return { statusCode: 400, body: { error: 'Code expired — request a new one', code: 'EXPIRED' } };
  }
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    return { statusCode: 429, body: { error: 'Too many attempts — request a new code', code: 'TOO_MANY_ATTEMPTS' } };
  }

  if (record.code !== code) {
    // Record the failed attempt so MAX_ATTEMPTS actually limits brute-forcing
    // a 6-digit code (1,000,000 possibilities — trivially guessable without
    // a rate limit on attempts).
    try {
      await otpStore.setJSON(email, Object.assign({}, record, { attempts: (record.attempts || 0) + 1 }));
    } catch (e) { /* non-fatal — worst case attempts counter doesn't increment this one time */ }
    return { statusCode: 400, body: { error: 'Incorrect code', code: 'WRONG_CODE' } };
  }

  // Correct code — issue a session token and clear the OTP record so it
  // can't be reused.
  const token = crypto.randomBytes(32).toString('hex');
  try {
    await sessionStore.setJSON(token, { email, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    await otpStore.delete(email);
  } catch (e) {
    console.error('[FlexRoute] verify-code write error:', e && e.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }

  return { statusCode: 200, body: { token: token, email: email } };
}

exports.handler = async function(event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }};
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed', code: 'METHOD' }) };
  }
  if (!isAuthorizedOrigin(event)) {
    logRejected('verify-code', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const otpStore = getStore({ name: 'otp', consistency: 'strong' });
  const sessionStore = getStore({ name: 'sessions', consistency: 'strong' });
  const result = await handleVerifyCode(body, otpStore, sessionStore);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleVerifyCode = handleVerifyCode;
