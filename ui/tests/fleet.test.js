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

test('genset wear and the further pollutants reach the engine only when set; a group takes its own wear', async () => {
  const { leanEcon } = await import('../src/lib/ws/lean.js');
  const e = { fuel_price: 1, diesel_overhaul_h: 0, diesel_overhaul_kw: 0, diesel_life_h: 0, diesel_replace_kw: null, pm25_g_per_l: 0, co_g_per_l: 0,
    nox_price_kg: 0, sox_price_kg: 0, pm25_price_kg: 0, co_price_kg: 0, pv_co2_kg_per_kwh: 0 };
  assert.deepEqual(leanEcon(e), { fuel_price: 1 });
  assert.deepEqual(leanEcon({ fuel_price: 1 }), { fuel_price: 1 });
  assert.deepEqual(leanEcon({ ...e, diesel_life_h: 20000, diesel_replace_kw: 0, pm25_price_kg: 40 }), { fuel_price: 1, diesel_life_h: 20000, diesel_replace_kw: 0, pm25_price_kg: 40 });
  const D = main();
  addGroup(D);
  assert.deepEqual(Object.keys(engineGroups(D)[0]).filter((k) => /overhaul|life|replace/.test(k)), [], 'blank wear stays out');
  assert.ok(setCell(D, 0, 'life_h', '30000').changed && setCell(D, 0, 'replace_kw', '').changed);
  assert.match(setCell(D, 0, 'overhaul_h', '50').error, /100 to 1,000,000/);
  assert.match(setCell(D, 0, 'replace_kw', '-1').error, /group's capex/);
  assert.equal(engineGroups(D)[0].life_h, 30000);
  assert.equal(cellValue(D.more_groups[0], 'overhaul_h'), '');
});

test('resource scales, the low-PV share and the grid extension reach the engine only when used', async () => {
  const { leanKeys, leanSim, leanGridExt } = await import('../src/lib/ws/lean.js');
  assert.deepEqual(leanKeys({ tilt: 10, irradiance_scale: 1 }, { irradiance_scale: 1 }), { tilt: 10 });
  assert.deepEqual(leanKeys({ tilt: 10, irradiance_scale: 0.9 }, { irradiance_scale: 1 }), { tilt: 10, irradiance_scale: 0.9 });
  assert.deepEqual(leanKeys({ units: 0 }, { speed_scale: 1 }), { units: 0 });
  assert.deepEqual(leanSim({ all_years: true, step_min: 60, subhourly: 'hold', low_pv_frac: 0.5 }), { all_years: true });
  assert.deepEqual(leanSim({ all_years: true, low_pv_frac: 0.4 }), { all_years: true, low_pv_frac: 0.4 });
  assert.equal(leanGridExt({ cost_per_km: 0, price: 0.1 }), undefined);
  assert.equal(leanGridExt({ cost_per_km: 20000 }).cost_per_km, 20000);
});

test('grid charging and the frequency reserve reach the engine only when used', async () => {
  const { leanGrid } = await import('../src/lib/ws/lean.js');
  const g = { enabled: true, import_kw: 100, charge_bess: false, reserve_kw: 0, reserve_min: 15, reserve_price: 0 };
  assert.deepEqual(leanGrid(g), { enabled: true, import_kw: 100 });
  assert.deepEqual(leanGrid({ enabled: true, import_kw: 100 }), { enabled: true, import_kw: 100 });
  assert.deepEqual(leanGrid({ ...g, charge_bess: true }), { enabled: true, import_kw: 100, charge_bess: true });
  assert.deepEqual(leanGrid({ ...g, reserve_kw: 50, reserve_min: 30 }), { enabled: true, import_kw: 100, reserve_kw: 50, reserve_min: 30 });
});

test('time step, ramps and outages reach the engine only when used; a 15 minute load at a short step', async () => {
  const { leanDiesel, leanSim, leanLoad } = await import('../src/lib/ws/lean.js');
  const d = { units: 2, ramp_pct_min: 0, start_min: 0, outage_rate: 0, repair_h: 24, outage_seed: 1, n1_check: false, more_groups: [] };
  assert.deepEqual(leanDiesel(d), { units: 2 });
  assert.deepEqual(leanDiesel({ ...d, outage_rate: 2, n1_check: true }), { units: 2, outage_rate: 2, repair_h: 24, outage_seed: 1, n1_check: true });
  assert.deepEqual(leanSim({ all_years: true, step_min: 60, subhourly: 'hold' }), { all_years: true });
  assert.deepEqual(leanSim({ all_years: true, step_min: '15', subhourly: 'interpolate' }), { all_years: true, step_min: 15, subhourly: 'interpolate' });
  // the PV and wind ramp limit only above 0 and in steps under an hour
  assert.deepEqual(leanSim({ all_years: true, step_min: 15, subhourly: 'hold', re_ramp_pct_min: 0 }), { all_years: true, step_min: 15, subhourly: 'hold' });
  assert.deepEqual(leanSim({ all_years: true, step_min: 60, subhourly: 'hold', re_ramp_pct_min: 2 }), { all_years: true });
  assert.deepEqual(leanSim({ all_years: true, step_min: 30, re_ramp_pct_min: '2' }), { all_years: true, step_min: 30, subhourly: 'hold', re_ramp_pct_min: 2 });
  const L = { kw: [1, 2], kw_sub: [1, 3, 5, 7, 2, 2, 2, 2], sub_min: 15, growth: 0 };
  assert.deepEqual(leanLoad(L, { step_min: 60 }).kw, [1, 2]);
  assert.deepEqual(leanLoad(L, { step_min: 15 }).kw, L.kw_sub);
  assert.deepEqual(leanLoad(L, { step_min: 30 }).kw, [2, 6, 2, 2]);
  assert.deepEqual(leanLoad({ ...L, sub_min: 30 }, { step_min: 15 }).kw, [1, 2], 'a 30 minute load is not split into quarters');
});

test('step CSV: one row per step with its time', async () => {
  const { stepCsv } = await import('../src/lib/sim-extra.js');
  const S = { load: [10, 11, 12, 13, 14, 15, 16, 17], soc: new Array(8).fill(0.5) };
  const lines = stepCsv(S, 15, (h) => 'd' + h).split('\n');
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^step,date,time,load,/);
  assert.equal(lines[6].split(',').slice(0, 4).join(','), '5,d1,01:15,15');
});

