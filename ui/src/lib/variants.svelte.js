// The Design variants page: the edits of P.variants, and the comparison run (W.VARIANTS, plain data kept raw). Pure parts are in
// variants.js and variants-view.js.
import { W } from './ws/state.js';
import { call } from './ipc.js';
import { toast } from './toast.js';
import { fnv1a } from './ws/diff.js';
import { engineProject, requireInputs } from './ws/core.js';
import { projectKey } from './ws/keys.js';
import { onFieldChange } from './ws/project.js';
import { MAX_VARIANTS, nextId, knob, getPath, startValue, validValue, variantCases } from './variants.js';

export const vs = $state({ rev: 0, busy: false, status: '', kind: '', fast: false });

// Fingerprint of what the comparison depends on: the engine inputs and the variants (their names too, which the table shows)
export const variantsKey = () => projectKey(engineProject({ name: '' })) + ':' + fnv1a(JSON.stringify(variantCases(W.P)));

// A new or reopened project: no comparison, no status text
export function reset() {
  W.VARIANTS = null;
  Object.assign(vs, { busy: false, status: '', kind: '' });
  vs.rev++;
}

const find = (id) => (W.P.variants || []).find((v) => v.id === id);
const edited = () => { onFieldChange('variants'); vs.rev++; };

export function addVariant() {
  const list = W.P.variants || (W.P.variants = []);
  if (list.length >= MAX_VARIANTS) { toast(`At most ${MAX_VARIANTS} variants.`, true); return; }
  list.push({ id: nextId(list), name: 'Variant ' + (list.length + 1), overrides: {} });
  edited();
}
export function duplicateVariant(id) {
  const v = find(id), list = W.P.variants;
  if (!v) return;
  if (list.length >= MAX_VARIANTS) { toast(`At most ${MAX_VARIANTS} variants.`, true); return; }
  list.splice(list.indexOf(v) + 1, 0, { id: nextId(list), name: (v.name + ' copy').slice(0, 40), overrides: { ...v.overrides } });
  edited();
}
export function removeVariant(id) {
  W.P.variants = (W.P.variants || []).filter((v) => v.id !== id);
  edited();
}
export function renameVariant(id, name) {
  const v = find(id), n = String(name).trim().slice(0, 40);
  if (v && n) { v.name = n; edited(); }
}
// The variant takes this input, starting from the project's own value
export function addChange(id, key) {
  const v = find(id), f = knob(key);
  if (!v || !f || key in v.overrides) return;
  v.overrides[key] = startValue(f, getPath(W.P, key));
  edited();
}
export function setChange(id, key, value) {
  const v = find(id), f = knob(key);
  if (!v || !f || !validValue(f, value)) return;
  v.overrides[key] = value;
  edited();
}
export function removeChange(id, key) {
  const v = find(id);
  if (!v) return;
  delete v.overrides[key];
  edited();
}

export async function runVariants() {
  if (vs.busy || !requireInputs()) return;
  const P = W.P, cases = variantCases(P);
  if (cases.length < 2) { Object.assign(vs, { status: 'Add a variant first.', kind: 'err' }); return; }
  const fast = vs.fast;
  Object.assign(vs, { busy: true, status: `Simulating ${cases.length} designs…`, kind: '' });
  try {
    const t0 = performance.now(), key = variantsKey();
    const r = await call('batch', { body: { project: engineProject(), cases: cases.map((c) => ({ overrides: fast ? { ...c.overrides, 'sim.all_years': false } : c.overrides })) } });
    if (W.P !== P) return;   // another project was opened meanwhile
    W.VARIANTS = { key, fast: fast || !P.sim.all_years, rows: cases.map((c, i) => ({ id: c.id, name: c.name, res: r.results[i] })) };
    const failed = W.VARIANTS.rows.filter((x) => x.res.error).length;
    Object.assign(vs, { status: `✓ ${cases.length} designs simulated (${W.VARIANTS.fast ? 'year 1, repeated' : P.econ.lifetime + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s${failed ? `, ${failed} failed` : ''}`, kind: failed ? 'err' : 'ok' });
    vs.rev++;
  } catch (e) {
    Object.assign(vs, { status: e.message, kind: 'err' });
    toast(e.message, true);
  } finally {
    vs.busy = false;
  }
}
