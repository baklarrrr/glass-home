'use strict';
const APP_BUILD = 42; // Identity of this executing entry script, including offline launches.
// Bakar Drive on the glasses.
//
// Three sources, all optional:
// - Phone GPS, through the glasses' web runtime (../drive-location.js, shared with Bakar Home's Drive tab): speed and
//   heading. Nothing about the position is kept or sent.
// - Bakar Drive on the phone: the next turn, the next street and the arrival time, sent encrypted by the phone's
//   glasses link (LINK.md). It needs the address the phone app gives (?t=…&p=…). Without it the page runs on GPS alone.
// - The same link also carries the phone's own GPS speed and heading (LINK.md, "Speed and heading"). While it is fresh
//   it is the speed on screen, so the speedometer works even when the glasses' own location is not allowed.
//
// Battery: nothing runs while the page is hidden. On screen, one connection per broker, a hello every 20 s, and the
// screen repaints only when something changes (and once a minute for the clock).

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
const HELLO_MS = 20000;
const FRAME_FRESH_MS = 4000;      // a turn older than this dims and the top line says directions are paused
const FRAME_DROP_MS = 30000;      // a turn older than this is taken off the screen
const PHONE_WAIT_MS = 8000;       // linked to a broker but nothing from the phone for this long
const CONTROLS_MS = 8000;
const HEADING_MIN_MPS = 2;        // GPS course is noise below about 7 km/h
const PHONE_GPS_FRESH_MS = 3500;  // the phone sends its speed about once a second while it has a reading under 3 s old
const LIGHTS = ['auto', 'day', 'dusk', 'night'];
const L = DriveLinkCore;
const SC = typeof SpeedCheck !== 'undefined' ? SpeedCheck : null;   // the speed self-check; the page still runs without it
const $ = (id) => document.getElementById(id);
const subtle = window.crypto && crypto.subtle;

const S = {
  addr: null, devId: '', devPubB64: '', code: '', keys: null,
  links: [], linkId: '', mqttTries: 0, mqttLoading: false, recent: [], hellos: [], helloTimer: 0, waitTimer: 0,
  // net: the brokers (none = no phone link set up). phone: what the phone last said. Kept apart, so a dropped
  // connection never hides what the phone said a moment ago, and an old turn still goes stale on time.
  net: 'none', phone: 'unknown', heardAt: 0, last: null, frame: null, frameAt: 0, staleTimers: [],
  heading: null, headingAt: 0, trip: { ms: 0, m: 0, lastAt: 0 }, gps: { status: 'off' }, phoneGps: null, phoneGpsAt: 0, phoneGpsSentAt: 0, phoneGpsAge: 0,
  controlsTimer: 0, panel: false, openedAt: 0, upAt: 0, offer: null, shown: null,   // upAt: when the brokers last came up; shown: what the speed self-check said last
  setup: false,   // the saved phone link has been read (found or not): until then nothing is known about the phone
};

// ---- small things ----------------------------------------------------------------------------------

function local(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* storage can be off; the page still works for this visit */ }
  return null;
}

