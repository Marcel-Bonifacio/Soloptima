// The Optimisation and Forecast & EMS pages (lib/plan-view.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNums, optSettings, suggestRanges, applySizes, localLabel, schedLead, schedAge, schedWarning, schedCsv, schedTiles, schedTable, schedLabels,
  sizingOverrides, projectKey, weekHours, forecastTiles } from '../src/lib/plan-view.js';

test('parseNums keeps the numbers that pass the check', () => {
  assert.deepEqual(parseNums('0.5, 1; 2  -1 x', (x) => x > 0), [0.5, 1, 2]);
  assert.deepEqual(parseNums('', () => true), []);
});

test('optSettings: C-rates default to 0.5, sensitivity values follow the variable', () => {
  assert.deepEqual(optSettings({ c_rates_text: '', sens_var: '' }).c_rates, [0.5]);
  assert.deepEqual(optSettings({ c_rates_text: '0.25 1', sens_var: '' }).sens_values, []);
  assert.deepEqual(optSettings({ c_rates_text: '', sens_var: 'discount_rate', sens_values_text: '-0.01, 0.05' }).sens_values, [-0.01, 0.05]);
  assert.deepEqual(optSettings({ c_rates_text: '', sens_var: 'pv_degradation', sens_values_text: '0, 0.01, -1' }).sens_values, [0, 0.01]);
  assert.deepEqual(optSettings({ c_rates_text: '', sens_var: 'fuel_price', sens_values_text: '0 1 2' }).sens_values, [1, 2]);
});

test('suggestRanges sets PV and battery ranges from the load', () => {
  const P = { load: { kw: new Array(8760).fill(100) }, optimizer: { max_pv_kwp: 0 } };
  const msg = suggestRanges(P, { specific_yield: 1000 });
  assert.equal(P.optimizer.pv_max, Math.round(1.2 * 876000 / 1000 / 100) * 100);
  assert.equal(P.optimizer.bess_max, Math.round(876000 / 365 * 0.5 / 100) * 100);
  assert.match(msg, /^Ranges: PV 0–/);
  P.optimizer.max_pv_kwp = 500; suggestRanges(P, null);
  assert.equal(P.optimizer.pv_max, 500);
  assert.equal(suggestRanges({ load: { kw: null }, optimizer: {} }, null), null);
});

test('applySizes rounds the sizes and keeps wind when the result has none', () => {
  const P = { pv: {}, bess: {}, wind: { units: 3 } };
  applySizes(P, { pv_kwp: 100.4, bess_kwh: 200.6, bess_kw: 50 });
  assert.deepEqual([P.pv.capacity_kwp, P.bess.energy_kwh, P.bess.power_kw, P.wind.units], [100, 201, 50, 3]);
  applySizes(P, { pv_kwp: 1, bess_kwh: 1, bess_kw: 1, wind_units: 2.4 });
  assert.equal(P.wind.units, 2);
});

test('sizing key ignores the sizes, the strategy and the name', () => {
  const mk = (kwp, strat) => ({ name: 'a' + kwp, pv: { capacity_kwp: kwp }, bess: { energy_kwh: kwp, power_kw: 1 }, wind: { units: 0 }, diesel: { strategy: strat, cc_setpoint: 1 } });
  assert.equal(projectKey(sizingOverrides(mk(1, 'x'))), projectKey(sizingOverrides(mk(2, 'y'))));
});

test('local time labels and the lead of the row stamps', () => {
  assert.equal(localLabel('2026-03-05T22:00', 3), '06 Mar 01:00');
  const S = { plan_start_utc: '2026-03-05T10:00', rows: [{ time_utc: '2026-03-05T11:00' }] };
  assert.equal(schedLead(S), -1);
  assert.equal(schedLead({ rows: [] }), 0);
  assert.equal(weekHours(51)[0], 51 * 168);
});

const S = { provider: 'met_norway', issued_utc: '2026-03-05T20:00:00Z', model_updated_utc: '2026-03-05T06:00:00Z', plan_start_utc: '2026-03-05T10:00', utc_offset: 8, soc_now: 0.5,
  rows: [{ time_utc: '2026-03-05T10:00', load_kw: 10, pv_kw: 5.55555, wind_kw: 1, bess_kw: -1, soc: 0.5, units: 1, gen_kw: 4, curtail_kw: 0, fuel_l: 2 }],
  totals: { fuel_l: 2, pv_used_kwh: 5, load_kwh: 10, wind_used_kwh: 1, gen_kwh: 4, curtail_kwh: 0 } };
test('schedule age, warning, tiles, table and CSV', () => {
  assert.equal(schedAge(S), 14);
  assert.match(schedWarning(S), /updated 14\.0 h before/);
  assert.equal(schedWarning({ ...S, model_updated_utc: '2026-03-05T19:00:00Z' }), '');
  const P = { wind: { units: 1 }, diesel: { units: 2 } };
  const t = schedTiles(S, P);
  assert.equal(t.length, 6); assert.equal(t[0][0], 'Planned fuel'); assert.equal(t.at(-1)[2], 'of 2');
  assert.equal(schedTiles(S, { wind: { units: 0 }, diesel: { units: 2 } }).length, 5);
  const tb = schedTable(S, P);
  assert.equal(tb.heads.length, tb.rows[0].length);
  assert.equal(schedLabels(S)[0], '05 Mar 18:00');
  const csv = schedCsv(S).split('\n');
  assert.match(csv[0], /^# provider met_norway/);
  assert.ok(csv[2].includes('5.556') && csv[2].endsWith('05 Mar 18:00'));
});

test('schedule with a grid: a tile, two columns and the CSV fields appear only then', () => {
  const P = { wind: { units: 0 }, diesel: { units: 2 } };
  const G = { ...S, rows: S.rows.map((r) => ({ ...r, grid_kw: 100, export_kw: 5 })), totals: { ...S.totals, grid_kwh: 2400, export_kwh: 120 } };
  assert.ok(schedTiles(G, P).some((t) => t[0] === 'Grid import'));
  const tb = schedTable(G, P);
  assert.equal(tb.heads.length, schedTable(S, P).heads.length + 2);
  assert.equal(tb.heads.length, tb.rows[0].length);
  const csv = schedCsv(G).split('\n');
  assert.ok(csv[1].endsWith(',grid_kw,export_kw') && csv[2].endsWith(',100,5'));
});

test('forecast tiles: EMS figures only for the predictive strategy', () => {
  const sim = { result: { forecast: { pv_nmae_h1: 0.1, pv_nmae_da: 0.2, pv_bias_da: 0, load_nmae_h1: 0.1, load_nmae_da: 0.2, load_bias_da: 0, plans: 5, net_error_kwh: 1, bess_compensation_kwh: 1 } } };
  const P = (strategy) => ({ diesel: { strategy }, ems: { pv_forecast: 'ensemble', load_forecast: 'profile', replan: 1, horizon: 24 } });
  assert.equal(forecastTiles(sim, P('load_following'))[4][1], 'n/a');
  assert.equal(forecastTiles(sim, P('predictive'))[4][1], '5');
});
