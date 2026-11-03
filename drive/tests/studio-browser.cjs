'use strict';
// Desktop-browser checks of Studio Drive (Home's Drive tab) at 600×600 for the speed self-check: the amber two-line warning, the dash
// that must not move when the warning comes and goes, and nothing overflowing, spilling over the top bar or covering the dash. No outside
// network; the glasses' own location is played by this script and so is the Journal link (its state snapshot is replaced, no brokers).
// Run: node drive/tests/studio-browser.cjs [outDir]    (needs Playwright with Chromium)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');            // the glass-home folder, served at /glass-home/
const OUT = process.argv[2] || path.join(__dirname, 'out-studio');
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
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

// A fake location feed under the test's control: speed in m/s and a course, or a refusal (error code 1), as when the phone's Meta AI
// app has no location access.
const FAKE_GEO = `(() => {
  const watchers = new Map(); let n = 0; window.__fix = null;
  const geo = { watchPosition(ok, fail) { const id = ++n; watchers.set(id, { ok, fail }); if (window.__fix) setTimeout(() => ok(window.__fix()), 10); return id; },
    clearWatch(id) { watchers.delete(id); }, getCurrentPosition() {} };
  Object.defineProperty(navigator, 'geolocation', { get: () => geo });
  window.__drive = (mps, heading) => { window.__fix = () => ({ timestamp: Date.now(), coords: { speed: mps, heading, accuracy: 8, latitude: 0, longitude: 0 } }); for (const w of watchers.values()) w.ok(window.__fix()); };
  window.__deny = () => { window.__fix = null; for (const w of watchers.values()) w.fail({ code: 1 }); };
  const perm = { state: 'granted', onchange: null };
  Object.defineProperty(navigator, 'permissions', { get: () => ({ query: async () => perm }) });
})();`;

const NAV = { ss: 'OnRoute', turn: 'TURN_RIGHT', exit: 0, toTurn: '350 m', next: 'King St W', street: 'Bay St', left: '12 km', secs: 1380, pct: 41.5, sim: false };

// Everything the page shows about the speed, and where it sits.
const measure = (pg) => pg.evaluate(() => {
  const st = document.getElementById('driveState');
  const range = document.createRange();
  range.selectNodeContents(st);
  const box = range.getBoundingClientRect();
  const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
  const top = document.querySelector('.top');
  const d = document.documentElement;
  return {
    text: st.textContent, level: document.getElementById('driveHud').dataset.level, speed: document.getElementById('driveSpeed').textContent,
    lines, textTop: box.top, textBottom: box.bottom, left: box.left, right: box.right,
    speedTop: document.getElementById('driveSpeed').getBoundingClientRect().top, unitTop: document.querySelector('.gps-unit').getBoundingClientRect().top,
    headerBottom: top && top.getClientRects().length ? top.getBoundingClientRect().bottom : 0,
    colour: getComputedStyle(st).color, scroll: d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1,
    turn: !document.getElementById('driveTurn').hidden,
  };
});

// The rows of the screen between two heights that have any lit pixel, as bands [first row, last row]: the lines of the warning, then
// the dash. Where the glyphs really are, not where their boxes are.
async function bands(pg, y0, y1) {
  const png = await pg.screenshot({ clip: { x: 0, y: y0, width: 600, height: y1 - y0 } });
  const rows = await pg.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, lit = [];
    for (let y = 0; y < c.height; y++) { let on = false; for (let x = 0; x < c.width && !on; x++) { const i = (y * c.width + x) * 4; on = Math.max(d[i], d[i + 1], d[i + 2]) > 70; } lit.push(on); }
    return lit;
  }, png.toString('base64'));
  const out = []; let from = -1;
  rows.forEach((on, y) => { if (on && from < 0) from = y; if (!on && from >= 0) { out.push([y0 + from, y0 + y - 1]); from = -1; } });
  if (from >= 0) out.push([y0 + from, y0 + rows.length - 1]);
  return out;
}

