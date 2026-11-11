'use strict';
// Unit checks of drive/cameras.js (the warning) and tools/build-cameras.cjs (the list). Run: node --test drive/tests/cameras.test.cjs
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../cameras.js');
const B = require('../../tools/build-cameras.cjs');

// A made-up place. The car drives east along y = 0; cameras are placed in metres east and north of the start.
const LAT0 = 43.0, LON0 = -79.0, T0 = 1_800_000_000_000;
const at = (east, north) => [+(LAT0 + north / 110540).toFixed(7), +(LON0 + east / (Math.cos(LAT0 * Math.PI / 180) * 111320)).toFixed(7)];
const cam = (east, north, kind = 'r', limit) => (limit ? [...at(east, north), kind, limit] : [...at(east, north), kind]);
function watch(items) { const clock = { t: T0 }; const w = new C.Watch({ now: () => clock.t }); w.load({ made: '2026-11-11', items }); return { w, clock }; }
// One fix a second later: metres east/north, course in degrees (null: none), speed in metres a second.
const go = (h, east, north, course = 90, speed = 14, over = {}) => {
  h.clock.t += 1000; const [latitude, longitude] = at(east, north);
  h.w.fix({ timestamp: h.clock.t, coords: { latitude, longitude, accuracy: 8, ...over } }, course, speed);
  return h.w.snapshot();
};

test('index: keeps good entries, drops malformed ones, and an empty or missing list is harmless', () => {
  const ix = C.index({ made: '2026-11-11T00:00', items: [cam(0, 0), cam(10, 0, 's', 50), [91, 0, 'r'], [43, -79, 'x'], 'junk', [43, NaN, 'r'], cam(20, 0, 's', 900)] });
  assert.equal(ix.count, 3); assert.equal(ix.made, '2026-11-11');
  assert.equal(C.index(null).count, 0); assert.equal(C.index({ items: 'no' }).count, 0);
  const h = watch([]); assert.equal(go(h, 0, 0), null);
});

test('a red light camera ahead on this road is warned about, with the distance counting down', () => {
  const h = watch([cam(600, 5)]);
  assert.equal(go(h, 0, 0), null);                               // 600 m ahead at 50 km/h: beyond the 400 m reach
  const s = go(h, 250, 0);
  assert.equal(s.kind, 'r'); assert.ok(Math.abs(s.dist - 350) < 2);
  assert.deepEqual(C.words(s, 50), { text: 'Red light camera · 350 m', kind: 'r', limit: 0, over: false });
  assert.equal(C.words(go(h, 420, 0), 50).text, 'Red light camera · 180 m');
});

test('faster means earlier: the reach is 25 seconds of travel, capped at 1 km', () => {
  const h = watch([cam(700, 0)]);
  assert.equal(go(h, 0, 0, 90, 14), null);                       // 50 km/h: the reach is 400 m
  assert.ok(go(h, 20, 0, 90, 30));                               // 108 km/h: the reach is 750 m, and it is 680 m away
  const far = watch([cam(1100, 0)]);
  assert.equal(go(far, 0, 0, 90, 60), null);                     // never beyond 1 km
});

test('a camera on a parallel street, behind, or on a cross street away from the line of travel says nothing', () => {
  assert.equal(go(watch([cam(300, 150)]), 0, 0), null);          // one block over
  assert.equal(go(watch([cam(-200, 0)]), 0, 0), null);           // behind
  assert.equal(go(watch([cam(100, -300)]), 0, 0), null);         // down a side street
  assert.ok(go(watch([cam(300, 40)]), 0, 0));                    // the far side of a wide junction still counts
});

test('the warning stays through the stop line and the junction, and goes once the camera is behind', () => {
  const h = watch([cam(300, 0)]);
  assert.ok(go(h, 0, 0)); assert.ok(go(h, 260, 0));
  assert.ok(Math.abs(go(h, 290, 0).dist - 10) < 2);              // 10 m before it: still warned
  assert.ok(go(h, 310, 0));                                      // 10 m past the point: still in the junction
  assert.equal(go(h, 320, 0), null);                             // 20 m behind: gone
  assert.equal(go(h, 340, 0), null);
  const late = watch([cam(300, 0)]);
  assert.equal(go(late, 285, 0), null);                          // first seen 15 m away: too late to start on
});

test('holding a camera never hides a nearer one, and turning off the road drops it', () => {
  const two = watch([cam(380, 0), cam(700, 0)]);
  assert.ok(Math.abs(go(two, 0, 0).dist - 380) < 2);
  assert.ok(Math.abs(go(two, 385, 0).dist - 5) < 2);             // in the first junction: the first is still the one shown
  assert.ok(Math.abs(go(two, 400, 0).dist - 300) < 2);           // 20 m past it: the next one takes over at once
  const turn = watch([cam(300, 0)]);
  assert.ok(go(turn, 150, 0));
  assert.equal(go(turn, 200, 60, 0), null);                      // turned north onto a side street: it is no longer ahead
  assert.equal(go(turn, 200, 120, 0), null);
});

