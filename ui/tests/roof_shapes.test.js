// The roof shapes past gable, hip and shed: their heights at the points engine/tests/roof_shapes.rs checks, the walls and faces
// the 3D view draws, the panels laid on them and the fields an item keeps (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roofOf, roofFaces, wallTop, roofArrays, capProfile, ellipseFit, ROOFS } from '../src/lib/layout/solids.js';
import { sceneOf, meshOf } from '../src/lib/layout/scene.js';
import { defaultRidge } from '../src/lib/layout/transform.js';
import { cleanItem, roundCorners, roundDiameter } from '../src/lib/layout/items.js';
import { localProjector } from '../src/lib/layout/geometry.js';

const lat0 = -8.5, lon0 = 115.2, ky = 110574, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
const ll = ([x, y]) => [lat0 + y / ky, lon0 + x / kx];
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(ll);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]], ob = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
const L = [[0, 0], [12, 0], [12, 4], [4, 4], [4, 10], [0, 10]];
const circle = (r, n) => Array.from({ length: n }, (_, k) => [r * Math.sin(k * 2 * Math.PI / n), r * Math.cos(k * 2 * Math.PI / n)]);
const tan = (d) => Math.tan(d * Math.PI / 180);

test('roof heights at the points the engine checks', () => {
  const dome = roofOf({ height: 4, roof: 'dome' }, ob);
  assert.ok(near(dome.fit.a, 10) && near(dome.fit.b, 5) && near(dome.rise, 2.5), 'the ellipse fills a 20 x 10 m footprint; default rise half the short half axis');
  assert.ok(near(dome.h([5, 0]), 4 + 2.5 * capProfile(0.5, 0.5)) && near(dome.h([5, 0]), 5.97822, 1e-5), 'the dome by hand');
  assert.ok(near(dome.h([9.9, 4.9]), 4) && near(dome.top, 6.5), 'a corner outside the ellipse stays at the walls');
  assert.ok(near(roofOf({ height: 5, roof: 'dome', rise: 10 }, circle(10, 720)).h([0, 6]), 13, 1e-3), 'a hemisphere');
  assert.equal(ellipseFit([[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]]), null, 'no dome on a C');
  const mansard = roofOf({ height: 4, roof: 'mansard', pitch: 60, pitch2: 20, rise: 3 }, sq), brk = 3 / tan(60);
  assert.ok(near(mansard.top, 7 + tan(20) * (10 - brk)) && near(mansard.h([0, 0]), mansard.top) && near(mansard.h([0, -10 + brk]), 7));
  const gambrel = roofOf({ height: 4, roof: 'gambrel', pitch: 60, pitch2: 20, rise: 3, ridge_az: 90 }, sq);
  const end = wallTop(gambrel, sq[3], sq[0]);   // the west wall, across the ridge
  assert.ok(near(Math.max(...end.map((p) => p[2])), mansard.top) && end.length === 5, 'the gambrel end wall: eaves, two breaks, ridge');
  const pyr = roofOf({ height: 4, roof: 'pyramid', pitch: 30, ridge_az: 90 }, ob);
  assert.ok(near(pyr.top, 4 + 5 * tan(30)) && near(pyr.h([5, 0]), 4 + 2.5 * tan(30)));
  const bf = roofOf({ height: 4, roof: 'butterfly', pitch: 20, ridge_az: 90 }, sq);
  assert.ok(near(bf.h([3, 0]), 4) && near(bf.h([0, -10]), 4 + 10 * tan(20)) && roofFaces(bf, sq).length === 2);
  const st = roofOf({ height: 4, roof: 'sawtooth', pitch: 30, width: 5, ridge_az: 180 }, sq);
  assert.ok(near(st.h([0, -7.5]), 4 + 2.5 * tan(30)) && near(st.h([0, 10]), 4 + 5 * tan(30)));
  assert.equal(wallTop(st, sq[1], sq[2]).length, 8, 'the east wall, south to north: three steps down');
  assert.equal(roofFaces(st, sq).filter((f) => f.kind === 'building').length, 3, 'three upright faces');
  const bv = roofOf({ height: 4, roof: 'barrel', rise: 5, ridge_az: 90 }, ob);
  assert.ok(near(bv.h([0, 3]), 8) && near(bv.top, 9) && near(roofOf({ height: 4, roof: 'barrel', ridge_az: 90 }, ob).top, 6.5));
  const cone = roofOf({ height: 4, roof: 'cone', rise: 10 }, circle(10, 720));
  assert.ok(near(cone.h([0, 5 * Math.cos(Math.PI / 720)]), 9, 1e-6));
  const par = roofOf({ height: 6, roof: 'parapet' }, sq);
  assert.ok(par.top === 7 && par.h([0, 0]) === 6 && wallTop(par, sq[0], sq[1]).every((p) => p[2] === 7));
});

