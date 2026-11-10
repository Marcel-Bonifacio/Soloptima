// Project finance page: presets, depreciation follow-up, tariff component edits, table rows, CSV and the haircut note; debt periods,
// the other currency and the partnership flip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idTax, presetValues, depFollow, editComponent, newComponent, pctText, revenueMode, p90Note, finRows, cashflowCsv, PRESET_LIST, rowOpts, periodsCsv, periodName, MODELS } from '../src/lib/finance-view.js';
import { finTiles, periodTable, fxTable, finCharts } from '../src/lib/fin-view.js';
import { migrateForms } from '../src/lib/migrate.js';
import { defaultProject } from '../src/lib/schema/index.js';

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

test('the dollar loan preset follows the project currency, the term-sheet presets reset to a yearly loan', () => {
  const idr = presetValues('usd_loan', 'IDR');
  assert.deepEqual([idr.debt_periods, idr.fx_currency, idr.debt_fx, idr.fx_rate], ['4', 'USD', true, 15500]);
  const usd = presetValues('usd_loan', 'USD');
  assert.deepEqual([usd.debt_periods, usd.fx_currency, usd.debt_fx], ['4', '', undefined]);
  for (const id of ['generic', 'pln', 'lease', 'flip']) assert.deepEqual([presetValues(id, 'USD').debt_periods, presetValues(id, 'USD').fx_currency], ['1', '']);
  const f = presetValues('flip', 'USD');
  assert.deepEqual([f.model, f.itc_pct, f.te_pre_tax, f.flip_trigger], ['flip', 0.3, 0.99, 'irr']);
  assert.ok(MODELS.some((m) => m[0] === 'flip'));
});

test('rows for another currency and the partnership flip', () => {
  const R = { model: 'flip', fx_currency: 'USD', years: [{ year: 0, fx_rate: 15500, fx_loss: 0 }] };
  const o = rowOpts(R);
  assert.deepEqual(o, { fx: true, fxDebt: true, flip: true, cur: 'USD' });
  const keys = finRows(false, o).filter((r) => r[0] !== 'g').map((r) => r[0]);
  for (const k of ['fx_rate', 'fx_loss', 'debt_balance_fx', 'te_cf', 'sponsor_cf', 'tax_credits']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('host_saving'));
  assert.equal(finRows(false, o).find((r) => r[0] === 'fx_rate')[1], 'Exchange rate (per USD)');
  assert.deepEqual(rowOpts({ model: 'ppa', years: [{ year: 0 }] }), { fx: false, fxDebt: false, flip: false, cur: '' });
  assert.ok(cashflowCsv(R).includes('"Investor cash flow (after tax)"'));
});

const PER = [{ period: 1, year: 1, month: 1, cfads: 100, interest: 10, principal: 20, debt_service: 30, debt_balance: 500, dsra: 15, dscr: 3.3333333 },
  { period: 2, year: 1, month: 7, cfads: 0, interest: 9, principal: 21, debt_service: 30, debt_balance: 480, dsra: 0, dscr: null }];

test('debt periods: table, CSV and names', () => {
  assert.equal(periodTable({ years: [] }), null);
  const T = periodTable({ periods: PER });
  assert.equal(T.heads.length, 10);
  assert.deepEqual([T.rows[0][9], T.rows[1][9]], ['3.33', '']);
  assert.equal(periodsCsv({}), null);
  const lines = periodsCsv({ periods: PER }).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].endsWith(',3.3333'));
  assert.deepEqual([periodName(2), periodName('4'), periodName(12), periodName(1)], ['half-year', 'quarter', 'month', 'year']);
});

test('the cover chart shows one bar per period, the tiles name the period', () => {
  const R = { model: 'ppa', periods: PER, years: [{ year: 0, equity_cf: -1 }, { year: 1, equity_cf: 1, dscr: 1.5 }], equity_cum: [-1, 0], project_cum: [-1, 0],
    metrics: { debt_periods: 2, dscr_min_period: 3.3333, dscr_min: 1.5, dscr_avg: 1.5, llcr: 2, term: 1 } };
  const P = { econ: { currency: 'USD', discount_rate: 0.08 }, finance: { dscr_target: 1.3, equity_discount: 0.12, te_target_irr: 0.07 } };
  const c = finCharts(R, P, {});
  assert.deepEqual(c.dscr.traces[0].x, [0]);
  assert.match(c.dscr.layout.xaxis.title.text, /half-year/);
  const t = finTiles(R, P).find((x) => /Minimum DSCR/.test(x[0]));
  assert.deepEqual([t[0], t[1]], ['Minimum DSCR per half-year', '3.33']);
});

test('exchange rate sensitivity table and the flip tiles', () => {
  const S = [-0.2, 0, 0.1].map((s) => ({ shock: s, fx_rate_y1: 15500 * (1 + s), equity_irr: 0.1 - s / 10, project_irr: 0.08, dscr_min: 1.3, equity_npv: 1000, sponsor_irr: 0.12, te_irr: 0.07 }));
  const P = { econ: { currency: 'IDR', discount_rate: 0.08 }, finance: { equity_discount: 0.12, te_target_irr: 0.07 } };
  assert.equal(fxTable({ model: 'ppa' }, P), null);
  const T = fxTable({ model: 'flip', fx_currency: 'USD', fx_sensitivity: S }, P);
  assert.equal(T.heads[1], 'Rate, year 1 (IDR per USD)');
  assert.ok(T.heads.includes('Sponsor IRR'));
  assert.deepEqual(T.rows.map((r) => [r.base, r.cells[0]]), [[false, '-20 %'], [true, '0 %'], [false, '+10 %']]);
  const R = { model: 'flip', fx_currency: 'USD', years: [], metrics: { sponsor_irr: 0.11, te_irr: 0.075, flip_year: 6, te_investment: 4e5, sponsor_investment: 6e5, sponsor_npv: 1,
    tax_credits_total: 3e5, itc: 3e5, fx_rate_cod: 15500, fx_rate_end: 20000, debt_in_fx: 1000, term: 20 } };
  const tiles = finTiles(R, P).map((t) => t[0]);
  assert.deepEqual(tiles.slice(0, 3), ['Sponsor IRR (after tax)', 'Investor IRR (after tax)', 'Flip']);
  assert.ok(tiles.includes('Exchange rate (IDR per USD)') && !tiles.includes('Host savings vs diesel'));
});

test('a file with bad finance lists and a bad debt period opens with safe values', () => {
  const p = defaultProject();
  Object.assign(p.finance, { fx_currency: '<b>USD"', cfads_months: [1, 2], fx_table: [15000, 'x'], debt_periods: 3 });
  migrateForms(p, { defaults: defaultProject, siteZone: () => null, mountStyleOf: () => 'open', loadTemplates: { custom: {} }, months: new Array(12).fill(0) });
  assert.deepEqual([p.finance.fx_currency, p.finance.cfads_months, p.finance.fx_table, p.finance.debt_periods], ['bUSD', null, null, '1']);
  const q = defaultProject();
  delete q.finance.debt_periods;
  q.finance.debt_periods = 4;
  migrateForms(q, { defaults: defaultProject, siteZone: () => null, mountStyleOf: () => 'open', loadTemplates: { custom: {} }, months: new Array(12).fill(0) });
  assert.equal(q.finance.debt_periods, '4');
});