test('random outages of inverter blocks and PCS units: their inputs go to the engine only while on, with the seed', async () => {
  const { leanOutages, leanDiesel } = await import('../src/lib/ws/lean.js');
  const pv = { availability: 0.99, inverter_outage_rate: 0, inverter_unit_kw: 250, inverter_repair_h: 72 };
  assert.deepEqual(leanOutages(pv, 'pv'), { availability: 0.99 }, 'off: the project keeps the engine inputs it had');
  assert.equal(leanOutages({ ...pv, inverter_outage_rate: 0.5 }, 'pv').inverter_unit_kw, 250);
  assert.deepEqual(leanOutages({ rte: 0.9, pcs_outage_rate: 0, pcs_unit_kw: 500, pcs_repair_h: 72 }, 'bess'), { rte: 0.9 });
  const d = { units: 4, outage_rate: 0, repair_h: 24, outage_seed: 9 };
  assert.equal(leanDiesel(d).outage_seed, undefined, 'no outages drawn: no seed');
  assert.equal(leanDiesel(d, true).outage_seed, 9, 'PV or PCS outages drawn: the seed goes along');
  assert.equal(leanDiesel(d, true).repair_h, undefined, 'the genset repair time only with genset outages');
});

test('a cycle-life curve, minimum up and down times and start costs in the plan reach the engine only when used', async () => {
  const { leanCurve, leanDiesel, leanEms } = await import('../src/lib/ws/lean.js');
  assert.deepEqual(leanCurve({ rte: 0.9, cycle_curve: null }), { rte: 0.9 });
  assert.deepEqual(leanCurve({ rte: 0.9, cycle_curve: [] }), { rte: 0.9 });
  assert.deepEqual(leanCurve({ rte: 0.9 }), { rte: 0.9 });
  const c = [[0.1, 60000], [1, 4000]];
  assert.deepEqual(leanCurve({ rte: 0.9, cycle_curve: c }), { rte: 0.9, cycle_curve: c });
  assert.deepEqual(leanDiesel({ units: 2, min_up_h: 0, min_down_h: 0 }), { units: 2 });
  assert.deepEqual(leanDiesel({ units: 2, min_up_h: 2, min_down_h: 0 }), { units: 2, min_up_h: 2 });
  assert.deepEqual(leanEms({ horizon: 24, reserve_energy: false, plan_starts: false }), { horizon: 24 });
  assert.deepEqual(leanEms({ horizon: 24, reserve_energy: false, plan_starts: true }), { horizon: 24, plan_starts: true });
  assert.deepEqual(leanEms({ horizon: 24 }), { horizon: 24 });
});

// Keys of the leaned blocks of the default project with some inputs on, taken from lean.js before its helpers. A new input of
// these blocks changes them: leave it out at its default (lean.js) so saved results keep their fingerprints.
test('the engine project keeps its fingerprint: leanProject output is unchanged', async () => {
  const { leanProject } = await import('../src/lib/ws/lean.js');
  const { defaultProject } = await import('../src/lib/schema/project.js');
  const { projectKey } = await import('../src/lib/ws/diff.js');
  const blocks = () => { const { pv, bess, wind, diesel, ems, econ, sim, grid } = defaultProject(); return { pv, bess, wind, diesel, ems, econ, sim, grid }; };
  const cases = [
    ['28e41944:2942', (p) => { delete p.grid; }],
    ['6a101143:3230', (p) => { p.grid.enabled = true; p.grid.reserve_kw = 50; p.grid.charge_bess = true; }],
    ['14a1bd16:3058', (p) => { delete p.grid; p.pv.inverter_outage_rate = 2; p.diesel.n1_check = true; p.diesel.min_up_h = 2; }],
    ['ba2c7fa7:3228', (p) => {
      delete p.grid;
      p.diesel.more_groups = [{ name: 'b', units: 2, unit_kw: 800, min_load: 0.3, fuel_curve: [[0.5, 3.5], [1, 3.9]], capex_kw: null, om_kwh: null, om_unit_hour: null, life_h: 60000, replace_kw: null }];
      p.econ.diesel_life_h = 60000; p.econ.diesel_replace_kw = 0; p.econ.pm25_price_kg = 40; p.bess.cycle_curve = [[0.5, 9000], [1, 5000]];
    }],
    ['d4046ef2:3107', (p) => {
      delete p.grid; p.pv.irradiance_scale = 0.9; p.pv.mppt_local = true; p.wind.speed_scale = 1.1; p.ems.reserve_energy = true; p.ems.voll_nc = 2;
      p.sim.step_min = 15; p.sim.low_pv_frac = 0.4; p.sim.re_ramp_pct_min = 10;
    }],
  ];
  for (const [key, edit] of cases) { const p = blocks(); edit(p); assert.equal(projectKey(leanProject(p)), key); }
});
