'use strict';
// Keeps Bakar Drive's own files on the glasses so it opens on a weak signal. Each build is served from its own install, so it opens at once; an update shows on
// the next launch. Only the files below are handled; the link to the phone (MQTT brokers) never passes through here.
const CACHE = 'bakar-drive-v52';
const ENTRY = 'runtime/drive-v52-dac530c9bdc23141.js';
const SHELL = [ENTRY, './', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'style.css', 'tape.css', 'cameras.json', 'icon.svg', 'icon-mono.svg', '../drive-location.js'];
const LATER = ['../vendor/mqtt.min.js'];   // kept once it has been fetched, only when the phone link is set up

// Report the active worker identity on request. It never relabels or reloads a document.
self.addEventListener('message',event=>{
  if(event.data==='running-shell' && event.ports[0])event.ports[0].postMessage(CACHE);
});
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map(p=>new Request(new URL(p,self.registration.scope),{cache:'reload'})))).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('bakar-drive-') && k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // The Battery app's one-line logger lives in another app on this origin. It is never part of the install (a missing
  // file must not stop this app installing); once it has been fetched it is kept, so readings carry on offline.
  if (event.request.method === 'GET' && url.origin === self.location.origin && url.pathname === '/battery-glass/battery-log.js') {
    // Kept copy first, so a slow network never holds the page; the copy is renewed behind it for the next launch.
    const renew = (async () => {
      const response = await Promise.race([fetch(event.request), new Promise((_, reject) => setTimeout(() => reject(new Error('slow network')), 3000))]);
      if (response.ok) await (await caches.open(CACHE)).put(url.origin + url.pathname, response.clone()).catch(() => {});
      return response;
    })();
    event.waitUntil(renew.catch(() => {}));
    event.respondWith((async () => (await (await caches.open(CACHE)).match(url.origin + url.pathname)) || renew.catch(() => Response.error()))());
    return;
  }
  const known = new Set(SHELL.concat(LATER).map((p) => new URL(p, self.registration.scope).pathname));
  if (!known.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const entryURL=new URL(ENTRY,self.registration.scope);
    const indexURL=new URL('index.html',self.registration.scope);
    const rootURL=new URL('./',self.registration.scope);
    // Everything installed with this build is served from the install: the page opens at once on a slow or dead network,
    // and the page, its script, its styles and the camera list are always from the same build. The link library (LATER)
    // still asks the network first.
    const fixed=new Set(SHELL.map(p=>new URL(p,self.registration.scope).pathname));
    if(fixed.has(url.pathname)){
      const installed=await cache.match(url.origin+url.pathname,{ignoreSearch:true});
      if(installed)return installed;
    }
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
