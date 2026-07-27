// netlify/functions/stripe-webhook.js
//
// Receives Stripe webhook events for FlexRoute.
//
// What this does:
//   1. Verifies the Stripe signature with STRIPE_WEBHOOK_SECRET.
//   2. Returns 200 for the three subscribed events (and any future ones)
//      so Stripe stops retrying and does not disable the endpoint.
//
// What it does NOT do:
//   - No mirror-writes to Netlify Blobs. check-entitlement.js is the source
//     of truth for paid state and queries Stripe live, so nothing here needs
//     to persist state for the app to function. If you later decide you want
//     a local email→customer_id index (e.g. to avoid Stripe searches on
//     every entitlement check), add it here — use raw store.set/store.get
//     with JSON.stringify/JSON.parse, NOT the bundled setJSON/getJSON, per
//     the send-code.js / verify-code.js / trial-status.js precedent (the
//     bundled helpers silently coerce objects to "[object Object]" in prod).
//
// Environment variables required:
//   - STRIPE_SECRET_KEY      (sk_live_… — already set for the other Stripe fns)
//   - STRIPE_WEBHOOK_SECRET  (whsec_… — from Stripe → Workbench → Webhooks
//                             → this endpoint → Signing secret)

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!WEBHOOK_SECRET) {
    // Fail loudly on server-side misconfiguration so it shows up in the
    // Stripe dashboard as a persistent failure rather than a silent 200.
    return { statusCode: 500, body: 'STRIPE_WEBHOOK_SECRET not configured' };
  }

  // Netlify may deliver the request body base64-encoded. Stripe computes the
  // signature over the raw UTF-8 bytes, so decode first if needed — otherwise
  // constructEvent will reject a body that is byte-identical to what Stripe sent.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  // Netlify normalises header names to lowercase, but check both to be safe.
  const signature =
    event.headers['stripe-signature'] ||
    event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    // 400 tells Stripe the request was malformed (wrong signature, bad body),
    // NOT a server error. Do NOT return 200 here — Stripe uses non-2xx to
    // detect endpoint misconfiguration.
    return { statusCode: 400, body: 'Signature verification failed' };
  }

  // Per Stripe's own guidance, acknowledge with 200 for any event — including
  // types we don't handle — so retries stop. Add real per-event logic here
  // only when you have a reason (e.g. side effects check-entitlement can't cover).
  switch (stripeEvent.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // No-op today. See the file header for guidance if adding logic.
      break;
    default:
      // Unhandled event type. Still ack.
      break;
  }

  return { statusCode: 200, body: 'ok' };
};
