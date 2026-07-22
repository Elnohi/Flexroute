// /netlify/functions/send-code.js
// FlexRoute — sends a 6-digit one-time login code to an email address.

// Node 18+ provides global fetch — no need for node-fetch
const { getStore, connectLambda } = require('@netlify/blobs');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const CODE_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000;    // Prevent rapid-fire resend spam

function normalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Build Blobs store options
function blobOpts(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token = process.env.BLOBS_TOKEN;
  }
  return opts;
}

async function sendEmail(email, code) {
  // If no provider configured, log and skip sending
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      `[FlexRoute] send-code: no email provider configured — code for ${email} is ${code}`
    );
    return;
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'FlexRoute <noreply@flexrouteapp.com>',
      to: email,
      subject: `Your FlexRoute code: ${code}`,
      text: `Your FlexRoute verification code is ${code}. It expires in 10 minutes.`
    })
  });

  if (!resp.ok) {
    throw new Error(`Email provider returned ${resp.status}`);
  }
}

exports.handler = async (event, context) => {
  try {
    // Origin check
    if (!isAuthorizedOrigin(event)) {
      logRejected(event);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Unauthorized origin' })
      };
    }

    const { email: rawEmail } = JSON.parse(event.body || '{}');
    const email = normalizeEmail(rawEmail);

    if (!isPlausibleEmail(email)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid email' })
      };
    }

    // Initialize Blobs store
    const store = getStore(blobOpts('otp'), connectLambda(context));

    const now = Date.now();
    const existing = await store.get(email);

    if (existing && existing.expiresAt > now) {
      const lastSent = existing.lastSent || 0;
      if (now - lastSent < RESEND_COOLDOWN_MS) {
        return {
          statusCode: 429,
          body: JSON.stringify({ error: 'Resend cooldown active' })
        };
      }
    }

    const code = genCode();
    const expiresAt = now + CODE_TTL_MS;

    await store.set(email, { code, expiresAt, lastSent: now });

    await sendEmail(email, code);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };

  } catch (err) {
    console.error('send-code error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
