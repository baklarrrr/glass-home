'use strict';
// Fixed-camera warning for the Drive screens: a red light or speed camera on the road ahead, and how far. No DOM, no
// timers and no network here, so Node runs this same code in drive/tests/cameras.test.cjs.
//
// The list is public data built by tools/build-cameras.cjs (drive/cameras.json): Toronto's own red light cameras and
// the cameras mapped in OpenStreetMap for Canada. It is fixed sites only. It knows nothing about mobile radar, police
// or temporary cameras, and a camera nobody mapped is not in it: a quiet screen is not a promise.
//
// Everything is worked out on the glasses from their own location. Only the camera being warned about and the last
// distance to it are kept, in page memory; the position is not stored and nothing is sent.
(function (root) {
  const FIX_MAX_AGE_MS = 5000, FIX_MAX_ACCURACY_M = 50;   // the same limits as the speed (drive-location.js)
  const LOOK_S = 25;                // warn this many seconds ahead at the current speed,
  const NEAR_M = 400, FAR_M = 1000; // but never nearer than this or farther than that
  const LANE_M = 60;                // how far to the side of the line of travel still counts as this road
  const PASSED_M = 25;              // a camera this close, not already being warned about, is too late to start on
  const BEHIND_M = 15;              // the camera being warned about stays until it is this far behind: through the stop line and the junction
  const ACCURACY_CAP_M = 15;        // how much of the fix's own doubt may widen the lane
  const MOTORWAY_MPS = 70 / 3.6;    // a camera marked as beside a motorway warns only below this speed: it is on the street, not the motorway
  const OLD_DAYS = 14, STALE_DAYS = 30;   // the list's age: said in details after the first, on the Drive face after the second
  const HOLD_M = 40;                // stopped, or no course: keep the warning unless the camera is this much farther than it was
  const CELL = 0.02;                // grid cell in degrees (about 2 km), for a quick look-up
  const KINDS = Object.freeze({ r: 'Red light camera', s: 'Speed camera' });

  const finite = Number.isFinite;
  const cell = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

  // The list from drive/cameras.json, checked and put on a grid. Anything malformed gives an empty, harmless index.
  function index(file) {
    const grid = new Map();
    let count = 0;
    const items = file && Array.isArray(file.items) ? file.items : [];
    for (const it of items) {
      if (!Array.isArray(it) || !finite(it[0]) || !finite(it[1]) || Math.abs(it[0]) > 90 || Math.abs(it[1]) > 180 || !KINDS[it[2]]) continue;
      const cam = { lat: it[0], lon: it[1], kind: it[2], limit: finite(it[3]) && it[3] >= 10 && it[3] <= 150 ? it[3] : 0,
        motorway: it[4] === 1, street: typeof it[5] === 'string' ? it[5].slice(0, 18) : '' };
      const key = cell(cam.lat, cam.lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(cam); count++;
    }
    const made = file && typeof file.made === 'string' && /^\d{4}-\d{2}-\d{2}/.test(file.made) ? file.made.slice(0, 10) : '';
    return { grid, count, made, region: file && typeof file.region === 'string' ? file.region.slice(0, 24) : '',
      redLightOnly: file && Array.isArray(file.redLightOnly) ? file.redLightOnly.filter((x) => typeof x === 'string').slice(0, 6) : [] };
  }

  // The cameras in the cells around a place.
  function around(ix, lat, lon) {
    const out = [], a = Math.floor(lat / CELL), b = Math.floor(lon / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const list = ix.grid.get(`${a + i}:${b + j}`); if (list) out.push(...list); }
    return out;
  }

  // A camera seen from a place and a course: metres to it, metres ahead along the line of travel, metres to the side.
  function seen(lat, lon, course, cam) {
    const dx = (cam.lon - lon) * Math.cos(lat * Math.PI / 180) * 111320, dy = (cam.lat - lat) * 110540;
    const dist = Math.hypot(dx, dy);
    if (!finite(course)) return { dist, ahead: NaN, side: NaN };
    const c = course * Math.PI / 180, ahead = dx * Math.sin(c) + dy * Math.cos(c);
    return { dist, ahead, side: Math.abs(dx * Math.cos(c) - dy * Math.sin(c)) };
  }

  class Watch {
    constructor({ now = Date.now } = {}) { this.now = now; this.ix = index(null); this.target = null; this.dist = NaN; this.at = 0; }
    load(file) { this.ix = index(file); this.target = null; }
    get count() { return this.ix.count; }
    get made() { return this.ix.made; }
    // How many whole days old the list is, or null when it has no date.
    ageDays() { const t = Date.parse(this.ix.made + 'T00:00:00Z'); return this.ix.made && finite(t) ? Math.max(0, Math.floor((this.now() - t) / 86400000)) : null; }
    // What the list covers, for the details panel, and the one line for the Drive face once it is too old to trust quietly.
    about() {
      if (!this.ix.count) return 'Cameras: list not loaded';
      const age = this.ageDays(), only = this.ix.redLightOnly;
      return `Cameras: ${this.ix.count} fixed sites, ${this.ix.region || 'region unknown'} only` + (only.length ? `. ${only.join(' and ')}: red light cameras only` : '') +
        `. List of ${this.ix.made || 'unknown date'}` + (age !== null && age > OLD_DAYS ? `, ${age} days old` : '') + '. No mobile radar or police.';
    }
    staleNote() { const age = this.ageDays(); return this.ix.count && age !== null && age > STALE_DAYS ? `Camera list ${age} days old` : ''; }
    // One location fix, with the course of travel in degrees (or null: stopped, or unknown) and the speed in metres a second.
    fix(position, course, speed) {
      const c = position && position.coords, at = position && position.timestamp, now = this.now();
      if (!c || !finite(at) || at > now || now - at >= FIX_MAX_AGE_MS) return;
      if (!finite(c.latitude) || !finite(c.longitude) || !finite(c.accuracy) || c.accuracy < 0 || c.accuracy > FIX_MAX_ACCURACY_M) return;
      this.at = at;
      if (!finite(course)) {
        // Stopped at the light, or no course yet: the camera already warned about stays while it is not falling behind.
        if (!this.target) return;
        const d = seen(c.latitude, c.longitude, NaN, this.target).dist;
        if (d > this.dist + HOLD_M) this.target = null; else this.dist = Math.min(this.dist, d), this.shown = d;
        return;
      }
      const reach = Math.max(NEAR_M, Math.min(FAR_M, (finite(speed) && speed > 0 ? speed : 0) * LOOK_S));
      const lane = LANE_M + Math.min(ACCURACY_CAP_M, c.accuracy);
      // A camera marked as beside a motorway is on the street next to it or under it. At motorway speed the car is on the motorway.
      const onStreet = (cam) => !cam.motorway || !(speed >= MOTORWAY_MPS);
      let best = null;
      for (const cam of around(this.ix, c.latitude, c.longitude)) {
        const s = seen(c.latitude, c.longitude, course, cam);
        // Ahead on this road: in front, within reach, and no farther to the side than a road is wide (plus a little of the
        // fix's own doubt). The camera already being warned about is followed through the stop line and the junction until
        // it is behind; a new one must still be properly ahead. The nearest that qualifies is the one shown, so a nearer
        // camera takes over and turning off the road drops the old one.
        const held = cam === this.target;
        if (s.ahead <= (held ? -BEHIND_M : PASSED_M) || s.dist > (held ? Math.max(reach, this.dist + HOLD_M) : reach) || s.side > lane || !onStreet(cam)) continue;
        if (!best || s.dist < best.dist) best = { cam, dist: s.dist };
      }
      this.target = best ? best.cam : null;
      this.dist = this.shown = best ? best.dist : NaN;
    }
    // What the screen may say right now: null, or the kind, the distance and the posted limit when the map has one.
    snapshot() {
      if (!this.target || this.now() - this.at >= FIX_MAX_AGE_MS || this.now() < this.at) return null;
      return { kind: this.target.kind, dist: this.shown, limit: this.target.limit, street: this.target.motorway ? this.target.street : '' };
    }
  }

  // Distance as a driver reads it, in 50 m steps (10 m steps under 200 m).
  function metres(m) {
    if (!finite(m) || m < 0) return '';
    if (m < 195) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return m < 975 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`;
  }

  // The one line for the screen. `over` is true when it is a speed camera with a known limit and the speed shown is above it.
  function words(snap, kmh) {
    if (!snap) return null;
    const limit = snap.kind === 's' && snap.limit ? snap.limit : 0;
    // Beside a motorway the street is named, so a driver on the other road knows it is not theirs.
    return { text: `${KINDS[snap.kind]}${snap.street ? ` on ${snap.street}` : ''}${limit ? ` · limit ${limit}` : ''} · ${metres(snap.dist)}`, kind: snap.kind, limit,
      over: Boolean(limit && finite(kmh) && Math.round(kmh) > limit) };
  }

  const api = Object.freeze({ index, around, seen, Watch, metres, words, KINDS, FIX_MAX_AGE_MS, NEAR_M, FAR_M, LANE_M, LOOK_S, PASSED_M, BEHIND_M, HOLD_M, ACCURACY_CAP_M, MOTORWAY_MPS, OLD_DAYS, STALE_DAYS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DriveCameras = api;
})(globalThis);
