// netlify/functions/review-optout.js
//
// One-click opt-out linked from the footer of every automatic feedback email:
//   GET /.netlify/functions/review-optout?e=<email>&t=<hmac signature>
//
// The signature (HMAC of the email, see _review-emails.js) means only the link we
// emailed can opt an address out, and nobody can enumerate or opt out others.
// The page never echoes the email address back, and says the same thing whether
// or not we had anything on file for it.

const reviewEmails = require('./_review-emails');

function page(status, title, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title + '</title></head>' +
      '<body style="margin:0;background:#0A0A12;color:#fff;font-family:system-ui,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
      '<div style="max-width:420px;padding:32px;text-align:center">' +
      '<h1 style="font-size:22px;margin:0 0 12px;color:#FF9900">' + title + '</h1>' +
      '<p style="font-size:16px;line-height:1.5;color:#C8C8E8;margin:0 0 20px">' + message + '</p>' +
      '<a href="https://flexrouteapp.com" style="color:#FF9900">flexrouteapp.com</a>' +
      '</div></body></html>'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const q = event.queryStringParameters || {};
  const email = reviewEmails.normalizeEmail(q.e);

  if (!email || !reviewEmails.isPlausibleEmail(email) || !reviewEmails.verifyOptoutToken(email, q.t)) {
    return page(400, 'This link isn\'t valid', 'It may have been copied incorrectly. Reply to any FlexRoute email and we\'ll remove you by hand.');
  }
  try {
    await reviewEmails.optOut(email);
  } catch (e) {
    console.error('[FlexRoute] review-optout: could not record opt-out:', e && e.message);
    return page(500, 'Something went wrong', 'We couldn\'t save that just now. Please try the link again in a minute, or reply to the email and we\'ll remove you by hand.');
  }
  return page(200, 'You\'re unsubscribed', 'You won\'t receive these feedback emails from FlexRoute anymore.');
};
