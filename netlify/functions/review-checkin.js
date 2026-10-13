// netlify/functions/review-checkin.js
//
// SCHEDULED daily (see netlify.toml). Sends the "How is FlexRoute working for
// you?" check-in to paying subscribers about 10 days after they subscribed.
//
// Safety:
//   - Does nothing unless REVIEW_EMAILS_ENABLED=1 (see _review-emails.js).
//   - Looks at subscriptions created 9-12 days ago, so one missed daily run
//     doesn't skip anyone. sendOnce() dedupes per subscription, so the overlap
//     never produces a second email.
//   - Skips anyone who has already scheduled a cancellation (they get the
//     cancellation-feedback email instead, not a "how's it going?" one).
//   - Caps the number of emails per run as a runaway-loop guard.
//   - Never throws: always returns 200 with a small JSON summary in the logs.

const Stripe = require('stripe');
const reviewEmails = require('./_review-emails');

const DAY = 24 * 60 * 60;
const MAX_PER_RUN = 25;

exports.handler = async () => {
  if (!reviewEmails.enabled()) {
    console.log('[FlexRoute] review-checkin: disabled (REVIEW_EMAILS_ENABLED is not "1")');
    return { statusCode: 200, body: 'disabled' };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] review-checkin: STRIPE_SECRET_KEY not configured');
    return { statusCode: 200, body: 'no stripe key' };
  }

  const summary = { checked: 0, sent: 0, skipped: {} };
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const now = Math.floor(Date.now() / 1000);
    const subs = await stripe.subscriptions.list({
      status: 'active',
      created: { gte: now - 12 * DAY, lte: now - 9 * DAY },
      limit: 100,
      expand: ['data.customer']
    });

    for (const sub of subs.data) {
      summary.checked++;
      if (summary.sent >= MAX_PER_RUN) { summary.skipped.cap = (summary.skipped.cap || 0) + 1; continue; }
      if (sub.cancel_at_period_end || sub.cancel_at) { summary.skipped.cancelling = (summary.skipped.cancelling || 0) + 1; continue; }

      const customer = (sub.customer && typeof sub.customer === 'object')
        ? sub.customer
        : await stripe.customers.retrieve(sub.customer);
      const email = (customer && !customer.deleted && customer.email) || null;

      const mail = reviewEmails.buildCheckinEmail({ email: email });
      const status = await reviewEmails.sendOnce({
        kind: 'checkin', subId: sub.id, to: email, subject: mail.subject, text: mail.text
      });
      if (status === 'sent' || status === 'dry-run') summary.sent++;
      else summary.skipped[status] = (summary.skipped[status] || 0) + 1;
    }
  } catch (e) {
    console.error('[FlexRoute] review-checkin error:', e && e.message);
  }
  console.log('[FlexRoute] review-checkin summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
