// The plant's stations and the cable lengths measured from them: checks of the stations in a project file, the lengths of the DC
// string cables and the MV feeders, and the design that uses them (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStations, STATION_KINDS, MAX_STATIONS, stationMode, stationHint } from '../src/lib/layout/stations.js';
import { plantLengths, routeFactor, lengthNotes } from '../src/lib/equip/siteplan.js';
import { snapshotOf, parseSnapshot } from '../src/lib/layout/history.js';
import { projector } from '../src/lib/layout/geometry.js';
import { migrateProject } from '../src/lib/migrate-project.js';
import { computeDesign, autoSize } from '../src/lib/equip/design.js';
import { defaultLibrary } from '../src/lib/equip/library.js';
import { HOURS } from '../src/lib/series.js';

// stations and tables at local metres east and north of a substation at 7 N, 1 W
const pr = projector(7, -1), ll = (x, y) => pr.inv([x, y]);
const station = (kind, x, y, extra = {}) => ({ kind, latlng: ll(x, y), ...extra });
const table = (x, y) => [[x, y], [x + 30, y], [x + 30, y + 5], [x, y + 5]].map(([a, b]) => ll(a, b));
const plan = (stations, tables = [], E = {}) => ({
  electrical: { len_from_layout: true, route_factor: 1, ...E },
  layout: { stations, result: { tables } },
});
const near = (a, b, tol = 0.11) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('cleanStations keeps known kinds on the globe and cuts names', () => {
  const out = cleanStations([
    { kind: 'pv', latlng: ['7.5', '-1.2'], name: '  Block A  ' },
    { kind: 'dragon', latlng: [1, 1] }, { kind: 'pv', latlng: [95, 0] }, { kind: 'pv', latlng: [0, 200] }, { kind: 'pv', latlng: [1] },
    { kind: 'bess', latlng: [7, -1], name: 'x'.repeat(100) }, null, 'text',
    { kind: 'substation', latlng: [7, -1] }, { kind: 'substation', latlng: [8, -1] },
  ]);
  assert.deepEqual(out.map((s) => s.kind), ['pv', 'bess', 'substation']);
  assert.deepEqual(out[0], { kind: 'pv', latlng: [7.5, -1.2], name: 'Block A' });
  assert.equal(out[1].name.length, 40);
  assert.deepEqual(cleanStations(undefined), []);
  // blank text, null and booleans are no coordinates (num() would read them as 0 or 1)
  assert.deepEqual(cleanStations([{ kind: 'pv', latlng: [' ', ' '] }, { kind: 'pv', latlng: [null, null] }, { kind: 'pv', latlng: [true, false] }, { kind: 'pv', latlng: ['', '1'] }]), []);
  assert.equal(cleanStations(Array.from({ length: 500 }, () => ({ kind: 'pv', latlng: [1, 1] }))).length, MAX_STATIONS);
  assert.deepEqual(STATION_KINDS.map(([k]) => k), ['pv', 'bess', 'gen', 'substation', 'load']);
});

test('a placing mode stands for one known kind of station', () => {
  assert.equal(stationMode('station:pv'), 'pv');
  assert.equal(stationMode('station:substation'), 'substation');
  for (const m of ['station:dragon', 'station:', 'tree', null, undefined, 7]) assert.equal(stationMode(m), null, String(m));
  assert.match(stationHint('substation'), /placing it again moves it/);
  assert.match(stationHint('pv'), /PV station: click the map/);
});

test('nothing is measured without the box, a substation, or a station of the circuit', () => {
  const st = [station('substation', 0, 0), station('pv', 300, 0)];
  assert.equal(plantLengths(plan(st, [], { len_from_layout: false })), null);
  assert.equal(plantLengths(plan([station('pv', 300, 0)])), null);
  assert.equal(plantLengths({ electrical: { len_from_layout: true } }), null);
  const only = plantLengths(plan(st));
  assert.deepEqual(Object.keys(only), ['mv_pv'], 'no tables: only the feeder, no string cables');
  assert.equal(plantLengths(plan([station('substation', 0, 0)])), null);
});

test('a feeder is the average run to the stations of its kind, and its longest run is kept', () => {
  const st = [station('substation', 0, 0), station('pv', 300, 400), station('pv', -60, 80), station('bess', 0, -150),
              station('gen', -30, 40), station('load', 200, 0)];
  const L = plantLengths(plan(st, [], { route_factor: 1.25 }));
  assert.equal(L.mv_pv.len, 375);        // 500 m and 100 m: 300 m on average
  assert.equal(L.mv_pv.max, 625);        // the farther one sets the voltage drop
  assert.equal(L.mv_pv.n, 2);
  assert.equal(L.mv_bess.len, 187.5);
  assert.equal(L.mv_bess.max, 187.5);
  assert.equal(L.mv_gen.len, 62.5);
  assert.equal(L.load.len, 250);
  assert.match(L.mv_pv.from, /PV stations/);
});

