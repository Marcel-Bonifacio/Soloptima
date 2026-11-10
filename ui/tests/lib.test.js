// The interface's plain modules (node --test ui/tests/): schema field values and the Markdown parser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { display, parse as parseField, sliderRange, inputAttrs } from '../src/lib/field.js';
import { parse as parseMd, inline } from '../src/lib/markdown.js';
import { migrateForms, numList } from '../src/lib/migrate.js';
import { welcomeLine } from '../src/lib/welcome.js';

test('field values: shown and parsed as the old forms did', () => {
  const pct = { k: 'pv.soiling', l: 'Soiling', t: 'pct', lim: [0, 0.5] };
  assert.equal(display(pct, 0.02), '2');
  assert.deepEqual(parseField(pct, '3'), { v: 0.03 });
  assert.match(parseField(pct, '80').error, /between 0 and 0.5/);
  const int = { k: 'weather_ui.year', l: 'Year', t: 'int' };
  assert.deepEqual(parseField(int, '2020.6'), { v: 2021 });
  assert.deepEqual(parseField(int, ''), {});
  assert.deepEqual(parseField({ k: 'a', l: 'A', t: 'num', ph: 'none' }, ' '), { v: null });
  assert.deepEqual(parseField({ k: 'a', l: 'A', t: 'chk' }, true), { v: true });
  const list = { k: 'pv.soiling_monthly', l: 'Monthly soiling', t: 'list', n: [12, 12], pct: true, lim: [0, 50], u: '%' };
  assert.match(parseField(list, '1, 2').error, /give 12 values in %/);
  assert.equal(parseField(list, Array(12).fill('2').join(' ')).v[0], 0.02);
  assert.equal(display(list, [0.02, 0.03]), '2, 3');
  assert.deepEqual(inputAttrs({ t: 'num', lim: [0, 9] }), { type: 'number', step: 'any', min: 0, max: 9 });
  assert.deepEqual(sliderRange({ k: 'pv.tilt', t: 'num', sl: [0, 45, 1] }, 10), { min: 0, max: 45, step: 1, x: 10 });
  assert.equal(sliderRange({ k: 'econ.fuel_price', t: 'num', sl: [0, 3, 0.01] }, 15000).max, 45000);
});

test('markdown: blocks and inline tokens, markup kept as text', () => {
  const b = parseMd('# Title\n\nVersion 1.2\n\n- a **b**\n  more\n- <script>x</script>\n\n| h |\n|---|\n| c |\n\n```\n<i>\n```');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'list', 'table', 'code']);
  assert.equal(b[0].id, 'md-title');
  assert.deepEqual(b[2].items[0][0], [{ t: 'text', text: 'a ' }, { t: 'b', text: 'b' }]);
  assert.deepEqual(b[2].items[1][0], [{ t: 'text', text: '<script>x</script>' }]);
  assert.equal(b[4].text, '<i>');
  assert.deepEqual(inline('[x](javascript:alert(1))'), [{ t: 'text', text: '[x](javascript:alert(1))' }]);
  assert.deepEqual(inline('see <https://a.org/x>'), [{ t: 'text', text: 'see ' }, { t: 'link', text: 'https://a.org/x', href: 'https://a.org/x' }]);
  assert.deepEqual(inline('[go](#terms)'), [{ t: 'jump', text: 'go', href: 'terms' }]);
});

test('welcome line: stable per profile and day, changes the next day', () => {
  const d = new Date(2026, 10, 6);
  assert.equal(welcomeLine('abc', d), welcomeLine('abc', d));
  assert.notEqual(welcomeLine('abc', d), welcomeLine('abc', new Date(2026, 10, 7)));
});

