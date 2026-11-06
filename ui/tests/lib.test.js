// The interface's plain modules (node --test ui/tests/): schema field values and the Markdown parser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { display, parse as parseField, sliderRange, inputAttrs } from '../src/lib/field.js';
import { parse as parseMd, inline } from '../src/lib/markdown.js';
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
