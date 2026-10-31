// netlify/functions/renew-pass.js
//
// The link in the pass-ending reminder email:
//   GET /.netlify/functions/renew-pass?s=<subscription id>&t=<signature>
//
// Checks the signature (see _pass-links.js), finds the customer from the subscription, and sends them straight to a Stripe
// Checkout page for another 30-day pass with their email filled in. One tap from the email to the payment page.
//
// Why it is safe without the usual origin check: the signature means only a link we emailed works, the link contains no email
// address, and the only thing it does is create a payment page for that same customer. Nothing is charged until the person
// completes Stripe's own checkout.
//
// It reuses create-checkout-session.js to build the session, so the price, the "month_pass" tagging and the success/cancel
// pages are exactly what the app's own "pay once" button produces.

const Stripe = require('stripe');
const pass = require('./_pass-links');

function page(status, title, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex"><title>' + title + '</title></head>' +
      '<body style="margin:0;background:#0A0A12;color:#fff;font-family:system-ui,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">' +
      '<div style="max-width:420px;padding:32px;text-align:center">' +
      '<h1 style="font-size:22px;margin:0 0 12px;color:#FF9900">' + title + '</h1>' +
      '<p style="font-size:16px;line-height:1.5;color:#C8C8E8;margin:0 0 20px">' + message + '</p>' +
      '<a href="https://flexrouteapp.com/flexroute.html" style="color:#FF9900">Open FlexRoute</a>' +
      '</div></body></html>'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const q = event.queryStringParameters || {};
  const subId = String(q.s || '');

  if (!/^sub_[A-Za-z0-9]+$/.test(subId) || !pass.verifyRenewToken(subId, q.t)) {
    return page(400, 'This link isn\'t valid', 'It may have been copied incorrectly. Open FlexRoute and choose a plan from there, or reply to the email and we\'ll sort it out.');
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[FlexRoute] renew-pass: STRIPE_SECRET_KEY not configured');
    return page(500, 'Something went wrong', 'Please try again in a minute, or open FlexRoute and choose a plan from there.');
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ['customer'] });
    // Only a 30-day pass can be renewed this way; anything else gets the generic page.
    if (!sub || !sub.metadata || sub.metadata.flexroute_plan !== 'month_pass') {
      return page(400, 'This link isn\'t valid', 'Open FlexRoute and choose a plan from there.');
    }
    const customer = (sub.customer && typeof sub.customer === 'object') ? sub.customer : await stripe.customers.retrieve(sub.customer);
    const email = (customer && !customer.deleted && customer.email) || '';

    // Build the session with the app's own code, so a renewal is identical to buying a pass in the app.
    const checkout = require('./create-checkout-session');
    const result = await checkout._handleCreateCheckout({ email: email || undefined, plan: 'month_pass' }, stripe, 'flexrouteapp.com', null);
    if (result.statusCode !== 200 || !result.body || !result.body.url) {
      console.error('[FlexRoute] renew-pass: could not create a checkout session for', subId, result && result.statusCode);
      return page(502, 'Something went wrong', 'We couldn\'t open the payment page just now. Please try the link again in a minute, or open FlexRoute and choose a plan from there.');
    }
    return { statusCode: 303, headers: { Location: result.body.url, 'Cache-Control': 'no-store' }, body: '' };
  } catch (e) {
    console.error('[FlexRoute] renew-pass error:', e && e.message);
    return page(500, 'Something went wrong', 'Please try again in a minute, or open FlexRoute and choose a plan from there.');
  }
};
