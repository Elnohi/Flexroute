// netlify/functions/stripe-webhook.js
//
// Receives Stripe webhook events for FlexRoute.
//
// What this does:
//   1. Verifies the Stripe signature with STRIPE_WEBHOOK_SECRET.
//   2. Sends an owner-notification email (via Resend) on the events that
//      actually matter to know about in real time: a new subscription, or
//      a cancellation/downgrade. Added because there was previously NO path
//      that told the developer a real conversion happened — Stripe's own
//      "Team notifications" only cover account-status/payout events, not
//      individual sales, and this webhook's checkout.session.completed
//      handler used to be a deliberate no-op (see prior header notes).
//   3. Returns 200 for the three subscribed events (and any future ones)
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
//   - Never let a failed notification email affect the response Stripe sees.
//     A dead Resend key or a transient email-provider outage must NEVER
//     cause this webhook to return non-200 — that would make Stripe think
//     the endpoint itself is broken and start retrying/eventually disabling
//     it, over what is genuinely just a "nice to know" side effect failing.
//
// Environment variables required:
//   - STRIPE_SECRET_KEY      (sk_live_… — already set for the other Stripe fns)
//   - STRIPE_WEBHOOK_SECRET  (whsec_… — from Stripe → Workbench → Webhooks
//                             → this endpoint → Signing secret)
//   - RESEND_API_KEY         (already set for send-code.js — reused here,
//                             no new provider/credential needed)
//   - ADMIN_NOTIFY_EMAIL     (optional — where owner notifications are sent.
//                             Defaults to flexrouteapp@gmail.com if unset.)

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'flexrouteapp@gmail.com';

// Amounts on a Stripe Checkout Session are in the smallest currency unit
// (cents for USD). This only needs to format USD today (FlexRoute's only
// currency per create-checkout-session.js's PRICE_IDS), but takes the
// currency code defensively rather than hardcoding the $ sign blindly.
function formatAmount(amountInSmallestUnit, currency) {
  if (typeof amountInSmallestUnit !== 'number') return 'unknown amount';
  const amount = (amountInSmallestUnit / 100).toFixed(2);
  const cur = (currency || 'usd').toUpperCase();
  return cur === 'USD' ? ('$' + amount) : (amount + ' ' + cur);
}

// Fire-and-forget style, but awaited so Netlify doesn't freeze/kill the
// function before the send completes — errors are caught and logged, never
// thrown, so a Resend outage can't turn into a 5xx that makes Stripe retry
// or disable this endpoint. See file header for why this matters.
async function notifyAdmin(subject, text) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[FlexRoute] stripe-webhook: RESEND_API_KEY not configured — owner notification not sent:', subject);
    return;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'FlexRoute <noreply@flexrouteapp.com>',
        to: ADMIN_EMAIL,
        subject: subject,
        text: text
      })
    });
    if (!resp.ok) {
      console.error('[FlexRoute] stripe-webhook: owner notification failed, status', resp.status);
    }
  } catch (e) {
    console.error('[FlexRoute] stripe-webhook: owner notification error:', e && e.message);
  }
}

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
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object;
      // Ignore anything that isn't a completed/paid subscription checkout —
      // e.g. a session that expired unpaid should never have reached this
      // event type, but payment_status is checked anyway as a cheap guard
      // against notifying on something that isn't a real conversion.
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        const email = (session.customer_details && session.customer_details.email)
          || session.customer_email || (session.metadata && session.metadata.flexroute_email) || 'unknown email';
        const plan = (session.metadata && session.metadata.flexroute_plan) || 'unknown plan';
        const amount = formatAmount(session.amount_total, session.currency);
        const isTestCoupon = Array.isArray(session.discounts) && session.discounts.length > 0 && amount === '$0.00';
        await notifyAdmin(
          (isTestCoupon ? '[TEST] ' : '') + '🎉 New FlexRoute subscriber: ' + email,
          'Email: ' + email + '\nPlan: ' + plan + '\nAmount charged: ' + amount +
            (isTestCoupon ? '\n(Discount applied — likely an internal test checkout, not a real paying driver.)' : '') +
            '\nSession: ' + session.id
        );
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = stripeEvent.data.object;
      await notifyAdmin(
        '👋 FlexRoute subscription cancelled',
        'Customer: ' + sub.customer + '\nSubscription: ' + sub.id +
          '\nCancelled at: ' + (sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : 'unknown')
      );
      break;
    }
    case 'customer.subscription.updated':
      // No-op today — plan changes/renewals aren't currently notification-
      // worthy on their own. See file header for guidance if that changes.
      break;
    default:
      // Unhandled event type. Still ack.
      break;
  }

  return { statusCode: 200, body: 'ok' };
};
