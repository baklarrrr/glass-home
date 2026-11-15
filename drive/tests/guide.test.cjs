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

test('sparse accurate fixes estimate a negative missing-speed sentinel; hiding clears the trail',()=>{
 const h=guide(),bare={heading:null,speed:-1};
 const a=fix(0,0,h.clock.t,bare);h.g.fix(a);assert.equal(h.g.fill(a).coords.speed,null);
 h.clock.t+=8000;
 const b=fix(80,0,h.clock.t,bare);h.g.fix(b);
 assert.ok(Math.abs(h.g.fill(b).coords.speed-10)<.2);
 h.g.clearMotion();assert.equal(h.g.estimate(),null);
});

// ---- on foot (15 Nov 2026): "Even my walking speed and running speed should be detected." Played locations only. ----
// A walker along a straight line, one fix every `every` ms with no speed or heading from the device, each fix scattered by
// a few metres the way a phone's GPS is (the same made-up scatter every run).
function walker(every = 1000) {
  const h = guide(route({ id: 'none', gl: undefined }));
  let east = 0, seed = 20261115;
  // The same made-up scatter every run (a small fixed random generator): up to 3 m either way on each axis, fix to fix.
  const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const jitter = () => [(rand() * 2 - 1) * 3, (rand() * 2 - 1) * 3];
  const step = (mps, over = {}) => {
    h.clock.t += every; east += mps * every / 1000;
    const [je, jn] = jitter(), p = fix(east + je, jn, h.clock.t, { speed: null, heading: null, accuracy: 8, ...over });
    h.g.fix(p); return h.g.fill(p).coords;
  };
  const run = (mps, seconds) => { const seen = []; for (let t = 0; t < seconds * 1000; t += every) seen.push(step(mps)); return seen; };
  return { h, step, run };
}
const kmh = (c) => (c.speed === null ? null : Math.round(c.speed * 3.6));

test('on foot: walking pace is shown, not 0 and not a dash, within a few seconds', () => {
  const w = walker(), seen = w.run(5 / 3.6, 60).map(kmh);       // 5 km/h for a minute
  const first = seen.findIndex((v) => v > 0);
  assert.ok(first >= 0 && first <= 8, `the first movement shows within 8 s (after ${first + 1} fixes)`);
  const settled = seen.slice(20);
  assert.ok(settled.every((v) => v >= 3 && v <= 7), `a believable walking speed once settled: ${settled.join(' ')}`);
  assert.ok(Math.max(...settled) - Math.min(...settled) <= 3, 'and it does not jump about');
});

test('on foot: slow walking, running and sparse fixes each give a believable speed', () => {
  const slow = walker().run(3.5 / 3.6, 60).map(kmh).slice(25);
  assert.ok(slow.every((v) => v >= 2 && v <= 5), `3.5 km/h: ${slow.join(' ')}`);
  const run = walker().run(12 / 3.6, 40).map(kmh).slice(10);
  assert.ok(run.every((v) => v >= 9 && v <= 15), `12 km/h: ${run.join(' ')}`);
  const sparse = walker(4000).run(5 / 3.6, 80).map(kmh).slice(5);          // a fix every four seconds
  assert.ok(sparse.every((v) => v >= 3 && v <= 7), `5 km/h, a fix every 4 s: ${sparse.join(' ')}`);
});

test('on foot: stop and go. Standing is 0 soon after stopping, and the next steps show again soon', () => {
  const w = walker();
  w.run(5 / 3.6, 40);
  const stopped = w.run(0, 30).map(kmh);
  const zeroAt = stopped.findIndex((v) => v === 0);
  assert.ok(zeroAt >= 0 && zeroAt <= 12, `0 within 12 s of stopping (${stopped.join(' ')})`);
  assert.ok(stopped.slice(zeroAt).every((v) => v === 0), 'and it stays 0: scatter while standing is not walking');
  const again = w.run(5 / 3.6, 30).map(kmh);
  const moveAt = again.findIndex((v) => v > 0);
  assert.ok(moveAt >= 0 && moveAt <= 8, `moving again shows within 8 s (${again.join(' ')})`);
  assert.ok(again.slice(20).every((v) => v >= 3 && v <= 7));
});

