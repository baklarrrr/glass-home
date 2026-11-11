#!/usr/bin/env node
'use strict';
// Builds drive/cameras.json: the fixed enforcement cameras Drive warns about (drive/cameras.js).
//   node tools/build-cameras.cjs            fetch the public sources and rewrite drive/cameras.json
//   node tools/build-cameras.cjs --check    the same, but only report what would change
//
// Sources, both public and both asked only for a whole region (nothing about where anyone is):
// - City of Toronto Open Data, "Red Light Cameras" (refreshed daily by the City; Open Government Licence - Toronto).
// - OpenStreetMap through the Overpass API: highway=speed_camera nodes and type=enforcement relations in Canada
//   (c OpenStreetMap contributors, ODbL). Volunteer-mapped: it can be incomplete or out of date.
//
// Rules about the law (NO_SPEED_CAMERAS below; change it when a law changes):
// - Ontario banned municipal speed cameras from 14 November 2025 (Bill 56).
// - Alberta ended speed-on-green and photo radar on its highways on 1 April 2025; what remains there is mobile, in
//   school, playground and construction zones, which no list has.
// A speed camera mapped in those provinces is therefore left out; red light cameras there stay.
//
// A camera within 80 m of a motorway is marked (and, from the Toronto list, named by its street): it is almost always on
// the street beside or under the motorway, and Drive must not warn a driver up on the motorway about it.
//
// What is NOT here, because no open source has it: mobile radar, police positions, temporary cameras.
const fs = require('node:fs'), path = require('node:path');

const OUT = path.join(__dirname, '..', 'drive', 'cameras.json');
const UA = { 'User-Agent': 'BakarHome-camera-list/1.0 (+https://baklarrrr.github.io/glass-home/)' };
const TORONTO = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/b57a31a1-5ee6-43e3-bfb9-206ebe93066d?format=json';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const Q_CANADA = '[out:json][timeout:150];area["ISO3166-1"="CA"][admin_level=2]->.a;(node["highway"="speed_camera"](area.a);relation["type"="enforcement"](area.a););out body;>;out skel qt;';
const NO_SPEED_CAMERAS = { 'CA-ON': ['Ontario', 'banned from 14 Nov 2025, Bill 56'], 'CA-AB': ['Alberta', 'speed-on-green and highway photo radar ended 1 Apr 2025'] };
const qProvince = (code) => `[out:json][timeout:150];area["ISO3166-2"="${code}"]->.a;(node["highway"="speed_camera"](area.a);relation["type"="enforcement"](area.a););out ids;>;out ids;`;
const MOTORWAY_M = 80;
const SAME_PLACE_M = 35;          // two entries of one kind this close are one camera site
const RED = /red.?light|feu.?rouge|traffic.?signal/i;

// A public server can be busy for a moment: up to four tries, waiting longer each time. Anything else is an error.
async function get(url, body) {
  for (let attempt = 1; ; attempt++) {
    const reply = await fetch(url, body ? { method: 'POST', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(body) } : { headers: UA }).catch((e) => ({ ok: false, status: String(e && e.message || e) }));
    if (reply.ok) return reply.json();
    if (attempt >= 4 || ![429, 502, 503, 504].includes(reply.status)) throw new Error(`${url.slice(0, 60)}: HTTP ${reply.status}`);
    await new Promise((r) => setTimeout(r, attempt * 20000));
  }
}
const metres = (a, b) => Math.hypot((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180) * 111320, (b[0] - a[0]) * 110540);
const limitOf = (tags) => { const m = /^(\d{2,3})(?:\s*km\/h)?$/.exec(String((tags && tags.maxspeed) || '').trim()); return m ? +m[1] : 0; };

// A street name short enough for one glance: "LAKE SHORE BLVD W" -> "Lake Shore".
function shortStreet(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const TYPE = /^(n|s|e|w|rd|st|ave|av|blvd|dr|cres|crt|ct|pkwy|hwy|way|ln|pl|terr|trl|gdns|sq|cir|rdwy)\.?$/i;
  // "Avenue Rd" stays whole: without its last word it would not be a name.
  while (words.length > 1 && TYPE.test(words[words.length - 1]) && !(words.length === 2 && /^(avenue|the|park|high|main)$/i.test(words[0]))) words.pop();
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ').slice(0, 18);
}

