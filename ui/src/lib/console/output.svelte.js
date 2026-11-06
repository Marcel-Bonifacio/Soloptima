// What the script console shows: the output lines and the figures. Plain arrays plus a counter, so the large traces of a figure
// are not proxied; the page reads `con.rev` and the arrays again.
import { fmtVal, tableCells, HELP_ROWS } from './format.js';

export const con = $state({ rev: 0 });
export const lines = [];   // {k: 'text' | 'table' | 'help', cls, text | cols, rows}
export let figs = [];      // {title, traces, layout}
let cur = -1;
const touch = () => { con.rev++; };

export function print(text, cls = '') { lines.push({ k: 'text', cls, text }); touch(); }
export function disp(...a) { print(a.map(fmtVal).join(' ')); }
export function table(rows, cols) {
  const t = tableCells(rows, cols);
  if (!t) return disp('(empty table)');
  lines.push({ k: 'table', ...t });
  touch();
}
export function help() { lines.push({ k: 'help', cls: 'info', rows: HELP_ROWS }); touch(); }

export function clearOutput() { lines.length = 0; touch(); }
export function clearFigures() { figs = []; cur = -1; touch(); }

export function figure(title) {
  figs = [...figs, { title: title || 'Figure ' + (figs.length + 1), traces: [], layout: {} }];
  cur = figs.length - 1;
  touch();
  return figs.length;
}
const update = (f) => { figs = figs.map((x, i) => (i === cur ? f(x) : x)); touch(); };

const PAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const color = (o) => o.color || PAL[(cur >= 0 ? figs[cur].traces.length : 0) % PAL.length];

export function addTrace(t, opts = {}) {
  if (cur < 0) figure(opts.figure);
  update((f) => {
    const i = f.traces.length, lay = f.layout;
    const axis = (ax, label) => ({ ...ax, title: { text: label || (ax && ax.title && ax.title.text) || '' } });
    const layout = { ...lay, xaxis: axis(lay.xaxis, opts.xlabel), yaxis: axis(lay.yaxis, opts.ylabel), showlegend: i + 1 > 1, ...(opts.layout || {}) };
    return { title: opts.title || f.title, traces: [...f.traces, { name: opts.name || 'series ' + (i + 1), ...t, ...(opts.trace || {}) }], layout };
  });
}
export const axisTitle = (ax, s) => { if (cur >= 0) update((f) => ({ ...f, layout: { ...f.layout, [ax]: { ...f.layout[ax], title: { text: s } } } })); };
export const setTitle = (s) => { if (cur >= 0) update((f) => ({ ...f, title: s })); };
