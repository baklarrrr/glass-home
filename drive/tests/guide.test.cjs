'use strict';
// Unit checks of drive/guide.js: the compass tape and the saved-route guidance. Run: node --test drive/tests/guide.test.cjs
const { test } = require('node:test'), assert = require('node:assert/strict');
const G = require('../guide.js');

// A made-up L-shaped route in a made-up place: 1,000 m east along "First St", then 500 m north along "Second Ave".
const LAT0 = 43.0, LON0 = -79.0;
const at = (east, north) => [LAT0 + north / 110540, LON0 + east / (Math.cos(LAT0 * Math.PI / 180) * 111320)];
const T0 = 1_800_000_000_000;
const route = (over = {}) => ({ id: 'r1', ti: 'Depot', at: T0 / 1000 - 60, gm: 1500,
  gl: [at(0, 0), at(500, 0), at(1000, 0), at(1000, 500)],
  gs: [[0, 'Start on First St'], [1000, 'Turn left onto Second Ave'], [1500, 'Arrive']], ...over });
const fix = (east, north, now, over = {}) => { const [latitude, longitude] = at(east, north); return { timestamp: now, coords: { latitude, longitude, accuracy: 8, ...over } }; };
function guide() { const clock = { t: T0 }; const g = new G.Guide({ now: () => clock.t }); g.setRoute(route()); return { g, clock }; }

test('tape: no course, no tape', () => {
  for (const bad of [null, undefined, NaN, -1, 360, '90']) assert.equal(G.tape(bad), null);
});

test('tape: due east is centred on E with NE and SE either side', () => {
  const t = G.tape(90);
  assert.equal(t.text, '090°'); assert.equal(t.point, 'E');
  const labelled = t.ticks.filter((k) => k.label).map((k) => [k.label, Math.round(k.x * 100) / 100]);
  assert.deepEqual(labelled, [['NE', -0.9], ['E', 0], ['SE', 0.9]]);
  assert.ok(t.ticks.every((k) => k.x >= -1 && k.x <= 1));
});

test('tape: wraps through north without a gap', () => {
  const t = G.tape(350);
  assert.equal(t.text, '350°'); assert.equal(t.point, 'N');
  const north = t.ticks.find((k) => k.north);
  assert.ok(north && Math.abs(north.x - 0.2) < 1e-9);
  assert.equal(t.ticks.length, 7);
  assert.equal(G.tape(359.7).text, '000°');
});

test('prepare: refuses anything malformed or too old', () => {
  const now = T0 / 1000;
  assert.ok(G.prepare(route(), now));
  assert.equal(G.prepare(null, now), null);
  assert.equal(G.prepare(route({ gl: undefined }), now), null);              // a route saved before this feature
  assert.equal(G.prepare(route({ gl: [at(0, 0)] }), now), null);
  assert.equal(G.prepare(route({ gl: [at(0, 0), [NaN, 1]] }), now), null);
  assert.equal(G.prepare(route({ gl: [at(0, 0), [91, 0]] }), now), null);
  assert.equal(G.prepare(route({ gs: [[-1, 'x']] }), now), null);
  assert.equal(G.prepare(route({ gs: [[10, 5]] }), now), null);
  assert.equal(G.prepare(route({ at: now - G.ROUTE_MAX_AGE_S - 1 }), now), null);
  assert.equal(G.prepare(route({ at: now + 3600 }), now), null);
});

test('prepare: scales the turns onto the thinned outline', () => {
  const r = G.prepare(route({ gm: 3000, gs: [[2000, 'Turn left onto Second Ave']] }), T0 / 1000);
  assert.ok(Math.abs(r.total - 1500) < 2);
  assert.ok(Math.abs(r.steps[0].s - 1000) < 2);
});

test('guide: silent until a fix lands on the route', () => {
  const { g } = guide();
  assert.equal(g.snapshot().state, 'none');
  g.fix(fix(300, 900, T0));                      // 900 m north of First St: somewhere else
  assert.equal(g.snapshot().state, 'none');
  assert.deepEqual(G.words(g.snapshot()), { turn: '', note: '', level: 'ok' });
});

test('guide: next turn, distance to it and distance left', () => {
  const { g } = guide();
  g.fix(fix(650, 6, T0));
  const s = g.snapshot();
  assert.equal(s.state, 'on'); assert.equal(s.turn, 'Turn left onto Second Ave');
  assert.ok(Math.abs(s.toTurn - 350) < 3); assert.ok(Math.abs(s.left - 850) < 3);
  assert.deepEqual(G.words(s), { turn: '350 m · Turn left onto Second Ave', note: 'Saved route · no traffic · 850 m left', level: 'ok' });
});

test('guide: after the turn the next thing is the arrival', () => {
  const { g, clock } = guide();
  g.fix(fix(650, 0, T0));
  clock.t += 1000; g.fix(fix(1003, 200, clock.t));
  const s = g.snapshot();
  assert.equal(s.turn, 'Arrive'); assert.ok(Math.abs(s.toTurn - 300) < 3);
});

