// The genset fleet's plain logic: further groups and their editor, labels, and the merit-order rating (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGroup, removeGroup, setCell, cellValue, curveWarnings, engineGroups, fleetUnits, fleetKw, fleetLabel, isMixed, unitCap, unitMin, groupTable, MAX_GROUPS }
  from '../src/lib/fleet-view.js';

const main = () => ({ units: 4, unit_kw: 500, min_load: 0.3, more_groups: [] });

test('groups: add, edit, remove, and the fleet they make', () => {
  const D = main();
  assert.ok(!isMixed(D));
  assert.equal(fleetLabel(D), '4 × 500 kW');
  assert.deepEqual(addGroup(D), { changed: true });
  assert.ok(setCell(D, 0, 'name', 'night <set>').changed);
  assert.equal(D.more_groups[0].name, 'night set');
  assert.ok(setCell(D, 0, 'units', '2').changed && setCell(D, 0, 'unit_kw', '200').changed && setCell(D, 0, 'min_load', '40').changed);
  assert.equal(D.more_groups[0].min_load, 0.4);
  assert.equal(cellValue(D.more_groups[0], 'min_load'), '40');
  assert.match(setCell(D, 0, 'unit_kw', '0').error, /rating/);
  assert.match(setCell(D, 0, 'min_load', '100').error, /minimum loading/);
  assert.equal(fleetUnits(D), 6);
  assert.equal(fleetKw(D), 2400);
  assert.equal(fleetLabel(D), '4 × 500 kW (main) + 2 × 200 kW (night set)');
  // costs: blank is the main group's
  assert.ok(setCell(D, 0, 'om_kwh', '0.02').changed);
  assert.ok(setCell(D, 0, 'om_kwh', '').changed);
  assert.equal(D.more_groups[0].om_kwh, null);
  assert.match(setCell(D, 0, 'capex_kw', '-1').error, /non-negative/);
  // fuel: one point is not a curve; two are, sorted, and go to the engine as a table
  assert.ok(setCell(D, 0, 'eff1', '3.6').changed);
  assert.equal(curveWarnings(D).length, 1);
  assert.deepEqual(engineGroups(D)[0].fuel_curve, undefined);
  assert.ok(setCell(D, 0, 'eff0.5', '3.2').changed);
  assert.deepEqual(D.more_groups[0].fuel_curve, [[0.5, 3.2], [1, 3.6]]);
  assert.equal(engineGroups(D)[0].fuel_model, 'table');
  assert.equal(curveWarnings(D).length, 0);
  assert.ok(setCell(D, 0, 'eff0.5', '').changed && setCell(D, 0, 'eff1', '').changed);
  assert.equal(D.more_groups[0].fuel_curve, null);
  for (let i = 1; i < MAX_GROUPS; i++) addGroup(D);
  assert.match(addGroup(D).error, /at most/);
  assert.ok(removeGroup(D, 0).changed);
  assert.equal(D.more_groups.length, MAX_GROUPS - 1);
});

test('rating and least output of u units follow the merit order of the result', () => {
  const D = main(), R = { fleet: [{ index: 1, units: 2, unit_kw: 200, min_load: 0.4 }, { index: 0, units: 4, unit_kw: 500, min_load: 0.3 }] };
  assert.equal(unitCap(null, D, 3), 1500);
  assert.equal(unitCap(R, D, 3), 900);
  assert.equal(unitMin(R, D, 3), 160 + 150);
  assert.equal(unitCap(R, D, 6), 2400);
});

test('genset group table: only for a mixed fleet, one row per group', () => {
  const D = { ...main(), more_groups: [{ name: 'small', units: 2, unit_kw: 200 }] };
  const y = { groups: [{ index: 1, unit_hours: 100, gen_kwh: 12000, fuel_l: 3600, starts: 5 }, { index: 0, unit_hours: 50, gen_kwh: 20000, fuel_l: 5000, starts: 2 }] };
  const S = { result: { fleet: [{ index: 1, units: 2, unit_kw: 200, min_load: 0.4 }, { index: 0, units: 4, unit_kw: 500, min_load: 0.3 }], years: [y] } };
  const t = groupTable(S, D);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][0], 'small');
  assert.equal(t.rows[1][0], 'Main group');
  assert.equal(t.rows[0][4], '60.0 %');
  assert.equal(groupTable({ result: { years: [{}] } }, main()), null);
});

test('unused new inputs stay out of the engine project, so old results keep their fingerprints', async () => {
  const { leanDiesel, leanEms } = await import('../src/lib/ws/lean.js');
  assert.deepEqual(leanDiesel({ units: 2, more_groups: [] }), { units: 2 });
  assert.deepEqual(leanDiesel({ units: 2 }), { units: 2 });
  assert.equal(leanDiesel({ units: 2, more_groups: [{ units: 1, unit_kw: 100, fuel_curve: null }] }).more_groups.length, 1);
  assert.deepEqual(leanEms({ horizon: 24, reserve_energy: false }), { horizon: 24 });
  assert.deepEqual(leanEms({ horizon: 24, reserve_energy: true }), { horizon: 24, reserve_energy: true });
});
