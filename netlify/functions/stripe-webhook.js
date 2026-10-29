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
const reviewEmails = require('./_review-emails');

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
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate'  // never ask for Brotli (Node.js Oct 2026 advisory CVE-2026-111497)
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

// Cancellation feedback email (see _review-emails.js). Called when a cancellation is
// SCHEDULED (customer.subscription.updated) and again, harmlessly, when it takes effect
// (customer.subscription.deleted) -- the second call is deduped per subscription, and it
// also covers immediate cancellations that never had a scheduling event. Never throws.
// A 30-day pass is an ordinary monthly subscription with renewal switched off right after checkout. Its end is
// planned, so it must not get the "sorry to see you go" feedback email or a "set to cancel" alert.
function isMonthPass(sub) {
  return !!(sub && sub.metadata && sub.metadata.flexroute_plan === 'month_pass');
}

async function onCancelSignal(sub, ended) {
  if (isMonthPass(sub)) return { email: null, status: 'skipped (30-day pass)', endsAt: null, pass: true };
  try {
    const customer = await stripe.customers.retrieve(sub.customer);
    const email = (customer && !customer.deleted && customer.email) || null;
    const item = sub.items && sub.items.data && sub.items.data[0];
    const endsAt = sub.cancel_at || (item && item.current_period_end) || sub.current_period_end || null;
    const mail = reviewEmails.buildCancelEmail({ endsAt: endsAt, ended: !!ended, email: email });
    const status = await reviewEmails.sendOnce({
      kind: 'cancel-feedback', subId: sub.id, to: email, subject: mail.subject, text: mail.text
    });
    console.log('[FlexRoute] stripe-webhook: cancel-feedback email ->', status, sub.id);
    return { email: email, status: status, endsAt: endsAt };
  } catch (e) {
    console.error('[FlexRoute] stripe-webhook: cancel-feedback error:', e && e.message);
    return null;
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
        const isPass = plan === 'month_pass';
        // 30-day pass: switch renewal off so the one paid period is all they get. Idempotent (Stripe may redeliver
        // this event) and it must never turn into a non-200 for Stripe, so every failure is caught and reported.
        let passNote = '';
        if (isPass) {
          if (session.subscription) {
            try {
              await stripe.subscriptions.update(session.subscription, { cancel_at_period_end: true });
              passNote = '\n(30-day pass: renewal switched off, access ends after this period.)';
            } catch (e) {
              console.error('[FlexRoute] stripe-webhook: could not switch pass renewal off:', e && e.message);
              passNote = '\n\u26a0 30-day pass: COULD NOT switch renewal off (' + ((e && e.message) || 'error') +
                '). Set "Cancel subscription at end of period" on sub ' + session.subscription + ' manually, or they will be charged again.';
            }
          } else {
            passNote = '\n\u26a0 30-day pass: the session had no subscription id, so renewal was not switched off. Check Stripe.';
          }
        }
        await notifyAdmin(
          (isTestCoupon ? '[TEST] ' : '') + (isPass ? '30-day pass bought: ' : '🎉 New FlexRoute subscriber: ') + email,
          'Email: ' + email + '\nPlan: ' + plan + '\nAmount charged: ' + amount +
            (isTestCoupon ? '\n(Discount applied — likely an internal test checkout, not a real paying driver.)' : '') +
            passNote +
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
      await onCancelSignal(sub, true); // no-op duplicate if the scheduling event already sent it
      break;
    }
    case 'customer.subscription.created': {
      const sub = stripeEvent.data.object;
      // A subscription created through real Checkout ALSO fires this event
      // (Stripe creates the underlying Subscription object as part of that
      // flow) -- checkout.session.completed already notifies for that case,
      // so notifying here too would double-email every real driver signup.
      // Ask Stripe directly whether a Checkout Session produced this
      // subscription; only notify when none exists, meaning it was created
      // some other way (Dashboard, as just done manually; the API directly;
      // etc.) and nothing else will ever notify for it.
      try {
        const linkedSessions = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
        if (linkedSessions.data.length > 0) break; // checkout.session.completed already covered this one

        const customer = await stripe.customers.retrieve(sub.customer);
        const email = (customer && !customer.deleted && customer.email) || 'unknown email';
        const priceId = sub.items && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
        const plan = priceId === 'price_1TvpRYK7RvJpTQ3hubMkSWwy' ? 'monthly'
          : priceId === 'price_1TvpTSK7RvJpTQ3hi6YTdqT0' ? 'yearly' : (priceId || 'unknown plan');
        const rawPrice = sub.items && sub.items.data[0] && sub.items.data[0].price;
        const amount = formatAmount(rawPrice && rawPrice.unit_amount, rawPrice && rawPrice.currency);
        // Discount shape varies by API/billing-mode version -- check both
        // the classic singular field and the newer array field defensively.
        const hasDiscount = !!(sub.discount) || (Array.isArray(sub.discounts) && sub.discounts.length > 0);
        await notifyAdmin(
          '📋 FlexRoute subscription created directly (not via Checkout): ' + email,
          'Email: ' + email + '\nPlan: ' + plan + '\nList price: ' + amount +
            (hasDiscount ? '\n(A discount is applied — actual amount charged may be $0. Check Stripe for the real invoice total.)' : '') +
            '\nSubscription: ' + sub.id +
            '\n\nThis fired because the subscription was NOT created through Stripe Checkout ' +
            '(e.g. created directly in the Dashboard). If this is expected — an internal test ' +
            'or manual grant — no action needed.'
        );
      } catch (e) {
        console.error('[FlexRoute] stripe-webhook: subscription.created lookup/notify error:', e && e.message);
      }
      break;
    }
    case 'customer.subscription.updated': {
      // Plan changes/renewals are still not notification-worthy. The one update that
      // IS: a customer scheduling a cancellation for the end of the billing period
      // (cancel_at_period_end false -> true, or a cancel_at date newly set). That is the
      // moment they decide to leave, long before customer.subscription.deleted fires.
      // NOTE: this event type must be enabled on the Stripe webhook endpoint.
      const sub = stripeEvent.data.object;
      const prev = stripeEvent.data.previous_attributes || {};
      const scheduledNow = sub.status !== 'canceled' &&
        ((sub.cancel_at_period_end === true && prev.cancel_at_period_end === false) ||
         (!!sub.cancel_at && prev.cancel_at === null));
      if (scheduledNow && isMonthPass(sub)) break;       // a pass is meant to end: nothing to email or alert about
      if (scheduledNow) {
        const r = await onCancelSignal(sub, false);
        await notifyAdmin(
          '\u23f3 FlexRoute subscription set to cancel: ' + ((r && r.email) || sub.customer),
          'Customer: ' + ((r && r.email) || sub.customer) + '\nSubscription: ' + sub.id +
            '\nEnds: ' + ((r && r.endsAt) ? reviewEmails.formatDate(r.endsAt) : 'end of billing period') +
            '\nFeedback email: ' + (r ? r.status : 'error')
        );
      }
      break;
    }
    default:
      // Unhandled event type. Still ack.
      break;
  }

  return { statusCode: 200, body: 'ok' };
};
