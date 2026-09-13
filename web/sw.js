// Golf O'Clock — Service Worker
// v1.5.2 (Alerts that cut through)
// Bump CACHE_NAME when you want installed PWA clients to re-fetch cached assets.

const CACHE_NAME = 'golfoclock-v10';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CORE_ASSETS).catch(function() {
        return cache.add('./index.html').catch(function(){});
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) {
        if (name !== CACHE_NAME) return caches.delete(name);
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin requests. The Alerts screen talks to the GitHub
  // API with an Authorization header; proxying that through here would cache
  // authenticated responses and could serve stale watches. Let the browser
  // handle anything that isn't ours.
  if (url.origin !== self.location.origin) return;

  // Tee time data is always network-first — stale times are worse than none.
  if (url.pathname.indexOf('teetimes.json') > -1) {
    event.respondWith(
      fetch(req).then(function(resp) {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(function(c) { c.put(req, copy); });
        return resp;
      }).catch(function() {
        return caches.match(req);
      })
    );
    return;
  }

  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html') ||
                 url.pathname.endsWith('.html');

  if (isHTML) {
    event.respondWith(
      fetch(req).then(function(resp) {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(function(c) { c.put(req, copy); });
        return resp;
      }).catch(function() {
        return caches.match(req).then(function(r) {
          return r || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(resp) {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, copy); });
        }
        return resp;
      });
    })
  );
});
