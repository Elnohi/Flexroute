// netlify/functions/review-optout.js
//
// Opt-out linked from the footer of every automatic feedback email, and used by mail clients' one-tap "Unsubscribe" button:
//   GET  /.netlify/functions/review-optout?e=<email>&t=<hmac signature>   shows a page with an "Unsubscribe" button. Changes NOTHING.
//   POST /.netlify/functions/review-optout?e=<email>&t=<hmac signature>   records the opt-out (the button, or a mail client's one-click
//                                                                          POST with the body "List-Unsubscribe=One-Click", RFC 8058)
//
// Why a GET must not opt anyone out: mail security scanners (corporate and government gateways, link checkers, preview bots) open every
// link in a message before the person sees it. When a plain click unsubscribed, those people were removed without ever deciding.
//
// The signature (HMAC of the email, see _review-emails.js) means only the link we emailed can opt an address out, and nobody can
// enumerate or opt out others. The page never shows the email address, and says the same thing whether or not we had anything on file.

const reviewEmails = require('./_review-emails');

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function page(status, title, message, extraHtml) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex">' +
      '<title>' + title + '</title></head>' +
      '<body style="margin:0;background:#0A0A12;color:#fff;font-family:system-ui,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
      '<div style="max-width:420px;padding:32px;text-align:center">' +
      '<h1 style="font-size:22px;margin:0 0 12px;color:#FF9900">' + title + '</h1>' +
      '<p style="font-size:16px;line-height:1.5;color:#C8C8E8;margin:0 0 20px">' + message + '</p>' +
      (extraHtml || '') +
      '<a href="https://flexrouteapp.com" style="color:#FF9900">flexrouteapp.com</a>' +
      '</div></body></html>'
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return { statusCode: 405, headers: { Allow: 'GET, POST' }, body: 'Method not allowed' };
  const q = event.queryStringParameters || {};
  const email = reviewEmails.normalizeEmail(q.e);

  if (!email || !reviewEmails.isPlausibleEmail(email) || !reviewEmails.verifyOptoutToken(email, q.t)) {
    return page(400, 'This link isn\'t valid', 'It may have been copied incorrectly. Reply to any FlexRoute email and we\'ll remove you by hand.');
  }

  if (method === 'GET') {
    // Only asks. The button below sends the POST that actually unsubscribes.
    const action = '/.netlify/functions/review-optout?e=' + encodeURIComponent(email) + '&t=' + encodeURIComponent(q.t);
    return page(200, 'Unsubscribe from FlexRoute emails?',
      'Tap the button to confirm. Nothing changes until you do.',
      '<form method="post" action="' + esc(action) + '" style="margin:0 0 22px">' +
      '<button type="submit" style="background:#FF9900;color:#0A0A12;border:0;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:700;cursor:pointer">Unsubscribe</button>' +
      '</form>');
  }

  try {
    await reviewEmails.optOut(email);
  } catch (e) {
    console.error('[FlexRoute] review-optout: could not record opt-out:', e && e.message);
    return page(500, 'Something went wrong', 'We couldn\'t save that just now. Please try again in a minute, or reply to the email and we\'ll remove you by hand.');
  }
  return page(200, 'You\'re unsubscribed', 'You won\'t receive these feedback emails from FlexRoute anymore.');
};
