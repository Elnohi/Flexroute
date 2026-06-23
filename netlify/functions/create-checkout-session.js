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

// Test-mode Price IDs for FlexRoute Premium (Stripe account also used by
// SpellRightPro — these IDs are specific to the FlexRoute Premium product,
// not shared with SpellRightPro's own prices).
const PRICE_IDS = {
  monthly: 'price_1TlZcaEl99zwdEZrFkqoF7V0', // $9.99 USD / month
  yearly:  'price_1TlZiZEl99zwdEZrGzvRs2H8', // $79.00 USD / year
};

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function handleCreateCheckout(body, stripe, originHost) {
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
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: baseUrl + '/flexroute.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: baseUrl + '/flexroute.html?checkout=cancelled',
      // Carried through to the webhook payload so it can match the
      // completed session back to a FlexRoute email without re-parsing
      // customer_email (which Stripe does populate, but metadata is the
      // documented-stable way to round-trip our own identifiers).
      metadata: { flexroute_email: email, flexroute_plan: plan },
    });
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
  const result = await handleCreateCheckout(body, stripe, originHost);
  return { statusCode: result.statusCode, headers: cors, body: JSON.stringify(result.body) };
};

exports._handleCreateCheckout = handleCreateCheckout;