test('a camera marked as beside a motorway warns on the street, names the street, and is silent at motorway speed', () => {
  const marked = [...at(300, 20), 'r', 0, 1, 'Lake Shore'];
  const street = watch([marked]);
  const s = go(street, 0, 0, 90, 14);
  assert.equal(C.words(s, 50).text, 'Red light camera on Lake Shore · 300 m');
  const motorway = watch([marked]);
  assert.equal(go(motorway, 0, 0, 90, 27), null);                // 97 km/h: on the motorway above it
  assert.equal(go(motorway, 100, 0, 90, 27), null);
  const slowing = watch([marked]);
  assert.ok(go(slowing, 0, 0, 90, 14));
  assert.equal(go(slowing, 30, 0, 90, 25), null);                // back up to motorway speed: dropped
  assert.equal(C.words(go(watch([cam(300, 0)]), 0, 0), 50).text, 'Red light camera · 300 m');    // unmarked: no street
});

test('a rough fix widens the lane by 15 m at most', () => {
  assert.ok(go(watch([cam(300, 70)]), 0, 0, 90, 14, { accuracy: 40 }));       // 70 m to the side: inside 60 + 15
  assert.equal(go(watch([cam(300, 80)]), 0, 0, 90, 14, { accuracy: 40 }), null);
});

test('the list says what it covers and how old it is', () => {
  const clock = { t: Date.parse('2026-11-12T12:00:00Z') }, w = new C.Watch({ now: () => clock.t });
  assert.equal(w.about(), 'Cameras: list not loaded'); assert.equal(w.staleNote(), '');
  w.load({ made: '2026-11-11', region: 'Canada', redLightOnly: ['Ontario', 'Alberta'], items: [cam(0, 0), cam(500, 0)] });
  assert.equal(w.ageDays(), 1);
  assert.equal(w.about(), 'Cameras: 2 fixed sites, Canada only. Ontario and Alberta: red light cameras only. List of 2026-11-11. No mobile radar or police.');
  assert.equal(w.staleNote(), '');
  clock.t = Date.parse('2026-11-30T12:00:00Z');
  assert.match(w.about(), /List of 2026-11-11, 19 days old\./); assert.equal(w.staleNote(), '');
  clock.t = Date.parse('2026-12-15T12:00:00Z');
  assert.equal(w.staleNote(), 'Camera list 34 days old');
  w.load({ made: 'soon', items: [cam(0, 0)] });
  assert.equal(w.ageDays(), null); assert.equal(w.staleNote(), ''); assert.match(w.about(), /List of unknown date/);
});

test('the nearest of two cameras ahead is the one shown', () => {
  const h = watch([cam(380, 0, 's', 50), cam(200, 0)]);
  assert.equal(go(h, 0, 0).kind, 'r');
  assert.equal(go(h, 230, 0).kind, 's');
});

test('stopped at the light: the warning stays, and goes if the camera falls behind', () => {
  const h = watch([cam(300, 0)]);
  assert.ok(go(h, 200, 0));
  const held = go(h, 262, 0, null, 0);                            // stopped at the stop line, no course
  assert.ok(held && Math.abs(held.dist - 38) < 2);
  assert.ok(go(h, 263, 1, null, 0));                              // still there, a little scatter
  assert.equal(go(h, 180, 0, null, 0), null);                     // rolled back 80 m: it is no longer the one ahead
  assert.equal(go(watch([cam(300, 0)]), 200, 0, null, 0), null);  // never warned, no course: nothing to hold
});

test('a fix that is old, in the future, rough or malformed changes nothing; no fresh fix, no warning', () => {
  const h = watch([cam(300, 0)]);
  go(h, 0, 0);
  const before = h.w.snapshot().dist, now = h.clock.t;
  const p = (ts, over = {}) => { const [latitude, longitude] = at(200, 0); return { timestamp: ts, coords: { latitude, longitude, accuracy: 8, ...over } }; };
  h.w.fix(p(now - 6000), 90, 14); h.w.fix(p(now + 5000), 90, 14); h.w.fix(p(now, { accuracy: 90 }), 90, 14); h.w.fix(p(now, { latitude: NaN }), 90, 14); h.w.fix(null, 90, 14);
  assert.equal(h.w.snapshot().dist, before);
  h.clock.t += C.FIX_MAX_AGE_MS;
  assert.equal(h.w.snapshot(), null);
});