// Pure, so the test can run it on saved answers: (Toronto records, OSM Canada elements, set of OSM ids in the provinces
// with no speed cameras) -> items as [lat, lon, kind, limit, street]. `limit` 0 and `street` '' when unknown.
function combine(toronto, osm, ontarioIds) {
  const items = [], counts = { torontoRedLight: 0, osmRedLight: 0, osmSpeed: 0, speedLeftOutByLaw: 0, sameSite: 0, unusable: 0 };
  const add = (lat, lon, kind, limit, count, street = '') => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { counts.unusable++; return; }
    if (items.some((it) => it[2] === kind && Math.abs(it[0] - lat) < 0.001 && metres(it, [lat, lon]) < SAME_PLACE_M)) { counts.sameSite++; return; }
    items.push([+lat.toFixed(5), +lon.toFixed(5), kind, limit || 0, street]);
    counts[count]++;
  };
  for (const r of toronto) {
    let point = null;
    try { point = JSON.parse(r.geometry).coordinates; } catch (_) { /* counted below */ }
    if (!point) { counts.unusable++; continue; }
    add(point[1], point[0], 'r', 0, 'torontoRedLight', shortStreet(r.street));
  }
  const nodes = new Map(osm.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const inRelation = new Set();
  const place = (node, id, kind, limit) => {
    const ontario = ontarioIds.has(id);
    if (kind === 's' && ontario) { counts.speedLeftOutByLaw++; return; }
    add(node.lat, node.lon, kind, kind === 's' ? limit : 0, kind === 'r' ? 'osmRedLight' : 'osmSpeed');
  };
  for (const rel of osm.filter((e) => e.type === 'relation')) {
    const what = String((rel.tags && rel.tags.enforcement) || '');
    const red = /traffic_signals|red_light/.test(what), speed = /maxspeed/.test(what);
    const devices = rel.members.filter((m) => m.type === 'node' && m.role === 'device');
    for (const m of devices) inRelation.add(m.ref);
    if (!red && !speed) continue;                         // weight, height, unknown: not what this warns about
    for (const m of devices) {
      const node = nodes.get(m.ref);
      if (!node) { counts.unusable++; continue; }
      // A relation that is both: a red light camera where speed cameras are banned, a speed camera elsewhere.
      const kind = red && (!speed || ontarioIds.has(rel.id)) ? 'r' : 's';
      place(node, rel.id, kind, limitOf(rel.tags));
    }
  }
  for (const node of osm.filter((e) => e.type === 'node' && e.tags && e.tags.highway === 'speed_camera' && !inRelation.has(e.id))) {
    const t = node.tags, words = [t.note, t.name, t.description, t.speed_camera, t.enforcement].filter(Boolean).join(' ');
    place(node, node.id, RED.test(words) ? 'r' : 's', limitOf(t));
  }
  items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { items, counts };
}

// The final shape, with the motorway mark: [lat, lon, kind], then limit, then 1 and the street when a motorway is near.
// Trailing empty fields are dropped to keep the file small.
function pack(items, nearMotorway) {
  return items.map((it, i) => {
    const out = [it[0], it[1], it[2]];
    if (nearMotorway[i]) out.push(it[3] || 0, 1, it[4] || '');
    else if (it[3]) out.push(it[3]);
    while (out.length > 3 && (out[out.length - 1] === '' || out[out.length - 1] === 0)) out.pop();
    return out;
  });
}

// Which sites have a motorway within MOTORWAY_M: one count per site from Overpass, asked in batches.
async function motorwayNear(items) {
  const near = [];
  for (let from = 0; from < items.length; from += 150) {
    const batch = items.slice(from, from + 150);
    const q = '[out:json][timeout:170];' + batch.map((it) => `way(around:${MOTORWAY_M},${it[0]},${it[1]})["highway"~"^motorway"];out count;`).join('');
    const reply = await get(OVERPASS, q);
    const counts = reply.elements.filter((e) => e.type === 'count');
    if (counts.length !== batch.length) throw new Error(`motorway check: ${counts.length} answers for ${batch.length} sites`);
    for (const c of counts) near.push(+c.tags.ways > 0);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return near;
}

async function main() {
  const check = process.argv.includes('--check');
  const toronto = await get(TORONTO), canada = await get(OVERPASS, Q_CANADA), ontario = { elements: [] };
  for (const code of Object.keys(NO_SPEED_CAMERAS)) {
    const reply = await get(OVERPASS, qProvince(code));
    if (!Array.isArray(reply.elements) || !reply.elements.length) throw new Error(`OpenStreetMap answer for ${code} is empty`);
    ontario.elements.push(...reply.elements);
  }
  if (!Array.isArray(toronto.records) || toronto.records.length < 100) throw new Error('Toronto list looks wrong: ' + (toronto.records && toronto.records.length));
  if (!Array.isArray(canada.elements) || canada.elements.length < 300) throw new Error('OpenStreetMap answer looks wrong: ' + (canada.elements && canada.elements.length));
  const geometryAt = toronto.fields.findIndex((f) => f.id === 'geometry'), streetAt = toronto.fields.findIndex((f) => f.id === 'MAIN');
  const made0 = combine(toronto.records.map((r) => ({ geometry: r[geometryAt], street: r[streetAt] })), canada.elements, new Set(ontario.elements.map((e) => e.id)));
  const counts = made0.counts, near = await motorwayNear(made0.items), items = pack(made0.items, near);
  counts.nearMotorway = near.filter(Boolean).length;
  const made = new Date().toISOString().slice(0, 10);
  const file = { made, osmAsOf: (canada.osm3s && canada.osm3s.timestamp_osm_base) || '', region: 'Canada', redLightOnly: Object.values(NO_SPEED_CAMERAS).map(([name]) => name),
    kinds: { r: 'Red light camera', s: 'Speed camera' },
    sources: ['City of Toronto Open Data: Red Light Cameras (Open Government Licence - Toronto)', 'OpenStreetMap contributors (ODbL), via Overpass'],
    rules: [...Object.values(NO_SPEED_CAMERAS).map(([name, why]) => `${name}: speed cameras left out (${why}); red light cameras kept`),
      `A site within ${MOTORWAY_M} m of a motorway is marked: it warns only below motorway speed`, 'No mobile radar, police positions or temporary cameras: no open source has them'],
    counts, items };
  let before = null;
  try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { /* first build */ }
  const same = before && JSON.stringify(before.items) === JSON.stringify(items);
  console.log(JSON.stringify({ made, total: items.length, red: items.filter((i) => i[2] === 'r').length, speed: items.filter((i) => i[2] === 's').length, counts, changed: !same, was: before ? before.items.length : 0 }));
  if (before && items.length < before.items.length * 0.7) throw new Error('The new list is much shorter than the old one; not written. Look at the sources.');
  if (!check && !same) fs.writeFileSync(OUT, JSON.stringify(file).replace('"items":[', '"items":[\n').replace(/\],\[/g, '],\n[') + '\n');
}

if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
module.exports = { combine, pack, shortStreet, limitOf, metres };
