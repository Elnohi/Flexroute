// /netlify/functions/trial-status.js
// FlexRoute — server-side trial tracking, keyed by EMAIL, not device.
//
// Why this exists:
//   The original trial gate only checked localStorage ('fr_entitlement').
//   That's trivially bypassed by clearing browser data or using a new
//   browser/device — and once email registration exists, it's ALSO
//   bypassable by registering a new email each time (Gmail '+' aliases
//   make this nearly free for an abuser). This function makes the email
//   the durable record, stored server-side, so neither bypass works on
//   its own. It is still not bulletproof — a person willing to use a
//   genuinely different real email each time can still get repeat trials
//   — but it stops the casual/cheap bypasses (clearing cookies, '+'
//   aliases on one inbox), which is the realistic threat model for a
//   $9-15/month product, not state-level fraud prevention.
//
// Contract:
//   POST /.netlify/functions/trial-status
//   Body: { email: "<verified email>", action: "check" | "consume" }
//   Response (200): { trialUsed: boolean }
//   Response (4xx/5xx): { error, code }
//
// Storage: Netlify Blobs, store name "trials", one key per normalized email,
// value is a small JSON record (so we can extend it later — e.g. timestamp,
// stop count — without a schema migration).

const { getStore } = require('@netlify/blobs');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

function normalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

// Basic sanity check — full RFC 5322 validation isn't the point here, just
// rejecting obviously-malformed input before it becomes a storage key.
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Core logic, store passed in — this separation exists so the actual
// business logic (validation, normalization, idempotency) can be unit
// tested with a fake in-memory store, without needing a live Netlify Blobs
// environment or fighting the module's read-only export bindings.
async function handleTrialRequest(body, store) {
  const email = normalizeEmail(body.email);
  const action = body.action;
  if (!email || !isPlausibleEmail(email)) {
    return { statusCode: 400, body: { error: 'Invalid email', code: 'BAD_EMAIL' } };
  }
  if (action !== 'check' && action !== 'consume') {
    return { statusCode: 400, body: { error: 'Invalid action', code: 'BAD_ACTION' } };
  }

  try {
    if (action === 'check') {
      const existing = await store.get(email, { type: 'json' });
      return { statusCode: 200, body: { trialUsed: !!(existing && existing.used) } };
    }
    // action === 'consume'
    const existing = await store.get(email, { type: 'json' });
    if (existing && existing.used) {
      // Already consumed — idempotent, not an error. Lets the client
      // safely call this even if it's not 100% sure whether a prior
      // request already went through (e.g. after a flaky connection).
      return { statusCode: 200, body: { trialUsed: true } };
    }
    await store.setJSON(email, { used: true, consumedAt: new Date().toISOString() });
    return { statusCode: 200, body: { trialUsed: true } };
  } catch (e) {
    console.error('[FlexRoute] trial-status storage error:', e && e.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }
}

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
  if (!isAuthorizedOrigin(event)) {
    logRejected('trial-status', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  // Strong consistency: this is exactly the kind of read where a stale
  // "trial available" result (from the default eventual-consistency cache)
  // could let someone slip through in the ~60s propagation window right
  // after a 'consume' write. The cost is a slightly slower read, which is
  // fine here — this isn't a hot path called many times per second.
  const store = getStore({ name: 'trials', consistency: 'strong' });
  const result = await handleTrialRequest(body, store);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

// Exported for testing only — not used by the Netlify Functions runtime.
exports._handleTrialRequest = handleTrialRequest;
exports._normalizeEmail = normalizeEmail;
exports._isPlausibleEmail = isPlausibleEmail;
