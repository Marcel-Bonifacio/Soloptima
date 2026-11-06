// Which inputs changed after a run: fingerprints of the project, snapshots and their differences.
import { fmtNum, fmtSig } from '../format.js';
import { sum } from '../series.js';
import { FORMS, PCT } from '../schema/index.js';
import { optionLabel } from './util.js';
import { W } from './state.js';

// ---------------------------------------------------------------- input snapshots: which inputs changed after a run
// FNV-1a hash of a string, in hex (projectKey fingerprints the engine project with it).
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
// Fingerprint of an engine project: its FNV-1a hash and length.
export function projectKey(p) {
  const s = JSON.stringify(p);
  return fnv1a(s) + ':' + s.length;
}
// Nested object as [path, value] rows. Arrays of up to 24 values become JSON text; longer ones are left out, or become long(array)
// when long is given.
export function flatten(o, pre = '', out = [], long) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, long);
    else if (!Array.isArray(v) || v.length <= 24) out.push([key, Array.isArray(v) ? JSON.stringify(v) : v]);
    else if (long) out.push([key, long(v)]);
  }
  return out;
}
// Engine inputs of a project as {path: value}, without the name (not an input of the results). Longer arrays (weather and load
// series) become {n, sum, h}: their length, sum and the hash of their JSON, so a run keeps a small copy of its inputs.
export function inputSnapshot(p) {
  const q = { ...p };
  delete q.name;
  return Object.fromEntries(flatten(q, '', [], (a) => {
    const s = a.every((x) => typeof x === 'number') ? sum(a) : null;
    return { n: a.length, sum: s == null ? null : +s.toPrecision(9), h: fnv1a(JSON.stringify(a)) };
  }));
}
// The input fields by project path (the first form that has the path) and the paths of each label, indexed on first use
// (FORMS is in schema.js and does not change).
let FIELDS = null;
function fieldIndex() {
  if (!FIELDS) {
    FIELDS = { byPath: new Map(), pathsOfLabel: new Map() };
    for (const fs of Object.values(FORMS)) for (const f of fs) {
      if (!FIELDS.byPath.has(f.k)) FIELDS.byPath.set(f.k, f);
      FIELDS.pathsOfLabel.set(f.l, (FIELDS.pathsOfLabel.get(f.l) || new Set()).add(f.k));
    }
  }
  return FIELDS;
}
// Input field of a project path in the input forms (any type), or null.
export function inputField(path) { return fieldIndex().byPath.get(path) || null; }
// Label of value v in a list of [value, label] options, or v itself.
// Labels of the engine inputs that have no input field (set by tables, cards, the weather download or import).
const PATH_LABELS = { 'finance.model': 'Finance model', 'finance.components': 'Tariff components', 'diesel.fuel_curve': 'Fuel curve',
  'pv.absorptance': 'Module absorptance', 'weather.source': 'Weather source', 'weather.ghi': 'Weather GHI', 'weather.dni': 'Weather DNI',
  'weather.dhi': 'Weather DHI', 'weather.tamb': 'Weather air temperature', 'weather.wind': 'Weather wind speed' };
// Label of a project path in change lists: its field's label (with the path when a field of another path has the same label), a
// label of PATH_LABELS, or the path.
function inputLabel(path) {
  if (path === 'load.kw') return 'Load';
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  if (path.startsWith('weather.')) return `Weather data (${path.slice(8)})`;
  const f = inputField(path);
  return !f ? path : fieldIndex().pathsOfLabel.get(f.l).size > 1 ? `${f.l} (${path})` : f.l;
}
// Two numbers as text that tells them apart: whole numbers without decimals, others to 3 significant digits, or more when those
// read the same. none stands for a missing value.
export function numPair(x, y, none = 'none') {
  const ok = (v) => typeof v === 'number' && isFinite(v), whole = [x, y].every((v) => !ok(v) || Number.isInteger(v));
  let f = (v) => (!ok(v) ? none : whole ? fmtNum(v) : fmtSig(v));
  if (ok(x) && ok(y) && x !== y && f(x) === f(y)) f = (v) => (!ok(v) ? none : String(+v.toPrecision(10)));
  return [f(x), f(y)];
}
// Inputs that differ between two snapshots (inputSnapshot), in the order of b: [{path, label, from, to, unit, series}]. from and to
// are the values as text in the units of the input field (options by their label, percentages in %), or the sums of a series
// (series: true); both are null when a text is too long to show or a series has no sum on one side.
const FIN_MODELS = { host: 'Host-owned', ppa: 'Single owner (PPA)', tpo: 'Third-party ownership' };   // as on the model cards
export function inputDiff(a, b) {
  a = a || {}; b = b || {};
  const isSeries = (v) => v != null && typeof v === 'object', out = [];
  for (const path of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const x = a[path], y = b[path];
    if (x === y || (Number.isNaN(x) && Number.isNaN(y)) || (isSeries(x) && isSeries(y) && x.h === y.h && x.n === y.n)) continue;
    const f = inputField(path), d = { path, label: inputLabel(path), from: null, to: null, unit: '', series: isSeries(x) || isSeries(y) };
    if (d.series) {
      if (isSeries(x) && isSeries(y) && x.sum != null && y.sum != null) [d.from, d.to] = numPair(x.sum, y.sum);
      if (path === 'load.kw') d.unit = 'kWh';
    } else if (path === 'finance.model') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : FIN_MODELS[v] || String(v)));
    else if (f && f.t === 'sel') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : String(optionLabel(f.o, v))));
    else if (typeof x === 'boolean' || typeof y === 'boolean') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : v ? 'yes' : 'no'));
    else if (typeof x === 'number' || typeof y === 'number') {
      const pct = !!f && f.t === PCT, n = (v) => (typeof v === 'number' && pct ? +(v * 100).toPrecision(12) : v);
      [d.from, d.to] = numPair(n(x), n(y), (f && f.ph) || 'none');
      // the unit after the pair ('1.00 to 1.10 USD/L'), or next to the number when the other side is a placeholder ('80 % to EOL')
      const u = !f || !f.u ? '' : f.u.startsWith('/') ? W.P.econ.currency + f.u : f.u, num = (v) => typeof v === 'number' && isFinite(v);
      if (u && !(num(x) && num(y))) { if (num(x)) d.from += ' ' + u; if (num(y)) d.to += ' ' + u; } else d.unit = u;
    } else {
      const t = [x, y].map((v) => (v == null ? 'none' : String(v)));
      if (t.every((s) => s.length <= 40)) [d.from, d.to] = t;
    }
    out.push(d);
  }
  return out;
}
// One change as text: 'Diesel price (delivered) 1.00 to 1.10 USD/L', 'Load changed (sum 8,760,000 to 9,198,000 kWh)'.
function diffText(d) {
  const u = d.unit ? ' ' + d.unit : '';
  if (d.from == null || d.to == null) return d.label + ' changed';
  if (d.series) return d.from === d.to ? `${d.label} changed (same sum, ${d.from}${u})` : `${d.label} changed (sum ${d.from} to ${d.to}${u})`;
  return `${d.label} ${d.from} to ${d.to}${u}`;
}
// The first n changes as one list: 'A, B, C (and 4 more)'.
export function diffList(diff, n = 6) {
  return diff.slice(0, n).map(diffText).join(', ') + (diff.length > n ? ` (and ${diff.length - n} more)` : '');
}

