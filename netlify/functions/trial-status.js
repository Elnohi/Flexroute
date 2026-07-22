// /netlify/functions/trial-status.js
// FlexRoute — server-side trial tracking

const { getStore } = require('@netlify/blobs');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

function blobOpts(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token = process.env.BLOBS_TOKEN;
  }
  return opts;
}

const FREE_TRIAL_ROUTE_LIMIT = 3;

function normalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

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
      const routesUsed = existing?.routesUsed || 0;
      return {
        statusCode: 200,
        body: {
          trialUsed: routesUsed >= FREE_TRIAL_ROUTE_LIMIT,
          routesUsed,
          limit: FREE_TRIAL_ROUTE_LIMIT
        }
      };
    }

    const existing = await store.get(email, { type: 'json' });
    const currentCount = existing?.routesUsed || 0;

    if (currentCount >= FREE_TRIAL_ROUTE_LIMIT) {
      return {
        statusCode: 200,
        body: {
          trialUsed: true,
          routesUsed: currentCount,
          limit: FREE_TRIAL_ROUTE_LIMIT
        }
      };
    }

    const newCount = currentCount + 1;

    await store.setJSON(email, {
      routesUsed: newCount,
      lastConsumedAt: new Date().toISOString(),
      used: newCount >= FREE_TRIAL_ROUTE_LIMIT
    });

    return {
      statusCode: 200,
      body: {
        trialUsed: newCount >= FREE_TRIAL_ROUTE_LIMIT,
        routesUsed: newCount,
        limit: FREE_TRIAL_ROUTE_LIMIT
      }
    };
  } catch (e) {
    console.error('[FlexRoute] trial-status storage error:', e?.message);
    return { statusCode: 502, body: { error: 'Storage error', code: 'STORAGE' } };
  }
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

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
    logRejected('trial-status', event);
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

  const store = getStore(blobOpts('trials'));
  const result = await handleTrialRequest(body, store);

  return {
    statusCode: result.statusCode,
    headers: cors,
    body: JSON.stringify(result.body)
  };
};

exports._handleTrialRequest = handleTrialRequest;
exports._normalizeEmail = normalizeEmail;
exports._isPlausibleEmail = isPlausibleEmail;