function clockText(when) {
  return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('bakar-drive', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('keys').objectStore('keys').get(k);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(k, v) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', 'readwrite');
    t.objectStore('keys').put(v, k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- turn arrows: drawn for a right-hand turn, mirrored for left ------------------------------------

const HEAD = (x, y, deg) => `<path class="head" transform="translate(${x} ${y}) rotate(${deg})" d="M0 -15 L14 6 L-14 6 Z"/>`;
const GLYPHS = {
  straight: () => `<path class="way" d="M50 90 V30"/>${HEAD(50, 22, 0)}`,
  slight: () => `<path class="road" d="M44 90 V12"/><path class="way" d="M44 90 V62 Q44 50 52 42 L64 30"/>${HEAD(70, 24, 45)}`,
  turn: () => `<path class="road" d="M38 90 V12"/><path class="way" d="M38 90 V52 Q38 40 50 40 H72"/>${HEAD(80, 40, 90)}`,
  sharp: () => `<path class="road" d="M34 90 V12"/><path class="way" d="M34 90 V36 Q34 24 44 30 L66 54"/>${HEAD(72, 61, 135)}`,
  uturn: () => `<path class="way" d="M64 90 V44 Q64 22 46 22 Q28 22 28 44 V60"/>${HEAD(28, 68, 180)}`,
  exit: () => `<path class="road" d="M40 90 V12"/><path class="way" d="M40 90 V66 Q40 52 54 42 L66 34"/>${HEAD(72, 29, 55)}`,
  round: (n) => `<circle class="ring" cx="50" cy="44" r="18"/><path class="way" d="M50 90 V62"/><path class="way" d="M63 31 L72 20"/>${HEAD(76, 15, 40)}${n ? `<text class="num" x="50" y="44">${n}</text>` : ''}`,
  finish: () => `<path class="way" d="M34 90 V16"/><path class="head" d="M34 16 H76 L66 30 L76 44 H34 Z"/>`,
  start: () => `<path class="road" d="M18 30 H82"/><path class="way" d="M50 90 V44"/>${HEAD(50, 36, 0)}`,
};
const TURN_GLYPH = {
  NO_TURN: ['straight'], GO_STRAIGHT: ['straight'],
  TURN_RIGHT: ['turn'], TURN_LEFT: ['turn', true],
  TURN_SLIGHT_RIGHT: ['slight'], TURN_SLIGHT_LEFT: ['slight', true],
  TURN_SHARP_RIGHT: ['sharp'], TURN_SHARP_LEFT: ['sharp', true],
  U_TURN_LEFT: ['uturn'], U_TURN_RIGHT: ['uturn', true],
  ENTER_ROUND_ABOUT: ['round'], LEAVE_ROUND_ABOUT: ['round'], STAY_ON_ROUND_ABOUT: ['round'],
  START_AT_THE_END_OF_STREET: ['start'], REACHED_YOUR_DESTINATION: ['finish'],
  EXIT_HIGHWAY_TO_RIGHT: ['exit'], EXIT_HIGHWAY_TO_LEFT: ['exit', true],
};
const TURN_WORDS = {
  NO_TURN: 'Straight on', GO_STRAIGHT: 'Straight on', TURN_RIGHT: 'Turn right', TURN_LEFT: 'Turn left',
  TURN_SLIGHT_RIGHT: 'Bear right', TURN_SLIGHT_LEFT: 'Bear left', TURN_SHARP_RIGHT: 'Sharp right', TURN_SHARP_LEFT: 'Sharp left',
  U_TURN_LEFT: 'U-turn', U_TURN_RIGHT: 'U-turn', ENTER_ROUND_ABOUT: 'Roundabout', LEAVE_ROUND_ABOUT: 'Leave the roundabout',
  STAY_ON_ROUND_ABOUT: 'Stay on the roundabout', START_AT_THE_END_OF_STREET: 'To the end of the street',
  REACHED_YOUR_DESTINATION: 'Destination', EXIT_HIGHWAY_TO_RIGHT: 'Exit right', EXIT_HIGHWAY_TO_LEFT: 'Exit left',
};

function drawArrow(turn, exit) {
  const [name, mirror] = TURN_GLYPH[turn] || [];
  const svg = $('arrow');
  if (!name) { svg.innerHTML = ''; return; }
  // Only fixed shapes and a number go into the SVG; no text from the phone.
  const body = GLYPHS[name](name === 'round' && Number.isInteger(exit) && exit > 0 ? exit : 0);
  svg.innerHTML = mirror ? `<g transform="translate(100 0) scale(-1 1)">${body}</g>` : body;  // no glyph with a number is mirrored
}

// ---- phone GPS ---------------------------------------------------------------------------------------

// The shared feed reads speed only. This wrapper also notes the GPS course (a direction, never a position) when
// the phone reports one at driving speed.
function noteHeading(p) {
  const c = p && p.coords, h = c && c.heading;
  const fresh = p && Number.isFinite(p.timestamp) && Date.now() - p.timestamp < StudioDriveLocation.MAX_AGE_MS;
  if (fresh && Number.isFinite(h) && h >= 0 && h < 360 && Number.isFinite(c.speed) && c.speed >= HEADING_MIN_MPS
    && Number.isFinite(c.accuracy) && c.accuracy <= StudioDriveLocation.MAX_ACCURACY_M) {
    S.heading = h; S.headingAt = Date.now();
  }
}

function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

const motion = typeof DriveGuide==='undefined'?null:new DriveGuide.Guide();
const feed = new StudioDriveLocation.Feed({geo:navigator.geolocation,permissions:navigator.permissions,change:onGps,
  transform:position=>{motion?.fix(position);const sample=motion?motion.fill(position):position;noteHeading(sample);return sample;}
});

// Trip: time and an estimated distance from reported speed (not from positions), while a speed is live. One source
// at a time (the phone's while it is fresh, else the glasses'), so nothing counts twice.
function addTrip(kmh) {
  const now = performance.now();
  if (S.trip.lastAt) {
    const dt = now - S.trip.lastAt;
    if (dt > 0 && dt <= 3000) { S.trip.ms += dt; S.trip.m += (kmh / 3.6) * (dt / 1000); }
  }
  S.trip.lastAt = now;
}

// The phone's own GPS speed and heading from the link, only while the phone is live and the reading is fresh.
function phoneSpeed(now = performance.now()) {
  const g = S.phoneGps;
  const elapsed=now-S.phoneGpsAt;
  const age=Math.max(Date.now()-S.phoneGpsSentAt,S.phoneGpsAge+elapsed);
  return g && S.phone === 'live' && S.phoneGpsAge>=0 && elapsed>=0 && Date.now()>=S.phoneGpsSentAt && age < PHONE_GPS_FRESH_MS ? g : null;
}

function onGps(reading) {
  S.gps = reading;
  if(reading.status==='waiting'&&!local('bd.gps'))local('bd.gps','asked');
  if(reading.status==='live'&&local('bd.gps')!=='on')local('bd.gps','on');
  if(reading.status==='denied')local('bd.gps','denied');
  if (phoneSpeed()) { render(); return; }          // the phone's speed is on screen and in the trip already
  if (reading.status === 'live') addTrip(reading.speed); else S.trip.lastAt = 0;
  render();
}

function toggleGps() {
  if (feed.enabled) { feed.stop(); local('bd.gps', 'off'); }
  else { local('bd.gps','asked'); feed.enable(); }
  render();
}

// ---- the link to the phone ------------------------------------------------------------------------------

// The phone link comes from the address once (?t=…&p=…) and is kept on the glasses. The glasses' own key is
// made per phone link, so a different link never reuses it. A link for a different phone than the one kept
// is not taken over silently: the panel asks first (S.offer).
const sameAddr = (a, b) => Boolean(a && b) && a.t === b.t && a.p === b.p;
const validAddr = (a) => Boolean(a) && Boolean(L.readAddress(`?t=${a.t}&p=${a.p}`, ''));

// Whether a phone key is a real P-256 point, so a broken link is never offered in place of a working one.
async function pointOk(p) {
  try { await subtle.importKey('raw', L.fromB64url(p), { name: 'ECDH', namedCurve: 'P-256' }, false, []); return true; }
  catch (e) { return false; }
}

// Keys for one phone link, or null. The glasses key is kept only once the keys work.
async function linkKeys(addr) {
  const devKey = `dev:${addr.t}:${addr.p}`;
  let dev = null;
  try { dev = await idbGet(devKey); } catch (e) { /* made below */ }
  const made = !dev;
  try {
    if (made) {
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      dev = { priv: pair.privateKey, pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
    }
    const devId = await L.deviceId(subtle, dev.pub);
    const keys = await L.deriveKeys(subtle, dev.priv, L.fromB64url(addr.p), addr.t, devId);
    const link = { addr, devId, devPubB64: L.toB64url(dev.pub), code: await L.pairCode(subtle, dev.pub), keys };
    if (made) { try { await idbPut(devKey, dev); } catch (e) { /* this visit only */ } }
    return link;
  } catch (e) { return null; }
}

async function setupLink() {
  if (!subtle || !window.indexedDB) return false;
  const fromUrl = L.readAddress(location.search, location.hash);
  let saved = null;
  try { saved = await idbGet('pairing'); } catch (e) { /* no storage: this visit only */ }
  if (!validAddr(saved)) saved = null;
  let link = saved ? await linkKeys(saved) : null;
  if (link && fromUrl && !sameAddr(saved, fromUrl) && await pointOk(fromUrl.p)) S.offer = fromUrl;
  if (!link && fromUrl) {
    link = await linkKeys(fromUrl);
    // Kept only once its keys work, so a link that can't be used never replaces one that can.
    if (link) { try { await idbPut('pairing', fromUrl); } catch (e) { /* this visit only */ } }
  }
  if (!link) return false;
  Object.assign(S, link);
  return true;
}

// The wearer chose the new phone link: keep it and start again with it (a fresh glasses key and code).
async function useOffer() {
  const next = S.offer;
  if (!next) return;
  try { await idbPut('pairing', next); } catch (e) { return; }
  location.replace(`${location.pathname}?t=${encodeURIComponent(next.t)}&p=${encodeURIComponent(next.p)}`);
}

// The wearer kept the phone they have: forget the offer and take it out of the address, so it isn't asked again.
function keepCurrent() {
  if (!S.offer) return;
  S.offer = null;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* the address stays; harmless */ }
}

function setNet(state) {
  if (S.net === state) return;
  S.net = state;
  render();
}

// The one state the screen shows, from the brokers, the phone and the age of the last turn.
function linkView(now = performance.now()) {
  if (S.net === 'none') return 'none';
  const age = now - S.frameAt;
  if (S.phone === 'live' && age < FRAME_FRESH_MS) return 'live';
  if (S.phone === 'pairing') return 'pairing';
  if (S.phone === 'live' && age < FRAME_DROP_MS) return 'paused';
  if (S.net === 'down') return 'offline';
  if (S.net === 'connecting') return 'connecting';
  if (S.phone === 'ready' || S.phone === 'live') return 'ready';
  return 'waiting';
}

// What the speed self-check is told about the phone. It must never blame the phone for something that is only "not yet":
// until the saved link has been read, and while the page is opening its brokers again (after the display slept or the
// signal came back), the phone is being found. And when the glasses cannot reach the brokers at all, that is the story.
function checkLink(view) {
  if (!S.setup) return 'connecting';
  if (view === 'offline') return 'nosignal';
  if (view === 'paused') {
    if (S.net === 'connecting') return 'connecting';
    if (S.net === 'down') return 'nosignal';
    // The last turn is from before the brokers came back up (the display woke, or the signal returned), so it says nothing
    // about the phone now. The phone has just been asked again: it gets the same wait as when the page first opens before it
    // counts as silent. The render timer in linkChanged fires when this wait is over.
    return S.frameAt < S.upAt && performance.now() - S.upAt < PHONE_WAIT_MS ? 'connecting' : 'paused';
  }
  return view;
}

function loadMqtt() {
  if (S.mqttLoading || S.mqttTries >= 10) return;
  S.mqttLoading = true;
  S.mqttTries += 1;
  const tag = document.createElement('script');
  tag.src = `../vendor/mqtt.min.js?try=${S.mqttTries}`;
  tag.onload = () => { S.mqttLoading = false; if (!document.hidden) openLink(); };
  tag.onerror = () => { S.mqttLoading = false; tag.remove(); setTimeout(loadMqtt, 3000); };
  document.head.append(tag);
}

function openLink() {
  if (!S.addr || S.links.length || document.hidden) return;
  if (typeof mqtt === 'undefined') { loadMqtt(); setNet('connecting'); return; }
  S.linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  setNet('connecting');
  for (const b of BROKERS) addBroker(b);
}

function retryDelay(fails, othersUp) {
  if (othersUp) return Math.min(600000, 1000 * 2 ** Math.min(fails, 10));
  return fails <= 3 ? 1000 : Math.min(30000, 1000 * 2 ** (fails - 3));
}

function scheduleRetry(client) {
  if (client.retryTimer || !S.links.includes(client) || client.connected) return;
  client.fails = (client.fails || 0) + 1;
  client.retryTimer = setTimeout(() => {
    client.retryTimer = 0;
    if (!S.links.includes(client) || client.connected) return;
    try { client.reconnect(); } catch (e) { scheduleRetry(client); }
  }, retryDelay(client.fails, S.links.some((l) => l.connected)));
}

function addBroker({ url, ...extra }) {
  const client = mqtt.connect(url, {
    clientId: `bdg-${S.linkId}-${S.links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    client.subscribe(`bkd/${S.addr.t}/d/${S.devId}`, { qos: 1 });
    hello(client);
    linkChanged();
  });
  client.on('message', (topic, payload) => onDown(new TextDecoder().decode(payload)));
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', () => { /* a close follows, and the retry is set there */ });
  S.links.push(client);
}

function closeLink() {
  const old = S.links;
  S.links = [];
  clearInterval(S.helloTimer); S.helloTimer = 0;
  clearTimeout(S.waitTimer); S.waitTimer = 0;
  for (const l of old) {
    clearTimeout(l.retryTimer);
    try { l.end(true); } catch (e) { /* closed already */ }
  }
  if (S.addr) setNet('down');
}

function linkChanged() {
  const up = S.links.some((l) => l.connected);
  if (!up) { if (S.links.length && S.net === 'up') setNet('down'); return; }
  if (!S.helloTimer) S.helloTimer = setInterval(() => hello(), HELLO_MS);
  if (S.net !== 'up') {
    S.upAt = performance.now();
    setNet('up');
    clearTimeout(S.waitTimer);
    S.waitTimer = setTimeout(render, PHONE_WAIT_MS + 100);   // a moment after the wait is over, so the screen sees that it is
  }
}

async function hello(only) {
  if (!S.keys || document.hidden) return;
  const id = L.toB64url(crypto.getRandomValues(new Uint8Array(9)));
  S.hellos = S.hellos.slice(-5).concat(id);
  const payload = await L.sealUp(subtle, S.keys.up, S.devPubB64, { c: 'hello', id, ts: Date.now(), v: 1 });
  for (const l of only ? [only] : S.links) if (l.connected) l.publish(`bkd/${S.addr.t}/u`, payload, { qos: 1 });
}

async function onDown(text) {
  if (typeof text !== 'string' || text.length > L.MAX_DOWN || !S.keys) return;
  if (S.recent.includes(text)) return;           // the same message through another broker
  S.recent.push(text);
  if (S.recent.length > 32) S.recent.shift();
  const m = await L.openDown(subtle, S.keys.down, text);
  if (!m) return;
  const pair = L.checkPair(m);
  if (pair) {
    if (!S.hellos.includes(pair.re)) return;      // an answer to a hello from before this page opened
    S.heardAt = Date.now();
    if (!pair.ok) S.phone = 'pairing';
    else if (S.phone !== 'live') S.phone = 'ready';
    render();
    return;
  }
  const r = L.checkNav(m, Date.now(), S.last, S.hellos);
  if (!r.ok) return;
  S.last = r.last;
  S.heardAt = Date.now();
  S.phone = 'live';
  S.frame = r.frame.nav;
  S.frameAt = performance.now();
  S.phoneGps = r.frame.gps;
  S.phoneGpsAt = S.frameAt;
  S.phoneGpsSentAt = r.frame.at;
  S.phoneGpsAge = Date.now()-r.frame.at;
  if (S.phoneGps) addTrip(S.phoneGps.kmh); else if (S.gps.status !== 'live') S.trip.lastAt = 0;
  for (const t of S.staleTimers) clearTimeout(t);
  S.staleTimers = [setTimeout(render, Math.max(0,PHONE_GPS_FRESH_MS-Math.max(0,S.phoneGpsAge)) + 1), setTimeout(render, FRAME_FRESH_MS + 50), setTimeout(render, FRAME_DROP_MS + 50)];
  render();
}

// ---- screen -----------------------------------------------------------------------------------------

function lightPick() {
  const pick = local('bd.light');
  return LIGHTS.includes(pick) ? pick : 'auto';
}

// Auto follows the sun at Toronto's latitude, the same way as Bakar Home's Drive tab; no position is used.
function sunLight(when = new Date()) {
  const day = (when - new Date(when.getFullYear(), 0, 0)) / 86400000;
  const tilt = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * Math.PI / 180;
  const lat = 43.7 * Math.PI / 180;
  const halfDay = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(tilt)))) * 12 / Math.PI;
  const zone = -when.getTimezoneOffset() / 60;
  const noon = 12 + zone + 79.4 / 15;
  const hour = when.getHours() + when.getMinutes() / 60;
  const fromNoon = Math.abs(hour - noon);
  if (fromNoon < halfDay - 0.75) return 'day';
  return fromNoon < halfDay + 0.75 ? 'dusk' : 'night';
}

const GPS_WORDS = {
  off: 'App GPS stopped', waiting: 'Finding GPS…', 'no-response': 'No GPS answer yet', live: 'App GPS',
  stale: 'GPS signal old', inaccurate: 'GPS too rough', invalid: 'GPS reading rejected', unavailable: 'No speed from GPS',
  error: 'Location provider error', timeout: 'GPS timed out', disconnected: 'No GPS fix yet', denied: 'Location not allowed', paused: 'GPS paused',
  unsupported: 'No GPS here',
};

function topLine(view) {
  const n = S.frame;
  switch (view) {
    case 'connecting': return 'Linking to your phone…';
    case 'offline': return 'No signal for directions';
    case 'pairing': return 'Pair with your phone';
    case 'waiting': return performance.now() - (S.openedAt || 0) > PHONE_WAIT_MS ? 'Open Bakar Drive on your phone' : 'Looking for your phone…';
    case 'ready': return 'Phone linked · no route';
    case 'paused': return S.net === 'down' ? 'No signal · directions paused' : 'Directions paused';
    case 'live':
      if (!n) return 'Phone linked · no route';
      if (n.sim) return 'Bakar Drive · demo route';
      if (n.ss === 'OffRoute') return 'Off route';
      if (n.ss === 'RouteRebuilding' || n.ss === 'RouteNeedsRebuild') return 'Rerouting…';
      return 'Bakar Drive';
    default:
      if(S.gps.status==='live'&&S.gps.source==='estimated')return 'Speed estimated from positions';
      if(S.gps.status==='unavailable'&&feed.report().fresh&&feed.report().coordinates)return 'Location found · measuring speed';
      return S.shown && S.shown.text ? 'No speed' : (GPS_WORDS[S.gps.status] || 'App GPS');   // the amber line under the dash says why
  }
}

function render() {
  const hud = $('hud');
  const pick = lightPick();
  hud.dataset.light = pick === 'auto' ? sunLight() : pick;
  $('lightBtn').textContent = `Light: ${pick[0].toUpperCase()}${pick.slice(1)}`;

  // Speed: the phone's own GPS through the link while it is fresh, else the glasses' own location.
  const pg = phoneSpeed();
  const live = Boolean(pg) || S.gps.status === 'live';
  hud.dataset.gps = live ? 'live' : 'off';
  $('speed').textContent = pg ? String(pg.kmh) : S.gps.status === 'live' ? String(Math.round(S.gps.speed)) : '—';
  const headingFresh = S.heading !== null && Date.now() - S.headingAt < 5000 && S.gps.status === 'live';
  const course = pg ? pg.hdg : (headingFresh ? S.heading : null);   // the phone already leaves the heading out below 2 m/s
  $('heading').textContent = course !== null ? compass(course) : '';
  $('gpsBtn').textContent = feed.enabled ? 'Stop GPS' : 'Start GPS';
  $('gpsBtn').disabled = S.gps.status === 'unsupported';
  const mins = Math.floor(S.trip.ms / 60000);
  $('trip').textContent = S.trip.ms > 60000 ? `Trip ${mins} min · ${(S.trip.m / 1000).toFixed(1)} km est.` : '';

  // Directions
  const view = linkView();
  const fresh = view === 'live';
  const n = view === 'live' || view === 'paused' ? S.frame : null;
  const phase = n ? L.phase(n.ss) : 'none';
  const guide = Boolean(n) && ['guide', 'arrived', 'ready', 'building'].includes(phase);
  const pairing = view === 'pairing';
  // Speed self-check: with no speed on screen, a definite fault and nothing healthy behind it gets a plain amber line.
  const health = SC ? SC.check({ phoneFresh: Boolean(pg), gpsStatus: S.gps.status, link: checkLink(view) }) : { source: live ? 'ok' : 'none', level: 'wait', text: '', short: '' };
  S.shown = health;
  const warnText = guide ? health.short : health.text;   // beside the directions the corner is narrow: the same two lines, shorter
  $('speedWarn').textContent = warnText;
  $('speedWarn').hidden = !warnText;
  hud.dataset.speedLevel = health.level;
  hud.dataset.mode = guide ? 'guide' : pairing ? 'pair' : 'speed';
  $('pairBox').hidden = !pairing || guide;
  $('pairCode').textContent = pairing ? `${S.code.slice(0, 3)} ${S.code.slice(3)}` : '';
  hud.dataset.link = view;
  $('turn').hidden = !guide;
  $('turn').classList.toggle('stale', guide && !fresh);
  if (guide) {
    let big = n.toTurn, small = n.next || TURN_WORDS[n.turn] || '';
    let turn = n.turn;
    if (phase === 'arrived') { turn = 'REACHED_YOUR_DESTINATION'; big = 'Arrived'; small = ''; }
    else if (phase === 'ready') { big = 'Route ready'; small = 'Start it in Bakar Drive'; turn = null; }
    else if (phase === 'building') { big = 'Finding route…'; small = ''; turn = null; }
    else if (!big) big = TURN_WORDS[n.turn] || '';
    drawArrow(turn, n.exit);
    $('toTurn').textContent = big;
    $('next').textContent = small;
    const eta = n.secs !== null && phase === 'guide';
    $('arriveTime').textContent = eta ? `Arrive ${clockText(new Date(Date.now() + n.secs * 1000))}` : '';
    $('arriveLeft').textContent = eta && n.left ? `${n.left} to go` : '';
  } else {
    $('arriveTime').textContent = '';
    $('arriveLeft').textContent = '';
  }
  $('status').textContent = topLine(view);
  $('clock').textContent = clockText(new Date());
  if (S.panel) renderPanel();
}

// Why there is no speed when nothing is wrong yet: GPS not started, still asking, or a reading that is not usable. One short
// line: the panel has no room for more.
function quietWhy() {
  return { off: 'GPS is not started.', waiting: 'Waiting for GPS.', 'no-response': 'Waiting for GPS.', paused: 'GPS is paused.' }[S.gps.status]
    || `${GPS_WORDS[S.gps.status] || 'No GPS speed'}.`;
}

function renderPanel() {
  const view = linkView();
  let state, help;
  $('panelUse').hidden = !S.offer;
  if (S.offer) {
    state = 'This link is for a different phone.';
    help = 'These glasses get directions from another phone now. Use this phone switches to the new one, with a new code to accept on it. Back keeps the phone you have.';
  } else if (!S.addr) {
    state = 'Not set up on this pair of glasses.';
    help = 'Directions come from Bakar Drive on your phone through its glasses link. Open this app from the link the phone gives you once. Until then this shows phone GPS speed.';
  } else if (S.phone === 'pairing') {
    state = 'Your phone hasn\'t accepted these glasses yet.';
    help = 'On your phone, open the glasses link and accept this code.';
  } else if (S.net === 'down') {
    state = 'No signal right now.';
    help = 'Directions come back on their own when the phone has signal.';
  } else if (checkLink(view) === 'paused') {   // the same silence the screen goes by, not the first moments after the link came back
    state = 'Your phone is not answering.';
    help = 'Directions come back on their own when the phone answers. Keep Bakar Drive and the phone\'s glasses link running.';
  } else if (S.phone === 'live' || S.phone === 'ready') {
    state = 'Linked to your phone.';
    help = 'Start a route in Bakar Drive and the next turn shows here. Your speed comes from the phone\'s GPS while it is driving.';
  } else {
    state = 'Looking for your phone.';
    help = 'Keep Bakar Drive and the phone\'s glasses link running. The phone sends turns only while this screen is open.';
  }
  $('panelState').textContent = state;
  $('panelHelp').textContent = help;
  const h = S.shown;
  $('panelSpeed').textContent = !h ? '' : h.source === 'phone' ? 'Speed: from your phone\'s GPS.'
    : h.source === 'glasses' ? 'Speed: from the glasses\' own GPS.' : `Speed: none. ${h.short ? h.short.split('\n')[0] + '.' : quietWhy()}`;   // one line: the panel has no room for more, and the screen has the rest
  $('panelCode').hidden = !S.code || Boolean(S.offer);
  $('panelQuiet').hidden = Boolean(S.offer);
  $('panelCodeNum').textContent = S.code ? `${S.code.slice(0, 3)} ${S.code.slice(3)}` : '';
}

// ---- input: any press shows the controls, which go away again on their own ---------------------------

function showControls() {
  $('controls').hidden = false;
  if (!$('controls').contains(document.activeElement)) $('gpsBtn').focus({ preventScroll: true });
  armControls();
}
function armControls() {
  clearTimeout(S.controlsTimer);
  S.controlsTimer = setTimeout(hideControls, CONTROLS_MS);
}
function hideControls() {
  clearTimeout(S.controlsTimer);
  $('controls').hidden = true;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function panelButtons() {
  return ['panelUse', 'panelStudio', 'panelBack'].map($).filter((b) => !b.hidden);
}
function openPanel() {
  S.panel = true;
  hideControls();
  renderPanel();
  $('panel').hidden = false;
  panelButtons()[0].focus({ preventScroll: true });
}
function closePanel() {
  keepCurrent();
  S.panel = false;
  $('panel').hidden = true;
  showControls();
  $('linkBtn').focus({ preventScroll: true });
}

const ORDER = ['gpsBtn', 'lightBtn', 'linkBtn'];
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (S.panel) {
    if (k === 'Escape' || k === 'Backspace') { e.preventDefault(); closePanel(); }
    else if (k.startsWith('Arrow')) {
      e.preventDefault();
      const list = panelButtons(), at = list.indexOf(document.activeElement);
      const step = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
      list[(Math.max(0, at) + step + list.length) % list.length].focus({ preventScroll: true });
    }
    return;
  }
  if ($('controls').hidden) {
    if (k.startsWith('Arrow') || k === 'Enter' || k === ' ') { e.preventDefault(); showControls(); }
    return;
  }
  armControls();
  if (k === 'Escape') { e.preventDefault(); hideControls(); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    const at = ORDER.indexOf(document.activeElement && document.activeElement.id);
    const step = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
    $(ORDER[(Math.max(0, at) + step + ORDER.length) % ORDER.length]).focus({ preventScroll: true });
  }
});
// A pinch arrives as a click on the focused control. A click while the controls are hidden only shows them.
document.addEventListener('click', (e) => {
  if (S.panel || !$('controls').hidden) return;
  if (e.target.closest && e.target.closest('button')) return;
  showControls();
});
$('gpsBtn').addEventListener('click', () => { armControls(); toggleGps(); });
$('lightBtn').addEventListener('click', () => {
  armControls();
  local('bd.light', LIGHTS[(LIGHTS.indexOf(lightPick()) + 1) % LIGHTS.length]);
  render();
});
$('linkBtn').addEventListener('click', openPanel);
$('panelBack').addEventListener('click', closePanel);
$('panelUse').addEventListener('click', useOffer);
// A deliberate setup handoff carries only the existing phone's topic and public key.
// Studio keeps its own keys; a separate storage context still needs the normal code comparison.
$('panelStudio').addEventListener('click',()=>{
  const next=new URL('../',location.href),q=new URLSearchParams({tab:'drive'});
  if(S.addr){q.set('dt',S.addr.t);q.set('dp',S.addr.p);}
  next.hash=q.toString();location.assign(next.href);
});

// ---- life cycle --------------------------------------------------------------------------------------

function visible() {
  const on = !document.hidden;
  const preference=local('bd.gps');
  if(!on&&feed.visible)motion?.clearMotion?.();
  feed.setVisible(on,{autoStart:preference!=='off',resumeOnly:preference==='asked'||preference==='denied'});
  if (on) { S.openedAt = performance.now(); openLink(); } else closeLink();
  render();
}

function tickClock() {
  render();
  const now = new Date();
  setTimeout(tickClock, (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50);
}

(async () => {
  const buildLabel=document.createElement('small');
  buildLabel.id='runningBuild';
  buildLabel.textContent='v'+APP_BUILD;
  buildLabel.setAttribute('aria-label','Bakar Drive build '+APP_BUILD);
  // The same label remains visible above the full-screen Directions panel.
  Object.assign(buildLabel.style,{position:'fixed',right:'5vmin',bottom:'0.7vmin',zIndex:'3',
    fontSize:'14px',lineHeight:'1.1',fontWeight:'500',color:'#99a69f',pointerEvents:'none'});
  document.body.append(buildLabel);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pagehide', () => { motion?.clearMotion?.();feed.setVisible(false);closeLink(); });
  window.addEventListener('pageshow', visible);
  window.addEventListener('online', () => { for (const l of S.links) if (!l.connected) { clearTimeout(l.retryTimer); l.retryTimer = 0; l.fails = 0; scheduleRetry(l); } });
  tickClock();
  visible();
  let linked = false;
  try { linked = await setupLink(); } catch (e) { /* no phone link this visit */ }
  S.setup = true;
  if (linked) openLink();
  render();
  if (S.offer) openPanel();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// For tests in a desktop browser: the same entry the brokers use.
window.__bakarDrive = { onDown, state: S, render, linkChanged };
