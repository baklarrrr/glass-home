'use strict';
// The speed self-check (drive/speed-check.js): which source the speed comes from, and the plain line when there is
// none and nothing healthy behind it. Pure code, no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../speed-check.js');

const at = (over) => SC.check({ phoneFresh: false, gpsStatus: 'off', link: 'none', ...over });

test('the phone speed wins while it is fresh, and says nothing', () => {
  const r = at({ phoneFresh: true, gpsStatus: 'denied', link: 'live' });
  assert.deepEqual([r.source, r.level, r.text], ['phone', 'ok', '']);
  assert.equal(at({ phoneFresh: true, gpsStatus: 'live', link: 'none' }).source, 'phone');
});

test('the glasses speed is used when the phone has none, and says nothing', () => {
  const r = at({ gpsStatus: 'live', link: 'none' });
  assert.deepEqual([r.source, r.level, r.text], ['glasses', 'ok', '']);
});

test('a refused location with no phone behind it says so, and names the way out', () => {
  assert.equal(at({ gpsStatus: 'denied', link: 'none' }).text, 'Glasses location not allowed\nPair your phone');
  assert.equal(at({ gpsStatus: 'denied', link: 'pairing' }).text, 'Glasses location not allowed\nAccept the code on your phone');
  assert.equal(at({ gpsStatus: 'denied', link: 'stopped' }).text, 'Glasses location not allowed\nPhone link stopped');
  assert.equal(at({ gpsStatus: 'denied', link: 'unavailable' }).text, 'Glasses location not allowed\nPhone link unavailable');
  for (const link of ['offline', 'paused']) assert.equal(at({ gpsStatus: 'denied', link }).text, 'Glasses location not allowed\nPhone not answering');
  const r = at({ gpsStatus: 'denied', link: 'none' });
  assert.deepEqual([r.source, r.level, r.code], ['none', 'warn', 'denied']);
});

test('a refused location is not a warning while the phone is, or is about to be, the source', () => {
  for (const link of ['live', 'ready', 'waiting', 'connecting']) {
    const r = at({ gpsStatus: 'denied', link });
    assert.deepEqual([r.source, r.level, r.text], ['none', 'wait', ''], link);
  }
});

test('no location in this app is a warning too', () => {
  assert.equal(at({ gpsStatus: 'unsupported', link: 'none' }).text, 'This app gets no location\nPair your phone');
  assert.equal(at({ gpsStatus: 'unsupported', link: 'offline' }).level, 'warn');
  assert.equal(at({ gpsStatus: 'unsupported', link: 'live' }).text, '');
});

test('each GPS fault is named as it is, and what backs it up follows', () => {
  const words = { stale: 'GPS speed lost', timeout: 'GPS timed out', disconnected: 'No GPS fix', invalid: 'GPS reading unusable',
    inaccurate: 'GPS signal too weak', unavailable: 'GPS gives no speed', 'something-new': 'GPS not working' };
  for (const [gpsStatus, fault] of Object.entries(words)) {
    const r = at({ gpsStatus, link: 'none' });
    assert.deepEqual([r.level, r.text], ['warn', `${fault}\nPair your phone`], gpsStatus);
    assert.equal(at({ gpsStatus, link: 'offline' }).text, `${fault}\nPhone not answering`, gpsStatus);
    assert.equal(at({ gpsStatus, link: 'live' }).text, '', `${gpsStatus}: the phone is up, so no warning on top`);
  }
});

test('GPS that is off, paused or still asking is calm', () => {
  for (const gpsStatus of ['off', 'paused', 'waiting', 'no-response']) {
    for (const link of SC.ALL) {
      const r = at({ gpsStatus, link });
      assert.deepEqual([r.level, r.text], ['wait', ''], `${gpsStatus} / ${link}`);
    }
  }
});

test('every warning fits two lines of the 600 px screen at its largest size', () => {
  const statuses = ['denied', 'unsupported', 'stale', 'timeout', 'disconnected', 'invalid', 'inaccurate', 'unavailable'];
  for (const gpsStatus of statuses) for (const link of SC.ALL) {
    const t = at({ gpsStatus, link }).text;
    assert.ok(t.length <= 70, `${t} (${t.length})`);
  }
});

test('Studio Drive link states map to the shared words', () => {
  const m = (state, over) => SC.fromStudio({ configured: true, enabled: true, state, ...over });
  assert.equal(SC.fromStudio(null), 'none');
  assert.equal(SC.fromStudio({ configured: false, enabled: true, state: 'unpaired' }), 'none');
  assert.equal(m('off', { enabled: false }), 'stopped');
  assert.equal(m('off'), 'stopped');
  for (const s of ['live', 'ready', 'no-sample', 'stale']) assert.equal(m(s), 'live', s);
  for (const s of ['pairing', 'waiting', 'connecting', 'offline', 'paused', 'unavailable']) assert.equal(m(s), s, s);
  assert.equal(m('something-new'), 'offline');
  for (const s of ['off', 'live', 'ready', 'no-sample', 'stale', 'pairing', 'waiting', 'connecting', 'offline', 'paused', 'unavailable', 'x']) {
    assert.ok(SC.ALL.includes(m(s)), s);
  }
});

test('the module is frozen and the healthy set is part of the vocabulary', () => {
  assert.ok(Object.isFrozen(SC));
  for (const h of SC.HEALTHY) assert.ok(SC.ALL.includes(h), h);
});
