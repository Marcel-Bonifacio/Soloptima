// Questions in the app's own dialog (lib/ask.js), the window's content policy and the frames (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, setAsker } from '../src/lib/ask.js';
import { toKML } from '../src/lib/layout/geodata.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(js|svelte)$/.test(n) ? [p] : [];
});
const SRC = files(join(ROOT, 'ui', 'src')).map((p) => [p.slice(ROOT.length + 1), readFileSync(p, 'utf8')]);

test('ask: no dialog means no, so nothing is deleted unseen', async () => {
  setAsker(null);
  assert.equal(await ask('Delete?', 'Delete'), false);
});

test('ask: the dialog gets the question and its answer comes back', async () => {
  const seen = [];
  setAsker((text, yes) => { seen.push([text, yes]); return Promise.resolve(yes === 'Delete'); });
  assert.equal(await ask('Delete this datasheet?', 'Delete'), true);
  assert.equal(await ask('Something else?'), false);
  assert.deepEqual(seen, [['Delete this datasheet?', 'Delete'], ['Something else?', 'OK']]);
  setAsker(null);
});

test('no screen uses confirm(), alert() or prompt(): the macOS web view answers them Cancel without a dialog', () => {
  const bad = SRC.flatMap(([p, s]) => s.split('\n').map((l, i) => [p, i + 1, l]))
    .filter(([, , l]) => /(^|[^\w.$])(window\.)?(confirm|alert|prompt)\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
    .map(([p, n, l]) => `${p}:${n}: ${l.trim()}`);
  assert.deepEqual(bad, []);
});

test('content policy: scripts from the app only; eval is allowed for the console Run', () => {
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const dirs = Object.fromEntries(conf.app.security.csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dirs['script-src'], ["'self'", "'unsafe-eval'"]);
  assert.deepEqual(dirs['object-src'], ["'none'"]);
  assert.deepEqual(dirs['frame-src'], ['https://www.google.com']);
  // the console compiles the user's script only inside run(), which only the Run button and Ctrl+Enter call
  const con = SRC.find(([p]) => p.endsWith('lib/console/console.svelte.js'))[1];
  assert.match(con, /export async function run\(\)[\s\S]*new AsyncFn\(/);
  const runners = SRC.filter(([, s]) => /\brun\b/.test(s) && /console\.svelte\.js/.test(s)).map(([p]) => p);
  assert.deepEqual(runners, ['ui/src/screens/console/ConsolePage.svelte']);
});

test('every frame is sandboxed; the report preview runs no script', () => {
  const frames = SRC.flatMap(([p, s]) => (s.match(/<iframe[^>]*>/g) || []).map((t) => [p, t]));
  assert.ok(frames.length >= 2);
  for (const [p, t] of frames) assert.match(t, /\ssandbox=/, `${p}: ${t}`);
  const report = frames.find(([p]) => p.endsWith('ReportPage.svelte'))[1];
  assert.match(report, /\ssandbox=""/);
});

test('KML export writes coordinates as numbers, so text in a project cannot change the document', () => {
  const kml = toKML({ polygons: [{ type: 'site', latlngs: [['1</coordinates><x>', '2'], [3, 4], [5, 6]] }, { type: 'obstacle', kind: 'tree', center: [7, '8<y/>'] }] }, 'T');
  assert.doesNotMatch(kml, /<x>|<y\/>/);
  assert.match(kml, /<coordinates>2,NaN,0 4,3,0 6,5,0 2,NaN,0<\/coordinates>/);
  assert.match(kml, /<coordinates>NaN,7,0<\/coordinates>/);
});
