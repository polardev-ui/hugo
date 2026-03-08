/**
 * Hugo Navigation App — Service Worker
 * Caches app shell for offline-first PWA experience.
 */

const CACHE_NAME   = 'hugo-v1.0.0';
const TILE_CACHE   = 'hugo-tiles-v1';
const ASSET_CACHE  = 'hugo-assets-v1';

// App shell assets to pre-cache
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/apple-touch-icon.svg',
];

// ── Install ────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
  );
});

// ── Activate ───────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== TILE_CACHE && k !== ASSET_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ──────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and chrome-extension URLs
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Map tiles — cache-then-network with long TTL
  if (
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('tile.openstreetmap.org')
  ) {
    event.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fresh = fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => null);
          return cached || fresh;
        })
      )
    );
    return;
  }

  // External APIs (Nominatim, OSRM, Google Fonts) — network-first, no cache
  if (
    url.hostname.includes('nominatim') ||
    url.hostname.includes('osrm') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com')
  ) {
    event.respondWith(
      fetch(request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // App shell — cache-first, fallback to network
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res.ok) return res;
        caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
        return res;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
