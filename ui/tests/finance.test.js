// Project finance page: presets, depreciation follow-up, tariff component edits, table rows, CSV and the haircut note
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idTax, presetValues, depFollow, editComponent, newComponent, pctText, revenueMode, p90Note, finRows, cashflowCsv, PRESET_LIST } from '../src/lib/finance-view.js';

test('Indonesian tax limits follow the currency', () => {
  assert.deepEqual(idTax('IDR'), { sme_31e: true, sme_low: 4.8e9, sme_high: 50e9 });
  assert.equal(idTax('USD').sme_low, Math.round(4.8e9 / 15500));
});

test('every preset exists and the Indonesian ones carry the tax limits', () => {
  for (const [id] of PRESET_LIST) assert.ok(presetValues(id, 'USD'));
  assert.equal(presetValues('nope', 'USD'), null);
  assert.equal(presetValues('pln', 'USD').sme_high, Math.round(50e9 / 15500));
  assert.equal(presetValues('pln', 'USD').components.length, 4);
  assert.equal(presetValues('generic', 'USD').tax_rate, 0.25);
  assert.equal(presetValues('diesel', 'USD').tariff_mode, 'diesel_discount');
});

test('presets give fresh component objects each time', () => {
  const a = presetValues('generic', 'USD'), b = presetValues('generic', 'USD');
  a.components[0].v1 = 9;
  assert.equal(b.components[0].v1, 0.12);
});

test('depreciation preset sets method and lives, zero means the term', () => {
  assert.deepEqual(depFollow('finance.dep_preset', { dep_preset: 'id_g3', term: 25 }, 20), { dep_method: 'db', dep_life: 16, dep_life_bess: 8 });
  assert.deepEqual(depFollow('finance.dep_preset', { dep_preset: 'sl_term', term: 25 }, 20), { dep_method: 'sl', dep_life: 25, dep_life_bess: 25 });
  assert.deepEqual(depFollow('finance.dep_preset', { dep_preset: 'sl_term' }, 20), { dep_method: 'sl', dep_life: 20, dep_life_bess: 20 });
});

test('editing method or life makes the preset custom, other keys do nothing', () => {
  assert.deepEqual(depFollow('finance.dep_method', { dep_preset: 'id_g2' }, 20), { dep_preset: 'custom' });
  assert.deepEqual(depFollow('finance.dep_life_bess', { dep_preset: 'id_g2' }, 20), { dep_preset: 'custom' });
  assert.equal(depFollow('finance.dep_preset', { dep_preset: 'custom' }, 20), null);
  assert.equal(depFollow('finance.tax_rate', {}, 20), null);
});

test('component edits: percent fields, stage 2 copy, bad numbers', () => {
  const c = newComponent();
  editComponent(c, 'v1', '0.2', false);
  assert.deepEqual([c.v1, c.v2], [0.2, 0.2]);
  editComponent(c, 'v1', '0.3', true);
  assert.deepEqual([c.v1, c.v2], [0.3, 0.2]);
  editComponent(c, 'idx', '2.5', true);
  assert.equal(c.idx, 0.025);
  editComponent(c, 'pct', 'abc', true);
  assert.equal(c.pct, 0);
  editComponent(c, 'name', 'F (BESS)', true);
  assert.equal(c.name, 'F (BESS)');
  assert.equal(pctText(0.0725), 7.25);
});

test('revenue card mode', () => {
  assert.equal(revenueMode({ model: 'host', tariff_mode: 'components' }), 'host');
  assert.equal(revenueMode({ model: 'tpo', tariff_mode: 'diesel_discount' }), 'discount');
  assert.equal(revenueMode({ model: 'ppa', tariff_mode: 'components' }), null);
});

test('haircut note only while the value still matches', () => {
  const P = { finance: { p90_factor: 0.93 }, resource_years: { applied: { p90_factor: 0.93, basis: 10, database: 'ERA5', from: 2010, to: 2019 } } };
  assert.match(p90Note(P), /^Revenue haircut 0.93: .*10-year average.*ERA5 2010–2019\)\.$/);
  P.finance.p90_factor = 0.9;
  assert.equal(p90Note(P), '');
  assert.equal(p90Note({ finance: { p90_factor: 1 } }), '');
});

test('rows differ for a host-owned plant', () => {
  const keys = (h) => finRows(h).filter((r) => r[0] !== 'g').map((r) => r[0]);
  assert.ok(!keys(true).includes('billed') && !keys(true).includes('host_saving'));
  assert.ok(keys(false).includes('billed') && keys(false).includes('host_saving'));
  assert.equal(finRows(true).find((r) => r[0] === 'tariff')[1], 'Avoided cost per kWh');
});

test('cash-flow CSV', () => {
  assert.equal(cashflowCsv(null), null);
  const R = { model: 'host', years: [{ year: 0, equity_cf: -1000.123456 }, { year: 1, equity_cf: 250, revenue: 300 }] };
  const lines = cashflowCsv(R).split('\n');
  assert.equal(lines[0], 'Item,Y0,Y1');
  assert.ok(lines.includes('"Equity cash flow (after tax)",-1000.1235,250'));
  assert.ok(lines.includes('"Avoided diesel cost",,300'));
  assert.ok(!lines.some((l) => l.includes('Energy billed')));
});