test('every shape draws within its walls and top, and makes a mesh', () => {
  for (const kind of ROOFS) for (const m of [sq, ob, circle(8, 40), L]) {
    const roof = roofOf({ height: 4, roof: kind, ridge_az: 30 }, m);
    for (const detail of [true, false]) {
      const faces = roofFaces(roof, m, detail);
      assert.ok(faces.length > 0, kind);
      for (const f of faces) for (const p of f.pts) assert.ok(Number.isFinite(p[2]) && p[2] >= 4 - 1e-9 && p[2] <= roof.top + 1e-9, `${kind}: ${p}`);
      m.forEach((a, i) => wallTop(roof, a, m[(i + 1) % m.length], detail).forEach((p) => assert.ok(p[2] >= 4 - 1e-9 && p[2] <= roof.top + 1e-9, `${kind} wall`)));
    }
  }
  // the dome's grid lies on its surface: 24 segments and the 32 corners round (8 of them on a segment's line), 8 up, and the
  // flat ring round it
  const m = circle(10, 32), dome = roofOf({ height: 4, roof: 'dome' }, m), faces = roofFaces(dome, m);
  for (const f of faces) if (!f.col) for (const p of f.pts) assert.ok(near(p[2], dome.h(p), 1e-9), 'on the surface');
  assert.equal(faces.filter((f) => !f.col).length, (24 + 32 - 8) * 8);
  assert.ok(roofFaces(dome, m, false).length < faces.length / 2, 'coarser with many items');
  const items = ROOFS.map((roof, i) => ({ type: 'obstacle', kind: 'building', height: 4, roof, ridge_az: 0, latlngs: rect(30 * i, 0, 30 * i + 20, 12) }));
  const P = { location: { lat: lat0, lon: lon0 }, pv: { mount: 'fixed', tilt: 10, azimuth: 0, azimuth_auto: true, gcr: 0.5, module_length: 2.278, module_width: 1.134 },
              layout: { polygons: items, orientation: 'portrait', modules_across: 2, modules_per_table: 28 } };
  const S = sceneOf(P), mesh = meshOf(S), f32 = new Float32Array(mesh.buffer), nt = new Uint32Array(mesh.buffer, 0, 1)[0];
  assert.ok(nt > 0 && nt % 3 === 0);
  for (let k = 0; k < (mesh.length - 8) / 24; k++) for (let j = 0; j < 3; j++) assert.ok(Number.isFinite(f32[2 + 6 * k + j]));
});

test('panels on roof shapes, saved fields and round footprints', () => {
  const pr = localProjector(rect(0, 0, 20, 20)), b = { type: 'obstacle', kind: 'building', height: 6, latlngs: rect(0, 0, 20, 20) };
  for (const roof of ['dome', 'cone', 'barrel', 'sawtooth']) assert.deepEqual(roofArrays({ ...b, roof }, pr, -8.5), [], `no panels on a ${roof}`);
  const sideOf = (a) => Math.sqrt(Math.abs(a[0].latlngs.map(pr.fwd).reduce((s, p, i, q) => s + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0)) / 2);
  assert.ok(near(sideOf(roofArrays(b, pr, -8.5)), 19, 0.01) && near(sideOf(roofArrays({ ...b, roof: 'parapet', rise: 1 }, pr, -8.5)), 17, 0.01), 'a 1 m parapet: 1 m further in');
  assert.equal(roofArrays({ ...b, roof: 'parapet' }, pr, -8.5)[0].base, 6, 'on the roof behind the parapet');
  assert.equal(roofArrays({ ...b, roof: 'butterfly', pitch: 10, ridge_az: 90 }, pr, -8.5).length, 1, 'the sunward plane of a butterfly');
  const mans = roofArrays({ ...b, roof: 'mansard', pitch: 70, pitch2: 20, rise: 2.5, ridge_az: 90 }, pr, -8.5);
  assert.ok(mans.some((a) => near(a.tilt, 20, 0.05) && near(a.azimuth, 0, 0.05)) && mans.every((a) => a.tilt === 20 || a.tilt === 70), 'planes of both pitches, the upper one facing the sun among them');
  assert.deepEqual(cleanItem({ ...b, roof: 'dome', pitch: 30, ridge_az: 10 }), { ...b, roof: 'dome' });
  assert.equal(cleanItem({ ...b, roof: 'dome', rise: 900 }).rise, 200);
  assert.equal(cleanItem({ ...b, roof: 'parapet' }).rise, 1);
  assert.equal(cleanItem({ ...b, roof: 'parapet', rise: 40 }).rise, 10);
  assert.deepEqual(cleanItem({ ...b, roof: 'mansard', pitch: 50, pitch2: 70 }), { ...b, roof: 'mansard', pitch: 50, pitch2: 50, rise: 2.5, ridge_az: 0 });
  assert.equal(cleanItem({ ...b, roof: 'sawtooth', width: 0.2 }).width, 1);
  assert.equal(cleanItem({ ...b, round: true }).round, true);
  const rc = roundCorners(rect(0, 0, 20, 20), 12);
  assert.equal(rc.length, 48);
  assert.ok(near(roundDiameter(rc), 12 * Math.sqrt(48 / (2 * Math.PI) * Math.sin(2 * Math.PI / 48)), 0.01), 'a 48-gon of 12 m');
  assert.ok(near(defaultRidge(b, 'sawtooth', -8.5), defaultRidge(b, 'shed', -8.5)), 'a sawtooth falls to the equator as a shed');
});
