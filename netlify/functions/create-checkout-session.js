// /netlify/functions/create-checkout-session.js
// FlexRoute — creates a Stripe Checkout session for Monthly or Yearly Premium.
//
// Why email, not a device ID: Stripe is the source of truth for "who has
// paid" (per the locked monetization plan), keyed by email — there is no
// separate FlexRoute database of customers. We pass the driver's verified
// email into Checkout so Stripe creates/reuses a Customer record tied to
// that email, which is what entitlement-check.js later queries.
//
// Contract:
//   POST /.netlify/functions/create-checkout-session
//   Body: { email: "<verified email>", plan: "monthly" | "yearly" }
//   Response (200): { url: "<stripe checkout url>" }
//   Response (4xx/5xx): { error, code }

const Stripe = require('stripe');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

// LIVE-mode Price IDs for FlexRoute Premium (Stripe account also used by
// SpellRightPro — these IDs are specific to the FlexRoute Premium product,
// not shared with SpellRightPro's own prices). These only work with a LIVE
// secret key (sk_live_...) — using them with a test-mode key (sk_test_...)
// will cause Stripe to reject the request, since test and live Price IDs
// live in separate, non-overlapping namespaces in Stripe's API.
const PRICE_IDS = {
  monthly: 'price_1TnKXhEl99zwdEZrEfAF76Be', // $9.99 USD / month
  yearly:  'price_1TnKcjEl99zwdEZrM0E4cVfU', // $79.00 USD / year
};

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function handleCreateCheckout(body, stripe, originHost, internalTestSecret) {
  const email = normalizeEmail(body.email);
  const plan = body.plan;
  if (!email || !isPlausibleEmail(email)) {
    return { statusCode: 400, body: { error: 'Invalid email', code: 'BAD_EMAIL' } };
  }
  if (plan !== 'monthly' && plan !== 'yearly') {
    return { statusCode: 400, body: { error: 'Invalid plan', code: 'BAD_PLAN' } };
  }

  const priceId = PRICE_IDS[plan];
  // success_url/cancel_url point back at the app itself. {CHECKOUT_SESSION_ID}
  // is a literal Stripe template token, substituted by Stripe at redirect
  // time — flexroute.html can read it from the query string after return,
  // though the webhook (separate function, still to build) is what actually
  // grants entitlement; the redirect is just where the driver lands.
  const baseUrl = 'https://' + originHost;

  // ── TEMPORARY: internal live-mode test path ──────────────────────────────
  // REMOVE THIS BLOCK once live-mode testing is confirmed working. Applies
  // a 100%-off coupon (INTERNAL-TEST-100, must already exist in Stripe) so
  // we can verify the full live checkout + webhook + entitlement pipeline
  // with a real Checkout Session but a genuine $0.00 charge — no refund
  // needed afterward, no real money ever moves.
  //
  // Double-gated so a real driver's checkout call can NEVER trigger this:
  //   1. body._internalTestSecret must match an env var only we know
  //   2. body._applyTestCoupon must be explicitly true
  // Neither field is ever sent by the real frontend checkout flow — both
  // only exist for this one manual verification step.
  const isInternalTest = internalTestSecret
    && body._internalTestSecret === internalTestSecret
    && body._applyTestCoupon === true;

  const sessionParams = {
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: baseUrl + '/flexroute.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: baseUrl + '/flexroute.html?checkout=cancelled',
    metadata: { flexroute_email: email, flexroute_plan: plan },
  };
  if (isInternalTest) {
    sessionParams.discounts = [{ coupon: 'INTERNAL-TEST-100' }];
    console.log('[FlexRoute] INTERNAL TEST CHECKOUT — 100% off coupon applied for', email);
  }
  // ── END TEMPORARY BLOCK ───────────────────────────────────────────────────

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    return { statusCode: 200, body: { url: session.url } };
  } catch (e) {
    console.error('[FlexRoute] create-checkout-session error:', e && e.message);
    return { statusCode: 502, body: { error: 'Could not create checkout session', code: 'STRIPE_ERROR' } };
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
    logRejected('create-checkout-session', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] create-checkout-session: STRIPE_SECRET_KEY not configured');
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Payments not configured', code: 'NO_STRIPE_KEY' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  // The request's own Origin/Referer (already validated above) tells us
  // which deployed host to build success/cancel URLs against, so this
  // works correctly on melodious-strudel during testing AND on
  // flexrouteapp.com once that's the live deploy — no hardcoded domain.
  const originHost = (event.headers.origin || event.headers.referer || 'flexrouteapp.com')
    .replace(/^https?:\/\//, '').split('/')[0];
  const result = await handleCreateCheckout(body, stripe, originHost, process.env.INTERNAL_TEST_SECRET);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleCreateCheckout = handleCreateCheckout;
