// Service worker de Pasaporte English: guarda la app para que funcione sin conexión.
// Cambia CACHE (por ejemplo a "pasaporte-v5") cada vez que publiques cambios.
const CACHE = "pasaporte-v18";
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "data/tutor.json",
  "data/karaoke.json",
  "data/viajes.json", "data/escenas.json",
  "data/m1.json", "data/m2.json", "data/m3.json", "data/m4.json", "data/m5.json", "data/m6.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;               // el tutor (POST) siempre va a la red
  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return;
  const sameOrigin = url.origin === self.location.origin;

  // La página y los datos: primero internet (para ver siempre lo último); sin conexión, la copia guardada.
  if (req.mode === "navigate" || (sameOrigin && /\.(html|json)$/.test(url.pathname))) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) caches.open(CACHE).then(cache => cache.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./")))
    );
    return;
  }

  // Íconos, fuentes y demás: copia guardada al instante y actualización en segundo plano.
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(cached => {
        const network = fetch(req)
          .then(res => {
            if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
