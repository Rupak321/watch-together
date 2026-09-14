/**
 * The service worker. It exists for two things: to make the site installable,
 * and to show a real page instead of the browser's error when the phone has no
 * connection.
 *
 * It deliberately caches nothing the room runs on. A stale room.js talking to a
 * newer room would drift or break in ways nobody could see, and a room cannot
 * work offline anyway — so every page and script still comes from the network,
 * and only the offline page and its icon are kept.
 */

const CACHE = 'wt-offline-v1';
// Extensionless: the asset server redirects /offline.html to /offline, and a
// redirected response may not be used to answer a navigation.
const OFFLINE = '/offline';
const PRECACHE = [OFFLINE, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      // Lets the browser start the page's request while the worker wakes up,
      // so going through it costs nothing on a slow phone.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // The offline page's own icon, from the cache when there is no network.
  if (request.method === 'GET' && new URL(request.url).pathname === '/icons/icon-192.png') {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // Everything else that is not a page load goes straight to the network,
  // untouched: scripts, the API, video byte ranges, fonts.
  if (request.mode !== 'navigate') return;

  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(request));
      } catch {
        return (await caches.match(OFFLINE)) || Response.error();
      }
    })()
  );
});
