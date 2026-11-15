'use strict';
// Compass tape and saved-route guidance for the Drive screens. No timers and no network here, so Node runs this same
// code in drive/tests/guide.test.cjs. The one piece that touches the page is paintTape, which draws into an SVG it is
// handed: both Drive faces (Bakar Home's Drive tab and Bakar Drive) call it, so the compass is one piece of code.
//
// Compass: the GPS course over the ground as a sliding tape. It is the way the car is moving, not the way the wearer
// looks. There is no course below about 7 km/h (the feed leaves it out), and then there is no tape: never an old one.
//
// Guidance: the next turn along the route the PC saved (relay/route.py), worked out on the glasses from their own
// location. It is a saved route: no traffic, no rerouting. Only numbers derived from a fix are kept (how far along the
// route, how far off it), in page memory; the position itself is not stored and nothing is sent anywhere.
(function (root) {
  const POINTS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
  const FIX_MAX_AGE_MS = 5000;       // the same age limit as the speed (drive-location.js)
  const FIX_MAX_ACCURACY_M = 50;     // and the same accuracy limit
  const FUTURE_MS = 2000;            // and the same allowance for a phone clock that runs a little ahead of the glasses'
  const TRAIL_MS = 20000;            // how long fixes are kept for working out a speed: long enough for walking pace
  const LONG_MS = 12000;             // on foot a few seconds of movement is smaller than GPS scatter, so look back this far
  const SLOW_MPS = 20 / 3.6;         // under this the estimate is smoothed a little, so it does not jump between 0 and 7
  const WALK_MPS = 0.5;              // slower than this is standing: no course
  const SLOW_COURSE_MS = 12000;      // on foot the course between fixes is kept this long (12 m takes a walker about 9 s)
  const ROUTE_MAX_AGE_S = 18 * 3600; // a route saved for an earlier day does not start guiding by itself
  const OFF_BASE_M = 70;             // road width, GPS scatter and the thinned outline together
  const OFF_FIXES = 3;               // this many fixes in a row off the line before the screen says so
  const GIVE_UP_M = 2500;            // this far off, or
  const GIVE_UP_MS = 5 * 60 * 1000;  // this long off: the wearer is going somewhere else, so guidance stops quietly
  const ARRIVE_M = 40;
  const JOIN_FIXES = 3;              // this many fixes in a row on the line and going its way before guidance starts
  const WITH_DEG = 60;               // "going its way": the GPS course within this of the road's direction there
  const AGAINST_DEG = 120;           // and this far from it is going the other way
  const AGAINST_FIXES = 3;           // that many in a row: the wearer is on the way back, so guidance stops
  const ARRIVED_SHOW_MS = 2 * 60 * 1000;   // "Arrived" is said for this long, or
  const ARRIVED_LEAVE_M = 150;       // until the wearer is this far from the end
  const PASSED_M = 15;               // a turn this close behind or ahead counts as being made now
  const LOOK_BACK_M = 200, LOOK_AHEAD_M = 2000;   // where the next fix is expected, so a route that crosses itself keeps its place

  const finite = Number.isFinite;
  const norm = (deg) => ((deg % 360) + 360) % 360;

  // What the tape draws for a course: ticks every 15 degrees inside the window, placed from -1 (left edge) to 1 (right
  // edge), with a letter on the eight compass points. Null when there is no usable course.
  function tape(course, halfSpan = 50) {
    if (!finite(course) || course < 0 || course >= 360) return null;
    const ticks = [];
    const first = Math.ceil((course - halfSpan) / 15) * 15;
    for (let d = first; d <= course + halfSpan; d += 15) {
      const at = norm(d);
      ticks.push({ x: (d - course) / halfSpan, label: at % 45 === 0 ? POINTS[at / 45] : '', major: at % 45 === 0, north: at === 0 });
    }
    const shown = Math.round(course) % 360;
    const point = POINTS[Math.round(course / 45) % 8];
    return { deg: shown, text: String(shown).padStart(3, '0') + '°', point, readout: `${point} ${String(shown).padStart(3, '0')}°`, ticks };
  }

  // Draws the tape into an <svg viewBox="-160 0 320 44">, or hides it (keeping its room) when there is no course. Redraws
  // only when the course moved half a degree. Styling is drive/tape.css, shared by both faces.
  const painted = new WeakMap();
  function paintTape(svg, course) {
    if (!svg || !svg.style) return;
    const t = tape(finite(course) ? course : NaN), key = t ? String(Math.round(course * 2) / 2) : '';
    svg.style.visibility = t ? 'visible' : 'hidden';
    svg.setAttribute('aria-label', t ? `Compass: heading ${t.point}, ${t.deg} degrees` : 'Compass: no heading while stopped');
    if (painted.get(svg) === key) return;
    painted.set(svg, key); svg.textContent = '';
    if (!t) return;
    const make = (name, attrs, text) => { const n = (svg.ownerDocument || document).createElementNS('http://www.w3.org/2000/svg', name); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text) n.textContent = text; svg.append(n); };
    for (const k of t.ticks) {
      const x = (k.x * 150).toFixed(1), fade = k.north ? 1 : (1 - Math.abs(k.x) * .35).toFixed(2);   // the edges dim a little; north never does
      make('line', { x1: x, x2: x, y1: 9, y2: k.major ? 19 : 15, class: k.north ? 'major north' : k.major ? 'major' : '', opacity: fade });
      if (k.label && Math.abs(k.x) > .36) make('text', { x, y: 40, class: k.north ? 'north' : '', opacity: fade }, k.label);   // the middle belongs to the readout
    }
    make('path', { d: 'M-6 0H6L0 8Z', class: 'needle' });
    make('text', { x: 0, y: 41, class: 'readout' }, t.readout);
  }

  // Metres on the ground between two latitude/longitude pairs, flat-earth around the first: exact enough for the few
  // kilometres this is used over.
  function flat(lat0, lon0, lat, lon) {
    return [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];
  }

  // Words cut to a length without cutting inside a word: "Rd 124" must never become "Rd 12". The cut is marked.
  function clip(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max + 1), space = cut.lastIndexOf(' ');
    return (space > max / 2 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s·,]+$/, '') + '…';
  }

  // A route from the PC, checked. `gl` is the outline as [latitude, longitude] pairs; `gs` the turns as
  // [metres from the start, words]. Anything malformed gives null and the screen simply has no guidance.
  function prepare(route, nowS) {
    if (!route || typeof route.id !== 'string' || !Array.isArray(route.gl) || !Array.isArray(route.gs)) return null;
    if (route.gl.length < 2 || route.gl.length > 2000 || route.gs.length > 400) return null;
    if (finite(nowS) && (!finite(route.at) || nowS - route.at > ROUTE_MAX_AGE_S || route.at - nowS > 600)) return null;
    const line = [];
    let total = 0;
    for (let i = 0; i < route.gl.length; i++) {
      const p = route.gl[i];
      if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) return null;
      if (i) { const [dx, dy] = flat(line[i - 1].lat, line[i - 1].lon, p[0], p[1]); total += Math.hypot(dx, dy); }
      line.push({ lat: p[0], lon: p[1], s: total });
    }
    if (!(total > 0)) return null;
    // The PC measures turns along the full road; the outline here is thinned, so slightly shorter. Scale to match.
    const said = finite(route.gm) && route.gm > 0 ? route.gm : total;
    const steps = [];
    for (const g of route.gs) {
      if (!Array.isArray(g) || !finite(g[0]) || g[0] < 0 || typeof g[1] !== 'string') return null;
      steps.push({ s: Math.min(total, g[0] * total / said), t: clip(g[1], 80) });
    }
    steps.sort((a, b) => a.s - b.s);
    return { id: route.id, ti: typeof route.ti === 'string' ? route.ti.slice(0, 40) : '', line, total, steps };
  }

  // Where a fix sits on the outline: metres along it and metres away from it. `near` (metres along) keeps the answer
  // close to where the last fix was when the route passes the same place twice.
  function project(r, lat, lon, near, heading, limit) {
    let best = null, local = null, agree = null;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i];
      const [ax, ay] = flat(lat, lon, a.lat, a.lon), [bx, by] = flat(lat, lon, b.lat, b.lon);
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
      const hit = { s: a.s + t * (b.s - a.s), away: Math.hypot(ax + t * vx, ay + t * vy), bearing: norm(Math.atan2(vx, vy) * 180 / Math.PI) };
      if (!best || hit.away < best.away) best = hit;
      if (finite(near) && hit.s >= near - LOOK_BACK_M && hit.s <= near + LOOK_AHEAD_M && (!local || hit.away < local.away)) local = hit;
      // On the line here and running the way the car moves: the leg the car is really on. Where two legs share a road
      // (out and back), the one nearest ahead of the last place wins.
      if (finite(heading) && hit.away <= limit && Math.abs(((heading - hit.bearing + 540) % 360) - 180) <= WITH_DEG) {
        const gap = finite(near) ? (hit.s >= near - LOOK_BACK_M ? hit.s - near : Infinity) : hit.away;
        if (gap !== Infinity && (!agree || gap < agree.gap)) agree = { ...hit, gap };
      }
    }
    return { best, local, agree };
  }

  class Guide {
    constructor({ now = Date.now } = {}) { this.now = now; this.route = null; this.anchor = null; this.moved = null; this.trail = []; this.reset(); }
    clearMotion() { this.trail=[];this.anchor=null;this.moved=null;this.rest=null;this.est=null;this.miss=0; }
    // The way the car is moving, for a runtime whose location gives no heading: the bearing between two fixes at least
    // 12 m apart (more when the fix is rough). The earlier fix is held in page memory for this only and replaced as the car
    // moves; a reported heading always wins. Nothing here needs a route.
    track(c, at) {
      // A few seconds of fixes, for a speed where the device reports none (see estimate). Page memory only.
      const before = this.trail[this.trail.length - 1];
      this.trail = this.trail.filter((p) => at - p.at <= TRAIL_MS && at > p.at);
      // Fixes went quiet for longer than the trail keeps: the last one stays, to tell standing still from having moved.
      if (!this.trail.length && before) this.rest = before;
      this.trail.push({ lat: c.latitude, lon: c.longitude, at, acc: c.accuracy });
      const a = this.anchor;
      if (a && at - a.at <= 30000 && at >= a.at) {
        const [dx, dy] = flat(a.lat, a.lon, c.latitude, c.longitude), far = Math.hypot(dx, dy);
        if (far < Math.max(12, c.accuracy)) return;
        if (far < 400) this.moved = { deg: norm(Math.atan2(dx, dy) * 180 / Math.PI), at, slow: far / Math.max(1, (at - a.at) / 1000) < SLOW_MPS };
      }
      this.anchor = { lat: c.latitude, lon: c.longitude, at };
    }
    // Ground speed in metres a second from the last few fixes, for a runtime whose location reports no speed: the distance
    // from a fix 1.5 to 6 seconds back (up to 12 seconds for sparse one-shot callbacks), over the time between. Movement smaller than the fixes' own scatter counts as
    // standing still. Null until there are two usable fixes. An estimate from positions, labelled as GPS on screen.
    // Walking and running (15 Nov 2026): a few seconds of walking is smaller than the scatter of the fixes, so two fixes
    // cannot tell it from standing. Under 20 km/h the speed is the slope of a straight line fitted through the last 12
    // seconds of fixes, which averages the scatter out. It counts only when the last 6 seconds show movement too: a car that
    // has just stopped, or a walker who has, is standing still, not a leftover speed. Moving estimates under 20 km/h are
    // blended a little with the one before. After fixes went quiet for longer than the trail, the last fix before the gap
    // tells standing still (0) from having moved (no number: the next fix gives one).
    estimate() {
      const t = this.trail, last = t[t.length - 1];
      if (!last || this.now() - last.at >= FIX_MAX_AGE_MS) return null;
      if (this.est && this.est.at === last.at) return this.est.out;
      const gap = (p) => last.at - p.at, scatter = (p) => Math.max(p.acc, last.acc);
      const far = (p) => { const [dx, dy] = flat(p.lat, p.lon, last.lat, last.lon); return Math.hypot(dx, dy); };
      const back = (ms) => { for (let i = t.length - 2; i >= 0; i--) if (gap(t[i]) >= ms) return t[i]; return null; };
      // Metres a second and metres covered, from a line fitted through the fixes of the last `ms`; null with too few of them.
      const fit = (ms, least) => {
        const pts = t.filter((p) => gap(p) <= ms), span = pts.length ? gap(pts[0]) / 1000 : 0;
        if (pts.length < 2 || span < least) return null;
        const xy = pts.map((p) => flat(last.lat, last.lon, p.lat, p.lon)), ts = pts.map((p) => -gap(p) / 1000);
        const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, tm = mean(ts), xm = mean(xy.map((q) => q[0])), ym = mean(xy.map((q) => q[1]));
        let stt = 0, stx = 0, sty = 0;
        ts.forEach((v, k) => { stt += (v - tm) ** 2; stx += (v - tm) * (xy[k][0] - xm); sty += (v - tm) * (xy[k][1] - ym); });
        const speed = Math.hypot(stx / stt, sty / stt);
        return { speed, span, moved: speed * span, acc: Math.max(...pts.map((p) => p.acc)) };
      };
      const near = t.find((p) => gap(p) >= 1500 && gap(p) <= 6000) || back(1500);
      let speed = null, fitted = false;
      if (near) {
        let two = far(near) >= Math.max(5, 0.6 * scatter(near)) ? far(near) / (gap(near) / 1000) : 0;
        // Pulling away, the last two seconds say more than the last six: a clear difference there wins.
        const quick = back(1500);
        if (quick && quick !== near) {
          const q = far(quick) >= Math.max(20, 2 * scatter(quick)) ? far(quick) / (gap(quick) / 1000) : 0;   // 20 m in two seconds: a car
          if (q > 0 && Math.abs(q - two) > 0.3 * Math.max(q, two)) two = q;
        }
        const whole = fit(LONG_MS, 6), recent = fit(LONG_MS / 2, 3);
        if (two >= SLOW_MPS || !whole || !recent) speed = two;          // a car, or too few fixes for a line: two fixes, as before
        else {
          const steady = whole.moved >= Math.max(6, 0.5 * whole.acc), lately = recent.moved >= Math.max(4, 0.4 * recent.acc);
          // One doubtful look at the last few seconds does not drop a walker to 0: the third in a row does.
          this.miss = steady && !lately ? (this.miss || 0) + 1 : 0;
          speed = steady && (lately || (this.miss < 3 && this.est && this.est.fitted)) ? whole.speed : 0;
          fitted = speed > 0;
        }
        // Braking hard or stopped: anything faster than a walk must show in the last four seconds too. If they show less
        // than half of it, they alone are the speed, and 0 once they show no movement beyond the scatter.
        const brief = fit(4000, 2);
        if (speed >= 2.5 && brief && brief.moved < 0.5 * speed * brief.span) { speed = brief.moved >= Math.max(5, 0.6 * brief.acc) ? brief.speed : 0; fitted = false; }
      } else if (this.rest && gap(this.rest) >= 1500 && far(this.rest) < Math.max(8, 0.75 * scatter(this.rest))) speed = 0;
      if (speed === null) return null;
      const prev = this.est;
      // Standing still is said at once; only one moving estimate after another is blended.
      if (prev && last.at - prev.at <= 12000 && speed > 0 && speed < SLOW_MPS && prev.speed > 0 && prev.speed < SLOW_MPS) speed = 0.6 * speed + 0.4 * prev.speed;
      const out = { speed, heading: speed >= 2 ? this.course() : null };
      this.est = { at: last.at, speed, out, fitted };
      return out;
    }
    // The fix as the speed feed should see it: unchanged when the device reports a speed, otherwise with the estimate
    // filled in. Never a made-up number: with no estimate the fix goes through as it came.
    fill(position) {
      const c = position && position.coords;
      if (!c || (finite(c.speed) && c.speed >= 0)) return position;
      const e = this.estimate();
      if (!e || !finite(e.speed) || this.trail.length === 0 || this.trail[this.trail.length - 1].at !== position.timestamp) {
        if(c.speed!==-1)return position;
        return {timestamp:position.timestamp,coords:{latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,speed:null,heading:null}};
      }
      return { timestamp: position.timestamp, coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, speed: e.speed, heading: e.heading } };
    }
    // The course to show or steer by right now, or null: reported by the device, else worked out from movement, and
    // never older than the speed's own limit.
    course(c) {
      if (c && finite(c.heading) && c.heading >= 0 && c.heading < 360 && finite(c.speed) && c.speed >= 2) return c.heading;
      if (c && finite(c.speed) && c.speed >= 0 && c.speed < WALK_MPS) return null;            // the device says stopped
      // At walking pace a reported heading is noise, so the bearing between fixes is used, and kept longer than in a car.
      const m = this.moved;
      return m && this.now() - m.at < (m.slow ? SLOW_COURSE_MS : FIX_MAX_AGE_MS) && this.now() >= m.at - FUTURE_MS ? m.deg : null;
    }
    reset() { this.joined = false; this.s = null; this.away = null; this.at = 0; this.offCount = 0; this.offSince = 0; this.done = false; this.doneAt = 0;
      this.onCount = 0; this.againstCount = 0; }
    // Stop for good on this route: arrived and left, or driving it backwards. A new route starts fresh.
    end() { this.reset(); this.over = true; }
    // Give it the snapshot's route (or nothing). The same route again changes nothing, so a repaint does not lose the place.
    setRoute(route) {
      const id = route && route.id;
      if (this.route && id === this.route.id) return;
      this.route = prepare(route, this.now() / 1000);
      this.savedAt = this.route ? route.at : 0;
      this.reset(); this.over = false;
    }
    // One location fix, straight from the browser. Only numbers derived from it are kept.
    fix(position) {
      const r = this.route, c = position && position.coords, at = position && position.timestamp, now = this.now();
      if (!c || !finite(at) || at > now + FUTURE_MS || now - at >= FIX_MAX_AGE_MS) return;
      if (!finite(c.latitude) || !finite(c.longitude) || !finite(c.accuracy) || c.accuracy < 0 || c.accuracy > FIX_MAX_ACCURACY_M) return;
      if(Math.abs(c.latitude)>90||Math.abs(c.longitude)>180)return;
      const previous=this.trail[this.trail.length-1];
      if(previous&&at<=previous.at)return;
      this.track(c, at);
      if (!r || this.over) return;
      const limit = OFF_BASE_M + c.accuracy;
      // The way the car is moving. No course (slow or stopped) says nothing either way.
      const heading = this.course(c), moving = heading !== null;
      const { best, local, agree } = project(r, c.latitude, c.longitude, this.joined ? this.s : NaN, moving ? heading : NaN, limit);
      const hit = agree || (local && local.away <= limit ? local : best);
      if (this.done) {                                // arrived: said for a while, gone once the wearer leaves
        const end = r.line[r.line.length - 1], [ex, ey] = flat(c.latitude, c.longitude, end.lat, end.lon);
        if (Math.hypot(ex, ey) > ARRIVED_LEAVE_M) this.end();
        return;
      }
      const turn = moving ? Math.abs(((heading - hit.bearing + 540) % 360) - 180) : NaN;
      if (!this.joined) {
        // Not guiding yet. Crossing the route, or driving it the other way, must not start it: only several fixes in a
        // row on the line and going its way do.
        if (hit.away > limit || !(turn <= WITH_DEG)) { this.onCount = 0; return; }
        if (++this.onCount < JOIN_FIXES) return;
        this.joined = true;
      }
      if (hit.away <= limit && turn >= AGAINST_DEG) { if (++this.againstCount >= AGAINST_FIXES) { this.end(); return; } }
      else if (moving) this.againstCount = 0;
      this.at = at; this.away = hit.away;
      if (hit.away <= limit) { this.s = hit.s; this.offCount = 0; this.offSince = 0; }
      else {
        if (!this.offCount++) this.offSince = now;
        if (hit.away > GIVE_UP_M || now - this.offSince > GIVE_UP_MS) { this.reset(); return; }
      }
      if (r.total - this.s <= ARRIVE_M && hit.away <= limit) { this.done = true; this.doneAt = now; }
    }
    // What the screen may say right now. `state`: none (no usable route, or not on it), paused (on it, but the last fix
    // is too old to point anywhere), on, off, arrived.
    snapshot() {
      const r = this.route;
      if (!r || !this.joined || this.over) return { state: 'none' };
      if (this.now() / 1000 - this.savedAt > ROUTE_MAX_AGE_S) return { state: 'none' };      // the route has gone old while open
      if (this.done) return this.now() - this.doneAt < ARRIVED_SHOW_MS ? { state: 'arrived', title: r.ti } : { state: 'none' };
      if (this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at - FUTURE_MS) return { state: 'paused', title: r.ti };
      if (this.offCount >= OFF_FIXES) return { state: 'off', title: r.ti, away: this.away };
      const next = r.steps.find((st) => st.s > this.s + PASSED_M) || null;
      const last = !next || next.t === 'Arrive';      // the PC's last turn is the arrival
      return { state: 'on', title: r.ti, left: r.total - this.s, toTurn: next ? next.s - this.s : r.total - this.s,
        turn: last ? (r.ti ? `Arrive at ${r.ti}` : 'Destination') : next.t.replace(' onto ', ' · ') };
    }
  }

  // Distances as a driver reads them: 10 m steps under 200 m, 50 m steps under a kilometre, then kilometres.
  function metres(m) {
    if (!finite(m) || m < 0) return '';
    if (m < 195) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    if (m < 975) return `${Math.round(m / 50) * 50} m`;
    if (m < 9950) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
  }

  // The two short lines for the screen: the turn, and under it what this guidance is.
  function words(snap) {
    switch (snap && snap.state) {
      // "not live": this route was worked out earlier. It knows nothing of traffic and does not reroute.
      case 'on': return { dist: metres(snap.toTurn), near: snap.toTurn < 300, turn: `${metres(snap.toTurn)} · ${snap.turn}`, note: `Saved route · not live · ${metres(snap.left)} to go`, level: 'ok' };
      case 'off': return { dist: '', near: false, turn: 'Off the saved route', note: `${metres(snap.away)} from it · no rerouting`, level: 'warn' };
      case 'paused': return { dist: '', near: false, turn: 'Saved route paused', note: 'Waiting for location', level: 'ok' };
      case 'arrived': return { dist: '', near: false, turn: snap.title ? `Arrived · ${snap.title}` : 'Arrived', note: '', level: 'ok' };
      default: return { dist: '', near: false, turn: '', note: '', level: 'ok' };
    }
  }

  const api = Object.freeze({ tape, paintTape, prepare, project, clip, Guide, metres, words, POINTS,
    FIX_MAX_AGE_MS, FIX_MAX_ACCURACY_M, ROUTE_MAX_AGE_S, OFF_BASE_M, OFF_FIXES, GIVE_UP_M, GIVE_UP_MS, ARRIVE_M,
    JOIN_FIXES, AGAINST_FIXES, ARRIVED_SHOW_MS, ARRIVED_LEAVE_M });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveGuide = api;
})(globalThis);
