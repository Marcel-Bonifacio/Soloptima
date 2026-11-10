// The results screens' plain modules: tiles, tables and chart definitions from a simulation response (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delta, headlineTiles, indicatorTiles, compareTable, mixChart, monthlyChart, dispatchChart, cashChart, yearHeads, yearCells, weekStart } from '../src/lib/sim-view.js';
import { warnings, rankedTable, paretoChart } from '../src/lib/opt-view.js';
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
