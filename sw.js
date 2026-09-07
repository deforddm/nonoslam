/* NONOSLAM service worker — caches the app shell so the game works offline.
 * Bump CACHE whenever you ship a new version so players pick it up. */
var CACHE = 'nonoslam-v1.0.0';
var ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './src/style.css', './src/nonogram.js', './src/audio.js', './src/board.js', './src/app.js',
  './fonts/bungee-latin-400-normal.woff2', './fonts/rubik-latin-400-normal.woff2', './fonts/rubik-latin-500-normal.woff2', './fonts/rubik-latin-700-normal.woff2', './fonts/rubik-latin-900-normal.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Cache-first for our own files, network for anything else; refresh the cache in the background.
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then(function (cached) {
    var fetched = fetch(e.request).then(function (res) {
      if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
      return res;
    }).catch(function () { return cached || new Response('Offline', { status: 503, statusText: 'Offline' }); });
    return cached || fetched;
  }));
});
