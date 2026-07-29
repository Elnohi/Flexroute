// /netlify/functions/_observability.js
//
// Lightweight auth-event logger. Records IP + userAgent hash + timestamp
// for auth-adjacent events so abuse patterns can be characterized later:
//   - Same IP requesting codes for many different emails (spammer / cloner)
//   - Same userAgent fingerprint tripping the trial repeatedly (reset abuser)
//   - Same email attempted from many IPs (account sharing / phishing)
//
// This is OBSERVATION ONLY — no enforcement. Data sits in Blobs until Sami
// decides whether the patterns justify blocking. Deciding on enforcement
// after seeing the shape of the data is much cheaper than guessing at rules
// up front.
//
// Non-blocking: every failure path is a silent no-op. Auth flows must never
// break because observability is degraded.
//
// Storage: Netlify Blobs store "auth-events", key = "event:<ts>:<rand>".
// Each record is ~150 bytes JSON. At ~100 events/day that's ~5MB/year — well
// within Blobs' free tier. Retention is manual for now.
//
// Emails are stored raw (no PII hashing) because the "otp" and "sessions"
// stores already hold emails under the same privacy posture, and email is
// the natural aggregation key for abuse review.

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

// Blobs store options — mirrors the pattern in send-code.js. Manual
// siteID/token fallback works around MissingBlobsEnvironmentError when
// automatic context injection is unreliable.
function blobOpts(name) {
  var opts = { name: name, consistency: 'eventual' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token  = process.env.BLOBS_TOKEN;
  }
  return opts;
}

// Get the client's IP from the Netlify function event.
// x-nf-client-connection-ip is Netlify's canonical header. Falls back to
// x-forwarded-for's first hop for other reverse-proxy environments.
function getClientIP(event) {
  var h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip'] ||
         (h['x-forwarded-for'] || '').split(',')[0].trim() ||
         '';
}

// 16-char truncated SHA-256 of the User-Agent header. Truncation trades a
// small collision risk for smaller storage. Good enough for pattern-matching
// "the same reset abuser keeps coming back" without keeping full UA strings.
function hashUA(ua) {
  if (!ua) return '';
  return crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
}

// Log an auth-adjacent event. `kind` is a short string like 'code_sent',
// 'code_verified', 'code_failed', 'checkout_started'. `extra` is any
// additional context (email, plan, reason). Fire-and-forget: caller does
// not await if it's on the response path — but awaiting is safe because
// this function never throws.
async function logAuthEvent(event, kind, extra) {
  try {
    var ts = Date.now();
    var rand = crypto.randomBytes(4).toString('hex');
    var key = 'event:' + ts + ':' + rand;
    var record = {
      ts: ts,
      kind: kind,
      ip: getClientIP(event),
      uaHash: hashUA(((event && event.headers) || {})['user-agent'] || '')
    };
    if (extra && typeof extra === 'object') {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && !(k in record)) {
          record[k] = extra[k];
        }
      }
    }
    var store = getStore(blobOpts('auth-events'));
    await store.set(key, JSON.stringify(record));
  } catch (e) {
    // Silently swallow. Observability MUST NOT break auth.
  }
}

module.exports = { logAuthEvent, getClientIP, hashUA };
