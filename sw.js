// Network first so updates show up straight away; cached copy when offline at the court.
// Bump VERSION (and the ?v= tags in index.html) with each release.
const VERSION = 8;
const CACHE = `baddy-tension-v${VERSION}`;
const SHELL = ['./', 'index.html', 'app.js', 'scene3d.js', 'vendor/three.module.min.js',
  'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2', 'vendor/fonts/ibm-plex-sans-latin-600-normal.woff2', 'vendor/fonts/jetbrains-mono-latin-400-normal.woff2', 'vendor/fonts/jetbrains-mono-latin-600-normal.woff2', 'vendor/fonts/saira-condensed-latin-600-normal.woff2', 'vendor/fonts/saira-condensed-latin-700-normal.woff2',
  'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache, so the offline copy is the new one.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // GitHub Pages lets browsers reuse files for 10 minutes. 'no-cache' makes the
  // browser check with the server every time, so a new version shows at once.
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
