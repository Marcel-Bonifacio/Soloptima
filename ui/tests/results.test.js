// The results screens' plain modules: tiles, tables and chart definitions from a simulation response (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delta, headlineTiles, indicatorTiles, compareTable, mixChart, monthlyChart, dispatchChart, cashChart, yearHeads, yearCells, weekStart, reliabilityTiles } from '../src/lib/sim-view.js';
import { warnings, rankedTable, archTable, heatChart, paretoChart, mapTable, mapChart, optTiles, runsTable, lpspTable } from '../src/lib/opt-view.js';
import { finTiles, solvedNote, finTable } from '../src/lib/fin-view.js';
import { monthlySum, dateOfHour, HOURS } from '../src/lib/series.js';

const col = new Proxy({}, { get: () => '#123456' });
const hours = (k) => new Array(HOURS).fill(k);
const year = (n, extra = {}) => ({ year: n, load: 1000, aux: 0, pv_to_load: 300, pv_to_bess: 100, pv_curtailed: 50, pv_avail: 450, bess_dis: 80, bess_ch: 100, gen_kwh: 600, gen_to_load: 520, gen_to_bess: 10,
  gen_dump: 5, wind_avail: 0, wind_used: 0, wind_curtailed: 0, unmet: 0, fuel_l: 160, re_fraction: 0.4, lol_h: 0, lol_events: 0, lol_max_h: 0, reserve_short_h: 0, reserve_short_max_kw: 0,
  max_units: 2, fleet_full_h: 0, minload_h: 3, minload_run_max_h: 1, unit_hours: 800, starts: 10, bess_efc: 200, bess_soh: 0.9, bess_replaced: false, c_total: 5, c_fuel: 3, c_om: 1, c_replace: 0,
  c_salvage: 0, co2_t: 4, ...extra });
const hourly = {};
for (const k of ['load', 'pv_to_load', 'pv_to_bess', 'pv_curtailed', 'pv_avail', 'bess_dis', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'unmet', 'fuel_l', 'soc', 'gen_units', 'wind_avail', 'wind_to_load', 'wind_to_bess', 'wind_curtailed']) hourly[k] = hours(1);
const econ = { lcoe: 0.3, npc: 1e6, tac: 9e4, crf: 0.1, coe: 0.31, capex_pv: 1, capex_bess: 2, capex_wind: 0, capex_other: 3, capex_total: 6 };
const sim = {
  all_years: true,
  result: { re_fraction: 0.4, curtail_fraction: 0.05, unmet_fraction: 0, avg_gen_load: 0.6, bess_replacements: 0, econ, size: { wind_units: 0 }, metrics: { lpsp: 0, rep: 100 }, years: [year(1), year(2)], hourly },
  baseline: { fuel_l_y1: 400, avg_gen_load: 0.7, econ: { ...econ, npc: 2e6 }, years: [year(1, { fuel_l: 400, c_total: 9 })] },
  comparison: { fuel_saved_l_y1: 240, lcoe_base: 0.4, npv_savings: 1e6, irr: 0.12, payback_years: 6, co2_saved_t_y1: 100 },
};
const P = { diesel: { units: 3 }, econ: { currency: 'USD' } };

test('change against the previous run', () => {
  assert.equal(delta(5, null, String, 1), '');
  assert.equal(delta(5, 5, String, 1), '= same as last run');
  assert.equal(delta(6, 5, (x) => x.toFixed(1), 1), '▲ +1.0 vs last run');
  assert.equal(delta(6, 5, (x) => x.toFixed(1), -1), '▼ +1.0 vs last run');
});

test('tiles: the headline tiles take the change from the previous run and show a battery value only when it exists', () => {
  const prev = { result: { re_fraction: 0.3, econ: { lcoe: 0.35 } }, comparison: sim.comparison };
  const t = headlineTiles(sim, prev, 'USD', null);
  assert.equal(t[0][0], 'Renewable fraction');
  assert.match(t[0][4], /^▲ \+10\.0 pp/);
  assert.ok(!t.some((r) => r[0] === 'Battery adds'));
  assert.equal(indicatorTiles(sim, P, 'USD').length, 14);
});

test('comparison table: three columns without PV only, four with it', () => {
  assert.deepEqual(compareTable(sim, 'USD').heads, ['', 'Diesel only', 'Hybrid', 'Change']);
  const withPv = compareTable({ ...sim, pv_only: { ...sim.result, years: [year(1, { fuel_l: 300 })] } }, 'USD');
  assert.equal(withPv.heads.length, 5);
  assert.equal(withPv.rows[0].cells[3], 160 - 300);
});

