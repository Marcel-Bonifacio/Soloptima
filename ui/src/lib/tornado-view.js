// The "What drives the result" card as plain data (no DOM, no store): the cases of a run, the figures of its result, the editable
// table of inputs and the chart. The design is simulated at the low and the high value of one input at a time, in one batch with
// the base case; the sizes stay fixed (the sensitivity cases of Optimise sizing re-optimise them instead). Every function takes
// the open project P, so tests can use a hand-made one.
import { fmtNum, fmtPct, fmtMoney, fmtPower, fmtSig } from './format.js';
import { getPath } from './path.js';
import { sum } from './series.js';
import { FORMS, PCT } from './schema/index.js';
import { inputField } from './ws/diff.js';

export const TORNADO_METRICS = {
  npv: ['NPV of savings', (r) => r.comparison.npv_savings],
  lcoe: ['LCOE', (r) => r.result.econ.lcoe],
  irr: ['IRR', (r) => r.comparison.irr],
  eq_irr: ['Equity IRR', (r) => (r.finance ? r.finance.equity_irr : null)],
  fuel: ['Fuel saved in year 1', (r) => r.comparison.fuel_saved_l_y1],
};
const TORNADO_PATHS = /^(pv|bess|aux|wind|diesel|ems|econ|finance)\.|^load\.growth$/;   // inputs the engine reads
export const GUI_ONLY = new Set(['pv.module_wp']);   // input of the layout and the equipment library only

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function tornadoFmt(cur, m, v) {
  if (v == null || !isFinite(v)) return '–';
  return m === 'npv' ? (v === 0 ? cur + ' 0' : fmtMoney(v, cur)) : m === 'lcoe' ? `${cur} ${fmtNum(v, 4)}/kWh` : m === 'fuel' ? fmtNum(v) + ' L' : fmtPct(v, 2);
}
export const tornadoSwing = (cur, m, v) => (m === 'irr' || m === 'eq_irr' ? fmtNum(v * 100, 2) + ' pp' : tornadoFmt(cur, m, v));
// [scale from engine units, axis title]
const tornadoAxis = (cur, m) => ({ npv: [1e-6, `NPV of savings (M ${cur})`], lcoe: [1, `LCOE (${cur}/kWh)`], irr: [100, 'IRR (%)'],
  eq_irr: [100, 'Equity IRR (%)'], fuel: [1e-3, 'Fuel saved in year 1 (kL)'] }[m]);

const isNumField = (f) => f.t !== 'sel' && f.t !== 'chk' && f.t !== 'text' && f.t !== 'list';
// Numeric input field of a project path in the input forms (label, unit, percentage), or null.
function formField(path) {
  const f = inputField(path);
  return f && isNumField(f) ? f : null;
}
const tornadoLabel = (v) => v.label || (v.path === 'load.kw' ? 'Load' : (formField(v.path) || {}).l || v.path || 'New input');
// Low and high typed in % or pp
export const tornadoPct = (v) => v.mode !== 'x' && (formField(v.path) || {}).t === PCT;
export function tornadoUnit(cur, v) {
  const f = formField(v.path) || {}, u = f.u || '';
  if (v.mode === 'x') return '';
  if (f.t === PCT) return v.mode === '+' ? 'pp' : u;
  return u.startsWith('/') ? cur + u : u;
}
// Input value of one case: x multiplies the base value (every hour of an array), + adds to it, = replaces it; null when it cannot apply.
export function tornadoValue(P, v, x) {
  const b = getPath(P, v.path), f = formField(v.path);
  if (typeof x !== 'number' || !isFinite(x)) return null;
  if (Array.isArray(b)) return v.mode === 'x' ? b.map((y) => y * x) : null;
  if (v.mode !== '=' && (typeof b !== 'number' || !isFinite(b))) return null;
  const val = v.mode === 'x' ? b * x : v.mode === '+' ? b + x : x;
  return f && f.t === 'int' ? Math.round(val) : val;
}
// An input value as text, in the units of its input field.
export function tornadoInput(P, v, val) {
  if (val == null) return '–';
  if (Array.isArray(val)) return fmtPower(sum(val) / val.length) + ' average';
  if (typeof val !== 'number') return String(val);
  const f = formField(v.path) || {}, u = f.u || '';
  if (f.t === PCT) return `${+(val * 100).toFixed(3)} ${u}`;
  return u.startsWith('/') ? `${P.econ.currency} ${fmtSig(val)}${u}` : `${fmtSig(val)}${u ? ' ' + u : ''}`;
}
// Overrides of one case. With "battery prices move together" the energy capex also scales the power capex and the replacement price.
export function tornadoOverrides(P, v, val) {
  const o = { [v.path]: val }, E = P.econ;
  if (P.tornado.bess_together && v.path === 'econ.bess_capex_kwh' && E.bess_capex_kwh > 0) {
    const f = val / E.bess_capex_kwh;
    o['econ.bess_capex_kw'] = E.bess_capex_kw * f; o['econ.bess_replace_kwh'] = E.bess_replace_kwh * f;
  }
  return o;
}
// Low and high values to start from after the change type of a row changes.
export function tornadoRange(P, v) {
  const b = getPath(P, v.path), f = formField(v.path) || {};
  if (v.mode === 'x' || typeof b !== 'number') return { lo: 0.8, hi: 1.2 };
  if (v.mode === '+') return f.t === PCT ? { lo: -0.01, hi: 0.01 } : { lo: -0.2 * Math.abs(b), hi: 0.2 * Math.abs(b) };
  return { lo: 0.8 * b, hi: 1.2 * b };
}
// The inputs offered in the path list: [path, label]
export function tornadoPathList() {
  const seen = new Set(['load.kw']), opts = [['load.kw', 'Load in every hour (× only)']];
  for (const fs of Object.values(FORMS))
    for (const f of fs)
      if (isNumField(f) && TORNADO_PATHS.test(f.k) && !GUI_ONLY.has(f.k) && !seen.has(f.k)) { seen.add(f.k); opts.push([f.k, f.l]); }
  return opts;
}

