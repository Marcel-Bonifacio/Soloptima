// The Solar resource and Load pages (lib/data-view.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { localSeries, weatherView, monthlyMeanMax, rng, applyTemplate, synthLoad, pastedNumbers, pasteInto, dailyProfile, loadView, loadKpis,
  weatherKey, loadKey, canon, projectKey, ryFingerprint, ryBody, weatherHeatFig, loadDailyFig } from '../src/lib/data-view.js';
import { LOAD_TEMPLATES } from '../src/lib/schema/index.js';

const flat = (v) => new Array(8760).fill(v);
const load = (o = {}) => ({ template: 'custom', daily: new Array(24).fill(100), monthly: new Array(12).fill(1), weekend_factor: 1, var_day: 0, var_hour: 0, seed: 1, target_avg: 0, source: 'synthetic', ...o });
const c = { pv: 'a', gen: 'b', unmet: 'c', load: 'd', surface2: 'e', text2: 'f' };

test('localSeries: local data stay, UTC data move by the offset (whole and fractional)', () => {
  const a = Array.from({ length: 8760 }, (_, i) => i % 24);
  assert.equal(localSeries(a, { is_utc: false }, 7), a);
  const b = localSeries(a, { is_utc: true }, 7);
  assert.equal(b[7], a[0]);   // UTC hour 0 is local hour 7
  const half = localSeries(flat(10), { is_utc: true }, 5.5);
  assert.ok(Math.abs(half.reduce((s, x) => s + x, 0) - 87600) < 1e-6);   // the energy is kept
  assert.ok(Math.abs(half[100] - 10) < 1e-9);
});

test('weatherView: tiles, monthly values and the QC days; null without data', () => {
  assert.equal(weatherView({ weather: null }), null);
  const P = { location: { utc_offset: 0, lat: 1, lon: 2 }, weather: { is_utc: false, ghi: flat(500), tamb: flat(25), wind: flat(3), source: 'PVGIS', lat: -8.5, lon: 115.25, qc: { days: [3, 4] } } };
  const v = weatherView(P);
  assert.equal(v.kpis[0][0], 'Annual GHI');
  assert.equal(v.kpis[0][1], '4,380');
  assert.equal(v.kpis[2][1], '25.0');
  assert.equal(v.kpis[4][1], '3.0');
  assert.equal(v.kpis[5][2], '-8.500, 115.250');
  assert.equal(v.gm.length, 12);
  assert.ok(Math.abs(v.gm[0] - 500 * 31 * 24 / 1000) < 1e-9);
  assert.deepEqual(v.marks, [3, 4]);
  assert.equal(v.heat.length, 24);
  assert.equal(v.heat[0].length, 365);
  P.weather.wind = null;
  assert.equal(weatherView(P).kpis[4][1], '–');
});

test('monthlyMeanMax: mean and maximum by month', () => {
  const t = flat(20); t[5] = 31;
  const { tm, tmax } = monthlyMeanMax(t);
  assert.equal(tmax[0], 31);
  assert.equal(tmax[1], 20);
  assert.ok(tm[0] > 20 && Math.abs(tm[1] - 20) < 1e-9);
});

test('rng: the same seed gives the same sequence', () => {
  const a = rng(5), b = rng(5), c2 = rng(6);
  assert.equal(a.normal(), b.normal());
  assert.notEqual(rng(5).normal(), c2.normal());
});

test('synthLoad: flat shape, weekend factor, average target, same seed same year', () => {
  const k = synthLoad(load());
  assert.equal(k.length, 8760);
  assert.ok(k.every((x) => x === 100));
  const w = synthLoad(load({ weekend_factor: 0.5 }));
  assert.equal(w[5 * 24], 50);   // the sixth day is a Saturday
  assert.equal(w[0], 100);
  const t = synthLoad(load({ target_avg: 40, var_day: 0.1, var_hour: 0.05 }));
  assert.ok(Math.abs(t.reduce((s, x) => s + x, 0) / 8760 - 40) < 0.05);
  const r1 = synthLoad(load({ var_hour: 0.1, seed: 9 })), r2 = synthLoad(load({ var_hour: 0.1, seed: 9 }));
  assert.deepEqual(r1, r2);
  assert.ok(r1.every((x) => x >= 0));
});

