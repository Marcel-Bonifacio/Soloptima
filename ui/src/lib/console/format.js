// How the script console prints values (disp, table, the result of a script)
const isArr = Array.isArray;

export const fmtVal = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : (+v.toPrecision(6)).toString());
  if (isArr(v)) return v.length > 12 ? `[${v.slice(0, 6).map(fmtVal).join(', ')}, … ${v.length - 9} more …, ${v.slice(-3).map(fmtVal).join(', ')}]  (1×${v.length})` : `[${v.map(fmtVal).join(', ')}]`;
  if (v && typeof v === 'object') return JSON.stringify(v, (k, x) => (isArr(x) && x.length > 12 ? `[${x.length} values]` : x), 2);
  return String(v);
};

// {cols, rows} of printed cells for table(rows, cols): rows are objects, arrays of objects or {name: value}
export function tableCells(rows, cols) {
  if (!isArr(rows)) rows = Object.entries(rows).map(([k, v]) => ({ name: k, value: v }));
  if (!rows.length) return null;
  cols = cols || Object.keys(rows[0]);
  return { cols, rows: rows.map((r) => cols.map((c) => fmtVal(r[c]))) };
}

// CSV text of exportCSV(name, rows)
export function csvText(rows) {
  if (!isArr(rows)) rows = [rows];
  const cols = isArr(rows[0]) ? null : Object.keys(rows[0]);
  return (cols ? [cols.join(',')].concat(rows.map((r) => cols.map((c) => r[c]).join(','))) : rows.map((r) => r.join(','))).join('\n');
}

// The help text: [label, text] rows
export const HELP_ROWS = [
  ['Workspace', 'P (project inputs, live) · project (copy) · sim · opt · hourly · pvr · forecast · equipment · design'],
  ['Vectors', 'linspace colon zeros ones rand randn weibull(n,c,k) lognormal(n,mu,sigma)'],
  ['Statistics', 'sum mean median std variance min max prctile cumsum diff sort corrcoef movmean histcounts trapz'],
  ['Element-wise', 'add sub mul div pow abs sqrt exp log log10 round floor ceil dot find'],
  ['Matrices', 'reshape transpose mtimes eye inv mldivide (A\\b)'],
  ['Fitting', 'polyfit polyval interp1'],
  ['Energy', "monthly(a,'sum'|'mean') daily(a) duration(a)  (8760 h series)"],
  ['Engine', "await simulate({'pv.capacity_kwp': 2e4}, {fast:true})  await batch([...])  await sweep({key:[...]}, r => ({...}))\nawait montecarlo(n, i => ({...overrides}), r => ({...metrics}))  await optimize({...})  await pvYield({...})"],
  ['Output', 'disp table figure plot bar scatter hist heatmap xlabel ylabel title'],
  ['Files', 'exportCSV exportXLSX saveJSON  await readCSV()  await loadFile()'],
];
