'use strict';

// Keeps the app shell on the glasses so it opens quickly on a slow link. Network first, so an update shows on the
// next launch. Only this app's own files are handled; the link to the PC (the MQTT brokers) never passes through here.
const CACHE = 'glass-home-v32-coherent-shell';
const SHELL = ['./', 'index.html', 'style.css', 'app.js','watch-phone.js','watch-library.js', 'vendor/mqtt.min.js', 'apps.json', 'icon.svg', 'icon-mono.svg','home-shell.js','home-shell.css','parked.js','drive-location.js','drive/link-core.js','drive-phone.js','review/index.html','review/app.js','review/style.css','review/review.js','review/navigation.js','review/embedded.js','review/embedded.css','review/icon.svg','review/icon-mono.svg'];
const PRECACHE = SHELL.filter(path=>!path.startsWith('review/'));

self.addEventListener('install', (event) => {
  // Normal activation waits for existing clients to close. Never force an open HUD to reload.
  // Review loads only on deliberate entry.
  // A new shell must not seed itself from a still-fresh HTTP cache for the prior release.
  const requests=PRECACHE.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'}));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(requests)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('glass-home-') && k !== CACHE).map((k) => caches.delete(k)))),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const shellPaths = new Set(SHELL.map(p=>new URL(p,self.registration.scope).pathname));
  if (!shellPaths.has(url.pathname)) return; // Never cache task/API/private-image responses.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await Promise.race([
        // Revalidate only the allowlisted public shell. HTTP freshness may otherwise mix releases.
        fetch(event.request,{cache:'no-cache'}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) await cache.put(url.origin+url.pathname, response.clone()).catch(()=>{});
      return response;
    } catch (e) {
      return (await cache.match(url.origin+url.pathname, { ignoreSearch: true })) || Response.error();
    }
  })());
});