test('chart definitions: series that exist only with wind or auxiliaries appear only then', () => {
  assert.equal(mixChart(sim, col).traces[0].y.length, 5);
  assert.equal(monthlyChart(sim, col).traces.length, 5);
  const w = { ...sim, result: { ...sim.result, years: [year(1, { wind_avail: 5, aux: 20 })] } };
  assert.equal(mixChart(w, col).traces[0].y.length, 7);
  assert.equal(cashChart(sim, 'USD', col).traces.length, 6);
  const d = dispatchChart(hourly, weekStart(51), 168, false, col);
  assert.equal(d.layout.xaxis.range[1], weekStart(51) + 167);
});

test('year table: a cell for every head', () => {
  assert.equal(yearCells(year(1)).length, yearHeads('USD').length);
});

test('calendar helpers', () => {
  assert.equal(monthlySum(hours(1)).reduce((a, b) => a + b), HOURS);
  assert.equal(monthlySum(hours(1))[1], 28 * 24);
  assert.equal(dateOfHour(0), '1 Jan');
  assert.equal(dateOfHour(31 * 24), '1 Feb');
});

test('optimisation: warnings, ranked rows and the Pareto line', () => {
  const O = { best: null, at_boundary: ['pv_max', 'unknown'], ranked: [{ pv_kwp: 1, bess_kwh: 1, bess_kw: 1, wind_units: 0, capex: 1, npc: 1, lcoe: 1, re: 0.5, fuel: 1000, curtail: 0, irr: null, payback: null }],
    grid: [], evaluated: [{ feasible: true, re: 0.5, lcoe: 0.3, pv_kwp: 1, bess_kwh: 1 }], pareto: [{ re: 0.5, lcoe: 0.3, pv_kwp: 1, bess_kwh: 1 }, { re: 0.1, lcoe: 0.2, pv_kwp: 1, bess_kwh: 1 }], baseline: { econ: { lcoe: 0.4 } } };
  assert.equal(warnings(O).length, 2);
  assert.equal(rankedTable(O, 'USD').rows[0].cells[0], 1);
  assert.deepEqual(paretoChart(O, 'USD', col).traces[1].x, [10, 50]);
});

test('optimisation with genset sizing: the count column, the system types and the map at the optimum count', () => {
  const r = (pv, gen, npc, feasible = true) => ({ pv_kwp: pv, bess_kwh: 10, bess_kw: 5, wind_units: 0, gen_units: gen, capex: 1, npc, lcoe: 0.2, re: 0.5, fuel: 2000, curtail: 0, irr: null, payback: null,
    feasible, crate_idx: 0, i: pv, j: 0 });
  const O = { best: r(1, 0, 5), at_boundary: ['gen_max'], ranked: [r(1, 0, 5), r(1, 2, 6)], settings: { algorithm_id: 'grid', gen_units_max: 2 }, pv_axis: [0, 1], bess_axis: [10],
    grid: [r(0, 0, 9, false), r(1, 0, 5), r(0, 2, 7), r(1, 2, 6)],
    architectures: [{ label: 'PV + battery', pv: true, bess: true, wind: false, gensets: false, n_evaluated: 2, n_feasible: 1, best: r(1, 0, 5) },
      { label: 'battery', pv: false, bess: true, wind: false, gensets: false, n_evaluated: 1, n_feasible: 0, best: null }] };
  assert.match(warnings(O)[0], /Genset units max/);
  const t = rankedTable(O, 'USD');
  assert.equal(t.heads[4], 'Gensets');
  assert.deepEqual(t.rows.map((x) => x.cells[4]), [0, 2]);
  const a = archTable(O, 'USD');
  assert.equal(a.heads.length, 9, 'no wind column without wind');
  assert.deepEqual([a.rows[0].cls, a.rows[0].cells[0], a.rows[0].cells[3], a.rows[1].cells[1], a.rows[1].best], ['best', 'PV + battery', 0, 'no feasible design', null]);
  assert.equal(archTable({ ...O, architectures: undefined }, 'USD'), null);
  // the heat map shows the plane at the optimum's count: one cell per point
  const z = heatChart(O, 'npc', 0, 'USD', col).traces[0].z;
  assert.deepEqual(z, [[null, 5 * 1e-6]]);
});

