// Metered PV output against the yield model: the import options, the card's tables and chart, Apply and Undo values, the workbook
// sheet and the cleaning of a project file's meter (plain modules)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSession, engineOpt } from '../src/lib/tsimport/guess.js';
import { unitHints, reportRows, importInfo } from '../src/lib/tsimport/texts.js';
import { statRows, STAT_HEADS, monthRows, fitView, meterFig, applyValues, canUndo, meterLine, meterSheet } from '../src/lib/pvmeter-view.js';
import { cleanMeter } from '../src/lib/migrate-project.js';

const ctx = { tz: 'Asia/Jakarta', utcOffset: 7, isUtc: false, prev: undefined };
const st = (k) => ({ hours: 100, meter_kwh: 1000 * k, model_kwh: 900 * k, mbe_kw: -1, mbe: -0.1, rmse_kw: 2, nrmse: 0.2, r2: 0.9 });
const month = (i) => (i === 2 || i === 3 ? { hours: 600, outage_h: i === 2 ? 4 : 0, meter_kwh: 1e5, model_kwh: 9e4, fit_kwh: 1e5, fit_monthly_kwh: 1e5, dev: -0.1 }
  : { hours: 0, outage_h: 0, meter_kwh: 0, model_kwh: 0, fit_kwh: 0, fit_monthly_kwh: 0, dev: null });
const R = {
  hours: 1200, daylight_h: 600, running_h: 596, outage_h: 4, outages: ['3 Mar 12:00'],
  stats: { running: st(1), all: st(1) }, monthly: Array.from({ length: 12 }, (_, i) => month(i)),
  fit: { soiling: 0.0812, soiling_raw: 0.0812, at_bound: false, soiling_monthly: Array.from({ length: 12 }, (_, i) => (i === 2 ? 0.07 : i === 3 ? 0.09 : 0.0812)),
    own_month: Array.from({ length: 12 }, (_, i) => i === 2 || i === 3), availability: 0.99341, after: { ...st(1), rmse_kw: 1 }, after_monthly: { ...st(1), rmse_kw: 0.9 },
    rmse_gain: 0.5, rmse_gain_monthly: 0.55 },
  notes: ['Less than three months of data: the fitted soiling holds for that season only.'],
  project: { soiling: 0.02, soiling_monthly: null, availability: 0.99 },
};

test('a PV meter file: the PV column, its unit and the options the engine takes', () => {
  const text = 'Timestamp,Irradiance W/m2,PV export kWh\n2025-03-01 00:15,0,0\n2025-03-01 00:30,0,0\n';
  const S = openSession('pv', 'm.csv', text, ctx);
  assert.deepEqual(S.opt.cols, [2]);
  assert.equal(S.opt.units, 'kwh_interval');
  const e = engineOpt(S, ctx);
  assert.equal(e.kind, 'pv');
  assert.deepEqual(e.cols, [2]);
  assert.equal(e.units, 'kwh_interval');
  assert.equal(e.fill_long, undefined);
  assert.equal(e.utc_offset, 7);
  assert.equal(importInfo('pv', 'm.csv', { basis: 'local_standard', units: 'kw' }, { interval_min: 15 }).units, 'kw');
});

test('import words for a PV meter: unit hints against the capacity, gaps not filled, negatives', () => {
  const kw = new Array(8760).fill(null);
  kw[12] = 2000;
  assert.match(unitHints('pv', { kw }, {}, { capacity_kwp: 1000 })[0], /above 1.3 times the PV capacity/);
  kw[12] = 100;
  assert.match(unitHints('pv', { kw }, {}, { capacity_kwp: 1000 })[0], /below a fifth/);
  kw[12] = 800;
  assert.deepEqual(unitHints('pv', { kw }, {}, { capacity_kwp: 1000 }), []);
  const rows = reportRows({ positional: true, parsed: 10, interval_min: 15, period: '2025', coverage: 0.5, missing_h: 4380, runs: [], filled_h: 0, max_gap_h: 4380, negative_h: 12 });
  assert.deepEqual(rows.find((r) => r[0] === 'Gaps'), ['Gaps', 'not filled, only the hours in the file are compared; longest gap 4,380 h']);
  assert.match(rows.find((r) => r[0] === 'Negative hours')[1], /^12, set to 0/);
  assert.ok(!rows.some((r) => r[0] === 'Filled hours'));
});

