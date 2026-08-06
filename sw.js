// TrackCare Service Worker - Offline-first cache (App Shell)
const CACHE_NAME = "trackcare-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first strategy for app shell, network-first fallback for everything else
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => cached);
    })
  );
});

// Background Sync (cuando el navegador lo soporte) - avisa a la app para intentar sincronizar
self.addEventListener("sync", (event) => {
  if (event.tag === "trackcare-sync") {
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => client.postMessage({ type: "TRY_SYNC" }));
    });
  }
});
