// /netlify/functions/create-checkout-session.js
// FlexRoute — creates a Stripe Checkout session for Monthly or Yearly Premium.
//
// Why email is now OPTIONAL: previously the app required a verified email
// (via send-code.js/verify-code.js OTP) BEFORE ever reaching this function —
// a real driver had to tap "Continue to payment", type an email, wait for a
// code, open their email app, copy the code, type it in, and ONLY THEN get
// redirected to Stripe. That's 6-8 steps before ever seeing Stripe's own
// one-page checkout (which itself collects and verifies email as part of
// payment). Given the app's own funnel data — dozens of paywall views per
// month but only 2 Stripe checkout sessions EVER started, both abandoned
// unpaid — that gate was very likely the single largest source of drop-off.
// Now "Continue to payment" goes straight here with no email required;
// Stripe's own hosted page collects it as part of paying. If the app
// already knows the driver's email (a returning signed-in driver), it's
// still passed through as customer_email to prefill Stripe's page — this
// change only makes it OPTIONAL, not removed for everyone.
//
// Contract:
//   POST /.netlify/functions/create-checkout-session
//   Body: { email?: "<verified email>", plan: "monthly" | "yearly" }
//   Response (200): { url: "<stripe checkout url>" }
//   Response (4xx/5xx): { error, code }

const Stripe = require('stripe');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');
const { logAuthEvent } = require('./_observability');

// LIVE-mode Price IDs for FlexRoute Premium.
// These live on FlexRoute's OWN dedicated Stripe account (migrated off the
// shared SpellRightPro account, which caused cross-product entitlement leaks).
// These only work with a LIVE secret key (sk_live_...) — using them with a
// test-mode key (sk_test_...) will cause Stripe to reject the request, since
// test and live Price IDs live in separate, non-overlapping namespaces.
//
// Keep in sync with FLEXROUTE_PRICE_IDS in check-entitlement.js.
const PRICE_IDS = {
  monthly: 'price_1TvpRYK7RvJpTQ3hubMkSWwy', // $9.99 USD / month
  yearly:  'price_1TvpTSK7RvJpTQ3hi6YTdqT0', // $79.00 USD / year
};

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function handleCreateCheckout(body, stripe, originHost, internalTestSecret) {
  // Email is now OPTIONAL — see file header. When present, it must still be
  // well-formed (a driver's own device already knowing their email is a
  // reasonable prefill; garbage input is not).
  const rawEmail = body.email;
  let email = null;
  if (rawEmail !== undefined && rawEmail !== null && rawEmail !== '') {
    email = normalizeEmail(rawEmail);
    if (!isPlausibleEmail(email)) {
      return { statusCode: 400, body: { error: 'Invalid email', code: 'BAD_EMAIL' } };
    }
  }
  const plan = body.plan;
  if (plan !== 'monthly' && plan !== 'yearly') {
    return { statusCode: 400, body: { error: 'Invalid plan', code: 'BAD_PLAN' } };
  }

  const priceId = PRICE_IDS[plan];
  // success_url/cancel_url point back at the app itself. {CHECKOUT_SESSION_ID}
  // is a literal Stripe template token, substituted by Stripe at redirect
  // time — flexroute.html reads it via get-checkout-email.js when the
  // driver wasn't already signed in, and the webhook (separate function)
  // is what actually grants entitlement server-side; the redirect is just
  // where the driver lands and how the client learns who just paid.
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
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: baseUrl + '/flexroute.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: baseUrl + '/flexroute.html?checkout=cancelled',
    metadata: { flexroute_plan: plan },
  };
  if (email) {
    // Prefills Stripe's email field for a driver whose device already knows
    // it (e.g. previously signed in) — Stripe still lets them change it.
    sessionParams.customer_email = email;
    sessionParams.metadata.flexroute_email = email;
  }
  if (isInternalTest) {
    sessionParams.discounts = [{ coupon: 'INTERNAL-TEST-100' }];
    console.log('[FlexRoute] INTERNAL TEST CHECKOUT — 100% off coupon applied for', email || '(no email provided)');
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
  await logAuthEvent(event, 'checkout_started', {
    email: (body.email || '').trim().toLowerCase(),
    plan: body.plan || '',
    ok: result.statusCode === 200
  });
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleCreateCheckout = handleCreateCheckout;
