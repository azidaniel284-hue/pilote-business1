/* Service worker — Pilote Business
   Stratégie « réseau d'abord » : on sert toujours la version la plus récente
   quand la connexion est là, et on bascule sur le cache uniquement hors-ligne.
   Aucune mise à jour ne peut donc rester bloquée par le cache. */
const CACHE = 'pilote-business-v3';
const CORE = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // on ne touche pas aux CDN/API
  if (url.pathname.startsWith('/.netlify/')) return;    // jamais les fonctions serveur

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => { try { c.put(req, copy); } catch (_) {} });
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});
