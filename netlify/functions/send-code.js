// /netlify/functions/send-code.js
// FlexRoute — sends a 6-digit one-time login code to an email address.
//
// Storage: Netlify Blobs, store "otp", key = normalized email, value =
// { code, expiresAt }. A fresh send overwrites any prior unexpired code.
//
// EMAIL SENDING IS STUBBED. Wire in a real provider (Resend, SendGrid,
// Postmark — any with an HTTP API) where marked below. Until that's done,
// this function still stores the code, but no email is actually sent — for
// local/manual testing you can read the code back out of the Blobs UI in
// the Netlify dashboard.

const { getStore, connectLambda } = require('@netlify/blobs');

// Build Blobs store options. Netlify's automatic context injection is
// unreliable on this site (see MissingBlobsEnvironmentError), so when
// BLOBS_SITE_ID + BLOBS_TOKEN env vars are set we configure Blobs manually —
// the officially documented fallback. connectLambda remains as a best-effort
// for environments where injection does work.
function blobOpts(name) {
  var opts = { name: name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token  = process.env.BLOBS_TOKEN;
  }
  return opts;
}

const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // prevent rapid-fire resend spam

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, no leading zero issue
}

async function sendEmail(email, code) {
  // ── REPLACE THIS BLOCK with a real provider call ──────────────────────
  // Example using Resend (https://resend.com), once RESEND_API_KEY is set
  // as a Netlify environment variable:
  //
  // const resp = await fetch('https://api.resend.com/emails', {
  //   method: 'POST',
  //   headers: {
  //     'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
  //     'Content-Type': 'application/json'
  //   },
  //   body: JSON.stringify({
  //     from: 'FlexRoute <noreply@flexrouteapp.com>',
  //     to: email,
  //     subject: 'Your FlexRoute code: ' + code,
  //     text: 'Your FlexRoute verification code is ' + code + '. It expires in 10 minutes.'
  //   })
  // });
  // if (!resp.ok) throw new Error('email provider returned ' + resp.status);
  //
  // Until a provider key is configured, this is a no-op so the rest of the
  // auth flow can still be built/tested end-to-end.
  if (!process.env.RESEND_API_KEY) {
    console.warn('[FlexRoute] send-code: no email provider configured — code for ' + email + ' is ' + code + ' (visible only in function logs, not sent)');
    return;
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'FlexRoute <noreply@flexrouteapp.com>',
      to: email,
      subject: 'Your FlexRoute code: ' + code,
      text: 'Your FlexRoute verification code is ' + code + '. It expires in 10 minutes.'
    })
  });
  if (!resp.ok) throw new Error('email provider returned ' + resp.status);
}

async function handleSendCode(body, store) {
  const email = normalizeEmail(body.email);
  if (!email || !isPlausibleEmail(email)) {
    return { statusCode: 400, body: { error: 'Invalid email', code: 'BAD_EMAIL' } };
  }
  try {
    const existing = await store.get(email, { type: 'json' });
    if (existing && existing.sentAt && (Date.now() - existing.sentAt) < RESEND_COOLDOWN_MS) {
      return { statusCode: 429, body: { error: 'Please wait before requesting another code', code: 'COOLDOWN' } };
    }
    const code = genCode();
    const record = { code, expiresAt: Date.now() + CODE_TTL_MS, sentAt: Date.now(), attempts: 0 };
    await store.setJSON(email, record);
    await sendEmail(email, code);
    return { statusCode: 200, body: { sent: true } };
  } catch (e) {
    console.error('[FlexRoute] send-code error:', e && e.message);
    return { statusCode: 502, body: { error: 'Could not send code', code: 'SEND_FAILED' } };
  }
}

exports.handler = async function(event) {
  // Classic (v1) Netlify Functions don't auto-inject the Blobs context —
  // connectLambda reads it from the invocation event. Without this,
  // getStore() throws MissingBlobsEnvironmentError (502) in production.
  try { connectLambda(event); } catch (e) { /* local dev — ignore */ }
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
    logRejected('send-code', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const store = getStore(blobOpts('otp'));
  const result = await handleSendCode(body, store);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleSendCode = handleSendCode;
