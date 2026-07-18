// FlexRoute Service Worker — offline support
// v2: network-first for HTML so deploys reach users immediately
const CACHE = 'flexroute-v4';   // bumped: v07e adds Netlify function routing   // ← bumped from v1; forces cache wipe on update

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

// Activate — wipe ALL old caches (flexroute-v1, etc.)
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
    e.respondWith(
      fetch(e.request).then(response => {
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
