'use strict';

// Bakar Home on Meta Ray-Ban Display: Claude and Codex sessions from the studio PC (Work), Bakar's glasses apps
// (Apps) and games kept apart from them (Games).
//
// The link: three free public MQTT brokers at once (EMQX, HiveMQ, and shiftr.io on port 443), the same link Tidal
// Glass and Bakar Studio use. No account, no daily cap, and any broker can be down without anything stopping. From
// Bakar's home network only shiftr.io answers reliably, so none of them waits for another. The PC keeps the latest
// session list retained there, so the list shows the moment a broker connects.
//
// Privacy: the brokers only carry ciphertext. The first time it runs, this page makes a P-256 key pair and keeps
// the private half in IndexedDB as a key that can't be exported. The PC accepts that key once, while a pairing
// window is open at the PC. Both sides then derive the same AES-GCM keys (ECDH + HKDF). The address carries only the
// topic and the PC's public key, so a copied link can't read or send anything.
//
// Battery: nothing runs while the app is hidden. On screen, the page keeps one connection per broker and says hello
// every 2.5 minutes so the PC keeps sending. After 90 seconds without a key press it closes the link (10 minutes
// while you watch a task you started). Times are clock times, so nothing ticks.

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
// A broker that connects late (or again) is also handed what went out in the last few seconds, so a hello that went
// only to a broker the PC isn't on still arrives. The PC drops the repeat by its id.
const RESEND_WINDOW = 10000;
const OUTBOX_MAX_AGE = 60 * 1000;   // the PC drops commands older than 90 seconds
const IDLE_MS = 90 * 1000;
const WATCH_MS = 10 * 60 * 1000;
const HELLO_MS = 150 * 1000;
const ANSWER_MS = 12 * 1000;
const DAILY_SENDS = 400;            // a safety valve against a runaway loop, not a budget
const HELP_OPTIONS = ['Give me THREE good options.', 'Unjumble this for me.'];

const SITE = 'https://baklarrrr.github.io/';
// The Apps and Games lists live in apps.json so another session can add an app or a game without touching this
// code. These are used when it can't be read.
let APPS = [
  { group: 'Studio', name: 'Bakar Studio', url: SITE + 'studio-glass/', why: 'Review pictures and check render progress', icon: 'studio-glass/icon-mono.svg', pass: 'sg' },
  { group: 'Faith', name: 'Quran Glass', url: SITE + 'quran-glass/', why: 'Read or follow a recitation word by word', icon: 'quran-glass/icon-mono.svg' },
  { group: 'Listening', name: 'TIDAL Glass', url: SITE + 'tidal-glass/', why: 'Music from your iPhone through the glasses', icon: 'tidal-glass/icon-mono.svg', pass: 'tg' },
  { group: 'Listening', name: 'Sound Lab', url: SITE + 'tidal-glass/sound/', why: 'Check the audio output on your iPhone', icon: 'tidal-glass/sound/icon-mono.svg', pass: 'tg' },
  { group: 'Driving', name: 'Bakar Drive', url: SITE + 'glass-home/drive/', why: 'GPS speed, heading and linked directions', icon: 'glass-home/drive/icon-mono.svg', pass: 'drive' },
  { group: 'Utilities', name: 'Battery', url: SITE + 'battery-glass/', why: 'Check the charge on your glasses', icon: 'battery-glass/icon-mono.svg', pass: 'tg' },
  { group: 'Activities', name: 'Gulzar', url: SITE + 'gulzar/', why: 'Guided cooking, crafts and drawing', icon: 'gulzar/icon-mono.svg' },
];
let GAMES = [];
const GLYPHS = {
  play: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='6' y='14' width='52' height='36' rx='9' fill='%23fff' opacity='.45'/%3E%3Cpath d='M27 23v18l15-9z' fill='%23fff'/%3E%3C/svg%3E",
  game: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpath d='M18 20h28a12 12 0 0 1 11.6 15l-3 11a6 6 0 0 1-10.4 2L40 43H24l-4.2 5A6 6 0 0 1 9.4 46l-3-11A12 12 0 0 1 18 20z' fill='%23fff'/%3E%3C/svg%3E",
  app: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='10' y='10' width='44' height='44' rx='12' fill='%23fff'/%3E%3C/svg%3E",
};

const $ = (id) => document.getElementById(id);
const enc = (s) => new TextEncoder().encode(s);

// The address may carry its settings as ?query or #fragment. Nothing in it is secret (topic and the PC's public
// key), so the install link uses the query form, which every launcher keeps.
function addressParams() {
  const out = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) out.set(k, v);
  return out;
}

const S = {
  topic: '', relayPubB64: '', fragment: addressParams(), links: [], outbox: [], recent: [], linkId: '', sentLately: [],
  mqttTries: 0, mqttLoading: false, calmTimer: 0, tg: null, battery: null, tidalLast: '',
  devId: '', devPubB64: '', kUp: null, kDown: null, z: 0,
  snap: null, details: {}, view: 'list', tab: 'now', open: '',
  paused: true, idle: 0, hello: 0, answer: 0, askedAt: 0, heardAt: 0, quiet: false, hellos: [], pcAt: 0,
  pending: {}, pairing: null, flash: '', compose: null, openedAt: 0, lastKeyAt: 0,
};

// ---- bytes, storage --------------------------------------------------------------------------------

function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('glass-home', 1);
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

function local(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage can be unavailable; the app still works for this visit */ }
  return null;
}

// ---- keys ------------------------------------------------------------------------------------------

