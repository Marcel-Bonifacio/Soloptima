// The script console's numeric library and printing (plain modules)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M } from '../src/lib/console/numeric.js';
import { fmtVal, tableCells, csvText } from '../src/lib/console/format.js';
import { parseCSV, csvSplit, csvDelimOf } from '../src/lib/csv.js';

const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('vectors and statistics', () => {
  assert.deepEqual(M.linspace(0, 1, 3), [0, 0.5, 1]);
  assert.deepEqual(M.colon(1, 2, 7), [1, 3, 5, 7]);
  assert.equal(M.mean([1, 2, 3, 4]), 2.5);
  assert.equal(M.median([5, 1, 3]), 3);
  close(M.std([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
  assert.deepEqual(M.cumsum([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(M.sort([3, 1, 2], 'descend'), [3, 2, 1]);
  assert.equal(M.prctile([1, 2, 3, 4, 5], 50), 3);
  assert.deepEqual(M.histcounts([1, 2, 2, 3], [0, 2, 4]), [1, 3]);
});

test('element-wise operations broadcast and refuse a size mismatch', () => {
  assert.deepEqual(M.add([1, 2], 1), [2, 3]);
  assert.deepEqual(M.mul([1, 2], [3, 4]), [3, 8]);
  assert.throws(() => M.add([1], [1, 2]), /Size mismatch/);
});

test('linear algebra and fitting', () => {
  assert.deepEqual(M.mldivide([[2, 0], [0, 4]], [2, 4]), [1, 1]);
  assert.throws(() => M.mldivide([[1, 2], [2, 4]], [1, 2]), /singular/);
  const p = M.polyfit([0, 1, 2, 3], [1, 3, 7, 13], 2);
  close(p[0], 1, 1e-6); close(p[1], 1, 1e-6); close(p[2], 1, 1e-6);
  close(M.polyval(p, 4), 21, 1e-6);
  close(M.interp1([0, 10], [0, 100], 2.5), 25);
  close(M.trapz([0, 1, 2], [0, 1, 2]), 2);
  assert.deepEqual(M.transpose([[1, 2], [3, 4]]), [[1, 3], [2, 4]]);
});

test('energy helpers', () => {
  const a = new Array(8760).fill(1);
  assert.equal(M.monthly(a)[0], 744);
  assert.equal(M.daily(a).length, 365);
  assert.equal(M.monthly(a, 'mean')[1], 1);
});

test('printing: numbers, long arrays, tables, CSV', () => {
  assert.equal(fmtVal(3), '3');
  assert.equal(fmtVal(0.123456789), '0.123457');
  assert.equal(fmtVal(123456.7), '1.2346e+5');
  assert.match(fmtVal(Array.from({ length: 30 }, (_, i) => i)), /more …/);
  const t = tableCells([{ a: 1, b: '<b>x</b>' }]);
  assert.deepEqual(t, { cols: ['a', 'b'], rows: [['1', '<b>x</b>']] });   // text, never markup
  assert.equal(tableCells([]), null);
  assert.deepEqual(tableCells({ k: 2 }).rows, [['k', '2']]);
  assert.equal(csvText([{ a: 1, b: 2 }, { a: 3, b: 4 }]), 'a,b\n1,2\n3,4');
});

test('CSV text helpers', () => {
  assert.deepEqual(csvSplit('a,"b,c","d""e"', ','), ['a', 'b,c', 'd"e']);
  assert.equal(csvDelimOf(['a;b;c', '1;2;3']), ';');
  const { header, rows } = parseCSV('Time,Load\n1,2\n3,4\n');
  assert.deepEqual(header, ['time', 'load']);
  assert.deepEqual(rows, [['1', '2'], ['3', '4']]);
});
