const CACHE_NAME = 'cortex-v2';
const PRECACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never intercept the backend — API calls must always hit the network.
  if (req.url.includes('/api/')) return;

  // Network-first for the app shell + code so a new deploy applies immediately,
  // falling back to cache only when offline. (Previously cache-first, which
  // pinned users to a stale bundle after every deploy.)
  if (req.mode === 'navigate' || req.destination === 'document' || req.destination === 'script' || req.destination === 'style') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for other static assets.
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
