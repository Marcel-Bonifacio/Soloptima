// The script console: the editor text, the saved scripts of the project and the Run. A script is the user's own JavaScript and
// runs only when Run is pressed (or Ctrl+Enter); it gets the numeric library, the functions of env.js and the workspace below.
import { M } from './numeric.js';
import { G } from './env.js';
import { print, disp, clearOutput, clearFigures } from './output.svelte.js';
import { EXAMPLES } from './examples.js';
import { storeGet, storeSet } from '../storage.js';
import { legacy } from '../legacy.js';
import { data } from '../results.svelte.js';
import { result as forecast } from '../forecast.svelte.js';
import { design } from '../equip/electrical.svelte.js';
import { queueSave } from '../projects.svelte.js';
import { MONTHS, HOURS } from '../series.js';

export const sc = $state({ code: storeGet('soloptima.script') || EXAMPLES['Load duration curve & statistics'], busy: false, saved: 0, naming: false });

export const saved = () => { sc.saved; const P = legacy.project(); return (P && P.scripts) || []; };   // no project before the workspace boots

export function open(i) { const s = saved()[i]; if (s) sc.code = s.code; }
export function example(name) { if (EXAMPLES[name]) sc.code = EXAMPLES[name]; }

export function save(name) {
  name = (name || '').trim();
  if (!name) return false;
  const P = legacy.project();
  P.scripts = (P.scripts || []).filter((s) => s.name !== name).concat([{ name, code: sc.code }]);
  queueSave();
  sc.saved++;
  return true;
}

export function clear() { clearOutput(); clearFigures(); }

const names = (env) => Object.keys(env).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

export async function run() {
  if (sc.busy) return;
  const code = sc.code, P = legacy.project();
  storeSet('soloptima.script', code);
  clearFigures();
  print(`» run ${new Date().toLocaleTimeString()}`, 'info');
  const sim = data.sim;
  const ws = { P, project: JSON.parse(JSON.stringify(P)), sim, opt: data.opt, hourly: sim ? sim.result.hourly : null, pvr: legacy.pvr(), forecast: forecast(),
    equipment: P.equipment, design: design(true), MONTHS, HOURS };
  const env = { ...M, ...G, ...ws }, ks = names(env), t0 = performance.now();
  sc.busy = true;
  try {
    const r = await new AsyncFn(...ks, '"use strict";\n' + code)(...ks.map((k) => env[k]));
    if (r !== undefined) disp(r);
    print(`done in ${((performance.now() - t0) / 1000).toFixed(2)} s`, 'info');
  } catch (e) {
    const m = (e.stack || '').match(/<anonymous>:(\d+):(\d+)/);
    print(`Error: ${e.message}${m ? `  (line ${+m[1] - 3})` : ''}`, 'err');
  }
  sc.busy = false;
}
