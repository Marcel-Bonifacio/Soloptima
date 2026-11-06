// Which inputs changed after a run (lib/ws/diff.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { inputSnapshot, inputDiff, diffList, numPair } from '../src/lib/ws/diff.js';
import { W } from '../src/lib/ws/state.js';

W.P = { econ: { currency: 'USD' } };

test('snapshot: long series become a length, a sum and a hash; the name is not an input', () => {
  const s = inputSnapshot({ name: 'x', load: { kw: new Array(100).fill(2), growth: 0.01 } });
  assert.equal('name' in s, false);
  assert.equal(s['load.kw'].n, 100);
  assert.equal(s['load.kw'].sum, 200);
  assert.equal(s['load.growth'], 0.01);
});

test('diff: numbers with their unit, options by label, series by their sum', () => {
  const a = inputSnapshot({ econ: { fuel_price: 1 }, load: { kw: new Array(30).fill(1) }, diesel: { strategy: 'load_following' } });
  const b = inputSnapshot({ econ: { fuel_price: 1.1 }, load: { kw: new Array(30).fill(2) }, diesel: { strategy: 'cycle_charging' } });
  const d = inputDiff(a, b);
  assert.equal(d.length, 3);
  assert.match(diffList(d), /1\.00 to 1\.10/);
  assert.match(diffList(d), /Load changed \(sum 30 to 60 kWh\)/);
  assert.equal(inputDiff(a, a).length, 0);
});
