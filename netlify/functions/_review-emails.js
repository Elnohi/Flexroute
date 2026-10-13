// netlify/functions/_review-emails.js
//
// Shared helpers for FlexRoute's automatic feedback / review emails to paying
// subscribers. Used by stripe-webhook.js (cancellation feedback) and
// review-checkin.js (day-10 check-in), and by review-optout.js (opt-out link).
//
// Design rules (same posture as the rest of this backend):
//   - OFF BY DEFAULT. Nothing is sent to a customer unless the Netlify env var
//     REVIEW_EMAILS_ENABLED is exactly "1". Deploying this file changes nothing
//     until that switch is flipped.
//   - DRY RUN. With REVIEW_EMAILS_DRY_RUN="1" every email goes to the owner
//     (ADMIN_NOTIFY_EMAIL) instead of the customer, subject-prefixed with who it
//     WOULD have gone to, and nothing is marked as sent. Use it for the first run.
//   - ONE EMAIL PER SUBSCRIPTION PER KIND. Stripe retries webhooks, and the
//     scheduled function runs daily, so every send is guarded by a Blobs key
//     (store "review-emails", key "<kind>:<subscriptionId>"). The key is written
//     only AFTER Resend accepts the message, so a failed send can be retried.
//   - FAIL CLOSED ON STORAGE. If the dedupe/opt-out store can't be read, the
//     email is skipped rather than risk sending duplicates.
//   - NEVER THROWS. Callers (notably the Stripe webhook) must never turn an
//     email problem into a non-200 response. sendOnce() returns a status string.
//   - OPT-OUT. Every email carries a one-click unsubscribe link (HMAC-signed, no
//     login needed) plus a List-Unsubscribe header. Opted-out addresses are never
//     emailed again (store "email-optout", key = normalized email).
//
// Environment variables:
//   REVIEW_EMAILS_ENABLED   "1" to send to customers (default: off)
//   REVIEW_EMAILS_DRY_RUN   "1" to route every email to the owner instead
//   REVIEW_EMAILS_SECRET    secret for opt-out link signatures (falls back to
//                           STRIPE_WEBHOOK_SECRET so no new variable is required)
//   REVIEW_EMAILS_EXCLUDE   optional comma-separated emails to never email
//                           (e.g. your own test accounts)
//   REVIEW_URL              optional public review link (e.g. Google Play listing),
//                           added to the day-10 check-in when set
//   ADMIN_NOTIFY_EMAIL      owner inbox; also used as Reply-To (default
//                           flexrouteapp@gmail.com)
//   RESEND_API_KEY          already set for send-code.js / stripe-webhook.js

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const SITE = 'https://flexrouteapp.com';
const ADMIN_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'flexrouteapp@gmail.com';

function enabled() { return process.env.REVIEW_EMAILS_ENABLED === '1'; }
function dryRun()  { return process.env.REVIEW_EMAILS_DRY_RUN === '1'; }

function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Mirrors send-code.js: manual siteID/token fallback for Blobs.
function blobOpts(name) {
  var opts = { name: name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token  = process.env.BLOBS_TOKEN;
  }
  return opts;
}

// Own serialization (not the bundled setJSON/getJSON) — see send-code.js header.
async function readJSON(store, key) {
  const raw = await store.get(key);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(typeof raw === 'string' ? raw : String(raw)); }
  catch (e) { return null; }
}
async function writeJSON(store, key, value) {
  await store.set(key, JSON.stringify(value));
}

// ── Opt-out links ───────────────────────────────────────────────────────────
function secret() {
  return process.env.REVIEW_EMAILS_SECRET || process.env.STRIPE_WEBHOOK_SECRET || '';
}
function optoutToken(email) {
  return crypto.createHmac('sha256', secret()).update(normalizeEmail(email)).digest('hex').slice(0, 32);
}
function verifyOptoutToken(email, token) {
  if (!secret() || !token) return false;
  const expected = Buffer.from(optoutToken(email));
  const given = Buffer.from(String(token));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}
function optoutUrl(email) {
  return SITE + '/.netlify/functions/review-optout?e=' + encodeURIComponent(normalizeEmail(email)) +
    '&t=' + optoutToken(email);
}

async function isOptedOut(email) {
  const store = getStore(blobOpts('email-optout'));
  return !!(await readJSON(store, normalizeEmail(email)));
}
async function optOut(email) {
  const store = getStore(blobOpts('email-optout'));
  await writeJSON(store, normalizeEmail(email), { optedOutAt: new Date().toISOString() });
}

function isExcluded(email) {
  const e = normalizeEmail(email);
  if (e === normalizeEmail(ADMIN_EMAIL)) return true;
  return (process.env.REVIEW_EMAILS_EXCLUDE || '').split(',')
    .map(normalizeEmail).filter(Boolean).indexOf(e) !== -1;
}

// ── Message text ────────────────────────────────────────────────────────────
// Stripe stores exact timestamps. A date taken in UTC can read as the NEXT day for someone who
// subscribed in the evening, so the date is shown in US Eastern time (the same dates the owner
// sees in the Stripe dashboard). The year is shown only when it isn't the current year
// ("November 10", but "January 5, 2027" across a year boundary).
function formatDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const tz = 'America/New_York';
  const yearOf = function(x) { return x.toLocaleDateString('en-US', { year: 'numeric', timeZone: tz }); };
  const opts = (yearOf(d) === yearOf(new Date()))
    ? { month: 'long', day: 'numeric', timeZone: tz }
    : { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz };
  return d.toLocaleDateString('en-US', opts);
}

