// FlexRoute Service Worker — offline support
// v3: HTML fetch explicitly bypasses the HTTP cache so deploys reach TWA
//     users on their next cold launch. The network-first design only helped
//     partially before, because Chrome's HTTP cache underneath was still
//     returning stale flexroute.html in Custom Tab / TWA sessions.
const CACHE = 'flexroute-v5';   // bumped from v4: forces old cache wipe after Waze TWA fix

const SHELL = ['/flexroute.html', '/index.html', '/'];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache =>
      cache.addAll(SHELL).catch(() => {})
    )
  );
  self.skipWaiting();
});

// Activate — wipe ALL old caches (flexroute-v1..v4, etc.)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network-only for Netlify functions — never cache, never offline-fallback
  // (POST requests to /.netlify/functions/* shouldn't be served stale)
  if (url.pathname.startsWith('/.netlify/functions/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline', code: 'OFFLINE' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Always network-only for external APIs — never cache these
  const isAPI = [
    'photon.komoot.io',
    'router.project-osrm.org',
    'maps.googleapis.com',
    'generativelanguage.googleapis.com',
    'googletagmanager.com',
    'google-analytics.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'netlify.app',
  ].some(host => url.hostname.includes(host));

  if (isAPI) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Skip non-http(s)
  if (!e.request.url.startsWith('http')) return;

  // NETWORK-FIRST for HTML pages — ensures deploys reach users immediately.
  // Falls back to cache only when genuinely offline.
  const isHTML = e.request.headers.get('accept')?.includes('text/html') ||
                 url.pathname.endsWith('.html') ||
                 url.pathname === '/';

  if (isHTML) {
    // { cache: 'reload' } bypasses the browser's HTTP cache and forces a fresh
    // trip to Netlify. Without this, a Chrome Custom Tab / TWA session can
    // keep serving stale flexroute.html for the duration of the HTTP cache's
    // max-age even though the SW is nominally network-first. The response is
    // still written into the SW cache after fetch so offline mode still works.
    e.respondWith(
      fetch(e.request, { cache: 'reload' }).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for other static assets (fonts, icons, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('/flexroute.html');
      });
    })
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