test('the card: statistics, months with data, fit lines and the chart', () => {
  const S = statRows(R);
  assert.equal(S[0].length, STAT_HEADS.length);
  assert.deepEqual(S.find((r) => r[0] === 'MBE').slice(1, 2), ['−10.0 % (-1.0 kW)']);
  const M = monthRows(R);
  assert.deepEqual(M.map((r) => r[0]), ['Mar', 'Apr']);
  assert.equal(M[0][6], '7.0 %');
  const F = fitView(R);
  assert.equal(F.monthly, false);   // two months of their own: the constant only
  assert.match(F.lines[1], /Fitted soiling 8\.1 % against the project's 2\.0 %; availability 99\.3 % against 99\.0 %/);
  assert.match(F.lines[2], /50\.0 % lower/);
  const fig = meterFig(R, { load: '#a', pv: '#b', muted: '#c' }, 30000);
  assert.equal(fig.traces.length, 3);
  assert.equal(fig.traces[0].y[0], null);
  assert.equal(fig.traces[0].y[2], 100);   // MWh above 1 MWp
  assert.equal(fig.traces[1].customdata[2], '−10.0 % vs meter');
});

test('Apply values, the values they replace, and Undo while they are unchanged', () => {
  const pv = { soiling: 0.02, soiling_monthly: null, availability: 0.99 };
  const { values, prev } = applyValues(R, pv, 'constant');
  assert.deepEqual(values, { soiling: 0.0812, soiling_monthly: null, availability: 0.9934 });
  assert.deepEqual(prev, pv);
  const after = { ...pv, ...values };
  assert.ok(canUndo({ values, prev }, after));
  assert.ok(!canUndo({ values, prev }, { ...after, soiling: 0.05 }));
  assert.ok(!canUndo(null, after));
  const m = applyValues(R, pv, 'monthly').values;
  assert.equal(m.soiling_monthly.length, 12);
  assert.equal(m.soiling_monthly[2], 0.07);
  assert.ok(canUndo({ values: m, prev }, { ...pv, ...m, soiling_monthly: [...m.soiling_monthly] }));
});

test('the meter line and the workbook sheet', () => {
  const kw = new Array(8760).fill(null).map((x, i) => (i < 48 ? 1 : null));
  assert.equal(meterLine({ kw, import: { file: 'm.csv', report: { period: '2025', interval_min: 15 } } }), 'm.csv: 48 h of 2025, logged every 15 min.');
  assert.equal(meterLine(null), '');
  const rows = meterSheet(R, { kw, import: { file: 'm.csv' }, applied: { mode: 'monthly' } });
  assert.equal(rows.length, 1 + 12 + 2 + 8 + 2 + 7 + 1 + 1 + 1);
  assert.deepEqual(rows[3].slice(0, 6), ['Mar', 600, 4, 1e5, 9e4, -0.1]);
  assert.deepEqual(rows.find((r) => r[0] === 'Soiling'), ['Soiling', 0.0812, 0.02]);
  assert.deepEqual(rows.find((r) => r[0] === 'Applied to the project'), ['Applied to the project', 'monthly soiling and availability', '']);
});

test('a meter from a project file is kept only with valid hours and values', () => {
  const kw = new Array(8760).fill(null);
  kw[5] = 3.5;
  const ok = { kw: [...kw], import: { file: 'm.csv' }, applied: { mode: 'constant', values: { soiling: 0.05, availability: 0.98, soiling_monthly: null }, prev: { soiling: 0.02, availability: 0.99 } } };
  const p = { pv_meter: structuredClone(ok) };
  cleanMeter(p);
  assert.deepEqual(p.pv_meter, ok);
  for (const bad of [{ kw: kw.slice(1) }, { kw: kw.map((x, i) => (i === 3 ? -1 : x)) }, { kw: kw.map((x, i) => (i === 3 ? '2' : x)) }, { kw: kw.map((x, i) => (i === 3 ? Infinity : x)) }, 'x', 5]) {
    const q = { pv_meter: bad };
    cleanMeter(q);
    assert.equal(q.pv_meter, null);
  }
  const q = { pv_meter: { kw: [...kw], import: 'x', applied: { values: { soiling: 'a' } } } };
  cleanMeter(q);
  assert.equal(q.pv_meter.import, null);
  assert.equal(q.pv_meter.applied, null);
  const none = {};
  cleanMeter(none);
  assert.equal(none.pv_meter, null);
});