// One edit of the table of inputs: key 'path', 'mode', 'lo' or 'hi' of row v set to the text raw. False when nothing changed
// (an empty or invalid number is ignored).
export function applyEdit(P, v, k, raw) {
  if (k === 'path') {
    v.path = raw.trim(); v.label = '';
    if (Array.isArray(getPath(P, v.path)) && v.mode !== 'x') { v.mode = 'x'; Object.assign(v, tornadoRange(P, v)); }
  } else if (k === 'mode') {
    v.mode = raw; Object.assign(v, tornadoRange(P, v));
  } else {
    const x = Number(raw);
    if (raw.trim() === '' || !isFinite(x)) return false;
    v[k] = tornadoPct(v) ? x / 100 : x;
  }
  return true;
}
// Rows of the editable table: the text of every cell, as the user sees it.
export function varRows(P) {
  const T = P.tornado, cur = P.econ.currency;
  const disp = (v, x) => (x == null ? '' : tornadoPct(v) ? +(x * 100).toFixed(6) : +x);
  return T.vars.map((v) => ({
    label: tornadoLabel(v), together: !!T.bess_together && v.path === 'econ.bess_capex_kwh', path: v.path, mode: v.mode,
    isArray: Array.isArray(getPath(P, v.path)), lo: disp(v, v.lo), hi: disp(v, v.hi), unit: tornadoUnit(cur, v),
    range: [tornadoValue(P, v, v.lo), getPath(P, v.path), tornadoValue(P, v, v.hi)].map((x) => tornadoInput(P, v, x)).join(' · '),
  }));
}

// The batch of a run: the base case first, then the low and high case of every input with a path. eng is the project as the engine
// takes it. rows[i].idx holds the case index of its low and high result (-1: none, 0: the base case).
export function tornadoCases(P, eng) {
  const T = P.tornado, basis = T.fast ? { 'sim.all_years': false } : {};
  const cases = [{ overrides: basis }], rows = [];
  for (const v of T.vars) {
    if (!v.path) continue;
    const row = { path: v.path, mode: v.mode, lo: v.lo, hi: v.hi, label: tornadoLabel(v) + (T.bess_together && v.path === 'econ.bess_capex_kwh' ? ' (with power and replacement prices)' : ''),
      base: tornadoInput(P, v, getPath(P, v.path)), vals: [], idx: [], err: '' };
    // the engine ignores a path it does not read (or creates it), which would draw a zero bar, as if the input did not matter
    const ignored = v.path !== 'load.kw' && (GUI_ONLY.has(v.path) || getPath(eng, v.path) === undefined);
    for (const x of [v.lo, v.hi]) {
      const val = tornadoValue(P, v, x);
      row.vals.push(tornadoInput(P, v, val));
      if (ignored) { row.err = 'not an input of the engine'; row.idx.push(-1); }
      else if (val == null || (!Array.isArray(val) && !isFinite(val))) { row.err = `cannot change ${v.path} this way`; row.idx.push(-1); }
      else if ((v.mode === 'x' && x === 1) || (v.mode === '+' && x === 0) || (v.mode === '=' && val === getPath(P, v.path))) row.idx.push(0);   // the base case
      else { row.idx.push(cases.length); cases.push({ overrides: { ...basis, ...tornadoOverrides(P, v, val) } }); }
    }
    rows.push(row);
  }
  return { cases, rows };
}

