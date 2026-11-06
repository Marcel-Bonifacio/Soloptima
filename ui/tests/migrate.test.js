// The rules for a project file from someone else (lib/migrate-project.js): results are kept only with the engine's types, the
// layout geometry is bounded and finite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQc, cleanResourceYears, cleanLayout, migrateProject } from '../src/lib/migrate-project.js';
import { defaultProject } from '../src/lib/schema/index.js';

const qc = () => ({ flags: [], days: [], hours: [], set: [] });

test('qc: kept only with the four lists and a finite timing shift', () => {
  const ok = { qc: qc() };
  cleanQc(ok); assert.ok(ok.qc);
  for (const bad of [{ flags: [], days: [], hours: [] }, 'x', { ...qc(), days: 'no' }, { ...qc(), timing: { shift_h: 'a' } }, { ...qc(), timing: { shift_h: Infinity } }]) {
    const D = { qc: bad }; cleanQc(D); assert.equal(D.qc, null, JSON.stringify(bad));
  }
  const timing = { qc: { ...qc(), timing: { shift_h: 1.5 } } };
  cleanQc(timing); assert.ok(timing.qc);
  cleanQc(null); cleanQc({});   // no data, no qc: nothing to do
});

test('resource_years: the result needs years, range and stats with integer worst years; applied needs a finite factor', () => {
  const result = () => ({ years: [2020], range: { from: 2005, to: 2020 }, stats: { ghi: { worst_year: 2015 } } });
  const good = { result: result(), applied: { p90_factor: 0.93 } };
  cleanResourceYears(good); assert.ok(good.result); assert.ok(good.applied);
  for (const f of [(r) => { r.years = 'x'; }, (r) => { r.range = { from: 1.5, to: 2 }; }, (r) => { r.stats = { ghi: { worst_year: 'a' } }; }, (r) => { delete r.stats; }]) {
    const RY = { result: result() }; f(RY.result); cleanResourceYears(RY); assert.equal(RY.result, null);
  }
  const RY = { result: null, applied: { p90_factor: 'a' } };
  cleanResourceYears(RY); assert.equal(RY.applied, null);
  cleanResourceYears(undefined);
});

test('layout: tables must be four finite numbers, areas and counts must fit, the sizes stay in range', () => {
  const L = { polygons: [{ type: 'site', pts: [[0, 0], [0, 1], [1, 1]] }], aisle_every: 9999, aisle_width: 'x', max_table_shade: 2,
    result: { tables: [[0, 0, 1, 1], [0, 0, 'a']], table_area: [0], groups: [{ label: 3 }], dropped: 'n' } };
  cleanLayout(L);
  assert.equal(L.aisle_every, null);
  assert.equal(L.aisle_width, 4);
  assert.equal(L.max_table_shade, null);
  assert.deepEqual(L.result.tables, []);
  assert.equal('table_area' in L.result, false);
  assert.equal('groups' in L.result, false);
  assert.equal('dropped' in L.result, false);
  const none = { polygons: 'x', removed: 5 };
  cleanLayout(none); assert.deepEqual(none.polygons, []);
});

test('migrateProject: the default project passes through unchanged in its results', () => {
  const p = defaultProject();
  p.weather = { qc: { flags: 1 } };
  migrateProject(p, () => ({ tz: 'Asia/Jakarta', std: 7 }));
  assert.equal(p.weather.qc, null);
  assert.equal(p.layout.aisle_width >= 0.5, true);
});
