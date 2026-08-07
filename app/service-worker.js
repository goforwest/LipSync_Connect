const CACHE = 'lipsync-connect-v9';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/main.js',
  './js/config/constants.js',
  './js/utils/timers.js',
  './js/utils/format.js',
  './js/ui/dom.js',
  './js/ui/a11y.js',
  './js/ui/notification.js',
  './js/ui/motion.js',
  './js/ui/theme.js',
  './js/ui/values.js',
  './js/ui/connection-ui.js',
  './js/ui/formatting.js',
  './js/ui/guard.js',
  './js/ui/sections.js',
  './js/services/mode-switch.js',
  './js/services/log.js',
  './js/services/log-export.js',
  './js/services/registry.js',
  './js/services/selftest.js',
  './js/services/hub-remote.js',
  './js/state/modes.js',
  './js/serial/session.js',
  './js/serial/protocol.js',
  './js/serial/commands.js',
  './js/serial/transport.js',
  './js/serial/device.js',
  './js/serial/connection.js',
  './js/serial/endpoints.js',
  './js/services/settings-service.js',
  './js/services/device-ops.js',
  './js/services/calibration.js',
  './js/services/health.js',
  './js/plotting/plot.js',
  './js/plotting/gauge.js',
  './js/plotting/diag.js',
  './manifest.json',
  './assets/mmc_logo.jpeg',
  './assets/icons/favicon.ico',
  './assets/icons/favicon-32x32.png',
  './assets/icons/favicon-16x16.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/robots.txt',
];

async function cacheResponse(request, response) {
  if (!response || !response.ok) return response;
  const cache = await caches.open(CACHE);
  await cache.put(request, response.clone());
  return response;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(
        async () => (await caches.match(e.request)) || (await caches.match('./index.html')) || Response.error(),
      ),
    );
    return;
  }

  // Stale-while-revalidate for static assets: serve the cached copy instantly,
  // then refresh it from the network in the background when online. This keeps
  // the app usable offline AND propagates deploys to returning users without
  // anyone having to remember to bump the CACHE constant for every change —
  // the constant is still a hard-invalidate lever for breaking changes.
  e.respondWith(
    caches.match(e.request).then(async (hit) => {
      const refresh = fetch(e.request)
        .then((response) => {
          if (response && response.ok) cacheResponse(e.request, response);
          return response;
        })
        .catch(() => null);
      return hit || refresh.then((response) => response || Response.error());
    }),
  );
});
