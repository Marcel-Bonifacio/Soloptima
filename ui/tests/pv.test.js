import test from 'node:test';
import assert from 'node:assert/strict';
import { pvTiles, pvUse, pvBalance, balanceRows, balanceFig, bestTilt, tiltFig, pvRefText, refErrorText, windPreview, windFig, BAL_HEADS } from '../src/lib/pv-view.js';
import { MDAYS } from '../src/lib/series.js';

const twelve = (v) => Array.from({ length: 12 }, () => v);
const PVR = { specific_yield: 1500, performance_ratio: 0.8, poa_annual: 1900, ac_per_kwp: new Array(8760).fill(0.2),
  monthly: { ghi: twelve(150), dhi: twelve(60), tamb: twelve(26), poa: twelve(160), eff: twelve(150), earray: twelve(130), eavail: twelve(125) } };
const C = { pv: '#a', curt: '#b', muted: '#c', text: '#d', text2: '#e', accent: '#f', wind: '#g' };

test('tiles', () => {
  const t = pvTiles(PVR, 100);
  assert.equal(t.length, 6);
  assert.equal(t[0][1], '1,500');
  assert.equal(t[0][3], true);
});

test('balance without simulation', () => {
  const B = pvBalance(PVR, null, 100);
  assert.equal(B.rows.length, 13);
  assert.equal(B.sim, false);
  assert.equal(B.stale, false);
  const y = B.rows[12];
  assert.equal(y.label, 'Year');
  assert.equal(y.poa, 1920);
  assert.ok(Math.abs(y.pr - 1500 / 1920) < 1e-12);
  assert.ok(Math.abs(B.rows[1].yr - 160 / MDAYS[1]) < 1e-12);
  assert.equal(pvBalance(null, null, 100), null);
});

test('balance with a matching and a stale simulation', () => {
  const n = 8760, kwp = 100;
  const H = { pv_avail: new Array(n).fill(1500 * kwp / n), pv_curtailed: new Array(n).fill(0), pv_to_load: new Array(n).fill(1500 * kwp / n), pv_to_bess: new Array(n).fill(0) };
  const SIM = { result: { hourly: H, size: { pv_kwp: kwp } } };
  const U = pvUse(PVR, SIM, kwp);
  assert.ok(Math.abs(U.used.reduce((a, b) => a + b, 0) - 1500) < 1e-6);
  const B = pvBalance(PVR, SIM, kwp);
  assert.equal(B.sim, true);
  assert.ok(B.rows[12].prUsed > 0);
  // PV capacity changed since the simulation
  const S = pvBalance(PVR, SIM, 120);
  assert.equal(S.sim, false);
  assert.equal(S.stale, true);
  assert.equal(S.rows[0].lu, null);
});

test('balance table and figure', () => {
  const B = pvBalance(PVR, null, 100), rows = balanceRows(B, 100);
  assert.equal(rows[12].cls, 'total');
  assert.equal(rows[0].cells.length, BAL_HEADS.length);
  const f = balanceFig(B, C);
  assert.equal(f.traces.length, 4);
  assert.equal(f.layout.barmode, 'stack');
  assert.equal(balanceFig({ ...B, sim: false }, C).layout.yaxis2.range[1], 100);
});

test('tilt scan', () => {
  const pts = [[0, 1200], [20, 1500], [40, 1400]];
  assert.deepEqual(bestTilt(pts), [20, 1500]);
  assert.equal(tiltFig(pts, C).traces[1].text[0], 'best 20°');
});

test('PVGIS text', () => {
  const r = { pvgis_ey: 1500, soloptima_ey: 1400, diff: -0.0667, loss_pct: 14, radiation_db: 'SARAH', year_min: 2005, year_max: 2020, tracker: false };
  const P = { pv: { bifaciality: 0.7 }, weather: { source: 'NASA POWER' } };
  const t = pvRefText(r, P);
  assert.match(t[0], /−6\.7 %/);
  assert.match(t[1], /bifacial/);
  assert.match(t[2], /not from PVGIS/);
  assert.equal(pvRefText({ ...r, diff: 0.1 }, { pv: { bifaciality: 0 }, weather: { source: 'PVGIS TMY' } }).length, 3);
  assert.match(pvRefText(r, { pv: { bifaciality: 0 }, weather: { source: 'PVGIS 2019' } })[2], /single PVGIS year/);
});

test('PVGIS error message', () => {
  assert.equal(refErrorText('Cannot reach server'), null);
  assert.equal(refErrorText('Download failed: 500'), null);
  assert.equal(refErrorText('boom'), 'PVGIS reference not available: boom');
});

test('wind preview', () => {
  assert.equal(windPreview({ weather: null, wind: {} }).monthlyMwh, null);
  const w = { hub_height: 80, ref_height: 10, shear_alpha: 0.14, v_in: 3, v_rated: 12, v_out: 25, rated_kw: 1000, curve: 'cubic', losses: 0.1, availability: 0.95, units: 2 };
  const P = { weather: { wind: new Array(8760).fill(6) }, wind: w };
  const r = windPreview(P);
  assert.equal(r.monthlyMwh.length, 12);
  assert.match(r.text, /for 2 turbines/);
  assert.equal(windFig(r.monthlyMwh, C).traces[0].type, 'bar');
  assert.ok(!/for \d+ turbines/.test(windPreview({ ...P, wind: { ...w, units: 0 } }).text));
});