test('string cables take the mean distance of the tables to their nearest station and keep the longest', () => {
  // two PV stations 400 m apart on the x axis; tables at their centres (15 m from the table corner x, 2.5 m up)
  const st = [station('substation', 0, 0), station('pv', 0, 0), station('pv', 400, 0)];
  const tables = [table(-15, -2.5), table(385, -2.5), table(85, -2.5), table(285, -2.5)];   // 0, 0, 100 and 100 m from a station
  const L = plantLengths(plan(st, tables));
  near(L.dc.len, 50);
  near(L.dc.max, 100);
  assert.equal(L.dc.n, 4);
  const f = plantLengths(plan(st, tables, { route_factor: 1.5 }));
  near(f.dc.len, 75);
  near(f.dc.max, 150);
  assert.ok(f.dc.max > f.dc.len);
});

test('the nearest-station search is kept only while the tables and the PV stations stay the same', () => {
  const sub = station('substation', 0, 0), tables = [table(-15, -2.5), table(85, -2.5)];
  const a = plantLengths(plan([sub, station('pv', 0, 0)], tables));
  near(a.dc.len, 50);
  assert.deepEqual(plantLengths(plan([sub, station('pv', 0, 0)], tables)), a, 'the same again');
  near(plantLengths(plan([sub, station('pv', 200, 0)], tables)).dc.len, 150);                            // the station moved: 200 and 100 m
  near(plantLengths(plan([sub, station('pv', 0, 0)], [table(185, -2.5), table(285, -2.5)])).dc.len, 250); // new tables, 200 and 300 m
  near(plantLengths(plan([sub, station('pv', 0, 0)], tables, { route_factor: 2 })).dc.len, 100);         // the factor is not part of the search
});

test('the design basis says when stations are placed but the layout has no tables', () => {
  const st = [station('substation', 0, 0), station('pv', 100, 0)];
  assert.equal(lengthNotes(plan(st, [table(0, 0)])).length, 0);
  assert.match(lengthNotes(plan(st, []))[0], /no tables/);
  assert.equal(lengthNotes(plan([station('substation', 0, 0)], [])).length, 0, 'no PV station: nothing was meant to be measured');
  assert.equal(lengthNotes(plan(st, [], { len_from_layout: false })).length, 0);
  assert.equal(lengthNotes(plan([station('pv', 100, 0)], [])).length, 0, 'no substation: the box says so');
});

test('an undo snapshot keeps the stations and brings them back cleaned', () => {
  const stations = [station('substation', 0, 0, { name: 'Main' }), station('pv', 100, 50)];
  const back = parseSnapshot(snapshotOf({ polygons: [], removed: [], stations }));
  assert.deepEqual(back.stations, cleanStations(stations));
  assert.equal(back.stations[0].name, 'Main');
  assert.deepEqual(back.items, []);
  assert.deepEqual(back.removed, []);
  // a snapshot or a layout without the key (an older state) means no stations, and bad entries do not survive
  assert.deepEqual(parseSnapshot(snapshotOf({ polygons: [], removed: [] })).stations, []);
  assert.deepEqual(parseSnapshot(JSON.stringify({ polygons: [], removed: [], stations: [{ kind: 'x', latlng: [1, 1] }, { kind: 'pv', latlng: ['', ''] }] })).stations, []);
  assert.notEqual(snapshotOf({ stations }), snapshotOf({ stations: [...stations, station('load', 5, 5)] }), 'a placed station is a new undo step');
});

test('the route factor is kept between 1 and 3 and defaults to 1.25', () => {
  assert.equal(routeFactor({}), 1.25);
  assert.equal(routeFactor({ route_factor: null }), 1.25);
  assert.equal(routeFactor({ route_factor: 0.2 }), 1);
  assert.equal(routeFactor({ route_factor: 9 }), 3);
  assert.equal(routeFactor({ route_factor: 1.4 }), 1.4);
});

test('a project file keeps its stations cleaned and gets the new electrical inputs', () => {
  const P = { name: 'x', layout: { stations: [{ kind: 'pv', latlng: [1, 2] }, { kind: 'x', latlng: [1, 2] }] }, electrical: {} };
  migrateProject(P, () => null);   // changes the project in place
  assert.deepEqual(P.layout.stations, [{ kind: 'pv', latlng: [1, 2] }]);
  assert.equal(P.electrical.len_from_layout, true);
  assert.equal(P.electrical.route_factor, 1.25);
  const none = { name: 'y' };
  migrateProject(none, () => null);
  assert.deepEqual(none.layout.stations, []);
});

