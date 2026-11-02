'use strict';
// Desktop-browser checks of the glasses page at 600×600: GPS speed, the turn screens, pairing, light looks,
// controls, no scrolling and no overflowing text. The phone is played by this script with the test keys in
// vectors.json; brokers are blocked, so directions are handed to the page's own message entry.
// Run: node tests/browser.cjs [outDir]    (needs Playwright with Chromium)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const L = require('../link-core.js');
const V = require('./vectors.json');
const ROOT = path.resolve(__dirname, '..', '..');            // the glass-home folder, served at /glass-home/
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const subtle = globalThis.crypto.subtle;
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/glass-home/')) { res.writeHead(404); res.end(); return; }
  let p = path.join(ROOT, decodeURIComponent(u.pathname.slice('/glass-home/'.length)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// A fake phone GPS: speed in m/s and a course, under the page's control from the test.
const FAKE_GEO = `(() => {
  const watchers = new Map(); let n = 0; window.__fix = null;
  const geo = {
    watchPosition(ok, fail) { const id = ++n; watchers.set(id, { ok, fail }); if (window.__fix) setTimeout(() => ok(window.__fix()), 10); return id; },
    clearWatch(id) { watchers.delete(id); }, getCurrentPosition() {},
  };
  Object.defineProperty(navigator, 'geolocation', { get: () => geo });
  window.__drive = (mps, heading) => {
    window.__fix = () => ({ timestamp: Date.now(), coords: { speed: mps, heading, accuracy: 8, latitude: 0, longitude: 0 } });
    for (const w of watchers.values()) w.ok(window.__fix());
  };
  // The glasses' own location is refused (error code 1), as when the phone's Meta AI app has no location access.
  window.__deny = () => { window.__fix = null; for (const w of watchers.values()) w.fail({ code: 1 }); };
  const perm = { state: 'granted', onchange: null };
  Object.defineProperty(navigator, 'permissions', { get: () => ({ query: async () => perm }) });
})();`;

async function phoneSeal(page, obj) {
  // The phone side: phone private key from the vectors, the page's own public key.
  const devPubB64 = await page.evaluate(() => window.__bakarDrive.state.devPubB64);
  const devId = await page.evaluate(() => window.__bakarDrive.state.devId);
  const phone = await subtle.importKey('pkcs8', L.fromB64url(V.phone.pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const dev = await subtle.importKey('raw', L.fromB64url(devPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: dev }, phone, 256);
  const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const down = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(L.SALT), info: new TextEncoder().encode(`down|${devId}|${V.t}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  return '1.' + await L.seal(subtle, down, obj);
}

async function layoutOk(page, what) {
  const r = await page.evaluate(() => {
    const d = document.documentElement;
    const over = [];
    for (const el of document.querySelectorAll('#hud p, #hud h1, #hud button')) {
      if (el.closest('[hidden]') || !el.getClientRects().length) continue;
      const b = el.getBoundingClientRect();
      if (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1 || b.top < -1) over.push(el.id || el.className);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis' && !el.classList.contains('next')) over.push((el.id || el.className) + ':clipped');
    }
    return { scroll: d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1, over };
  });
  check(!r.scroll && !r.over.length, `${what}: fits 600×600 without scrolling${r.over.length ? ' (' + r.over.join(', ') + ')' : ''}`);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/glass-home/drive/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());     // no outside network: brokers fail as offline
  await ctx.addInitScript(FAKE_GEO);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });

  // 1. No phone link: GPS off, then live speed and heading.
  await page.goto(base);
  await page.waitForTimeout(300);
  check((await page.textContent('#status')) === 'Phone GPS off', 'starts with GPS off and says so');
  check((await page.textContent('#speed')) === '—', 'no speed shown before GPS');
  await shot('01-gps-off');
  await page.keyboard.press('Enter');
  check(await page.isVisible('#controls'), 'a press shows the controls');
  await shot('02-controls');
  await page.keyboard.press('Enter');                                  // Start GPS (focused first)
  await page.evaluate(() => window.__drive(16.1, 47));
  await page.waitForTimeout(100);
  check((await page.textContent('#speed')) === '58', 'speed 16.1 m/s shows as 58 km/h');
  check((await page.textContent('#heading')) === 'NE', 'course 47° shows as NE');
  check((await page.textContent('#status')) === 'Phone GPS', 'top line says Phone GPS');
  await shot('03a-speed-live');
  await page.waitForTimeout(8300);
  check(!(await page.isVisible('#controls')), 'controls hide themselves after 8 s');
  await shot('03-speed-live');
  await layoutOk(page, 'speed screen');
  await page.evaluate(() => window.__drive(1.0, 200));
  await page.waitForTimeout(50);
  check((await page.textContent('#heading')) === '', 'no heading below walking speed');

  // 2. With the phone link address: pairing, then directions.
  await page.goto(`${base}?t=${V.t}&p=${V.phone.pub}`);
  await page.waitForFunction(() => window.__bakarDrive && window.__bakarDrive.state.keys);
  const code = await page.evaluate(() => window.__bakarDrive.state.code);
  check(/^\d{6}$/.test(code), 'the page computes its six-digit pairing code');
  const hello = await page.evaluate(() => (window.__bakarDrive.state.hellos.push('HelloIdTest1'), 'HelloIdTest1'));
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { m: 'pair', ok: false, code, re: hello, at: Date.now() }));
  await page.waitForTimeout(50);
  check((await page.textContent('#pairCode')) === `${code.slice(0, 3)} ${code.slice(3)}` && await page.isVisible('#pairBox'), 'an unpaired reply shows the code to accept on the phone, big');
  check((await page.textContent('#status')) === 'Pair with your phone', 'top line asks to pair');
  await layoutOk(page, 'pairing screen');
  await shot('04-pairing');
  let sid = 'TestSess01';
  const nav = (seq, over = {}) => ({ m: 'nav', sid, seq, at: Date.now(), re: hello,
    nav: { ss: 'OnRoute', turn: 'TURN_RIGHT', exit: 0, toTurn: '350 m', next: 'King St W', street: 'Bay St', left: '12 km', secs: 1380, pct: 41.5, sim: false, ...over } });
  await page.evaluate(() => window.__drive(13.9, 92));
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(1)));
  await page.waitForTimeout(50);
  check((await page.textContent('#toTurn')) === '350 m', 'the distance to the turn shows as sent');
  check((await page.textContent('#next')) === 'King St W', 'the next street shows');
  check((await page.textContent('#status')) === 'Bakar Drive', 'top line says Bakar Drive');
  check((await page.textContent('#arriveTime')).startsWith('Arrive ') && (await page.textContent('#arriveLeft')) === '12\u00a0km to go', 'arrival time and distance left show');
  check((await page.textContent('#speed')) === '50', 'speed stays alongside directions');
  await shot('05-turn-right');
  await layoutOk(page, 'turn screen');
  const before = await page.textContent('#toTurn');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(1, { toTurn: '9 km' })));
  check((await page.textContent('#toTurn')) === before, 'a repeated sequence number is ignored');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { ...nav(2), at: Date.now() - 600000 }));
  check((await page.textContent('#toTurn')) === before, 'a frame ten minutes old is ignored');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), 'junk');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), '1.' + 'A'.repeat(80));
  check((await page.textContent('#toTurn')) === before, 'junk and forged payloads change nothing');
  const { re: _drop, ...noRe } = nav(4, { toTurn: '1 m' });
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, noRe));
  check((await page.textContent('#toTurn')) === before, 'a frame that answers no hello is ignored');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { ...nav(5, { toTurn: '1 m' }), re: 'RecordedOld1' }));
  check((await page.textContent('#toTurn')) === before, 'a frame answering a hello from before the page opened is ignored');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), '1.' + 'A'.repeat(6000));
  check((await page.textContent('#toTurn')) === before, 'an oversized payload is ignored');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { m: 'pair', ok: false, code, at: Date.now() }));
  await page.waitForTimeout(20);
  check((await page.textContent('#status')) === 'Bakar Drive' && (await page.textContent('#toTurn')) === before, 'a pair reply naming no hello changes nothing');

  // Long street name and the stale state.
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(3, { turn: 'TURN_SLIGHT_LEFT', toTurn: '1.2 km', next: 'Don Valley Parkway Northbound Express Collector Lanes Toward Highway 401' })));
  await page.waitForTimeout(50);
  await shot('06-long-name');
  await layoutOk(page, 'long street name');
  await page.waitForTimeout(4300);
  check((await page.textContent('#status')).includes('directions paused') || (await page.textContent('#status')) === 'Directions paused', 'after 4 s without a frame the turn dims and says paused');
  check(await page.evaluate(() => document.getElementById('turn').classList.contains('stale')), 'the old turn is dimmed');
  await shot('07-paused');

  // Every turn the navigator can send, on one sheet.
  const turns = L.TURNS;
  let seq = 10;
  for (const t of turns) {
    await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++, { turn: t, exit: t.includes('ROUND') ? 2 : 0, next: t.toLowerCase() })));
    await page.waitForTimeout(20);
    const drawn = await page.evaluate(() => document.getElementById('arrow').innerHTML.length > 20);
    check(drawn, `arrow drawn for ${t}`);
    await page.locator('#arrow').screenshot({ path: path.join(OUT, `turn-${t}.png`) });
  }
  // Route states.
  for (const [ss, expect] of [['RouteNotStarted', 'Route ready'], ['RouteFinished', 'Arrived'], ['RouteBuilding', 'Finding route…']]) {
    await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++, { ss })));
    await page.waitForTimeout(20);
    check((await page.textContent('#toTurn')) === expect, `${ss} shows "${expect}"`);
  }
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++, { ss: 'OffRoute' })));
  check((await page.textContent('#status')) === 'Off route', 'off route is said on the top line');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++, { sim: true })));
  check((await page.textContent('#status')).includes('demo'), 'a demo drive is labelled as demo');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { m: 'nav', sid, seq: seq++, at: Date.now(), re: hello, nav: null }));
  await page.waitForTimeout(20);
  check(await page.isHidden('#turn'), 'no route: the turn goes away and speed is big again');
  check((await page.textContent('#status')) === 'Phone linked · no route', 'no route is said plainly');

  // The phone's own GPS speed and heading ride on the frames: they are the speed on screen while fresh, they work
  // when the glasses' own location is refused, and a missing, old or malformed reading never shows a made-up number.
  const withGps = (gps, over = {}) => ({ ...nav(seq++, over), gps });
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, withGps({ kmh: 83, hdg: 270 })));
  await page.waitForTimeout(30);
  check((await page.textContent('#speed')) === '83' && (await page.textContent('#heading')) === 'W', 'phone speed 83 km/h and heading W show, over the glasses\' own 50');
  const tt1 = await page.textContent('#toTurn');
  check(tt1 === '350\u00a0m', `directions still show beside the phone\'s speed (toTurn "${tt1}")`);
  await shot('05b-phone-speed');
  await layoutOk(page, 'phone speed with a turn');
  await page.evaluate(() => window.__deny());
  await page.waitForTimeout(30);
  check((await page.textContent('#speed')) === '83', 'the glasses\' location refused: the phone\'s speed stays');
  await page.waitForTimeout(3700);
  check((await page.textContent('#speed')) === '—' && (await page.textContent('#heading')) === '', 'no reading from the phone for 3.5 s and no location of its own: a dash, never a stale number');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, withGps({ kmh: 0, hdg: null })));
  await page.waitForTimeout(30);
  check((await page.textContent('#speed')) === '0' && (await page.textContent('#heading')) === '', 'a measured zero shows as 0, with no heading');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, withGps(null)));
  await page.waitForTimeout(30);
  check((await page.textContent('#speed')) === '—', 'a frame without a reading shows a dash');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, withGps({ kmh: -5, hdg: 400 })));
  await page.waitForTimeout(30);
  const tt2 = await page.textContent('#toTurn');
  check((await page.textContent('#speed')) === '—' && tt2 === '350\u00a0m', `a malformed reading is dropped and the directions still show (toTurn "${tt2}")`);
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { m: 'nav', sid, seq: seq++, at: Date.now(), re: hello, nav: null, gps: { kmh: 61, hdg: 12 } }));
  await page.waitForTimeout(30);
  check((await page.textContent('#speed')) === '61' && (await page.textContent('#heading')) === 'N' && (await page.textContent('#status')) === 'Phone linked · no route', 'with no route the phone\'s speed still shows');
  await layoutOk(page, 'phone speed without a route');
  await shot('05c-phone-speed-no-route');

  // The phone's sender restarts: the new session takes over and the old one can't come back.
  const oldSid = sid;
  sid = 'TestSess02';
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(0, { toTurn: '80 m' })));
  await page.waitForTimeout(20);
  check((await page.textContent('#toTurn')) === '80 m', 'a restarted phone sender is followed');
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, { ...nav(seq + 100, { toTurn: '5 km' }), sid: oldSid, at: Date.now() + 1000 }));
  await page.waitForTimeout(20);
  check((await page.textContent('#toTurn')) === '80 m', 'frames from the ended session are ignored');

  // Light looks and the directions panel.
  await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++)));
  for (const look of ['day', 'dusk', 'night']) {
    await page.evaluate((l) => { localStorage.setItem('bd.light', l); }, look);
    await page.evaluate((p) => window.__bakarDrive.onDown(p), await phoneSeal(page, nav(seq++)));
    await page.waitForTimeout(30);
    check((await page.getAttribute('#hud', 'data-light')) === look, `light ${look} applies`);
    await shot(`08-light-${look}`);
  }
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  check(await page.isVisible('#panel'), 'Directions opens the panel');
  await shot('09-panel');
  await layoutOk(page, 'directions panel');
  await page.keyboard.press('Enter');
  check(await page.isHidden('#panel'), 'Back closes the panel');

  // 3. A link for a different phone: asked first, never taken over silently.
  const other = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p2 = L.toB64url(new Uint8Array(await subtle.exportKey('raw', other.publicKey)));
  const firstCode = code;
  await page.goto(`${base}?t=${V.t}&p=${p2}`);
  await page.waitForSelector('#panel:not([hidden])');
  check((await page.textContent('#panelState')) === 'This link is for a different phone.', 'a different phone link asks first');
  check(await page.evaluate(() => document.activeElement.id === 'panelUse'), 'Use this phone is ready for a pinch');
  check(await page.evaluate((p) => window.__bakarDrive.state.addr.p !== p, p2), 'the kept phone keeps working while it asks');
  await layoutOk(page, 'different phone panel');
  await shot('10-other-phone');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement.id === 'panelBack'), 'the D-pad moves to Back');
  await page.keyboard.press('Enter');
  check(await page.isHidden('#panel') && await page.evaluate(() => location.search === ''), 'Back keeps the current phone and clears the address');
  await page.goto(base);
  await page.waitForFunction(() => window.__bakarDrive.state.keys);
  check(await page.evaluate((p) => window.__bakarDrive.state.addr.p === p, V.phone.pub) && await page.isHidden('#panel'), 'after Back the kept phone is still the one used');
  await page.goto(`${base}?t=${V.t}&p=${p2}`);
  await page.waitForSelector('#panel:not([hidden])');
  await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);   // the page starts again on the new link
  await page.waitForFunction((p) => window.__bakarDrive && window.__bakarDrive.state.keys && window.__bakarDrive.state.addr.p === p, p2);
  const newCode = await page.evaluate(() => window.__bakarDrive.state.code);
  check(newCode !== firstCode && /^\d{6}$/.test(newCode) && await page.isHidden('#panel'), 'Use this phone switches, with a new glasses key and code');
  const badP = L.toB64url(Uint8Array.from({ length: 65 }, (_, i) => (i ? 0 : 4)));
  await page.goto(`${base}?t=${V.t}&p=${badP}`);
  await page.waitForFunction(() => window.__bakarDrive.state.keys);
  await page.waitForTimeout(100);
  check(await page.isHidden('#panel') && await page.evaluate((p) => window.__bakarDrive.state.addr.p === p, p2), 'a broken link is never offered');

  // 4. A first link whose key doesn't work is not kept.
  const fresh = await browser.newContext({ viewport: { width: 600, height: 600 } });
  await fresh.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
  const page2 = await fresh.newPage();
  page2.on('pageerror', (e) => errors.push(String(e)));
  await page2.goto(`${base}?t=${V.t}&p=${badP}`);
  await page2.waitForTimeout(500);
  const kept = await page2.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('bakar-drive', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => { const g = r.result.transaction('keys').objectStore('keys').getAllKeys(); g.onsuccess = () => res(g.result); g.onerror = () => res(['error']); };
    r.onerror = () => res(['error']);
  }));
  check(kept.length === 0 && await page2.evaluate(() => !window.__bakarDrive.state.keys), 'a link whose key fails is not kept, and no glasses key is stored for it');
  await fresh.close();

  // Size budget for the first load (without the phone link library).
  const sizes = ['index.html', 'style.css', 'app.js', 'link-core.js', '../drive-location.js'].map((f) => fs.statSync(path.join(ROOT, 'drive', f)).size);
  const total = sizes.reduce((a, b) => a + b, 0);
  check(total < 120 * 1024, `first load is ${Math.round(total / 1024)} KB of our files (budget 300 KB with everything)`);
  check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