test('two-way map: the winner of each cell as a table and a heat map; the autonomy tile', () => {
  const b = (npc) => ({ pv_kwp: 1, bess_kwh: 1, bess_kw: 1, npc });
  const O = { map: { x: 'fuel_price', y: 'irradiance_scale', x_values: [0.8, 1.2], y_values: [0.9, 1], mode: 'fixed',
    cells: [[{ type: 'diesel', best: b(5e6) }, { type: 'PV + diesel', best: b(4e6) }], [{ type: null, best: null }, null]] } };
  const t = mapTable(O, 'USD');
  assert.equal(t.heads.length, 3);
  assert.match(t.heads[0], /Irradiance multiplier .* Diesel price/);
  assert.deepEqual(t.rows[1].slice(1), ['no feasible design', 'not run']);
  assert.match(t.rows[0][2], /^PV \+ diesel · /);
  assert.deepEqual(t.types, ['diesel', 'PV + diesel']);
  assert.equal(t.fixed, true);
  assert.deepEqual(mapChart(O, 'USD', col).traces[0].z, [[5, 4], [null, null]]);
  assert.equal(mapTable({}, 'USD'), null);
  const P = { econ: { currency: 'USD' }, wind: { rated_kw: 1 }, diesel: { unit_kw: 1 } };
  const best = { pv_kwp: 1, bess_kwh: 1, bess_kw: 1, wind_units: 0, npc: 1, lcoe: 1, re: 0.5, fuel: 1, irr: null, payback: null, capex: 1, curtail: 0 };
  const opt = { best, settings: { algorithm: 'grid' }, baseline: { econ: { npc: 2 }, fuel_l_y1: 2 } };
  assert.equal(optTiles(opt, P).some((x) => x[0] === 'Autonomy'), false);
  assert.equal(optTiles({ ...opt, best: { ...best, autonomy_d: 1.5 }, settings: { min_autonomy_days: 1 } }, P).find((x) => x[0] === 'Autonomy')[1], '1.50 days');
});

test('reliability in time: the low-PV spell and the unserved run', () => {
  assert.deepEqual(reliabilityTiles(undefined), []);
  const t = reliabilityTiles({ low_pv_frac: 0.5, low_pv_days: 12, low_pv_run_d: 4, low_pv_run_start: 31, unmet_run_h: 3, unmet_run_start: 30 });
  assert.equal(t[0][1], '4 days');
  assert.match(t[0][2], /^from 1 Feb · 12 days below 50 %/);
  assert.equal(t[1][1], '3 h');
  assert.match(t[1][2], /from 2 Jan 06:00/);
  assert.equal(t[1][3], 'bad');
  assert.equal(reliabilityTiles({ low_pv_frac: 0.5, low_pv_days: null, low_pv_run_d: null, low_pv_run_start: null, unmet_run_h: 0, unmet_run_start: null })[0][1], '–');
});

test('finance: tiles, the solved-tariff note and the table with group rows', () => {
  const R = { model: 'ppa', metrics: { equity_irr: 0.1, term: 20, tariff_scale: 1.2, tariff_y1: 0.2 }, years: [{ year: 0, equity_cf: -5 }, { year: 1, equity_cf: 2, revenue: 3 }], solved: { ok: true } };
  const Pr = { econ: { currency: 'USD', discount_rate: 0.08 }, finance: { equity_discount: 0.1, target_irr: 0.12, solve_for: 'equity' } };
  assert.equal(finTiles(R, Pr).length, 11);
  assert.equal(solvedNote(R, Pr).b, '1.2000');
  assert.equal(solvedNote({ ...R, solved: { ok: false, reason: '<b>x</b>' } }, Pr).text, '<b>x</b>');
  const t = finTable(R, Pr, () => [['g', 'Energy'], ['revenue', 'Revenue']]);
  assert.equal(t.rows[0].group, 'Energy');
  assert.deepEqual(t.rows[1].cells, ['Revenue', '', '3']);
});