// the design with lengths from the layout: a 3 MWp plant with its stations placed 400 to 900 m from the substation
const flat = (k) => new Array(HOURS).fill(k);
const designProject = (E = {}) => ({
  name: 'plan', location: { lat: 7, lon: -1 }, econ: { currency: 'USD' }, weather: null,
  load: { kw: Array.from({ length: HOURS }, (_, h) => 800 + 300 * Math.sin(h / 24 * 2 * Math.PI)) },
  pv: { capacity_kwp: 3000, dc_ac_ratio: 1.3, inverter_eff: 0.98 }, bess: { energy_kwh: 5000, power_kw: 2500, rte: 0.88 },
  diesel: { units: 2, unit_kw: 500, strategy: 'load_following', reserve_load: 0.1, reserve_pv: 0.2 }, aux: {},
  equipment: { lib: defaultLibrary(), sel: { pv: 'pv600', inverter: 'inv330', battery: 'bat5', genset: 'dg500' } },
  electrical: {
    mv_kv: 20, pf_load: 0.9, t_min: 15, t_cell_max: 70, modules_per_string: 0, derate: 0.8, trafo_pv: 'tr3150', trafo_bess: 'tr5000', trafo_gen: 'tr2500',
    gens_per_trafo: 1, gen_mv: false, trafo_load: '', pv_per_feeder: 4, dv_dc: 1.5, dv_lv: 1.5, dv_mv: 1.0, len_from_layout: true, route_factor: 1.25,
    len: { dc: 60, lv_pv: 120, mv_pv: 800, lv_bess: 30, mv_bess: 400, lv_gen: 60, mv_gen: 250, load: 500 },
    cable: { dc: 'dc6', lv_pv: 'lv240al', mv_pv: 'mv240al', lv_bess: 'lv400al', mv_bess: 'mv240al', lv_gen: 'lv630cu', mv_gen: 'mv150al', load: 'mv400al' },
    runs: { dc: 1, lv_pv: 2, mv_pv: 1, lv_bess: 4, mv_bess: 1, lv_gen: 4, mv_gen: 1, load: 2 }, applied: null, ...E,
  },
  layout: {
    stations: [station('substation', 0, 0), station('pv', 700, 500), station('pv', -300, 300), station('bess', 0, -200), station('gen', -100, 50), station('load', 150, 60)],
    result: { tables: [table(680, 480), table(-320, 280), table(-310, 290)] },
  },
});
const pvr = () => ({ ac_per_kwp: Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin((h % 24 - 6) / 12 * Math.PI)) * 0.7), tcell: flat(40), poa: flat(500) });

test('the design takes DC and MV lengths from the layout and keeps the LV runs typed', () => {
  const P = designProject(), D = computeDesign(P, { PVR: pvr(), SIM: null }), by = (k) => D.circuits.find((c) => c.key === k);
  const L = plantLengths(P);
  for (const k of ['dc', 'mv_pv', 'mv_bess', 'mv_gen', 'load']) {
    assert.equal(by(k).fromLayout, true, k);
    assert.equal(by(k).L, L[k].len, k);
  }
  for (const k of ['lv_pv', 'lv_bess', 'lv_gen']) assert.equal(by(k).fromLayout, undefined, `${k} stays typed`);
  assert.equal(by('lv_pv').L, 120);
  const far = 1.25 * Math.hypot(700, 500), mean = 1.25 * (Math.hypot(700, 500) + Math.hypot(300, 300)) / 2;
  near(by('mv_pv').L, mean, 0.2);
  near(by('mv_pv').Lmax, far, 0.2);
  assert.ok(by('dc').Lmax > by('dc').L && by('dc').dvMax > by('dc').dv, 'the longest string drops more than the average one');
  assert.ok(by('mv_pv').dvMax > by('mv_pv').dv, 'the farther PV station drops more than the average one');
  assert.equal(by('mv_bess').dvMax, undefined, 'one station is its own longest run');
  const off = computeDesign(designProject({ len_from_layout: false }), { PVR: pvr(), SIM: null });
  assert.equal(off.circuits.find((c) => c.key === 'dc').L, 60);
  assert.equal(off.circuits.find((c) => c.key === 'dc').fromLayout, undefined);
});

test('auto-size meets the voltage drop on the longest string, not on the average one', () => {
  const P = designProject({ len_from_layout: true }), ctx = { PVR: pvr(), SIM: null };
  autoSize(P, ctx);
  const D = computeDesign(P, ctx), dc = D.circuits.find((c) => c.key === 'dc');
  assert.ok(dc.Lmax > dc.L);
  assert.ok((dc.dvMax ?? dc.dv) * 100 <= dc.lim, `longest string ${(dc.dvMax * 100).toFixed(2)} % against ${dc.lim} %`);
  assert.ok(!D.warn.some((w) => /longest run/.test(w)), D.warn.join(' | '));
});