test('migrate: older files get the models they were made with, new inputs and clean lists', () => {
  const d = {
    defaults: () => ({ pv: { thermal_model: 'uc_uv', tilt: 10 }, load: { template: 'flat' }, econ: { currency: 'USD', fuel_price: 1 }, location: {}, site_records: { monthly_fuel_l: null } }),
    siteZone: () => ({ tz: 'Asia/Makassar', std: 8 }), mountStyleOf: () => 'open_rack', loadTemplates: { flat: 1 }, months: Array(12).fill('m'),
  };
  const p = { pv: { thermal_model: 'x', soiling_monthly: [1, 2], horizon: [0, 1, 2, 3] }, load: { template: 'gone' }, econ: { currency: 'U<S>D' },
    location: { lat: -8, lon: 120, utc_offset: null }, site_records: { monthly_fuel_l: [5, 0, 'a'] } };
  migrateForms(p, d);
  assert.equal(p.pv.transposition, 'hay_davies');
  assert.equal(p.pv.tilt, 10);
  assert.equal(p.pv.thermal_model, 'uc_uv');
  assert.equal(p.pv.soiling_monthly, null);
  assert.deepEqual(p.pv.horizon, [0, 1, 2, 3]);
  assert.equal(p.econ.currency, 'USD');
  assert.equal(p.location.utc_offset, 8);
  assert.equal(p.location.utc_offset_src, 'zone');
  assert.equal(p.load.template, 'custom');
  assert.deepEqual(p.site_records.monthly_fuel_l.slice(0, 3), [5, null, null]);
  assert.equal(numList([0.5], 1, 1, 0, 1)[0], 0.5);
});

test('grid lists: a tariff of 24 or 288 prices and a pattern of 24 values, on open and in the field', () => {
  const d = {
    defaults: () => ({ pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, location: {}, site_records: { monthly_fuel_l: null },
      grid: { enabled: false, tou: null, pattern: null } }),
    siteZone: () => null, mountStyleOf: () => 'open_rack', loadTemplates: { flat: 1 }, months: Array(12).fill('m'),
  };
  const p = { pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, location: { lat: 0, lon: 0, utc_offset: 0 }, site_records: {},
    grid: { enabled: true, tou: Array(100).fill(0.1), pattern: Array(24).fill(1) } };
  migrateForms(p, d);
  assert.equal(p.grid.tou, null);
  assert.equal(p.grid.pattern.length, 24);
  const q = { location: { lat: 0, lon: 0, utc_offset: 0 }, pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, site_records: {} };
  migrateForms(q, d);
  assert.equal(q.grid.enabled, false);
  const f = { k: 'grid.tou', l: 'Tariff', t: 'list', n: [24, 288], only: [24, 288], lim: [-10, 1e6] };
  assert.match(parseField(f, Array(48).fill('0.1').join(',')).error, /24 or 288 values/);
  assert.equal(parseField(f, Array(24).fill('0.1').join(',')).v.length, 24);
});

test('genset groups on open: bad entries dropped, values cleaned, at most 8', () => {
  const d = {
    defaults: () => ({ pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, location: {}, site_records: { monthly_fuel_l: null }, diesel: { more_groups: [] } }),
    siteZone: () => null, mountStyleOf: () => 'open_rack', loadTemplates: { flat: 1 }, months: Array(12).fill('m'),
  };
  const groups = [{ name: '<b>x</b>', units: 2.4, unit_kw: 300, min_load: 2, fuel_curve: [[0.5, 'a']] }, { units: 1, unit_kw: 0 }, 'junk', ...Array(10).fill({ units: 1, unit_kw: 100 })];
  const p = { pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, location: { lat: 0, lon: 0, utc_offset: 0 }, site_records: {},
    diesel: { min_load: 0.3, more_groups: groups } };
  migrateForms(p, d);
  const g = p.diesel.more_groups;
  assert.equal(g.length, 8);
  assert.deepEqual([g[0].name, g[0].units, g[0].min_load, g[0].fuel_curve, g[0].om_kwh], ['bx/b', 2, 0.3, null, null]);
  const q = { pv: {}, load: { template: 'flat' }, econ: { currency: 'USD' }, location: { lat: 0, lon: 0, utc_offset: 0 }, site_records: {}, diesel: {} };
  migrateForms(q, d);
  assert.deepEqual(q.diesel.more_groups, []);
});
