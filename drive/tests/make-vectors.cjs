'use strict';
// Makes tests/vectors.json: fixed test keys (never used for a real link) and sealed messages with fixed IVs,
// so the phone sender can prove it derives the same keys and the same bytes. Run: node tests/make-vectors.cjs
// It keeps the test keys and topic already in vectors.json; add --new for fresh ones.
const fs = require('fs'), path = require('path');
const L = require('../link-core.js');
const subtle = globalThis.crypto.subtle;
const hex = (b) => Buffer.from(b).toString('hex');
(async () => {
  const file = path.join(__dirname, 'vectors.json');
  const old = !process.argv.includes('--new') && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const EC = { name: 'ECDH', namedCurve: 'P-256' };
  const gen = () => subtle.generateKey(EC, true, ['deriveBits']);
  const load = async (k) => ({ privateKey: await subtle.importKey('pkcs8', L.fromB64url(k.pkcs8), EC, true, ['deriveBits']),
    publicKey: await subtle.importKey('raw', L.fromB64url(k.pub), EC, true, []) });
  const phone = old ? await load(old.phone) : await gen(), dev = old ? await load(old.device) : await gen();
  const phonePub = new Uint8Array(await subtle.exportKey('raw', phone.publicKey));
  const devPub = new Uint8Array(await subtle.exportKey('raw', dev.publicKey));
  const t = old ? old.t : L.toB64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const devId = await L.deviceId(subtle, devPub);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: phone.publicKey }, dev.privateKey, 256));
  // Extractable copies only so the vectors can show the derived bytes.
  const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const raw = async (dir) => new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(L.SALT), info: new TextEncoder().encode(`${dir}|${devId}|${t}`) }, ikm, 256));
  const upRaw = await raw('up'), downRaw = await raw('down');
  const key = (r) => subtle.importKey('raw', r, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const up = await key(upRaw), down = await key(downRaw);
  const ivA = Uint8Array.from({ length: 12 }, (_, i) => i + 1), ivB = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i), ivC = Uint8Array.from({ length: 12 }, (_, i) => 0x50 + i);
  const hello = { c: 'hello', id: 'AbCdEfGhIjKl', ts: 1793580000000, v: 1 };
  const nav = { m: 'nav', sid: 'Zx81kq2mP0aa', seq: 42, at: 1793580000000, re: 'AbCdEfGhIjKl',
    nav: { ss: 'OnRoute', turn: 'TURN_RIGHT', exit: 0, toTurn: '350 m', next: 'King St W', street: 'Bay St', left: '12 km', secs: 1380, pct: 41.5, sim: false } };
  const pair = { m: 'pair', ok: false, code: await L.pairCode(subtle, devPub), re: 'AbCdEfGhIjKl', at: 1793580000000 };
  const out = {
    about: 'Test keys only, never a real link. JSON plaintexts are exactly JSON.stringify of the objects (key order as written).',
    t, phone: { pkcs8: L.toB64url(new Uint8Array(await subtle.exportKey('pkcs8', phone.privateKey))), pub: L.toB64url(phonePub) },
    device: { pkcs8: L.toB64url(new Uint8Array(await subtle.exportKey('pkcs8', dev.privateKey))), pub: L.toB64url(devPub), id: devId, code: pair.code },
    sharedHex: hex(bits), upKeyHex: hex(upRaw), downKeyHex: hex(downRaw),
    hello: { plain: JSON.stringify(hello), ivHex: hex(ivA), payload: await L.sealUp(subtle, up, L.toB64url(devPub), hello, ivA), topic: `bkd/${t}/u` },
    nav: { plain: JSON.stringify(nav), ivHex: hex(ivB), payload: `1.${await L.seal(subtle, down, nav, ivB)}`, topic: `bkd/${t}/d/${devId}` },
    pair: { plain: JSON.stringify(pair), ivHex: hex(ivC), payload: `1.${await L.seal(subtle, down, pair, ivC)}`, topic: `bkd/${t}/d/${devId}` },
    address: `https://baklarrrr.github.io/glass-home/drive/?t=${t}&p=${L.toB64url(phonePub)}`,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log('wrote vectors.json; code', pair.code, 'devId', devId);
})();
