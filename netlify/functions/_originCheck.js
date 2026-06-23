// /netlify/functions/_originCheck.js
// FlexRoute — shared origin/referer gate for paid/costed backend functions.
//
// Why this exists:
//   ocr.js (Google Vision, billed per call) and geocode.js (Nominatim/Census,
//   rate-limited per IP) are reachable by anyone who finds the endpoint URL —
//   which is visible in any browser's Network tab. verify.js only protects
//   the *frontend UI*; a cloned copy of flexroute.html with that check deleted
//   could still call these two functions directly and run up our Vision bill
//   or burn our shared Nominatim rate-limit bucket. This closes that gap by
//   checking Origin/Referer server-side, where a clone can't bypass it by
//   editing client-side JS.
//
// This is NOT meant to replace verify.js — it's meant to make the backend
// functions themselves refuse to serve a clone, even if the clone's frontend
// never calls verify.js or ignores its result.
//
// Usage in a handler:
//   const { isAuthorizedOrigin } = require('./_originCheck');
//   if (!isAuthorizedOrigin(event)) {
//     return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
//   }

const AUTHORIZED_ORIGINS = [
  'flexrouteapp.com',
  'www.flexrouteapp.com',
];

// Allow localhost / 127.0.0.1 so local development isn't broken.
// These never appear on the public internet, so allowing them here doesn't
// weaken protection against a deployed clone on a different real domain.
const DEV_HOSTS = ['localhost', '127.0.0.1'];

function hostFromHeader(raw) {
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0] // strip port, e.g. localhost:8888
    .toLowerCase();
}

function isAuthorizedHost(host) {
  if (!host) return false;
  if (DEV_HOSTS.includes(host)) return true;
  return AUTHORIZED_ORIGINS.some(a => host === a || host.endsWith('.' + a));
}

// Checks the Origin header first (sent by browsers on fetch/XHR cross-origin
// and same-origin POSTs), falling back to Referer (some browser/proxy
// configurations omit Origin on same-origin requests but keep Referer).
// Headers can be spoofed by a non-browser client (curl, server-to-server),
// so this is a deterrent against casual clone reuse and direct hot-linking
// from a browser — not a cryptographic guarantee. Combined with verify.js
// and normal API-key/quota limits, it raises the cost of abuse meaningfully
// without adding user-facing friction (no key, no login, no extra request).
function isAuthorizedOrigin(event) {
  const headers = event.headers || {};
  const origin = hostFromHeader(headers.origin || headers.Origin);
  const referer = hostFromHeader(headers.referer || headers.Referer);
  return isAuthorizedHost(origin) || isAuthorizedHost(referer);
}

function logRejected(fnName, event) {
  console.warn('[FlexRoute] Rejected origin for ' + fnName + ':', {
    origin: event.headers && (event.headers.origin || event.headers.Origin) || '',
    referer: event.headers && (event.headers.referer || event.headers.Referer) || '',
    ip: event.headers && event.headers['x-forwarded-for'] || 'unknown',
    time: new Date().toISOString()
  });
}

module.exports = { isAuthorizedOrigin, logRejected, AUTHORIZED_ORIGINS };
