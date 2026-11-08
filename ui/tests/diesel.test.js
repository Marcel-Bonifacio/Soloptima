import test from 'node:test';
import assert from 'node:assert/strict';
import { strategyHelp, fuelRate, fuelRows, setFuelCell, addFuelPoint, removeFuelPoint, fuelFig, recValue, pasteCells, pasteRecords } from '../src/lib/diesel-view.js';

const C = { gen: '#a', unmet: '#b' };
const table = () => ({ fuel_model: 'table', unit_kw: 100, min_load: 0.3, fuel_curve: [[0.25, 2.5], [0.5, 3.5], [1, 3.9]] });

test('strategy text', () => {
  assert.match(strategyHelp('predictive'), /^Predictive EMS/);
  assert.match(strategyHelp('load_following'), /^Load following/);
  assert.equal(strategyHelp('nothing'), '');
});

test('fuel rate: linear and interpolated', () => {
  assert.ok(Math.abs(fuelRate({ fuel_model: 'linear', fuel_intercept: 0.05, fuel_slope: 0.2 }, 0.5) - 0.15) < 1e-12);
  const D = table();
  assert.ok(Math.abs(fuelRate(D, 0.5) - 0.5 / 3.5) < 1e-12);
  const mid = fuelRate(D, 0.375);
  assert.ok(Math.abs(mid - (0.25 / 2.5 + 0.5 / 3.5) / 2) < 1e-12);
});

test('fuel table rows and edits', () => {
  const D = table();
  assert.deepEqual(fuelRows(D)[1], { load: 50, eff: 3.5, lph: '14.3' });
  setFuelCell(D, 2, 0, 40);   // load typed in percent, the curve is sorted again
  assert.deepEqual(D.fuel_curve.map((p) => p[0]), [0.25, 0.4, 0.5]);
  setFuelCell(D, 0, 1, 2.6);
  assert.equal(D.fuel_curve[0][1], 2.6);
  addFuelPoint(D);
  assert.deepEqual(D.fuel_curve[3], [1, 3.9]);
  assert.equal(removeFuelPoint(D, 0), true);
  removeFuelPoint(D, 0);
  assert.equal(removeFuelPoint(D, 0), false);
  assert.equal(D.fuel_curve.length, 2);
});

test('fuel figure', () => {
  const f = fuelFig(table(), C);
  assert.equal(f.traces.length, 2);
  assert.equal(f.layout.shapes[0].x0, 30);
  assert.equal(fuelFig({ fuel_model: 'linear', fuel_intercept: 0.05, fuel_slope: 0.2, min_load: 0.3 }, C).traces.length, 1);
});

test('records', () => {
  assert.equal(recValue(' 1200 '), 1200);
  assert.equal(recValue('0'), null);
  assert.equal(recValue(''), null);
  assert.equal(recValue('abc'), null);
  assert.equal(pasteCells('5'), null);
  assert.deepEqual(pasteCells('1,200\t\t300\n'), ['1200', '', '300']);
  assert.deepEqual(pasteCells('1 2;3'), ['1', '2', '3']);
  const rec = new Array(12).fill(null);
  pasteRecords(rec, 10, ['5', '6', '7']);
  assert.deepEqual(rec.slice(9), [null, 5, 6]);
  pasteRecords(rec, 0, ['', '9']);
  assert.deepEqual(rec.slice(0, 3), [null, 9, null]);
});

test('pasted cells: thousands separators and decimal commas', () => {
  assert.deepEqual(pasteCells('12,345.6\t1234,5\t12.345,6\t1,000'), ['12345.6', '1234.5', '12345.6', '1000']);
  assert.deepEqual(pasteCells('1 234\n5'), ['1234', '5']);
  assert.equal(pasteCells('42'), null);
});
