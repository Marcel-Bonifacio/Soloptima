// The layout map without the map: item checks, orientations, labels, the fill of a project, tables taken out, alignment to a
// click, shade-free rows, coordinates and file imports (node --test ui/tests/). The geometry itself is tests/layout_geometry.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanItem, cleanRemoved, orientationOf, layoutUsed, crossSlope, rectOf, rectCorners, alignedAzimuth, itemLabel, followPath, importedItems } from '../src/lib/layout/items.js';
import { fillLayout, keepOnly, alignShift, shadeFreeGcr, tableSize, rowsOf } from '../src/lib/layout/fill.js';
import { parseCoords, toDMS, km, wrapLon } from '../src/lib/layout/coords.js';
import { localProjector } from '../src/lib/layout/geometry.js';

// a 200 x 150 m PV area near the equator, from local metres
const lat0 = -8.5, lon0 = 115.2, ky = 110574, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
const ll = ([x, y]) => [lat0 + y / ky, lon0 + x / kx];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(ll);
const project = (polygons, extra = {}) => ({
  location: { lat: lat0, lon: lon0 },
  pv: { mount: 'fixed', tilt: 10, azimuth: 0, azimuth_auto: true, gcr: 0.5, module_length: 2.278, module_width: 1.134, module_wp: 550, near_shading: true, tracker_axis_azimuth: 0 },
  layout: { polygons, orientation: 'portrait', modules_across: 2, modules_per_table: 28, table_gap: 0.5, setback: 5, aisle_every: null, aisle_width: 4, removed: [],
            shade_free_from: 9, shade_free_to: 15, ...extra },
});

test('cleanItem keeps sizes in range and drops what cannot be used', () => {
  assert.equal(cleanItem({ type: 'road' }), null);
  assert.equal(cleanItem({ type: 'site', latlngs: [[0, 0], [1, 1]] }), null);
  const s = cleanItem({ type: 'site', latlngs: [['1', '2'], [1, 3], [2, 3]], base: '900', tilt: 95, azimuth: '180', canopy: 'true', shift_u: 300, source: 'evil' });
  assert.deepEqual(s, { type: 'site', latlngs: [[1, 2], [1, 3], [2, 3]], base: 500, azimuth: 180, canopy: true, shift_u: 200 });
  const t = cleanItem({ type: 'obstacle', kind: 'tree', center: [1, 2], diameter: 100, height: -1, clearance: 3 });
  assert.deepEqual(t, { type: 'obstacle', kind: 'tree', center: [1, 2], diameter: 60, height: 8, clearance: 3 });
  const p = cleanItem({ type: 'exclusion', kind: 'path', path: [[0, 0], [0, 0.001]], width: 0 });
  assert.equal(p.width, 4);
  assert.equal(p.latlngs.length >= 4, true);
  assert.deepEqual(cleanRemoved([[[0, 0], [0, 1], [1, 1], [1, 0]], [[0, 0]], 'x']), [[[0, 0], [0, 1], [1, 1], [1, 0]]]);
});

test('orientations, the engine use of the layout and labels', () => {
  const area = { type: 'site', latlngs: rect(0, 0, 200, 150) };
  const P = project([area]);
  assert.deepEqual(orientationOf(P, area), { own: false, ew: false, canopy: false, tilt: 10, azimuth: 0 });   // south of the equator faces north
  assert.equal(layoutUsed(P), false);
  const own = { ...area, east_west: true, tilt: 12, azimuth: 90 };
  assert.equal(orientationOf(P, own).ew, true);
  assert.equal(layoutUsed(project([own])), true);
  assert.equal(layoutUsed(project([area, { type: 'obstacle', kind: 'tree', center: ll([10, 10]), diameter: 6, height: 8 }])), true);
  assert.match(itemLabel(P, area), /^PV area · 3\.00 ha$/);
  assert.match(itemLabel(P, own), /east-west 12° \/ 90°/);
  assert.equal(itemLabel(P, { type: 'obstacle', kind: 'tree', center: [0, 0], diameter: 6, height: 8 }), 'Tree · 8.0 m high · crown 6.0 m');
});

test('rectangles: size, rotation and corners round trip; squared azimuth', () => {
  const r = rectOf(rect(0, 0, 30, 10));
  assert.ok(Math.abs(r.length - 30) < 0.01 && Math.abs(r.width - 10) < 0.01 && Math.abs(r.rotation - 90) < 0.01);
  const again = rectOf(rectCorners(rect(0, 0, 30, 10), { ...r, length: 40 }));
  assert.ok(Math.abs(again.length - 40) < 0.01 && Math.abs(again.width - 10) < 0.01);
  assert.equal(rectOf(rect(0, 0, 30, 10).slice(0, 3)), null);
  assert.equal(alignedAzimuth(rect(0, 0, 30, 10), false, lat0), 0);
  assert.equal(alignedAzimuth(rect(0, 0, 30, 10), false, 10), 180);
  assert.equal(alignedAzimuth(rect(0, 0, 10, 30), true, 10), 90);
});

test('a keepout path moves with a dragged strip and becomes a zone when reshaped', () => {
  const q = { kind: 'path', path: [[0, 0], [0, 1]], width: 4 };
  followPath(q, [[0, 0], [1, 0]], [[0.5, 0.5], [1.5, 0.5]]);
  assert.deepEqual(q.path, [[0.5, 0.5], [0.5, 1.5]]);
  followPath(q, [[0, 0], [1, 0]], [[0, 0], [2, 0]]);
  assert.equal(q.kind, undefined);
  assert.equal(q.path, undefined);
});