async function setupKeys() {
  let t = S.fragment.get('t');
  let p = S.fragment.get('p');
  if (t && p) await idbPut('pairing', { t, p }).catch(() => {});
  else {
    const saved = await idbGet('pairing').catch(() => null);
    if (saved) ({ t, p } = saved);
  }
  if (!t || !p || !window.crypto || !crypto.subtle) return false;
  S.topic = t;
  S.relayPubB64 = p;
  let dev = await idbGet('dev:' + t).catch(() => null);
  if (!dev) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    dev = { priv: pair.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
    await idbPut('dev:' + t, dev).catch(() => {});
  }
  S.devPubB64 = toB64url(dev.pub);
  S.devId = toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', dev.pub))).slice(0, 16);
  const relay = await crypto.subtle.importKey('raw', fromB64url(p), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: relay }, dev.priv, 256);
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const derive = (dir, use) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc('glass-home v1'), info: enc(`${dir}|${S.devId}|${t}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, [use]);
  S.kUp = await derive('up', 'encrypt');
  S.kDown = await derive('down', 'decrypt');
  try { new DecompressionStream('deflate-raw'); S.z = 1; } catch (e) { S.z = 0; }
  return true;
}

async function inflate(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

async function openDown(text) {
  const [v, flag, blob] = String(text).trim().split('.');
  if (v !== '1' || !blob) return null;
  const raw = fromB64url(blob);
  let plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, S.kDown, raw.slice(12)));
  if (flag === 'z') plain = await inflate(plain);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function send(c, extra = {}, options = {}) {
  if (!S.kUp) return '';
  const pairedKey=S.kUp,pairedTopic=S.topic,pairedPublic=S.devPubB64;
  if (options.guard && !options.guard()) throw new Error('Cancelled before sending. Your draft is kept.');
  const today = new Date().toDateString();
  const b = local('gh.sends') || {};
  const n = b.d === today ? (b.n || 0) : 0;
  if (n >= DAILY_SENDS) { flash('Too many messages today; check the PC'); return ''; }
  local('gh.sends', { d: today, n: n + 1 });
  const id = options.id || toB64url(crypto.getRandomValues(new Uint8Array(9)));
  if (c === 'hello') S.hellos = S.hellos.slice(-4).concat(id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc(JSON.stringify({ c, id, ts: Date.now(), z: S.z, ...extra }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.kUp, body));
  if(options.noQueue&&(S.kUp!==pairedKey||S.topic!==pairedTopic||S.devPubB64!==pairedPublic))throw new Error('The paired connection changed before sending. Your draft is kept.');
  if (options.guard && !options.guard()) throw new Error('Cancelled before sending. Your draft is kept.');
  const sealed = new Uint8Array(12 + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, 12);
  const payload = `1.${S.devPubB64}.${toB64url(sealed)}`;
  const live = S.links.filter((l) => l.connected);
  if (!live.length && options.noQueue) throw new Error('Connection unavailable. Nothing was sent; your draft is kept.');
  if(options.noQueue){
    let queued=false;
    for(const client of live){try{options.onPublish?.();client.publish(`bkr/${S.topic}/u`,payload,{qos:1});queued=true;}catch(_){}}
    if(!queued)throw new Error('The connection did not confirm publication. Check the saved receipt before trying anything else.');
    return id; // Explicit requests never enter the automatic reconnect/replay buffer.
  }
  if (!live.length) {
    // Not connected this instant (just opened, or the glasses' network is waking): it goes out the moment a
    // broker connects. The PC drops a command it has already seen.
    S.outbox.push({ payload, at: Date.now() });
    openLink();
  } else {
    for (const l of live) l.publish(`bkr/${S.topic}/u`, payload, { qos: 1 });
    remember(payload);
  }
  return id;
}

// ---- link ------------------------------------------------------------------------------------------

function linkUp() {
  return S.links.some((l) => l.connected);
}

function linkChanged() {
  renderState();
}

function remember(payload) {
  S.sentLately.push({ payload, at: Date.now() });
  if (S.sentLately.length > 20) S.sentLately.shift();
}

// The link library is a large file. On the first launch after an update the previous offline copy of this app can
// give up on it before it arrives, so it is fetched again for about half a minute instead of waiting silently.
function loadMqtt() {
  if (S.mqttLoading || S.mqttTries >= 10) return;
  S.mqttLoading = true;
  S.mqttTries += 1;
  const tag = document.createElement('script');
  tag.src = `vendor/mqtt.min.js?try=${S.mqttTries}`;
  tag.onload = () => { S.mqttLoading = false; if (!S.paused) openLink(); };
  tag.onerror = () => { S.mqttLoading = false; tag.remove(); setTimeout(loadMqtt, 3000); };
  document.head.append(tag);
}

function openLink() {
  if (S.links.length || (!S.kUp && !S.tg)) return;
  if (typeof mqtt === 'undefined') { loadMqtt(); return; }
  S.linkId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  for (const b of BROKERS) addBroker(b);
}

// Retries are scheduled here, not by mqtt.js (reconnectPeriod 0). On 2026-10-25 a Tidal Glass page left open without
// signal on Bakar's glasses tried every broker about every 2 s for 8.5 minutes, which keeps the radio awake. Now: 1 s
// for the first three tries, then doubling to 30 s while nothing is connected; a broker that keeps failing while
// another carries the link backs off to 10 min. A connect, the network coming back ('online') or a new visit starts
// it fast again.
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
  }, retryDelay(client.fails, linkUp()));
}

// Connect timeout 6 s: the slowest good connect the glasses reported was 4.1 s, and a try that hangs costs the whole
// timeout before the next one.
function addBroker({ url, ...extra }) {
  // Random ids: shiftr.io shows client ids on a public dashboard.
  const client = mqtt.connect(url, {
    clientId: `ghg-${S.linkId}-${S.links.length}`, clean: true, keepalive: 45, protocolVersion: 4,
    reconnectPeriod: 0, connectTimeout: 6000, ...extra,
  });
  client.on('connect', () => {
    client.fails = 0;
    clearTimeout(client.retryTimer);
    client.retryTimer = 0;
    const topics = S.kUp ? [`bkr/${S.topic}/d/${S.devId}/s`, `bkr/${S.topic}/d/${S.devId}/m`] : [];
    if (S.tg) topics.push(`bkr/${S.tg.t}/s`); // Existing phone state: battery and correlated Watch handoff receipts
    client.subscribe(topics, { qos: 1 });
    // What already went out on the other brokers in the last few seconds goes on this one too.
    const now = Date.now();
    S.sentLately = S.sentLately.filter((o) => now - o.at < RESEND_WINDOW);
    for (const o of S.sentLately) client.publish(`bkr/${S.topic}/u`, o.payload, { qos: 1 });
    flushOutbox();
    linkChanged();
    // Back after a drop: a hello the PC hasn't answered is asked again (the PC ignores a repeat).
    if (!S.paused && S.askedAt && S.heardAt < S.askedAt && now - S.askedAt > 3000) hello();
  });
  client.on('message', (t, payload) => {
    const text = new TextDecoder().decode(payload);
    if (S.tg && t === `bkr/${S.tg.t}/s`) handleTidal(text);
    else handle(text);
  });
  client.on('offline', linkChanged);
  client.on('close', () => { linkChanged(); scheduleRetry(client); });
  client.on('error', () => { /* a 'close' follows, and the retry is scheduled there */ });
  S.links.push(client);
  return client;
}

function closeLink() {
  const old = S.links;
  S.links = [];
  S.outbox = [];
  S.sentLately = [];   // a reopened link never resends an old hello
  for (const l of old) {
    clearTimeout(l.retryTimer);
    l.retryTimer = 0;
    try { l.end(true); } catch (e) { /* already closed */ }
  }
}

function flushOutbox() {
  const live = S.links.filter((l) => l.connected);
  if (!live.length) return;
  const now = Date.now();
  const due = S.outbox.filter((o) => now - o.at < OUTBOX_MAX_AGE);
  S.outbox = [];
  for (const o of due) {
    for (const l of live) l.publish(`bkr/${S.topic}/u`, o.payload, { qos: 1 });
    remember(o.payload);
  }
}

async function handle(text) {
  if (S.recent.includes(text)) return; // the same message from the other broker
  S.recent.push(text);
  if (S.recent.length > 24) S.recent.shift();
  let m;
  try { m = await openDown(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  // The retained list can be minutes old. A reply that names one of this visit's hellos is live, and so is anything
  // the PC wrote after that reply (by the PC's own clock, so the two clocks needn't agree).
  const live = Boolean(m.re && S.hellos.includes(m.re)) || (S.pcAt > 0 && (m.at || 0) >= S.pcAt);
  if (live) { S.heardAt = Date.now(); S.quiet = false; S.pcAt = Math.max(S.pcAt, m.at || 0); }
  if (m.t === 'snap') {
    if (!S.snap || m.at >= S.snap.at) {
      S.snap = m;
      showPush(m.say);
      if (S.pairing && live) closePairing();
      renderWork();
      if (S.view === 'detail') renderDetail();
    }
  } else if (m.t === 'det') {
    const old = S.details[m.k];
    if (!old || m.at >= old.at) {
      S.details[m.k] = m;
      if (S.view === 'detail' && S.open === m.k) renderDetail();
    }
  } else if (m.t === 'ack') {
    const done = S.pending[m.re];
    if (done) { delete S.pending[m.re]; done(m); }
  } else if (m.t === 'unpaired' && live) {
    showPairing(m.code);
  } else if (m.t === 'paired' && live) {
    closePairing();
    flash(`Paired · code ${m.code}`);
  }
  renderState();
}

// Yes/no facts about this browser, sent once per visit so the PC can record what the glasses support. Only whether
// the other apps' pairing exists here (shared storage), never its value.
function diagnostics() {
  if (S.diagSent) return undefined;
  S.diagSent = true;
  let sg = false;
  const tg = Boolean(passPairing('tg'));
  try { sg = Boolean(localStorage.getItem('sg.pair')); } catch (e) { /* none */ }
  return { ua: navigator.userAgent.slice(0, 160), sg, tg, ref: document.referrer ? new URL(document.referrer).pathname : '',
    z: S.z, idb: Boolean(window.indexedDB), w: innerWidth, h: innerHeight };
}

function hello() {
  S.askedAt = Date.now();
  send('hello', { w: S.view === 'detail' ? S.open : '', d: diagnostics() });
  clearTimeout(S.answer);
  S.answer = setTimeout(() => {
    if (S.heardAt < S.askedAt) { S.quiet = true; renderState(); }
  }, ANSWER_MS);
}

function wake() {
  if ((!S.kUp && !S.tg) || document.visibilityState !== 'visible') return;
  const was = S.paused;
  S.paused = false;
  armIdle();
  if (!was) return;
  S.askedAt = Date.now();
  openLink();
  hello();
  clearInterval(S.hello);
  S.hello = setInterval(hello, HELLO_MS);
  renderState();
}

function sleep(reason) {
  S.paused = true;
  if (reason === 'hidden') clearTimeout(S.renderStatusTimer);
  closeLink();
  if (reason === 'hidden') { clearTimeout(S.calmTimer); S.calmTimer = 0; }
  clearInterval(S.hello);
  clearTimeout(S.idle);
  clearTimeout(S.answer);
  renderState();
}

function watchingOwnTask() {
  const d = S.view === 'detail' && S.details[S.open];
  return Boolean(d && d.own && d.st === 'work');
}

function armIdle() {
  clearTimeout(S.idle);
  S.idle = setTimeout(() => sleep('idle'), watchingOwnTask() ? WATCH_MS : IDLE_MS);
}

// ---- other apps' pairings ----------------------------------------------------------------------------
// Studio's PC registration survives an update. A legacy phone registration does
// not identify the current iPhone. A new Android companion integration must
// explicitly supply its own Android bridge in the fragment, never the query.
function passPairing(name) {
  if (name === 'tg') {
    const bridge = new URLSearchParams(location.hash.slice(1)).get('androidBridge') || '';
    const [t, k] = bridge.split('~');
    return t && k ? { t, k } : null;
  }
  if (name !== 'sg') return null;
  const saved = local('gh.pass') || {};
  const incoming = S.fragment.get('sg');
  const studio = incoming && incoming.includes('~') ? incoming : saved.sg || '';
  const [t, k] = studio.split('~');
  if (t && k) {
    if (saved.sg !== studio) local('gh.pass', { ...saved, sg: studio });
    return { t, k };
  }
  // The embedded Review also stores its surviving Studio pairing on this origin.
  const review = local('sg.pair');
  return review && review.t && review.k ? { t: review.t, k: review.k } : null;
}

// ---- glasses battery -------------------------------------------------------------------------------
// The phone's Tidal Glass app reports the glasses' battery (5% steps) in Tidal Glass's retained state. With Tidal's
// pairing (above), Bakar Home reads state. Explicit parked Watch actions can also use the existing command topic. No Tidal pairing,
// or no battery in the state: no chip.

async function setupBattery() {
  const pair = passPairing('tg');
  if (!pair || !window.crypto || !crypto.subtle) return;
  try {
    const key = await crypto.subtle.importKey('raw', fromB64url(pair.k), 'AES-GCM', false, ['encrypt','decrypt']);
    S.tg = { t: pair.t, key };
  } catch (e) { S.tg = null; }
}

async function handleTidal(text) {
  if (!text || text === S.tidalLast) return; // the same state from the other broker
  S.tidalLast = text;
  let m;
  try {
    const buf = fromB64url(text.trim());
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, S.tg.key, buf.slice(12));
    m = JSON.parse(new TextDecoder().decode(plain));
  } catch (e) { return; }
  if (!m || m.t !== 'state') return;
  watchPhone.receive(m);
  if (S.battery && m.at && S.battery.at && m.at < S.battery.at) return;
  // gb/gc: the glasses (5% steps, charging); bb: the Neural Band, which the phone reads over Bluetooth.
  const gb = Number.isFinite(m.gb) ? m.gb : null;
  const bb = Number.isFinite(m.bb) ? m.bb : null;
  S.battery = gb != null || bb != null ? { gb, gc: Boolean(m.gc), bb, at: m.at || Date.now() } : null;
  renderBattery();
}

function renderBattery() {
  const b = S.battery;
  // A reading over 30 minutes old (the phone app stopped, say) is hidden rather than shown as current.
  const fresh = Boolean(b) && Date.now() - (b.at || 0) < 30 * 60 * 1000;
  const glasses = $('gbat');
  glasses.hidden = !fresh || b.gb == null;
  if (!glasses.hidden) {
    $('gbatText').textContent = `${b.gb}%`;
    $('gbatFill').setAttribute('width', String(Math.max(1, (13.4 * b.gb) / 100)));
    glasses.classList.toggle('charging', b.gc);
    glasses.classList.toggle('low', !b.gc && b.gb <= 15);
    glasses.setAttribute('aria-label', `Glasses battery ${b.gb}%${b.gc ? ', charging' : ''}`);
  }
  const band = $('bbat');
  band.hidden = !fresh || b.bb == null;
  if (!band.hidden) {
    $('bbatText').textContent = `${b.bb}%`;
    band.classList.toggle('low', b.bb <= 15);
    band.setAttribute('aria-label', `Neural Band battery ${b.bb}%`);
  }
}

// ---- calm: less light while nobody is touching it --------------------------------------------------
// After CALM_AFTER without a swipe or pinch on a list or a session, the page dims what doesn't need full light
// (see style.css). The first input wakes it at once and is handled as usual. One timer, reset by input; none while
// the app is hidden.
const CALM_AFTER = 15000;
const CALM_PANES = ['now', 'work', 'detail', 'watch', 'route', 'play', 'apps', 'games'];

function enterCalm() {
  const pane = PANES.find((p) => !$(p).hidden);
  if (CALM_PANES.includes(pane) && document.visibilityState === 'visible') document.body.classList.add('calm');
}

function wakeUp() {
  document.body.classList.remove('calm');
  clearTimeout(S.calmTimer);
  S.calmTimer = document.visibilityState === 'visible' ? setTimeout(enterCalm, CALM_AFTER) : 0;
}

// ---- words -----------------------------------------------------------------------------------------

const STATUS = { needs: 'Needs you', work: 'Working', done: 'Done', stop: 'Stopped' };
const PROVIDER = { c: 'Claude', x: 'Codex' };

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function age(sec) {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Explicit provider handoff. Posted confirms a phone notification, never playback or search results.
let watchViewEpoch=0;
const watchPhone=new StudioWatchPhone.Handoff({
  pair:()=>S.tg,
  active:()=>!document.hidden&&StudioParked.controlsAllowed()&&S.tab==='watch'&&(S.view==='list'||(S.view==='compose'&&S.compose?.mode==='yt')),
  ensureConnected:async current=>{
    wake();openLink();
    const until=performance.now()+2500;
    while(current()&&performance.now()<until){if(linkUp())return true;await new Promise(resolve=>setTimeout(resolve,20));}
    return false;
  },
  publish:(topic,body)=>{
    let sent=false;
    for(const client of S.links){if(!client.connected)continue;try{client.publish(topic,body,{qos:1,retain:false});sent=true;}catch(_){}}
    return sent;
  }
});
function cancelWatch(){watchViewEpoch++;watchPhone.cancel();}
async function handoffWatch(fields,note){
  if(watchPhone.pending)return;
  const epoch=++watchViewEpoch,compose=S.compose,view=S.view;
  note.hidden=false;note.textContent='Sending to your phone…';
  if(view==='compose')$('cSend').setAttribute('aria-disabled','true');
  try{
    const result=await watchPhone.request(fields);
    if(epoch!==watchViewEpoch||S.view!==view||S.compose!==compose||S.tab!=='watch'||document.hidden)return;
    note.textContent=result.code==='posted'?'Notification posted. Tap it on your phone to open '+(fields.kind==='search'?'YouTube search.':'the video. Playback has not started.'):
      result.code==='notifications-disabled'?'Your phone could not show its notification. Its existing notification setting is off.':
      result.code==='expired'?'The handoff expired before your phone accepted it. Try again.':'Your phone could not confirm this handoff. Check its notifications before trying again.';
  }catch(error){if(epoch===watchViewEpoch&&S.view===view&&S.compose===compose&&S.tab==='watch'&&!document.hidden)note.textContent=error.message;}
  finally{if(view==='compose'&&S.compose===compose)$('cSend').removeAttribute('aria-disabled');}
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- drawing ---------------------------------------------------------------------------------------

function renderState() {
  const dot = $('dot');
  let text = '';
  let tone = '';
  if (S.flash) text = S.flash;
  else if (!S.kUp) text = '';
  else if (S.pairing) { text = 'Not paired'; tone = 'warn'; }
  else if (S.paused) text = S.snap ? `Paused · ${clock(S.snap.at)}` : 'Paused';
  else if (!linkUp() && !S.snap) text = 'Connecting…';
  else if (S.quiet && !S.snap) { text = 'PC not answering'; tone = 'warn'; }
  else if (!S.snap) text = 'Asking your PC…';
  else if (S.quiet) { text = `PC quiet · ${clock(S.snap.at)}`; tone = 'warn'; }
  else if (S.heardAt < S.askedAt) text = `Updating · ${clock(S.snap.at)}`;
  else { text = `Live · ${clock(S.snap.at)}`; tone = 'live'; }
  $('stateText').textContent = text;
  dot.className = 'dot' + (tone ? ' ' + tone : '');
}

function flash(text) {
  S.flash = text;
  renderState();
  clearTimeout(S.flashTimer);
  S.flashTimer = setTimeout(() => { S.flash = ''; renderState(); }, 4000);
}

function renderWork() {
  renderNow();
  renderWatch();
  renderRoute();
  const s = S.snap;
  const list = $('rows');
  const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : '';
  list.textContent = '';
  const sum = $('summary');
  sum.textContent = '';
  if (!S.kUp) {
    sum.textContent = 'Open Bakar Home from its existing link to see Claude and Codex.';
    return;
  }
  if (!s) {
    sum.textContent = S.paused ? 'Press any key to ask your PC.' : 'Asking your PC for Claude and Codex…';
    return;
  }
  const n = s.n || {};
  const parts = [];
  if (n.needs) parts.push(['needs', `${n.needs} need${n.needs === 1 ? 's' : ''} you`]);
  if (n.work) parts.push(['', `${n.work} working`]);
  if (n.done) parts.push(['', `${n.done} done`]);
  if (n.stop) parts.push(['', `${n.stop} stopped`]);
  if (!parts.length) sum.textContent = 'No Claude or Codex sessions in the last day.';
  parts.forEach(([cls, text], i) => {
    if (i) sum.append(' · ');
    sum.append(el('b', cls, text));
  });
  const can = s.can || {};
  $('newTask').hidden = !(can.new && can.new.length);
  (s.rows || []).forEach((r, i) => {
    const li = el('li');
    const why = r.st === 'work' && !r.why ? 'Working' : r.why;
    // The first session is the hero: the same row in the same place in the order, drawn with more presence.
    const b = el('button', `row ${r.st}${i === 0 ? ' hero' : ''}`);
    b.dataset.k = r.k;
    if (i === 0) {
      const kicker = el('span', 'kicker');
      const meta = el('span', 'km', ` · ${r.own ? 'Glasses · ' : ''}${PROVIDER[r.p]} · `);
      meta.append(el('span', 'ag', age(r.at)));
      kicker.append(el('span', 'st', STATUS[r.st]), meta);
      b.append(kicker, el('span', 'ti', r.ti), el('span', 'why', why));
    } else {
      b.append(el('span', `mark ${r.st}`), el('span', 'ti', r.ti), el('span', 'tag', (r.own ? 'Glasses · ' : '') + PROVIDER[r.p]));
      b.append(el('span', 'why', why), el('span', 'age', age(r.at)));
    }
    b.setAttribute('aria-label', `${r.ti}. ${PROVIDER[r.p]}. ${STATUS[r.st]}. ${r.why}`);
    b.addEventListener('click', () => openDetail(r.k));
    li.append(b);
    list.append(li);
  });
  if (s.more) list.append(el('li', 'empty', `${s.more} more on your PC`));
  if (focusedKey) {
    const again = list.querySelector(`[data-k="${CSS.escape(focusedKey)}"]`);
    if (again) again.focus({ preventScroll: true });
  } else if (!S.listShown && S.view === 'list' && S.tab === 'work' && !S.pairing) {
    // The first list after opening: start on the top session unless Bakar has already moved somewhere.
    const a = document.activeElement;
    if (!a || a === document.body || a.dataset.tab === 'work') focusFirst('work');
  }
  S.listShown = S.listShown || Boolean((s.rows || []).length);
}

// ---- now: the first screen -------------------------------------------------------------------------
// One hero and at most three quiet cards: what in Bakar's world needs him or is moving right now. Built from the
// session list plus the PC's glance (renders from the shared queue, open GreenCitizen site notes). The hero is the
// most pressing card; when nothing is, the screen says so and stays dark.

function ago(sec) {
  const a = age(sec);
  return a === 'now' ? 'just now' : `${a} ago`;
}

// A line short enough for one row on the glasses, cut between words.
function shortAt(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:·-]+$/, '')}…`;
}

