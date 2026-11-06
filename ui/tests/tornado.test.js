// The "What drives the result" card (lib/tornado-view.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { tornadoCases, tornadoValue, tornadoInput, tornadoOverrides, tornadoRange, tornadoUnit, tornadoPct, tornadoFmt, tornadoSwing, applyEdit, varRows,
  summarize, tornadoFig, tableRows, tornadoNotes, tornadoPathList, tornadoHeight } from '../src/lib/tornado-view.js';

const mkP = () => ({ econ: { currency: 'USD', fuel_price: 1, discount_rate: 0.1, bess_capex_kwh: 300, bess_capex_kw: 100, bess_replace_kwh: 200, lifetime: 20 },
  pv: { degradation: 0.005, module_wp: 600 }, load: { kw: [10, 20, 30] }, sim: { all_years: true },
  tornado: { metric: 'npv', fast: false, bess_together: false, vars: [] } });
const V = (path, mode, lo, hi, label = '') => ({ path, label, mode, lo, hi });

test('values: x multiplies, + adds, = replaces; arrays only scale', () => {
  const P = mkP();
  assert.equal(tornadoValue(P, V('econ.fuel_price', 'x'), 1.2), 1.2);
  assert.equal(tornadoValue(P, V('econ.fuel_price', '+'), 0.5), 1.5);
  assert.equal(tornadoValue(P, V('econ.fuel_price', '='), 3), 3);
  assert.deepEqual(tornadoValue(P, V('load.kw', 'x'), 2), [20, 40, 60]);
  assert.equal(tornadoValue(P, V('load.kw', '+'), 2), null);
  assert.equal(tornadoValue(P, V('econ.nothing', 'x'), 2), null);
  assert.equal(tornadoValue(P, V('econ.fuel_price', 'x'), NaN), null);
  assert.equal(tornadoInput(P, V('load.kw', 'x'), [10, 20, 30]), '20.0 kW average');
});

test('overrides: battery energy capex drags the power capex and the replacement price along when ticked', () => {
  const P = mkP();
  assert.deepEqual(tornadoOverrides(P, V('econ.bess_capex_kwh', 'x'), 600), { 'econ.bess_capex_kwh': 600 });
  P.tornado.bess_together = true;
  assert.deepEqual(tornadoOverrides(P, V('econ.bess_capex_kwh', 'x'), 600), { 'econ.bess_capex_kwh': 600, 'econ.bess_capex_kw': 200, 'econ.bess_replace_kwh': 400 });
});

test('cases: base case first, the base value reuses it, bad paths are reported', () => {
  const P = mkP();
  P.tornado.vars = [V('econ.fuel_price', 'x', 0.8, 1.2, 'Diesel price'), V('econ.discount_rate', '+', 0, 0.02), V('pv.module_wp', 'x', 0.9, 1.1), V('econ.typo', 'x', 0.9, 1.1),
    V('load.kw', 'x', 0.9, 1.1), V('', 'x', 1, 1)];
  const eng = { econ: P.econ, pv: P.pv, load: P.load };
  const { cases, rows } = tornadoCases(P, eng);
  assert.equal(rows.length, 5);                          // the row without a path is skipped
  assert.deepEqual(cases[0], { overrides: {} });
  assert.deepEqual(rows[0].idx, [1, 2]);
  assert.deepEqual(rows[1].idx, [0, 3]);                 // + 0 is the base case
  assert.equal(rows[2].err, 'not an input of the engine');
  assert.equal(rows[3].err, 'not an input of the engine');
  assert.equal(rows[4].err, '');
  assert.equal(cases.length, 1 + 2 + 1 + 2);
  P.tornado.fast = true;
  assert.deepEqual(tornadoCases(P, eng).cases[0], { overrides: { 'sim.all_years': false } });
});

