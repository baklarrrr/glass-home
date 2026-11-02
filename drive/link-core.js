'use strict';
// Bakar Drive link v1, the glasses half: keys, sealing and checks on what the phone sends. See LINK.md.
// No network here and no DOM, so Node runs the same code in tests/link-core.test.cjs.
(function (root) {
  const SALT = 'bakar-drive v1', PAIR_LABEL = 'bakar-drive pair v1|';
  const TOPIC_RE = /^[A-Za-z0-9_-]{16,64}$/, KEY_RE = /^[A-Za-z0-9_-]{87}$/, ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
  const STATES = Object.freeze(['NoValidRoute', 'RouteBuilding', 'RouteNotStarted', 'OnRoute', 'RouteNeedsRebuild',
    'RouteFinished', 'RouteNoFollowing', 'RouteRebuilding', 'OffRoute']);
  const TURNS = Object.freeze(['NO_TURN', 'GO_STRAIGHT', 'TURN_RIGHT', 'TURN_SHARP_RIGHT', 'TURN_SLIGHT_RIGHT',
    'TURN_LEFT', 'TURN_SHARP_LEFT', 'TURN_SLIGHT_LEFT', 'U_TURN_LEFT', 'U_TURN_RIGHT', 'ENTER_ROUND_ABOUT',
    'LEAVE_ROUND_ABOUT', 'STAY_ON_ROUND_ABOUT', 'START_AT_THE_END_OF_STREET', 'REACHED_YOUR_DESTINATION',
    'EXIT_HIGHWAY_TO_LEFT', 'EXIT_HIGHWAY_TO_RIGHT']);
  const CLOCK_WINDOW_MS = 120000, MAX_TEXT = 60, MAX_DIST = 16, MAX_SECS = 360000;
  const MAX_KMH = 360;              // 100 m/s, the same ceiling as the glasses' own GPS filter
  const MAX_DOWN = 5600;            // characters in one phone → glasses payload; a sealed body is at most 4096 bytes
  const SID_SLIP_MS = 5000;         // a new sender session may start this far behind the last frame (a clock step)
  const GONE_MAX = 8;               // ended sender sessions remembered, so their frames can't come back
  const enc = (s) => new TextEncoder().encode(s);

  function fromB64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toB64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // The address: ?t=…&p=… (or the same in the fragment). Only the shape is checked here; a key that isn't
  // a real P-256 point fails later, at import.
  function readAddress(search, hash) {
    const q = new URLSearchParams(search || '');
    for (const [k, v] of new URLSearchParams(String(hash || '').replace(/^#/, ''))) q.set(k, v);
    const t = q.get('t'), p = q.get('p');
    if (!t || !p || !TOPIC_RE.test(t) || !KEY_RE.test(p)) return null;
    try { if (fromB64url(p)[0] !== 4) return null; } catch (e) { return null; }
    return { t, p };
  }

  async function deviceId(subtle, devPub) {
    return toB64url(new Uint8Array(await subtle.digest('SHA-256', devPub))).slice(0, 16);
  }

  async function pairCode(subtle, devPub) {
    const label = enc(PAIR_LABEL), data = new Uint8Array(label.length + devPub.length);
    data.set(label, 0); data.set(devPub, label.length);
    const h = new Uint8Array(await subtle.digest('SHA-256', data));
    const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
    return String(n % 1000000).padStart(6, '0');
  }

  // up: glasses → phone (encrypt here), down: phone → glasses (decrypt here).
  async function deriveKeys(subtle, devPriv, phonePubRaw, t, devId, uses = { up: ['encrypt'], down: ['decrypt'] }) {
    const phone = await subtle.importKey('raw', phonePubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: phone }, devPriv, 256);
    const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const derive = (dir) => subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc(SALT), info: enc(`${dir}|${devId}|${t}`) },
      ikm, { name: 'AES-GCM', length: 256 }, false, uses[dir]);
    return { up: await derive('up'), down: await derive('down') };
  }

  async function seal(subtle, key, obj, iv) {
    const nonce = iv || crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0); out.set(ct, 12);
    return toB64url(out);
  }

  async function open(subtle, key, sealed) {
    const raw = fromB64url(sealed);
    if (raw.length < 12 + 16 + 2 || raw.length > 4096) return null;
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  }

  // phone → glasses payload: "1.<sealed>". Anything else, or a failed tag, is null.
  async function openDown(subtle, key, text) {
    if (typeof text !== 'string' || text.length > MAX_DOWN) return null;
    const parts = text.trim().split('.');
    if (parts.length !== 2 || parts[0] !== '1' || !parts[1]) return null;
    try { return await open(subtle, key, parts[1]); } catch (e) { return null; }
  }

  async function sealUp(subtle, key, devPubB64, obj, iv) {
    return `1.${devPubB64}.${await seal(subtle, key, obj, iv)}`;
  }

  const clean = (s, max) => typeof s === 'string'
    ? s.replace(/[​-‏‪-‮⁠-⁩﻿]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/[^\S ]+/g, ' ').trim().slice(0, max)
    : '';

  // The phone's own GPS speed and heading (LINK.md, "Speed and heading"): whole km/h 0 to 360 and a heading 0 to
  // 359 or null. Anything else is dropped as a whole, never repaired. It never holds a position.
  function cleanGps(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    if (!Number.isSafeInteger(g.kmh) || g.kmh < 0 || g.kmh > MAX_KMH) return null;
    return { kmh: g.kmh, hdg: Number.isSafeInteger(g.hdg) && g.hdg >= 0 && g.hdg < 360 ? g.hdg : null };
  }

  // A directions frame, checked field by field. Returns {ok:false, why} or {ok:true, frame, last}.
  // last: {sid, seq, at, gone} after the newest accepted frame, or null; keep r.last for the next call.
  // hellos: the ids of this page's recent hellos. A frame must name one (re), so frames recorded before
  // the page opened can't be played back to it.
  function checkNav(m, now, last, hellos) {
    if (!m || m.m !== 'nav') return { ok: false, why: 'type' };
    if (typeof m.sid !== 'string' || !ID_RE.test(m.sid)) return { ok: false, why: 'sid' };
    if (!Number.isSafeInteger(m.seq) || m.seq < 0) return { ok: false, why: 'seq' };
    if (!Number.isFinite(m.at) || Math.abs(now - m.at) > CLOCK_WINDOW_MS) return { ok: false, why: 'clock' };
    if (typeof m.re !== 'string' || !Array.isArray(hellos) || !hellos.includes(m.re)) return { ok: false, why: 're' };
    let gone = last && Array.isArray(last.gone) ? last.gone : [];
    if (last) {
      if (m.sid === last.sid) {
        if (m.seq <= last.seq) return { ok: false, why: 'old' };
      } else {
        if (gone.includes(m.sid) || m.at < last.at - SID_SLIP_MS) return { ok: false, why: 'old' };
        gone = gone.concat(last.sid).slice(-GONE_MAX);
      }
    }
    const next = { sid: m.sid, seq: m.seq, at: m.at, gone };
    const gps = cleanGps(m.gps);   // a bad gps never costs the directions
    if (m.nav === null) return { ok: true, frame: { sid: m.sid, seq: m.seq, at: m.at, nav: null, gps }, last: next };
    const n = m.nav;
    if (!n || typeof n !== 'object' || Array.isArray(n)) return { ok: false, why: 'nav' };
    if (!STATES.includes(n.ss)) return { ok: false, why: 'state' };
    const secs = Number.isSafeInteger(n.secs) && n.secs >= 0 && n.secs <= MAX_SECS ? n.secs : null;
    const pct = Number.isFinite(n.pct) && n.pct >= 0 && n.pct <= 100 ? n.pct : null;
    const exit = Number.isSafeInteger(n.exit) && n.exit >= 0 && n.exit <= 20 ? n.exit : 0;
    return {
      ok: true,
      frame: {
        sid: m.sid, seq: m.seq, at: m.at,
        nav: {
          ss: n.ss, turn: TURNS.includes(n.turn) ? n.turn : null, exit,
          toTurn: clean(n.toTurn, MAX_DIST), left: clean(n.left, MAX_DIST),
          next: clean(n.next, MAX_TEXT), street: clean(n.street, MAX_TEXT),
          secs, pct, sim: n.sim === true,
        },
        gps,
      },
      last: next,
    };
  }

  // A pair reply always names the hello it answers (re); the page drops one that names none of its own.
  function checkPair(m) {
    if (!m || m.m !== 'pair' || typeof m.ok !== 'boolean') return null;
    if (typeof m.code !== 'string' || !/^\d{6}$/.test(m.code)) return null;
    if (typeof m.re !== 'string' || !ID_RE.test(m.re)) return null;
    return { ok: m.ok, code: m.code, re: m.re };
  }

  // What the screen should say about a route state.
  function phase(ss) {
    if (['OnRoute', 'OffRoute', 'RouteRebuilding', 'RouteNeedsRebuild'].includes(ss)) return 'guide';
    if (ss === 'RouteNotStarted') return 'ready';
    if (ss === 'RouteFinished') return 'arrived';
    if (ss === 'RouteBuilding') return 'building';
    return 'none';
  }

  const api = Object.freeze({
    SALT, PAIR_LABEL, STATES, TURNS, CLOCK_WINDOW_MS, MAX_DOWN,
    fromB64url, toB64url, readAddress, deviceId, pairCode, deriveKeys, seal, open, openDown, sealUp, checkNav,
    checkPair, phase, clean, cleanGps,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveLinkCore = api;
})(globalThis);
