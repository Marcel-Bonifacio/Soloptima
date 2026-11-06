import test from 'node:test';
import assert from 'node:assert/strict';
import { monthBalance, energyFlow, flowFigure, flowTiles, flowNote, calibrationOf, calPct, calFmt, yearList, thresholdOf, bessHealthOf, bessTiles,
  sohFigure, genLoadBands, unitsDurationFigure, weekPicksOf, hourlyCsv, whatIfRanges, cRateOf, hasBattery } from '../src/lib/sim-extra.js';

const N = 8760;
const arr = (f) => Array.from({ length: N }, (_, i) => f(i));
const C = { pv: '#f0a000', wind: '#2a8', gen: '#38e', unmet: '#e22', soc: '#98e', bess: '#2b6', load: '#222', curt: '#e8a', text2: '#555', surface2: '#eee' };

function hourly() {
  return { load: arr(() => 100), aux: arr(() => 0), pv_to_load: arr((i) => (i % 24 > 8 && i % 24 < 16 ? 50 : 0)), wind_to_load: arr(() => 0), bess_dis: arr(() => 10),
    gen_to_load: arr(() => 40), gen_to_bess: arr(() => 0), unmet: arr(() => 0), pv_curtailed: arr(() => 0), gen_dump: arr(() => 0), fuel_l: arr(() => 10),
    gen_units: arr(() => 1), soc: arr(() => 0.5), pv_avail: arr(() => 60) };
}

test('monthBalance has 12 months and a year row that adds up', () => {
  const MB = monthBalance({ hourly: hourly() });
  assert.equal(MB.length, 13);
  assert.equal(MB[12].label, 'Year');
  assert.equal(MB[12].load, 100 * N);
  assert.ok(Math.abs(MB.slice(0, 12).reduce((s, x) => s + x.fuel, 0) - MB[12].fuel) < 1e-6);
  assert.ok(MB[12].re >= 0 && MB[12].re <= 1);
});

const year = { e_start: 100, e_end: 100, bess_ch: 1000, bess_dis: 850, self_discharge: 50, pv_to_load: 3000, pv_to_bess: 1000, wind_to_load: 0, wind_to_bess: 0,
  pv_avail: 4500, wind_avail: 0, gen_kwh: 6000, unmet: 0, load: 9000, pv_curtailed: 500, wind_curtailed: 0, gen_dump: 0, gen_to_load: 5150, gen_to_bess: 0, aux: 0 };

test('energyFlow closes the battery balance', () => {
  const F = energyFlow(year);
  assert.equal(F.loss, 100);
  assert.equal(F.showDE, false);
  assert.ok(Math.abs(F.direct - 0.75) < 1e-9);
});
test('flow figure, tiles and note', () => {
  const f = flowFigure(C, year);
  assert.equal(f.traces[0].type, 'sankey');
  assert.equal(f.traces[0].link.source.length, f.traces[0].link.value.length);
  assert.ok(f.traces[0].node.label.includes('Battery losses'));
  assert.deepEqual(flowTiles(year).map((t) => t[0]), ['Direct RE share', 'Battery losses', 'Self-discharge', 'Stored-energy change']);
  assert.match(flowNote(year), /below 0.1 %/);
  assert.equal(flowTiles({ ...year, bess_ch: 0, bess_dis: 0, self_discharge: 0, pv_to_bess: 0 }).length, 1);
});

test('calPct and calFmt', () => {
  assert.equal(calPct(null), '–');
  assert.equal(calPct(0.1234), '+12.3 %');
  assert.equal(calPct(-0.05), '−5.0 %');
  assert.equal(calFmt('sfc', 0.3333), '0.333');
  assert.equal(calFmt('load', 50.26), '50.3');
});

function simFor(fuelB) {
  const bh = { fuel_l: arr(() => fuelB / N), gen_units: arr(() => 1) };
  return { result: { hourly: hourly() }, baseline_hourly: bh,
    baseline: { years: [{ load: 8e6, gen_kwh: 8e6, fuel_l: fuelB, unit_hours: 8000 }] }, comparison: { fuel_saved_l_y1: fuelB / 2 } };
}
test('calibration: null without records, flags beyond tolerance, monthly note', () => {
  const P = { diesel: { units: 2, unit_kw: 1000, fuel_model: 'linear' }, site_records: null };
  assert.equal(calibrationOf(P, simFor(2e6)), null);
  assert.equal(calibrationOf(P, null), null);
  P.site_records = { annual_fuel_l: 2e6, annual_gen_mwh: 8000, annual_load_mwh: 0 };
  let K = calibrationOf(P, simFor(2e6));
  assert.deepEqual(K.rows.map((r) => r.k).sort(), ['fuel', 'gen', 'sfc']);
  assert.ok(K.rows.every((r) => !r.flag));
  assert.match(K.diag[0], /within its tolerance/);
  assert.equal(K.monthly, false);
  K = calibrationOf(P, simFor(2.4e6));
  assert.ok(K.rows.find((r) => r.k === 'fuel').flag);
  assert.ok(K.diag.some((d) => /specific fuel consumption/.test(d)));
  P.site_records.monthly_fuel_l = [100000, 200000];
  K = calibrationOf(P, simFor(2e6));
  assert.equal(K.nMonths, 2);
  assert.ok(K.monthly && K.months.length === 12 && K.cv > 0);
  assert.match(K.monthNote, /CV\(RMSE\)/);
  assert.match(K.basis, /2 × 1,?000 kW/);
});

