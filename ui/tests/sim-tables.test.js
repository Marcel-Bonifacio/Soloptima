import test from 'node:test';
import assert from 'node:assert/strict';
import { gensetMonthly, socHistogram, reFractions, reTiles, checkText, checksOf, runFleetKw, DIESEL_KWH_PER_L } from '../src/lib/sim-tables.js';

const N = 8760;
const arr = (f) => Array.from({ length: N }, (_, i) => f(i));
// two 500 kW units: one from 06:00 to 18:00, two from 18:00 to 22:00, none at night; the battery cycles through the day
function result() {
  const units = arr((i) => { const h = i % 24; return h >= 18 && h < 22 ? 2 : h >= 6 && h < 18 ? 1 : 0; });
  const H = { load: arr(() => 600), gen_units: units, gen_to_load: units.map((u) => u * 300), gen_to_bess: units.map((u) => u * 20), gen_dump: arr(() => 0),
    fuel_l: units.map((u) => u * 320 * 0.27), pv_to_load: arr((i) => (i % 24 === 12 ? 450 : i % 24 === 10 ? 300 : 0)), wind_to_load: arr(() => 0),
    soc: arr((i) => (i % 24) / 24) };
  let starts = 0, prev = 0;
  for (const u of units) { if (u > prev) starts += u - prev; prev = u; }
  const sum = (a) => a.reduce((x, v) => x + v, 0);
  return { hourly: H, size: { pv_kwp: 1000, wind_units: 0, bess_kwh: 2000, bess_kw: 500 }, re_fraction: 0.4,
    years: [{ unit_hours: sum(units), starts, gen_kwh: sum(units) * 320, fuel_l: sum(H.fuel_l) }] };
}
const P = { wind: { rated_kw: 1500 }, diesel: { units: 2, unit_kw: 500, more_groups: [] } };

test('the genset months add up to the year and to the engine totals', () => {
  const R = result(), G = gensetMonthly(R, P.diesel), y = R.years[0], Y = G[12];
  assert.equal(G.length, 13);
  for (const k of ['hours', 'starts', 'kwh', 'fuel']) assert.ok(Math.abs(G.slice(0, 12).reduce((a, x) => a + x[k], 0) - Y[k]) < 1e-6, k);
  assert.ok(Math.abs(Y.hours - y.unit_hours) < 1e-6);
  assert.equal(Y.starts, y.starts);
  assert.ok(Math.abs(Y.kwh - y.gen_kwh) < 1e-6);
  assert.ok(Math.abs(Y.fuel - y.fuel_l) < 1e-6);
  assert.ok(Math.abs(Y.cf - y.gen_kwh / (1000 * N)) < 1e-12);
  assert.ok(Math.abs(Y.sfc - 0.27) < 1e-12);
  assert.ok(Math.abs(Y.eff - 1 / (0.27 * DIESEL_KWH_PER_L)) < 1e-12);
  // January: 31 days, 20 unit-hours and 3 starts a day
  assert.equal(G[0].hours, 31 * 20);
  assert.equal(G[0].starts, 31 * 2);
});

test('starts come from the steps of a run under an hour', () => {
  const R = result();
  // 15 minute steps: one unit started and stopped twice within every hour 0..3 of the year's first day only
  R.steps = { gen_units: Array.from({ length: N * 4 }, (_, i) => (i < 16 && i % 2 === 0 ? 1 : 0)) };
  assert.equal(gensetMonthly(R, P.diesel)[0].starts, 8);
  assert.equal(gensetMonthly({ ...R, years: [{ gen_kwh: 0 }] }, P.diesel), null);
});

test('the state of charge histogram sums to the hours of each season and the year', () => {
  const S = socHistogram(result()), sum = (a) => a.reduce((x, v) => x + v, 0);
  assert.equal(sum(S.year), N);
  assert.deepEqual(S.seasons.map(sum), [90 * 24, 92 * 24, 92 * 24, 91 * 24]);
  // hour h of the day sits in band floor(10 h / 24)
  assert.equal(S.year[0], 3 * 365);
  assert.equal(S.year[9], 2 * 365);
  assert.equal(socHistogram({ ...result(), size: { bess_kwh: 0, bess_kw: 0 } }), null);
});

test('renewable fraction by energy, capacity and peak', () => {
  const R = result(), F = reFractions(R, P);
  assert.equal(F.energy, 0.4);
  assert.ok(Math.abs(F.capacity - 1000 / 2000) < 1e-12);
  assert.ok(Math.abs(F.peak - 450 / 600) < 1e-12);
  // a wind turbine and the optimiser's genset count
  const W = reFractions({ ...R, size: { ...R.size, wind_units: 2, gen_units: 4 } }, P);
  assert.ok(Math.abs(W.capacity - 4000 / 6000) < 1e-12);
  assert.equal(runFleetKw({ size: {}, fleet: [{ units: 2, unit_kw: 800 }, { units: 1, unit_kw: 200 }] }, P.diesel), 1800);
  assert.equal(reTiles(F)[0][1], '50.0 %');
});

test('a failed check reads as one line with its range', () => {
  const t = checkText({ id: 'co2_per_l', label: 'CO2 per litre of diesel (year 1)', value: 2.9, lo: 2.67732, hi: 2.68268, unit: 'kg/L', why: 'the factor entered' });
  assert.equal(t, 'CO2 per litre of diesel (year 1): 2.9000 kg/L, expected 2.6773 to 2.6827 kg/L. The factor entered.');
  assert.equal(checkText({ label: 'Payback', value: 5, lo: null, hi: -1, unit: 'years', why: 'never' }), 'Payback: 5.00 years, expected at most -1.00 years. Never.');
  assert.deepEqual(checksOf({ summary: {} }), []);
});
