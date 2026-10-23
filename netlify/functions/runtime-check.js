// netlify/functions/runtime-check.js
//
// TEMPORARY DIAGNOSTIC. Shows which Node.js version your Netlify functions really run on, and whether
// it includes the October 21, 2026 security fixes (22.23.4 / 24.22.1 / 26.12.1). It does not depend on
// Netlify's log viewer.
//
// It answers ONLY when the request carries the secret in the DIAG_TOKEN environment variable
// (?t=<token>). Everyone else gets a plain 404, and with no DIAG_TOKEN set it is always a 404.
// Delete this file and the DIAG_TOKEN variable once you have your answer.

const crypto = require('crypto');

const FIXED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };

function isPatched(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v[0] > 26) return true;                 // newer line than any listed (assumed to carry the fixes)
  const need = FIXED[v[0]];
  if (!need) return false;                    // 25, 23, 20 and older: end of life, no fix
  for (let i = 0; i < 3; i++) {
    if (v[i] > need[i]) return true;
    if (v[i] < need[i]) return false;
  }
  return true;
}

exports.handler = async (event) => {
  const want = process.env.DIAG_TOKEN || '';
  const got = (event.queryStringParameters && event.queryStringParameters.t) || '';
  const a = Buffer.from(want);
  const b = Buffer.from(String(got));
  const ok = want.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { statusCode: 404, body: 'Not found' };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      node: process.version,
      patched_for_oct_2026_advisory: isPatched(process.version),
      fixed_versions: '22.23.4, 24.22.1, 26.12.1 (or newer)'
    }, null, 2)
  };
};
