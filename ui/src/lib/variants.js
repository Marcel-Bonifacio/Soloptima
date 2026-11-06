// Design variants: the open project with some settings changed, kept by name in the project file (P.variants) and compared side
// by side (variants-view.js, variants.svelte.js). A variant holds only what it changes: {id, name, overrides: {dotted path: value}}.
// The comparison is one `batch` of the engine, each variant a case that overrides those paths. No page or store here, so
// ui/tests/variants.test.js runs this under Node.
import { FORMS } from './schema/index.js';

export const MAX_VARIANTS = 8;
export const MAX_OVERRIDES = 60;

// The forms whose inputs a variant may change: the ones the engine reads as they are. Site, load and layout inputs are made by the
// interface (the load profile, the PV tables), so changing them here would change nothing in the run.
const SECTIONS = [['pv-module', 'PV module'], ['pv-mount', 'PV mounting'], ['pv-loss', 'PV losses'], ['bess', 'Battery'], ['bess-age', 'Battery ageing'],
  ['wind', 'Wind'], ['aux', 'Auxiliary loads'], ['diesel', 'Diesel fleet'], ['control', 'Dispatch'], ['fuel', 'Fuel curve'], ['ems', 'Energy management'],
  ['econ-gen', 'Costs, general'], ['econ-cap', 'Costs, PV and battery'], ['econ-dg', 'Costs, diesel and emissions'],
  ['fin-cap', 'Finance, capital'], ['fin-debt', 'Finance, debt'], ['fin-op', 'Finance, operation']];
const SKIP = new Set(['pv.mount_style', 'sim.all_years', 'econ.currency']);   // the first sets other inputs in the interface only; the others are not a design choice
const KINDS = ['num', 'int', 'pct', 'sel', 'chk'];

// Every input a variant can change: {k (path), l (label), name (label with its group), u (unit), t, o, lim, step, ph (set for inputs that may be blank), group}
export const KNOBS = [];
const BY = Object.create(null);   // no inherited names: a file's "constructor" is not an input
for (const [id, group] of SECTIONS) {
  for (const f of FORMS[id] || []) {
    if (BY[f.k] || SKIP.has(f.k) || !KINDS.includes(f.t)) continue;
    BY[f.k] = { k: f.k, l: f.l, name: `${group} · ${f.l}`, u: f.u || '', t: f.t, o: f.o, lim: f.lim, step: f.step, ph: f.ph, group };
    KNOBS.push(BY[f.k]);
  }
}
export const knob = (k) => BY[k] || null;
// [[group name, knobs]] in the order of the forms
export const knobGroups = () => SECTIONS.map(([, name]) => [name, KNOBS.filter((x) => x.group === name)]).filter(([, a]) => a.length);

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Is v a value this input can take (numbers as the project stores them, percentages as fractions; null for an input that may be
// blank, which the engine then fills with its default)?
export function validValue(f, v) {
  if (v === null) return f.ph != null;
  if (f.t === 'chk') return typeof v === 'boolean';
  if (f.t === 'sel') return f.o.some(([x]) => x === v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (f.t === 'int' && !Number.isInteger(v)) return false;
  return !f.lim || (v >= f.lim[0] && v <= f.lim[1]);
}

// A value to start from when a variant takes an input: the project's own when it is a valid one, else the first the input allows
export function startValue(f, base) {
  if (base == null && f.ph != null) return null;   // blank in the project: the variant starts blank, with the engine's default
  if (validValue(f, base)) return base;
  if (f.t === 'chk') return false;
  if (f.t === 'sel') return f.o[0][0];
  return f.lim ? f.lim[0] : 0;
}

// The first free id v1, v2, ... in a list of variants
export function nextId(list) {
  const used = new Set(list.map((v) => v.id));
  for (let n = 1; ; n++) if (!used.has('v' + n)) return 'v' + n;
}

// The variants of a project file or a pasted copy: at most MAX_VARIANTS, each with a unique id, a name of up to 40 characters and
// only overrides of known inputs with values they can take.
export function cleanVariants(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_VARIANTS) break;
    if (!v || typeof v !== 'object') continue;
    const id = typeof v.id === 'string' && /^v\d{1,4}$/.test(v.id) && !out.some((x) => x.id === v.id) ? v.id : nextId(out);
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, 40) : '';
    const overrides = {};
    const src = v.overrides && typeof v.overrides === 'object' && !Array.isArray(v.overrides) ? v.overrides : {};
    for (const [k, val] of Object.entries(src)) {
      if (Object.keys(overrides).length >= MAX_OVERRIDES) break;
      if (BY[k] && validValue(BY[k], val)) overrides[k] = val;
    }
    out.push({ id, name: name || 'Variant ' + (out.length + 1), overrides });
  }
  return out;
}

export const BASE_ID = 'base';
// The cases of one comparison: the project as it is, then each variant: [{id, name, overrides}]
export function variantCases(P) {
  return [{ id: BASE_ID, name: 'Current design', overrides: {} }, ...(P.variants || []).map((v) => ({ id: v.id, name: v.name, overrides: { ...v.overrides } }))];
}