test('words: a speed camera says its limit when the map has one, and whether the speed shown is over it', () => {
  assert.deepEqual(C.words({ kind: 's', dist: 420, limit: 50 }, 63), { text: 'Speed camera · limit 50 · 400 m', kind: 's', limit: 50, over: true });
  assert.equal(C.words({ kind: 's', dist: 420, limit: 50 }, 50).over, false);
  assert.deepEqual(C.words({ kind: 's', dist: 90, limit: 0 }, 80), { text: 'Speed camera · 90 m', kind: 's', limit: 0, over: false });
  assert.equal(C.words({ kind: 'r', dist: 1200, limit: 60 }, 90).text, 'Red light camera · 1.2 km');
  assert.equal(C.words(null, 50), null);
});

test('builder: Toronto first, one entry per site, no speed cameras where the law ended them, motorway marks', () => {
  const node = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, ...(tags ? { tags } : {}) });
  const rel = (id, enforcement, devices, tags = {}) => ({ type: 'relation', id, tags: { type: 'enforcement', enforcement, ...tags }, members: devices.map((ref) => ({ type: 'node', ref, role: 'device' })) });
  const toronto = [{ geometry: JSON.stringify({ type: 'Point', coordinates: [-79.5, 43.7] }) }, { geometry: 'broken' }];
  const osm = [
    node(1, 43.70001, -79.50001), rel(101, 'traffic_signals', [1]),                 // the same Toronto site again: one entry
    node(2, 43.9, -79.4), rel(102, 'traffic_signals', [2]),                         // another Ontario red light camera: kept
    node(3, 44.0, -79.3), rel(103, 'maxspeed', [3], { maxspeed: '40' }),            // Ontario speed camera: left out
    node(4, 45.5, -73.6), rel(104, 'maxspeed', [4], { maxspeed: '50' }),            // Quebec speed camera: kept, with its limit
    node(5, 45.6, -73.7, { highway: 'speed_camera', maxspeed: '70 km/h' }),         // Quebec, a bare node: kept
    node(6, 43.6, -79.6, { highway: 'speed_camera' }),                              // Ontario, a bare node: left out
    node(7, 43.65, -79.47, { highway: 'speed_camera', note: 'red light camera' }),  // Ontario, mapped as a red light camera: kept
    node(8, 46.0, -74.0), rel(108, 'maxweight', [8]),                               // not a camera this warns about
    node(9, 43.8, -79.2), rel(109, 'traffic_signals;maxspeed', [9]),                // both, in Ontario: a red light camera
  ];
  toronto[0].street = 'LAKE SHORE BLVD W';
  const { items, counts } = B.combine(toronto, osm, new Set([1, 101, 2, 102, 3, 103, 6, 7, 9, 109]));
  assert.deepEqual(B.pack(items, items.map(() => false)), [[43.65, -79.47, 'r'], [43.7, -79.5, 'r'], [43.8, -79.2, 'r'], [43.9, -79.4, 'r'], [45.5, -73.6, 's', 50], [45.6, -73.7, 's', 70]]);
  assert.deepEqual(counts, { torontoRedLight: 1, osmRedLight: 3, osmSpeed: 2, speedLeftOutByLaw: 2, sameSite: 1, unusable: 1 });
  // Beside a motorway: marked, and named when the City gives the street.
  assert.deepEqual(B.pack(items, items.map((it, i) => i === 1 || i === 4 || i === 3)).filter((it) => it.length > 4), [[43.7, -79.5, 'r', 0, 1, 'Lake Shore'], [43.9, -79.4, 'r', 0, 1], [45.5, -73.6, 's', 50, 1]]);
  assert.deepEqual(['LAKE SHORE BLVD W', 'AVENUE RD', 'THE QUEENSWAY', 'STEELES AVE E', ''].map(B.shortStreet), ['Lake Shore', 'Avenue Rd', 'The Queensway', 'Steeles', '']);
});

test('the shipped list: well formed, and the warning runs on it', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cameras.json'), 'utf8'));
  assert.match(file.made, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(file.items.length > 300 && file.items.length < 20000, String(file.items.length));
  assert.equal(C.index(file).count, file.items.length);                            // every entry is usable
  assert.ok(file.items.filter((i) => i[2] === 'r').length >= 250);                 // Toronto alone has about 300
  assert.ok(file.sources.length === 2 && file.rules.length === 4);
  assert.deepEqual(file.redLightOnly, ['Ontario', 'Alberta']);
  const marked = file.items.filter((i) => i[4] === 1);
  assert.ok(marked.length >= 20 && marked.some((i) => i[5] === 'Lake Shore'), String(marked.length));   // the Gardiner runs over Lake Shore
  // Approaching the first camera in the list from 300 m south, heading north.
  const [lat, lon] = file.items[0], clock = { t: T0 }, w = new C.Watch({ now: () => clock.t });
  w.load(file);
  w.fix({ timestamp: T0, coords: { latitude: lat - 300 / 110540, longitude: lon, accuracy: 8 } }, 0, 14);
  const s = w.snapshot();
  assert.ok(s && Math.abs(s.dist - 300) < 3, JSON.stringify(s));
});
