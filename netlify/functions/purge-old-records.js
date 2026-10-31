// netlify/functions/purge-old-records.js
//
// SCHEDULED daily (see netlify.toml). Deletes records that have outlived the retention periods stated in the privacy policy,
// so the policy is true. Before this, several stores kept everything forever ("retention is manual for now").
//
//   store            what is in it                                  deleted when
//   ---------------  ---------------------------------------------  --------------------------------------------
//   auth-events      IP, hashed user agent, email, event kind       older than 180 days (age is in the key)
//   otp              one-time sign-in codes                          expired more than 1 day ago
//   sessions         sign-in sessions (180 days long)                expired
//   trials           free-route count per email                      last used more than 24 months ago
//   device_trials    free-route count per device identifier          last used more than 24 months ago
//   feedback         end-of-shift survey answers and note            older than 12 months
//   review-emails    "already sent" markers for automatic emails     sent more than 24 months ago
//
//   email-optout is NEVER touched: the unsubscribe list has to be kept, or we could email someone who asked us not to.
//
// Safety:
//   - PURGE_DISABLED=1 turns it off; PURGE_DRY_RUN=1 counts what it would delete and deletes nothing.
//   - Per run it examines at most 3000 records and deletes at most 400 per store, so a mistake cannot empty a store quickly.
//   - A record it cannot read or understand is KEPT. Only a record with a clear, parseable date that is past its limit is deleted.
//   - One store failing never stops the others, and it never throws: it always returns 200 with a summary in the logs.

const { getStore } = require('@netlify/blobs');

const DAY = 24 * 60 * 60 * 1000;
const MAX_EXAMINE = 3000;
const MAX_DELETE = 400;

function blobOpts(name) {
  var opts = { name: name, consistency: 'strong' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token  = process.env.BLOBS_TOKEN;
  }
  return opts;
}

async function readJSON(store, key) {
  try {
    const raw = await store.get(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (e) { return null; }
}
function isoMs(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }

// Each rule returns true only when the record is clearly past its limit. `rec` is null for rules that need no read.
const RULES = [
  { store: 'auth-events',   read: false, isOld: function(key, rec, now) {
      const m = /^event:(\d{13}):/.exec(key); return !!m && (now - Number(m[1])) > 180 * DAY; } },
  { store: 'otp',           read: true,  isOld: function(key, rec, now) {
      return !!rec && typeof rec.expiresAt === 'number' && (now - rec.expiresAt) > 1 * DAY; } },
  { store: 'sessions',      read: true,  isOld: function(key, rec, now) {
      return !!rec && typeof rec.expiresAt === 'number' && rec.expiresAt < now; } },
  { store: 'trials',        read: true,  isOld: function(key, rec, now) {
      const t = rec && isoMs(rec.lastConsumedAt); return t !== null && (now - t) > 730 * DAY; } },
  { store: 'device_trials', read: true,  isOld: function(key, rec, now) {
      const t = rec && isoMs(rec.lastConsumedAt); return t !== null && (now - t) > 730 * DAY; } },
  { store: 'feedback',      read: true,  isOld: function(key, rec, now) {
      const t = rec && isoMs(rec.at); return t !== null && (now - t) > 365 * DAY; } },
  { store: 'review-emails', read: true,  isOld: function(key, rec, now) {
      const t = rec && isoMs(rec.sentAt); return t !== null && (now - t) > 730 * DAY; } }
];

async function purgeStore(rule, now, dryRun) {
  const out = { examined: 0, old: 0, deleted: 0 };
  const store = getStore(blobOpts(rule.store));
  const listed = await store.list();
  const blobs = (listed && listed.blobs) || [];
  for (const b of blobs) {
    if (out.examined >= MAX_EXAMINE || out.old >= MAX_DELETE) break;
    out.examined++;
    const rec = rule.read ? await readJSON(store, b.key) : null;
    if (!rule.isOld(b.key, rec, now)) continue;
    out.old++;
    if (dryRun) continue;
    try { await store.delete(b.key); out.deleted++; }
    catch (e) { console.error('[FlexRoute] purge: could not delete', rule.store, 'record:', e && e.message); }
  }
  return out;
}

exports.handler = async () => {
  if (process.env.PURGE_DISABLED === '1') {
    console.log('[FlexRoute] purge-old-records: disabled (PURGE_DISABLED=1)');
    return { statusCode: 200, body: 'disabled' };
  }
  const dryRun = process.env.PURGE_DRY_RUN === '1';
  const now = Date.now();
  const summary = { dryRun: dryRun, stores: {} };
  for (const rule of RULES) {
    try { summary.stores[rule.store] = await purgeStore(rule, now, dryRun); }
    catch (e) {
      console.error('[FlexRoute] purge-old-records: ' + rule.store + ' skipped:', e && e.message);
      summary.stores[rule.store] = { error: String((e && e.message) || e).slice(0, 120) };
    }
  }
  console.log('[FlexRoute] purge-old-records summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

exports._RULES = RULES;