test('the fill of a project, tables taken out and the alignment to a click', () => {
  const P = project([{ type: 'site', latlngs: rect(0, 0, 200, 150) }, { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(80, 60, 120, 90) }]);
  assert.equal(fillLayout(project([])), null);
  const F = fillLayout(P), R = F.result, { slant, along } = tableSize(P);
  assert.ok(R.n_tables > 50 && R.tables.length === R.n_tables && F.emptyAreas === 0);
  assert.equal(R.modules, R.n_tables * 56);
  assert.ok(Math.abs(R.kwp - R.modules * 0.55) < 1e-9);
  assert.ok(Math.abs(R.slant - slant) < 1e-12 && Math.abs(R.along - along) < 1e-12);
  assert.ok(Math.abs(R.site_m2 - 30000) < 30);
  // without the building more tables fit
  assert.ok(fillLayout(project([P.layout.polygons[0]])).result.n_tables > R.n_tables);
  // a table taken out stays out of the next fill
  P.layout.removed = [R.tables[3]];
  const F2 = fillLayout(P);
  assert.equal(F2.result.n_tables, R.n_tables - 1);
  const K = keepOnly(P, R, R.tables.map((_, i) => i !== 0));
  assert.equal(K.n_tables, R.n_tables - 1);
  assert.equal(K.table_area.length, K.tables.length);
  // aligning to a table's corner gives shifts that keep a corner there
  P.layout.removed = [];
  const item = P.layout.polygons[0], pr = localProjector(item.latlngs);
  for (const corner of R.tables[5]) {   // each corner of a table, and a point off the grid
    for (const at of [corner, pr.inv(pr.fwd(corner).map((x) => x + 1.3))]) {
      const s = alignShift(P, item, at);
      assert.ok(s.shift_u >= 0 && s.shift_v >= 0);
      Object.assign(item, s);
      const c = pr.fwd(at), T = fillLayout(P).result.tables;
      assert.ok(T.some((t) => t.some((q) => { const m = pr.fwd(q); return Math.hypot(m[0] - c[0], m[1] - c[1]) < 0.05; })), `a table corner at ${c}`);
    }
  }
});

test('PV areas on sloped ground: the slope across the rows, the pitch on the plan and the engine use', () => {
  const flat = { type: 'site', latlngs: rect(0, 0, 200, 150) }, P = project([flat]);
  assert.equal(crossSlope(P, flat), null);
  const down = { ...flat, slope: 10 }, up = { ...flat, slope: 10, slope_azimuth: 180 }, side = { ...flat, slope: 10, slope_azimuth: 90 };
  assert.ok(Math.abs(crossSlope(P, down) - 10) < 1e-9 && Math.abs(crossSlope(P, up) + 10) < 1e-9 && Math.abs(crossSlope(P, side)) < 1e-9);   // facing north here
  const { slant, along } = tableSize(P), g0 = rowsOf(P, flat, slant, along), g1 = rowsOf(P, down, slant, along);
  assert.ok(Math.abs(g1.pitch / g0.pitch - Math.cos(10 * Math.PI / 180)) < 1e-12 && g1.label === 'project on a 10.0° slope');
  assert.ok(!layoutUsed(P) && layoutUsed(project([down])));
  assert.ok(fillLayout(project([down])).result.n_tables > fillLayout(P).result.n_tables);
  assert.deepEqual(cleanItem({ ...flat, slope: '60', slope_azimuth: 400 }), { type: 'site', latlngs: flat.latlngs, slope: 45 });
  assert.equal(crossSlope({ ...P, pv: { ...P.pv, mount: 'tracker' } }, down), null);
});

test('shade-free rows', () => {
  const P = project([]);
  const r = shadeFreeGcr(P);
  assert.ok(r.gcr > 0.1 && r.gcr < 0.95);
  assert.match(shadeFreeGcr({ ...P, pv: { ...P.pv, mount: 'tracker' } }).error, /backtracking/);
  assert.match(shadeFreeGcr({ ...P, layout: { ...P.layout, shade_free_from: 16 } }).error, /Shade-free hours/);
});

test('coordinates from text, in DMS, distances and longitude wrap', () => {
  assert.deepEqual(parseCoords('-8.5, 115.2'), [-8.5, 115.2]);
  assert.deepEqual(parseCoords('https://www.google.com/maps/@-8.71,115.17,15z'), [-8.71, 115.17]);
  const d = parseCoords(`8°30'0"S 115°12'0"E`);
  assert.ok(Math.abs(d[0] + 8.5) < 1e-9 && Math.abs(d[1] - 115.2) < 1e-9);
  assert.equal(parseCoords('Denpasar'), null);
  assert.equal(toDMS(-6.2, 106.85), '6°12′00.0″S 106°51′00.0″E');
  assert.ok(Math.abs(km({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.19) < 0.1);
  assert.equal(wrapLon(190), -170);
});

test('imported shapes: kinds from the export, the chosen kind, holes and points; names are not kept', () => {
  const ring = rect(0, 0, 10, 10);
  const items = [
    { kind: 'polygon', latlngs: ring, props: { name: '<img src=x onerror=alert(1)>' } },
    { kind: 'hole', latlngs: ring },
    { kind: 'point', latlng: ll([5, 5]), props: { diameter: 4, height: '7' } },
    { kind: 'polygon', latlngs: ring, props: { soloptima: 'building', height: 12 } },
    { kind: 'point', latlng: ll([1, 1]), props: { soloptima: 'site' } },
  ];
  const out = importedItems(items, 'site');
  assert.deepEqual(out.map((g) => g.kind || g.type), ['site', 'exclusion', 'tree', 'building']);
  assert.equal(out[2].height, 7);
  assert.ok(out.every((g) => g.source === 'import' && !('name' in g)));
});
