'use strict';
// node --test tests/link-core.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../link-core.js');
const V = require('./vectors.json');
const subtle = globalThis.crypto.subtle;
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

async function deviceKeys() {
  const priv = await subtle.importKey('pkcs8', L.fromB64url(V.device.pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return L.deriveKeys(subtle, priv, L.fromB64url(V.phone.pub), V.t, V.device.id, { up: ['encrypt', 'decrypt'], down: ['encrypt', 'decrypt'] });
}

test('device id and pairing code match the vectors', async () => {
  const pub = L.fromB64url(V.device.pub);
  assert.equal(await L.deviceId(subtle, pub), V.device.id);
  const code = await L.pairCode(subtle, pub);
  assert.equal(code, V.device.code);
  assert.match(code, /^\d{6}$/);
});

test('the glasses derive the same keys and the same sealed bytes', async () => {
  const k = await deviceKeys();
  assert.equal(await L.sealUp(subtle, k.up, V.device.pub, JSON.parse(V.hello.plain), unhex(V.hello.ivHex)), V.hello.payload);
  assert.deepEqual(await L.openDown(subtle, k.down, V.nav.payload), JSON.parse(V.nav.plain));
  assert.deepEqual(await L.openDown(subtle, k.down, V.pair.payload), JSON.parse(V.pair.plain));
  assert.equal('1.' + await L.seal(subtle, k.down, JSON.parse(V.nav.plain), unhex(V.nav.ivHex)), V.nav.payload);
  // The sample frame answers the sample hello, so it passes every check at its own time.
  const at = JSON.parse(V.nav.plain).at, helloId = JSON.parse(V.hello.plain).id;
  assert.equal(L.checkNav(JSON.parse(V.nav.plain), at, null, [helloId]).ok, true);
  assert.notEqual(L.checkPair(JSON.parse(V.pair.plain)), null);
});

test('a wrong key, a changed byte or the wrong shape opens to nothing', async () => {
  const k = await deviceKeys();
  assert.equal(await L.openDown(subtle, k.up, V.nav.payload), null);            // up key can't read down
  const body = V.nav.payload.slice(2), flip = (body[20] === 'A' ? 'B' : 'A');
  assert.equal(await L.openDown(subtle, k.down, '1.' + body.slice(0, 20) + flip + body.slice(21)), null);
  assert.equal(await L.openDown(subtle, k.down, '2.' + body), null);
  assert.equal(await L.openDown(subtle, k.down, V.hello.payload), null);        // three parts is the up shape
  assert.equal(await L.openDown(subtle, k.down, '1.***'), null);
  assert.equal(await L.openDown(subtle, k.down, '1.' + 'A'.repeat(6000)), null);
});

test('address: query or fragment, shape checked', () => {
  const p = V.phone.pub, t = V.t;
  assert.deepEqual(L.readAddress(`?t=${t}&p=${p}`, ''), { t, p });
  assert.deepEqual(L.readAddress('', `#t=${t}&p=${p}`), { t, p });
  assert.equal(L.readAddress(`?t=short&p=${p}`, ''), null);
  assert.equal(L.readAddress(`?t=${t}&p=${p.slice(1)}`, ''), null);
  assert.equal(L.readAddress(`?t=${t}`, ''), null);
  assert.equal(L.readAddress(`?t=${t}&p=A${p.slice(1)}`, ''), null);           // not an uncompressed point
  assert.equal(L.readAddress('', ''), null);
});

const NOW = 1793580000000;
const HELLOS = ['AbCdEfGhIjKl'];
const frame = (over = {}, nav = {}) => ({ m: 'nav', sid: 'Zx81kq2mP0aa', seq: 7, at: NOW, re: 'AbCdEfGhIjKl', ...over,
  nav: over.nav === null ? null : { ss: 'OnRoute', turn: 'TURN_LEFT', exit: 0, toTurn: '200 m', next: 'Queen St', street: 'Bay St', left: '3 km', secs: 300, pct: 50, sim: false, ...nav } });
const nav = (m, last = null) => L.checkNav(m, NOW, last, HELLOS);

test('directions frames are checked field by field', () => {
  assert.equal(nav(frame()).ok, true);
  assert.equal(nav(frame({ nav: null })).frame.nav, null);
  assert.equal(nav(frame({ m: 'x' })).why, 'type');
  assert.equal(nav(frame({ sid: 'bad id!' })).why, 'sid');
  assert.equal(nav(frame({ seq: -1 })).why, 'seq');
  assert.equal(nav(frame({ seq: 1.5 })).why, 'seq');
  assert.equal(nav(frame({ at: NOW - 121000 })).why, 'clock');
  assert.equal(nav(frame({ at: NOW + 121000 })).why, 'clock');
  assert.equal(nav(frame({}, { ss: 'Driving' })).why, 'state');
  assert.equal(nav(frame({}, { turn: 'JUMP' })).frame.nav.turn, null);
  assert.equal(nav(frame({}, { secs: -5 })).frame.nav.secs, null);
  assert.equal(nav(frame({}, { secs: 400000 })).frame.nav.secs, null);
  assert.equal(nav(frame({}, { pct: 101 })).frame.nav.pct, null);
  assert.equal(nav(frame({}, { exit: 99 })).frame.nav.exit, 0);
  assert.equal(nav(frame({}, { sim: 'yes' })).frame.nav.sim, false);
});

test('the phone\'s speed and heading ride on a frame, checked on arrival', () => {
  const g = (gps, over = {}) => nav(frame({ gps, ...over })).frame.gps;
  assert.deepEqual(g({ kmh: 50, hdg: 90 }), { kmh: 50, hdg: 90 });
  assert.deepEqual(g({ kmh: 0, hdg: null }), { kmh: 0, hdg: null });               // a measured zero stays zero
  assert.deepEqual(g({ kmh: 360, hdg: 359 }), { kmh: 360, hdg: 359 });
  assert.equal(nav(frame()).frame.gps, null);                                       // none sent: none shown
  assert.equal(g(null), null);
  assert.equal(g({ kmh: -1, hdg: 0 }), null);
  assert.equal(g({ kmh: 361, hdg: 0 }), null);
  assert.equal(g({ kmh: 50.5, hdg: 0 }), null);
  assert.equal(g({ kmh: '50', hdg: 0 }), null);
  assert.equal(g({ hdg: 90 }), null);
  assert.equal(g([50, 90]), null);
  assert.equal(g('fast'), null);
  assert.deepEqual(g({ kmh: 50, hdg: 360 }), { kmh: 50, hdg: null });               // a bad heading costs only the heading
  assert.deepEqual(g({ kmh: 50, hdg: -3 }), { kmh: 50, hdg: null });
  assert.deepEqual(g({ kmh: 50, hdg: 12.5 }), { kmh: 50, hdg: null });
  assert.deepEqual(g({ kmh: 50 }), { kmh: 50, hdg: null });
  assert.deepEqual(g({ kmh: 50, hdg: 90, lat: 43.6, lon: -79.3 }), { kmh: 50, hdg: 90 });   // nothing else is ever passed on
  // With no route the speed still arrives; a bad gps never costs the directions.
  assert.deepEqual(nav(frame({ nav: null, gps: { kmh: 83, hdg: 270 } })).frame, { sid: 'Zx81kq2mP0aa', seq: 7, at: NOW, nav: null, gps: { kmh: 83, hdg: 270 } });
  assert.equal(nav(frame({ gps: { kmh: 'x' } })).ok, true);
  assert.equal(nav(frame({ nav: null, gps: 7 })).ok, true);
});

test('a frame must answer one of this page\'s own hellos', () => {
  assert.equal(nav(frame({ re: undefined })).why, 're');
  assert.equal(nav(frame({ re: 'SomeOtherId1' })).why, 're');                  // recorded before the page opened
  assert.equal(L.checkNav(frame(), NOW, null, []).why, 're');                  // no hello sent yet
  assert.equal(L.checkNav(frame(), NOW, null).why, 're');                      // no list given
  assert.equal(nav(frame({ re: 42 })).why, 're');
});

test('repeats and replays are dropped', () => {
  const first = nav(frame());
  assert.deepEqual(first.last, { sid: 'Zx81kq2mP0aa', seq: 7, at: NOW, gone: [] });
  const last = first.last;
  assert.equal(nav(frame({ seq: 7 }), last).why, 'old');
  assert.equal(nav(frame({ seq: 6 }), last).why, 'old');
  assert.equal(nav(frame({ seq: 8 }), last).ok, true);
  assert.equal(nav(frame({ sid: 'OtherSess01', seq: 0, at: NOW - 6000 }), last).why, 'old');
  const moved = nav(frame({ sid: 'OtherSess01', seq: 0, at: NOW + 1 }), last);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.last.gone, ['Zx81kq2mP0aa']);
  // The ended session can't come back, however new its frame claims to be.
  assert.equal(nav(frame({ seq: 999, at: NOW + 2000 }), moved.last).why, 'old');
  // Only the last eight ended sessions are remembered.
  let l = moved.last;
  for (let i = 0; i < 10; i++) l = nav(frame({ sid: `Session${String(i).padStart(4, '0')}`, seq: 0, at: NOW + 10 + i }), l).last;
  assert.equal(l.gone.length, 8);
  assert.equal(l.gone.includes('Session0008'), true);
});

test('an oversized payload is dropped before any work', async () => {
  const k = await deviceKeys();
  assert.equal(await L.openDown(subtle, k.down, '1.' + 'A'.repeat(L.MAX_DOWN)), null);
  assert.equal(await L.openDown(subtle, k.down, { toString: () => V.nav.payload }), null);   // not a string
  assert.equal(L.MAX_DOWN, 5600);
});

test('text is cleaned: control and direction-override characters out, lengths capped', () => {
  const f = nav(frame({}, { next: 'King\u0000 St‮ W\n' + 'x'.repeat(100), toTurn: '350 m' + '9'.repeat(30) })).frame.nav;
  assert.equal(f.next.startsWith('King St W x'), true);
  assert.equal(f.next.length, 60);
  assert.equal(f.toTurn.length, 16);
  assert.equal(nav(frame({}, { next: 42 })).frame.nav.next, '');
});

test('pair replies must name a hello', () => {
  assert.deepEqual(L.checkPair({ m: 'pair', ok: false, code: '012345', re: 'AbCdEfGhIjKl' }), { ok: false, code: '012345', re: 'AbCdEfGhIjKl' });
  assert.equal(L.checkPair({ m: 'pair', ok: false, code: '012345' }), null);
  assert.equal(L.checkPair({ m: 'pair', ok: false, code: '012345', re: 'x' }), null);
  assert.equal(L.checkPair({ m: 'pair', ok: 'no', code: '012345', re: 'AbCdEfGhIjKl' }), null);
  assert.equal(L.checkPair({ m: 'pair', ok: true, code: '12345', re: 'AbCdEfGhIjKl' }), null);
});

test('route phases', () => {
  assert.equal(L.phase('OnRoute'), 'guide');
  assert.equal(L.phase('OffRoute'), 'guide');
  assert.equal(L.phase('RouteNotStarted'), 'ready');
  assert.equal(L.phase('RouteFinished'), 'arrived');
  assert.equal(L.phase('NoValidRoute'), 'none');
  assert.equal(L.STATES.length, 9);
  assert.equal(L.TURNS.length, 17);
});
