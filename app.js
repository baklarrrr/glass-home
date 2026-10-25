'use strict';

// Bakar Home on Meta Ray-Ban Display: Claude and Codex sessions from the studio PC (Work), Bakar's glasses apps
// (Apps) and games kept apart from them (Games).
//
// Privacy: the studio PC's relay and this page talk through ntfy.sh, encrypted end to end. The first time it runs,
// this page makes a P-256 key pair and keeps the private half in IndexedDB as a key that can't be exported. The PC
// accepts that key once, while a pairing window is open at the PC. Both sides then derive the same AES-GCM keys
// (ECDH + HKDF). The address carries only the ntfy topic and the PC's public key, so a copied link can't read or
// send anything.
//
// Battery: nothing runs while the app is hidden. On screen, the page listens for the PC and says hello every
// 2.5 minutes so the PC keeps sending. After 90 seconds without a key press it pauses itself (10 minutes while
// you watch a task you started). Times are clock times, so nothing ticks.

const DEFAULT_SERVER = 'https://ntfy.sh';
const IDLE_MS = 90 * 1000;
const WATCH_MS = 10 * 60 * 1000;
const HELLO_MS = 150 * 1000;
const ANSWER_MS = 12 * 1000;
const DAILY_SENDS = 30;
const HELP_OPTIONS = ['Give me THREE good options.', 'Unjumble this for me.'];

