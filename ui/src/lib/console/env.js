// The functions a script of the console can call besides the numeric library: output, plots, files and the engine.
import { call, saveFile } from '../ipc.js';
import { getPath, setPath } from '../path.js';
import { csvText } from './format.js';
import { parseCSV } from '../csv.js';
import { waitJob } from '../results.svelte.js';
import { xlsx } from '../report/xlsx.js';
import { disp, print, table, figure, help, addTrace, axisTitle, setTitle, color } from './output.svelte.js';
import { W } from '../ws/state.js';
import { engineProject } from '../ws/core.js';

const isArr = Array.isArray;
const clone = (o) => JSON.parse(JSON.stringify(o));
const GUI_ONLY = new Set(['pv.module_wp']);   // input of the layout and the equipment library only

// The project as the engine takes it, with the overrides {'pv.capacity_kwp': 2e4, ...} set
function withOverrides(over, opts) {
  const p = clone(engineProject(false));
  if (opts.fast) p.sim = { ...p.sim, all_years: false };
  checkPaths(p, Object.keys(over));
  for (const [k, v] of Object.entries(over)) setPath(p, k, v);
  return p;
}
// The engine takes an override path it does not read without complaint (a mistyped path is created and changes nothing), so say so
// before the run. Batch overrides are applied in the engine; they are checked once per path, not per case.
function checkPaths(p, keys) {
  for (const k of keys) {
    if (GUI_ONLY.has(k)) print(`${k} is not an input of the engine; only the layout and the equipment library use it`, 'warn');
    else if (getPath(p, k) === undefined) print(`${k} is not in the project; the engine ignores unknown inputs`, 'warn');
  }
}
// plot(y) and bar(y), with or without options: x becomes 1..n
const xyo = (x, y, o = {}) => (y === undefined || (typeof y === 'object' && !isArr(y)) ? [x.map((_, i) => i + 1), x, y || {}] : [x, y, o]);

const loadFile = () => new Promise((res) => {
  const i = document.createElement('input');
  i.type = 'file';
  i.onchange = async () => res(i.files[0] ? await i.files[0].text() : '');
  i.click();
});
const named = (name, ext) => (name.endsWith(ext) ? name : name + ext);

export const G = {
  disp, table, figure, help,
  plot: (...a) => { const [x, y, o] = xyo(...a); addTrace({ type: 'scatter', mode: o.markers ? 'lines+markers' : 'lines', x, y, line: { color: color(o), width: 2, dash: o.dash } }, o); },
  scatter: (x, y, o = {}) => addTrace({ type: 'scatter', mode: 'markers', x, y, marker: { color: color(o), size: o.size || 8 } }, o),
  bar: (...a) => { const [x, y, o] = xyo(...a); addTrace({ type: 'bar', x, y, marker: { color: color(o), cornerradius: 3 } }, o); },
  hist: (a, o = {}) => addTrace({ type: 'histogram', x: a, nbinsx: o.bins || 30, marker: { color: color(o) } }, o),
  heatmap: (z, o = {}) => addTrace({ type: 'heatmap', z, x: o.x, y: o.y, colorscale: [[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']] }, o),
  xlabel: (s) => axisTitle('xaxis', s),
  ylabel: (s) => axisTitle('yaxis', s),
  title: (s) => setTitle(s),
  exportCSV: (name, rows) => saveFile(named(name, '.csv'), csvText(rows), 'text/csv'),
  exportXLSX: (name, sheets) => {   // sheets: {SheetName: [rowObjects]}
    const s = Object.entries(sheets).map(([n, rows]) => { const cols = Object.keys(rows[0] || {}); return { name: n, rows: [cols].concat(rows.map((r) => cols.map((c) => r[c]))) }; });
    const b = xlsx(s);
    return saveFile(named(name, '.xlsx'), b, b.type);
  },
  saveJSON: (name, obj) => saveFile(named(name, '.json'), JSON.stringify(obj, null, 1), 'application/json'),
  loadFile,
  readCSV: async () => {
    const { header, rows } = parseCSV(await loadFile());
    return header ? rows.map((r) => Object.fromEntries(header.map((h, i) => [h, isFinite(+r[i]) && r[i] !== '' ? +r[i] : r[i]]))) : rows.map((r) => r.map(Number));
  },
  // ---- engine
  simulate: async (over = {}, opts = {}) => call('simulate', { body: withOverrides(over, opts) }),
  batch: async (cases, opts = {}) => {   // cases: array of override objects; runs in parallel in the engine
    const project = withOverrides({}, opts);
    checkPaths(project, new Set(cases.flatMap((c) => Object.keys(c || {}))));
    return (await call('batch', { body: { project, cases: cases.map((c) => ({ overrides: c })) } })).results;
  },
  sweep: async (spec, metric, opts = {}) => {   // full-factorial parametric study
    let combos = [{}];
    for (const k of Object.keys(spec)) combos = combos.flatMap((c) => spec[k].map((v) => ({ ...c, [k]: v })));
    print(`sweep: ${combos.length} cases…`, 'info');
    const res = await G.batch(combos, opts);
    return combos.map((c, i) => ({ ...c, ...(metric ? metric(res[i]) : { lcoe: res[i].result.econ.lcoe, npc: res[i].result.econ.npc, re: res[i].result.re_fraction }) }));
  },
  montecarlo: async (n, sampler, metric, opts = {}) => {
    const cases = Array.from({ length: n }, (_, i) => sampler(i));
    print(`Monte Carlo: ${n} runs…`, 'info');
    const res = await G.batch(cases, opts);
    return res.map((r, i) => ({ ...cases[i], ...metric(r) }));
  },
  pvYield: async (over = {}) => call('pv', { body: withOverrides(over, {}) }),
  optimize: async (settings = {}, over = {}) => {
    const { job } = await call('optimize', { body: { project: withOverrides(over, {}), optimizer: { ...W.P.optimizer, c_rates: [0.5], ...settings } } });
    return waitJob(job, () => {});
  },
};
