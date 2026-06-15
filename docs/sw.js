// Network-first service worker.
// Goal: the installed PWA should ALWAYS load the freshest app code when online,
// so code/CSS updates appear on the next launch without any manual cache-clearing.
// Falls back to the last cached copy only when offline.
const CACHE = 'mylib-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch GitHub API writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // only the app shell; let api.github.com pass straight through

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
