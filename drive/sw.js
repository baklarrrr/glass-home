'use strict';
// Keeps Bakar Drive's own files on the glasses so it opens on a weak signal. Network first, so an update shows on
// the next launch. Only the files below are handled; the link to the phone (MQTT brokers) never passes through here.
const CACHE = 'bakar-drive-v42-running-build';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'style.css', 'app.js', 'link-core.js', 'speed-check.js', 'guide.js', 'icon.svg', 'icon-mono.svg', '../drive-location.js'];
const LATER = ['../vendor/mqtt.min.js'];   // kept once it has been fetched, only when the phone link is set up

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map(p=>new Request(new URL(p,self.registration.scope),{cache:'reload'})))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('bakar-drive-') && k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const known = new Set(SHELL.concat(LATER).map((p) => new URL(p, self.registration.scope).pathname));
  if (!known.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.origin + url.pathname;
    try {
      const response = await Promise.race([
        fetch(event.request),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000)),
      ]);
      if (response.ok) await cache.put(key, response.clone()).catch(() => {});
      return response;
    } catch (e) {
      return (await cache.match(key)) || Response.error();
    }
  })());
});
