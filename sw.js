'use strict';

// Keeps the app shell on the glasses so it opens at once on a slow link or none. Each build installs its whole shell and
// serves it from that install; a new build shows on the next launch after it has installed. Only this app's own files are handled; the link to the PC (the MQTT brokers) never passes through here.
const CACHE = 'glass-home-v52';
const ENTRY = 'runtime/home-v52-f75bd153d4f57a57.js';
const SHELL = [ENTRY, './', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'style.css','readable.css', 'vendor/mqtt.min.js', 'apps.json', 'icon.svg', 'icon-mono.svg','home-shell.css','drive/tape.css','drive/cameras.json','review/index.html','review/app.js','review/style.css','review/readable.css','review/review.js','review/navigation.js','review/embedded.js','review/embedded.css','review/icon.svg','review/icon-mono.svg'];
const PRECACHE = SHELL.filter(path=>!path.startsWith('review/'));

// Report the active worker identity on request. It never relabels or reloads a document.
self.addEventListener('message',event=>{
  if(event.data==='running-shell' && event.ports[0])event.ports[0].postMessage(CACHE);
});
self.addEventListener('install', (event) => {
  // New navigations can use the complete new shell. Existing documents keep running.
  // Review loads only on deliberate entry.
  // A new shell must not seed itself from a still-fresh HTTP cache for the prior release.
  const requests=PRECACHE.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'}));
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(requests)).then(()=>self.skipWaiting()));
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
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const shellPaths = new Set(SHELL.map(p=>new URL(p,self.registration.scope).pathname));
  if (!shellPaths.has(url.pathname)) return; // Never cache task/API/private-image responses.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const entryURL=new URL(ENTRY,self.registration.scope);
    const indexURL=new URL('index.html',self.registration.scope);
    const rootURL=new URL('./',self.registration.scope);
    // Everything installed with this build is served from the install: the page opens at once on a slow or dead network,
    // and the page, its script and its styles are always from the same build. Only the apps list (data, not code) and
    // Review's files (fetched on entry, not installed) ask the network first.
    const fixed=new Set(PRECACHE.filter(p=>p!=='apps.json').map(p=>new URL(p,self.registration.scope).pathname));
    if(fixed.has(url.pathname)||url.pathname===entryURL.pathname||url.pathname===indexURL.pathname||url.pathname===rootURL.pathname){
      const installed=await cache.match(url.origin+url.pathname,{ignoreSearch:true});
      if(installed)return installed;
    }
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
