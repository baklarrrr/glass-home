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
// A fix: metres east and north of the start, moving at 50 km/h on `heading` (east unless said).
const fix = (east, north, now, over = {}) => { const [latitude, longitude] = at(east, north); return { timestamp: now, coords: { latitude, longitude, accuracy: 8, speed: 13.9, heading: 90, ...over } }; };
function guide(r = route()) { const clock = { t: T0 }; const g = new G.Guide({ now: () => clock.t }); g.setRoute(r); return { g, clock }; }
// One fix a second later.
const go = (h, east, north, over) => { h.clock.t += 1000; h.g.fix(fix(east, north, h.clock.t, over)); };
// Guidance starts after three fixes in a row on the line and going its way: drive the 20 m up to the given spot.
const join = (h, east, north = 0) => { for (let i = 2; i >= 0; i--) go(h, east - i * 10, north); };
const NORTH = { heading: 0 }, WEST = { heading: 270 };

test('tape: no course, no tape', () => {
  for (const bad of [null, undefined, NaN, -1, 360, '90']) assert.equal(G.tape(bad), null);
});

test('tape: due east is centred on E with NE and SE either side', () => {
  const t = G.tape(90);
  assert.equal(t.text, '090°'); assert.equal(t.point, 'E'); assert.equal(t.readout, 'E 090°');
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

test('guide: silent until the wearer is on the route', () => {
  const h = guide();
  assert.equal(h.g.snapshot().state, 'none');
  for (let i = 0; i < 4; i++) go(h, 300 + i * 10, 900);          // 900 m north of First St: somewhere else
  assert.equal(h.g.snapshot().state, 'none');
  assert.equal(G.words(h.g.snapshot()).turn, '');
});

test('guide: one or two fixes on the line do not start it; three going its way do', () => {
  const h = guide();
  go(h, 630, 0); go(h, 640, 0);
  assert.equal(h.g.snapshot().state, 'none');
  go(h, 650, 6);
  assert.equal(h.g.snapshot().state, 'on');
});

test('guide: crossing the route does not start it', () => {
  const h = guide();
  for (const n of [-30, -10, 10, 30]) go(h, 400, n, NORTH);      // straight across First St
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: driving the route the other way does not start it', () => {
  const h = guide();
  for (const e of [700, 680, 660, 640, 620]) go(h, e, 0, WEST);
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: with no course (slow or stopped) it does not start', () => {
  const h = guide();
  for (let i = 0; i < 5; i++) go(h, 650, 0, { heading: null, speed: 0.3 });
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: next turn, distance to it and distance to go', () => {
  const h = guide();
  join(h, 650, 6);
  const s = h.g.snapshot();
  assert.equal(s.state, 'on'); assert.equal(s.turn, 'Turn left · Second Ave');
  assert.ok(Math.abs(s.toTurn - 350) < 3); assert.ok(Math.abs(s.left - 850) < 3);
  assert.deepEqual(G.words(s), { dist: '350 m', near: false, turn: '350 m · Turn left · Second Ave', note: 'Saved route · not live · 850 m to go', level: 'ok' });
  go(h, 760, 0);
  assert.equal(G.words(h.g.snapshot()).near, true);              // under 300 m the distance is drawn larger
});

test('guide: after the turn the next thing is the destination, by name', () => {
  const h = guide();
  join(h, 650);
  go(h, 1003, 200, NORTH);
  const s = h.g.snapshot();
  assert.equal(s.turn, 'Arrive at Depot'); assert.ok(Math.abs(s.toTurn - 300) < 3);
  const nameless = guide(route({ ti: '' })); join(nameless, 650); go(nameless, 1003, 200, NORTH);
  assert.equal(nameless.g.snapshot().turn, 'Destination');
});

test('guide: a fix that is old, in the future, inaccurate or malformed changes nothing', () => {
  const h = guide();
  join(h, 100);
  const before = h.g.snapshot().toTurn, now = h.clock.t;
  h.g.fix(fix(600, 0, now - 6000));
  h.g.fix(fix(600, 0, now + 5000));
  h.g.fix(fix(600, 0, now, { accuracy: 80 }));
  h.g.fix(fix(600, 0, now, { accuracy: NaN }));
  h.g.fix(fix(600, 0, now, { latitude: NaN }));
  h.g.fix(null); h.g.fix({});
  assert.equal(h.g.snapshot().toTurn, before);
});

test('guide: no arrow from a stale fix', () => {
  const h = guide();
  join(h, 100);
  h.clock.t += G.FIX_MAX_AGE_MS;
  assert.equal(h.g.snapshot().state, 'paused');
  assert.equal(G.words(h.g.snapshot()).turn, 'Saved route paused');
  go(h, 200, 0);
  assert.equal(h.g.snapshot().state, 'on');
});

test('guide: off the route only after three fixes in a row, and back on at once', () => {
  const h = guide();
  join(h, 400);
  for (let i = 0; i < 2; i++) { go(h, 420 + i * 10, 300); assert.equal(h.g.snapshot().state, 'on'); }
  go(h, 440, 300);
  const s = h.g.snapshot();
  assert.equal(s.state, 'off'); assert.ok(Math.abs(s.away - 300) < 3);
  assert.deepEqual(G.words(s), { dist: '', near: false, turn: 'Off the saved route', note: '300 m from it · no rerouting', level: 'warn' });
  go(h, 460, 5);
  assert.equal(h.g.snapshot().state, 'on');
});

test('guide: gives up quietly when far off or off for long', () => {
  let h = guide();
  join(h, 400);
  go(h, 400, -(G.GIVE_UP_M + 100));
  assert.equal(h.g.snapshot().state, 'none');
  h = guide();
  join(h, 400);
  go(h, 400, 400);
  h.clock.t += G.GIVE_UP_MS; go(h, 400, 400);
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: turning back along the route stops it, and it stays stopped for this route', () => {
  const h = guide();
  join(h, 600);
  go(h, 590, 0, WEST); go(h, 580, 0, WEST);
  assert.equal(h.g.snapshot().state, 'on');                       // two fixes could be a U-turn in progress
  go(h, 570, 0, WEST);
  assert.equal(h.g.snapshot().state, 'none');
  join(h, 650);                                                   // the same saved route does not start again by itself
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: arrival is said, then goes after two minutes', () => {
  const h = guide();
  join(h, 1000 - 0, 0); go(h, 1000, 300, NORTH);
  go(h, 1000, 480, NORTH);
  assert.equal(h.g.snapshot().state, 'arrived');
  assert.equal(G.words(h.g.snapshot()).turn, 'Arrived · Depot');
  go(h, 1000, 490, { heading: null, speed: 0 });                  // parked at the door: still arrived
  assert.equal(h.g.snapshot().state, 'arrived');
  h.clock.t += G.ARRIVED_SHOW_MS;
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: arrival goes as soon as the wearer drives away, and does not come back', () => {
  const h = guide();
  join(h, 1000, 0); go(h, 1000, 300, NORTH); go(h, 1000, 480, NORTH);
  assert.equal(h.g.snapshot().state, 'arrived');
  go(h, 1000 + G.ARRIVED_LEAVE_M + 20, 500);
  assert.equal(h.g.snapshot().state, 'none');
  join(h, 650);
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: a route that goes old while the page is open stops guiding', () => {
  const h = guide();
  join(h, 650);
  h.clock.t += G.ROUTE_MAX_AGE_S * 1000;
  go(h, 660, 0);
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: the same route again keeps the place; a new one starts fresh', () => {
  const h = guide();
  join(h, 650);
  h.g.setRoute(route());
  assert.equal(h.g.snapshot().state, 'on');
  h.g.setRoute(route({ id: 'r2' }));
  assert.equal(h.g.snapshot().state, 'none');
  join(h, 700);
  assert.equal(h.g.snapshot().state, 'on');
  h.g.setRoute(null);
  assert.equal(h.g.snapshot().state, 'none');
});

test('guide: a route that crosses itself keeps its place', () => {
  // Out 1,000 m east, loop north and back west, then south across the first leg at 500 m east.
  const h = guide(route({ gm: 2700, gl: [at(0, 0), at(1000, 0), at(1000, 400), at(500, 400), at(500, -400)],
    gs: [[1000, 'Turn left'], [1400, 'Turn left'], [1900, 'Turn left onto Cross St'], [2700, 'Arrive']] }));
  join(h, 450);
  assert.ok(Math.abs(h.g.snapshot().toTurn - 550) < 3);          // first pass through the crossing: still heading east
  go(h, 1000, 200, NORTH); go(h, 750, 400, WEST); go(h, 500, 200, { heading: 180 });
  go(h, 500, 5, { heading: 180 });                               // second pass, now southbound
  const s = h.g.snapshot();
  assert.equal(s.turn, 'Arrive at Depot'); assert.ok(Math.abs(s.left - 405) < 5);
});

test('guide: out and back along the same road: after the U-turn it follows the way back', () => {
  // 1,000 m east, then back west along the same road to the start.
  const h = guide(route({ gm: 2000, gl: [at(0, 0), at(1000, 0), at(0, 0)], gs: [[0, 'Start'], [1000, 'Make a U-turn'], [2000, 'Arrive']] }));
  join(h, 700);
  assert.equal(h.g.snapshot().turn, 'Make a U-turn');
  go(h, 990, 0);
  for (const e of [900, 800, 700]) go(h, e, 0, WEST);            // now westbound on the return leg, same road
  const s = h.g.snapshot();
  assert.equal(s.state, 'on'); assert.equal(s.turn, 'Arrive at Depot'); assert.ok(Math.abs(s.left - 700) < 5);
});

test('clip: a long turn is cut between words, never inside a road number, and the cut is marked', () => {
  assert.equal(G.clip('Turn left onto King St W', 80), 'Turn left onto King St W');
  const long = 'Turn sharp left onto Regional Municipality Road 124 toward the Northern Industrial Distribution Centre';
  const cut = G.clip(long, 80);
  assert.ok(cut.length <= 81 && cut.endsWith('…') && long.startsWith(cut.slice(0, -1)));
  assert.ok(/ \S+…$/.test(cut) && long[cut.length - 1] === ' ', cut);          // ends on a whole word
  assert.equal(G.prepare(route({ gs: [[1000, 'Turn sharp left onto Regional Municipality Rd 124']] }), T0 / 1000).steps[0].t, 'Turn sharp left onto Regional Municipality Rd 124');
});

test('course: with no heading from the device it is worked out from movement, and goes when the car stops', () => {
  const h = guide(route({ id: 'none', gl: undefined }));          // no usable route: the course needs none
  const bare = { heading: null, speed: null };
  go(h, 0, 0, bare);
  assert.equal(h.g.course(), null);
  go(h, 14, 0, bare);
  assert.ok(Math.abs(h.g.course() - 90) < 1);
  go(h, 14, 14, bare);
  assert.ok(Math.abs(h.g.course() - 0) < 1 || Math.abs(h.g.course() - 360) < 1);
  go(h, 15, 15, bare);                                             // 1.4 m: scatter, not movement
  assert.ok(h.g.course() !== null);
  h.clock.t += G.FIX_MAX_AGE_MS;
  assert.equal(h.g.course(), null);                                // no fresh movement: no course, never an old one
  assert.equal(h.g.course({ heading: 200, speed: 10 }), 200);      // a reported heading always wins
  assert.equal(h.g.course({ heading: null, speed: 0.5 }), null);   // the device says stopped
});

test('guide: starts and follows the route on a runtime that reports no heading or speed', () => {
  const h = guide(), bare = { heading: null, speed: null };
  for (const e of [600, 615, 630, 645, 660]) go(h, e, 0, bare);
  const s = h.g.snapshot();
  assert.equal(s.state, 'on'); assert.ok(Math.abs(s.toTurn - 340) < 3);
});

test('speed: with none from the device it comes from the positions; scatter is standing still', () => {
  const h = guide(route({ id: 'none', gl: undefined })), bare = { heading: null, speed: null };
  const feed = (east, north) => { h.clock.t += 1000; const p = fix(east, north, h.clock.t, bare); h.g.fix(p); return h.g.fill(p); };
  assert.equal(feed(0, 0).coords.speed, null);                     // one fix: nothing to estimate, passed through as it came
  feed(14, 0);
  let seen = feed(28, 0);
  assert.ok(Math.abs(seen.coords.speed - 14) < 0.2, String(seen.coords.speed));    // 14 m a second: 50 km/h
  assert.ok(Math.abs(seen.coords.heading - 90) < 1);
  for (let i = 0; i < 7; i++) seen = feed(28 + (i % 2) * 2, i % 3);                 // parked: a couple of metres of scatter
  assert.equal(seen.coords.speed, 0); assert.equal(seen.coords.heading, null);
  const real = fix(0, 0, h.clock.t + 1000, { speed: 9, heading: 10 }); h.clock.t += 1000; h.g.fix(real);
  assert.equal(h.g.fill(real), real);                              // a reported speed is never replaced
  const zero = fix(0, 0, h.clock.t + 1000, { speed: 0, heading: null }); h.clock.t += 1000; h.g.fix(zero);
  assert.equal(h.g.fill(zero), zero);
  h.clock.t += G.FIX_MAX_AGE_MS;
  assert.equal(h.g.estimate(), null);                              // no fresh fix: no estimate
});

test('metres: rounded the way a driver reads them', () => {
  assert.deepEqual([4, 96, 194, 349, 960, 990, 1249, 9949, 12400].map(G.metres),
    ['10 m', '100 m', '190 m', '350 m', '950 m', '1.0 km', '1.2 km', '9.9 km', '12 km']);
  assert.equal(G.metres(NaN), ''); assert.equal(G.metres(-5), '');
});
