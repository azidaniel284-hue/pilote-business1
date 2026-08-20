/* Service worker — Pilote Business
   Stratégie « réseau d'abord » : on sert toujours la version la plus récente
   quand la connexion est là, et on bascule sur le cache uniquement hors-ligne.
   Aucune mise à jour ne peut donc rester bloquée par le cache. */
const CACHE = 'pilote-business-v4';
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

// Clic sur un rappel : on remet l'app au premier plan si elle est déjà ouverte,
// sinon on l'ouvre. Sans ce gestionnaire, cliquer la notification ne fait rien.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      const url = (e.notification.data && e.notification.data.url) || '/';
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* ===== Rappel quotidien reçu du serveur (Web Push) =====
   Le message arrive CHIFFRÉ : ni Google, ni Apple, ni Mozilla ne peuvent le
   lire — seul cet appareil possède la clé. Il ne contient de toute façon aucune
   donnée d'activité, uniquement un texte d'encouragement générique.
   Le `tag` fixe remplace le rappel de la veille au lieu d'empiler les bulles. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { corps: e.data && e.data.text() }; }
  const titre = d.titre || 'Pilote Business';
  e.waitUntil(self.registration.showNotification(titre, {
    body: d.corps || '',
    tag: d.tag || 'pb-daily',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' }
  }));
});

/* Le navigateur peut renouveler un abonnement de lui-même (rotation de clés,
   mise à jour du système). Sans ce gestionnaire, les rappels s'arrêteraient
   silencieusement : on se réabonne et on prévient le serveur. */
const VAPID_PUBLIC = 'BKMiApc3GgGXEOBtzdrGr1dVRm55BKEvr44qvjTYnXMzojNF43EIZPUcmG4qTgt-VII2eCKO8sx1ZnYvvXZ4thU';
function b64ToU8(b64) {
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) })
      .then((sub) => {
        const j = sub.toJSON();
        return fetch('/.netlify/functions/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
            heure: 8, tz: new Date().getTimezoneOffset(), langue: 'fr'
          })
        });
      })
      .catch(() => {})
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
