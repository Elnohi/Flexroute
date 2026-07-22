// /netlify/functions/_originCheck.js
// FlexRoute — shared origin/referer gate for paid/costed backend functions.

const AUTHORIZED_ORIGINS = [
  'flexrouteapp.com',
  'www.flexrouteapp.com'
];

// Allow localhost / 127.0.0.1 for local development
const DEV_HOSTS = ['localhost', '127.0.0.1'];

// Extract hostname from Origin/Referer header
function hostFromHeader(raw) {
  if (!raw) return '';
  try {
    return raw
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split(':')[0]
      .toLowerCase();
  } catch {
    return '';
  }
}

// Check if host is authorized
function isAuthorizedHost(host) {
  if (!host) return false;
  if (DEV_HOSTS.includes(host)) return true;
  return AUTHORIZED_ORIGINS.some(a => host === a || host.endsWith('.' + a));
}

// Developer bypass using X-Dev-Key header
function isDevBypass(event) {
  const envKey = process.env.DEV_BYPASS_KEY;
  if (!envKey) return false;

  const headers = event.headers || {};
  const sentKey =
    headers['x-dev-key'] ||
    headers['X-Dev-Key'] ||
    '';

  return sentKey && sentKey === envKey;
}

// Main origin check
function isAuthorizedOrigin(event) {
  if (isDevBypass(event)) return true;

  const headers = event.headers || {};
  const originHost  = hostFromHeader(headers.origin  || headers.Origin);
  const refererHost = hostFromHeader(headers.referer || headers.Referer);

  return isAuthorizedHost(originHost) || isAuthorizedHost(refererHost);
}

// Log rejected requests with useful metadata
function logRejected(fnName, event) {
  const headers = event.headers || {};
  console.warn('[FlexRoute] Rejected origin for ' + fnName + ':', {
    origin:  headers.origin  || headers.Origin  || '',
    referer: headers.referer || headers.Referer || '',
    ip:      headers['x-forwarded-for'] || 'unknown',
    time:    new Date().toISOString()
  });
}

module.exports = {
  isAuthorizedOrigin,
  logRejected,
  AUTHORIZED_ORIGINS
};
