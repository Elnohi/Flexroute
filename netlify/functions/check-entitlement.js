// /netlify/functions/check-entitlement.js
// FlexRoute — live entitlement check against Stripe.
//
// Stripe is the single source of truth for "has this email paid" (per the
// locked monetization plan — no separate FlexRoute database for this).
// This function looks up Stripe customers by email and checks for an
// active, trialing, OR past_due subscription. Called on app load when
// S.userEmail is set, to correct local entitlement state if it's stale
// (e.g. paid on another device, or cancelled and the local flag hasn't
// caught up).
//
// Contract:
//   POST /.netlify/functions/check-entitlement
//   Body: { email: "<verified email>" }
//   Response (200): { paid: boolean, plan: "monthly"|"yearly"|null }
//   Response (4xx/5xx): { error, code }

const Stripe = require('stripe');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

// LIVE-mode Price IDs for FlexRoute Premium, on FlexRoute's own Stripe account.
// A subscription only grants premium if it uses one of these prices — this
// prevents any unrelated subscription on the account from unlocking the app.
// Keep in sync with PRICE_IDS in create-checkout-session.js.
const FLEXROUTE_PRICE_IDS = [
  'price_1TvpRYK7RvJpTQ3hubMkSWwy', // $9.99 USD / month
  'price_1TvpTSK7RvJpTQ3hi6YTdqT0', // $79.00 USD / year
];

// Subscription statuses that grant access. past_due is a DELIBERATE grace
// period: when a renewal payment fails, Stripe doesn't cancel immediately —
// it moves the subscription to past_due and retries automatically over a
// window (configurable in Stripe's Dashboard, commonly 1-3 weeks) before
// finally giving up and moving to canceled/unpaid. Without past_due here,
// a driver's access would cut off the INSTANT a single payment attempt
// failed — an expired card, a bank flagging the charge, insufficient funds
// that one day — even though Stripe hasn't given up and the retry might
// succeed hours later. Treating past_due as still-paid trades a few extra
// days of access for someone who's genuinely stopped paying, for not
// locking out someone who's still a real customer mid-retry. Once Stripe's
// retries are exhausted, the subscription moves to canceled/unpaid — NOT
// in this list — and access is correctly revoked on the next check.
const GRANTING_STATUSES = ['active', 'trialing', 'past_due'];

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function handleCheckEntitlement(body, stripe) {
  const email = normalizeEmail(body.email);
  if (!email || !isPlausibleEmail(email)) {
    return { statusCode: 400, body: { error: 'Invalid email', code: 'BAD_EMAIL' } };
  }

  try {
    // Stripe customers are looked up by email — list (not retrieve) because
    // email isn't guaranteed unique as a lookup key in Stripe's API, though
    // in practice each driver should only ever have one Customer record
    // since create-checkout-session.js always passes the same normalized
    // email for a given driver.
    const customers = await stripe.customers.list({ email: email, limit: 5 });
    if (!customers.data.length) {
      return { statusCode: 200, body: { paid: false, plan: null } };
    }

    // Check subscriptions across all matching customers (defensive — in
    // case more than one Customer record somehow exists for this email).
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'all',
        limit: 10,
      });
      for (const sub of subs.data) {
        if (GRANTING_STATUSES.includes(sub.status)) {
          const item = sub.items.data[0];
          const priceId = item && item.price && item.price.id;

          // Only FlexRoute's own prices grant premium. Without this check, ANY
          // active subscription on the Stripe account would unlock the app —
          // which is how the old shared SpellRightPro account leaked access.
          // Applies identically to past_due subs: a past_due subscription on
          // an unrelated product still must never grant FlexRoute premium.
          if (!FLEXROUTE_PRICE_IDS.includes(priceId)) continue;

          const interval = item && item.price && item.price.recurring && item.price.recurring.interval;
          const plan = interval === 'year' ? 'yearly' : (interval === 'month' ? 'monthly' : null);
          return { statusCode: 200, body: { paid: true, plan: plan } };
        }
      }
    }
    return { statusCode: 200, body: { paid: false, plan: null } };
  } catch (e) {
    console.error('[FlexRoute] check-entitlement error:', e && e.message);
    return { statusCode: 502, body: { error: 'Could not check entitlement', code: 'STRIPE_ERROR' } };
  }
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
    logRejected('check-entitlement', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] check-entitlement: STRIPE_SECRET_KEY not configured');
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Payments not configured', code: 'NO_STRIPE_KEY' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const result = await handleCheckEntitlement(body, stripe);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleCheckEntitlement = handleCheckEntitlement;