test('on foot: standing still from the start is 0, however long, never a walking speed', () => {
  const seen = walker().run(0, 120).map(kmh);
  assert.equal(seen[0], null);                                      // one fix: nothing to compare with yet
  assert.ok(seen.slice(2).every((v) => v === 0), seen.join(' '));
});

test('on foot, then driving: the car speed shows at once, with no smoothing holding it down', () => {
  const w = walker();
  w.run(5 / 3.6, 30);
  const car = w.run(14, 12).map(kmh);                                // 50 km/h
  assert.ok(car[1] >= 25 && car[3] >= 25, `from the second fix it is a car speed, not a walking one: ${car.join(' ')}`);
  assert.ok(car.slice(6).every((v) => v >= 46 && v <= 54), car.join(' '));
  const stop = w.run(0, 14).map(kmh);                                // and the car stops at a light
  assert.ok(stop.slice(8).every((v) => v === 0), `a stopped car is 0, not a leftover walking speed: ${stop.join(' ')}`);
});

test('on foot: the compass has a course from the bearing between fixes, kept between them, gone when standing', () => {
  const w = walker();
  w.run(5 / 3.6, 30);
  const course = w.h.g.course({ heading: null, speed: 1.4 });
  assert.ok(course !== null && Math.abs(course - 90) < 20, `walking east: ${course}`);
  assert.equal(w.h.g.course({ heading: 200, speed: 1.4 }) === 200, false, 'a reported heading at walking pace is not trusted');
  assert.equal(w.h.g.course({ heading: null, speed: 0.2 }), null, 'standing: no course');
  w.h.clock.t += 13000;
  assert.equal(w.h.g.course({ heading: null, speed: 1.4 }), null, 'no movement for 13 s: never an old course');
});

test('after a long quiet gap: the same place is 0 at once, a different place is not given a made-up speed', () => {
  const h = guide(route({ id: 'none', gl: undefined })), bare = { heading: null, speed: null };
  const feed = (east, gapMs) => { h.clock.t += gapMs; const p = fix(east, 0, h.clock.t, bare); h.g.fix(p); return h.g.fill(p).coords.speed; };
  feed(0, 1000);
  assert.equal(feed(1, 90000), 0, 'ninety quiet seconds, still in the same place: standing still');
  assert.equal(feed(400, 90000), null, 'ninety quiet seconds and 400 m away: moved, but how fast is not known');
  assert.ok(Math.abs(feed(428, 2000) - 14) < 0.5, 'the next fix gives the speed');
});

test('a fix stamped up to two seconds ahead of the glasses\' clock is used; clearly future ones are not', () => {
  const h = guide(route({ id: 'none', gl: undefined }));
  h.g.fix(fix(0, 0, h.clock.t + 2000)); assert.equal(h.g.trail.length, 1);
  h.g.fix(fix(10, 0, h.clock.t + 2001)); assert.equal(h.g.trail.length, 1, 'more than two seconds ahead: rejected');
});

test('compass painter: one drawing for both faces, hidden with its room kept when there is no course, redrawn only when it moved', () => {
  const made = [];
  const node = () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: '' });
  const svg = { style: {}, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(n) { this.kids.push(n); },
    set textContent(v) { this.kids = []; }, ownerDocument: { createElementNS(ns, name) { const n = node(); n.name = name; made.push(n); return n; } } };
  const { paintTape } = require('../guide.js');
  paintTape(svg, 92);
  assert.equal(svg.style.visibility, 'visible');
  assert.equal(svg.attrs['aria-label'], 'Compass: heading E, 92 degrees');
  assert.equal(svg.kids.find((n) => n.attrs.class === 'readout').textContent, 'E 092°');
  const drawn = made.length;
  paintTape(svg, 92.1); assert.equal(made.length, drawn, 'a tenth of a degree is not a redraw');
  paintTape(svg, 95); assert.ok(made.length > drawn);
  paintTape(svg, null);
  assert.equal(svg.style.visibility, 'hidden'); assert.equal(svg.kids.length, 0);
  assert.equal(svg.attrs['aria-label'], 'Compass: no heading while stopped');
  paintTape(null, 10); paintTape({}, 10);   // nothing to draw into: no throw
});
