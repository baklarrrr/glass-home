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
  const geo = { watchPosition(ok, fail) { const id = ++n; watchers.set(id, { ok, fail }); if (window.__fix) {const last=window.__fix();setTimeout(() => ok(last),10);} return id; },
    clearWatch(id) { watchers.delete(id); }, getCurrentPosition(ok, fail) { const id=++n;watchers.set(id,{ok(p){watchers.delete(id);ok(p);},fail(e){watchers.delete(id);fail(e);}}); } };
  Object.defineProperty(navigator, 'geolocation', { get: () => geo });
  window.__drive = (mps, heading) => { window.__fix = () => ({ timestamp: Date.now(), coords: { speed: mps, heading, accuracy: 8, latitude: 0, longitude: 0 } }); for (const w of [...watchers.values()]) w.ok(window.__fix()); };
  window.__at = (lat, lon, mps, heading) => { const at=Date.now();window.__fix = () => ({ timestamp: at, coords: { speed: mps, heading, accuracy: 8, latitude: lat, longitude: lon } }); for (const w of [...watchers.values()]) w.ok(window.__fix()); }
  window.__deny = () => { window.__fix = null; for (const w of watchers.values()) w.fail({ code: 1 }); };
  const perm = { state: window.__grantAtStart ? 'granted' : 'prompt', onchange: null }; window.__perm = perm;   // not allowed yet, unless a test says so: looking at Drive must not start anything then
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
  // The shipped camera list loads by itself when Drive opens. The screens below then run with an empty list, so a real
  // camera near the made-up test place can never change them; the camera section at the end brings its own.
  await page.waitForFunction(() => typeof driveCams !== 'undefined' && driveCams && driveCams.count > 300, null, { timeout: 8000 }).catch(() => {});
  check(await page.evaluate(() => driveCams.count > 300 && /^\d{4}-\d{2}-\d{2}$/.test(driveCams.made)), `${tag}: the shipped camera list loads when Drive opens (${await page.evaluate(() => driveCams.count + ' sites, ' + driveCams.made)})`);
  await page.evaluate(() => driveCams.load({ made: '2026-11-11', items: [] }));

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
    const m=await measure(page);
    const details=await page.locator('#driveHealthDetail').textContent();
    const source=await page.locator('#driveHud').getAttribute('data-source');
    const isCamera=await page.locator('#driveHud').getAttribute('data-camera')!=='none';
    const labels={none:'Speed unavailable',linked:'Linked speed',location:'Location speed',estimated:'Estimated speed'};
    const expected=isCamera?want.text:labels[source];
    const b=await bands(page,Math.ceil(m.headerBottom)+1,Math.floor(m.unitTop));
    m.ink={dash:b[b.length-1],above:b.length>1?b[b.length-2]:null,count:b.length};
    await page.screenshot({path:path.join(OUT,name+(height===600?'':'-'+height)+'.png')});
    check(m.text===expected && m.speed===want.speed,tag+' '+name+': actual HUD '+m.text+' / '+m.speed);
    if(!isCamera)check(details===want.text.replace('Phone link · GPS estimate','Linked speed'),tag+' '+name+': source and fault reason are accessible in Details');
    check(isCamera||m.level==='ok',tag+' '+name+': ordinary signal problems are not driving warnings');
    check(!(await page.locator('#driveHealthDetail').isVisible()),tag+' '+name+': troubleshooting stays off the HUD');
    return m;
  };
  const GRACE = { text: '', level: 'ok', speed: '—' };

  // No phone set up, GPS not started: the calm start screen, the reference for where the dash sits.
  await unpaired();
  const start = await shot('s0-start', { text: 'Finding your location…', level: 'ok', speed: '—' });
  check(!start.scroll, `${tag}: the start screen fits without scrolling`);
  await page.evaluate(() => { driveFeed.setVisible(true); driveFeed.enable(); });
  await page.waitForTimeout(100);

  const seen = [];          // [name, measure] of every screen below, for the common checks
  await page.evaluate(() => window.__deny());
  seen.push(['s1-unpaired-denied', await shot('s1-unpaired-denied', { text: 'Glasses location not allowed\nAllow location for this app', level: 'warn', speed: '—' })]);
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
  seen.push(['s8-glasses-speed-lost', await shot('s8-glasses-speed-lost', { text: 'GPS speed lost\nWaiting for a new fix', level: 'warn', speed: '—' })]);
  // the day look (the brightest, for sunlight) and the night look of the same line
  for (const look of ['day', 'night']) {
    await page.evaluate((l) => { document.getElementById('driveHud').dataset.light = l; }, look);
    seen.push([`s9-lost-${look}`, await shot(`s9-lost-${look}`, { text: 'GPS speed lost\nWaiting for a new fix', level: 'warn', speed: '—' })]);
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
  check(!guideOffline.scroll && guideOffline.lines === 1 && guideOffline.ink.dash[0] - guideOffline.ink.above[1] >= 12, `${tag}: and the speed status above them is one line that fit and clear the dash`);
  check(guideDead.ink.dash[0] === guideCalm.ink.dash[0] && guideOffline.ink.dash[0] === guideCalm.ink.dash[0], `${tag}: nor is the dash drawn on other rows (${guideCalm.ink.dash[0]}, ${guideDead.ink.dash[0]}, ${guideOffline.ink.dash[0]})`);

  // Compass tape and saved-route guidance (drive/guide.js): a made-up L-shaped route, 1,000 m east then 500 m north, with the
  // glasses' own location played along it. No phone directions, so the saved route is what the turn line shows.
  const LAT0 = 43, LON0 = -79, spot = (east, north) => [LAT0 + north / 110540, LON0 + east / (Math.cos(LAT0 * Math.PI / 180) * 111320)];
  const saved = { id: 'test-route', ti: 'Depot', km: 1.5, min: 3, at: Math.floor(Date.now() / 1000) - 60, pts: [[0, 1000], [1000, 1000], [1000, 500]], steps: [],
    gm: 1500, gl: [spot(0, 0), spot(500, 0), spot(1000, 0), spot(1000, 500)], gs: [[0, 'Start on First St'], [1000, 'Turn left onto Second Ave'], [1500, 'Arrive']] };
  const tapeOf = () => page.evaluate(() => { const t = document.getElementById('driveTape'), r = t.getBoundingClientRect(), u = document.querySelector('.gps-unit').getBoundingClientRect();
    return { shown: getComputedStyle(t).visibility === 'visible', letters: [...t.querySelectorAll('text')].map((x) => x.textContent).join(' '), heading: document.getElementById('driveHeading').textContent, sideOpacity: Math.min(...[...t.querySelectorAll('text:not(.readout)')].map((x) => +x.getAttribute('opacity'))), lettersPx: parseFloat(getComputedStyle(t.querySelector('text') || t).fontSize), tapeH: r.height, turnLines: Math.round(document.getElementById('driveTurn').getBoundingClientRect().height / parseFloat(getComputedStyle(document.getElementById('driveTurn')).lineHeight)), ticks: t.querySelectorAll('line').length,
      label: t.getAttribute('aria-label'), top: r.top, bottom: r.bottom, left: r.left, right: r.right, unitBottom: u.bottom,
      turn: document.getElementById('driveTurn').hidden ? '' : document.getElementById('driveTurn').textContent, turnLevel: document.getElementById('driveTurn').dataset.level,
      turnBox: document.getElementById('driveTurn').getBoundingClientRect().toJSON(), turnCut: document.getElementById('driveTurn').scrollWidth > document.getElementById('driveTurn').clientWidth && getComputedStyle(document.getElementById('driveTurn')).textOverflow === 'ellipsis', note: document.getElementById('driveAge').textContent,
      noteBottom: document.getElementById('driveAge').getBoundingClientRect().bottom, revealTop: document.getElementById('driveReveal').getBoundingClientRect().top }; });
  await unpaired();
  await page.evaluate((rt) => { window.__fix=null; S.snap = { ...(S.snap || {}), rt }; driveFeed.enable(); }, saved);
  await page.waitForTimeout(50);
  for (const east of [630, 640]) { await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 90), spot(east, 0)); await page.waitForTimeout(30); }
  check((await tapeOf()).turn === '', `${tag}: two fixes on the saved route are not enough to start guidance`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 90), spot(650, 4));
  const onRoute = await shot('s13-saved-route', { text: 'App location · GPS estimate', level: 'ok', speed: '50' });
  let t = await tapeOf();
  check(t.shown && t.letters === 'NE SE E 090°' && t.ticks === 7 && t.label === 'Compass: heading E, 90 degrees' && t.heading === '', `${tag}: heading east, the tape shows NE and SE either side of one readout, E 090°, and the letter beside km/h is gone (${t.letters}; ${t.ticks} ticks; ${t.label})`);
  check(t.top >= t.unitBottom && t.left >= 0 && t.right <= 600, `${tag}: the tape sits under the unit line, inside the screen (${Math.round(t.top)} px, unit ends ${Math.round(t.unitBottom)} px)`);
  check(t.sideOpacity >= 0.6 && t.lettersPx >= 18 && Math.abs(t.tapeH - 44) < 0.5, `${tag}: the side letters stay readable and the tape is full size (opacity ${t.sideOpacity}, ${t.lettersPx} px letters, ${t.tapeH} px tall)`);
  check(t.turn === '350 m · Turn left · Second Ave' && t.turnLevel === 'ok' && t.turnLines === 1, `${tag}: on the saved route the turn line gives the distance and the turn (${JSON.stringify(t.turn)})`);
  check(t.note === 'Saved route · not live · 850 m to go', `${tag}: and the line under it says what this guidance is (${JSON.stringify(t.note)})`);
  check(t.turnBox.left >= 0 && t.turnBox.right <= 600 && t.turnBox.top >= t.bottom - 0.5 && t.noteBottom <= t.revealTop + 0.5 && !onRoute.scroll, `${tag}: turn and note fit between the tape and the Controls button without scrolling`);
  check(Math.abs(onRoute.unitTop - onRoute.speedTop - (start.unitTop - start.speedTop)) < 0.5, `${tag}: the speed and its unit keep their spacing with the tape up`);
  for (let i = 0; i < 3; i++) { await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 0), spot(700, 300 + i * 10)); await page.waitForTimeout(30); }
  await shot('s14-off-saved-route', { text: 'App location · GPS estimate', level: 'ok', speed: '50' });
  t = await tapeOf();
  check(t.turn === 'Off the saved route' && t.turnLevel === 'warn' && /m from it · no rerouting$/.test(t.note), `${tag}: three fixes off the line and it says so in amber, with no rerouting promised (${JSON.stringify(t.turn)}, ${JSON.stringify(t.note)})`);
  check(t.letters === 'NW NE N 000°', `${tag}: heading north, the tape wraps through N (${t.letters})`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 0.4, null), spot(1000, 200));
  await shot('s15-stopped-no-course', { text: 'App location · GPS estimate', level: 'ok', speed: '1' });
  t = await tapeOf();
  check(!t.shown && t.ticks === 0 && t.label === 'Compass: no heading while stopped', `${tag}: stopped, there is no course and no tape, never an old one (${t.shown}, ${t.ticks})`);
  check(t.turn === '300 m · Arrive at Depot', `${tag}: back on the line after the turn, the destination is next, by name (${JSON.stringify(t.turn)})`);
  // A long street name is cut, never wrapped.
  await page.evaluate(async ([rt, lat, lon]) => { S.snap = { ...S.snap, rt }; for (let i = 0; i < 5; i++) {window.__at(lat, lon + i * 0.0001, 13.9, 90);await new Promise(r=>setTimeout(r,4));} },
    [{ ...saved, id: 'test-long', gs: [[0, 'Start'], [1000, 'Turn sharp left onto Regional Municipality Road 124 North Service Rd'], [1500, 'Arrive']] }, ...spot(300, 0)]);
  await shot('s16-long-turn', { text: 'App location · GPS estimate', level: 'ok', speed: '50' });
  t = await tapeOf();
  check(t.turn.endsWith('Regional Municipality Road 124 North Service Rd') && t.turnCut && t.turnLines === 1 && t.turnBox.right <= 600 && t.turnBox.left >= 0, `${tag}: the longest turn keeps its whole road number in the text, stays on one line and shows a visible … where it runs out of room (${Math.round(t.turnBox.left)}-${Math.round(t.turnBox.right)})`);
  // No fresh fix: the last turn must not sit there. A rough fix, then silence.
  await page.evaluate(([lat, lon]) => { window.__fix = null; }, spot(0, 0));
  await page.waitForFunction(() => document.getElementById('driveSpeed').textContent === '—', null, { timeout: 9000 });
  t = await tapeOf();
  check(t.turn === 'Saved route paused' && t.note === 'Waiting for location' && !t.shown, `${tag}: with no fresh fix the turn is replaced by "paused" and the tape is gone (${JSON.stringify(t.turn)}, ${JSON.stringify(t.note)}, tape ${t.shown})`);
  await page.screenshot({ path: path.join(OUT, `s17-saved-route-paused${height === 600 ? '' : '-' + height}.png`) });
  await page.evaluate(() => { driveStopped = true; driveFeed.stop(); });
  t = await tapeOf();
  check(t.turn === '', `${tag}: and once GPS is stopped there is no turn line at all (${JSON.stringify(t.turn)})`);
  await page.evaluate(() => { driveStopped = false; driveFeed.enable(); });
  await phone('live', { nav: NAV, gps: { kmh: 62, hdg: 90 }, ageMs: 300 });
  t = await tapeOf();
  check(t.turn.includes('King St W') && !t.note.startsWith('Saved route'), `${tag}: directions from a phone win over the saved route (${JSON.stringify(t.turn)})`);
  await unpaired();
  await page.evaluate(() => { S.snap = { ...(S.snap || {}), rt: {} }; paintDrive(driveFeed.snapshot()); });
  t = await tapeOf();
  check(t.turn === '', `${tag}: no saved route, no turn line (${JSON.stringify(t.turn)})`);
  check(await page.evaluate(() => !document.getElementById('parkedGate') && StudioParked.confirmed() && StudioParked.controlsAllowed() && !StudioParked.isOpen()), `${tag}: there is no parked check: no dialog in the page and nothing held back`);

  // Fixed-camera warning (drive/cameras.js): a red light camera 600 m east of the start and a speed camera (limit 50) 2 km east.
  await unpaired();
  await page.evaluate(([red, speed]) => { S.snap = { ...(S.snap || {}), rt: {} }; driveCams.load({ made: '2026-11-11', items: [[...red, 'r'], [...speed, 's', 50]] }); driveStopped = false; if (!driveFeed.enabled) driveFeed.enable(); }, [spot(600, 3), spot(2000, 0)]);
  await page.waitForTimeout(50);
  const cameraOf = () => page.evaluate(() => { const h = document.getElementById('driveHud'), st = document.getElementById('driveState'), r = document.createRange(); r.selectNodeContents(st); const b = r.getBoundingClientRect();
    return { mark: h.dataset.camera, colour: getComputedStyle(st).color, speedColour: getComputedStyle(document.getElementById('driveSpeed')).color, left: b.left, right: b.right,
      lines: new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size }; });
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 90), spot(300, 0));
  const red = await shot('s18-red-light-camera', { text: 'Red light camera · 300 m', level: 'ok', speed: '50' });
  let c = await cameraOf();
  check(c.mark === 'ahead' && c.colour === 'rgb(255, 193, 94)' && c.lines === 1 && c.left >= 0 && c.right <= 600, `${tag}: a red light camera ahead takes the top line in amber, on one line inside the screen (${c.mark}, ${c.colour}, ${Math.round(c.left)}-${Math.round(c.right)})`);
  check(c.speedColour === 'rgb(255, 255, 255)', `${tag}: the speed stays white: a red light camera has no limit to be over (${c.speedColour})`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 0.2, null), spot(560, 0));
  c = await cameraOf();
  check(c.mark === 'ahead' && (await page.textContent('#driveState')) === 'Red light camera · 40 m', `${tag}: stopped at the light, the warning stays (${await page.textContent('#driveState')})`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 90), spot(700, 0));
  c = await cameraOf();
  check(c.mark === 'none' && (await page.textContent('#driveState')) === 'Location speed' && c.colour !== 'rgb(255, 193, 94)', `${tag}: past the camera, the calm line is back (${c.mark}, ${await page.textContent('#driveState')})`);
  const calm = await measure(page);
  check(Math.abs(red.speedTop - calm.speedTop) < 0.5 && Math.abs(red.unitTop - calm.unitTop) < 0.5 && !red.scroll, `${tag}: the speed and unit do not move when the warning comes and goes (${Math.round(red.speedTop)} px, calm ${Math.round(calm.speedTop)} px)`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 17.5, 90), spot(1700, 0));
  await shot('s19-speed-camera-over', { text: 'Speed camera · limit 50 · 300 m', level: 'ok', speed: '63' });
  c = await cameraOf();
  check(c.mark === 'over' && c.speedColour === 'rgb(255, 193, 94)', `${tag}: over a speed camera's posted limit, the speed itself turns amber (${c.mark}, ${c.speedColour})`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.3, 90), spot(1800, 0));
  c = await cameraOf();
  check(c.mark === 'ahead' && c.speedColour === 'rgb(255, 255, 255)' && (await page.textContent('#driveState')) === 'Speed camera · limit 50 · 200 m', `${tag}: at 48 the speed is white again and the warning still counts down (${c.mark}, ${await page.textContent('#driveState')})`);
  // The night look of the same warning, for the review.
  await page.evaluate(() => { document.getElementById('driveHud').dataset.light = 'night'; });
  await page.screenshot({ path: path.join(OUT, `s19b-speed-camera-night${height === 600 ? '' : '-' + height}.png`) });
  await page.evaluate(() => { delete document.getElementById('driveHud').dataset.light; });
  // A camera beside a motorway names its street; and an old list says so on the face, in amber, where "Just now" sits.
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  await page.evaluate(([site, made]) => { driveCams.load({ made, region: 'Canada', redLightOnly: ['Ontario', 'Alberta'], items: [[...site, 'r', 0, 1, 'Lake Shore']] }); }, [spot(2400, 10), old]);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 13.9, 90), spot(2100, 0));
  await shot('s20-camera-street-old-list', { text: 'Red light camera on Lake Shore · 300 m', level: 'ok', speed: '50' });
  c = await cameraOf();
  const note = await page.evaluate(() => ({ text: document.getElementById('driveAge').textContent, colour: getComputedStyle(document.getElementById('driveAge')).color }));
  check(c.lines === 1 && c.left >= 0 && c.right <= 600, `${tag}: the longer line with a street still fits on one line (${Math.round(c.left)}-${Math.round(c.right)})`);
  check(/^camera list (39|40|41) days old$/.test(note.text) && note.colour === 'rgb(255, 193, 94)', `${tag}: a list over 30 days old says so on the face in amber, while the dashboard stays quiet (${JSON.stringify(note.text)}, ${note.colour})`);
  const missing = await page.evaluate(() => { const kept = driveCams.ix; driveCamsFailed = true; driveCams.load({ items: [] }); paintDrive(driveFeed.snapshot()); const text = document.getElementById('driveAge').textContent; driveCamsFailed = false; driveCams.ix = kept; paintDrive(driveFeed.snapshot()); return text; });
  check(missing === 'no camera list', `${tag}: a list that could not be loaded is said on the face too, never a quiet screen (${JSON.stringify(missing)})`);
  await page.evaluate(([lat, lon]) => window.__at(lat, lon, 27, 90), spot(2150, 0));
  c = await cameraOf();
  check(c.mark === 'none', `${tag}: at motorway speed a camera marked as beside the motorway says nothing (${c.mark})`);
  await page.evaluate(() => { window.__fix = null; });
  await page.waitForFunction(() => document.getElementById('driveSpeed').textContent === '—', null, { timeout: 9000 });
  c = await cameraOf();
  check(c.mark === 'none' && !(await page.textContent('#driveState')).includes('camera'), `${tag}: with no fresh fix there is no camera warning, never an old one (${c.mark}, ${JSON.stringify(await page.textContent('#driveState'))})`);

  check(errors.length === 0, `${tag}: no script errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}

// Location already allowed: opening Drive starts the speed by itself, with no press. Not allowed yet: nothing starts and nothing asks.
async function autoStart(browser) {
  for (const granted of [true, false, 'remembered', 'stopped']) {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    await ctx.route(/^(?!http:\/\/127\.0\.0\.1)/, (r) => r.abort());
    await ctx.addInitScript(`window.__grantAtStart = ${granted === true || granted === 'stopped'}; ${granted === 'stopped' ? "try { localStorage.setItem('bakar.drive.gps', '0'); } catch (_) {}" : ''} ${granted === 'remembered' ? "try { localStorage.setItem('bakar.drive.gps', '1'); } catch (_) {}" : ''}`);
    await ctx.addInitScript(FAKE_GEO);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/glass-home/#tab=drive`);
    await page.waitForTimeout(700);
    if (!(await page.isVisible('#driveHud'))) { await page.click('#section-drive').catch(() => {}); await page.waitForTimeout(400); }
    const m = await page.evaluate(() => ({ enabled: driveFeed.enabled, text: document.getElementById('driveState').textContent, button: document.getElementById('driveGps').textContent }));
    if (granted === 'stopped') check(!m.enabled && m.button === 'Start app GPS', `auto start: a deliberate Stop holds through a relaunch, even with location allowed (${m.enabled})`);
    else if (granted === 'remembered') check(m.enabled && m.button === 'Stop app GPS', `auto start: a Start that worked before is made again, even where the permission cannot be read (${m.enabled})`);
    else if (granted) {
      check(m.enabled && m.button === 'Stop app GPS', `auto start: location already allowed, Drive starts by itself (${m.enabled}, ${JSON.stringify(m.text)})`);
      await page.evaluate(() => window.__drive(20, 180)); await page.waitForTimeout(80);
      check((await page.textContent('#driveSpeed')) === '72', 'auto start: and the speed arrives with no press at all');
      check(await page.evaluate(() => localStorage.getItem('bakar.drive.gps') === '1'), 'auto start: a working Start is remembered for the next visit');
      const after = await page.evaluate(() => { driveStopped = true; driveFeed.stop(); syncDriveFeed(); return driveFeed.enabled; });   // what a press on Stop does
      check(after === false, 'auto start: a deliberate Stop holds; looking at Drive again does not restart it');
    } else check(m.enabled && m.text === 'Speed unavailable' && m.button === 'Stop app GPS', `auto start: first Drive entry requests native location (${m.enabled}, ${JSON.stringify(m.text)})`);
    await ctx.close();
  }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  await autoStart(browser);
  await run(browser, 600, '600x600');
  await run(browser, 480, '600x480');          // the short layout (max-height 500px) has its own sizes
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
