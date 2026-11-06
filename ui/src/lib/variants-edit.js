// The edits of the variants of a project (P.variants), as plain functions of the project: each returns {changed, error?}, where error
// is the message to show when the edit is refused. variants.svelte.js applies them and tells the rest of the app; no store or page
// here, so ui/tests/variants.test.js runs this under Node.
import { MAX_VARIANTS, MAX_OVERRIDES, nextId, knob, getPath, startValue, validValue } from './variants.js';

const find = (P, id) => (P.variants || []).find((v) => v.id === id);
const full = { changed: false, error: `At most ${MAX_VARIANTS} variants.` };

export function newVariant(P) {
  const list = P.variants || (P.variants = []);
  if (list.length >= MAX_VARIANTS) return full;
  list.push({ id: nextId(list), name: 'Variant ' + (list.length + 1), overrides: {} });
  return { changed: true };
}
export function copyVariant(P, id) {
  const v = find(P, id);
  if (!v) return { changed: false };
  if (P.variants.length >= MAX_VARIANTS) return full;
  P.variants.splice(P.variants.indexOf(v) + 1, 0, { id: nextId(P.variants), name: (v.name + ' copy').slice(0, 40), overrides: { ...v.overrides } });
  return { changed: true };
}
export function dropVariant(P, id) {
  const n = (P.variants || []).length;
  P.variants = (P.variants || []).filter((v) => v.id !== id);
  return { changed: P.variants.length !== n };
}
// A blank name is refused: the variant keeps its own
export function renameVariant(P, id, name) {
  const v = find(P, id), n = String(name).trim().slice(0, 40);
  if (!v || !n || n === v.name) return { changed: false };
  v.name = n;
  return { changed: true };
}
// The variant takes this input, starting from the project's own value
export function takeSetting(P, id, key) {
  const v = find(P, id), f = knob(key);
  if (!v || !f || key in v.overrides) return { changed: false };
  if (Object.keys(v.overrides).length >= MAX_OVERRIDES) return { changed: false, error: `A variant changes at most ${MAX_OVERRIDES} settings.` };
  v.overrides[key] = startValue(f, getPath(P, key));
  return { changed: true };
}
export function changeSetting(P, id, key, value) {
  const v = find(P, id), f = knob(key);
  if (!v || !f || !(key in v.overrides) || !validValue(f, value)) return { changed: false };
  v.overrides[key] = value;
  return { changed: true };
}
export function dropSetting(P, id, key) {
  const v = find(P, id);
  if (!v || !(key in v.overrides)) return { changed: false };
  delete v.overrides[key];
  return { changed: true };
}

// The overrides of each case of a batch; fast: the first year, repeated (as for the operating options)
export const batchOverrides = (cases, fast) => cases.map((c) => ({ overrides: fast ? { ...c.overrides, 'sim.all_years': false } : c.overrides }));
