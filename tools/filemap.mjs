// Writes docs/FILES.md: every source file with the first line of its header comment, so a reader (or a coding session) can
// find the file for a task without searching. `node tools/filemap.mjs --check` fails when the map is out of date (Check workflow).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'docs/FILES.md';
const GLOBS = ['engine/src/*.rs', 'src-tauri/src/*.rs', 'ui/src/*.js', 'ui/src/*.svelte', 'ui/src/*.ts', 'packaging/*.sh', 'packaging/*.py', 'tools/*.mjs'];
const AREAS = [['engine/', 'Engine (Rust)'], ['src-tauri/', 'Desktop shell (Tauri)'], ['ui/src/lib/', 'Interface logic (ui/src/lib)'],
  ['ui/src/screens/', 'Interface screens (ui/src/screens)'], ['ui/src/', 'Interface entry (ui/src)'], ['packaging/', 'Packaging'], ['tools/', 'Tools']];

// The first sentence of the file's header comment (//!, //, #, <!-- --> or a Python docstring), at most 120 characters.
// The header is the first comment block within the first lines; imports and shebangs before it are skipped.
const DOC = '"""';
function headerOf(file) {
  const text = [];
  for (const raw of readFileSync(file, 'utf8').split('\n').slice(0, 12)) {
    const ln = raw.trim(), doc = text.length && text.doc;
    const m = doc ? [ln, ln.replace(DOC, '')] : ln.match(/^\/\/!?\s?(.*)$/) || ln.match(/^<!--\s*(.*?)\s*(-->)?$/)
      || (!ln.startsWith('#!') && ln.match(/^#\s(.*)$/)) || (ln.startsWith(DOC) && [ln, ln.slice(3).replace(DOC, '')]);
    if (m && !/^(eslint|@ts-)/.test(m[1])) { text.push(m[1].replace(/\s*-->$/, '')); if (ln.startsWith(DOC)) text.doc = true; }
    else if (text.length) break;
    const docEnd = text.doc && ln.endsWith(DOC) && (text.length > 1 || ln.length > 3);
    if (ln.endsWith('-->') || docEnd) break;
  }
  const all = text.join(' ').replace(/\s+/g, ' ').trim();
  const first = (all.match(/^.*?[.:;](?=\s|$)/) || [all])[0].replace(/[:;]$/, '.');
  return first.length > 120 ? first.slice(0, first.lastIndexOf(' ', 117)) + '...' : first;
}

const files = execFileSync('git', ['ls-files', ...GLOBS], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const lines = ['# Source files', '', 'One line per file: what it is for. Generated from the first line of each header comment by',
  '`node tools/filemap.mjs`; do not edit by hand.', ''];
const missing = [];
for (const [prefix, title] of AREAS) {
  const mine = files.filter((f) => f.startsWith(prefix) && !AREAS.some(([p]) => p !== prefix && p.startsWith(prefix) && f.startsWith(p)));
  if (!mine.length) continue;
  lines.push(`## ${title}`, '');
  for (const f of mine) {
    const h = headerOf(f);
    if (!h) missing.push(f);
    lines.push(`- \`${f}\`: ${h || '(no header comment)'}`);
  }
  lines.push('');
}
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  let old = '';
  try { old = readFileSync(OUT, 'utf8'); } catch { /* not written yet */ }
  if (old !== text || missing.length) {
    console.error(missing.length ? `No header comment: ${missing.join(', ')}` : `${OUT} is out of date: run node tools/filemap.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`${OUT}: ${files.length} files${missing.length ? `; no header comment: ${missing.join(', ')}` : ''}`);
}