function footer(email) {
  return '\n\n--\nDon\'t want emails like this? Click here and we won\'t send another: ' + optoutUrl(email);
}

// Greets "Hi There" rather than by name: the name on a Stripe customer is the billing name,
// which can differ from the person who owns the inbox, and test accounts have placeholder names.
function buildCancelEmail(opts) {
  const when = formatDate(opts.endsAt);
  const taken = ', and that\'s all taken care of: you won\'t be charged again';
  const status = opts.ended
    ? 'I saw that your subscription has been cancelled' + taken + '.'
    : (when
        ? 'I saw that your subscription is set to end on ' + when + taken + ', and you can keep using the app until then.'
        : 'I saw that your subscription is set to end at the close of your current billing period' + taken + ', and you can keep using the app until then.');
  const text =
    'Hi There,\n\n' +
    'Thanks for trying FlexRoute. ' + status + '\n\n' +
    'We\'re a small team and your feedback really helps us improve. Would you mind sharing, in a sentence or two, ' +
    'what led you to cancel? For example: routes didn\'t optimize the way you expected, you don\'t need it often enough, ' +
    'the price, or something else.\n\n' +
    'If a route went wrong, the area and roughly how many stops it had (or a screenshot) would help us look into it.\n\n' +
    'No need to reply if you\'d rather not.\n\n' +
    'Thanks again,\nThe FlexRoute Team' + footer(opts.email);
  return { subject: 'Quick question about your FlexRoute subscription', text: text };
}

function buildCheckinEmail(opts) {
  const reviewLine = process.env.REVIEW_URL
    ? '\n\nIf FlexRoute is saving you time, a short review helps other drivers find it: ' + process.env.REVIEW_URL
    : '';
  const text =
    'Hi There,\n\n' +
    'Thanks for subscribing to FlexRoute. We\'re a small team and we want to make sure the app is really saving you time on your routes.\n\n' +
    'Has it worked well for you so far? If anything has been confusing, slow, or didn\'t optimize the way you expected, ' +
    'we\'d like to hear about it and fix it. A sentence or two is plenty, and if a route went wrong, the area and roughly ' +
    'how many stops it had (or a screenshot, with names blurred) helps a lot.\n\n' +
    'Just reply to this email.' + reviewLine + '\n\n' +
    'Thanks again for your support,\nThe FlexRoute Team' + footer(opts.email);
  return { subject: 'How is FlexRoute working for you?', text: text };
}

// ── Sending ─────────────────────────────────────────────────────────────────
async function resendSend(to, subject, text, unsubscribeUrl) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'FlexRoute Team <noreply@flexrouteapp.com>',
      to: to,
      reply_to: ADMIN_EMAIL,           // replies land in the owner inbox
      subject: subject,
      text: text,
      headers: unsubscribeUrl ? { 'List-Unsubscribe': '<' + unsubscribeUrl + '>' } : undefined
    })
  });
  if (!resp.ok) throw new Error('email provider returned ' + resp.status);
}

// Returns one of: 'disabled' | 'no-email' | 'excluded' | 'optout' | 'duplicate' |
// 'store-error' | 'dry-run' | 'sent' | 'failed'. Never throws.
async function sendOnce(args) {
  try {
    if (!enabled()) return 'disabled';
    const to = normalizeEmail(args.to);
    if (!to || !isPlausibleEmail(to)) return 'no-email';
    if (isExcluded(to)) return 'excluded';
    if (!process.env.RESEND_API_KEY) { console.warn('[FlexRoute] review-emails: RESEND_API_KEY not set'); return 'failed'; }

    let sentStore;
    try {
      if (await isOptedOut(to)) return 'optout';
      sentStore = getStore(blobOpts('review-emails'));
      if (await readJSON(sentStore, args.kind + ':' + args.subId)) return 'duplicate';
    } catch (e) {
      console.error('[FlexRoute] review-emails: store unavailable, skipping send:', e && e.message);
      return 'store-error';
    }

    if (dryRun()) {
      await resendSend(ADMIN_EMAIL, '[DRY RUN -> ' + to + '] ' + args.subject, args.text, null);
      return 'dry-run';
    }

    await resendSend(to, args.subject, args.text, optoutUrl(to));
    try {
      await writeJSON(sentStore, args.kind + ':' + args.subId, { sentAt: new Date().toISOString(), to: to });
    } catch (e) {
      console.error('[FlexRoute] review-emails: sent but could not record it (duplicate possible on retry):', e && e.message);
    }
    return 'sent';
  } catch (e) {
    console.error('[FlexRoute] review-emails: send failed:', e && e.message);
    return 'failed';
  }
}

module.exports = {
  enabled, dryRun, normalizeEmail, isPlausibleEmail,
  optoutToken, verifyOptoutToken, optoutUrl, optOut,
  buildCancelEmail, buildCheckinEmail, formatDate,
  sendOnce, ADMIN_EMAIL
};
