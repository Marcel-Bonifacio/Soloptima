// The critical-load and deferrable-load inputs on their way to the engine (lib/ws/lean.js) and the outage survival card (lib/resilience-view.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { leanLoad, leanDeferrable, leanDiesel, leanGrid, leanEms } from '../src/lib/ws/lean.js';
import { resilRows, resilCells, resilFig, resilStripFig, stripPick, stripDurations, resilNotes, unitFails } from '../src/lib/resilience-view.js';

const c = { bess: 'g', gen: 'b', unmet: 'r', muted: 'm', text2: 't', pv: 'a' };

// A study of `max_h` hours every `stride` hours whose survival falls linearly
function study(max_h = 48, stride = 1, fails = true) {
  const f = (k) => Array.from({ length: max_h }, (_, i) => 1 - k * (i + 1) / max_h);
  const starts = Math.ceil(8760 / stride), durs = [1, 2, 4, 8, 12, 24, 48].filter((d) => d < max_h).concat([max_h]);
  return { stride, max_h, starts, critical_share: 0.5, critical_kw_mean: 100, units: 2, fail_start: fails ? 0.05 : 0, mttf_h: fails ? 1000 : null,
    availability: 1, unit_reliability: f(0.1), cum: { min: f(0.9), p5: f(0.5), mean: f(0.2), below90: f(-0.1).map((x) => x - 1) },
    hourly: { min: f(0.8), mean: f(0.1) }, served_mean: f(0.05),
    strip: { durations: durs, values: durs.map((d) => Array.from({ length: starts }, () => 1 - d / max_h / 2)) } };
}

test('the critical-load inputs reach the engine only when used', () => {
  assert.deepEqual(leanLoad({ kw: [1], growth: 0, critical_share: 1 }, {}), { kw: [1], growth: 0 });
  assert.deepEqual(leanLoad({ kw: [1], growth: 0 }, {}), { kw: [1], growth: 0 });
  assert.deepEqual(leanLoad({ kw: [1], growth: 0, critical_share: 0.4 }, {}), { kw: [1], growth: 0, critical_share: 0.4 });
  assert.deepEqual(leanDiesel({ units: 2, fail_start: 0, mttf_h: 0 }), { units: 2 });
  assert.deepEqual(leanDiesel({ units: 2, fail_start: 0.02, mttf_h: 0 }), { units: 2, fail_start: 0.02 });
  assert.deepEqual(leanGrid({ enabled: true, outage_critical_only: false }), { enabled: true });
  assert.deepEqual(leanGrid({ enabled: true, outage_critical_only: true }), { enabled: true, outage_critical_only: true });
  assert.deepEqual(leanEms({ voll: 5, voll_nc: null }), { voll: 5 });
  assert.deepEqual(leanEms({ voll: 5, voll_nc: 0.5 }), { voll: 5, voll_nc: 0.5 });
  assert.deepEqual(leanEms({ voll: 5, voll_nc: null, plan_starts: true }), { voll: 5, plan_starts: true });
});

test('the deferrable load reaches the engine in energy, and only when on', () => {
  const D = { unit: 'energy', kwh_day: 0, m3_day: 0, kwh_m3: 0.5, kw: 0, start_h: 8, end_h: 17, tank_kwh: 0, tank_m3: 0, tank_fill: 0.5, first: 'battery' };
  assert.deepEqual(leanLoad({ kw: [1], growth: 0, deferrable: D }, {}), { kw: [1], growth: 0 });
  assert.deepEqual(leanLoad({ kw: [1], growth: 0, deferrable: { ...D, kwh_day: 600, kw: 100, tank_kwh: 1200 } }, {}).deferrable,
    { kwh_day: 600, kw: 100, start_h: 8, end_h: 17, tank_kwh: 1200, tank_fill: 0.5, first: 'battery' });
  // water times the energy per m³; the energy fields are not read then
  const w = leanDeferrable({ ...D, unit: 'water', kwh_day: 999, m3_day: 400, tank_m3: 800, kw: 50, first: 'deferrable' });
  assert.deepEqual(w, { kwh_day: 200, kw: 50, start_h: 8, end_h: 17, tank_kwh: 400, tank_fill: 0.5, first: 'deferrable' });
  assert.equal(leanDeferrable({ ...D, unit: 'water', m3_day: 400, kwh_m3: 0 }), undefined);
  assert.equal(leanDeferrable(undefined), undefined);
});

test('table: the listed outage lengths up to the longest, which is always a row', () => {
  const R = study(30);
  assert.deepEqual(resilRows(R).map((x) => x.d), [1, 2, 4, 8, 12, 24, 30]);
  const x = resilRows(R)[1];
  assert.equal(x.mean, R.cum.mean[1]);
  assert.equal(resilCells(x)[0], '2 h');
  assert.equal(resilRows(study(24)).at(-1).d, 24);
});

test('chart: minimum, 5th percentile, mean and the hourly mean in %, the unit reliability only when gensets fail', () => {
  const R = study(48);
  const f = resilFig(R, c);
  assert.deepEqual(f.traces.map((t) => t.name), ['Mean', '5th percentile', 'Minimum', 'Hour d alone, mean', 'One genset still running']);
  assert.equal(f.traces[0].x.length, 48);
  assert.ok(Math.abs(f.traces[0].y[47] - 80) < 1e-9);
  assert.equal(resilFig(study(48, 1, false), c).traces.length, 4);
  assert.ok(unitFails(R) && !unitFails(study(48, 1, false)));
});

test('strip: day by hour when the step fits the day, one row of starts otherwise', () => {
  const R = study(48, 1);
  assert.deepEqual(stripDurations(R), [1, 2, 4, 8, 12, 24, 48]);
  assert.equal(stripPick(R, 12), 12);
  assert.equal(stripPick(R, 336), 24, 'a length the study has not: 24 h');
  const f = resilStripFig(R, 24, c);
  assert.equal(f.traces[0].z.length, 24);
  assert.equal(f.traces[0].z[0].length, 365);
  assert.ok(Math.abs(f.traces[0].z[5][100] - 75) < 1e-9);
  const g = resilStripFig(study(48, 6), 24, c).traces[0];
  assert.deepEqual([g.z.length, g.z[0].length, g.y], [4, 365, [0, 6, 12, 18]]);
  const h = resilStripFig(study(48, 7), 24, c).traces[0];
  assert.equal(h.z.length, 1);
  assert.equal(h.z[0].length, Math.ceil(8760 / 7));
  assert.equal(resilStripFig(R, 5, c), null);
});

test('notes: what the study assumed', () => {
  const t = resilNotes(study(48)).join(' ');
  assert.ok(t.includes('50 % of the site load') && t.includes('1,000 h') && t.includes('Fuel is unlimited'), t);
  assert.ok(resilNotes(study(48, 1, false)).join(' ').includes('without failing'));
});
