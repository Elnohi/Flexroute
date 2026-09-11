// /netlify/functions/get-checkout-email.js
//
// FlexRoute — retrieves the email a driver used on Stripe's own Checkout
// page, given the session_id Stripe appends to the success redirect URL.
//
// Why this exists:
//   create-checkout-session.js no longer requires an email up front — the
//   driver now goes straight to Stripe Checkout, which collects (and,
//   crucially, VERIFIES via card/Apple Pay/Google Pay/Link) the email
//   itself. That collapses a 6-8 step pre-payment flow (tap, type email,
//   wait for code, open email app, copy code, type code, THEN redirect to
//   Stripe) down to one tap. But it means the app has no idea what email
//   was used until the driver is redirected back — this function closes
//   that gap by asking Stripe directly, the same "query Stripe live rather
//   than trust the client" pattern used throughout these functions
//   (check-entitlement.js, stripe-webhook.js).
//
// Security note: session_id values are long, high-entropy strings
// (effectively unguessable) known only to Stripe, the browser that
// completed checkout, and this backend — treating one as a valid lookup
// key is the same trust model Stripe's own documentation recommends for
// "thank you" pages. This endpoint deliberately returns ONLY email and
// payment_status, nothing else from the session object, to keep exposure
// minimal even in that already-low-risk scenario. It also only returns an
// email when payment actually succeeded — an expired or still-open session
// returns paid:false and no email, so nothing is disclosed for a checkout
// that never completed.
//
// Contract:
//   POST /.netlify/functions/get-checkout-email
//   Body: { session_id: "cs_..." }
//   Response (200): { paid: boolean, email: string|null, plan: string|null }
//   Response (4xx/5xx): { error, code }

const Stripe = require('stripe');
const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

function isPlausibleSessionId(id) {
  // Stripe Checkout Session IDs: "cs_" + live/test marker + alnum. Loose
  // shape check only — Stripe's own retrieve() call is the real validator;
  // this just rejects obviously-wrong input before spending an API call.
  return typeof id === 'string' && /^cs_[a-zA-Z0-9_]{10,}$/.test(id) && id.length <= 200;
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
    logRejected('get-checkout-email', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] get-checkout-email: STRIPE_SECRET_KEY not configured');
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Not configured', code: 'NO_STRIPE_KEY' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }) }; }

  const sessionId = body.session_id;
  if (!isPlausibleSessionId(sessionId)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid session_id', code: 'BAD_SESSION_ID' }) };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ paid: false, email: null, plan: null }) };
    }
    const email = (session.customer_details && session.customer_details.email)
      || session.customer_email || null;
    const plan = (session.metadata && session.metadata.flexroute_plan) || null;
    return { statusCode: 200, headers: cors, body: JSON.stringify({ paid: true, email: email, plan: plan }) };
  } catch (e) {
    // Stripe throws for a malformed/nonexistent session ID (e.g. someone
    // hand-editing the URL) — treat that the same as "not paid" rather than
    // leaking whether a given ID exists via a different error shape.
    console.warn('[FlexRoute] get-checkout-email: session retrieve failed:', e && e.message);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ paid: false, email: null, plan: null }) };
  }
};
