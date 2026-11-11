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
// One rule about the law: Ontario banned municipal speed cameras from 14 November 2025 (Bill 56). A speed camera
// mapped in Ontario is therefore left out; red light cameras there stay. Change ONTARIO_SPEED_CAMERAS if that law changes.
//
// What is NOT here, because no open source has it: mobile radar, police positions, temporary cameras.
const fs = require('node:fs'), path = require('node:path');

const OUT = path.join(__dirname, '..', 'drive', 'cameras.json');
const UA = { 'User-Agent': 'BakarHome-camera-list/1.0 (+https://baklarrrr.github.io/glass-home/)' };
const TORONTO = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/b57a31a1-5ee6-43e3-bfb9-206ebe93066d?format=json';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const Q_CANADA = '[out:json][timeout:150];area["ISO3166-1"="CA"][admin_level=2]->.a;(node["highway"="speed_camera"](area.a);relation["type"="enforcement"](area.a););out body;>;out skel qt;';
const Q_ONTARIO = '[out:json][timeout:150];area["ISO3166-2"="CA-ON"]->.a;(node["highway"="speed_camera"](area.a);relation["type"="enforcement"](area.a););out ids;>;out ids;';
const ONTARIO_SPEED_CAMERAS = false;
const SAME_PLACE_M = 35;          // two entries of one kind this close are one camera site
const RED = /red.?light|feu.?rouge|traffic.?signal/i;

async function get(url, body) {
  const reply = await fetch(url, body ? { method: 'POST', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(body) } : { headers: UA });
  if (!reply.ok) throw new Error(`${url.slice(0, 60)}: HTTP ${reply.status}`);
  return reply.json();
}
const metres = (a, b) => Math.hypot((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180) * 111320, (b[0] - a[0]) * 110540);
const limitOf = (tags) => { const m = /^(\d{2,3})(?:\s*km\/h)?$/.exec(String((tags && tags.maxspeed) || '').trim()); return m ? +m[1] : 0; };

// Pure, so the test can run it on saved answers: (Toronto records, OSM Canada elements, set of OSM ids in Ontario) -> items.
function combine(toronto, osm, ontarioIds) {
  const items = [], counts = { torontoRedLight: 0, osmRedLight: 0, osmSpeed: 0, ontarioSpeedLeftOut: 0, sameSite: 0, unusable: 0 };
  const add = (lat, lon, kind, limit, count) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { counts.unusable++; return; }
    if (items.some((it) => it[2] === kind && Math.abs(it[0] - lat) < 0.001 && metres(it, [lat, lon]) < SAME_PLACE_M)) { counts.sameSite++; return; }
    items.push(limit ? [+lat.toFixed(5), +lon.toFixed(5), kind, limit] : [+lat.toFixed(5), +lon.toFixed(5), kind]);
    counts[count]++;
  };
  for (const r of toronto) {
    let point = null;
    try { point = JSON.parse(r.geometry).coordinates; } catch (_) { /* counted below */ }
    if (!point) { counts.unusable++; continue; }
    add(point[1], point[0], 'r', 0, 'torontoRedLight');
  }
  const nodes = new Map(osm.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const inRelation = new Set();
  const place = (node, id, kind, limit) => {
    const ontario = ontarioIds.has(id);
    if (kind === 's' && ontario && !ONTARIO_SPEED_CAMERAS) { counts.ontarioSpeedLeftOut++; return; }
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
      const kind = red && (!speed || (ontarioIds.has(rel.id) && !ONTARIO_SPEED_CAMERAS)) ? 'r' : 's';
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

async function main() {
  const check = process.argv.includes('--check');
  const [toronto, canada, ontario] = [await get(TORONTO), await get(OVERPASS, Q_CANADA), await get(OVERPASS, Q_ONTARIO)];
  if (!Array.isArray(toronto.records) || toronto.records.length < 100) throw new Error('Toronto list looks wrong: ' + (toronto.records && toronto.records.length));
  if (!Array.isArray(canada.elements) || canada.elements.length < 300) throw new Error('OpenStreetMap answer looks wrong: ' + (canada.elements && canada.elements.length));
  if (!Array.isArray(ontario.elements) || !ontario.elements.length) throw new Error('OpenStreetMap Ontario answer is empty');
  const geometryAt = toronto.fields.findIndex((f) => f.id === 'geometry');
  const { items, counts } = combine(toronto.records.map((r) => ({ geometry: r[geometryAt] })), canada.elements, new Set(ontario.elements.map((e) => e.id)));
  const made = new Date().toISOString().slice(0, 10);
  const file = { made, osmAsOf: (canada.osm3s && canada.osm3s.timestamp_osm_base) || '', region: 'Canada',
    kinds: { r: 'Red light camera', s: 'Speed camera' },
    sources: ['City of Toronto Open Data: Red Light Cameras (Open Government Licence - Toronto)', 'OpenStreetMap contributors (ODbL), via Overpass'],
    rules: ['Ontario: speed cameras left out (banned from 14 Nov 2025, Bill 56); red light cameras kept', 'No mobile radar, police positions or temporary cameras: no open source has them'],
    counts, items };
  let before = null;
  try { before = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { /* first build */ }
  const same = before && JSON.stringify(before.items) === JSON.stringify(items);
  console.log(JSON.stringify({ made, total: items.length, red: items.filter((i) => i[2] === 'r').length, speed: items.filter((i) => i[2] === 's').length, counts, changed: !same, was: before ? before.items.length : 0 }));
  if (before && items.length < before.items.length * 0.7) throw new Error('The new list is much shorter than the old one; not written. Look at the sources.');
  if (!check && !same) fs.writeFileSync(OUT, JSON.stringify(file).replace('"items":[', '"items":[\n').replace(/\],\[/g, '],\n[') + '\n');
}

if (require.main === module) main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
module.exports = { combine, limitOf, metres };
