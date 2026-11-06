// Design variants: the inputs a variant may change, cleaning of the saved variants, and the side-by-side figures of a comparison
// (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOBS, knob, knobGroups, validValue, startValue, cleanVariants, variantCases, nextId, getPath, MAX_VARIANTS, BASE_ID } from '../src/lib/variants.js';
import { showValue, variantView, changeLines, compareTable, costFig, supplyFig } from '../src/lib/variants-view.js';
import { migrateProject } from '../src/lib/migrate-project.js';
import { defaultProject } from '../src/lib/schema/index.js';

test('a variant can change the inputs the engine reads, and nothing the interface makes', () => {
  for (const k of ['bess.energy_kwh', 'pv.capacity_kwp', 'diesel.units', 'diesel.strategy', 'econ.fuel_price', 'pv.tilt', 'bess.provides_reserve', 'finance.gearing']) assert.ok(knob(k), k);
  for (const k of ['location.lat', 'load.target_avg', 'layout.modules_across', 'pv.mount_style', 'sim.all_years', 'econ.currency', 'pv.horizon', 'sched.api_key', 'optimizer.seed']) assert.equal(knob(k), null, k);
  assert.equal(new Set(KNOBS.map((x) => x.k)).size, KNOBS.length, 'each input once, though forms repeat some');
  assert.ok(KNOBS.every((x) => ['num', 'int', 'pct', 'sel', 'chk'].includes(x.t) && x.l && x.group));
  assert.ok(knobGroups().every(([name, list]) => name && list.length));
  assert.ok(KNOBS.length > 100);
});

test('values are checked against the input they are for', () => {
  const num = knob('bess.energy_kwh'), int = knob('diesel.units'), sel = knob('diesel.strategy'), chk = knob('bess.provides_reserve');
  assert.ok(validValue(num, 5000) && validValue(num, 0));
  for (const v of [NaN, Infinity, '5000', null, true, undefined]) assert.equal(validValue(num, v), false, String(v));
  assert.ok(validValue(int, 4) && !validValue(int, 1.5));
  assert.ok(validValue(sel, 'predictive') && !validValue(sel, 'nonsense') && !validValue(sel, 3));
  assert.ok(validValue(chk, true) && validValue(chk, false) && !validValue(chk, 1) && !validValue(chk, 'true'));
  const lim = { t: 'num', lim: [0, 10] };   // inputs with limits (none of the forms a variant may change has one yet)
  assert.ok(validValue(lim, 0) && validValue(lim, 10) && !validValue(lim, 10.5) && !validValue(lim, -1));
});

test('a variant starts from the project value when it is a valid one', () => {
  assert.equal(startValue(knob('bess.energy_kwh'), 4000), 4000);
  assert.equal(startValue(knob('diesel.strategy'), 'predictive'), 'predictive');
  assert.equal(startValue(knob('diesel.strategy'), undefined), 'load_following');
  assert.equal(startValue(knob('bess.provides_reserve'), undefined), false);
  assert.equal(startValue(knob('bess.energy_kwh'), null), 0);
});

test('cleanVariants keeps good variants and drops what the engine could not use', () => {
  const out = cleanVariants([
    { id: 'v1', name: '  Big battery  ', overrides: { 'bess.energy_kwh': 9000, 'bess.power_kw': 'lots', 'location.lat': 5, 'diesel.strategy': 'predictive', 'diesel.units': 2.5 } },
    { id: 'v1', name: '', overrides: {} }, null, 'text', 7,
    { id: 'zzz', name: 'x'.repeat(80), overrides: [1, 2] },
    { name: 'no id', overrides: { 'econ.fuel_price': 1.1 } },
  ]);
  assert.deepEqual(out.map((v) => v.id), ['v1', 'v2', 'v3', 'v4'], 'ids stay unique');
  assert.deepEqual(out[0], { id: 'v1', name: 'Big battery', overrides: { 'bess.energy_kwh': 9000, 'diesel.strategy': 'predictive' } });
  assert.equal(out[1].name, 'Variant 2');
  assert.equal(out[2].name.length, 40);
  assert.deepEqual(out[2].overrides, {});
  assert.deepEqual(out[3].overrides, { 'econ.fuel_price': 1.1 });
  assert.deepEqual(cleanVariants(undefined), []);
  assert.deepEqual(cleanVariants({ id: 'v1' }), []);
  assert.equal(cleanVariants(Array.from({ length: 30 }, () => ({ overrides: {} }))).length, MAX_VARIANTS);
  assert.equal(nextId([{ id: 'v1' }, { id: 'v3' }]), 'v2');
});