test('applyTemplate: the shape is scaled to the peak once; custom keeps the values', () => {
  const L = load({ template: 'dayshift', daily: new Array(24).fill(0) });
  assert.equal(applyTemplate(L), true);
  assert.equal(Math.max(...L.daily), 1000);   // no peak yet: 1000 kW
  assert.equal(applyTemplate(L), false);      // applied once per chosen template
  L.template = 'residential'; L.daily[0] = 2000;
  assert.equal(applyTemplate(L), true);
  assert.equal(Math.max(...L.daily), 2000 * LOAD_TEMPLATES.residential.shape[18] * 1);
  const C = load(); assert.equal(applyTemplate(C), false);
});

test('paste: two numbers at least; values fill from the hour on and negatives become 0', () => {
  assert.equal(pastedNumbers('5'), null);
  assert.deepEqual(pastedNumbers('1.5\n2\t-3'), [1.5, 2, -3]);
  assert.deepEqual(pastedNumbers('1,5\n2,25\t3'), [1.5, 2.25, 3]);   // decimal commas
  assert.deepEqual(pastedNumbers('1,5\n2.5'), [1, 5, 2.5]);   // a dot is used: commas separate
  const d = new Array(24).fill(9);
  pasteInto(d, 22, [1, -2, 7]);
  assert.deepEqual(d.slice(21), [9, 1, 0]);
});

test('load view: tiles, hourly profile and monthly MWh', () => {
  const kw = flat(100); kw[10] = 400;
  const P = { load: { kw, source: 'csv', template: 'custom', qc: { days: [1] } } };
  const v = loadView(P);
  assert.equal(v.kpis[5][1], 'Measured (CSV)');
  assert.deepEqual(v.marks, [1]);
  assert.ok(Math.abs(v.monthly.reduce((s, x) => s + x, 0) - (876000 + 300) / 1000) < 1e-9);
  assert.equal(dailyProfile(kw).mx[10], 400);
  assert.equal(dailyProfile(kw).mn[10], 100);
  P.load.source = 'synthetic'; P.load.template = 'dayshift';
  assert.equal(loadKpis(P)[5][2], LOAD_TEMPLATES.dayshift.name);
  assert.equal(loadView({ load: { kw: null } }), null);
  assert.equal(loadView(P).marks, null);
});

test('keys: a new object makes a new key, the same data keep it', () => {
  const P = { location: { utc_offset: 7 }, weather: { ghi: [], is_utc: true }, load: { kw: [], source: 'synthetic', template: 'x' } };
  const a = weatherKey(P), l = loadKey(P);
  assert.equal(weatherKey(P), a);
  assert.equal(loadKey(P), l);
  P.weather = { ghi: [], is_utc: true };
  assert.notEqual(weatherKey(P), a);
  P.location.utc_offset = 8;
  assert.ok(weatherKey(P).endsWith('|8'));
  P.load.kw = [];
  assert.notEqual(loadKey(P), l);
});

test('fingerprint of the weather-year run: key order and 7 digits do not matter, a setting does', () => {
  assert.deepEqual(canon({ b: 0.123456789, a: [1, { d: 2, c: 1.5 }] }), { a: [1, { c: 1.5, d: 2 }], b: 0.1234568 });
  const R = { source: 'pvgis', from: 2005, to: 2020, unc_dataset: 0.03, unc_model: 0.03, unc_soiling: 0.01 };
  const a = ryFingerprint({ x: 1, y: 2.123456789 }, R), b = ryFingerprint({ y: 2.1234568, x: 1 }, R);
  assert.equal(a, b);
  assert.notEqual(a, ryFingerprint({ x: 1, y: 2.1234568 }, { ...R, to: 2021 }));
  assert.match(projectKey({ a: 1 }), /^[0-9a-f]+:7$/);
  assert.deepEqual(ryBody({ p: 1 }, R).budget, { dataset: 0.03, model: 0.03, soiling: 0.01 });
});

test('figures: heat map outlines the flagged days, the load profile has three traces', () => {
  const f = weatherHeatFig(c, { heat: [[1]], marks: [3, 4, 9] });
  assert.equal(f.layout.shapes.length, 2);
  assert.equal(loadDailyFig(c, { prof: { mn: [], mx: [], mean: [] } }).traces.length, 3);
});
