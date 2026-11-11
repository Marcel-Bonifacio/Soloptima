// Inverter blocks: the balanced assignment of tables to inverters or PV stations, the automatic places, the block colours and the
// lengths and per-block losses the electrical design takes from them (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assign, split, autoNodes, inverterBlocks, blockColours } from '../src/lib/equip/blocks.js';
import { plantLengths } from '../src/lib/equip/siteplan.js';
import { projector } from '../src/lib/layout/geometry.js';

const pr = projector(7, -1), ll = (x, y) => pr.inv([x, y]);
const station = (kind, x, y) => ({ kind, latlng: ll(x, y) });
const table = (x, y) => [[x, y], [x + 10, y], [x + 10, y + 4], [x, y + 4]].map(([a, b]) => ll(a, b));
// rows of tables: `nx` along, `ny` rows, 12 m apart along and 8 m between rows
const field = (nx, ny) => Array.from({ length: nx * ny }, (_, i) => table((i % nx) * 12, Math.floor(i / nx) * 8));
const plan = (stations, tables, E = {}) => ({ electrical: { len_from_layout: true, route_factor: 1, ...E }, layout: { stations, result: { tables } } });

test('assign keeps every node within its share, nearest first', () => {
  const pts = [[0, 0], [1, 0], [2, 0], [3, 0], [100, 0], [101, 0]];
  const a = assign(pts, [[0, 0], [100, 0]], 3);
  assert.deepEqual([...a], [0, 0, 0, 1, 1, 1], 'the fourth point goes to the far node: the near one is full');
  assert.deepEqual([...assign(pts, [[0, 0]], 6)], [0, 0, 0, 0, 0, 0]);
  const even = assign(pts, [[0, 0], [50, 0], [100, 0], [101, 0]]);   // 6 points, 4 nodes: two take 2, two take 1
  assert.deepEqual([0, 1, 2, 3].map((j) => [...even].filter((x) => x === j).length).sort(), [1, 1, 2, 2]);
  assert.equal(assign(pts, [], 3).every((x) => x === -1), true);
});

test('split cuts a field into compact groups of about equal size', () => {
  const pts = Array.from({ length: 100 }, (_, i) => [i % 20, Math.floor(i / 20)]);
  const g = split(pts, 7);
  assert.equal(g.length, 7);
  assert.equal(g.flat().length, 100);
  assert.equal(new Set(g.flat()).size, 100);
  assert.ok(Math.max(...g.map((x) => x.length)) - Math.min(...g.map((x) => x.length)) <= 1);
  assert.equal(split(pts.slice(0, 3), 10).length, 3, 'no more groups than points');
  assert.equal(autoNodes(pts, 4).length, 4);
  assert.ok(autoNodes(pts, 4).every((n) => pts.some((p) => p[0] === n[0] && p[1] === n[1])), 'each node on a table');
});

test('central inverters: blocks are the PV stations, balanced, string cables to them', () => {
  const t = field(10, 4), P = plan([station('pv', -20, 12), station('pv', 140, 12)], t);
  const B = inverterBlocks(P);
  assert.equal(B.mode, 'central');
  assert.deepEqual(B.blocks.map((b) => b.n), [20, 20]);
  assert.ok(B.blocks.every((b) => b.ac === null));
  const L = plantLengths(P);
  assert.equal(L.dc.n, 40);
  assert.match(L.dc.from, /PV station/);
  assert.equal(L.lv_pv, undefined, 'the LV run is inside the station: typed');
  assert.ok(L.mv_pv === undefined, 'no substation: no feeders');
});

test('string inverters: string cables to the inverters, their AC cables to the PV stations', () => {
  const t = field(10, 4), inv = autoNodes(t.map((q) => pr.fwd([(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2])), 4).map(([x, y]) => station('inv', x, y));
  const P = plan([...inv, station('pv', 60, -30), station('substation', 60, -60)], t, { inverter_layout: 'string' });
  const B = inverterBlocks(P);
  assert.equal(B.mode, 'string');
  assert.deepEqual(B.blocks.map((b) => b.n), [10, 10, 10, 10]);
  assert.ok(B.blocks.every((b) => b.ac > 0 && b.station === 0));
  const L = plantLengths(P);
  assert.match(L.dc.from, /string inverter/);
  assert.ok(L.dc.len < 30, `string cables stay short: ${L.dc.len}`);
  assert.equal(L.lv_pv.n, 4);
  assert.ok(L.lv_pv.max >= L.lv_pv.len);
  assert.ok(L.mv_pv.len > 0);
  assert.equal(inverterBlocks(plan([station('pv', 0, 0)], t, { inverter_layout: 'string' })), null, 'string inverters without inverter pins: none');
});

test('block colours: neighbours differ', () => {
  const c = blockColours([[0, 0], [10, 0], [20, 0], [0, 10], [10, 10], [20, 10]]);
  assert.equal(c.length, 6);
  assert.notEqual(c[0], c[1]);
  assert.notEqual(c[1], c[4]);
});

test('autoPlace: the pins of the design, one block each', async () => {
  const { autoPlace } = await import('../src/lib/equip/blocks.js');
  const t = field(12, 6), keep = station('substation', 0, -50);
  const c = autoPlace(plan([keep, station('pv', 0, 0)], t), 0, 3);
  assert.equal(c.kind, 'pv');
  assert.deepEqual(c.stations.map((s) => s.kind).sort(), ['pv', 'pv', 'pv', 'substation'], 'central: the PV stations replaced, the rest kept');
  const P = plan([keep], t, { inverter_layout: 'string' }), s = autoPlace(P, 8, 2);
  assert.equal(s.stations.filter((x) => x.kind === 'inv').length, 8);
  assert.equal(s.stationsAdded, 2, 'no PV station yet: they are placed too');
  P.layout.stations = s.stations;
  const B = inverterBlocks(P);
  assert.deepEqual(B.blocks.map((b) => b.n), Array(8).fill(9));
  const big = plan(autoPlace(plan([keep], field(23, 6), { inverter_layout: 'string' }), 15, 2).stations, field(23, 6), { inverter_layout: 'string' });
  const sizes = inverterBlocks(big).blocks.map((b) => b.n);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `blocks differ by one table at most: ${sizes}`);
  assert.ok(B.blocks.every((b) => b.ac > 0));
  assert.equal(autoPlace(plan([], []), 4, 1), null);
});