test('guide: a fix that is old, in the future, inaccurate or malformed changes nothing', () => {
  const { g, clock } = guide();
  g.fix(fix(100, 0, T0));
  const before = g.snapshot().toTurn;
  g.fix(fix(600, 0, T0 - 6000));
  g.fix(fix(600, 0, T0 + 5000));
  g.fix(fix(600, 0, T0, { accuracy: 80 }));
  g.fix(fix(600, 0, T0, { accuracy: NaN }));
  g.fix(fix(600, 0, T0, { latitude: NaN }));
  g.fix(null); g.fix({});
  assert.equal(g.snapshot().toTurn, before);
  assert.ok(clock.t === T0);
});

test('guide: no arrow from a stale fix', () => {
  const { g, clock } = guide();
  g.fix(fix(100, 0, T0));
  clock.t += G.FIX_MAX_AGE_MS;
  assert.equal(g.snapshot().state, 'paused');
  assert.equal(G.words(g.snapshot()).turn, 'Saved route paused');
  clock.t += 1000; g.fix(fix(200, 0, clock.t));
  assert.equal(g.snapshot().state, 'on');
});

test('guide: off the route only after three fixes in a row, and back on at once', () => {
  const { g, clock } = guide();
  g.fix(fix(400, 0, T0));
  for (let i = 0; i < 2; i++) { clock.t += 1000; g.fix(fix(420 + i * 10, 300, clock.t)); assert.equal(g.snapshot().state, 'on'); }
  clock.t += 1000; g.fix(fix(440, 300, clock.t));
  const s = g.snapshot();
  assert.equal(s.state, 'off'); assert.ok(Math.abs(s.away - 300) < 3);
  assert.deepEqual(G.words(s), { turn: 'Off the saved route', note: '300 m from it · no rerouting', level: 'warn' });
  clock.t += 1000; g.fix(fix(460, 5, clock.t));
  assert.equal(g.snapshot().state, 'on');
});

test('guide: gives up quietly when far off or off for long', () => {
  let { g, clock } = guide();
  g.fix(fix(400, 0, T0));
  clock.t += 1000; g.fix(fix(400, -(G.GIVE_UP_M + 100), clock.t));
  assert.equal(g.snapshot().state, 'none');
  ({ g, clock } = guide());
  g.fix(fix(400, 0, T0));
  clock.t += 1000; g.fix(fix(400, 400, clock.t));
  clock.t += G.GIVE_UP_MS + 1000; g.fix(fix(400, 400, clock.t));
  assert.equal(g.snapshot().state, 'none');
});

test('guide: arrival is said once and stays', () => {
  const { g, clock } = guide();
  g.fix(fix(1000, 300, T0));
  clock.t += 1000; g.fix(fix(1000, 480, clock.t));
  assert.equal(g.snapshot().state, 'arrived');
  assert.equal(G.words(g.snapshot()).turn, 'Arrived · Depot');
  clock.t += 60000; g.fix(fix(0, 0, clock.t));
  assert.equal(g.snapshot().state, 'arrived');
});

test('guide: the same route again keeps the place; a new one starts fresh', () => {
  const { g } = guide();
  g.fix(fix(650, 0, T0));
  g.setRoute(route());
  assert.equal(g.snapshot().state, 'on');
  g.setRoute(route({ id: 'r2' }));
  assert.equal(g.snapshot().state, 'none');
  g.setRoute(null);
  assert.equal(g.snapshot().state, 'none');
});

test('guide: a route that crosses itself keeps its place', () => {
  // Out 1,000 m east, loop north and back west, then south across the first leg at 500 m east.
  const clock = { t: T0 }, g = new G.Guide({ now: () => clock.t });
  g.setRoute(route({ gm: 2700, gl: [at(0, 0), at(1000, 0), at(1000, 400), at(500, 400), at(500, -400)],
    gs: [[1000, 'Turn left'], [1400, 'Turn left'], [1900, 'Turn left onto Cross St'], [2700, 'Arrive']] }));
  g.fix(fix(450, 0, T0));
  assert.ok(Math.abs(g.snapshot().toTurn - 550) < 3);          // first pass through the crossing: still heading east
  for (const [e, n] of [[1000, 200], [750, 400], [500, 200]]) { clock.t += 1000; g.fix(fix(e, n, clock.t)); }
  clock.t += 1000; g.fix(fix(500, 5, clock.t));                // second pass, now southbound
  const s = g.snapshot();
  assert.equal(s.turn, 'Arrive'); assert.ok(Math.abs(s.left - 405) < 5);
});

test('metres: rounded the way a driver reads them', () => {
  assert.deepEqual([4, 96, 194, 349, 960, 990, 1249, 9949, 12400].map(G.metres),
    ['10 m', '100 m', '190 m', '350 m', '950 m', '1.0 km', '1.2 km', '9.9 km', '12 km']);
  assert.equal(G.metres(NaN), ''); assert.equal(G.metres(-5), '');
});