const SITE = 'https://baklarrrr.github.io/';
// The Apps and Games lists live in apps.json so another session can add an app or a game without touching this
// code. These are used when it can't be read.
let APPS = [
  { group: 'Studio', name: 'Bakar Studio', url: SITE + 'studio-glass/', why: 'Renders, AI at work and today’s AI cost', icon: 'studio-glass/icon-mono.svg', pass: 'sg' },
  { group: 'Listen', name: 'Tidal', url: SITE + 'tidal-glass/', why: 'Now playing and controls', icon: 'tidal-glass/icon-mono.svg', pass: 'tg' },
  { group: 'Listen', name: 'Sound Lab', url: SITE + 'tidal-glass/sound/', why: 'EQ, tone and loudness for the glasses’ speakers', icon: 'tidal-glass/sound/icon-mono.svg', pass: 'tg' },
  { group: 'Watch', name: 'Watchlight', url: 'https://watchlight.heralds.gg/', why: 'YouTube on the glasses, from Herald', icon: 'play' },
  { group: 'Faith', name: 'Quran', url: SITE + 'quran-glass/', why: 'Follow a recitation word by word', icon: 'quran-glass/icon-mono.svg' },
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
  server: DEFAULT_SERVER, topic: '', relayPubB64: '', fragment: addressParams(),
  devId: '', devPubB64: '', kUp: null, kDown: null, z: 0,
  snap: null, details: {}, view: 'list', tab: 'work', open: '',
  stream: null, paused: true, idle: 0, hello: 0, answer: 0, askedAt: 0, heardAt: 0, quiet: false, hellos: [], pcAt: 0,
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

function allowedServer(s) {
  return s === DEFAULT_SERVER || /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(s || '');
}

async function setupKeys() {
  let t = S.fragment.get('t');
  let p = S.fragment.get('p');
  const s = S.fragment.get('s');
  if (s && allowedServer(s)) S.server = s;
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

function sendsLeft() {
  const today = new Date().toDateString();
  const b = local('gh.sends') || {};
  return b.d === today ? DAILY_SENDS - (b.n || 0) : DAILY_SENDS;
}

async function send(c, extra = {}) {
  if (!S.kUp) return '';
  const today = new Date().toDateString();
  const b = local('gh.sends') || {};
  const n = b.d === today ? (b.n || 0) : 0;
  if (n >= DAILY_SENDS) { flash('Daily message limit reached'); return ''; }
  local('gh.sends', { d: today, n: n + 1 });
  const id = toB64url(crypto.getRandomValues(new Uint8Array(9)));
  if (c === 'hello') S.hellos = S.hellos.slice(-4).concat(id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc(JSON.stringify({ c, id, ts: Date.now(), z: S.z, ...extra }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, S.kUp, body));
  const sealed = new Uint8Array(12 + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, 12);
  try {
    await fetch(`${S.server}/${S.topic}-u`, { method: 'POST', body: `1.${S.devPubB64}.${toB64url(sealed)}` });
  } catch (e) { /* the state line reports a PC that goes quiet */ }
  return id;
}

// ---- link ------------------------------------------------------------------------------------------

const downTopic = () => `${S.server}/${S.topic}-${S.devId}`;

async function handle(text) {
  let m;
  try { m = await openDown(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  // The stream starts with the last half hour's messages. A reply that names one of this visit's hellos is
  // live, and so is anything the PC wrote after that reply (by the PC's own clock, so the two clocks needn't agree).
  const live = Boolean(m.re && S.hellos.includes(m.re)) || (S.pcAt > 0 && (m.at || 0) >= S.pcAt);
  if (live) { S.heardAt = Date.now(); S.quiet = false; S.pcAt = Math.max(S.pcAt, m.at || 0); }
  if (m.t === 'snap') {
    if (!S.snap || m.at >= S.snap.at) {
      S.snap = m;
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

// One connection does both: the last half hour (so the screen fills at once) and then whatever comes next.
function openStream() {
  if (S.stream || S.paused) return;
  S.stream = new EventSource(`${downTopic()}/sse?since=30m`);
  S.stream.addEventListener('message', (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.event === 'message' && ev.message) handle(ev.message);
    } catch (err) { /* keepalive */ }
  });
}

function closeStream() {
  if (S.stream) { S.stream.close(); S.stream = null; }
}

// Yes/no facts about this browser, sent once per visit so the PC can record what the glasses support. Only whether
// the other apps' pairing exists here (shared storage), never its value.
function diagnostics() {
  if (S.diagSent) return undefined;
  S.diagSent = true;
  let sg = false;
  let tg = false;
  try { sg = Boolean(localStorage.getItem('sg.pair')); tg = Boolean(localStorage.getItem('tg.pair')); } catch (e) { /* none */ }
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
  if (!S.kUp || document.visibilityState !== 'visible') return;
  const was = S.paused;
  S.paused = false;
  armIdle();
  if (!was) return;
  S.askedAt = Date.now();
  openStream();
  hello();
  clearInterval(S.hello);
  S.hello = setInterval(hello, HELLO_MS);
  renderState();
}

function sleep(reason) {
  S.paused = true;
  closeStream();
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
  const s = S.snap;
  const list = $('rows');
  const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : '';
  list.textContent = '';
  const sum = $('summary');
  sum.textContent = '';
  if (!S.kUp) {
    sum.textContent = 'Open Bakar Home from its own link to see Claude and Codex.';
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
  for (const r of s.rows || []) {
    const li = el('li');
    const b = el('button', `row ${r.st}`);
    b.dataset.k = r.k;
    b.append(el('span', `mark ${r.st}`), el('span', 'ti', r.ti), el('span', 'tag', (r.own ? 'Glasses · ' : '') + PROVIDER[r.p]));
    b.append(el('span', 'why', r.st === 'work' && !r.why ? 'Working' : r.why), el('span', 'age', age(r.at)));
    b.setAttribute('aria-label', `${r.ti}. ${PROVIDER[r.p]}. ${STATUS[r.st]}. ${r.why}`);
    b.addEventListener('click', () => openDetail(r.k));
    li.append(b);
    list.append(li);
  }
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
  if (focusId) {
    const again = document.querySelector(`[data-f="${focusId}"]`);
    if (again) again.focus({ preventScroll: true });
  } else if (S.lastKeyAt < S.openedAt && document.activeElement === $('dResult')) {
    // The question arrived after the screen opened and Bakar hasn't moved yet: start on its first answer.
    const first = $('dOptions').querySelector('button');
    if (first) first.focus();
  }
}

function appRow(app) {
  const b = el('button', 'row app');
  const icon = el('span', 'icon');
  const src = GLYPHS[app.icon] || (app.icon ? SITE + app.icon : GLYPHS.app);
  icon.style.setProperty('--icon', `url("${src}")`);
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
}

function renderApps() {
  const list = $('appRows');
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
  $('gamesNote').textContent = GAMES.length
    ? 'Games stay here, away from Work and Apps.'
    : 'No web games added yet. Games you add will appear here, away from Work and Apps. Meta’s own games stay in the glasses’ main app list.';
}

function launch(app) {
  let url = app.url;
  const pass = app.pass && S.fragment.get(app.pass);
  if (pass && pass.includes('~')) {
    const [t, k] = pass.split('~');
    url += `#t=${encodeURIComponent(t)}&k=${encodeURIComponent(k)}`;
  }
  location.assign(url);
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

const PANES = ['work', 'detail', 'compose', 'apps', 'games', 'pair'];

function showPane(id) {
  for (const p of PANES) $(p).hidden = p !== id;
  const listView = ['work', 'apps', 'games', 'pair'].includes(id);
  for (const t of document.querySelectorAll('.tab')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === S.tab));
    t.tabIndex = listView ? 0 : -1;
  }
}

function focusFirst(pane) {
  // On Work, start on the top session (needs-you sessions sort first); New task is one press up.
  const first = (pane === 'work' && $('rows').querySelector('.row[data-k]'))
    || $(pane).querySelector('button:not([hidden]), [tabindex="0"]');
  (first || document.querySelector(`.tab[data-tab="${S.tab}"]`)).focus();
}

function selectTab(tab, focusTab) {
  S.tab = tab;
  S.view = 'list';
  history.replaceState({ v: 'list', tab }, '');
  if (S.pairing && tab === 'work') showPane('pair');
  else showPane(tab);
  if (focusTab) document.querySelector(`.tab[data-tab="${tab}"]`).focus();
  else focusFirst(tab === 'work' && S.pairing ? 'pair' : tab);
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
  closeConfirm();
  if (!state || state.v === 'list') {
    const backTo = S.open;
    S.view = 'list';
    S.open = '';
    showPane(S.pairing && S.tab === 'work' ? 'pair' : S.tab);
    const row = backTo && $('rows').querySelector(`[data-k="${CSS.escape(backTo)}"]`);
    if (row) row.focus(); else focusFirst(S.tab);
  } else if (state.v === 'detail') {
    S.view = 'detail';
    S.open = state.k;
    showPane('detail');
    renderDetail();
    ($('dActions').querySelector('button') || $('dOptions').querySelector('button') || $('dResult')).focus();
  } else if (state.v === 'compose') {
    history.back();
  }
}

// ---- writing: new task, reply, answer, stop --------------------------------------------------------

function startCompose(c) {
  S.compose = Object.assign({ provider: '', project: '' }, c);
  S.view = 'compose';
  history.pushState({ v: 'compose' }, '');
  showPane('compose');
  closeConfirm();
  $('cNote').textContent = '';
  const can = (S.snap && S.snap.can) || {};
  const pick = $('cPick');
  pick.textContent = '';
  const text = $('cText');
  text.value = c.text || '';
  const field = text.closest('.field');
  field.hidden = c.mode === 'stop' || c.mode === 'answer';
  $('cSend').textContent = 'Review';
  const d = S.details[c.k] || rowFor(c.k) || {};
  if (c.mode === 'new') {
    $('cTitle').textContent = 'New task';
    $('cLabel').textContent = 'Say what you want done';
    const providers = can.new || [];
    S.compose.provider = providers[0] || '';
    const who = el('div', 'pickgroup');
    who.append(el('span', 'label', 'AI'));
    for (const p of providers) who.append(choice(PROVIDER[p], 'provider', p));
    const projects = can.projects || [];
    S.compose.project = projects.length ? projects[0].k : '';
    const where = el('div', 'pickgroup');
    where.append(el('span', 'label', 'Folder'));
    for (const p of projects) where.append(choice(p.n, 'project', p.k));
    pick.append(who, where);
    syncChoices();
  } else if (c.mode === 'say') {
    $('cTitle').textContent = `Reply to ${d.ti || 'this task'}`;
    $('cLabel').textContent = 'Say your reply';
  } else if (c.mode === 'answer') {
    $('cTitle').textContent = 'Answer';
    review();
    return;
  } else if (c.mode === 'stop') {
    $('cTitle').textContent = 'Stop this task?';
    review();
    return;
  }
  (pick.querySelector('button') || text).focus();
  if (!pick.querySelector('button')) text.focus();
}

function choice(label, kind, value) {
  const b = el('button', 'btn', label);
  b.dataset.kind = kind;
  b.dataset.value = value;
  b.addEventListener('click', () => { S.compose[kind] = value; syncChoices(); });
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
  const text = c.mode === 'answer' ? c.text : $('cText').value.trim();
  if ((c.mode === 'new' || c.mode === 'say') && !text) {
    $('cNote').textContent = 'Nothing to send yet. Focus the box and speak.';
    $('cText').focus();
    return;
  }
  const can = (S.snap && S.snap.can) || {};
  const d = S.details[c.k] || rowFor(c.k) || {};
  let summary = '';
  if (c.mode === 'new') {
    const project = (can.projects || []).find((p) => p.k === c.project);
    const place = !project ? 'the chosen folder' : project.k === 'desk' ? 'a fresh folder' : project.n;
    summary = `Send to ${PROVIDER[c.provider] || 'the AI'}, working in ${place}:`;
  } else if (c.mode === 'say') summary = `Send this reply to ${d.ti}:`;
  else if (c.mode === 'answer') summary = `Answer ${d.ti} with:`;
  else summary = `Stop ${d.ti}? Its work so far is kept.`;
  c.final = text;
  $('cSummary').textContent = summary;
  $('cQuote').textContent = c.mode === 'stop' ? '' : `“${text}”`;
  $('cConfirm').hidden = false;
  $('cGo').textContent = c.mode === 'stop' ? 'Stop task' : 'Send';
  // An answer or a stop has no text to edit, so its second button goes back instead.
  $('cEdit').textContent = c.mode === 'answer' || c.mode === 'stop' ? 'Cancel' : 'Edit';
  $('cGo').disabled = false;
  $('cGo').focus();
}

function closeConfirm() {
  $('cConfirm').hidden = true;
}

async function go() {
  const c = S.compose;
  if (!c || $('cGo').disabled) return;
  $('cGo').disabled = true;
  $('cNote').textContent = 'Sending…';
  let id = '';
  if (c.mode === 'new') id = await send('new', { p: c.provider, w: c.project, text: c.final });
  else if (c.mode === 'say' || c.mode === 'answer') id = await send('say', { k: c.k, text: c.final, answer: c.mode === 'answer' });
  else if (c.mode === 'stop') id = await send('stop', { k: c.k });
  if (!id) { $('cNote').textContent = 'Not sent. Check the connection and try again.'; $('cGo').disabled = false; return; }
  const timer = setTimeout(() => {
    if (S.pending[id]) { delete S.pending[id]; $('cNote').textContent = 'Sent, but your PC hasn’t confirmed it yet.'; $('cGo').disabled = false; }
  }, 20000);
  S.pending[id] = (ack) => {
    clearTimeout(timer);
    if (!ack.ok) { $('cNote').textContent = ack.why || 'Your PC refused that.'; $('cGo').disabled = false; return; }
    S.compose = null;
    const k = ack.k || c.k;
    S.open = k;
    S.view = 'detail';
    history.replaceState({ v: 'detail', k }, '');
    if (ack.det) S.details[k] = ack.det;
    showPane('detail');
    renderDetail();
    ($('dActions').querySelector('button') || $('dResult')).focus();
    armIdle();
  };
}

// ---- keys ------------------------------------------------------------------------------------------

// Each screen is a column of rows of controls. Up and Down move between rows; Left and Right move within a row
// (or, on the section lists, between sections). This doesn't depend on the browser's guess of the nearest element.
function visible(n) {
  return n && !n.hidden && !n.disabled && n.offsetParent !== null && !n.closest('[hidden]');
}

function rowsOfControls() {
  const groups = [];
  const add = (list) => { const g = [...list].filter(visible); if (g.length) groups.push(g); };
  const pane = PANES.find((p) => !$(p).hidden);
  if (['work', 'apps', 'games', 'pair'].includes(pane)) {
    add([document.querySelector(`.tab[data-tab="${S.tab}"]`)]);
    if (pane === 'pair') add([$('pRetry')]);
    else if (pane === 'work') { add([$('newTask')]); for (const b of $('rows').querySelectorAll('.row')) add([b]); }
    else for (const b of $(pane === 'apps' ? 'appRows' : 'gameRows').querySelectorAll('.row')) add([b]);
  } else if (pane === 'detail') {
    add($('dOptions').querySelectorAll('button'));
    if ($('dResult').textContent) add([$('dResult')]);
    add($('dActions').querySelectorAll('button'));
  } else if (pane === 'compose') {
    for (const g of $('cPick').querySelectorAll('.pickgroup')) add(g.querySelectorAll('button'));
    add([$('cText')]);
    add([$('cSend')]);
    add([$('cGo'), $('cEdit')]);
  }
  return groups;
}

function moveFocus(dy, dx) {
  const groups = rowsOfControls();
  const a = document.activeElement;
  let gi = groups.findIndex((g) => g.includes(a));
  if (gi < 0) { (groups[0] || [])[0]?.focus(); return; }
  if (dx) {
    const g = groups[gi];
    const next = g[g.indexOf(a) + dx];
    if (next) next.focus();
    return;
  }
  gi += dy;
  if (gi < 0 || gi >= groups.length) return;
  const g = groups[gi];
  const pick = g.find((n) => n.getAttribute('aria-selected') === 'true' || n.getAttribute('aria-pressed') === 'true') || g[0];
  pick.focus();
  if (pick.scrollIntoView) pick.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (document.visibilityState !== 'visible') return;
  if (e.key !== 'Enter') S.lastKeyAt = Date.now();
  if (S.paused && S.kUp) wake(); else if (S.kUp) armIdle();
  const k = e.key;
  if (S.view === 'list' && (k === 'ArrowLeft' || k === 'ArrowRight') && !e.target.closest('textarea')) {
    const tabs = ['work', 'apps', 'games'];
    const i = tabs.indexOf(S.tab);
    const next = tabs[(i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault();
    selectTab(next, Boolean(e.target.closest('.tabs')));
    return;
  }
  if (e.target === $('dResult') && (k === 'ArrowDown' || k === 'ArrowUp')) {
    const r = $('dResult');
    const down = k === 'ArrowDown';
    const room = down ? r.scrollHeight - r.clientHeight - r.scrollTop : r.scrollTop;
    e.preventDefault();
    if (room > 2) r.scrollBy({ top: down ? 150 : -150 });
    else moveFocus(down ? 1 : -1, 0);
    return;
  }
  if (e.target === $('cText')) {
    const t = $('cText');
    if (k === 'Enter' && !e.shiftKey) { e.preventDefault(); $('cSend').focus(); return; }
    if (k === 'ArrowDown' && t.selectionEnd >= t.value.length) { e.preventDefault(); moveFocus(1, 0); return; }
    if (k === 'ArrowUp' && t.selectionStart === 0) { e.preventDefault(); moveFocus(-1, 0); }
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveFocus(k === 'ArrowDown' ? 1 : -1, 0); return; }
  if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveFocus(0, k === 'ArrowRight' ? 1 : -1); }
}

// ---- start -----------------------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) { /* optional */ }
}

async function main() {
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab, true));
  $('newTask').addEventListener('click', () => startCompose({ mode: 'new' }));
  $('cSend').addEventListener('click', review);
  $('cGo').addEventListener('click', go);
  $('cEdit').addEventListener('click', () => {
    const mode = S.compose && S.compose.mode;
    if (mode === 'answer' || mode === 'stop') { history.back(); return; }
    closeConfirm();
    $('cText').focus();
  });
  $('pRetry').addEventListener('click', () => { if (S.paused) wake(); else hello(); });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', (e) => apply(e.state));
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? wake() : sleep('hidden')));
  window.addEventListener('pagehide', () => sleep('hidden'));
  renderApps();
  loadApps();
  const start = ['work', 'apps', 'games'].includes(S.fragment.get('tab')) ? S.fragment.get('tab') : 'work';
  history.replaceState({ v: 'list', tab: start }, '');
  S.tab = start;
  let ready = false;
  try { ready = await setupKeys(); } catch (e) { ready = false; }
  renderWork();
  showPane(start);
  focusFirst(start);
  renderState();
  registerServiceWorker();
  if (ready) wake();
}

main();
