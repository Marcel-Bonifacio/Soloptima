// The plant's stations and the cable lengths measured from them: checks of the stations in a project file, the lengths of the DC
// string cables and the MV feeders, and the design that uses them (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStations, STATION_KINDS, MAX_STATIONS, stationMode, stationHint } from '../src/lib/layout/stations.js';
import { plantLengths, routeFactor, lengthNotes } from '../src/lib/equip/siteplan.js';
import { snapshotOf, parseSnapshot } from '../src/lib/layout/history.js';
import { projector } from '../src/lib/layout/geometry.js';
import { migrateProject } from '../src/lib/migrate-project.js';

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
  assert.equal(cleanStations(Array.from({ length: MAX_STATIONS + 50 }, () => ({ kind: 'pv', latlng: [1, 1] }))).length, MAX_STATIONS);
  assert.deepEqual(STATION_KINDS.map(([k]) => k), ['pv', 'inv', 'bess', 'gen', 'substation', 'load']);
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
  assert.deepEqual(lengthNotes(plan([station('pv', 100, 0)], [])).map((n) => n.split(' ')[1]), ['layout', 'the'], 'no tables, and no substation for the feeders');
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
