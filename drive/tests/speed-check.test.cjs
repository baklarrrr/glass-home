'use strict';
// The speed self-check (drive/speed-check.js): which source the speed comes from, and the plain line when there is
// none and nothing healthy behind it. Pure code, no browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../speed-check.js');

const at = (over) => SC.check({ phoneFresh: false, gpsStatus: 'off', link: 'none', ...over });
// Faults that stay put until something is done or the signal returns, and so deserve the amber line.
const HARD = ['denied', 'unsupported', 'stale', 'timeout', 'disconnected'];
// Readings that come and go by themselves (rough, no speed while parked, unusable) and statuses nobody has heard of: calm.
const SOFT = ['inaccurate', 'unavailable', 'invalid', 'something-new'];
const NOT_HEALTHY = SC.ALL.filter((l) => !SC.HEALTHY.includes(l));

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
  assert.equal(at({ gpsStatus: 'denied', link: 'none' }).text, 'Glasses location not allowed\nPair your phone when parked');
  assert.equal(at({ gpsStatus: 'denied', link: 'pairing' }).text, 'Glasses location not allowed\nCompare the code on your phone');
  assert.equal(at({ gpsStatus: 'denied', link: 'stopped' }).text, 'Glasses location not allowed\nResume the phone link');
  assert.equal(at({ gpsStatus: 'denied', link: 'unavailable' }).text, 'Glasses location not allowed\nPhone link unavailable');
  assert.equal(at({ gpsStatus: 'denied', link: 'paused' }).text, 'Glasses location not allowed\nPhone not answering');
  assert.equal(at({ gpsStatus: 'denied', link: 'nosignal' }).text, 'Glasses location not allowed\nNo signal to phone');
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
  assert.equal(at({ gpsStatus: 'unsupported', link: 'none' }).text, 'This app gets no location\nPair your phone when parked');
  assert.equal(at({ gpsStatus: 'unsupported', link: 'paused' }).level, 'warn');
  assert.equal(at({ gpsStatus: 'unsupported', link: 'live' }).text, '');
});

test('each hard GPS fault is named as it is, and what backs it up follows', () => {
  const words = { stale: 'GPS speed lost', timeout: 'GPS timed out', disconnected: 'No GPS fix' };
  for (const [gpsStatus, fault] of Object.entries(words)) {
    const r = at({ gpsStatus, link: 'none' });
    assert.deepEqual([r.level, r.text], ['warn', `${fault}\nPair your phone when parked`], gpsStatus);
    assert.equal(at({ gpsStatus, link: 'paused' }).text, `${fault}\nPhone not answering`, gpsStatus);
    assert.equal(at({ gpsStatus, link: 'live' }).text, '', `${gpsStatus}: the phone is up, so no warning on top`);
  }
});

test('a reading that comes and goes by itself, and a status nobody knows, never raise the alarm', () => {
  for (const gpsStatus of SOFT) for (const link of SC.ALL) {
    const r = at({ gpsStatus, link });
    assert.deepEqual([r.level, r.text, r.short], ['wait', '', ''], `${gpsStatus} / ${link}`);
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
  for (const gpsStatus of HARD) for (const link of SC.ALL) {
    const t = at({ gpsStatus, link }).text;
    if (!t) continue;   // a phone that is linked or being found: no warning
    const lines = t.split('\n');
    assert.equal(lines.length, 2, t);
    for (const l of lines) assert.ok(l.length <= 32, `${l} (${l.length})`);
  }
});

test('the corner beside directions says the same thing in lines short enough for its 250 px', () => {
  const compact = { denied: 'Glasses GPS refused', unsupported: 'No GPS in this app' };
  for (const gpsStatus of HARD) {
    // Directions are on screen only while the phone link is live or paused (no signal is the same silence), so the second line there is one of two.
    for (const [link, second] of [['paused', 'Phone not answering'], ['nosignal', 'No signal to phone']]) {
      const r = at({ gpsStatus, link });
      const [first, again, ...more] = r.short.split('\n');
      assert.deepEqual(more, [], r.short);
      assert.ok(first.length <= 20, `${first} (${first.length})`);
      assert.equal(again, second);
      assert.ok(again.length <= 20, again);
      // the corner names the same fault as the whole-screen line: identical, except the two that are too long for it
      assert.equal(first, compact[gpsStatus] || r.text.split('\n')[0], `${gpsStatus}: ${r.text} / ${r.short}`);
    }
  }
  assert.equal(at({ gpsStatus: 'denied', link: 'paused' }).short, 'Glasses GPS refused\nPhone not answering');
  assert.equal(at({ gpsStatus: 'unsupported', link: 'nosignal' }).short, 'No GPS in this app\nNo signal to phone');
  // quiet states have no corner line either
  for (const link of SC.HEALTHY) assert.equal(at({ gpsStatus: 'denied', link }).short, '');
  assert.equal(at({ phoneFresh: true, gpsStatus: 'denied', link: 'paused' }).short, '');
  assert.equal(at({ gpsStatus: 'live', link: 'paused' }).short, '');
});

test('nothing in the vocabulary tells a wearer to do something on the phone without saying when', () => {
  for (const l of NOT_HEALTHY) {
    const w = SC.backup(l);
    assert.ok(!/^(pair|accept|open|set up)\b/i.test(w) || /parked/.test(w), `${l}: ${w}`);
  }
});

test('Studio Drive link states map to the shared words', () => {
  const m = (state, over) => SC.fromStudio({ configured: true, enabled: true, state, ...over });
  assert.equal(SC.fromStudio(null), 'none');
  assert.equal(SC.fromStudio({ configured: false, enabled: true, state: 'unpaired' }), 'none');
  assert.equal(SC.fromStudio({ configured: false, enabled: true, state: 'unavailable', problem: 'Secure phone link unavailable in this app' }), 'unavailable', 'nothing to pair when the link cannot run here');
  assert.equal(m('off', { enabled: false }), 'stopped');
  assert.equal(m('off'), 'stopped');
  for (const s of ['live', 'ready', 'no-sample', 'stale']) assert.equal(m(s), 'live', s);
  for (const s of ['pairing', 'waiting', 'connecting', 'unavailable']) assert.equal(m(s), s, s);
  assert.equal(m('offline'), 'nosignal');
  assert.equal(m('paused'), 'connecting', 'the Drive tab is not on screen: not a fault');
  assert.equal(m('something-new'), 'connecting', 'a state nobody knows is not a fault');
  for (const s of ['off', 'live', 'ready', 'no-sample', 'stale', 'pairing', 'waiting', 'connecting', 'offline', 'paused', 'unavailable', 'x']) {
    assert.ok(SC.ALL.includes(m(s)), s);
  }
});

test('the module is frozen and the healthy set is part of the vocabulary', () => {
  assert.ok(Object.isFrozen(SC));
  for (const h of SC.HEALTHY) assert.ok(SC.ALL.includes(h), h);
});
