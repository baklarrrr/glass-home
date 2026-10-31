'use strict';

// Keeps the app shell on the glasses so it opens quickly on a slow link. Network first, so an update shows on the
// next launch. Only this app's own files are handled; the link to the PC (the MQTT brokers) never passes through here.
const CACHE = 'glass-home-v24-studio-preparation';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'vendor/mqtt.min.js', 'apps.json', 'icon.svg', 'icon-mono.svg','home-shell.js','home-shell.css','parked.js','review/index.html','review/app.js','review/style.css','review/review.js','review/navigation.js','review/embedded.js','review/embedded.css','review/icon.svg','review/icon-mono.svg'];
const PRECACHE = SHELL.filter(path=>!path.startsWith('review/'));

self.addEventListener('install', (event) => {
  // Review loads only on deliberate entry; do not download its second view at first launch.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('glass-home-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
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
        fetch(event.request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) await cache.put(url.origin+url.pathname, response.clone()).catch(()=>{});
      return response;
    } catch (e) {
      return (await cache.match(url.origin+url.pathname, { ignoreSearch: true })) || Response.error();
    }
  })());
});
