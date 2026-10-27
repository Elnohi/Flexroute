// /netlify/functions/ocr.js
// FlexRoute OCR proxy → Google Cloud Vision API
//
// Why a Netlify function instead of calling Google directly from the browser?
//  - The API key must stay secret. If embedded in the HTML, anyone could
//    grab it from DevTools and rack up charges or burn through the free tier.
//  - This function holds the key server-side and forwards requests.
//
// Origin gate: this endpoint is billed per call (Google Vision), so it also
// rejects requests that don't come from flexrouteapp.com — see
// _originCheck.js for why this exists alongside verify.js.
//
// Contract:
//   POST /.netlify/functions/ocr
//   Body: { image: "<base64 image, no data: prefix>" }
//   Response: { text: "<extracted text>", words: [[t,x0,y0,x1,y1],...], w: <page width> } on success
//             { error: "...", code: "..." } on failure (HTTP 4xx/5xx)

const { isAuthorizedOrigin, logRejected } = require('./_originCheck');

const GOOGLE_VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // 10 MB — Google's limit is 20MB, we cap lower
const TIMEOUT_MS = 25000;                  // 25s — Netlify function max is 26s on free tier

// ── Geometry helpers ────────────────────────────────────────────────────────────────────────────────
// Edit distance, used to recognise "Scheduled" / "Picked" even when OCR garbles a letter or two.
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}
function isAnchorWord(t) {
  const w = String(t || '').toLowerCase().replace(/[^a-z]/g, '');
  return (w.length >= 7 && w.length <= 11 && lev(w, 'scheduled') <= 3) || (w.length >= 5 && w.length <= 7 && lev(w, 'picked') <= 2);
}
// Pull compact word boxes out of Vision's response: [text, x0, y0, x1, y1] for numbers and anchor labels.
function extractGeometry(result) {
  const out = [];
  const page = result.fullTextAnnotation && result.fullTextAnnotation.pages && result.fullTextAnnotation.pages[0];
  const box = (vs) => {
    if (!vs || !vs.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    vs.forEach(v => { const x = v.x || 0, y = v.y || 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; });
    return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
  };
  const keep = (t) => (/\d/.test(t) && t.length <= 6) || isAnchorWord(t);
  if (page && page.blocks) {
    page.blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.words || []).forEach(w => {
      const t = (w.symbols || []).map(s => s.text || '').join('');
      if (!t || !keep(t)) return;
      const bb = box(w.boundingBox && w.boundingBox.vertices); if (bb) out.push([t].concat(bb));
    })));
  } else if (result.textAnnotations && result.textAnnotations.length > 1) {      // legacy per-word entries
    result.textAnnotations.slice(1).forEach(a => {
      const t = a.description || ''; if (!t || !keep(t)) return;
      const bb = box(a.boundingPoly && a.boundingPoly.vertices); if (bb) out.push([t].concat(bb));
    });
  }
  let width = (page && page.width) || 0;
  if (!width) out.forEach(w => { if (w[3] > width) width = w[3]; });
  return { words: out, width: width };
}

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    };
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed', code: 'METHOD' }) };
  }

  // Reject requests not coming from flexrouteapp.com BEFORE doing any costed
  // work (Vision API calls are billed per request). A cloned frontend with
  // verify.js stripped out would still hit this check here.
  if (!isAuthorizedOrigin(event)) {
    logRejected('ocr', event);
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Forbidden', code: 'BAD_ORIGIN' }) };
  }

  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'OCR service not configured', code: 'NO_KEY' }) };
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body', code: 'BAD_JSON' }) };
  }

  const image = body.image;
  if (!image || typeof image !== 'string') {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing image field', code: 'NO_IMAGE' }) };
  }

  // Strip data URI prefix if present (e.g. "data:image/png;base64,XXXX" → "XXXX")
  const cleanedB64 = image.replace(/^data:image\/[a-z]+;base64,/i, '');

  // Rough size check (base64 = ~1.33× raw bytes)
  if (cleanedB64.length > MAX_IMAGE_BYTES * 1.4) {
    return { statusCode: 413, headers: cors, body: JSON.stringify({ error: 'Image too large (max 10 MB)', code: 'TOO_LARGE' }) };
  }

  // Build Google Vision request
  // DOCUMENT_TEXT_DETECTION is the dense-text mode — better than TEXT_DETECTION
  // for screenshots full of addresses (multi-line, structured layout).
  const visionRequest = {
    requests: [{
      image: { content: cleanedB64 },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
      imageContext: {
        languageHints: ['en']  // hint English; Vision auto-detects but this speeds it up
      }
    }]
  };

  // Call Google with timeout via AbortController
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(GOOGLE_VISION_URL + '?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      // Accept-Encoding: never ask for Brotli (Node.js Oct 2026 advisory CVE-2026-111497); gzip/deflate only.
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify(visionRequest),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { statusCode: 504, headers: cors, body: JSON.stringify({ error: 'OCR timeout', code: 'TIMEOUT' }) };
    }
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'OCR upstream error', code: 'UPSTREAM' }) };
  }
  clearTimeout(timer);

  // Check Google's response
  if (!resp.ok) {
    // Common cases: 400 (bad image), 403 (key issue), 429 (rate limit)
    const errText = await resp.text().catch(() => '');
    return {
      statusCode: resp.status === 429 ? 429 : 502,
      headers: cors,
      body: JSON.stringify({
        error: 'Google Vision returned ' + resp.status,
        code: resp.status === 429 ? 'RATE_LIMIT' : 'VISION_ERROR',
        // Do NOT leak full error to client — could contain key/quota details
        upstream_status: resp.status
      })
    };
  }

  // Parse Google's response
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'OCR response parse error', code: 'PARSE' }) };
  }

  // Extract text from response
  // Google returns either fullTextAnnotation.text (entire page concatenated)
  // OR textAnnotations[0].description (legacy field, same content for DOC mode)
  const result = data.responses && data.responses[0];
  if (!result) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Empty OCR response', code: 'EMPTY' }) };
  }

  if (result.error) {
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({
        error: 'Vision API error',
        code: 'VISION_ERROR',
        message: (result.error.message || '').substring(0, 200)
      })
    };
  }

  const text = (result.fullTextAnnotation && result.fullTextAnnotation.text)
            || (result.textAnnotations && result.textAnnotations[0] && result.textAnnotations[0].description)
            || '';

  // POSITIONS, not just text. The flat text string loses where each number sat on screen, and the order
  // Vision emits the right-hand column of package counts in is unpredictable, so the app reads counts,
  // circle numbers and the warehouse total from their position instead. Only what is needed is returned
  // (numbers and the "Scheduled" / "Picked up" labels), never addresses, to keep the response small.
  let words = [], width = 0;
  try { const g = extractGeometry(result); words = g.words; width = g.width; } catch (e) { words = []; }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ text: text, words: words, w: width })
  };
};