test('yearList builds ranges', () => {
  assert.equal(yearList([1, 2, 3, 7]), '1–3, 7');
  assert.equal(yearList([]), '');
  assert.equal(yearList([4]), '4');
});

const yrs = [1, 2, 3].map((n) => ({ year: n, soh_loss_cal: 0.02, soh_loss_cyc: 0.03, bess_soh: 1 - 0.05 * (n - 1), bess_efc: 200 + n, bess_efc_dc: 210, max_c_rate: 0.4 + n / 100, bess_replaced: n === 2 }));
test('bess health and its figures', () => {
  assert.equal(thresholdOf({ replace_soh: -1, eol_soh: 0.7 }), 0.7);
  assert.equal(thresholdOf({ replace_soh: 0.6, eol_soh: 0.7 }), 0.6);
  const R = { years: yrs, size: { bess_kwh: 100, bess_kw: 50 } };
  const h = bessHealthOf(R, { replace_soh: null, eol_soh: 0.7, warranty_efc_yr: 202 });
  assert.equal(hasBattery(R), true);
  assert.equal(hasBattery({ size: { bess_kwh: 0, bess_kw: 0 } }), false);
  assert.deepEqual(h.repl, [2]);
  assert.deepEqual(h.over, [3]);
  assert.ok(Math.abs(h.life - 6) < 1e-9);
  assert.ok(Math.abs(h.cycShare - 0.6) < 1e-9);
  const t = bessTiles(R, h);
  assert.equal(t.length, 6);
  assert.equal(t[5][3], 'bad');
  const s = sohFigure(C, R, h);
  assert.equal(s.traces.length, 3);
  assert.equal(s.traces[0].x.length, 6);
});

test('genset bands and the duration curve', () => {
  const H = hourly();
  const b = genLoadBands(H, 100);   // 40 kW on one 100 kW unit
  assert.equal(b[4], N);
  assert.equal(b.reduce((a, x) => a + x, 0), N);
  const f = unitsDurationFigure(C, { gen_units: arr((i) => (i < 10 ? 2 : 1)) }, null);
  assert.equal(f.traces.length, 1);
  assert.equal(f.traces[0].y[0], 2);
  assert.equal(f.traces[0].y[N - 1], 1);
});

test('weekPicks names weeks that stand out', () => {
  const H = hourly();
  H.unmet[500] = 5;
  const R = { hourly: H, size: { bess_kwh: 0, bess_kw: 0 } };
  const p = weekPicksOf(R, { unit_kw: 100, min_load: 0.3 });
  assert.equal(p.unmet, Math.floor(500 / 168) * 168);
  assert.equal(p.soc, undefined);
  assert.ok(p.pv != null && p.units != null && p.re != null);
});

test('hourly CSV has a header and one row per hour', () => {
  const lines = hourlyCsv(hourly(), (t) => 'd' + t).split('\n');
  assert.equal(lines.length, N + 1);
  assert.match(lines[0], /^hour,date,hour_of_day,load,aux,/);
  assert.match(lines[1], /^0,d0,0,100,0,60,/);
});

test('what-if ranges', () => {
  const P = { load: { kw: arr(() => 1000) }, pv: { capacity_kwp: 500 }, bess: { energy_kwh: 1000, power_kw: 500 }, optimizer: { pv_max: 4000 }, layout: { result: null }, econ: { fuel_price: 1 } };
  const r = whatIfRanges(P);
  assert.equal(r.pv.max, 4000);
  assert.equal(r.pv.step, 10);
  assert.equal(r.be.max, 12000);
  assert.equal(r.fp.max, 3);
  assert.equal(r.fp.min, 0.2);
  assert.equal(cRateOf(P.bess), 0.5);
  assert.equal(cRateOf({ energy_kwh: 0, power_kw: 0 }), 0.5);
});