function duration(sec) {
  if (!sec) return '';
  return sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
}

function openStudio() {
  selectTab('review');
}

// ---- messages from the PC (relay/push.py, MCP glasses_say) ------------------------------------------

function showPush(p) {
  if (S.tab === 'drive' || S.tab === 'route') return; // Never reveal or speak an incoming banner in Drive.
  if (!p || !p.id || p.id === S.pushed) return;
  S.pushed = p.id;
  const box = $('push');
  $('pushTitle').textContent = p.ti || '';
  $('pushText').textContent = p.tx || '';
  box.hidden = false;
  box.classList.remove('go');
  void box.offsetWidth;   // restart the light sweep for a second message
  box.classList.add('go');
  clearTimeout(S.pushTimer);
  S.pushTimer = setTimeout(() => { box.hidden = true; box.classList.remove('go'); }, 7000);
  if (p.sp && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance([p.ti, p.tx].filter(Boolean).join('. ')));
  }
}

function speakNote(text) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (S.speaking === 'now') { stopReading(); return; }
  stopReading();
  const u = new SpeechSynthesisUtterance(text);
  u.onend = u.onerror = () => { if (S.speaking === 'now') S.speaking = ''; };
  S.speaking = 'now';
  synth.speak(u);
}

function renderObservation(r, now = Date.now() / 1000) {
  const observed = (x) => x && Number.isInteger(x.run) && x.run >= 0
    && Number.isFinite(x.checkedAt) && x.checkedAt > 0 && x.checkedAt <= now;
  const validFor = r && Number.isFinite(r.validFor) && r.validFor > 0 && r.validFor <= 120 ? r.validFor : 0;
  const trusted = r && r.state === 'ok' && observed(r);
  const known = Boolean(trusted && validFor && now - r.checkedAt < validFor);
  return { known, validFor,
    lastKnown: trusted ? r : r && observed(r.lastKnown) ? r.lastKnown : null,
    reason: trusted ? 'Last check is stale' : !r || r.error === 'Not checked yet' ? 'Awaiting a process check' : 'Process check unavailable' };
}

function scheduleRenderStatusRefresh() {
  clearTimeout(S.renderStatusTimer);
  S.renderStatusTimer = 0;
  if (document.visibilityState !== 'visible' || $('now').hidden || !S.snap) return;
  const r = (S.snap.g || {}).r;
  const observation = renderObservation(r);
  if (!observation.known && !observation.lastKnown) return;
  const delay = observation.known ? Math.min(60000, Math.max(1000, (r.checkedAt + observation.validFor - Date.now() / 1000) * 1000 + 10)) : 60000;
  // UI age/expiry only: no query, broker request or timer while this pane is hidden.
  S.renderStatusTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && !$('now').hidden) renderNow();
  }, delay);
}

function nowCards() {
  const s = S.snap;
  if (!s) return [];
  const g = s.g || {};
  const n = s.n || {};
  const rows = s.rows || [];
  const cards = [];
  const needs = rows.filter((r) => r.st === 'needs');
  if (needs.length) {
    const one = needs.length === 1;
    cards.push({ id: 'needs', st: 'needs', rank: 0, kick: 'Needs you',
      ti: one ? needs[0].ti : `${needs.length} sessions need you`,
      meta: one ? ` · ${PROVIDER[needs[0].p]} · ${age(needs[0].at)}` : '',
      why: one ? needs[0].why : needs.slice(0, 2).map((r) => r.ti).join(' · '),
      go: () => (one ? openDetail(needs[0].k) : selectTab('work')) });
  }
  const r = g.r;
  const observation = renderObservation(r);
  if (!observation.known) {
    const last = observation.lastKnown;
    cards.push({ id: 'render-status', st: 'stop', rank: 2.1, unknown: true,
      kick: observation.reason === 'Last check is stale' ? 'Stale' : 'Unknown', ti: 'Blender activity unknown',
      why: last ? `Last known: ${last.run} background job${last.run === 1 ? '' : 's'} · ${ago(last.checkedAt)}` : observation.reason,
      go: openStudio });
  }
  if (observation.known && r.run > 0) {
    // The longest-running job, named from its .blend, with how long it has run: the card moves on its own.
    const job = r.job || {};
    const running = job.since ? `Running ${duration(Math.max(1, Math.round(Date.now() / 1000 - job.since)))}` : 'Running';
    // A headless Blender run that isn't rendering frames (a bake, an export) is only "busy", and never the hero.
    const verb = job.busy ? 'Blender busy' : 'Rendering';
    cards.push({ id: 'render', st: 'work', rank: job.busy ? 2.2 : 1, kick: r.run === 1 ? verb : `${verb} · ${r.run} jobs`,
      ti: job.ti || 'Blender render',
      why: `${running}${r.last ? ` · last ${r.last.ok ? 'finished' : 'failed'}: ${r.last.ti}` : ''}`, go: openStudio });
  } else if (r && r.last) {
    cards.push({ id: 'render', st: r.last.ok ? 'done' : 'needs', rank: r.last.ok ? 3 : 0.5,
      kick: r.last.ok ? 'Last render' : 'Render failed', ti: r.last.ti,
      why: `${observation.known ? '0 background jobs · ' : ''}${r.last.ok ? 'Finished' : 'Stopped'} ${ago(r.last.at)}${r.last.sec ? ` · took ${duration(r.last.sec)}` : ''}`,
      go: openStudio });
  } else if (observation.known) {
    cards.push({ id: 'render', st: 'stop', rank: 3, kick: 'Checked', ti: 'No background Blender jobs',
      why: `Checked ${ago(r.checkedAt)}`, go: openStudio });
  }
  if (observation.known && r.run > 0 && r.last && r.last.ok === false) {
    cards.push({ id: 'render-history', st: 'needs', rank: 0.5, kick: 'Earlier render failed', ti: r.last.ti,
      why: `Stopped ${ago(r.last.at)}${r.last.sec ? ` · took ${duration(r.last.sec)}` : ''}`, go: openStudio });
  }
  if (n.work) {
    const w = rows.filter((x) => x.st === 'work');
    cards.push({ id: 'work', st: 'work', rank: 2, kick: 'Claude and Codex',
      ti: `${n.work} session${n.work === 1 ? '' : 's'} working`,
      why: w.length ? `Newest: ${w[0].ti}${w.length > 1 ? ` and ${w.length - 1} more` : ''}` : '', go: () => selectTab('work') });
  }
  // Site notes are steady background: they show beside anything else, and on a quiet screen only when one changed
  // in the last day, so "Nothing needs you" never sits above an old pile.
  const gc = g.gc;
  const fresh = gc && gc.up && Date.now() / 1000 - gc.up < 86400;
  if (gc && gc.open && (fresh || cards.some((c) => c.rank < 2.5))) {
    cards.push({ id: 'gc', st: 'done', rank: 2.5, kick: 'GreenCitizen · reads aloud',
      ti: `${gc.open} site note${gc.open === 1 ? '' : 's'} open`,
      why: gc.top ? shortAt(`${gc.pg ? gc.pg[0].toUpperCase() + gc.pg.slice(1) + ' · ' : ''}${gc.top.replace(/…$/, '')}`, 50) : '',
      go: () => speakNote(`GreenCitizen. ${gc.open} site notes open. Newest${gc.pg ? `, on ${gc.pg}` : ''}: ${gc.top || ''}`) });
  }
  cards.sort((a, b) => a.rank - b.rank);
  return cards.slice(0, 4);
}

function renderNow() {
  clearTimeout(S.renderStatusTimer);
  const list = $('nowRows');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.now : '';
  list.textContent = '';
  const line = $('nowLine');
  if (!S.kUp) { line.textContent = 'Open Bakar Home from its existing link to see your studio.'; return; }
  if (!S.snap) { line.textContent = S.paused ? 'Press any key to ask your PC.' : 'Asking your PC…'; return; }
  const cards = nowCards();
  const calm = !cards.length || cards[0].rank >= 2;
  line.textContent = calm ? (cards.some((c) => c.unknown) ? 'Some activity is unknown.' : 'Nothing needs you right now.') : '';
  line.hidden = !calm;
  scheduleRenderStatusRefresh();
  cards.forEach((c, i) => {
    const li = el('li');
    const hero = i === 0 && !calm;
    const b = el('button', `row ${c.st}${hero ? ' hero' : ''}`);
    b.dataset.now = c.id;
    if (hero) {
      const kicker = el('span', 'kicker');
      kicker.append(el('span', 'st', c.kick));
      if (c.meta) kicker.append(el('span', 'km', c.meta));
      b.append(kicker, el('span', 'ti', c.ti), el('span', 'why', c.why));
    } else {
      // A quiet card's line is cut between words to fit beside its tag; the full text is in its label and read aloud.
      b.append(el('span', `mark ${c.st}`), el('span', 'ti', c.ti), el('span', 'tag', c.kick), el('span', 'why', shortAt(c.why, 54)), el('span', 'age', ''));
    }
    b.setAttribute('aria-label', `${c.kick}. ${c.ti}. ${c.why}`);
    b.addEventListener('click', c.go);
    li.append(b);
    list.append(li);
  });
  if (focused && document.visibilityState === 'visible' && !$('now').hidden) {
    const again = list.querySelector(`[data-now="${CSS.escape(focused)}"]`)
      || list.querySelector('[data-now="render-status"]') || list.querySelector('button');
    if (again) again.focus({ preventScroll: true });
  } else if (S.view === 'list' && S.tab === 'now' && !S.pairing && !S.nowShown) {
    const a = document.activeElement;
    if (!a || a === document.body || a.dataset.tab === 'now') focusFirst('now');
  }
  S.nowShown = S.nowShown || cards.length > 0;
}

// ---- watch: YouTube on the glasses ---------------------------------------------------------------
// The list lives on the PC (relay/youtube.py): videos shared from the phone, or the newest from chosen channels.
// Playback is YouTube's own embedded player; this page only drives it with the arrows and Enter, and tells the PC where
// he stopped so the next visit picks up there. Meta's driving detection keeps the display off at driving speed.

function clockTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ---- route: a parked preview, drawn from relay/route.py ---------------------------------------------