test('table of inputs: percentages are typed in %, a path that is an array turns the change type to x', () => {
  const P = mkP();
  P.tornado.vars = [V('econ.discount_rate', '+', -0.02, 0.02)];
  assert.equal(tornadoPct(P.tornado.vars[0]), true);
  assert.equal(varRows(P)[0].lo, -2);
  assert.equal(applyEdit(P, P.tornado.vars[0], 'hi', '3'), true);
  assert.equal(P.tornado.vars[0].hi, 0.03);
  assert.equal(applyEdit(P, P.tornado.vars[0], 'hi', ' '), false);
  assert.equal(applyEdit(P, P.tornado.vars[0], 'hi', 'abc'), false);
  assert.equal(P.tornado.vars[0].hi, 0.03);
  applyEdit(P, P.tornado.vars[0], 'path', ' load.kw ');
  assert.equal(P.tornado.vars[0].path, 'load.kw');
  assert.equal(P.tornado.vars[0].mode, 'x');
  assert.deepEqual([P.tornado.vars[0].lo, P.tornado.vars[0].hi], [0.8, 1.2]);
  assert.equal(varRows(P)[0].isArray, true);
  assert.deepEqual(tornadoRange(P, V('econ.fuel_price', '=')), { lo: 0.8, hi: 1.2 });
  assert.equal(tornadoUnit('USD', V('econ.discount_rate', '+')), 'pp');
  assert.equal(tornadoUnit('USD', V('econ.fuel_price', 'x')), '');
});

test('path list: engine inputs of the forms, without the layout-only module power', () => {
  const l = tornadoPathList();
  assert.equal(l[0][0], 'load.kw');
  assert.ok(l.some(([k]) => k === 'econ.fuel_price'));
  assert.ok(!l.some(([k]) => k === 'pv.module_wp'));
});

const run = () => ({ key: 'x', fast: false, together: false, base: { comparison: { npv_savings: 100 }, result: { econ: {} } },
  rows: [
    { label: 'A', vals: ['1', '2'], err: '', res: [{ comparison: { npv_savings: 90 }, result: { econ: {} } }, { comparison: { npv_savings: 120 }, result: { econ: {} } }] },
    { label: 'B', vals: ['1', '2'], err: '', res: [{ comparison: { npv_savings: 40 }, result: { econ: {} } }, { comparison: { npv_savings: 100 }, result: { econ: {} } }] },
    { label: 'C', vals: ['1', '2'], err: 'not an input of the engine', res: [null, null] },
    { label: 'D', vals: ['1', '2'], err: '', res: [{ error: 'bad' }, null] },
  ] });

test('summary: swing is the span of low, high and base; sorted, errors kept', () => {
  const S = summarize(run(), 'npv', false);
  assert.deepEqual(S.rows.map((x) => x.label), ['B', 'A', 'C', 'D']);
  assert.equal(S.rows[0].swing, 60);
  assert.equal(S.rows[1].swing, 30);
  assert.equal(S.rows[3].err, 'bad');
  assert.equal(S.base, 100);
  assert.equal(summarize(run(), 'nonsense', true).metric, 'npv');
  assert.equal(summarize(run(), 'nonsense', true).stale, true);
});

test('chart and table: bars for the rows that have one, base marker, notes', () => {
  const S = summarize(run(), 'npv', true), c = { gen: 'b', pv: 'a', text2: 'g' };
  const f = tornadoFig('USD', S, c);
  assert.equal(f.traces.length, 4);
  assert.deepEqual(f.traces[0].y, ['A', 'B']);           // largest swing on top: the categories run bottom-up
  assert.ok(Math.abs(f.traces[0].base - 100e-6) < 1e-12);
  assert.ok(Math.abs(f.layout.shapes[0].x0 - 100e-6) < 1e-12);
  assert.equal(tornadoHeight(S), 260);
  assert.equal(tornadoHeight({ rows: Array.from({ length: 10 }, () => ({ err: '', vLo: 1, vHi: 2 })), base: 1 }), 400);
  assert.equal(tornadoHeight({ rows: [], base: 1 }), 260);
  const t = tableRows('USD', S);
  assert.equal(t[2].err, 'not an input of the engine');
  assert.equal(t[0].cells.length, 3);
  const notes = tornadoNotes('USD', S);
  assert.match(notes[0], /press Run tornado again/);
  assert.match(notes[1], /^Base NPV of savings: USD 100/);
});

test('formats: IRR swing in points, LCOE per kWh, fuel in litres, missing as a dash', () => {
  assert.equal(tornadoSwing('USD', 'irr', 0.0123), '1.23 pp');
  assert.equal(tornadoFmt('USD', 'lcoe', 0.25), 'USD 0.2500/kWh');
  assert.equal(tornadoFmt('USD', 'fuel', 1234), '1,234 L');
  assert.equal(tornadoFmt('USD', 'npv', 0), 'USD 0');
  assert.equal(tornadoFmt('USD', 'irr', null), '–');
});
