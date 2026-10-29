// netlify/functions/feedback.js
//
// Receives the three-question mini survey from the end of a completed shift and stores it, then emails a
// digest line to the owner. Deliberately tiny: no personal data is collected and none is asked for.
//
// Response: { ok: true } on success. Failures are still 200 with { ok:false } so the app never shows the
// driver an error for something that is not their problem.
const { getStore, connectLambda } = require('@netlify/blobs');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const ALLOWED = {
  route_size: ['Under 20', '20 to 40', 'Over 40'],
  most_used:  ['Scanning the list', 'The optimised order', 'Shift Mode'],
  improve:    ['Reading addresses', 'Package counts', 'The route order', 'Speed', 'Something else']
};

function clean(body) {
  const out = { answers: {}, note: '', stops: 0, platform: '', display: '', lang: '', region: '' };
  const a = (body && body.answers) || {};
  // Only the known questions and the known options are stored: anything else is dropped rather than trusted.
  Object.keys(ALLOWED).forEach(function(k) {
    if (typeof a[k] === 'string' && ALLOWED[k].indexOf(a[k]) >= 0) out.answers[k] = a[k];
  });
  out.note = typeof body.note === 'string' ? body.note.slice(0, 1000) : '';
  out.stops = Number.isFinite(+body.stops) ? Math.max(0, Math.min(500, Math.round(+body.stops))) : 0;
  ['platform', 'display', 'lang', 'region'].forEach(function(k) {
    out[k] = typeof body[k] === 'string' ? body[k].slice(0, 24).replace(/[^\w\- ]/g, '') : '';
  });
  return out;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'BAD_JSON' }) }; }

  const d = clean(body);
  if (!Object.keys(d.answers).length && !d.note) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: 'EMPTY' }) };
  }
  const rec = Object.assign({ at: new Date().toISOString() }, d);
  const id = rec.at.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);

  try {
    if (typeof connectLambda === 'function') connectLambda(event);
    const store = getStore({ name: 'feedback' });
    await store.set(id, JSON.stringify(rec));
  } catch (e) {
    console.warn('[feedback] store failed:', e && e.message);   // the email below is still worth sending
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO || process.env.OWNER_EMAIL;
  if (key && to) {
    const rows = Object.keys(d.answers).map(function(k) {
      return '<tr><td style="padding:4px 10px 4px 0;color:#666">' + escapeHtml(k) + '</td><td style="padding:4px 0"><b>' + escapeHtml(d.answers[k]) + '</b></td></tr>';
    }).join('');
    const html = '<div style="font-family:system-ui,sans-serif;font-size:14px">' +
      '<h2 style="margin:0 0 10px">FlexRoute feedback</h2><table>' + rows + '</table>' +
      (d.note ? '<p style="margin:12px 0 0"><b>Note:</b><br>' + escapeHtml(d.note).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p style="margin:14px 0 0;color:#888;font-size:12px">' + d.stops + ' stops &middot; ' +
      escapeHtml(d.platform || '?') + ' / ' + escapeHtml(d.display || '?') + ' &middot; ' +
      escapeHtml(d.lang || '?') + (d.region ? ' &middot; ' + escapeHtml(d.region) : '') + '</p></div>';
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate'  // never ask for Brotli (Node.js Oct 2026 advisory CVE-2026-111497)
        },
        body: JSON.stringify({
          from: process.env.FEEDBACK_FROM || 'FlexRoute <onboarding@resend.dev>',
          to: [to],
          subject: 'FlexRoute feedback' + (d.answers.improve ? ' — ' + d.answers.improve : ''),
          html: html
        })
      });
    } catch (e) { console.warn('[feedback] email failed:', e && e.message); }
  }
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