function fitDistance(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`; }

function renderRoute() {
  const r = (S.snap && S.snap.rt) || {};
  const line = $('routeLine');
  const map = $('routeMap');
  const list = $('routeRows');
  if (!r.id) {
    map.setAttribute('hidden', '');   // an svg has no .hidden property
    list.textContent = '';
    line.textContent = S.snap ? 'No route yet. Ask an AI or use Send route on your PC. This is for planning, before you set off.' : 'Asking your PC for your route…';
    return;
  }
  const hours = Math.floor(r.min / 60);
  line.textContent = `Saved preview: ${r.ti}. ${r.km} km, ${hours ? `${hours} h ` : ''}${r.min % 60} min. No live guidance or traffic.`;
  if (S.routeShown === r.id) return;
  S.routeShown = r.id;
  map.removeAttribute('hidden');
  const path = r.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  for (const id of ['routeTrace', 'routeGlow']) $(id).setAttribute('d', path);
  const end = r.pts[r.pts.length - 1];
  $('routeEnd').setAttribute('cx', end[0]);
  $('routeEnd').setAttribute('cy', end[1]);
  placeRouteDot(r.steps[0]);
  map.classList.remove('draw');
  void map.getBoundingClientRect();   // restart the line drawing itself on for a new route
  map.classList.add('draw');
  list.textContent = '';
  r.steps.forEach((s, i) => {
    const li = el('li');
    const b = el('button', 'row step');
    b.dataset.s = i;
    b.append(el('span', 'ti', s.t), el('span', 'tag', fitDistance(s.km)));
    b.setAttribute('aria-label', `${s.t}. ${fitDistance(s.km)}`);
    li.append(b);
    list.append(li);
  });
}

function placeRouteDot(s) {
  if (!s) return;
  $('routeDot').setAttribute('transform', `translate(${s.x} ${s.y})`);
}

// ---- drive: reported phone GPS speed, never a vehicle instrument or a sample -------------------------
const DRIVE_PHONE_LABELS=Object.freeze({
  off:'Phone link stopped in this app', unpaired:'Phone link not set up', paused:'Phone link paused',
  live:'Phone GPS through Journal', stale:'Phone speed expired', 'no-sample':'Phone linked · no fresh GPS speed',
  pairing:'Compare the code on your phone', ready:'Phone linked · waiting for GPS',
  waiting:'Waiting for your phone', connecting:'Connecting to your phone', offline:'Phone link unavailable',
  unavailable:'Secure phone link unavailable'
});
const drivePhone = typeof StudioDrivePhone!=='undefined'?new StudioDrivePhone.Phone({change:()=>paintDrive(driveFeed.snapshot())}):{
  enabled:false,snapshot:()=>({state:'unavailable',configured:false,gps:null,nav:null,offer:false,code:''}),
  setup:async()=>false,setVisible(){},setEnabled(){},cancelChoice(){},acceptOffer:async()=>false,keepCurrent(){}
};
// Compass tape and saved-route guidance (drive/guide.js). The guide is handed each fix as it arrives and keeps only how far
// along the saved route it is; the position is not stored and nothing is sent. A missing module leaves Drive as it was.
const driveGuide = typeof DriveGuide!=='undefined'?new DriveGuide.Guide():null;
// Fixed-camera warning (drive/cameras.js): a red light or speed camera on the road ahead, from a public list shipped with
// the app (drive/cameras.json). Worked out here from each fix; nothing about the position is kept or sent.
const driveCams = typeof DriveCameras!=='undefined'?new DriveCameras.Watch():null;
let driveCamsAsked=false,driveCamsFailed=false;
// What the Drive face must admit about the list, or '': it could not be loaded, or it is more than 30 days old.
function driveCamsNote(){return !driveCams?'':driveCamsFailed&&!driveCams.count?'no camera list':driveCams.staleNote().replace(/^C/,'c');}
function loadDriveCameras() {
  if(!driveCams||driveCamsAsked)return;
  driveCamsAsked=true;
  fetch('drive/cameras.json').then(r=>r.ok?r.json():Promise.reject()).then(file=>{driveCams.load(file);driveCamsFailed=!driveCams.count;})
    .catch(()=>{driveCamsAsked=false;driveCamsFailed=true;});   // a miss is tried again next time Drive opens, and the face says there is no list
}
const driveGeo = driveGuide&&navigator.geolocation?{
  watchPosition:(ok,fail,options)=>navigator.geolocation.watchPosition(p=>{
    driveGuide.fix(p);
    const seen=driveGuide.fill(p);   // fill: a speed from positions where the device reports none
    driveCams?.fix(p,driveGuide.course(seen.coords),seen.coords.speed);
    ok(seen);
  },fail,options),
  clearWatch:id=>navigator.geolocation.clearWatch(id)
}:navigator.geolocation;
let driveTapeShown='';
function paintDriveTape(course) {
  const svg=$('driveTape'); if(!svg?.style)return;
  const t=driveGuide?DriveGuide.tape(Number.isFinite(course)?course:NaN):null,key=t?String(Math.round(course*2)/2):'';
  svg.style.visibility=t?'visible':'hidden';
  svg.setAttribute('aria-label',t?`Compass: heading ${t.point}, ${t.deg} degrees`:'Compass: no heading while stopped');
  if(key===driveTapeShown)return;
  driveTapeShown=key; svg.textContent='';
  if(!t)return;
  const make=(name,attrs,text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const k in attrs)n.setAttribute(k,attrs[k]);if(text)n.textContent=text;svg.append(n);};
  for(const k of t.ticks){
    const x=(k.x*150).toFixed(1),fade=k.north?1:(1-Math.abs(k.x)*.35).toFixed(2);   // the edges dim a little; north never does
    make('line',{x1:x,x2:x,y1:9,y2:k.major?19:15,class:k.north?'major north':k.major?'major':'',opacity:fade});
    if(k.label&&Math.abs(k.x)>.36)make('text',{x,y:40,class:k.north?'north':'',opacity:fade},k.label);   // the middle belongs to the readout
  }
  make('path',{d:'M-6 0H6L0 8Z',class:'needle'});
  make('text',{x:0,y:41,class:'readout'},t.readout);
}
const driveFeed = new StudioDriveLocation.Feed({
  geo:driveGeo, permissions:navigator.permissions,
  change:paintDrive
});
const driveCheck = typeof SpeedCheck!=='undefined'?SpeedCheck:null;
const DRIVE_STATUS_LABELS=Object.freeze({
    off:'GPS not started in this app', unsupported:'Location API unavailable',
    waiting:'Waiting for phone GPS', unavailable:'GPS has no speed reading',
    invalid:'GPS reading unavailable', inaccurate:'GPS signal too weak',
    stale:'GPS reading expired', denied:'Location permission not granted',
    timeout:'GPS request timed out', 'no-response':'No GPS response yet', disconnected:'Location fix unavailable',
    paused:'App GPS paused'
  });
function paintDrive(reading) {
  const phone=drivePhone.snapshot(),pg=phone.gps;
  // The course: the phone's, else the one the location reports, else the one worked out from movement (drive/guide.js).
  const course=pg?pg.hdg:Number.isFinite(reading.heading)?reading.heading:reading.status==='live'&&reading.speed>=7.2&&driveGuide?driveGuide.course():null;   // 7.2 km/h is the feed's own 2 m/s: slower than that there is no course
  if($('driveHeading'))$('driveHeading').textContent=driveGuide&&$('driveTape')?.style?'':Number.isFinite(course)?['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(course/22.5)%16]:'';
  let guide=null;
  const nav=phone.nav,words={NO_TURN:'Straight on',GO_STRAIGHT:'Straight on',TURN_RIGHT:'Turn right',TURN_LEFT:'Turn left',TURN_SLIGHT_RIGHT:'Bear right',TURN_SLIGHT_LEFT:'Bear left',TURN_SHARP_RIGHT:'Sharp right',TURN_SHARP_LEFT:'Sharp left',U_TURN_LEFT:'U-turn',U_TURN_RIGHT:'U-turn',ENTER_ROUND_ABOUT:'Roundabout',LEAVE_ROUND_ABOUT:'Leave roundabout',STAY_ON_ROUND_ABOUT:'Roundabout',START_AT_THE_END_OF_STREET:'To the end of the street',REACHED_YOUR_DESTINATION:'Destination',EXIT_HIGHWAY_TO_RIGHT:'Exit right',EXIT_HIGHWAY_TO_LEFT:'Exit left'};
  if($('driveTurn')){
    const route=nav&&['OnRoute','OffRoute','RouteRebuilding','RouteNeedsRebuild','RouteNotStarted'].includes(nav.ss);
    $('driveTurn').textContent=route?[nav.sim?'Preview':null,({OffRoute:'Off route',RouteRebuilding:'Rerouting',RouteNeedsRebuild:'Rerouting',RouteNotStarted:'Route ready'})[nav.ss],nav.toTurn,words[nav.turn],nav.next||nav.street].filter(Boolean).join(' · '):'';
    // No directions from a phone: the next turn along the route the PC saved, if the glasses are on it (drive/guide.js).
    driveGuide?.setRoute(S.snap&&S.snap.rt);
    // Only beside a live reading. Without one the last turn must not sit there: it says paused, or nothing once GPS is off.
    const seen=!route&&driveGuide?driveGuide.snapshot():null;
    guide=seen?DriveGuide.words(reading.status==='live'||seen.state==='none'?seen:{state:driveFeed.enabled?'paused':'none'}):null;
    if(guide?.turn){
      const line=$('driveTurn');line.textContent=guide.turn;
      if(guide.dist&&line.replaceChildren){   // the distance is the part that changes: it gets its own weight, larger when the turn is close
        const dist=document.createElement('span');dist.className=guide.near?'dist near':'dist';dist.textContent=guide.dist;
        line.replaceChildren(dist,guide.turn.slice(guide.dist.length));
      }
    }
    $('driveTurn').dataset.level=guide?.turn?guide.level:'ok';
    $('driveTurn').hidden=!$('driveTurn').textContent;
  }
  paintDriveTape(course);
  if(reading.status==='live'&&!pg)driveRemember(true); else if(reading.status==='denied'&&!driveHeld())driveRemember(null);
  const live=Boolean(pg)||reading.status==='live';
  $('driveSpeed').textContent=pg?String(pg.kmh):reading.status==='live'?String(Math.round(reading.speed)):'—';
  // Self-check (drive/speed-check.js): with no speed on screen, a definite fault and nothing healthy behind it is said
  // in plain words and shown amber. Calm states keep the words below; a missing module leaves the old wording alone.
  const check=driveCheck?driveCheck.check({phoneFresh:Boolean(pg),gpsStatus:reading.status,link:driveCheck.fromStudio(phone)}):null;
  const phoneFault=!live&&phone.configured&&phone.enabled&&['stale','offline','unavailable'].includes(phone.state);
  $('driveState').textContent=pg?'Phone link · GPS estimate':reading.status==='live'?'App location · GPS estimate':
    check?.text||(phone.configured&&phone.enabled?(DRIVE_PHONE_LABELS[phone.state]||'Phone speed unavailable'):
    (DRIVE_STATUS_LABELS[reading.status]||'Speed unavailable'));
  $('driveHud').dataset.level=check?.level==='warn'||phoneFault?'warn':'ok';
  // A fixed camera on the road ahead takes the top line while the glasses' own reading is live: what it is and how far.
  const camera=driveCams&&reading.status==='live'&&!pg?DriveCameras.words(driveCams.snapshot(),reading.speed):null;
  if(camera)$('driveState').textContent=camera.text;
  $('driveHud').dataset.camera=camera?(camera.over?'over':'ahead'):'none';
  const age=pg?phone.ageMs:reading.ageMs;
  // An old camera list says so here, in amber, until a fresh one is published: a quiet screen must not look like a clear road.
  // The fix's own age stays; the list's trouble is added after it.
  const oldList=!guide?.note&&live?driveCamsNote():'';
  $('driveAge').textContent=guide?.note||(live?(age<1000?'Just now':Math.floor(age/1000)+' s ago')+(oldList?' · '+oldList:''):'');
  $('driveAge').dataset.level=oldList?'warn':'ok';
  $('driveHud').dataset.status=live?'live':reading.status;
  $('driveGps').textContent=driveFeed.enabled?'Stop app GPS':'Start app GPS';
  $('driveGps').disabled=reading.status==='unsupported';
  const retry=$('driveRetry');
  const canRetry=driveFeed.enabled&&['timeout','no-response','disconnected','stale','invalid','inaccurate'].includes(reading.status);
  retry.hidden=!canRetry&&document.activeElement!==retry;
  const permission=driveFeed.details().permission;
  HomeShell.setLocationPending(driveFeed.enabled&&['waiting','no-response'].includes(reading.status)&&permission!=='granted');
  if(!$('driveInfo').hidden)paintDriveDetails();
}
function toggleDriveGps() {
  if(HomeShell.driveQuiet()||S.tab!=='drive'||document.hidden)return;
  driveStopped=driveFeed.enabled;
  if(driveFeed.enabled){driveRemember(false);driveFeed.stop();} else driveFeed.enable();
}
function retryDriveGps() {
  if(HomeShell.driveQuiet()||S.tab!=='drive'||document.hidden||$('driveRetry').hidden)return;
  driveFeed.enable(); // Replaces one watch, only on this deliberate press.
}
function paintDriveDetails() {
  const f=driveFeed.details(),last=f.lastFix,error=f.lastError,status=f.status,phone=drivePhone.snapshot();
  if($('drivePhoneState')){
  $('drivePhoneState').textContent=DRIVE_PHONE_LABELS[phone.state]||'Phone link unavailable';
  $('drivePhoneCode').textContent=phone.configured&&['pairing','waiting','ready','connecting'].includes(phone.state)?'Pairing code: '+phone.code:'';
  $('drivePhoneToggle').textContent=phone.enabled?'Stop phone link':'Resume phone link';
  $('drivePhoneToggle').disabled=!phone.configured;
  $('drivePhoneUse').hidden=$('drivePhoneKeep').hidden=!phone.offer;
  }
  // Details can stay open indefinitely: use acquisition time rather than an age
  // that would freeze when the expired feed stops its refresh timer.
  const fixTime=last?.at==null?'time unknown':new Date(last.at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const fix=last?fixTime+' · accuracy '+(last.accuracy==null?'unknown':Math.round(last.accuracy)+' m')+' · speed '+(last.speedPresent?'reported':'absent'):'none';
  const errorName=error?({1:'Denied',2:'Unavailable',3:'Timeout'}[error.code]||'Unknown'):'none';
  const errorTime=error?' '+new Date(error.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'';
  let policy='unknown';
  try {const p=document.permissionsPolicy||document.featurePolicy;if(p?.allowsFeature)policy=p.allowsFeature('geolocation')?'allowed':'blocked';}catch(_){}
  $('driveFacts').textContent=[
    'Drive 29 · '+(f.watchActive?'watch active':'watch stopped')+' · '+(f.visible?'page visible':'page hidden'),
    'Now: '+(status==='live'?'Phone GPS speed received':DRIVE_STATUS_LABELS[status]||'Speed unavailable'),
    'Fix callbacks this page: '+f.fixes+' · starts: '+f.attempts,
    'Last fix: '+fix,
    driveCams?(driveCamsFailed&&!driveCams.count?'Cameras: the list could not be loaded':driveCams.about()):'Cameras: not available',
    'Last API error: '+errorName+errorTime+(error?' (#'+error.attempt+')':''),
    'Web permission: '+f.permission+' · policy: '+policy,
    'Secure page: '+(window.isSecureContext===true?'yes':window.isSecureContext===false?'no':'unknown')
  ].join('\n');
  const help={
    off:'This page has not started a location request. It does not read Android’s GPS switch. Start app GPS here, or use the paired Journal phone link.',
    denied:'Open the glasses’ Web App menu → Permissions. Check this app’s location access, then return and press Start GPS.',
    timeout:'No fix within 10 seconds. The watch is still listening. Retry starts a new request.',
    'no-response':'The location provider has not called back. Check for an outstanding app permission prompt. Retry replaces the request.',
    unavailable:'A position arrived without speed. Nothing is converted to zero.',
    inaccurate:'The returned position exceeds this app’s 50 m accuracy filter.',
    stale:'The last usable speed expired after five seconds.',
    disconnected:'The location provider could not supply a fix. This does not establish that the phone is disconnected.',
    unsupported:'This runtime has not supplied the geolocation API.'
  };
  $('driveHelp').textContent=help[status]||'“Now” is current. The last API error may be from an earlier request. No coordinates or raw error text are saved or sent.';
}
function syncDriveFeed() {
  const visible=S.tab==='drive'&&S.view==='list'&&!$('drive').hidden&&!document.hidden;
  driveFeed.setVisible(visible);drivePhone.setVisible(visible);
  // Opening Drive starts the speed by itself when location is already allowed (Bakar, 11 Nov 2026: no unnecessary
  // presses). This is the feed's own resume path: it asks the browser first and goes on only with an existing grant, so
  // no permission prompt can appear from just looking at Drive. A deliberate Stop holds until the next Start.
  // Where the glasses cannot report the permission at all, a Start that worked before is remembered and simply made again:
  // at worst that is one system prompt the wearer has already answered.
  if(visible)loadDriveCameras();
  if(visible&&!driveFeed.enabled&&!driveStopped&&!driveHeld()){
    if(driveRemembered())driveFeed.enable(); else {driveFeed.enabled=true;driveFeed.start();}
  }
}
let driveStopped=false;
const DRIVE_REMEMBER='bakar.drive.gps';
function driveRemembered(){try{return localStorage.getItem(DRIVE_REMEMBER)==='1';}catch(_){return false;}}
// '1' a Start that worked; '0' a deliberate Stop, which holds through a relaunch until the next Start; nothing after a denial.
function driveHeld(){try{return localStorage.getItem(DRIVE_REMEMBER)==='0';}catch(_){return false;}}
function driveRemember(on){try{if(on===null)localStorage.removeItem(DRIVE_REMEMBER);else localStorage.setItem(DRIVE_REMEMBER,on?'1':'0');}catch(_){}}
document.addEventListener('visibilitychange',syncDriveFeed);
window.addEventListener('pagehide',()=>{driveFeed.setVisible(false);drivePhone.setVisible(false);});
window.addEventListener('pageshow',syncDriveFeed);
// Light: the display adds to whatever is behind it, so a bright sky needs solid, simple shapes and a dark road needs
// far less light. Auto follows the sun at Toronto's latitude; pressing the button picks one by hand and it's remembered.
const DRIVE_LIGHTS = ['auto', 'day', 'dusk', 'night'];

function sunLight(when = new Date()) {
  const day = (when - new Date(when.getFullYear(), 0, 0)) / 86400000;
  const tilt = -23.44 * Math.cos(2 * Math.PI * (day + 10) / 365) * Math.PI / 180;
  const lat = 43.7 * Math.PI / 180;
  const halfDay = Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(tilt)))) * 12 / Math.PI;
  const zone = -when.getTimezoneOffset() / 60;
  const noon = 12 + zone + 79.4 / 15;            // Toronto's longitude
  const hour = when.getHours() + when.getMinutes() / 60;
  const fromNoon = Math.abs(hour - noon);
  if (fromNoon < halfDay - 0.75) return 'day';
  return fromNoon < halfDay + 0.75 ? 'dusk' : 'night';
}

function applyDriveLight() {
  let pick = 'auto';
  try { pick = localStorage.getItem('driveLight') || 'auto'; } catch (e) { /* private window: stay on Auto */ }
  $('driveHud').dataset.light = $('drive').dataset.light = pick === 'auto' ? sunLight() : pick;
  $('driveLight').textContent = `Light: ${pick[0].toUpperCase()}${pick.slice(1)}`;
}

function nextDriveLight() {
  let pick = 'auto';
  try { pick = localStorage.getItem('driveLight') || 'auto'; } catch (e) { /* stays on Auto */ }
  const next = DRIVE_LIGHTS[(DRIVE_LIGHTS.indexOf(pick) + 1) % DRIVE_LIGHTS.length];
  try { localStorage.setItem('driveLight', next); } catch (e) { /* forgotten next launch, which is fine */ }
  applyDriveLight();
}

function renderWatch() {
  const list = $('watchRows');
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.v : '';
  list.textContent = '';
  const found = S.ytFound;
  const shared = (S.snap && S.snap.yt) || [];
  const items = found || [...STUDIO_WATCH_LIBRARY,...shared];
  const line = $('watchLine');
  line.hidden = false;
  line.textContent = found ? found.length+' PC results. Back returns to the list.' : STUDIO_WATCH_LIBRARY.length+' studio lessons. Provider videos open on your phone.';
  items.forEach((v) => {
    const li = el('li');
    const started = v.pos > 5;
    const left = v.len ? Math.max(0, v.len - v.pos) : 0;
    const b = el('button', `row ${started ? 'work' : 'done'}`);
    b.dataset.v = v.id;
    const status = v.curated ? (v.provider==='vimeo'?'Vimeo · Phone':'YouTube · Phone') : started ? (left ? `${Math.max(1, Math.round(left / 60))} min left` : `at ${clockTime(v.pos)}`) : (v.src === 'feed' ? 'New' : 'Saved');
    b.append(el('span', `mark ${started ? 'work' : 'done'}`), el('span', 'ti', v.ti || 'YouTube video'), el('span', 'tag', status),
      el('span', 'why', [v.ch,v.curated&&v.why].filter(Boolean).join(' · ')), el('span', 'age', ''));
    b.setAttribute('aria-label', `${v.ti || 'YouTube video'}. ${v.ch || ''}. ${status}`);
    b.addEventListener('click', () => { if(v.curated){handoffWatch({kind:'video',provider:v.provider,videoId:v.videoId},$('watchPhoneNote'));return;} if (found) send('ytadd', { u: `https://youtu.be/${v.id}` }); openPlayer(v); });
    li.append(b);
    list.append(li);
  });
  if (focused) {
    const again = list.querySelector(`[data-v="${CSS.escape(focused)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

let YT_READY = null;
function loadYouTube() {
  if (!YT_READY) {
    YT_READY = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { YT_READY = null; reject(new Error('YouTube could not load')); };
      document.head.append(s);
    });
  }
  return YT_READY;
}

const SPEEDS = [1, 1.25, 1.5, 2];

async function openPlayer(v) {
  S.video = v;
  S.view = 'play';
  history.pushState({ v: 'play', id: v.id }, '');
  showPane('play');
  $('pvTitle').textContent = v.ti || 'YouTube video';
  $('pvTime').textContent = v.ch || '';
  $('pvNote').textContent = 'Loading…';
  $('pvPlay').focus();
  armIdle();
  try {
    const YT = await loadYouTube();
    if (S.view !== 'play' || S.video !== v) return;
    const start = v.len && v.pos > v.len - 15 ? 0 : Math.floor(v.pos || 0);
    if (S.player && S.player.loadVideoById) {
      S.player.loadVideoById({ videoId: v.id, startSeconds: start });
    } else {
      S.player = new YT.Player('ytPlayer', {
        width: 600, height: 338, videoId: v.id,
        playerVars: { autoplay: 1, start, playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: (e) => { e.target.setPlaybackRate(SPEEDS[S.speedAt || 0]); e.target.playVideo(); },
          onStateChange: playerState,
          onError: () => { $('pvNote').textContent = 'YouTube won’t play this one on the glasses (the owner may block embedding).'; },
        },
      });
      const frame = $('ytWrap').querySelector('iframe');
      if (frame) frame.tabIndex = -1;   // the arrows stay with this page's controls
    }
    $('pvNote').textContent = 'Enter pauses · ← → choose · ↑ ↓ jump 10 s · Back keeps your place';
  } catch (e) {
    $('pvNote').textContent = 'YouTube didn’t load. Check the glasses’ connection and try again.';
  }
}

function playerState(e) {
  const playing = e.data === 1;
  $('pvPlay').textContent = playing ? 'Pause' : 'Play';
  clearInterval(S.pvTick);
  if (playing) S.pvTick = setInterval(tickPlayer, 1000);
  tickPlayer();
  if (e.data === 2) savePosition();          // paused
  if (e.data === 0) savePosition(true);      // ended
}

function tickPlayer() {
  const p = S.player;
  if (!p || !p.getCurrentTime) return;
  const t = p.getCurrentTime() || 0;
  const len = p.getDuration() || 0;
  $('pvTime').textContent = `${clockTime(t)} / ${clockTime(len)}${S.video && S.video.ch ? ` · ${S.video.ch}` : ''}`;
  $('pvBar').style.transform = `scaleX(${len ? Math.min(1, t / len) : 0})`;
  if (Date.now() - (S.savedAt || 0) > 30000) savePosition();
  armIdle();   // watching counts as using the page
}

function savePosition(done) {
  const p = S.player;
  if (!p || !p.getCurrentTime || !S.video) return;
  S.savedAt = Date.now();
  const t = p.getCurrentTime() || 0;
  const len = p.getDuration() || 0;
  S.video.pos = t;
  S.video.len = len;
  send('ytpos', { v: S.video.id, t: Math.floor(t), l: Math.floor(len), d: done ? 1 : 0 });
}

function closePlayer() {
  clearInterval(S.pvTick);
  if (S.player && S.player.pauseVideo) { savePosition(); S.player.pauseVideo(); }
}

function rowFor(k) {
  return ((S.snap && S.snap.rows) || []).find((r) => r.k === k) || null;
}

function renderDetail() {
  const k = S.open;
  const d = S.details[k] || rowFor(k);
  if (!d) { $('dTitle').textContent = 'This session is no longer listed'; return; }
  const focused = document.activeElement;
  const focusId = focused && focused.dataset ? focused.dataset.f : '';
  $('dTitle').textContent = d.ti;
  const meta = $('dMeta');
  meta.textContent = '';
  meta.append(`${d.own ? 'Glasses task · ' : ''}${PROVIDER[d.p]} · ${d.pr || ''} · `);
  meta.append(el('span', d.st, STATUS[d.st]));
  if (d.step) meta.append(` · Step ${d.step.n} of ${d.step.of}`);
  const nowParts = [];
  if (d.step && d.step.c && d.st === 'work') nowParts.push(d.step.c);
  if (d.now && d.st === 'work') nowParts.push(d.now);
  $('dNow').textContent = nowParts.join(' — ');
  $('dAsked').textContent = d.asked ? `You said: “${d.asked}”` : '';

  const acts = d.acts || [];
  const q = d.q;
  const box = $('dQuestion');
  box.hidden = !q;
  const opts = $('dOptions');
  opts.textContent = '';
  $('dQNote').textContent = '';
  if (q) {
    $('dQText').textContent = q.text + (q.more ? ` (+${q.more} more)` : '');
    if (!q.safe) {
      $('dQNote').textContent = 'This needs your own yes at your PC. The glasses can’t approve it.';
    } else if (acts.includes('answer')) {
      const choices = (q.opts || []).concat(HELP_OPTIONS);
      choices.forEach((label, i) => {
        const b = el('button', 'btn opt' + (i >= (q.opts || []).length ? ' help' : ''), label);
        b.dataset.f = 'opt' + i;
        b.addEventListener('click', () => startCompose({ mode: 'answer', k, text: label }));
        opts.append(b);
      });
      const written=el('button','btn primary','Write an answer');written.dataset.f='write-answer';
      written.addEventListener('click',()=>startCompose({mode:'answertext',k}));opts.append(written);
    } else {
      // Its choices are shown so he can decide now, then answer where the session lives.
      const choices = (q.opts || []).length ? `Choices: ${q.opts.join(' · ')}. ` : '';
      $('dQNote').textContent = choices + (d.p === 'x'
        ? 'Answer this in Codex on your PC.'
        : 'Answer this at your PC, or in the Claude app on your phone.');
    }
  }
  const res = $('dResult');
  res.textContent = S.details[k] ? (d.res || (d.st === 'work' ? 'Nothing to report yet.' : 'No message yet.')) : 'Loading…';
  requestAnimationFrame(updateGauge);

  const actions = $('dActions');
  actions.textContent = '';
  if (acts.includes('say')) {
    const b = el('button', 'btn primary', d.p === 'x' ? 'Reply to Codex' : 'Reply to Claude');
    b.dataset.f = 'say';
    b.addEventListener('click', () => startCompose({ mode: 'say', k }));
    actions.append(b);
  }
  if (acts.includes('stop') && d.st === 'work') {
    const b = el('button', 'btn', 'Stop this task');
    b.dataset.f = 'stop';
    b.addEventListener('click', () => startCompose({ mode: 'stop', k }));
    actions.append(b);
  }
  if ('speechSynthesis' in window && S.details[k]) {
    const b = el('button', 'btn', S.speaking === k ? 'Stop reading' : 'Read aloud');
    b.dataset.f = 'read';
    b.addEventListener('click', () => readAloud(k));
    actions.append(b);
  }
  if (focusId) {
    const again = document.querySelector(`[data-f="${focusId}"]`);
    if (again) again.focus({ preventScroll: true });
  } else if (S.lastKeyAt < S.openedAt && document.activeElement === $('dResult')) {
    // The question arrived after the screen opened and Bakar hasn't moved yet: start on its first answer.
    const first = $('dOptions').querySelector('button');
    if (first) first.focus();
  }
}

// The hairline gauge beside a long result: where you are in it. Shown only when there is more to read.
function updateGauge() {
  const r = $('dResult');
  const wrap = r.parentElement;
  const max = r.scrollHeight - r.clientHeight;
  const scrolls = max > 4;
  wrap.classList.toggle('scrolls', scrolls);
  r.classList.toggle('above', scrolls && r.scrollTop > 2);
  r.classList.toggle('below', scrolls && r.scrollTop < max - 2);
  if (!scrolls) return;
  const track = wrap.clientHeight - 16;
  const thumb = Math.max(24, (track * r.clientHeight) / r.scrollHeight);
  const t = $('rThumb');
  t.style.blockSize = `${thumb}px`;
  t.style.transform = `translateY(${((track - thumb) * r.scrollTop) / max}px)`;
}

// Read aloud through the glasses' speaker, on request only: the title, its state, the question, then the result.
function readAloud(k) {
  const synth = window.speechSynthesis;
  if (S.speaking === k) { stopReading(); renderDetail(); return; }
  const d = S.details[k];
  if (!d) return;
  synth.cancel();
  const parts = [`${d.ti}.`, `${PROVIDER[d.p]}, ${STATUS[d.st].toLowerCase()}.`];
  if (d.q) parts.push(`Question: ${d.q.text}`);
  if (d.res) parts.push(d.res.replace(/•/g, '').slice(0, 1200));
  const u = new SpeechSynthesisUtterance(parts.join(' '));
  const done = () => {
    clearInterval(S.speakCheck);
    if (S.speaking !== k) return;
    S.speaking = '';
    if (S.view === 'detail' && S.open === k) renderDetail();
  };
  u.onend = done;
  u.onerror = done;
  S.speaking = k;
  synth.speak(u);
  renderDetail();
  // In case the end of speech is never reported, look once a second while reading (and only then).
  clearInterval(S.speakCheck);
  S.speakCheck = setInterval(() => { if (!synth.speaking && !synth.pending) done(); }, 1000);
}

function stopReading() {
  clearInterval(S.speakCheck);
  if (S.speaking && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  S.speaking = '';
}

function appRow(app) {
  const b = el('button', 'row app');
  b.dataset.appUrl = app.url;
  const icon = el('span', 'icon');
  if (app.icon && !GLYPHS[app.icon]) icon.dataset.src = SITE + app.icon;
  icon.style.setProperty('--icon', `url("${iconSrc(app)}")`);
  b.append(icon, el('span', 'ti', app.name), el('span', 'why', app.why || ''));
  b.addEventListener('click', () => launch(app));
  return b;
}

async function loadApps() {
  try {
    const r = await fetch('apps.json', { cache: 'no-cache' });
    const list = await r.json();
    const ok = (a) => a && typeof a.name === 'string' && /^https:\/\//.test(a.url || '');
    if (Array.isArray(list.apps)) APPS = list.apps.filter(ok);
    if (Array.isArray(list.games)) GAMES = list.games.filter(ok);
  } catch (e) { /* the built-in list stays */ }
  renderApps();
  keepIcons();
}

function renderApps() {
  const list = $('appRows');
  const focusedUrl = document.activeElement?.dataset.appUrl;
  list.textContent = '';
  let group = '';
  for (const app of APPS) {
    if (app.group !== group) { group = app.group; list.append(el('li', 'group', group)); }
    const li = el('li');
    li.append(appRow(app));
    list.append(li);
  }
  const games = $('gameRows');
  games.textContent = '';
  for (const game of GAMES) {
    const li = el('li');
    li.append(appRow(game));
    games.append(li);
  }
  if (focusedUrl) focusApp(focusedUrl);
  $('gamesNote').textContent = GAMES.length
    ? 'Games stay here, away from Work and Apps.'
    : 'No web games added yet. Games you add will appear here, away from Work and Apps. Meta’s own games stay in the glasses’ main app list.';
}

// App icons are kept here as data: addresses, so a section paints with its icons on its first frame; an icon fetched
// from the site arrives a few frames after its section has slid in. Refreshed in place at most once a day.
const ICONS_KEY = 'glass-home.icons';
const iconsKept = local(ICONS_KEY) || {};
let iconData = iconsKept.data || {};

function iconSrc(app) {
  if (GLYPHS[app.icon]) return GLYPHS[app.icon];
  if (!app.icon) return GLYPHS.app;
  return iconData[SITE + app.icon] || SITE + app.icon;
}

async function keepIcons() {
  const wanted = [...new Set(APPS.concat(GAMES).filter((a) => a.icon && !GLYPHS[a.icon]).map((a) => SITE + a.icon))];
  if (Date.now() - (iconsKept.at || 0) < 86400000 && wanted.every((url) => iconData[url])) return;
  const kept = {};
  for (const url of wanted) {
    kept[url] = iconData[url];
    try {
      const r = await fetch(url);
      const svg = r.ok ? await r.text() : '';
      if (svg.length < 20000 && /<svg[\s>]/i.test(svg)) kept[url] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } catch (e) { /* keep what we had */ }
  }
  for (const url of Object.keys(kept)) if (!kept[url]) delete kept[url];
  local(ICONS_KEY, { at: Date.now(), data: kept });
  if (JSON.stringify(kept) === JSON.stringify(iconData)) return;
  iconData = kept;
  for (const icon of document.querySelectorAll('.row.app .icon[data-src]')) {
    if (iconData[icon.dataset.src]) icon.style.setProperty('--icon', `url("${iconData[icon.dataset.src]}")`);
  }
}

function focusApp(url) {
  const button = [...document.querySelectorAll('.row.app')].find(b => b.dataset.appUrl === url && !b.closest('[hidden]'));
  if (button) button.focus();
  return Boolean(button);
}

function launch(app) {
  const url = new URL(app.url);
  // Only these exact app addresses may receive a pairing. Never forward it to another catalog entry.
  const destinations = {
    'studio-glass/': 'sg', 'tidal-glass/': 'tg', 'tidal-glass/sound/': 'tg',
    'battery-glass/': 'tg', 'glass-home/drive/': 'drive',
  };
  const pairing = destinations[url.pathname.slice(1)];
  if (url.origin === new URL(SITE).origin && pairing && app.pass === pairing) {
    const data = pairing === 'drive' ? drivePhone.link?.addr : passPairing(pairing);
    if (data) {
      const fragment = pairing === 'drive' ? { t: data.t, p: data.p }
        : pairing === 'tg' ? { androidBridge: data.t + '~' + data.k } : { t: data.t, k: data.k };
      url.hash = new URLSearchParams(fragment).toString();
    }
  }
  // The public catalog address identifies the focus row. Keep pairing data out of history state.
  history.replaceState({ v: 'list', tab: S.tab, appUrl: app.url }, '');
  location.assign(url.href);
}

// ---- pairing ---------------------------------------------------------------------------------------

function showPairing(code) {
  S.pairing = code || '…';
  $('pTitle').textContent = 'Pair these glasses';
  $('pText').textContent = 'At your PC, ask Claude to open Glass Home pairing, then press Try again. The PC shows this code when it pairs.';
  $('pCode').textContent = code || '';
  $('pRetry').hidden = false;
  showPane('pair');
  $('pRetry').focus();
}

function closePairing() {
  if (!S.pairing) return;
  S.pairing = null;
  if (S.view === 'list') showPane(S.tab);
}

// ---- screens and history ---------------------------------------------------------------------------

const PANES = ['review', 'now', 'work', 'detail', 'compose', 'watch', 'route', 'drive', 'play', 'apps', 'games', 'pair'];
const MOTION = !window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEPTH = { review: 0, now: 0, work: 0, watch: 0, route: 0, drive: 0, apps: 0, games: 0, pair: 0, detail: 1, play: 1, compose: 2 };
const TABS = ['review', 'now', 'work', 'watch', 'route', 'drive', 'apps', 'games'];
// Sections that show the pairing screen instead while these glasses aren't paired: both need the PC.
const NEEDS_PC = ['now', 'work'];

function showPane(id) {
  const before = PANES.find((p) => !$(p).hidden);
  for (const p of PANES) $(p).hidden = p !== id;
  clearTimeout(S.renderStatusTimer);
  syncDriveFeed(); if (id === 'drive') applyDriveLight();
  if (id === 'now') renderNow();
  if (!CALM_PANES.includes(id)) wakeUp();
  const listView = ['now', 'work', 'watch', 'route', 'drive', 'apps', 'games', 'pair'].includes(id);
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === S.tab));
    t.tabIndex = listView ? 0 : -1;
  }
  placeTabline();
  // Continuity: deeper screens come in from the right and go back to the left; sections slide the way you swiped.
  if (id !== 'drive' && before !== 'drive' && MOTION && before && before !== id && $(id).animate) {
    let dir = Math.sign(DEPTH[id] - DEPTH[before]);
    if (!dir) dir = S.slide || Math.sign(TABS.indexOf(id) - TABS.indexOf(before)) || 1;
    // Mostly a slide: opacity starts at 0.92 (about 83% of the light), because a dark first frame between screens
    // reads as a blink on a see-through display.
    $(id).animate([{ opacity: 0.92, transform: `translateX(${dir * 22}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }
  S.slide = 0;
  HomeShell.onPane(id, before);
}

// The section underline glides to the selected section (transform only).
function placeTabline() {
  const t = document.querySelector(`.tab[data-tab="${S.tab}"]`);
  const line = $('tabline');
  if (!t || !line) return;
  line.style.transform = `translateX(${t.offsetLeft + 12}px) scaleX(${Math.max(1, t.offsetWidth - 24)})`;
}

// At the end of a list a further press nudges the focus that way and springs it back past rest, so the end is felt
// rather than silent. Added to the control's own transform, so a lifted row keeps its lift.
function rubberBand(dy, dx) {
  if (!MOTION) return;
  const a = focusedControl();
  const target = a && a !== document.body && a.animate ? a : $(PANES.find((p) => !$(p).hidden));
  if (!target || !target.animate) return;
  target.animate([
    { transform: 'translate(0, 0)', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    { transform: `translate(${dx * 6}px, ${dy * 6}px)`, offset: 0.28, easing: 'cubic-bezier(0.34, 1.45, 0.64, 1)' },
    { transform: 'translate(0, 0)' },
  ], { duration: 300, composite: 'add' });
}

// A press: a short sink and a brighter rim, settled within 100 ms; the control's spring brings it back.
function press(target) {
  if (!target || !target.matches || !target.matches('button')) return;
  target.classList.add('pressing');
  setTimeout(() => target.classList.remove('pressing'), 90);
}

function focusFirst(pane) {
  if (pane === 'drive' && HomeShell.driveQuiet()) { $('driveReveal').focus(); return; }
  if (pane === 'review') { HomeShell.focusReview(); return; }
  // On Work, start on the top session (needs-you sessions sort first); New task is one press up.
  const first = (pane === 'work' && $('rows').querySelector('.row[data-k]'))
    || (pane === 'now' && $('nowRows').querySelector('.row'))
    || $(pane).querySelector('button:not([hidden]), [tabindex="0"]');
  (first || document.querySelector(`.tab[data-tab="${S.tab}"]`)).focus();
}

function selectTab(tab, focusTab) {
  if (S.tab==='watch' && tab !== 'watch') cancelWatch();
  if (S.view !== 'list') return; // Native Back preserves the current draft and bounds shared history.
  if (!HomeShell.canEnterRoute(tab, focusTab) || !HomeShell.canLeaveReview(tab)) return;
  S.tab = tab;
  S.view = 'list';
  history.replaceState({ v: 'list', tab }, '');
  if (S.pairing && NEEDS_PC.includes(tab)) showPane('pair');
  else showPane(tab);
  if (tab === 'review') HomeShell.focusReview();
  else if (focusTab) document.querySelector(`.tab[data-tab="${tab}"]`).focus();
  else focusFirst(NEEDS_PC.includes(tab) && S.pairing ? 'pair' : tab);
}

function openDetail(k) {
  S.open = k;
  S.view = 'detail';
  S.openedAt = Date.now();
  history.pushState({ v: 'detail', k }, '');
  showPane('detail');
  renderDetail();
  $('dResult').scrollTop = 0;
  const first = $('dOptions').querySelector('button') || $('dResult');
  first.focus();
  // Ask the PC only when what's here is more than a minute old; each request costs two messages.
  const d = S.details[k];
  if (!d || Date.now() - d.at > 60000) send('det', { k });
  armIdle();
}

function apply(state) {
  if(S.view==='compose')saveCompose();
  cancelWatch();
  closeConfirm();
  if (!state || state.v === 'list') {
    stopReading();
    if (S.view === 'play') {
      // Leaving a video: pause it, keep the place, and land back on its row.
      const v = S.video;
      closePlayer();
      S.view = 'list';
      showPane(S.tab);
      renderWatch();
      const vrow = v && $('watchRows').querySelector(`[data-v="${CSS.escape(v.id)}"]`);
      if (vrow) vrow.focus(); else focusFirst(S.tab);
      return;
    }
    const backTo = S.open;
    if (S.ytFound && S.view === 'list') { S.ytFound = null; renderWatch(); }
    S.view = 'list';
    S.open = '';
    showPane(S.pairing && NEEDS_PC.includes(S.tab) ? 'pair' : S.tab);
    const row = backTo && $('rows').querySelector(`[data-k="${CSS.escape(backTo)}"]`);
    if (row) row.focus(); else focusFirst(S.tab);
  } else if (state.v === 'detail') {
    S.view = 'detail';
    S.open = state.k;
    showPane('detail');
    renderDetail();
    ($('dActions').querySelector('button') || $('dOptions').querySelector('button') || $('dResult')).focus();
  } else if (state.v === 'play') {
    // Back from a video is the list; Forward never reopens the player.
    history.back();
  } else if (state.v === 'compose') {
    if(!S.compose){const saved=(local('gh.composeDrafts')||{})[state.draft];if(saved)startCompose(saved,false);else {history.back();return;}}
    S.view='compose';showPane('compose');closeConfirm();$('cText').readOnly=!!S.compose?.request&&['sending','uncertain'].includes(S.compose.request.status);$('cSend').focus();
  } else if(state.v==='confirm') {
    if(!S.compose){const saved=(local('gh.composeDrafts')||{})[state.draft];if(saved)startCompose(saved,false);else {history.back();return;}}
    S.view='compose';showPane('compose');paintConfirmation(S.compose,false);
  }
}

// ---- writing: new task, reply, answer, stop --------------------------------------------------------

function composeKey(c) { return `${c.mode}:${c.k || 'new'}`; }
function saveCompose(c = S.compose, durable = false) {
  if (!c || !['new','say','answertext','answer','stop'].includes(c.mode)) return false;
  if(c.request?.status==='accepted')return true;
  const drafts = local('gh.composeDrafts') || {};
  if(S.compose===c)c.text=$('cText').value;
  drafts[composeKey(c)] = {mode:c.mode,k:c.k||'',text:c.text||c.final||'',provider:c.provider,project:c.project,
    final:c.final||'',question:c.question||'',request:c.request||null,at:Date.now()};
  if(!durable){local('gh.composeDrafts',drafts);return true;}
  try{
    localStorage.setItem('gh.composeDrafts',JSON.stringify(drafts));
    const saved=JSON.parse(localStorage.getItem('gh.composeDrafts')||'null')?.[composeKey(c)];
    return !!saved&&saved.request?.id===c.request?.id&&JSON.stringify(saved.request?.payload)===JSON.stringify(c.request?.payload)&&saved.request?.summary===c.request?.summary&&saved.question===(c.question||'')&&saved.final===(c.final||'');
  }catch(_){return false;}
}
function clearComposeDraft(c) {
  const drafts=local('gh.composeDrafts')||{},key=composeKey(c),saved=drafts[key],sent=c.request?.payload?.text??c.final;
  if(saved&&saved.text!==sent){saved.request=null;saved.final='';}else delete drafts[key];
  local('gh.composeDrafts',drafts);
}
function startCompose(c, record = true) {
  const saved=(local('gh.composeDrafts')||{})[composeKey(c)];
  if(saved?.request?.status==='sending')saved.request={...saved.request,status:'uncertain'};
  if(saved?.request&&['sending','uncertain'].includes(saved.request.status))c={...c,...saved};
  else if(saved && ['new','say','answertext'].includes(c.mode))c={...saved,...c,text:c.text??saved.text};
  S.compose = Object.assign({ provider: '', project: '' }, c);
  S.view = 'compose';
  if(record)history.pushState({ v: 'compose', draft:composeKey(c) }, '');
  showPane('compose');
  closeConfirm();
  $('cNote').textContent = '';
  const can = (S.snap && S.snap.can) || {};
  const pick = $('cPick');
  pick.textContent = '';
  const text = $('cText');
  text.value = c.text || '';
  text.readOnly=!!S.compose.request&&['sending','uncertain'].includes(S.compose.request.status);
  const field = text.closest('.field');
  field.hidden = c.mode === 'stop' || c.mode === 'answer';
  $('cSend').textContent = 'Review';
  const d = S.details[c.k] || rowFor(c.k) || {};
  if(S.compose.request&&['sending','uncertain','accepted'].includes(S.compose.request.status)){
    $('cTitle').textContent=c.mode==='new'?'New task':c.mode==='stop'?'Stop this task?':c.mode==='say'?'Reply':'Answer';
    S.compose.final=c.final||c.text||'';paintConfirmation(S.compose,false);return;
  }
  if (c.mode === 'new') {
    $('cTitle').textContent = 'New task';
    $('cLabel').textContent = 'Say what you want done';
    const providers = can.new || [];
    S.compose.provider = providers.includes(c.provider) ? c.provider : providers.length === 1 ? providers[0] : '';
    const who = el('div', 'pickgroup');
    who.append(el('span', 'label', 'AI'));
    for (const p of providers) who.append(choice(PROVIDER[p], 'provider', p));
    const projects = can.projects || [];
    S.compose.project = projects.some(p=>p.k===c.project) ? c.project : projects.some(p=>p.k==='desk') ? 'desk' : '';
    const where = el('div', 'pickgroup');
    where.append(el('span', 'label', 'Folder'));
    for (const p of projects) where.append(choice(p.n, 'project', p.k));
    pick.append(who, where);
    syncChoices();
  } else if (c.mode === 'yt') {
    $('cTitle').textContent = 'Search YouTube on phone';
    $('cLabel').textContent = 'Say what to find';
    $('cSend').textContent = 'Send search to phone';
  } else if (c.mode === 'say') {
    $('cTitle').textContent = `Reply to ${d.ti || 'this task'}`;
    $('cLabel').textContent = 'Say your reply';
  } else if(c.mode === 'answertext') {
    $('cTitle').textContent='Answer this question';
    $('cLabel').textContent=d.q?.text||'Say your answer';
  } else if (c.mode === 'answer') {
    $('cTitle').textContent = 'Answer';
    review();
    return;
  } else if (c.mode === 'stop') {
    $('cTitle').textContent = 'Stop this task?';
    review();
    return;
  }
  saveCompose();
  (pick.querySelector('button') || text).focus();
  if (!pick.querySelector('button')) text.focus();
}

function choice(label, kind, value) {
  const b = el('button', 'btn', label);
  b.dataset.kind = kind;
  b.dataset.value = value;
  b.addEventListener('click', () => { S.compose[kind] = value; syncChoices(); saveCompose(); });
  return b;
}

function syncChoices() {
  for (const b of $('cPick').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(S.compose[b.dataset.kind] === b.dataset.value));
  }
}

function review() {
  const c = S.compose;
  if (!c) return;
  if(c.request?.status==='accepted'){openAcceptedTask(c);return;}
  if(c.request&&['sending','uncertain'].includes(c.request.status)){paintConfirmation(c);return;}
  if(c.request?.status==='rejected'){c.request=null;$('cText').readOnly=false;saveCompose(c);}
  if (c.mode === 'yt') { findVideos(); return; }
  const text = c.mode === 'answer' ? c.text : $('cText').value;
  if (['new','say','answertext'].includes(c.mode) && !text.trim()) {
    $('cNote').textContent = 'Nothing to send yet. Focus the box and speak.';
    $('cText').focus();
    return;
  }
  const can = (S.snap && S.snap.can) || {};
  const d = S.details[c.k] || rowFor(c.k) || {};
  let summary = '';
  if (c.mode === 'new') {
    if (!(can.new || []).includes(c.provider) || !(can.projects || []).some(p=>p.k===c.project)) {
      $('cNote').textContent='Choose an available agent and folder before reviewing.';return;
    }
    const project = (can.projects || []).find((p) => p.k === c.project);
    const place = !project ? 'the chosen folder' : project.k === 'desk' ? 'a fresh folder' : project.n;
    summary = `Send to ${PROVIDER[c.provider] || 'the AI'}, working in ${place}:`;
  } else if (c.mode === 'say') summary = `Send to ${PROVIDER[d.p] || 'the selected agent'} - ${d.ti || 'this task'}:`;
  else if (c.mode === 'answer' || c.mode === 'answertext') summary = `Answer ${d.ti || 'this task'} with:`;
  else summary = `Stop ${d.ti}? Its work so far is kept.`;
  c.final = text;
  c.question=JSON.stringify(d.q||null);
  $('cSummary').textContent = summary;
  $('cQuote').textContent = c.mode === 'stop' ? '' : `“${text}”`;
  paintConfirmation(c);
}

function taskSendProblem(c) {
  if(!c || document.hidden || S.view!=='compose' || S.compose!==c)return 'Return to this draft before sending.';
  if(!S.kUp||!S.topic||S.pairing)return 'The Studio connection is not paired. Your draft is kept.';
  if(!linkUp()||S.quiet||!S.pcAt)return 'The PC has not confirmed a live connection. Your draft is kept.';
  if(!StudioParked.controlsAllowed())return 'Drive controls require a parked declaration.';
  const can=S.snap?.can||{},d=S.details[c.k]||rowFor(c.k)||{};
  if(c.mode==='new'){
    if(!(can.new||[]).includes(c.provider))return 'That agent is not currently available. Choose an available agent.';
    if(!(can.projects||[]).some(p=>p.k===c.project))return 'Choose an available folder.';
  }else{
    const action=c.mode==='stop'?'stop':c.mode==='answer'||c.mode==='answertext'?'answer':'say';
    if(!/^g[0-9a-f]{8}$/.test(c.k||'') || !(d.acts||[]).includes(action))return 'This session does not provide that action from the glasses.';
    if(['answer','answertext'].includes(c.mode)&&(!d.q?.safe||JSON.stringify(d.q||null)!==c.question))return 'The question changed or requires approval in its original app. Your draft is kept.';
  }
  if(c.mode!=='stop'&&(!String(c.final||'').trim()||String(c.final).length>2000))return 'Use a message of 1–2000 characters.';
  if(['new','say','answertext'].includes(c.mode)&&$('cText').value!==c.final)return 'Your words changed. Review them again before sending.';
  return '';
}

function paintConfirmation(c, record = true, focus = true) {
  if(record && history.state?.v!=='confirm')history.pushState({v:'confirm',draft:composeKey(c)},'');
  $('compose').classList.add('compose-review');$('cConfirm').hidden=false;
  if(c.request&&['sending','uncertain','accepted'].includes(c.request.status)){
    const original=c.request.summary||(c.request.command==='new'?`Send to ${PROVIDER[c.request.payload.p]||'the selected agent'}, folder ${c.request.payload.w}:`:`Request for task ${c.k}:`);
    $('cSummary').textContent=`Original request. ${original}`;
  }
  $('cQuote').textContent=c.mode==='stop'?'':c.final||'';
  const pending=c.request && ['sending','uncertain'].includes(c.request.status),accepted=c.request?.status==='accepted';
  const problem=pending||accepted?'':taskSendProblem(c);
  $('cGo').disabled=!!problem || c.request?.status==='sending';
  $('cGo').textContent=accepted?'Open task':pending?'Check saved receipt':c.mode==='stop'?'Stop task':'Send';
  // An answer or a stop has no text to edit, so its second button goes back instead.
  $('cEdit').textContent=pending||accepted||['answer','stop'].includes(c.mode)?'Back':'Edit';
  $('cNote').textContent=problem||(accepted?'This request was accepted. Open its task.':pending?'This request is unconfirmed. Check its saved receipt; it will not be sent again.':'Review the agent, folder and text. Send is the only action that submits.');
  saveCompose(c);if(focus)($('cGo').disabled?$('cEdit'):$('cGo')).focus();
}

async function findVideos() {
  if(watchPhone.pending)return;
  const query=$('cText').value;
  await handoffWatch({kind:'search',provider:'youtube',query},$('cNote'));
}

function closeConfirm() {
  $('cConfirm').hidden = true;
  $('compose').classList.remove('compose-review');
}

function openAcceptedTask(c) {
  const k=c.request?.k;if(!/^g[0-9a-f]{8}$/.test(k||''))return;
  S.compose=null;S.open=k;S.view='detail';history.replaceState({v:'detail',k},'');showPane('detail');renderDetail();
  ($('dActions').querySelector('button')||$('dResult')).focus();armIdle();
}

function completeTaskReply(c, request, ack) {
  if(c.request!==request || typeof ack.ok!=='boolean')return false;
  if(S.compose&&S.compose!==c&&S.compose.request?.id===request.id&&JSON.stringify(S.compose.request.payload)===JSON.stringify(request.payload)){
    const current=S.compose;c.request=current.request;return completeTaskReply(current,current.request,ack);
  }
  const active=S.compose===c&&S.view==='compose'&&!document.hidden&&!$('cConfirm').hidden;
  if(!ack.ok){request.status='rejected';saveCompose(c);if(active){$('cNote').textContent=ack.why||'The PC refused this request. Your draft is kept.';$('cGo').disabled=true;$('cEdit').textContent='Edit';}return true;}
  const k=ack.k||c.k;
  if(!/^g[0-9a-f]{8}$/.test(k||'') || (ack.det&&ack.det.k!==k))return false;
  if(request.command!=='new'&&k!==c.k)return false;
  request.status='accepted';request.k=k;clearComposeDraft(c);
  if(ack.det)S.details[k]=ack.det;
  if(!active){if(S.compose===c){$('cSend').textContent='Open accepted task';$('cNote').textContent='Request accepted. Open its task when ready.';}return true;}
  openAcceptedTask(c);
  return true;
}

async function checkTaskReceipt(c) {
  const request=c.request;if(!request)return;
  if(S.snap?.can?.receipts!==1){$('cNote').textContent='This relay cannot check a saved task receipt yet. The request remains unconfirmed; no duplicate was sent.';return;}
  const query=toB64url(crypto.getRandomValues(new Uint8Array(9)));
  const active=()=>S.compose===c&&S.view==='compose'&&!document.hidden;
  $('cGo').disabled=true;$('cNote').textContent='Checking the original request. Nothing is being sent again.';
  const timer=setTimeout(()=>{delete S.pending[query];if(active()){$('cGo').disabled=false;$('cNote').textContent='No receipt answer arrived. The original request is still unconfirmed.';}},15000);
  S.pending[query]=ack=>{
    clearTimeout(timer);
    const kind=request.command==='say'&&request.payload.answer?'answer':request.command;
    if(ack.mutationId!==request.id||ack.status!=='accepted'||ack.kind!==kind){if(active()){$('cGo').disabled=false;$('cNote').textContent='No saved receipt was confirmed. Your original request and draft are kept.';}return;}
    completeTaskReply(c,request,ack);
  };
  try{const id=await send('taskreceipt',{mutationId:request.id},{id:query,noQueue:true,guard:active});if(id!==query)throw new Error('The receipt check was not sent. Your original request remains unconfirmed.');}
  catch(error){clearTimeout(timer);delete S.pending[query];if(active()){$('cGo').disabled=false;$('cNote').textContent=error.message;}}
}

async function go() {
  const c=S.compose;if(!c||$('cGo').disabled||$('cConfirm').hidden)return;
  if(c.request?.status==='accepted'){openAcceptedTask(c);return;}
  if(c.request&&['sending','uncertain'].includes(c.request.status)){await checkTaskReceipt(c);return;}
  const problem=taskSendProblem(c);if(problem){$('cNote').textContent=problem;return;}
  const command=c.mode==='new'?'new':c.mode==='stop'?'stop':'say';
  const payload=c.mode==='new'?{p:c.provider,w:c.project,text:c.final}:c.mode==='stop'?{k:c.k}:{k:c.k,text:c.final,answer:['answer','answertext'].includes(c.mode)};
  const request={id:toB64url(crypto.getRandomValues(new Uint8Array(9))),command,payload,summary:$('cSummary').textContent,status:'sending',at:Date.now()};
  c.request=request;
  if(!saveCompose(c,true)){c.request=null;$('cGo').disabled=true;$('cNote').textContent='This device could not save the request safely. Nothing was sent; your draft stays open.';return;}
  $('cText').readOnly=true;$('cGo').disabled=true;$('cNote').textContent='Sending. Waiting for the PC’s saved acknowledgement.';
  const active=()=>S.compose===c&&S.view==='compose'&&!document.hidden&&!$('cConfirm').hidden&&history.state?.v==='confirm'&&c.request===request;
  let published=false;
  const timer=setTimeout(()=>{if(c.request===request&&request.status==='sending'){request.status='uncertain';saveCompose(c);if(active())paintConfirmation(c,false);}},20000);
  S.pending[request.id]=ack=>{if(completeTaskReply(c,request,ack))clearTimeout(timer);};
  try{
    const sent=await send(command,payload,{id:request.id,noQueue:true,guard:()=>active()&&!taskSendProblem(c),onPublish:()=>{published=true;}});
    if(sent!==request.id)throw new Error('Nothing was sent. Check the connection or message limit; your draft is kept.');
  }catch(error){
    clearTimeout(timer);
    if(['accepted','rejected'].includes(request.status))return;
    if(published){request.status='uncertain';saveCompose(c);if(active())paintConfirmation(c,false);}
    else{delete S.pending[request.id];c.request=null;saveCompose(c);if(S.compose===c&&S.view==='compose'){$('cText').readOnly=false;$('cNote').textContent=error.message;$('cGo').disabled=true;}}
  }
}

// ---- keys ------------------------------------------------------------------------------------------

// Each screen is a column of rows of controls. Up and Down move between rows; Left and Right move within a row
// (or, on the section lists, between sections). This doesn't depend on the browser's guess of the nearest element.
function visible(n) {
  return n && !n.hidden && !n.disabled && n.offsetParent !== null && !n.closest('[hidden]');
}

// One focus model: the review frame is same-origin, so its controls join the rows moveFocus already walks.
function reviewRows() {
  const f = $('reviewFrame');
  return (!f.hidden && !f.inert && f.contentWindow.reviewRows?.()) || [];
}

function focusedControl() {
  const a = document.activeElement;
  return a === $('reviewFrame') ? a.contentDocument?.activeElement : a;
}

function rowsOfControls() {
  const groups = [];
  const add = (list) => { const g = [...list].filter(visible); if (g.length) groups.push(g); };
  const pane = PANES.find((p) => !$(p).hidden);
  add(document.querySelectorAll('[data-section]'));
  if (pane === 'review') { add([$('reviewEnter')]); for (const g of reviewRows()) add(g); }
  else if (['now', 'work', 'watch', 'route', 'drive', 'apps', 'games', 'pair'].includes(pane)) {
    add([document.querySelector(`.tab[data-tab="${S.tab}"]`)]);
    if (pane === 'pair') add([$('pRetry')]);
    else if (pane === 'now') for (const b of $('nowRows').querySelectorAll('.row')) add([b]);
    else if (pane === 'watch') { add([$('ytFind')]); for (const b of $('watchRows').querySelectorAll('.row')) add([b]); }
    else if (pane === 'route') for (const b of $('routeRows').querySelectorAll('.row')) add([b]);
    else if (pane === 'drive' && HomeShell.driveQuiet()) add([$('driveReveal')]);
    else if (pane === 'drive' && !$('driveInfo').hidden) add([$('drivePhoneToggle'),$('drivePhoneUse'),$('drivePhoneKeep'),$('driveInfoClose')]);
    else if (pane === 'drive') { add([$('driveGps'),$('driveRetry')]); add([$('driveLight'),$('driveInfoButton')]); }
    else if (pane === 'work') { add([$('newTask')]); for (const b of $('rows').querySelectorAll('.row')) add([b]); }
    else for (const b of $(pane === 'apps' ? 'appRows' : 'gameRows').querySelectorAll('.row')) add([b]);
  } else if (pane === 'play') {
    add($('pvControls').querySelectorAll('button'));
  } else if (pane === 'detail') {
    add($('dOptions').querySelectorAll('button'));
    if ($('dResult').textContent) add([$('dResult')]);
    add($('dActions').querySelectorAll('button'));
  } else if (pane === 'compose') {
    for (const g of $('cPick').querySelectorAll('.pickgroup')) add(g.querySelectorAll('button'));
    add([$('cText')]);
    add([$('cSend')]);
    if(!$('cConfirm').hidden&&$('cQuote').textContent)add([$('cQuote')]);
    add([$('cGo'), $('cEdit')]);
  }
  return groups;
}

function moveFocus(dy, dx) {
  const groups = rowsOfControls();
  const a = focusedControl();
  let gi = groups.findIndex((g) => g.includes(a));
  if (gi < 0) { (document.activeElement === $('reviewFrame') && reviewRows()[0] || groups[0] || [])[0]?.focus(); return; }
  if (dx) {
    const g = groups[gi];
    const next = g[g.indexOf(a) + dx];
    if (next) next.focus(); else rubberBand(0, dx);
    return;
  }
  gi += dy;
  if (gi < 0 || gi >= groups.length) { rubberBand(dy, 0); return; }
  const g = groups[gi];
  const pick = g.find((n) => n.getAttribute('aria-selected') === 'true' || n.getAttribute('aria-pressed') === 'true' || n.getAttribute('aria-current') === 'page') || g[0];
  pick.focus();
  if (pick.scrollIntoView) pick.scrollIntoView({ block: 'nearest' });
}

// A swipe that landed inside the picture frame: the same rows and the same mover as everywhere else.
function reviewKey(k) {
  wakeUp();
  if (k === 'ArrowDown' || k === 'ArrowUp') moveFocus(k === 'ArrowDown' ? 1 : -1, 0);
  else if (k === 'ArrowLeft' || k === 'ArrowRight') moveFocus(0, k === 'ArrowRight' ? 1 : -1);
}

function onKey(e) {
  if (document.visibilityState !== 'visible') return;
  if (HomeShell.handleKey(e)) return;
  if (e.key !== 'Enter') S.lastKeyAt = Date.now();
  if (e.key === 'Enter' && !e.target.closest('textarea')) press(e.target);
  if (S.paused && (S.kUp || S.tg)) wake(); else if (S.kUp || S.tg) armIdle();
  const k = e.key;
  if (e.target.closest('.sections') && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    e.preventDefault();moveFocus(0,k === 'ArrowRight' ? 1 : -1);return;
  }
  if (S.view === 'list' && S.tab === 'drive' && e.target.closest('.drive-actions, .drive-info') && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    e.preventDefault();moveFocus(0,k === 'ArrowRight' ? 1 : -1);return;
  }
  if (S.view === 'list' && (k === 'ArrowLeft' || k === 'ArrowRight') && !e.target.closest('textarea')) {
    const tabs = HomeShell.tabsForInput(e.target);
    if (tabs.length < 2) { e.preventDefault(); moveFocus(0, k === 'ArrowRight' ? 1 : -1); return; } // Review has no tab to step to.
    const i = Math.max(0,tabs.indexOf(S.tab));
    const next = tabs[(i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault();
    S.slide = k === 'ArrowRight' ? 1 : -1;
    selectTab(next, Boolean(e.target.closest('.tabs')));
    return;
  }
  if ((e.target === $('dResult') || e.target === $('cQuote')) && (k === 'ArrowDown' || k === 'ArrowUp')) {
    const r = e.target;
    const down = k === 'ArrowDown';
    const room = down ? r.scrollHeight - r.clientHeight - r.scrollTop : r.scrollTop;
    e.preventDefault();
    if (room > 2) r.scrollBy({ top: down ? 150 : -150, behavior: MOTION ? 'smooth' : 'auto' });
    else moveFocus(down ? 1 : -1, 0);
    return;
  }
  if (e.target === $('cText')) {
    // A normal activated textarea belongs to the glasses' system composer.
    return;
  }
  // In a video, up and down jump 10 seconds; left and right move along the controls.
  if (S.view === 'play' && (k === 'ArrowDown' || k === 'ArrowUp')) {
    e.preventDefault();
    if (S.player && S.player.getCurrentTime) S.player.seekTo(Math.max(0, S.player.getCurrentTime() + (k === 'ArrowUp' ? 10 : -10)), true);
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveFocus(k === 'ArrowDown' ? 1 : -1, 0); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveFocus(0, k === 'ArrowRight' ? 1 : -1); }
}

// ---- start -----------------------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}); } catch (e) { /* optional */ }
}

async function main() {
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab, true));
  $('newTask').addEventListener('click', () => startCompose({ mode: 'new' }));
  $('cSend').addEventListener('click', review);
  $('cGo').addEventListener('click', go);
  $('cText').addEventListener('input',()=>{saveCompose();if(!$('cConfirm').hidden)closeConfirm();});
  $('cEdit').addEventListener('click', () => {
    const mode = S.compose && S.compose.mode;
    if(S.compose?.request&&['sending','uncertain'].includes(S.compose.request.status)){history.go(-2);return;}
    if(S.compose?.request?.status==='rejected'){
      const c=S.compose;c.request=null;$('cText').readOnly=false;saveCompose(c);
      if(['new','say','answertext'].includes(mode)){if(history.state?.v==='confirm')history.back();startCompose(c,false);return;}
    }
    if(history.state?.v==='confirm'){history.back();return;}
    if (mode === 'answer' || mode === 'stop') { history.back(); return; }
    closeConfirm();$('cText').focus();
  });
  $('pRetry').addEventListener('click', () => { if (S.paused) wake(); else hello(); });
  // The video controls: the player's own controls are hidden so the arrows and pinch drive these.
  const seek = (d) => { if (S.player && S.player.getCurrentTime) S.player.seekTo(Math.max(0, S.player.getCurrentTime() + d), true); };
  $('pvBack10').addEventListener('click', () => seek(-10));
  $('pvFwd10').addEventListener('click', () => seek(10));
  $('pvPlay').addEventListener('click', () => {
    const p = S.player;
    if (!p || !p.getPlayerState) return;
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
  });
  $('pvSpeed').addEventListener('click', () => {
    S.speedAt = ((S.speedAt || 0) + 1) % SPEEDS.length;
    $('pvSpeed').textContent = `${SPEEDS[S.speedAt]}×`;
    if (S.player && S.player.setPlaybackRate) S.player.setPlaybackRate(SPEEDS[S.speedAt]);
  });
  // Back keeps the place; a video leaves the list on its own once it has played to the end.
  $('pvDone').addEventListener('click', () => history.back());
  // Any swipe or pinch wakes the page from calm before anything else handles it (and is still handled).
  document.addEventListener('keydown', wakeUp, true);
  document.addEventListener('pointerdown', wakeUp, true);
  document.addEventListener('pointerdown', (e) => press(e.target.closest && e.target.closest('button')), true);
  document.addEventListener('keydown', onKey, true);
  $('dResult').addEventListener('scroll', updateGauge, { passive: true });
  for (const id of ['rows', 'appRows', 'gameRows']) {
    $(id).addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 2), { passive: true });
  }
  window.addEventListener('popstate', (e) => apply(e.state));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { wakeUp(); wake(); if (!$('now').hidden) renderNow(); } else { cancelWatch(); stopReading(); if (S.view === 'play') closePlayer(); sleep('hidden'); }
  });
  window.addEventListener('pagehide', () => { cancelWatch(); stopReading(); sleep('hidden'); });
  // The network is back (signal again after driving through a dead zone, say): fresh links, tried fast.
  window.addEventListener('online', () => {
    if ((!S.kUp && !S.tg) || S.paused || document.visibilityState !== 'visible') return;
    closeLink();
    openLink();
    hello();
  });
  HomeShell.init();
  renderApps();
  loadApps();
  const returned = history.state;
  const fromApp = returned?.appUrl && ['apps', 'games'].includes(returned.tab);
  const start = fromApp ? returned.tab : TABS.includes(S.fragment.get('tab')) ? S.fragment.get('tab') : 'now';
  history.replaceState(fromApp ? returned : { v: 'list', tab: start }, '');
  S.tab = start;
  let ready = false;
  try { ready = await setupKeys(); } catch (e) { ready = false; }
  try { await setupBattery(); } catch (e) { S.tg = null; }
  await drivePhone.setup(S.fragment);
  wakeUp();
  renderWork();
  showPane(start);
  requestAnimationFrame(placeTabline);
  if (!fromApp || !focusApp(returned.appUrl)) focusFirst(start);
  renderState();
  registerServiceWorker();
  if (ready || S.tg) wake();
  // Opening the passive Now/Drive view is not a declaration that the wearer is parked.
  // Interactive controls ask when deliberately activated; the route preview is parked-only.
  if (S.tab === 'route') StudioParked.request();
}

main();

$('driveGps').addEventListener('click', toggleDriveGps);
$('drivePhoneToggle')?.addEventListener('click',()=>drivePhone.setEnabled(!drivePhone.enabled));
$('drivePhoneUse')?.addEventListener('click',()=>drivePhone.acceptOffer());
$('drivePhoneKeep')?.addEventListener('click',()=>drivePhone.keepCurrent());
$('driveRetry').addEventListener('click', retryDriveGps);
$('driveLight').addEventListener('click', nextDriveLight);
applyDriveLight();
paintDrive(driveFeed.snapshot());

// This is a saved route preview, not live navigation.
// Moving through the turns moves the dot along the route.
$('routeRows').addEventListener('focusin', (e) => {
  const b = e.target.closest('[data-s]');
  if (b && S.snap && S.snap.rt) placeRouteDot(S.snap.rt.steps[+b.dataset.s]);
});

// Watch: search lives above the list.
$('ytFind').addEventListener('click', () => startCompose({ mode: 'yt' }));
