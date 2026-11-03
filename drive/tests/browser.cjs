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

const warn = async (pg) => ({ text: await pg.textContent('#speedWarn'), shown: await pg.isVisible('#speedWarn'), level: await pg.getAttribute('#hud', 'data-speed-level') });
// Where the dash and its unit sit: they must not move when the self-check line comes and goes.
const dashAt = (pg) => pg.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); return { speed: Math.round(r('speed').top), unit: Math.round(r('heading').top) }; });

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
  check(!(await warn(page)).shown, 'self-check: a live speed carries no warning line');
  const liveDash = await dashAt(page);
  await page.waitForTimeout(8300);
  check(!(await page.isVisible('#controls')), 'controls hide themselves after 8 s');
  // The 16.1 m/s reading is now old: no number from the past, a dash, and the amber line says why.
  let lost = await warn(page);
  check((await page.textContent('#speed')) === '—' && lost.shown && lost.text === 'GPS speed lost\nPair your phone when parked' && lost.level === 'warn', `self-check: the speed stopped coming: a dash and the reason (${JSON.stringify(lost.text)})`);
  const lostDash = await dashAt(page);
  check(lostDash.speed === liveDash.speed && lostDash.unit === liveDash.unit, `self-check: the dash and unit do not move when the line appears (${JSON.stringify(liveDash)} -> ${JSON.stringify(lostDash)})`);
  await layoutOk(page, 'speed lost');
  await shot('03b-speed-lost');
  // A slow reading first (walking pace): the speed is back and there is no heading, since none was good a moment ago.
  await page.evaluate(() => window.__drive(1.0, 200));
  await page.waitForTimeout(50);
  check((await page.textContent('#heading')) === '', 'no heading below walking speed');
  // Then a fresh driving reading: live, controls still hidden, no warning and nothing else changed.
  await page.evaluate(() => window.__drive(16.1, 47));
  await page.waitForTimeout(100);
  lost = await warn(page);
  check((await page.textContent('#speed')) === '58' && !lost.shown && lost.level === 'ok' && (await page.textContent('#status')) === 'Phone GPS' && !(await page.isVisible('#controls')), 'self-check: speed back means the line is gone at once, with the controls still hidden');
  await shot('03-speed-live');
  await layoutOk(page, 'speed screen');

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
  check(await page.evaluate(() => document.activeElement.id === 'panelStudio'), 'the panel opens on the Studio Drive hand-off');
  await page.keyboard.press('Escape');
  check(await page.isHidden('#panel'), 'Back (the glasses\' back gesture) closes the panel');

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
  check(await page.evaluate(() => document.activeElement.id === 'panelStudio'), 'the D-pad moves to the Studio Drive hand-off');
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement.id === 'panelBack'), 'the D-pad moves on to Back');
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

  // 5. Speed self-check: a plain amber line when speed is dead and nothing healthy backs it up; silent otherwise.
  // GPS that was started last time comes back on by itself, so each scenario forgets that first and starts GPS by a press.
  const open5 = async (pg, url) => { await pg.goto(base); await pg.evaluate(() => localStorage.removeItem('bd.gps')); await pg.goto(url); };
  const startGps = async (pg) => {
    await pg.keyboard.press('Enter'); await pg.keyboard.press('Enter');                                      // controls, then Start GPS
    check((await pg.textContent('#gpsBtn')) === 'Stop GPS', 'self-check: GPS was started by the press');
  };
  const fresh5 = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await fresh5.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
  await fresh5.addInitScript(FAKE_GEO);
  const p5 = await fresh5.newPage();
  p5.on('pageerror', (e) => errors.push(String(e)));
  const shot5 = (name) => p5.screenshot({ path: path.join(OUT, name + '.png') });

  // (a) No phone set up, glasses location refused.
  await open5(p5, base);
  await p5.waitForTimeout(200);
  check(!(await warn(p5)).shown, 'self-check: nothing to say before GPS is started');
  await startGps(p5);
  const askingDash = await dashAt(p5);
  await p5.evaluate(() => window.__deny());
  await p5.waitForTimeout(60);
  let w = await warn(p5);
  const deniedDash = await dashAt(p5);
  check(deniedDash.speed === askingDash.speed && deniedDash.unit === askingDash.unit, `self-check: the dash and unit stay put when the refusal line appears (${JSON.stringify(askingDash)} -> ${JSON.stringify(deniedDash)})`);
  check(w.shown && w.text === 'Glasses location not allowed\nPair your phone when parked' && w.level === 'warn', `self-check: refused location with no phone says what to do (${w.text})`);
  check((await p5.textContent('#speed')) === '—', 'self-check: the dash stays a dash');
  await layoutOk(p5, 'refused location, no phone');
  await shot5('11-refused-no-phone');
  check((await p5.textContent('#status')) === 'No speed', 'self-check: the top line says No speed, and the line under the dash says why');
  // The Directions panel states the source in words (Start GPS is focused: two steps right is Directions).
  await p5.keyboard.press('ArrowRight'); await p5.keyboard.press('ArrowRight');
  await p5.keyboard.press('Enter');
  await p5.waitForTimeout(30);
  check((await p5.isVisible('#panel')) && (await p5.textContent('#panelSpeed')) === 'Speed: none. Glasses GPS blocked.', 'self-check: the Directions panel says the speed source is none, and why, on one line');
  await layoutOk(p5, 'directions panel with the speed source');
  await p5.keyboard.press('Escape');                                                                           // focus comes back on Directions
  await p5.keyboard.press('ArrowLeft'); await p5.keyboard.press('ArrowLeft');
  await p5.keyboard.press('Enter');                                                                            // Start GPS again: the page asks the glasses again, on a deliberate press
  await p5.evaluate(() => window.__drive(8.3, 10));
  await p5.waitForTimeout(80);
  w = await warn(p5);
  check((await p5.textContent('#speed')) === '30' && !w.shown && (await p5.textContent('#status')) === 'Phone GPS', `self-check: speed back means the line is gone at once (${await p5.textContent('#speed')}, "${w.text}", ${await p5.textContent('#status')})`);

  // (b) A phone that has not accepted these glasses yet.
  await open5(p5, `${base}?t=${V.t}&p=${V.phone.pub}`);
  await p5.waitForFunction(() => window.__bakarDrive && window.__bakarDrive.state.keys);
  const code5 = await p5.evaluate(() => window.__bakarDrive.state.code);
  const hello5 = await p5.evaluate(() => (window.__bakarDrive.state.hellos.push('HelloIdTest5'), 'HelloIdTest5'));
  await p5.evaluate((x) => window.__bakarDrive.onDown(x), await phoneSeal(p5, { m: 'pair', ok: false, code: code5, re: hello5, at: Date.now() }));
  await startGps(p5);
  await p5.evaluate(() => window.__deny());
  await p5.waitForTimeout(60);
  w = await warn(p5);
  check(w.text === 'Glasses location not allowed\nCompare the code on your phone' && w.level === 'warn' && !w.shown, `self-check: while pairing the code is the one thing on screen; the line waits behind it (${JSON.stringify(w.text)})`);
  await layoutOk(p5, 'refused location, pairing');
  await shot5('12-refused-pairing');

  // (c) A live phone link is the speed source to come: no warning on top of a dash.
  await open5(p5, `${base}?t=${V.t}&p=${V.phone.pub}`);
  await p5.waitForFunction(() => window.__bakarDrive && window.__bakarDrive.state.keys);
  await p5.waitForFunction(() => window.__bakarDrive.state.links.length > 0);                                // the page has opened its brokers (blocked here)
  const hello5b = await p5.evaluate(() => (window.__bakarDrive.state.hellos.push('HelloIdTest6'), 'HelloIdTest6'));
  const frame5 = (seq, gps) => ({ m: 'nav', sid: 'SelfCheck01', seq, at: Date.now(), re: hello5b, nav: null, gps });
  // The brokers are blocked in this test, so the page never gets a real connection: say it is up, as it is once the phone has answered.
  // The page's own broker attempts would flip it back as they fail, so they are ended first.
  const net5 = (n) => p5.evaluate((v) => {
    const S = window.__bakarDrive.state;
    for (const l of S.links) { clearTimeout(l.retryTimer); try { l.end(true); } catch (e) { /* closed already */ } }
    S.links = []; S.net = v; window.__bakarDrive.render();
  }, n);
  await p5.evaluate((x) => window.__bakarDrive.onDown(x), await phoneSeal(p5, frame5(1, null)));
  await net5('up');
  await startGps(p5);
  await p5.evaluate(() => window.__deny());
  await p5.waitForTimeout(60);
  w = await warn(p5);
  check(!w.shown && (await p5.textContent('#status')) === 'Phone linked · no route', `self-check: phone linked, location refused: no warning, the phone is the source (${await p5.textContent('#status')})`);
  await shot5('13-refused-phone-linked');
  // The phone's speed arrives and then stops: the dash comes back with no number from the past; the link is still fresh, so still no warning.
  await p5.evaluate((x) => window.__bakarDrive.onDown(x), await phoneSeal(p5, frame5(2, { kmh: 47, hdg: 90 })));
  await p5.waitForTimeout(40);
  check((await p5.textContent('#speed')) === '47' && !(await warn(p5)).shown, 'self-check: the phone\'s speed shows with no warning');
  await p5.waitForTimeout(3700);
  w = await warn(p5);
  check((await p5.textContent('#speed')) === '—' && !w.shown, 'self-check: speed gone while the phone is still linked: a dash, no number from the past, no false alarm');
  // (d) The phone goes quiet: nothing for more than four seconds. Both sources are dead and the page says both.
  await p5.waitForTimeout(1500);
  w = await warn(p5);
  check((await p5.textContent('#speed')) === '—' && w.text === 'Glasses location not allowed\nPhone not answering' && w.level === 'warn', `self-check: the phone went quiet as well: both named (${w.text})`);
  await layoutOk(p5, 'both sources dead');
  await shot5('14-both-dead');
  // The glasses cannot reach the brokers at all: that is the story, not the phone.
  await net5('down');
  w = await warn(p5);
  check(w.text === 'Glasses location not allowed\nNo signal to phone' && w.level === 'warn', `self-check: no signal is named as no signal, not as a silent phone (${JSON.stringify(w.text)})`);
  await layoutOk(p5, 'both sources dead, no signal');
  await shot5('14b-both-dead-no-signal');
  // The display slept and woke: the page opens its brokers again, and until the phone answers it is being found, not silent.
  await net5('up');
  await p5.evaluate(() => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  await p5.waitForTimeout(40);
  await p5.keyboard.press('Enter');                                                                            // Start GPS again, by a press: the glasses refuse again
  if ((await p5.textContent('#gpsBtn')) !== 'Stop GPS') await p5.keyboard.press('Enter');
  await p5.evaluate(() => window.__deny());
  await p5.waitForTimeout(40);
  w = await warn(p5);
  const woke = await p5.evaluate(() => ({ net: window.__bakarDrive.state.net, gps: window.__bakarDrive.state.gps.status }));
  check(woke.net === 'connecting' && woke.gps === 'denied' && !w.shown && w.level === 'wait', `self-check: the display woke, the link is opening again and the glasses refuse again: no false "Phone not answering" (${JSON.stringify(woke)} ${JSON.stringify(w.text)})`);
  await shot5('14c-wake-reconnecting');
  await net5('up');
  // (e) Turn-by-turn on screen, then the phone goes quiet: the small speed corner carries the same two lines.
  await p5.evaluate((x) => window.__bakarDrive.onDown(x), await phoneSeal(p5, { m: 'nav', sid: 'SelfCheck01', seq: 3, at: Date.now(), re: hello5b,
    nav: { ss: 'OnRoute', turn: 'TURN_RIGHT', exit: 0, toTurn: '350 m', next: 'King St W', street: 'Bay St', left: '12 km', secs: 1380, pct: 41.5, sim: false }, gps: null }));
  await p5.waitForTimeout(60);
  check(await p5.isVisible('#turn') && !(await warn(p5)).shown, 'self-check: a live link with directions shows no warning');
  await p5.waitForTimeout(4300);
  w = await warn(p5);
  check(await p5.isVisible('#turn') && w.shown && w.text === 'Glasses GPS blocked\nPhone not answering', `self-check: directions paused and no speed anywhere: the corner says why, in its short words (${JSON.stringify(w.text)})`);
  const corner = await p5.evaluate(() => { const e = document.getElementById('speedWarn'); const cs = getComputedStyle(e); return { h: e.getBoundingClientRect().height, line: parseFloat(cs.lineHeight), w: e.getBoundingClientRect().width, size: parseFloat(cs.fontSize) }; });
  check(corner.h <= corner.line * 2 + 1, `self-check: the corner warning is exactly two lines, not three (${Math.round(corner.h)} px high, ${Math.round(corner.line)} px a line, ${corner.size} px type)`);
  await layoutOk(p5, 'directions paused, no speed anywhere');
  await shot5('15-guide-both-dead');
  await net5('down');
  w = await warn(p5);
  check(w.text === 'Glasses GPS blocked\nNo signal to phone', `self-check: the corner names no signal too (${JSON.stringify(w.text)})`);
  const corner2 = await p5.evaluate(() => { const e = document.getElementById('speedWarn'); const cs = getComputedStyle(e); return e.getBoundingClientRect().height <= parseFloat(cs.lineHeight) * 2 + 1; });
  check(corner2, 'self-check: and it is two lines as well');
  await layoutOk(p5, 'directions paused, no signal');
  // The Directions panel does not say "Linked to your phone." while the phone is silent or there is no signal, and its speed line is one line.
  const openPanel5 = () => p5.evaluate(() => document.getElementById('linkBtn').click());
  await openPanel5();
  await p5.waitForTimeout(30);
  check((await p5.isVisible('#panel')) && (await p5.textContent('#panelState')) === 'No signal right now.' && (await p5.textContent('#panelSpeed')) === 'Speed: none. Glasses GPS blocked.', `self-check: the panel agrees with the screen on no signal (${await p5.textContent('#panelState')} / ${await p5.textContent('#panelSpeed')})`);
  await layoutOk(p5, 'directions panel, no signal, code shown');
  await p5.keyboard.press('Escape');
  await net5('up');
  await openPanel5();
  await p5.waitForTimeout(30);
  check((await p5.isVisible('#panel')) && (await p5.textContent('#panelState')) === 'Your phone is not answering.' && (await p5.textContent('#panelSpeed')) === 'Speed: none. Glasses GPS blocked.', `self-check: the panel agrees with the screen on a silent phone (${await p5.textContent('#panelState')} / ${await p5.textContent('#panelSpeed')})`);
  await layoutOk(p5, 'directions panel, silent phone, code shown');
  await shot5('16-panel-silent-phone');
  await fresh5.close();

  // (f) Launch with a saved phone link: GPS comes back on by itself and the glasses refuse it at once, before the page has read the saved
  // link (reading it takes a while on the glasses). Until the link is read nothing is known about the phone, so no "Pair your phone".
  const fresh6 = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await fresh6.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
  await fresh6.addInitScript(FAKE_GEO);
  await fresh6.addInitScript(`(() => {
    try { localStorage.setItem('bd.gps', 'on'); } catch (e) {}
    const g = navigator.geolocation, watch = g.watchPosition.bind(g);
    g.watchPosition = (ok, fail) => { const id = watch(ok, fail); setTimeout(() => fail({ code: 1 }), 0); return id; };
    for (const name of ['importKey', 'deriveBits', 'deriveKey', 'generateKey']) {
      const f = SubtleCrypto.prototype[name];
      SubtleCrypto.prototype[name] = async function (...a) { await new Promise((r) => setTimeout(r, 250)); return f.apply(this, a); };
    }
    window.__warnLog = []; window.__samples = [];
    new MutationObserver(() => { const e = document.getElementById('speedWarn'); window.__warnLog.push(e.hidden ? '' : e.textContent); })
      .observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    setInterval(() => { const b = window.__bakarDrive; if (b) window.__samples.push([b.state.setup, b.state.gps.status]); }, 20);
  })();`);
  const p6 = await fresh6.newPage();
  p6.on('pageerror', (e) => errors.push(String(e)));
  await p6.goto(`${base}?t=${V.t}&p=${V.phone.pub}`);
  await p6.waitForFunction(() => window.__bakarDrive && window.__bakarDrive.state.setup === true);
  await p6.waitForTimeout(300);
  const launch = await p6.evaluate(() => ({ log: window.__warnLog, samples: window.__samples, status: window.__bakarDrive.state.gps.status, net: window.__bakarDrive.state.net }));
  check(launch.samples.some(([setup, status]) => setup === false && status === 'denied'), 'self-check: at launch the refusal really did land before the saved phone link was read');
  check(launch.status === 'denied' && launch.log.every((t) => t === ''), `self-check: and the page said nothing false about the phone meanwhile (${JSON.stringify(launch.log.filter((t) => t))})`);
  await fresh6.close();

  // Size budget for the first load (without the phone link library).
  const sizes = ['index.html', 'style.css', 'app.js', 'link-core.js', 'speed-check.js', '../drive-location.js'].map((f) => fs.statSync(path.join(ROOT, 'drive', f)).size);
  const total = sizes.reduce((a, b) => a + b, 0);
  check(total < 120 * 1024, `first load is ${Math.round(total / 1024)} KB of our files (budget 300 KB with everything)`);
  check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
