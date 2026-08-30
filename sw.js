// Service worker minimal TA'KUL HALAL — permet l'installation en PWA
// et un chargement quasi instantané des pages déjà visitées.
const CACHE_NAME = 'takul-halal-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Les appels à l'API (commandes en temps réel) ne doivent jamais être mis en cache
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(event.request)
        .then((response) => {
          cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cache.match(event.request))
    )
  );
});
