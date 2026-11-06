// The Design variants page: the edits of P.variants, and the comparison run (W.VARIANTS, plain data kept raw). Pure parts are in
// variants.js, variants-edit.js and variants-view.js.
import { W } from './ws/state.js';
import { call } from './ipc.js';
import { toast } from './toast.js';
import { fnv1a } from './ws/diff.js';
import { engineProject, requireInputs } from './ws/core.js';
import { projectKey } from './ws/keys.js';
import { onFieldChange } from './ws/project.js';
import { variantCases } from './variants.js';
import { newVariant, copyVariant, dropVariant, renameVariant as renameVariantIn, takeSetting, changeSetting, dropSetting, batchOverrides } from './variants-edit.js';
import { changeLines } from './variants-view.js';

export const vs = $state({ rev: 0, busy: false, status: '', kind: '', fast: false });

// Fingerprint of what the comparison depends on: the engine inputs and the variants (their names too, which the table shows)
export const variantsKey = () => projectKey(engineProject({ name: '' })) + ':' + fnv1a(JSON.stringify(variantCases(W.P)));

// A new or reopened project: no comparison, no status text
export function reset() {
  W.VARIANTS = null;
  Object.assign(vs, { busy: false, status: '', kind: '' });
  vs.rev++;
}

const edited = () => { onFieldChange('variants'); vs.rev++; };
const apply = (r) => { if (r.error) toast(r.error, true); if (r.changed) edited(); };

export const addVariant = () => apply(newVariant(W.P));
export const duplicateVariant = (id) => apply(copyVariant(W.P, id));
export const removeVariant = (id) => apply(dropVariant(W.P, id));
export const renameVariant = (id, name) => apply(renameVariantIn(W.P, id, name));
export const addChange = (id, key) => apply(takeSetting(W.P, id, key));
export const setChange = (id, key, value) => apply(changeSetting(W.P, id, key, value));
export const removeChange = (id, key) => apply(dropSetting(W.P, id, key));

export async function runVariants() {
  if (vs.busy || !requireInputs()) return;
  const P = W.P, cases = variantCases(P);
  if (cases.length < 2) { Object.assign(vs, { status: 'Add a variant first.', kind: 'err' }); return; }
  const fast = vs.fast;
  Object.assign(vs, { busy: true, status: `Simulating ${cases.length} designs…`, kind: '' });
  try {
    // what each case changes, the run length and the key as they are now: the project may be edited while the run goes on
    const t0 = performance.now(), key = variantsKey(), changes = cases.map((c, i) => (i === 0 ? ['As set in the project'] : changeLines(P, c)));
    const yearOne = fast || !P.sim.all_years, years = P.econ.lifetime;
    const r = await call('batch', { body: { project: engineProject(), cases: batchOverrides(cases, fast) } });
    if (W.P !== P) return;   // another project was opened meanwhile
    W.VARIANTS = { key, fast: yearOne, rows: cases.map((c, i) => ({ id: c.id, name: c.name, changes: changes[i], res: r.results[i] })) };
    const failed = W.VARIANTS.rows.filter((x) => x.res.error).length;
    Object.assign(vs, { status: `✓ ${cases.length} designs simulated (${W.VARIANTS.fast ? 'year 1, repeated' : years + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s${failed ? `, ${failed} failed` : ''}`, kind: failed ? 'err' : 'ok' });
    vs.rev++;
  } catch (e) {
    Object.assign(vs, { status: e.message, kind: 'err' });
    toast(e.message, true);
  } finally {
    vs.busy = false;
  }
}
