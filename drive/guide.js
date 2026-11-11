'use strict';
// Compass tape and saved-route guidance for the Drive screens. No DOM, no timers and no network here, so Node runs this
// same code in drive/tests/guide.test.cjs.
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

  // Metres on the ground between two latitude/longitude pairs, flat-earth around the first: exact enough for the few
  // kilometres this is used over.
  function flat(lat0, lon0, lat, lon) {
    return [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, (lat - lat0) * 110540];
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
      steps.push({ s: Math.min(total, g[0] * total / said), t: g[1].slice(0, 48) });
    }
    steps.sort((a, b) => a.s - b.s);
    return { id: route.id, ti: typeof route.ti === 'string' ? route.ti.slice(0, 40) : '', line, total, steps };
  }

  // Where a fix sits on the outline: metres along it and metres away from it. `near` (metres along) keeps the answer
  // close to where the last fix was when the route passes the same place twice.
  function project(r, lat, lon, near) {
    let best = null, local = null;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1], b = r.line[i];
      const [ax, ay] = flat(lat, lon, a.lat, a.lon), [bx, by] = flat(lat, lon, b.lat, b.lon);
      const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
      const hit = { s: a.s + t * (b.s - a.s), away: Math.hypot(ax + t * vx, ay + t * vy), bearing: norm(Math.atan2(vx, vy) * 180 / Math.PI) };
      if (!best || hit.away < best.away) best = hit;
      if (finite(near) && hit.s >= near - LOOK_BACK_M && hit.s <= near + LOOK_AHEAD_M && (!local || hit.away < local.away)) local = hit;
    }
    return { best, local };
  }

  class Guide {
    constructor({ now = Date.now } = {}) { this.now = now; this.route = null; this.reset(); }
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
      if (!r || this.over || !c || !finite(at) || at > now || now - at >= FIX_MAX_AGE_MS) return;
      if (!finite(c.latitude) || !finite(c.longitude) || !finite(c.accuracy) || c.accuracy < 0 || c.accuracy > FIX_MAX_ACCURACY_M) return;
      const limit = OFF_BASE_M + c.accuracy;
      const { best, local } = project(r, c.latitude, c.longitude, this.joined ? this.s : NaN);
      const hit = local && local.away <= limit ? local : best;
      if (this.done) {                                // arrived: said for a while, gone once the wearer leaves
        const end = r.line[r.line.length - 1], [ex, ey] = flat(c.latitude, c.longitude, end.lat, end.lon);
        if (Math.hypot(ex, ey) > ARRIVED_LEAVE_M) this.end();
        return;
      }
      // The way the car is moving against the way the road runs here. No course (slow or stopped) says nothing either way.
      const moving = finite(c.heading) && c.heading >= 0 && c.heading < 360 && finite(c.speed) && c.speed >= 2;
      const turn = moving ? Math.abs(((c.heading - hit.bearing + 540) % 360) - 180) : NaN;
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
      if (this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at) return { state: 'paused', title: r.ti };
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

  const api = Object.freeze({ tape, prepare, project, Guide, metres, words, POINTS,
    FIX_MAX_AGE_MS, FIX_MAX_ACCURACY_M, ROUTE_MAX_AGE_S, OFF_BASE_M, OFF_FIXES, GIVE_UP_M, GIVE_UP_MS, ARRIVE_M,
    JOIN_FIXES, AGAINST_FIXES, ARRIVED_SHOW_MS, ARRIVED_LEAVE_M });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveGuide = api;
})(globalThis);
