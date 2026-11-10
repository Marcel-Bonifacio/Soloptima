// Every component a Svelte file uses in its markup is imported, declared or passed in: the build does not catch a missing
// import, the app then fails when the markup mounts (node --test ui/tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const files = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.svelte') ? [join(dir, e.name)] : []));

test('the components used in markup are imported or declared', () => {
  const missing = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, 'utf8');
    const script = (text.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).join('\n');
    const markup = text.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const [, name] of markup.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)) {
      // an import, a let or const (a component chosen at run time), a prop, or a {#snippet}/{#each}/{#await}/{@const} name
      const known = new RegExp(`\\b${name}\\b`).test(script) || new RegExp(`\\{[#@:][^}]*\\b${name}\\b`).test(markup);
      if (!known) missing.push(`${f.slice(SRC.length)}: <${name}>`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

// The page loads one stylesheet, web/style.css; a <style> block in a component would go to web/ui/app.css, which nothing
// loads, so its rules would silently not apply (as happened to the 3D view)
test('no component has a style block of its own', () => {
  const own = files(SRC).filter((f) => /<style[\s>]/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length));
  assert.deepEqual(own, []);
});