test('a project file keeps its variants cleaned, and a new project has none', () => {
  const P = { name: 'x', variants: [{ id: 'v1', name: 'A', overrides: { 'bess.energy_kwh': 1, 'bogus.key': 2 } }, { id: 'v9', overrides: { 'pv.capacity_kwp': -1e9 } }] };
  migrateProject(P, () => null);   // changes the project in place
  assert.deepEqual(P.variants.map((v) => v.name), ['A', 'Variant 2']);
  assert.deepEqual(P.variants[0].overrides, { 'bess.energy_kwh': 1 });
  const none = { name: 'y' };
  migrateProject(none, () => null);
  assert.deepEqual(none.variants, []);
  assert.deepEqual(defaultProject().variants, []);
});

test('the cases of a comparison are the project as it is, then each variant', () => {
  const P = { variants: [{ id: 'v1', name: 'A', overrides: { 'bess.energy_kwh': 1 } }] };
  const cases = variantCases(P);
  assert.deepEqual(cases.map((c) => c.id), [BASE_ID, 'v1']);
  assert.deepEqual(cases[0].overrides, {});
  cases[1].overrides['x'] = 1;
  assert.deepEqual(Object.keys(P.variants[0].overrides), ['bess.energy_kwh'], 'a case is a copy');
  assert.equal(variantCases({}).length, 1);
});

const proj = (extra = {}) => ({ econ: { currency: 'USD' }, bess: { energy_kwh: 4000, power_kw: 2000 }, diesel: { strategy: 'load_following', units: 3 }, pv: { capacity_kwp: 3000 },
  optimizer: { max_unmet: 0.001, min_re: 0, max_curtail: 1, max_lole_h: -1, max_reserve_short_h: -1, max_pv_kwp: 0, max_capex: 0 }, variants: [], ...extra });

test('values and changes read as text with their unit', () => {
  const P = proj();
  assert.equal(showValue(knob('bess.energy_kwh'), 8000), '8000 kWh');
  assert.notEqual(showValue(knob('diesel.strategy'), 'cycle_charging'), 'cycle_charging', 'the label of the choice, not its code');
  assert.equal(showValue(knob('bess.provides_reserve'), true), 'on');
  assert.equal(getPath(P, 'bess.energy_kwh'), 4000);
  assert.equal(getPath(P, 'bess.nope.deeper'), undefined);
  const v = { id: 'v1', name: 'A', overrides: { 'bess.energy_kwh': 8000, 'diesel.units': 2, 'location.lat': 5 } };
  assert.equal(changeLines(P, v)[0], 'Battery · Energy capacity: 8000 kWh, was 4000 kWh');
  assert.match(changeLines(P, v)[1], /, was 3$/);
  const view = variantView({ ...P, variants: [v] });
  assert.equal(view[0].rows.length, 2, 'an input that is no longer one a variant may change is not shown');
  assert.deepEqual(view[0].rows[0].base, 4000);
});

// a batch result as the engine returns it
const res = ({ npc, lcoe, capex = 1000, re = 0.5, unmet = 0, pv = 3000, bess = 4000, fuel = 200000, irr = 0.12 }) => ({
  result: { size: { pv_kwp: pv, bess_kwh: bess, bess_kw: 2000, wind_units: 0 }, re_fraction: re, unmet_fraction: unmet, unmet_fraction_max: unmet, curtail_fraction: 0.02,
    avg_gen_load: 0.6, bess_replacements: 1, fuel_l_y1: fuel,
    econ: { capex_pv: 300, capex_bess: 400, capex_wind: 0, capex_diesel: 100, capex_other: 200, capex_total: capex, npc, lcoe },
    years: [{ fuel_l: fuel, unit_hours: 5000, starts: 300, bess_efc: 250, co2_t: 520, pv_to_load: 4e6, wind_to_load: 0, bess_dis: 1e6, gen_to_load: 3e6, unmet: unmet * 1e6 }] },
  comparison: { npv_savings: 5000, irr }, finance: { equity_irr: 0.15 },
});