test('grid connection: rows, columns and series appear only with one', () => {
  const g = { grid_import: 200, grid_export: 30, pv_to_grid: 30, wind_to_grid: 0, c_grid: 12 };
  const S = { ...sim, result: { ...sim.result, has_grid: true, years: [year(1, g)], hourly: { ...hourly, grid_import: hours(2), grid_export: hours(1) } },
    baseline: { ...sim.baseline, years: [year(1, { ...g, fuel_l: 400, grid_export: 0 })] } };
  const t = compareTable(S, 'USD');
  assert.equal(t.heads[1], 'Grid + diesel');
  assert.ok(t.rows.some((r) => r.label === 'Grid import (MWh/yr)' && r.cells[1] === 0.2));
  assert.ok(!compareTable(sim, 'USD').rows.some((r) => r.label.startsWith('Grid')));
  assert.equal(mixChart(S, col).traces[0].y.length, 7);
  assert.equal(monthlyChart(S, col).traces.length, 6);
  assert.ok(dispatchChart(S.result.hourly, 0, 168, false, col).traces.some((x) => x.name === 'Exported'));
  assert.ok(!dispatchChart(hourly, 0, 168, false, col).traces.some((x) => x.name === 'Grid → load'));
  assert.equal(yearCells(year(1, g), true).length, yearHeads('USD', true).length);
  assert.equal(yearHeads('USD', true).length, yearHeads('USD').length + 2);
});

test('optimisation with repeated runs, a genset rating and the MOPSO front by LPSP', () => {
  const d = (pv, unmet, npc) => ({ pv_kwp: pv, bess_kwh: 10, bess_kw: 5, wind_units: 0, gen_units: 1, gen_kw: 300, gen_rating: 2, capex: 1, npc, lcoe: 0.2, re: 0.5, fuel: 2000, co2_t: 5,
    curtail: 0, irr: null, payback: null, unmet, feasible: true });
  const O = { best: d(1, 0, 9), ranked: [d(1, 0, 9)], grid: [], evaluated: [d(1, 0, 9), d(2, 0.04, 7)], pareto: [d(1, 0, 9), d(2, 0.04, 7)],
    baseline: { econ: { npc: 20, lcoe: 0.4 }, fuel_l_y1: 5000, unmet_fraction: 0, metrics: { co2_t: 13 } },
    settings: { algorithm_id: 'mopso', algorithm: 'MOPSO', objective: 'npc', mo_second: 'lpsp', gen_ratings: [{ kw: 60 }, { kw: 120 }, { kw: 300, name: 'Mid' }] },
    runs: { n: 2, metric: 'hypervolume', higher_is_better: true, best: 0.8, mean: 0.7, worst: 0.6, std: 0.14, n_with_value: 2, best_run: 1,
      rows: [{ run: 1, seed: 42, evaluations: 36, simulations: 30, value: 0.8, front: 2, spacing: 0.1 }, { run: 2, seed: 7, evaluations: 36, simulations: 20, value: 0.6, front: 3, spacing: null }] },
    lpsp_table: [{ target: 0, best: d(1, 0, 9) }, { target: 0.01, best: d(1, 0, 9) }, { target: 0.02, best: d(1, 0, 9) }, { target: 0.05, best: d(2, 0.04, 7) }, { target: 0.1, best: null }],
    pareto_quality: { points: 2, spacing: 0, hypervolume: 0.8, ref_cost: 9.2, ref_second: 0.044 } };
  const tiles = optTiles(O, { econ: { currency: 'USD' }, diesel: { unit_kw: 100 }, wind: { rated_kw: 1 } });
  assert.ok(tiles.some((t) => t[0] === 'Genset unit rating' && t[1] === '300 kW' && t[2] === 'Mid'));
  assert.ok(tiles.some((t) => t[0] === 'Gensets' && /300 kW/.test(t[2])));
  assert.equal(rankedTable(O, 'USD').heads[5], 'Genset kW');
  const R = runsTable(O, 'USD');
  assert.deepEqual([R.name, R.better, R.rows[0].cls, R.rows[1].cells[6]], ['Hypervolume', 'higher', 'best', '–']);
  const L = lpspTable(O, 'USD');
  assert.deepEqual(L.rows.map((r) => r.cells[0]), ['0 %', '1 %', '2 %', '5 %', '10 %']);
  assert.equal(L.rows[4].best, null);
  assert.match(L.quality, /2 designs on the front/);
  // the cost chart plots the front against the unmet load
  assert.deepEqual(paretoChart(O, 'USD', col).traces[1].x, [0, 4]);
  assert.equal(runsTable({ ...O, runs: undefined }, 'USD'), null);
  assert.equal(lpspTable({ ...O, lpsp_table: undefined }, 'USD'), null);
});
