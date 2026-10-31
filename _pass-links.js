// netlify/functions/_pass-links.js
//
// Helpers for the 30-day pass reminder: the signed one-tap renewal link and the email text.
//
//   renewUrl(subId)  ->  https://flexrouteapp.com/.netlify/functions/renew-pass?s=<subId>&t=<signature>
//
// The signature is an HMAC of "renew:" + subId with the same secret the unsubscribe links use
// (REVIEW_EMAILS_SECRET, falling back to STRIPE_WEBHOOK_SECRET, so no new variable is needed). The "renew:" prefix keeps
// it separate from the unsubscribe signature, so one kind of link can never be used as the other. The link carries no email
// address; renew-pass.js looks the customer up from the subscription.

const crypto = require('crypto');
const reviewEmails = require('./_review-emails');

const SITE = 'https://flexrouteapp.com';

function secret() {
  return process.env.REVIEW_EMAILS_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
}
function renewToken(subId) {
  return crypto.createHmac('sha256', secret()).update('renew:' + String(subId)).digest('hex').slice(0, 32);
}
function verifyRenewToken(subId, token) {
  if (!secret() || !subId || !token) return false;
  const expected = Buffer.from(renewToken(subId));
  const given = Buffer.from(String(token));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}
function renewUrl(subId) {
  return SITE + '/.netlify/functions/renew-pass?s=' + encodeURIComponent(subId) + '&t=' + renewToken(subId);
}

// Plain text, like the other automatic emails. "Hi There" rather than a name: the name on a Stripe customer is the billing
// name, which can differ from the person who owns the inbox.
function buildPassReminderEmail(opts) {
  const when = reviewEmails.formatDate(opts.endsAt);
  const text =
    'Hi There,\n\n' +
    'Your FlexRoute 30-day pass ends on ' + when + '. It does not renew by itself, so you won\'t be charged again.\n\n' +
    'After that, FlexRoute goes back to its free version. If you\'d like another pass, you can get one here ' +
    '(one payment, no subscription):\n\n' +
    opts.renewLink + '\n\n' +
    'If you renew now, the new pass starts today, so it overlaps with the days you have left on this one. ' +
    'Renewing on or after ' + when + ' gets the most out of both.\n\n' +
    'If the pass didn\'t do what you hoped, just reply and tell us what went wrong. We read every message.\n\n' +
    'Thanks,\nThe FlexRoute Team' +
    '\n\n--\nDon\'t want emails like this? Click here and we won\'t send another: ' + reviewEmails.optoutUrl(opts.email);
  return { subject: 'Your FlexRoute pass ends on ' + when, text: text };
}

module.exports = { secret, renewToken, verifyRenewToken, renewUrl, buildPassReminderEmail, SITE };
