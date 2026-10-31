// netlify/functions/pass-reminder.js
//
// SCHEDULED daily (see netlify.toml). Emails people whose 30-day pass ends in about three days, with a one-tap link to buy
// another. It reuses everything the other automatic emails have, so it behaves the same way:
//   - Does nothing unless REVIEW_EMAILS_ENABLED=1 (and with REVIEW_EMAILS_DRY_RUN=1 every email goes to the owner instead).
//   - One email per pass: sendOnce() dedupes on "pass-reminder:<subscriptionId>", so overlapping runs never send twice.
//   - Honours the unsubscribe list and REVIEW_EMAILS_EXCLUDE; every email carries a one-click unsubscribe link.
//   - Never throws: always returns 200 with a small summary in the logs.
//
// Which passes: active subscriptions tagged flexroute_plan = month_pass (put on the subscription by
// create-checkout-session.js) that are set to end, and whose end is 2 to 4 days away. A window rather than "exactly 3 days"
// means one missed daily run does not skip anyone.
//
// Who is skipped: anyone who has already renewed (the same customer has another active subscription that does not end sooner),
// so nobody is nagged to buy what they already bought.

const Stripe = require('stripe');
const reviewEmails = require('./_review-emails');
const pass = require('./_pass-links');

const DAY = 24 * 60 * 60;
const MAX_PER_RUN = 25;
const MAX_PAGES = 5;            // up to 500 active subscriptions looked at per run

function endOf(sub) {
  // Newer Stripe API versions keep the period end on the subscription item; older ones on the subscription.
  const item = sub.items && sub.items.data && sub.items.data[0];
  const periodEnd = sub.current_period_end || (item && item.current_period_end) || 0;
  return sub.cancel_at || periodEnd || 0;
}
function isEnding(sub) { return !!(sub.cancel_at_period_end || sub.cancel_at); }

exports.handler = async () => {
  if (!reviewEmails.enabled()) {
    console.log('[FlexRoute] pass-reminder: disabled (REVIEW_EMAILS_ENABLED is not "1")');
    return { statusCode: 200, body: 'disabled' };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] pass-reminder: STRIPE_SECRET_KEY not configured');
    return { statusCode: 200, body: 'no stripe key' };
  }
  if (!pass.secret()) {
    console.error('[FlexRoute] pass-reminder: no signing secret (REVIEW_EMAILS_SECRET / STRIPE_WEBHOOK_SECRET); not sending');
    return { statusCode: 200, body: 'no secret' };
  }

  const summary = { looked: 0, passes: 0, due: 0, sent: 0, skipped: {} };
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const now = Math.floor(Date.now() / 1000);
    const from = now + 2 * DAY, to = now + 4 * DAY;

    let startingAfter = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = { status: 'active', limit: 100, expand: ['data.customer'] };
      if (startingAfter) args.starting_after = startingAfter;
      const subs = await stripe.subscriptions.list(args);

      for (const sub of subs.data) {
        summary.looked++;
        if (!sub.metadata || sub.metadata.flexroute_plan !== 'month_pass') continue;
        summary.passes++;
        if (!isEnding(sub)) continue;                       // a pass is always set to end; anything else is not ours to remind
        const endsAt = endOf(sub);
        if (!endsAt || endsAt < from || endsAt > to) continue;
        summary.due++;
        if (summary.sent >= MAX_PER_RUN) { summary.skipped.cap = (summary.skipped.cap || 0) + 1; continue; }

        const customer = (sub.customer && typeof sub.customer === 'object') ? sub.customer : await stripe.customers.retrieve(sub.customer);
        const email = (customer && !customer.deleted && customer.email) || null;

        // Already renewed? Another active subscription for the same customer that is not ending sooner than this one.
        const customerId = (customer && customer.id) || (typeof sub.customer === 'string' ? sub.customer : null);
        if (customerId) {
          const mine = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 20 });
          const renewed = mine.data.some(function(o) {
            return o.id !== sub.id && (!isEnding(o) || endOf(o) > endsAt + DAY);
          });
          if (renewed) { summary.skipped.renewed = (summary.skipped.renewed || 0) + 1; continue; }
        }

        const mail = pass.buildPassReminderEmail({ email: email, endsAt: endsAt, renewLink: pass.renewUrl(sub.id) });
        const status = await reviewEmails.sendOnce({
          kind: 'pass-reminder', subId: sub.id, to: email, subject: mail.subject, text: mail.text
        });
        if (status === 'sent' || status === 'dry-run') summary.sent++;
        else summary.skipped[status] = (summary.skipped[status] || 0) + 1;
      }

      if (!subs.has_more || !subs.data.length) break;
      startingAfter = subs.data[subs.data.length - 1].id;
    }
  } catch (e) {
    console.error('[FlexRoute] pass-reminder error:', e && e.message);
  }
  console.log('[FlexRoute] pass-reminder summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
