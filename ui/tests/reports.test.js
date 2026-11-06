// The documents of the bug reports (lib/reports/doc.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureOf, appFrame, sourceOf, toMarkdown, redact, issueUrl, repoName } from '../src/lib/reports/doc.js';

test('signature: numbers never matter, quoted text only for engine responses', () => {
  assert.equal(signatureOf('Failed at 12 of 40', 'a.js:3', true), signatureOf('Failed at 99 of 7', 'a.js:3', true));
  assert.equal(signatureOf('no "x"', 'w', false), signatureOf('no "y"', 'w', false));
  assert.notEqual(signatureOf('no "x"', 'w', true), signatureOf('no "y"', 'w', true));
  assert.notEqual(signatureOf('m', 'a.js:1', true), signatureOf('m', 'b.js:1', true));
});

test('appFrame: the first frame outside the skipped files', () => {
  const st = 'Error: x\n    at f (http://x/ipc.js:5:3)\n    at g (http://x/app.js:42:9)';
  assert.equal(appFrame(st, ['ipc.js']), 'app.js:42');
  assert.equal(appFrame('', []), '');
});

const r = { id: 'SOL-0001', kind: 'bug', status: 'new', severity: 'high', title: 'Stops | at 40 %', reporter: 'Ann', description: 'Opened /Users/ann/data/x\n```\nopen', created: '2026-11-06T10:00:00Z',
  context: { app_version: '2.0', project: 'My Farm', project_id: 'p123456' }, history: [{ time: '2026-11-06T10:00:00Z', text: 'Reported.\nTwo' }], project: {} };

test('markdown: the full copy has the reporter, project and history; an open fence is closed', () => {
  const md = toMarkdown(r, false);
  assert.match(md, /Reported by \| Ann/);
  assert.match(md, /My Farm \(p123456\)/);
  assert.match(md, /## History/);
  assert.equal((md.match(/^```/gm) || []).length % 2, 0);
});

test('markdown: the public copy leaves out the reporter, project, history and local names', () => {
  const md = toMarkdown(r, true, { user: { id: 'u1', name: 'Ann' } });
  assert.doesNotMatch(md, /Ann|My Farm|p123456|History|\/Users\/ann/);
  assert.match(md, /~\/data\/x/);
});

test('redact: paths and names of the machine', () => {
  const ctx = { info: { reports_dir: '/Users/bob/Soloptima/reports' }, user: { id: 'abcdef', name: 'Bob Stone' } };
  assert.equal(redact('see /Users/bob/Soloptima/reports/SOL-1.json', ctx), 'see <reports>/SOL-1.json');
  assert.equal(redact('hello Bob Stone, abcdef', ctx), 'hello <profile>, <profile>');
  assert.equal(redact('C:\\Users\\Bob\\x', {}), '~\\x');
});

test('GitHub issue: the address, the clipboard for a long body, and the repository name', () => {
  assert.equal(issueUrl('a/b', 't', 'body').clipboard, false);
  assert.equal(issueUrl('a/b', 't', 'x'.repeat(8000)).clipboard, true);
  assert.equal(repoName('https://github.com/acme/soloptima.git/'), 'acme/soloptima');
  assert.equal(repoName('nonsense'), null);
  assert.equal(repoName(' '), '');
});

test('source: a bundle line maps back to its module and code line', async () => {
  const bundle = ['import x;', '// src/lib/ws/state.js', 'const W = {};', '// src/lib/tsimport.svelte.js', 'function fixWeather() {', '  const wx = W.P.weather;', '}'].join('\n');
  const read = async (path) => (path === '/ui/app.js' ? bundle : '');
  const stack = 'TypeError: x\n    at fixWeather (tauri://localhost/ui/app.js:6:20)\n    at fixWeather (tauri://localhost/ui/app.js:6:20)\nfn@http://tauri.localhost/ui/app.js:3:1\n    at native';
  assert.equal(await sourceOf(stack, read), 'src/lib/tsimport.svelte.js: const wx = W.P.weather;\nsrc/lib/ws/state.js: const W = {};');
  assert.equal(await sourceOf('', read), '');
});