// Figures of the last run for one metric (shared by the card, the report and the workbook): result at the low and high input value
// (vLo, vHi), and the swing = the span of both results and the base value. Sorted by swing, largest first. TORNADO is the run
// ({key, fast, together, base, rows}).
export function summarize(TORNADO, metric, stale) {
  const m = TORNADO_METRICS[metric] ? metric : 'npv', [name, get] = TORNADO_METRICS[m];
  const val = (res) => { if (!res || res.error) return null; const x = get(res); return x == null || !isFinite(x) ? null : x; };
  const base = val(TORNADO.base);
  const rows = TORNADO.rows.map((row) => {
    const err = row.err || (row.res.find((x) => x && x.error) || {}).error || '', vLo = err ? null : val(row.res[0]), vHi = err ? null : val(row.res[1]);
    const xs = [vLo, vHi, base].filter((x) => x != null);
    return { ...row, err, vLo, vHi, swing: base == null || xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs) };
  }).sort((a, b) => b.swing - a.swing);
  return { metric: m, name, base, rows, fast: TORNADO.fast, together: TORNADO.together, stale: !!stale };
}

// Rows that get a bar (largest swing last, as the categories run bottom-up)
const barRows = (S) => S.rows.filter((x) => !x.err && S.base != null && (x.vLo != null || x.vHi != null)).reverse();
export const tornadoHeight = (S) => Math.max(260, 100 + 30 * barRows(S).length);

// Chart of a summary S for the colours c: {traces, layout}
export function tornadoFig(cur, S, c) {
  const [sc, title] = tornadoAxis(cur, S.metric), b = S.base, ok = barRows(S);
  // The shorter bar of a row is drawn over the longer one, so both show when the low and high values move the result the same way.
  const loTop = ok.map((x) => x.vLo != null && x.vHi != null && Math.abs(x.vLo - b) < Math.abs(x.vHi - b));
  const bar = (k, name, color, top) => ({ type: 'bar', orientation: 'h', name, legendgroup: k, showlegend: !top, y: ok.map((x) => x.label), base: b * sc,
    x: ok.map((x, j) => (x[k] != null && (k === 'vLo' ? loTop[j] : !loTop[j]) === top ? (x[k] - b) * sc : null)),
    customdata: ok.map((x) => [x.vals[k === 'vLo' ? 0 : 1], tornadoFmt(cur, S.metric, x[k])]), marker: { color, cornerradius: 4 },
    hovertemplate: `%{y}<br>${name}: %{customdata[0]}<br>${esc(S.name)}: %{customdata[1]}<extra></extra>` });
  return {
    traces: [bar('vLo', 'Low input value', c.gen, false), bar('vHi', 'High input value', c.pv, false), bar('vLo', 'Low input value', c.gen, true), bar('vHi', 'High input value', c.pv, true)],
    layout: { barmode: 'overlay', xaxis: { title: { text: title } }, margin: { l: 10, r: 16, t: 28, b: 40 },
      shapes: b == null ? [] : [{ type: 'line', x0: b * sc, x1: b * sc, yref: 'paper', y0: 0, y1: 1, line: { color: c.text2, width: 1.5 } }],
      annotations: b == null ? [] : [{ x: b * sc, y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false, text: 'base ' + esc(tornadoFmt(cur, S.metric, b)), font: { color: c.text2, size: 11 } }] },
  };
}

export const tableHeads = (S) => ['Input', 'Low value', 'High value', S.name + ' at low', S.name + ' at high', 'Swing'];
// Table rows: {label, vals, err, cells (low, high, swing results)}
export function tableRows(cur, S) {
  return S.rows.map((x) => ({ label: x.label, vals: x.vals, err: x.err,
    cells: x.err ? [] : [tornadoFmt(cur, S.metric, x.vLo), tornadoFmt(cur, S.metric, x.vHi),
      S.base == null || (x.vLo == null && x.vHi == null) ? '–' : tornadoSwing(cur, S.metric, x.swing)] }));
}
// The sentences under the table
export function tornadoNotes(cur, S) {
  const note = [], irr = S.metric === 'irr' || S.metric === 'eq_irr';
  if (S.stale) note.push('⚠ The inputs have changed since this run: press Run tornado again.');
  note.push(`Base ${S.name}: ${tornadoFmt(cur, S.metric, S.base)}. Swing is the span of the low, base and high results.`);
  if (irr && S.base == null) note.push('The base design has no IRR (the investment does not pay back), so the chart has no bars; the table shows the cases that have one.');
  else if (irr && S.rows.some((x) => !x.err && (x.vLo == null || x.vHi == null))) note.push('A dash means the IRR has no value in that case (the investment does not pay back).');
  if (S.together) note.push('Battery energy capex moves the power capex and the replacement price by the same factor.');
  if (S.fast) note.push('Year 1 is simulated and repeated over the project life: PV degradation and load growth are left out, so their bars show little or no effect; battery ageing is still counted.');
  return note;
}
