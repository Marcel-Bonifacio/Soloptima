// The "Compare operating options" card (lib/options-view.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { optionCases, ccSetpoint, optionShort, infeasible, summarize, optionRows, bestNote, waterfallFig } from '../src/lib/options-view.js';

const P = { bess: { soc_max: 0.9 }, wind: { units: 0 }, ems: { pv_forecast: 'ensemble', load_forecast: 'mlp' }, econ: { currency: 'USD' },
  optimizer: { max_unmet: 0.01, min_re: 0, max_curtail: 1, max_lole_h: -1, max_reserve_short_h: -1, max_pv_kwp: 0, max_capex: 0 } };

// a simulation response with the figures the card reads
const res = (npc, over = {}) => ({ result: { years: [{ fuel_l: 1e5, unit_hours: 4000, starts: 20, bess_efc: 100 }], re_fraction: 0.4, avg_gen_load: 0.6, bess_replacements: 1,
  curtail_fraction: 0.02, unmet_fraction: 0, size: { pv_kwp: 1000 }, econ: { capex_total: 2e6, npc, lcoe: 0.3 }, ...over }, comparison: { npv_savings: 1e5, irr: 0.12 }, finance: { equity_irr: 0.15 } });
const run = (npcs) => ({ key: 'k', fast: false, rows: optionCases(P).map(([id, label], i) => ({ id, label, res: res(npcs[id] ?? 1e6 + i) })) });

test('cases: the cycle-charging setpoint is capped at the maximum SOC and rows that coincide run once', () => {
  assert.equal(ccSetpoint(P, 'cc60'), 0.6);
  assert.equal(ccSetpoint(P, 'cc100'), 0.9);
  const ids = optionCases(P).map((c) => c[0]);
  assert.deepEqual(ids, ['diesel', 'pv', 'lf', 'cc60', 'cc80', 'cc100', 'pred', 'perfect']);
  const Q = { ...P, bess: { soc_max: 0.7 } };
  assert.deepEqual(optionCases(Q).map((c) => c[0]), ['diesel', 'pv', 'lf', 'cc60', 'cc80', 'pred', 'perfect']);   // cc80 and cc100 both cap at 0.7: one row
  assert.equal(optionShort(P, 'cc100'), 'cycle charging to 90 %');
  assert.match(optionCases(P).find((c) => c[0] === 'cc100')[1], /\(maximum SOC\)/);
  assert.equal(optionCases({ ...P, wind: { units: 2 } })[1][1], 'PV + wind only');
});

test('cases: the predictive row names the forecast methods', () => {
  assert.match(optionCases(P).find((c) => c[0] === 'pred')[1], /Adaptive ensemble \/ Neural network \(MLP\)/);
});

test('infeasible: the first broken constraint, in the optimiser order', () => {
  assert.equal(infeasible(P, res(1).result), '');
  assert.equal(infeasible(P, res(1, { unmet_fraction: 0.05 }).result), 'unmet load');
  assert.equal(infeasible({ ...P, optimizer: { ...P.optimizer, min_re: 0.5 } }, res(1).result), 'renewable fraction');
  assert.equal(infeasible({ ...P, optimizer: { ...P.optimizer, max_capex: 1e6 } }, res(1).result), 'capex budget');
});

test('summary: the best feasible option, NPC steps and the options within 0.5 %', () => {
  const S = summarize(P, run({ diesel: 5e6, pv: 4.5e6, lf: 4e6, cc60: 4.01e6, cc80: 4.2e6, cc100: 4.3e6, pred: 3.9e6, perfect: 3.5e6 }), false);
  assert.equal(S.best.id, 'pred');                       // the perfect-forecast benchmark is never the best
  assert.equal(S.strat.id, 'pred');
  assert.equal(S.rows.find((x) => x.id === 'lf').dnpc, -5e5);
  assert.deepEqual(S.near.map((x) => x.id), []);
  const S2 = summarize(P, run({ diesel: 5e6, pv: 4.5e6, lf: 3.91e6, cc60: 4.2e6, cc80: 4.2e6, cc100: 4.3e6, pred: 3.9e6 }), true);
  assert.deepEqual(S2.near.map((x) => x.id), ['lf']);
  assert.equal(S2.stale, true);
  assert.ok(S2.fall && S2.fall.S.id === 'pred');
  const note = bestNote(S2, 'USD');
  assert.equal(note.label, 'Battery, predictive EMS: Adaptive ensemble / Neural network (MLP)');
  assert.deepEqual(note.near, ['Battery, load following']);
});

test('summary: an infeasible option is never the best, an error row has no figures', () => {
  const o = run({ diesel: 5e6, pv: 4.5e6, lf: 4e6, cc60: 4.1e6, cc80: 4.1e6, cc100: 4.1e6, pred: 3e6 });
  o.rows.find((r) => r.id === 'pred').res.result.unmet_fraction = 0.5;
  o.rows.find((r) => r.id === 'cc60').res = { error: 'boom' };
  const S = summarize(P, o, false);
  assert.equal(S.best.id, 'lf');
  assert.equal(S.rows.find((x) => x.id === 'pred').why, 'unmet load');
  const rows = optionRows(S);
  assert.equal(rows.find((r) => r.label.includes('cycle charging to 60')).err, 'boom');
  assert.equal(rows.find((r) => r.label === 'Battery, load following').best, true);
  assert.equal(rows[0].change, '–');
  assert.equal(rows[0].cells.length, 15);
});

test('waterfall: five steps from diesel only to the hybrid; none when a step is missing', () => {
  const c = { text: '#000', unmet: 'r', bess: 'g', gen: 'b', border: '#ccc' };
  const S = summarize(P, run({ diesel: 5e6, pv: 4.5e6, lf: 4e6, cc60: 9e6, cc80: 9e6, cc100: 9e6, pred: 3.9e6 }), false);
  const f = waterfallFig(P, S, c);
  assert.deepEqual(f.traces[0].y, [5e6, -5e5, -5e5, -1e5, 3.9e6]);
  assert.equal(f.traces[0].x[1], '+ PV');
  const o = run({}); o.rows = o.rows.filter((r) => r.id !== 'lf');
  assert.equal(waterfallFig(P, summarize(P, o, false), c), null);
});
