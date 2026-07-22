// /netlify/functions/verify-code.js
// FlexRoute — verifies a one-time code and issues a session token.

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

function blobOpts(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token = process.env.BLOBS_TOKEN;
  }
  return opts;
}

function normalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

async function handleVerifyCode(body, otpStore, sessionStore) {
  const email = normalizeEmail(body.email);
  const code = (body.code || '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return { statusCode: 400, body: { error: 'Invalid request', code: 'BAD_INPUT' } };
  }

  let record;
  try {
    record = await otpStore.get(email, { type: 'json' });
  } catch (e) {
    console.error('[FlexRoute] verify-code read error:', e?.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }

  if (!record) {
    return { statusCode: 400, body: { error: 'No code requested for this email', code: 'NO_CODE' } };
  }

  const now = Date.now();

  if (now > record.expiresAt) {
    return { statusCode: 400, body: { error: 'Code expired — request a new one', code: 'EXPIRED' } };
  }

  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    return { statusCode: 429, body: { error: 'Too many attempts — request a new code', code: 'TOO_MANY_ATTEMPTS' } };
  }

  if (record.code !== code) {
    // Increment failed attempts
    try {
      await otpStore.setJSON(email, {
        ...record,
        attempts: (record.attempts || 0) + 1
      });
    } catch (e) {
      // Non-fatal — worst case attempts counter doesn't increment
    }
    return { statusCode: 400, body: { error: 'Incorrect code', code: 'WRONG_CODE' } };
  }

  // Correct code — issue session token and clear OTP
  const token = crypto.randomBytes(32).toString('hex');

  try {
    await sessionStore.setJSON(token, {
      email,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });
    await otpStore.delete(email);
  } catch (e) {
    console.error('[FlexRoute] verify-code write error:', e?.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }

  return { statusCode: 200, body: { token, email } };
}

exports.handler = async function (event) {
  // Ensure Blobs context is available
  try {
    connectLambda(event);
  } catch {
    // Local dev — ignore
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: 'Method not allowed', code: 'METHOD' })
    };
  }

  if (!isAuthorizedOrigin(event)) {
    logRejected('verify-code', event);
    return {
      statusCode: 403,
      headers: cors,
      body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' })
    };
  }

  const otpStore = getStore(blobOpts('otp'));
  const sessionStore = getStore(blobOpts('sessions'));

  const result = await handleVerifyCode(body, otpStore, sessionStore);

  return {
    statusCode: result.statusCode,
    headers: cors,
    body: JSON.stringify(result.body)
  };
};

exports._handleVerifyCode = handleVerifyCode;
