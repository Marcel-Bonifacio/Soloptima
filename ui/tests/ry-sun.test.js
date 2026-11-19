// The weather-year card, the sun path chart and the loss diagram as plain data (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, summary, tableRows, notes, factorText, chosenFactor, chart, HEADS, QUANTILES } from '../src/lib/ry-view.js';
import { sunAt, profileXY, sunChart } from '../src/lib/sun.js';

const col = new Proxy({}, { get: () => '#123456' });
const st = (p50, mean, extra = {}) => ({ mean, p50, p75_1: p50 * 0.97, p90_1: p50 * 0.93, p99_1: p50 * 0.85, p90_10: p50 * 0.98, sigma_iav: 0.04, elasticity: 1.1, worst_year: 2015, worst: p50 * 0.9, ...extra });
const X = {
  database: 'PVGIS', range: { from: 2014, to: 2016 }, requested: { from: 2005, to: 2023 }, weather: 'PVGIS TMY (PVGIS)', model: 'host', sigma_sys: 0.05, budget: { dataset: 0.05, model: 0.02, soiling: 0.015 },
  key: 'k1', years: [2014, 2015, 2016].map((y, i) => ({ year: y, sy: 1500 + i * 10, fuel_saved: 1e5 + i })),
  stats: { yield: st(1500, 1500), fuel_saved: st(1e5, 1e5), re: st(0.4, 0.4), revenue: st(2e5, 2e5), fuel_used: st(5e5, 5e5) },
};

test('fmt gives units per result and a dash for no value', () => {
  assert.equal(fmt('yield', 1500), '1,500 kWh/kWp');
  assert.equal(fmt('re', 0.4), '40.0 %');
  assert.equal(fmt('fuel_used', 5e5), '500 kL');
  assert.equal(fmt('revenue', 2e5, 'USD'), 'USD 200 k');
  assert.equal(fmt('yield', null), '–');
});

test('summary: factors, applied factor, stale flag and the gap to the mean', () => {
  const S = summary(X, { p90_factor: 0.93, basis: 1 }, 0.93, 'k1');
  assert.equal(S.rows.length, 5);
  assert.equal(S.rows[3].label, 'Revenue (avoided diesel cost)');
  assert.ok(Math.abs(S.f1 - 0.93) < 1e-9);
  assert.equal(S.applied.p90_factor, 0.93);
  assert.equal(S.stale, false);
  assert.equal(summary(X, { p90_factor: 0.93 }, 0.9, 'k2').applied, null);
  assert.equal(summary(X, null, 1, 'k2').stale, true);
  assert.equal(summary(X, null, 1, null).stale, false);
  assert.equal(S.devWarn, '');
  const off = summary({ ...X, stats: { ...X.stats, yield: st(1650, 1500) } }, null, 1, 'k1');
  assert.match(off.devWarn, /already a typical year/);
  assert.equal(chosenFactor(S, 1), 0.93);
  assert.equal(chosenFactor(summary({ ...X, stats: { ...X.stats, revenue: st(0, 0) } }, null, 1, 'k1'), 1), null);
});

test('table, notes and factor text', () => {
  const S = summary(X, { p90_factor: 0.93, basis: 10 }, 0.93, 'k2');
  const rows = tableRows(S, 'USD');
  assert.equal(rows.length, 5);
  assert.equal(rows[0].length, HEADS.length);
  assert.equal(rows[0][1], '1,500 kWh/kWp');
  assert.equal(rows[0][8], '2015 (1,350 kWh/kWp)');
  assert.equal(QUANTILES.length, 5);
  const n = notes(S, 2);
  assert.match(n[0], /inputs have changed/);
  assert.match(n[1], /3 weather years of PVGIS 2014–2016 \(the years the database covers\)/);
  assert.match(n[2], /wind turbines/);
  assert.match(factorText(S), /Debt sizing uses 0.93 \(10-year average\)/);
});

test('chart: bars from the mean and the worst year outlined', () => {
  const { traces } = chart(summary(X, null, 1, 'k1'), col, 'USD');
  assert.equal(traces.length, 7);
  assert.deepEqual(traces[0].marker.line.width, [0, 2.5, 0]);
  assert.equal(traces[0].base, 100);
  assert.ok(Math.abs(traces[0].y[2] - (100 * 1520 / 1500 - 100)) < 1e-9);
});

test('sun position: equator equinox noon is overhead, the sun rises in the east', () => {
  assert.ok(Math.abs(sunAt(0, 0, 0).el - 90) < 1e-9);
  const r = sunAt(0, 0, -90);
  assert.ok(Math.abs(r.el) < 1e-9 && Math.abs(r.az - 90) < 1e-9);
});

test('profile is linear between the azimuth steps and wraps at north', () => {
  const { xs, ys } = profileXY([0, 10, 20, 30], false);
  assert.equal(xs[0], 0); assert.equal(xs[xs.length - 1], 360);
  assert.equal(ys[0], 0); assert.ok(Math.abs(ys[45] - 10) < 1e-9);   // 90 deg
  assert.ok(Math.abs(ys[180] - 0) < 1e-9);                            // 360 deg wraps to the first value
  assert.equal(profileXY([1, 2], true).xs[0], -180);
});

test('sun chart: horizon and shade profiles, seven sun paths, axes follow the hemisphere', () => {
  assert.equal(sunChart(null, [], null, col), null);
  const N = sunChart(10, [1, 2, 3, 4], { median: [5, 5], max: [8, 8] }, col);
  assert.equal(N.traces.length, 3 + 7);
  assert.deepEqual(N.layout.xaxis.range, [0, 360]);
  const S = sunChart(-8, null, null, col);
  assert.equal(S.traces.length, 7);
  assert.deepEqual(S.layout.xaxis.range, [-180, 180]);
  assert.equal(S.traces.filter((t) => t.showlegend).length, 1);
  assert.ok(S.traces.every((t) => t.y.every((v) => v == null || (v > 0 && v <= 90))));
});


test('loss diagram: totals on the trunk, the change of each step as a share of the one before', async () => {
  const { lossDiagram } = await import('../src/lib/loss-diagram.js');
  const L = [['Global horizontal irradiation', 2000, true], ['Global incident in collector plane', 2100, true], ['Effective irradiation (after soiling)', 2058, true],
    ['Array nominal energy at STC', 1900, false], ['After temperature loss', 1710, false], ['After inverter clipping', 1700, false], ['After availability (energy available)', 1683, false]]
    .map(([name, value, irradiance]) => ({ name, value, irradiance }));
  const svg = lossDiagram(L, { capacity_kwp: 100, module_wp: 500, module_length: 2, module_width: 1 });
  for (const t of ['+5.00%', '-2.00%', '-10.00%', 'Soiling loss factor', 'PV loss due to temperature', 'Energy available at the plant bus', '2000 kWh/m²', '168.3 MWh', 'efficiency at STC = 25.00%', '400 m² coll.']) assert.ok(svg.includes(t), t);
  assert.equal(lossDiagram([], {}), '');
  assert.ok(!lossDiagram([{ name: '<b>x', value: 1, irradiance: true }, { name: 'y', value: 1, irradiance: true }], {}).includes('<b>'), 'names are escaped');
});
