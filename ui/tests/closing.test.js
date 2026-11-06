// Closing with a field still being edited, the Cancel button of questions and the names of exported files (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFileName } from '../src/lib/filename.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, 'src', p), 'utf8');

test('safeFileName: invalid characters become one space, repeats collapse, ends are trimmed', () => {
  assert.equal(safeFileName('Plant: Phase 1'), 'Plant Phase 1');
  assert.equal(safeFileName('a/b\\c*d?e"f<g>h|i'), 'a b c d e f g h i');
  assert.equal(safeFileName('  x::  y  '), 'x y');
  assert.equal(safeFileName('Plant: A_results.xlsx'), 'Plant A_results.xlsx');
  assert.equal(safeFileName('...'), 'file');
  assert.equal(safeFileName(''), 'file');
});

test('every export goes through saveFile, which cleans the name once', () => {
  assert.match(src('lib/ipc.js'), /name = safeFileName\(name\)/);
  for (const f of ['lib/report.svelte.js', 'lib/equip/electrical.svelte.js', 'lib/ws/project.js', 'lib/layout/tools.svelte.js']) {
    assert.doesNotMatch(src(f), /replace\(\/\[\^\\w\\- \]\+\/g/, f + ' cleans the name itself');
  }
});

test('the question dialog has no header Close next to Cancel', () => {
  assert.match(src('screens/AskDialog.svelte'), /<Dialog[^]*?\bnoclose>/);
  assert.match(src('lib/Dialog.svelte'), /\{#if !noclose\}/);
});

test('closing or quitting commits the focused field before the save', async () => {
  const calls = [];
  globalThis.document = { body: {}, activeElement: { blur: () => calls.push('blur') } };
  const { commitFocusedField } = await import('../src/lib/projects.svelte.js').catch(() => ({}));
  if (commitFocusedField) { commitFocusedField(); assert.deepEqual(calls, ['blur']); }
  const p = src('lib/projects.svelte.js');
  assert.match(p, /export async function readyToClose\(\) \{\n  commitFocusedField\(\);/);
  assert.match(src('lib/session.svelte.js'), /beforeunload', \(e\) => \{ commitFocusedField\(\)/);
});