async function run(browser, height, tag) {
  const ctx = await browser.newContext({ viewport: { width: 600, height }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());     // no outside network
  await ctx.addInitScript(FAKE_GEO);
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/glass-home/#tab=drive`);
  await page.waitForTimeout(600);
  if (!(await page.isVisible('#driveHud'))) { await page.click('#section-drive').catch(() => {}); await page.waitForTimeout(300); }
  check(await page.isVisible('#driveHud'), `${tag}: the Drive screen is up`);

  // The Journal link, played by the test: replace the snapshot the page reads and repaint.
  const phone = (state, over = {}) => page.evaluate(([st, o]) => {
    window.__ph = { state: st, configured: true, enabled: true, gps: null, nav: null, offer: false, code: '123456', problem: '', ...o };
    drivePhone.snapshot = () => window.__ph; paintDrive(driveFeed.snapshot());
  }, [state, over]);
  const unpaired = () => page.evaluate(() => {
    window.__ph = { state: 'unpaired', configured: false, enabled: true, gps: null, nav: null, offer: false, code: '' };
    drivePhone.snapshot = () => window.__ph; paintDrive(driveFeed.snapshot());
  });
  const shot = async (name, want) => {
    await page.waitForTimeout(80);
    const m = await measure(page);
    const b = await bands(page, Math.ceil(m.headerBottom) + 1, Math.floor(m.unitTop));
    m.ink = { dash: b[b.length - 1], above: b.length > 1 ? b[b.length - 2] : null, count: b.length };
    await page.screenshot({ path: path.join(OUT, `${name}${height === 600 ? '' : '-' + height}.png`) });
    check(m.text === want.text && m.level === want.level && m.speed === want.speed, `${tag} ${name}: says ${JSON.stringify(want.text)} (${want.level}), the dash shows ${want.speed} (${JSON.stringify(m.text)}, ${m.level}, ${m.speed})`);
    return m;
  };
  const GRACE = { text: '', level: 'ok', speed: '—' };

  // No phone set up, GPS not started: the calm start screen, the reference for where the dash sits.
  await unpaired();
  const start = await shot('s0-start', { text: 'GPS not started in this app', level: 'ok', speed: '—' });
  check(!start.scroll, `${tag}: the start screen fits without scrolling`);
  await page.evaluate(() => { driveFeed.setVisible(true); driveFeed.enable(); });
  await page.waitForTimeout(100);

  const seen = [];          // [name, measure] of every screen below, for the common checks
  await page.evaluate(() => window.__deny());
  seen.push(['s1-unpaired-denied', await shot('s1-unpaired-denied', { text: 'Glasses location not allowed\nPair your phone when parked', level: 'warn', speed: '—' })]);
  await phone('ready');
  seen.push(['s2-paired-denied-calm', await shot('s2-paired-denied-calm', { text: 'Phone linked · waiting for GPS', level: 'ok', speed: '—' })]);
  await phone('live', { gps: { kmh: 62, hdg: 90 }, ageMs: 300 });
  seen.push(['s3-phone-speed', await shot('s3-phone-speed', { text: 'Phone link · GPS estimate', level: 'ok', speed: '62' })]);
  await phone('stale');
  seen.push(['s4-phone-speed-dead', await shot('s4-phone-speed-dead', { text: 'Phone speed expired', level: 'warn', speed: '—' })]);
  await phone('offline');
  seen.push(['s5-denied-no-signal', await shot('s5-denied-no-signal', { text: 'Glasses location not allowed\nNo signal to phone', level: 'warn', speed: '—' })]);
  await phone('pairing');
  seen.push(['s6-denied-pairing', await shot('s6-denied-pairing', { text: 'Glasses location not allowed\nCompare the code on your phone', level: 'warn', speed: '—' })]);
  await phone('unavailable', { configured: false });
  seen.push(['s6b-denied-no-secure-link', await shot('s6b-denied-no-secure-link', { text: 'Glasses location not allowed\nPhone link unavailable', level: 'warn', speed: '—' })]);
  await unpaired();
  await page.evaluate(() => driveFeed.enable());                                                                // Start again, as a press does
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__drive(16.1, 47));
  seen.push(['s7-glasses-speed', await shot('s7-glasses-speed', { text: 'App location · GPS estimate', level: 'ok', speed: '58' })]);
  await page.waitForFunction(() => document.getElementById('driveSpeed').textContent === '—', null, { timeout: 9000 });
  seen.push(['s8-glasses-speed-lost', await shot('s8-glasses-speed-lost', { text: 'GPS speed lost\nPair your phone when parked', level: 'warn', speed: '—' })]);
  // the day look (the brightest, for sunlight) and the night look of the same line
  for (const look of ['day', 'night']) {
    await page.evaluate((l) => { document.getElementById('driveHud').dataset.light = l; }, look);
    seen.push([`s9-lost-${look}`, await shot(`s9-lost-${look}`, { text: 'GPS speed lost\nPair your phone when parked', level: 'warn', speed: '—' })]);
  }
  await page.evaluate(() => { delete document.getElementById('driveHud').dataset.light; });

  // Common to every screen above.
  for (const [name, m] of seen) {
    check(Math.abs(m.speedTop - start.speedTop) < 0.5 && Math.abs(m.unitTop - start.unitTop) < 0.5, `${tag} ${name}: the dash and unit have not moved (${Math.round(m.speedTop)} px, start screen ${Math.round(start.speedTop)} px)`);
    const same = m.speed === '—' ? start : seen.find(([, x]) => x.speed !== '—')[1];   // the same glyphs: a dash against the dash, a number against a number
    check(m.ink.dash[0] === same.ink.dash[0] && m.ink.dash[1] === same.ink.dash[1], `${tag} ${name}: and what is drawn is on the same rows (${m.ink.dash}, reference ${same.ink.dash})`);
    check(!m.scroll, `${tag} ${name}: fits without scrolling`);
    if (m.level === 'warn' && m.text.includes('\n')) {
      check(m.lines === 2, `${tag} ${name}: the warning is exactly two lines (${m.lines})`);
      check(m.left >= 0 && m.right <= 600, `${tag} ${name}: the warning is inside the screen width (${Math.round(m.left)}-${Math.round(m.right)})`);
      check(m.textTop >= m.headerBottom, `${tag} ${name}: the warning stays under the top bar (${Math.round(m.textTop)} px, bar ends ${Math.round(m.headerBottom)} px)`);
      check(m.ink.above && m.ink.above[0] >= m.headerBottom + 6, `${tag} ${name}: the lit warning stays clear of the top bar (starts ${m.ink.above && m.ink.above[0]} px, bar ends ${Math.round(m.headerBottom)} px)`);
      check(m.ink.above && m.ink.dash[0] - m.ink.above[1] >= 12, `${tag} ${name}: and clear of the dash (text ends ${m.ink.above && m.ink.above[1]} px, dash starts ${m.ink.dash[0]} px)`);
    }
    if (m.level === 'warn') check(m.colour === 'rgb(255, 193, 94)', `${tag} ${name}: amber (${m.colour})`);
    else check(m.colour !== 'rgb(255, 193, 94)', `${tag} ${name}: a calm screen is not amber (${m.colour})`);
  }

  // Directions on screen: the turn line adds one line for every state alike, and the dash still stays put between calm and warning.
  await phone('live', { nav: NAV, gps: null });
  await page.evaluate(() => window.__deny());
  const guideCalm = await shot('s10-guide-calm', { text: 'Phone GPS through Journal', level: 'ok', speed: '—' });
  await phone('stale', { nav: NAV });
  const guideDead = await shot('s11-guide-phone-speed-dead', { text: 'Phone speed expired', level: 'warn', speed: '—' });
  await phone('offline', { nav: NAV });
  const guideOffline = await shot('s12-guide-no-signal', { text: 'Glasses location not allowed\nNo signal to phone', level: 'warn', speed: '—' });
  check(guideCalm.turn && guideDead.turn && guideOffline.turn, `${tag}: the turn line is up on all three direction screens`);
  check(Math.abs(guideDead.speedTop - guideCalm.speedTop) < 0.5 && Math.abs(guideOffline.speedTop - guideCalm.speedTop) < 0.5, `${tag}: with directions on screen the dash does not move either (${Math.round(guideCalm.speedTop)}, ${Math.round(guideDead.speedTop)}, ${Math.round(guideOffline.speedTop)} px)`);
  check(!guideOffline.scroll && guideOffline.lines === 2 && guideOffline.ink.dash[0] - guideOffline.ink.above[1] >= 12, `${tag}: and the warning above them is two lines that fit and clear the dash`);
  check(guideDead.ink.dash[0] === guideCalm.ink.dash[0] && guideOffline.ink.dash[0] === guideCalm.ink.dash[0], `${tag}: nor is the dash drawn on other rows (${guideCalm.ink.dash[0]}, ${guideDead.ink.dash[0]}, ${guideOffline.ink.dash[0]})`);

  check(errors.length === 0, `${tag}: no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  await run(browser, 600, '600x600');
  await run(browser, 480, '600x480');          // the short layout (max-height 500px) has its own sizes
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
