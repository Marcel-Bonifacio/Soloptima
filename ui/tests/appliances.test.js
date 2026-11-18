import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAppliances, seasonDays, seasonEnergy, applianceShapes, editAppliances, newAppliance } from '../src/lib/appliances.js';
import { synthLoad } from '../src/lib/data-view.js';
import { MDAYS, SEASON_OF_MONTH } from '../src/lib/series.js';

// lights from 18:00 for 5 h, a fridge all day, fans 2.5 h from 23:00 in Jun-Aug only (past midnight, the last hour in part)
const LIST = { households: 10, items: [
  { name: 'Lights', w: 10, qty: 4, h: [5, 5, 5, 5], start: 18 },
  { name: 'Fridge', w: 100, qty: 1, h: [24, 24, 24, 24], start: 0 },
  { name: 'Fan', w: 50, qty: 2, h: [0, 0, 2.5, 0], start: 23 },
] };

test('the list sums to the expected daily energy in each season', () => {
  const E = seasonEnergy(LIST);
  const base = 10 * (0.04 * 5 + 0.1 * 24);   // kWh a day, all households
  assert.ok(Math.abs(E[0].kwh - base) < 1e-9);
  assert.ok(Math.abs(E[2].kwh - (base + 10 * 0.1 * 2.5)) < 1e-9);
  assert.ok(Math.abs(E[3].kwh - base) < 1e-9);
});

test('each appliance stays in its window', () => {
  const D = seasonDays(LIST);
  // lights 18-22, fridge every hour
  for (let h = 0; h < 24; h++) assert.ok(Math.abs(D[0][h] - (1 + (h >= 18 && h <= 22 ? 0.4 : 0))) < 1e-9, `hour ${h}`);
  // fans: 23:00 full, 00:00 full, 01:00 half, nothing at 02:00
  assert.ok(Math.abs(D[2][23] - 2) < 1e-9);
  assert.ok(Math.abs(D[2][0] - 2) < 1e-9);
  assert.ok(Math.abs(D[2][1] - 1.5) < 1e-9);
  assert.ok(Math.abs(D[2][2] - 1) < 1e-9);
});

test('the synthetic load takes the list month by month', () => {
  const L = { template: 'appliances', appliances: LIST, daily: new Array(24).fill(500), monthly: new Array(12).fill(1), weekend_factor: 1, var_day: 0, var_hour: 0, seed: 1, target_avg: 0 };
  const kw = synthLoad(L), S = applianceShapes(LIST), E = seasonEnergy(LIST);
  let h0 = 0;
  MDAYS.forEach((d, m) => {
    const month = kw.slice(h0 * 24, (h0 + d) * 24).reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(month - d * E[SEASON_OF_MONTH[m]].kwh) < 0.01 * d, `month ${m}`);
    h0 += d;
  });
  assert.equal(kw[19], S[0][19]);
  // without energy in the list the daily shape is used
  assert.equal(applianceShapes({ households: 1, items: [newAppliance()] }), null);
  assert.equal(synthLoad({ ...L, appliances: { households: 1, items: [] } })[5], 500);
});

test('a file list is cleaned and edits stay in range', () => {
  const C = cleanAppliances({ households: -3, items: [{ name: 7, w: 'x', qty: 2, h: [30, -1], start: 25.4 }, null] });
  assert.deepEqual(C, { households: 0, items: [{ name: '7', w: 0, qty: 2, h: [24, 0, 0, 0], start: 23 }] });
  assert.deepEqual(cleanAppliances(undefined), { households: 1, items: [] });
  let A = editAppliances(undefined, { add: true });
  A = editAppliances(A, { row: 0, key: 'h2', value: '6' });
  A = editAppliances(A, { row: 0, key: 'w', value: '250' });
  assert.deepEqual(A.items[0], { ...newAppliance(), w: 250, h: [0, 0, 6, 0] });
  assert.equal(editAppliances(A, { remove: 0 }).items.length, 0);
});
