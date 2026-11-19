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

test('the 3D view: faces of the layout, the sun, shadows and the camera', async () => {
  const { sceneOf, sunOf, shadowOf, cameraOf, drawList, groundOf } = await import('../src/lib/layout/scene.js');
  assert.equal(sceneOf(project([])), null);
  const site = { type: 'site', latlngs: rect(0, 0, 60, 40), slope: 10, slope_azimuth: 0 };
  const P = project([site, { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(80, 0, 90, 10) }, { type: 'obstacle', kind: 'tree', center: ll([-20, 20]), diameter: 6, height: 9 }]);
  P.pv.mount_height = 1.5;
  P.layout.result = fillLayout(P).result;
  const S = sceneOf(P), n = P.layout.result.tables.length;
  assert.equal(S.faces.filter((f) => f.kind === 'table').length, n);
  assert.equal(S.faces.filter((f) => f.kind === 'building').length, 4);
  assert.equal(S.faces.filter((f) => f.kind === 'crown').length, 9);
  // the ground of the area falls to the north: northern points lower
  const pr = localProjector(site.latlngs), g = groundOf(P, site, site.latlngs.map(pr.fwd));
  assert.ok(g([0, 20]) < g([0, -20]) && Math.abs(g([0, 0])) < 1e-9);
  // noon in June at 8.5 deg S: the sun stands in the north; a shadow falls south, and a face on the ground keeps its place
  const sun = sunOf(-8.5, 5, 12);
  assert.ok(sun.el > 50 && (sun.az < 1 || sun.az > 359) && sun.dir[1] > 0);
  const sh = shadowOf({ pts: [[0, 0, 10], [1, 0, 0]] }, sun);
  assert.ok(sh[0][1] < 0 && Math.abs(sh[1][1]) < 1e-12);
  assert.equal(shadowOf({ pts: [[0, 0, 1]] }, sunOf(-8.5, 5, 5)), null);
  // a camera looking from the south sees the target in the middle of the canvas
  const cam = cameraOf(180, 30, 100, 800, 600), c = cam.to2d([0, 0, 0]);
  assert.ok(Math.abs(c[0] - 400) < 1e-9 && Math.abs(c[1] - 300) < 1e-9 && cam.eye[1] < 0);
  const list = drawList(S, sun, cam);
  assert.ok(list.length > S.faces.length && list.every((p) => p.pts.every(([x, y]) => isFinite(x) && isFinite(y)) && /^#[0-9a-f]{6}$/.test(p.fill)));
});

test('the 3D view: stations, inverters, cable routes, table colours and picking', async () => {
  const { sceneOf, sunOf, cameraOf, drawList, pickFace } = await import('../src/lib/layout/scene.js');
  const { inverterBlocks, autoPlace } = await import('../src/lib/equip/blocks.js');
  const P = project([{ type: 'site', latlngs: rect(0, 0, 80, 60) }]);
  P.layout.result = fillLayout(P).result;
  P.electrical = { inverter_layout: 'string' };
  P.layout.stations = autoPlace(P, 4, 1).stations.concat([{ kind: 'substation', latlng: ll([120, 30]) }]);
  const B = inverterBlocks(P), S = sceneOf(P, B), n = P.layout.result.tables.length;
  assert.equal(S.faces.filter((f) => f.kind === 'inv').length, 4 * 5, 'four inverter boxes');
  assert.equal(S.faces.filter((f) => f.kind === 'table').map((f) => f.i).join(), [...Array(n).keys()].join(), 'tables keep their index');
  assert.equal(S.lines.filter((l) => l.kind === 'dc').length, n);
  assert.equal(S.lines.filter((l) => l.kind === 'ac').length, 4);
  assert.equal(S.lines.filter((l) => l.kind === 'mv').length, 1, 'the PV station to the substation');
  const cam = cameraOf(180, 60, S.size * 2.4, 800, 600), list = drawList(S, sunOf(-8.5, 5, 12), cam, (f) => (f.i === 0 ? '#ff0000' : null));
  assert.ok(list.some((p) => p.line === 'dc') && list.some((p) => p.face && p.face.i === 0 && p.fill.startsWith('#')));
  const top = list.filter((p) => p.face && p.face.kind === 'table').at(-1), c = top.pts.reduce((a, q) => [a[0] + q[0] / top.pts.length, a[1] + q[1] / top.pts.length], [0, 0]);
  assert.equal(pickFace(S, cam, c[0], c[1]), top.face, 'a click in a table picks it');
  assert.equal(pickFace(S, cam, -50, -50), null);
});

test('the 3D view on the GPU: triangles of a polygon and the mesh', async () => {
  const { sceneOf, triangulate, meshOf } = await import('../src/lib/layout/scene.js');
  const area = (pts, t) => t.reduce((a, [i, j, k]) => a + Math.abs((pts[j][0] - pts[i][0]) * (pts[k][1] - pts[i][1]) - (pts[j][1] - pts[i][1]) * (pts[k][0] - pts[i][0])) / 2, 0);
  const L = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];   // an L of 6 m², with a reflex corner
  for (const pts of [L, L.slice().reverse()]) {
    const t = triangulate(pts);
    assert.equal(t.length, 4);
    assert.ok(Math.abs(area(pts, t) - 6) < 1e-9, 'the triangles cover the L once');
  }
  assert.deepEqual(triangulate([[0, 0], [1, 0]]), []);
  const P = project([{ type: 'site', latlngs: rect(0, 0, 60, 40) }, { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(80, 0, 90, 10) }]);
  P.layout.result = fillLayout(P).result;
  const S = sceneOf(P);
  S.lines = [{ a: [0, 0, 0.05], b: [5, 5, 0.05], kind: 'dc' }];
  const m = meshOf(S, () => '#ff0000', true, false), n = new Uint32Array(m.buffer, 0, 1)[0], f32 = new Float32Array(m.buffer);
  const tables = S.faces.filter((f) => f.kind === 'table').length;
  assert.equal(n % 3, 0);
  assert.equal((m.length - 8) / 24, n + 2, 'triangles, then one line of two ends');
  assert.ok(n >= 3 * (2 + 2 * tables + 2 * 4 + 2), 'ground, tables, walls and roof');
  assert.ok(f32[1] > S.size && Number.isFinite(f32[1]));
  const corner = (k) => [...m.slice(8 + 24 * k + 20, 8 + 24 * k + 24)];
  assert.ok(Array.from({ length: n }, (_, k) => corner(k)).some((c) => c.join() === '255,0,0,200'), 'a table in its own colour, shaded as a panel');
  assert.equal(corner(n)[3], 0, 'cable lines are not lit');
  assert.equal((meshOf(S, null, false, false).length - 8) / 24, n, 'no cables');
  assert.ok(S.struts.length >= 3 * tables, 'posts and frames under every table');
  assert.equal((meshOf(S, null, false, true).length - 8) / 24, n + 2 * S.struts.length);
  // a table's corners carry module coordinates: modules along, modules up
  const k = Array.from({ length: n }, (_, k) => k).find((k) => corner(k)[3] === 200);
  assert.ok([0, 28, 2].includes(Math.round(f32[2 + 6 * k + 3])) || Math.round(f32[2 + 6 * k + 4]) === 2);
});

test('the 3D view on the map: the square of imagery, its corners in the scene and the body for the shell', async () => {
  const { sceneOf, meshOf, drawList, sunOf, cameraOf } = await import('../src/lib/layout/scene.js');
  const { groundBox, groundCorners, groundBody, affineOf, GROUND_MAX_PX } = await import('../src/lib/layout/ground.js');
  const P = project([{ type: 'site', latlngs: rect(0, 0, 60, 40) }, { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(80, 0, 90, 10) }]);
  P.layout.result = fillLayout(P).result;
  const S = sceneOf(P), b = groundBox(S), s = S.size * 1.3;
  assert.equal(groundBox(null), null);
  // a square in degrees round the scene, its pixels square in degrees and at most the largest image the shell takes
  assert.ok(b.la0 < b.la1 && b.lo0 < b.lo1 && b.wrap === 0);
  assert.ok(b.w <= GROUND_MAX_PX && b.h <= GROUND_MAX_PX && Math.max(b.w, b.h) >= 256);
  assert.ok(Math.abs(b.w / b.h - (b.lo1 - b.lo0) / (b.la1 - b.la0)) < 0.01, 'square degree pixels');
  // its corners: south-west, south-east, north-east, north-west in metres, a square that holds the drawn ground with a margin
  const c = groundCorners(b, S.pr);
  assert.equal(c.length, 4);
  assert.ok(c.every((p) => p[2] < 0 && p[2] > -0.05), 'just under the faces on the ground');
  assert.ok(c[0][0] < -s && c[0][1] < -s && c[2][0] > s && c[2][1] > s, 'the plain ground lies inside the image');
  assert.ok(Math.abs(c[0][1] - c[1][1]) < 1e-6 && Math.abs(c[0][0] - c[3][0]) < 1e-6 && c[1][0] > c[0][0] && c[3][1] > c[0][1]);
  const side = c[1][0] - c[0][0], tall = c[3][1] - c[0][1];
  assert.ok(Math.abs(side - tall) / side < 0.01 && side <= 6400 + 1, 'square, at most 6.4 km');
  assert.ok(c.every(([x, y]) => { const [la, lo] = S.pr.inv([x, y]); return la >= b.la0 - 1e-9 && la <= b.la1 + 1e-9 && lo >= b.lo0 - 1e-9 && lo <= b.lo1 + 1e-9; }));
  // a small move of an item keeps the same image; the site far away gets another
  const moved = sceneOf({ ...P, layout: { ...P.layout, polygons: [P.layout.polygons[0], { ...P.layout.polygons[1], latlngs: rect(83, 0, 93, 10) }] } });
  assert.equal(groundBox(moved).key, b.key);
  const far = project([{ type: 'site', latlngs: rect(5000, 0, 5060, 40) }]);
  far.location = { lat: lat0, lon: lon0 + 5000 / kx };
  assert.notEqual(groundBox(sceneOf(far)).key, b.key);
  // across 180 deg no image is asked for; west of it the box is in [-180, 180] and wraps back to the scene
  const at = (lon) => ({ size: 100, pr: localProjector([[10, lon], [10.001, lon + 0.001]]) });
  assert.equal(groundBox(at(179.999)), null);
  const wb = groundBox(at(-190 + 0.5));
  assert.ok(wb.lo0 > 170 && wb.wrap === -360 && Math.abs(groundCorners(wb, at(-190 + 0.5).pr)[0][0]) < 1000);
  assert.equal(groundBox({ size: 100, pr: localProjector([[85, 0], [85.001, 0.001]]) }), null, 'not near a pole');
  // the body: width, height, corners, then the pixels; without an image only the corners
  const img = { w: 2, h: 1, rgba: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }, body = groundBody(c, img), dv = new DataView(body.buffer);
  assert.equal(body.length, 56 + 8);
  assert.deepEqual([dv.getUint32(0, true), dv.getUint32(4, true)], [2, 1]);
  assert.ok(Math.abs(dv.getFloat32(8 + 12 * 2, true) - c[2][0]) < 0.01 && Math.abs(dv.getFloat32(8 + 12 * 3 + 4, true) - c[3][1]) < 0.01);
  assert.deepEqual([...body.slice(56)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(groundBody(c).length, 56);
  // the fallback canvas maps image points onto the projected triangle
  const m = affineOf([0, 0], [10, 0], [0, 10], [5, 7], [25, 9], [3, 27]), on = ([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  assert.deepEqual([on([0, 0]), on([10, 0]), on([0, 10])].map((p) => p.map((x) => +x.toFixed(9))), [[5, 7], [25, 9], [3, 27]]);
  assert.equal(affineOf([0, 0], [1, 1], [2, 2], [0, 0], [1, 0], [0, 1]), null);
  // over the map a PV area on the ground is its outline, so the image shows through it
  const area = S.faces.filter((f) => f.kind === 'area').length, nArea = S.faces.filter((f) => f.kind === 'area').reduce((a, f) => a + f.pts.length, 0);
  assert.ok(area > 0);
  const plain = meshOf(S, null, false, false), onMap = meshOf(S, null, false, false, true, true), nt = (m) => new Uint32Array(m.buffer, 0, 1)[0];
  assert.ok(nt(onMap) < nt(plain), 'fewer triangles');
  assert.equal((onMap.length - 8) / 24 - nt(onMap), 2 * nArea, 'an outline of the area');
  const list = drawList(S, sunOf(-8.5, 5, 12), cameraOf(180, 60, S.size * 2.4, 800, 600), null, true);
  assert.equal(list.filter((p) => p.line === 'area').length, nArea);
  assert.ok(list.some((p) => p.shadow));
});

test('solids: pitched roofs, crowns and the PV areas on a roof match the shading geometry', async () => {
  const { roofOf, roofPieces, edgeBreaks, crownTop, roofArrays, insetPoly } = await import('../src/lib/layout/solids.js');
  const { sceneOf, meshOf, triangulate } = await import('../src/lib/layout/scene.js');
  const m = [[-10, -5], [10, -5], [10, 5], [-10, 5]], t30 = Math.tan(Math.PI / 6);   // 20 x 10 m, ridge along x (azimuth 90)
  const gable = roofOf({ height: 4, roof: 'gable', pitch: 30, ridge_az: 90 }, m);
  assert.ok(Math.abs(gable.top - (4 + 5 * t30)) < 1e-9 && Math.abs(gable.h([3, 0]) - gable.top) < 1e-9 && Math.abs(gable.h([0, -5]) - 4) < 1e-9);
  assert.equal(roofPieces(gable, m).length, 2);
  assert.deepEqual(edgeBreaks(gable, m[1], m[2]).map((x) => +x.toFixed(9)), [0.5], 'the gable end wall peaks under the ridge');
  const hip = roofOf({ height: 4, roof: 'hip', pitch: 30, ridge_az: 90 }, m);
  assert.ok(Math.abs(hip.h([9, 0]) - (4 + t30)) < 1e-9 && Math.abs(hip.top - gable.top) < 1e-9);
  assert.equal(roofPieces(hip, m).length, 4);
  const shed = roofOf({ height: 3, roof: 'shed', pitch: 10, ridge_az: 180 }, m);   // falls south
  assert.ok(shed.h([0, 5]) > shed.h([0, -5]) && Math.abs(shed.h([0, -5]) - 3) < 1e-9);
  assert.equal(roofOf({ height: 6 }, m).top, 6);
  // the roof pieces cover the footprint once
  const area = (q) => Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % q.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
  for (const r of [gable, hip, shed]) assert.ok(Math.abs(roofPieces(r, m).reduce((s, x) => s + area(x.poly), 0) - 200) < 1e-6);
  // crowns: the tops the engine shades with
  assert.equal(crownTop('cone', 10, 6, 0), 10); assert.ok(Math.abs(crownTop('cone', 10, 6, 3) - 1.6) < 1e-9);
  assert.ok(Math.abs(crownTop('round', 10, 6, 0) - 10) < 1e-9 && Math.abs(crownTop('round', 10, 6, 3) - 7) < 1e-9);
  assert.equal(crownTop('palm', 10, 6, 2), 9); assert.equal(crownTop(undefined, 10, 6, 2.9), 10); assert.equal(crownTop('round', 10, 6, 3.1), 0);
  assert.equal(insetPoly([[0, 0], [1, 0], [1, 1], [0, 1]], 0.6), null, 'a roof too small for the setback has no area');
  // PV on the roof: one flush area on the sun side of a gable (south of the equator: the north plane)
  const pr = localProjector(rect(0, 0, 20, 10)), b = { type: 'obstacle', kind: 'building', height: 4, roof: 'gable', pitch: 30, ridge_az: 90, latlngs: rect(0, 0, 20, 10) };
  const arr = roofArrays(b, pr, -8.5);
  assert.equal(arr.length, 1);
  assert.ok(Math.abs(arr[0].tilt - 30) < 0.1 && Math.abs(arr[0].azimuth - 0) < 0.1 && arr[0].canopy && arr[0].rooftop && arr[0].slope === 30 && arr[0].h0 === 0.15);
  const c = arr[0].latlngs.map(pr.fwd).reduce((a, p, _, q) => [a[0] + p[0] / q.length, a[1] + p[1] / q.length], [0, 0]);
  assert.ok(Math.abs(arr[0].base - roofOf(b, b.latlngs.map(pr.fwd)).h(c)) < 0.01, 'the area sits on the plane at its centre');
  assert.equal(roofArrays({ ...b, roof: undefined }, pr, -8.5)[0].base, 4, 'a flat roof: one area at the roof height');
  // the scene draws the shaped crowns within the shading envelope and the gable walls up to the ridge
  const P = project([b, ...['round', 'cone', 'palm'].map((shape, i) => ({ type: 'obstacle', kind: 'tree', shape, center: ll([40 + 15 * i, 30]), diameter: 6, height: 10 }))]);
  const S = sceneOf(P), lp = S.pr;
  ['round', 'cone', 'palm'].forEach((shape, i) => {
    const ctr = lp.fwd(ll([40 + 15 * i, 30])), it = 1 + i;
    for (const f of S.faces.filter((f) => f.it === it && f.kind === 'leaf')) for (const p of f.pts)
      assert.ok(p[2] <= crownTop(shape, 10, 6, Math.hypot(p[0] - ctr[0], p[1] - ctr[1])) + 0.25, `${shape} crown inside its shading top`);
  });
  const walls = S.faces.filter((f) => f.it === 0 && f.kind === 'building');
  assert.ok(walls.some((f) => f.pts.length === 5 && Math.abs(Math.max(...f.pts.map((p) => p[2])) - (4 + 5 * t30)) < 1e-6), 'gable end wall');
  assert.ok(S.faces.some((f) => f.it === 0 && f.kind === 'glass') && S.faces.some((f) => f.kind === 'door'));
  const mesh = meshOf(S), nt = new Uint32Array(mesh.buffer, 0, 1)[0], f32 = new Float32Array(mesh.buffer);
  for (let k = 0; k < (mesh.length - 8) / 24; k++) for (let j = 0; j < 5; j++) assert.ok(Number.isFinite(f32[2 + 6 * k + j]));
  assert.ok(nt > 0 && nt % 3 === 0);
  assert.equal(triangulate([[0, 0], [0, 0], [0, 0]]).length, 1, 'degenerate input still closes');
});

test('3D editing: move, turn, slope and resize an item as saved', async () => {
  const { frameOf, sizeOf, moveItem, turnItem, slopeTurns, withSlope, resizeItem, defaultRidge, canSlope } = await import('../src/lib/layout/transform.js');
  const P = project([]);
  const b = cleanItem({ type: 'obstacle', kind: 'building', height: 5, latlngs: rect(0, 0, 20, 10) });
  const near = (a, x, tol = 0.02) => Math.abs(a - x) < tol;
  const s0 = sizeOf(b, P);
  assert.ok(near(s0[0], 20) && near(s0[1], 10) && s0[2] === 5);
  const mv = moveItem(b, P, 7, -3, 4), m0 = frameOf(b), m1 = frameOf(mv);
  const shift = [m1.pr.fwd(mv.latlngs[0])[0] - m1.pr.fwd(b.latlngs[0])[0], m1.pr.fwd(mv.latlngs[0])[1] - m1.pr.fwd(b.latlngs[0])[1]];
  assert.ok(near(shift[0], 7) && near(shift[1], -3), 'moved 7 m east, 3 m south');
  assert.equal(mv.height, 5, 'a building does not leave the ground');
  // a quarter turn swaps the long axis from east-west to north-south and turns the ridge with it
  const roofed = { ...b, roof: 'gable', pitch: 30, ridge_az: defaultRidge(b, 'gable', -8.5) };
  assert.ok(near(roofed.ridge_az, 90, 0.5));
  const tq = turnItem(roofed, P, 90), st = sizeOf(tq, P);
  assert.ok(near(st[0], 20) && near(frameOf(tq).axis % 180, 0, 0.5) && near(tq.ridge_az, 180, 0.01));
  assert.ok(near(defaultRidge(b, 'shed', -8.5), 0, 0.5) && near(defaultRidge(b, 'shed', 30), 180, 0.5), 'a shed falls to the equator');
  // a PV area takes its own azimuth when turned; its ground slope follows turns about the east and north axes
  const site = cleanItem({ type: 'site', latlngs: rect(0, 0, 60, 40) });
  const ts = turnItem(site, P, 30);
  assert.ok(near(ts.azimuth, 30, 0.01) && ts.tilt === 10, 'project azimuth 0 (south of the equator) plus 30');
  const sl = withSlope(site, 10, 0);
  assert.ok(near(sl.slope, 10, 0.01) && near(sl.slope_azimuth, 180, 0.01), 'raised to the north: it falls south');
  const back = slopeTurns(sl, P);
  assert.ok(near(back[0], 10, 0.01) && near(back[1], 0, 0.01));
  const both = slopeTurns(withSlope(site, 5, -7), P);
  assert.ok(near(both[0], 5, 0.05) && near(both[1], -7, 0.05));
  assert.equal(withSlope(sl, 0, 0).slope, undefined, 'level again');
  assert.ok(canSlope(site, P) && !canSlope({ ...site, rooftop: true }, P) && !canSlope({ ...site, carport: true }, P));
  // resizing along an axis keeps the centre and the other side
  const rs = resizeItem(b, P, 0, 30), sr = sizeOf(rs, P);
  assert.ok(near(sr[0], 30) && near(sr[1], 10));
  assert.equal(resizeItem(b, P, 2, 9).height, 9);
  const tree = cleanItem({ type: 'obstacle', kind: 'tree', center: ll([5, 5]), diameter: 6, height: 9, shape: 'cone' });
  assert.equal(resizeItem(tree, P, 0, 8).diameter, 8);
  assert.equal(resizeItem(tree, P, 2, 500).height, 100, 'clamped to the tree limit');
  assert.equal(moveItem({ ...site, carport: true, h0: 3 }, P, 0, 0, 1.5).h0, 4.5);
  assert.equal(moveItem(site, P, 0, 0, -5).base, 0, 'never below the ground');
  // what comes out is still a valid saved item
  for (const q of [mv, tq, ts, sl, rs, resizeItem(tree, P, 0, 8)]) assert.ok(cleanItem(q), 'cleanItem keeps it');
  assert.deepEqual(cleanItem(roofed).roof, 'gable');
  assert.equal(cleanItem({ ...roofed, pitch: 500 }).pitch, 75);
  assert.equal(cleanItem({ ...tree, shape: 'banana' }).shape, undefined, 'an unknown shape is a column');
});

test('the fill: a building carries the PV area on its roof, blocks one on the ground; a dragged item leaves the scene', async () => {
  const { sceneOf } = await import('../src/lib/layout/scene.js');
  const b = { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(0, 0, 40, 30) };
  const roof = { type: 'site', latlngs: rect(1, 1, 39, 29), base: 6, rooftop: true };
  const P = project([b, roof]);
  P.layout.modules_per_table = 4;
  assert.ok(fillLayout(P).result.tables.length > 0, 'panels on its own roof');
  assert.equal(fillLayout(project([b, { type: 'site', latlngs: rect(1, 1, 39, 29) }])).result.tables.length, 0, 'a ground area under a building gets none');
  const unit = { type: 'obstacle', kind: 'building', height: 7.5, latlngs: rect(10, 10, 30, 20) };   // a rooftop unit 1.5 m over the roof
  const Q = project([b, roof, unit]);
  Q.layout.modules_per_table = 4;
  assert.ok(fillLayout(Q).result.tables.length < fillLayout(P).result.tables.length, 'a unit on the roof still blocks');
  // while an item is dragged the scene leaves it out, and the item alone draws on the same projector
  P.layout.result = fillLayout(P).result;
  const all = sceneOf(P), rest = sceneOf(P, null, { skip: 1 }), one = sceneOf(P, null, { only: 1, pr: rest.pr });
  assert.equal(rest.faces.filter((f) => f.it === 1).length, 0);
  assert.equal(one.faces.length + rest.faces.length, all.faces.length, 'the two parts make the whole');
  assert.deepEqual(one.pr.fwd(rect(0, 0, 1, 1)[0]), all.pr.fwd(rect(0, 0, 1, 1)[0]));
});

test('the session trail folds a run of the same successful call into one line, and keeps failures', async () => {
  const { trail } = await import('../src/lib/reports/trail.js');
  const { noteCall } = await import('../src/lib/reports/trail.js');
  const n0 = trail.length;
  for (let i = 0; i < 50; i++) noteCall('view3d_frame', 3);
  assert.equal(trail.length, n0 + 1);
  assert.match(trail.at(-1).text, /×50/);
  noteCall('view3d_frame', 3, 'lost the device');
  noteCall('view3d_frame', 3);
  assert.equal(trail.length, n0 + 3, 'a failure is its own line and starts a new run');
});

test('moving the site moves the layout with it, shapes and offsets kept', async () => {
  const { shiftLayout, farItems } = await import('../src/lib/layout/follow.js');
  const { projector } = await import('../src/lib/layout/geometry.js');
  const from = { lat: 7, lon: -1 }, to = { lat: -6.175, lon: 106.827 };
  const sq = [[7.001, -1.001], [7.001, -0.999], [6.999, -0.999], [6.999, -1.001]];
  const L = { polygons: [{ type: 'site', latlngs: sq.map((p) => [...p]) }, { kind: 'tree', center: [7.0005, -1.0002] }], stations: [{ kind: 'pv', latlng: [7, -1] }], result: { tables: [sq.map((p) => [...p])] }, removed: [] };
  assert.equal(farItems(L, to), 2);
  shiftLayout(L, from, to);
  assert.equal(farItems(L, to), 0);
  const a = projector(from.lat, from.lon), b = projector(to.lat, to.lon);
  sq.forEach((p, i) => { const x = a.fwd(p), y = b.fwd(L.polygons[0].latlngs[i]); assert.ok(Math.hypot(x[0] - y[0], x[1] - y[1]) < 0.05, 'the same offset from the site'); });
  assert.deepEqual(L.stations[0].latlng, [to.lat, to.lon]);
});

test('the 3D scene leaves out items over 50 km from the site', async () => {
  const { sceneOf } = await import('../src/lib/layout/scene.js');
  const sq = (lat, lon) => [[lat, lon], [lat + 0.001, lon], [lat + 0.001, lon + 0.001], [lat, lon + 0.001]];
  const P = { location: { lat: -6.17, lon: 106.83 }, pv: {}, layout: { polygons: [{ type: 'site', latlngs: sq(-6.17, 106.83) }, { type: 'obstacle', kind: 'building', height: 6, latlngs: sq(7, -1) }], result: null } };
  const S = sceneOf(P);
  assert.ok(S && S.size < 1000, `scene spans ${S && S.size} m`);
  assert.ok(S.faces.every((f) => f.it !== 1), 'the far building is not drawn');
});

test('far items come in groups, and a group moves to the site with its shape', async () => {
  const { farGroups, bringItems } = await import('../src/lib/layout/follow.js');
  const { km } = await import('../src/lib/layout/coords.js');
  const loc = { lat: -6.17, lon: 106.83 };
  const L = { polygons: [{ type: 'site', latlngs: [[-6.17, 106.83], [-6.169, 106.83], [-6.169, 106.831]] }, { kind: 'tree', center: [7, -1] }, { kind: 'tree', center: [7.001, -1] }, { type: 'site', latlngs: [[0.42, 52.91], [0.421, 52.91], [0.421, 52.911]] }] };
  const G = farGroups(L, loc);
  assert.deepEqual(G.map((g) => g.idx), [[1, 2], [3]]);
  bringItems(L, G[0].idx, G[0].at, loc);
  assert.ok(km({ lat: L.polygons[1].center[0], lon: L.polygons[1].center[1] }, loc) < 0.01);
  assert.ok(Math.abs(km({ lat: L.polygons[2].center[0], lon: L.polygons[2].center[1] }, loc) - 0.111) < 0.002, 'spacing kept');
  assert.equal(farGroups(L, loc).length, 1);
});