test('the side-by-side table marks the best value of each row and the change against the current design', () => {
  const P = proj({ variants: [{ id: 'v1', name: 'More battery', overrides: { 'bess.energy_kwh': 8000 } }, { id: 'v2', name: 'Gensets only', overrides: { 'pv.capacity_kwp': 0 } }] });
  const V = { rows: [{ id: 'base', name: 'Current design', res: res({ npc: 10000, lcoe: 0.2 }) }, { id: 'v1', name: 'More battery', res: res({ npc: 9000, lcoe: 0.18, bess: 8000, re: 0.6 }) },
    { id: 'v2', name: 'Gensets only', res: { error: 'PV capacity must be positive' } }] };
  const T = compareTable(P, V, 'USD');
  assert.deepEqual(T.heads, ['Current design', 'More battery', 'Gensets only']);
  assert.deepEqual(T.changes[0], ['As set in the project']);
  assert.deepEqual(T.changes[1], ['Battery · Energy capacity: 8000 kWh, was 4000 kWh']);
  const row = (label) => T.rows.find((r) => r.label.startsWith(label));
  assert.equal(row('Net present cost,').best, 1);
  assert.deepEqual(row('Net present cost,').cells, ['10,000', '9,000', '–']);
  assert.equal(row('Renewable share').best, 1);
  assert.equal(row('PV capacity').best, -1, 'a size is not better or worse');
  assert.equal(row('Net present cost against').cells[1], '−10.0 %');
  const close = compareTable(P, { rows: [V.rows[0], { id: 'v1', name: 'x', res: res({ npc: 9990, lcoe: 0.2 }) }] }, 'USD');
  assert.equal(close.rows.find((r) => r.label.startsWith('Net present cost against')).cells[1], '−0.1 %, within model accuracy');
  assert.equal(row('Net present cost against').cells[0], '–');
  assert.equal(row('LCOE against').cells[1], '−10.0 %');
  assert.ok(T.notes.some((n) => n.startsWith('Gensets only: PV capacity must be positive')));
});

test('a case that breaks the optimiser constraints is never the best, and equal values mark nobody', () => {
  const P = proj();
  const V = { rows: [{ id: 'base', name: 'A', res: res({ npc: 10000, lcoe: 0.2 }) }, { id: 'v1', name: 'B', res: res({ npc: 7000, lcoe: 0.1, unmet: 0.05 }) }] };
  const T = compareTable(P, V, 'USD');
  assert.equal(T.rows.find((r) => r.label.startsWith('Net present cost,')).best, -1, 'one case left: nothing to pick');
  assert.ok(T.notes.some((n) => /B breaks the optimiser constraint on unmet load/.test(n)));
  const same = compareTable(P, { rows: [{ id: 'base', name: 'A', res: res({ npc: 5, lcoe: 0.2 }) }, { id: 'v1', name: 'B', res: res({ npc: 5, lcoe: 0.2 }) }] }, 'USD');
  assert.equal(same.rows.find((r) => r.label.startsWith('Net present cost,')).best, -1);
});

test('the charts take one bar per case and leave a failed case empty', () => {
  const c = { pv: 'a', bess: 'b', wind: 'c', gen: 'd', unmet: 'e', muted: 'f', text2: 'g' };
  const V = { rows: [{ id: 'base', name: 'A', res: res({ npc: 10000, lcoe: 0.2, capex: 1000 }) }, { id: 'v1', name: 'B', res: { error: 'x' } }] };
  const cost = costFig({ econ: { currency: 'USD' } }, V, c), supply = supplyFig(V, c);
  assert.equal(cost.layout.barmode, 'stack');
  assert.ok(cost.traces.every((t) => t.x.length === 2 && t.y.length === 2 && t.y[1] === null));
  assert.equal(cost.traces.at(-1).y[0], 9000, 'everything after construction: NPC less capex');
  assert.equal(supply.traces[0].y[0], 4000, 'PV to load in MWh');
  assert.ok(supply.traces.every((t) => t.y[1] === null));
});
