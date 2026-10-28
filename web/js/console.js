// Script console: a numeric workspace (JavaScript syntax + numeric helpers, plotting, tables, engine calls).
'use strict';

const Console = (() => {
  let figs = [], cur = null, out;

  // ------------------------------------------------------------------ numeric library (vectors are plain arrays)
  const isArr = Array.isArray;
  const bc = (a, b, f) => {   // broadcasting element-wise op
    if (isArr(a) && isArr(b)) { if (a.length !== b.length) throw new Error(`Size mismatch: ${a.length} vs ${b.length}`); return a.map((x, i) => f(x, b[i])); }
    if (isArr(a)) return a.map((x) => f(x, b));
    if (isArr(b)) return b.map((y) => f(a, y));
    return f(a, b);
  };
  const map1 = (f) => (a) => (isArr(a) ? a.map(f) : f(a));
  const M = {
    linspace: (a, b, n = 100) => Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (b - a) * i / (n - 1))),
    colon: (a, step, b) => { if (b === undefined) { b = step; step = 1; } if (!step) return []; const o = []; for (let x = a; step > 0 ? x <= b + 1e-12 : x >= b - 1e-12; x += step) o.push(+x.toFixed(12)); return o; },
    zeros: (n) => new Array(n).fill(0), ones: (n) => new Array(n).fill(1),
    rand: (n) => Array.from({ length: n }, Math.random),
    randn: (n) => Array.from({ length: n }, () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }),
    sum,
    mean: (a) => M.sum(a) / a.length,
    median: (a) => M.prctile(a, 50),
    std: (a) => Math.sqrt(M.variance(a)),
    variance: (a) => { const m = M.mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); },
    min: (a, b) => (b === undefined ? a.reduce((m, x) => Math.min(m, x), Infinity) : bc(a, b, Math.min)), max: (a, b) => (b === undefined ? a.reduce((m, x) => Math.max(m, x), -Infinity) : bc(a, b, Math.max)),
    cumsum: (a) => { let s = 0; return a.map((x) => (s += x)); },
    diff: (a) => a.slice(1).map((x, i) => x - a[i]),
    sort: (a, dir = 'ascend') => [...a].sort((x, y) => (dir === 'descend' ? y - x : x - y)),
    prctile: (a, p) => { const s = [...a].sort((x, y) => x - y), k = (s.length - 1) * p / 100, lo = Math.floor(k), hi = Math.ceil(k); return s[lo] + (s[hi] - s[lo]) * (k - lo); },
    abs: map1(Math.abs), sqrt: map1(Math.sqrt), exp: map1(Math.exp), log: map1(Math.log), log10: map1(Math.log10), round: (a, d = 0) => map1((x) => +x.toFixed(d))(a),
    floor: map1(Math.floor), ceil: map1(Math.ceil),
    add: (a, b) => bc(a, b, (x, y) => x + y), sub: (a, b) => bc(a, b, (x, y) => x - y), mul: (a, b) => bc(a, b, (x, y) => x * y), div: (a, b) => bc(a, b, (x, y) => x / y), pow: (a, b) => bc(a, b, Math.pow),
    dot: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
    find: (a, f) => a.reduce((o, x, i) => (f(x, i) ? (o.push(i), o) : o), []),
    reshape: (a, r, c) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => a[j * r + i])),   // column-major order
    transpose: (A) => A[0].map((_, j) => A.map((r) => r[j])),
    mtimes: (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, x, k) => s + x * B[k][j], 0))),
    eye: (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j))),
    mldivide: (A, b) => {   // Gaussian elimination with partial pivoting: solves A x = b
      const n = A.length, Mx = A.map((r, i) => [...r, isArr(b[i]) ? b[i][0] : b[i]]);
      for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r;
        [Mx[c], Mx[p]] = [Mx[p], Mx[c]];
        if (Math.abs(Mx[c][c]) < 1e-14) throw new Error('Matrix is singular');
        for (let r = 0; r < n; r++) if (r !== c) { const f = Mx[r][c] / Mx[c][c]; for (let k = c; k <= n; k++) Mx[r][k] -= f * Mx[c][k]; }
      }
      return Mx.map((r, i) => r[n] / r[i]);
    },
    inv: (A) => { const n = A.length, I = M.eye(n); return M.transpose(I.map((col) => M.mldivide(A, col))); },
    polyfit: (x, y, n) => {   // least squares, coefficients highest power first
      const V = x.map((xi) => Array.from({ length: n + 1 }, (_, k) => xi ** (n - k)));
      const Vt = M.transpose(V);
      return M.mldivide(M.mtimes(Vt, V), M.mtimes(Vt, y.map((v) => [v])).map((r) => r[0]));
    },
    polyval: (p, x) => map1((xi) => p.reduce((s, c) => s * xi + c, 0))(x),
    interp1: (x, y, xi) => map1((v) => { if (v <= x[0]) return y[0]; if (v >= x[x.length - 1]) return y[y.length - 1]; let j = 1; while (x[j] < v) j++; return y[j - 1] + (y[j] - y[j - 1]) * (v - x[j - 1]) / (x[j] - x[j - 1]); })(xi),
    trapz: (x, y) => { if (!y) { y = x; x = y.map((_, i) => i); } let s = 0; for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2; return s; },
    corrcoef: (a, b) => { const ma = M.mean(a), mb = M.mean(b); let n = 0, da = 0, db = 0; a.forEach((x, i) => { n += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; }); return n / Math.sqrt(da * db); },
    movmean: (a, w) => a.map((_, i) => { const lo = Math.max(0, i - Math.floor(w / 2)), hi = Math.min(a.length, lo + w); return M.mean(a.slice(lo, hi)); }),
    histcounts: (a, edges) => { const c = new Array(edges.length - 1).fill(0); a.forEach((v) => { for (let i = 0; i < edges.length - 1; i++) if (v >= edges[i] && (v < edges[i + 1] || (i === edges.length - 2 && v === edges[i + 1]))) { c[i]++; break; } }); return c; },
    monthly: (a, how = 'sum') => { const m = monthlySum(a); return how === 'mean' ? m.map((x, i) => x / (MDAYS[i] * 24)) : m; },
    daily: (a) => Array.from({ length: 365 }, (_, d) => M.sum(a.slice(d * 24, d * 24 + 24))),
    duration: (a) => M.sort(a, 'descend'),
    weibull: (n, c, k) => Array.from({ length: n }, () => c * Math.pow(-Math.log(1 - Math.random()), 1 / k)),         // inverse-CDF sampling
    lognormal: (n, mu, sigma) => M.randn(n).map((z) => Math.exp(mu + sigma * z)),
  };

  // ------------------------------------------------------------------ output
  const print = (html, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; };
  const fmtVal = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(4) : (+v.toPrecision(6)).toString());
    if (isArr(v)) return v.length > 12 ? `[${v.slice(0, 6).map(fmtVal).join(', ')}, … ${v.length - 9} more …, ${v.slice(-3).map(fmtVal).join(', ')}]  (1×${v.length})` : `[${v.map(fmtVal).join(', ')}]`;
    if (v && typeof v === 'object') return JSON.stringify(v, (k, x) => (isArr(x) && x.length > 12 ? `[${x.length} values]` : x), 2);
    return String(v);
  };
  function disp(...a) { print(escapeHtml(a.map(fmtVal).join(' '))); }
  function table(rows, cols) {
    if (!isArr(rows)) rows = Object.entries(rows).map(([k, v]) => ({ name: k, value: v }));
    if (!rows.length) return disp('(empty table)');
    cols = cols || Object.keys(rows[0]);
    print(`<table><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(fmtVal(r[c]))}</td>`).join('')}</tr>`).join('')}</table>`);
  }
  function figure(title) {
    const card = document.createElement('div');
    card.className = 'card fig-card';
    card.innerHTML = `<h3>${escapeHtml(title || 'Figure ' + (figs.length + 1))}</h3><div class="chart tall"></div>`;
    $('#scFigs').appendChild(card);
    cur = { el: card.querySelector('.chart'), traces: [], layout: {} };
    figs.push(cur);
    return figs.length;
  }
  const PAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  function addTrace(t, opts = {}) {
    if (!cur) figure(opts.figure);
    const i = cur.traces.length;
    cur.traces.push({ name: opts.name || 'series ' + (i + 1), ...t, ...(opts.trace || {}) });
    const axis = (ax, label) => ({ ...ax, title: { text: label || (ax && ax.title && ax.title.text) || '' } });
    Object.assign(cur.layout, { xaxis: axis(cur.layout.xaxis, opts.xlabel), yaxis: axis(cur.layout.yaxis, opts.ylabel), showlegend: cur.traces.length > 1 });
    if (opts.title) cur.el.parentElement.querySelector('h3').textContent = opts.title;
    if (opts.layout) Object.assign(cur.layout, opts.layout);
    plot(cur.el, cur.traces, cur.layout);
  }
  const color = (o) => o.color || PAL[(cur ? cur.traces.length : 0) % PAL.length];
  const G = {
    disp, table, figure, help,
    plot: (x, y, o = {}) => { if (y === undefined || (typeof y === 'object' && !isArr(y))) { o = y || {}; y = x; x = y.map((_, i) => i + 1); } addTrace({ type: 'scatter', mode: o.markers ? 'lines+markers' : 'lines', x, y, line: { color: color(o), width: 2, dash: o.dash } }, o); },
    scatter: (x, y, o = {}) => addTrace({ type: 'scatter', mode: 'markers', x, y, marker: { color: color(o), size: o.size || 8 } }, o),
    bar: (x, y, o = {}) => { if (y === undefined || (typeof y === 'object' && !isArr(y))) { o = y || {}; y = x; x = y.map((_, i) => i + 1); } addTrace({ type: 'bar', x, y, marker: { color: color(o), cornerradius: 3 } }, o); },
    hist: (a, o = {}) => addTrace({ type: 'histogram', x: a, nbinsx: o.bins || 30, marker: { color: color(o) } }, o),
    heatmap: (z, o = {}) => addTrace({ type: 'heatmap', z, x: o.x, y: o.y, colorscale: [[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']] }, o),
    xlabel: (s) => { if (cur) { cur.layout.xaxis = { ...cur.layout.xaxis, title: { text: s } }; plot(cur.el, cur.traces, cur.layout); } },
    ylabel: (s) => { if (cur) { cur.layout.yaxis = { ...cur.layout.yaxis, title: { text: s } }; plot(cur.el, cur.traces, cur.layout); } },
    title: (s) => { if (cur) cur.el.parentElement.querySelector('h3').textContent = s; },
    exportCSV: (name, rows) => {
      if (!isArr(rows)) rows = [rows];
      const cols = isArr(rows[0]) ? null : Object.keys(rows[0]);
      const lines = cols ? [cols.join(',')].concat(rows.map((r) => cols.map((c) => r[c]).join(','))) : rows.map((r) => r.join(','));
      download(name.endsWith('.csv') ? name : name + '.csv', lines.join('\n'), 'text/csv');
    },
    exportXLSX: (name, sheets) => {   // sheets: {SheetName: [rowObjects]}
      const s = Object.entries(sheets).map(([n, rows]) => { const cols = Object.keys(rows[0] || {}); return { name: n, rows: [cols].concat(rows.map((r) => cols.map((c) => r[c]))) }; });
      const b = Report.xlsx(s); download(name.endsWith('.xlsx') ? name : name + '.xlsx', b, b.type);
    },
    saveJSON: (name, obj) => download(name.endsWith('.json') ? name : name + '.json', JSON.stringify(obj, null, 1), 'application/json'),
    loadFile: () => new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.onchange = async () => res(i.files[0] ? await readFile(i.files[0]) : ''); i.click(); }),
    readCSV: async () => { const t = await G.loadFile(); const { header, rows } = parseCSV(t); return header ? rows.map((r) => Object.fromEntries(header.map((h, i) => [h, isFinite(+r[i]) && r[i] !== '' ? +r[i] : r[i]]))) : rows.map((r) => r.map(Number)); },
    // ---- engine
    simulate: async (over = {}, opts = {}) => api('/api/simulate', withOverrides(over, opts)),
    batch: async (cases, opts = {}) => {   // cases: array of override objects; runs in parallel in the C++ engine
      const project = withOverrides({}, opts);
      checkPaths(project, new Set(cases.flatMap((c) => Object.keys(c || {}))));
      const r = await api('/api/batch', { project, cases: cases.map((c) => ({ overrides: c })) });
      return r.results;
    },
    sweep: async (spec, metric, opts = {}) => {   // full-factorial parametric study
      const keys = Object.keys(spec);
      let combos = [{}];
      for (const k of keys) combos = combos.flatMap((c) => spec[k].map((v) => ({ ...c, [k]: v })));
      print(`<span class="info">sweep: ${combos.length} cases…</span>`);
      const res = await G.batch(combos, opts);
      return combos.map((c, i) => ({ ...c, ...(metric ? metric(res[i]) : { lcoe: res[i].result.econ.lcoe, npc: res[i].result.econ.npc, re: res[i].result.re_fraction }) }));
    },
    montecarlo: async (n, sampler, metric, opts = {}) => {
      const cases = Array.from({ length: n }, (_, i) => sampler(i));
      print(`<span class="info">Monte Carlo: ${n} runs…</span>`);
      const res = await G.batch(cases, opts);
      return res.map((r, i) => ({ ...cases[i], ...metric(r) }));
    },
    pvYield: async (over = {}) => api('/api/pv', withOverrides(over, {})),
    optimize: async (settings = {}, over = {}) => {
      const { job } = await api('/api/optimize', { project: withOverrides(over, {}), optimizer: { ...P.optimizer, c_rates: [0.5], ...settings } });
      for (;;) { await new Promise((r) => setTimeout(r, 400)); const s = await api('/api/job?id=' + job); if (s.done) { if (s.error) throw new Error(s.error); return s.result; } }
    },
  };
  function withOverrides(over, opts) {
    const p = clone(engineProject());
    if (opts.fast) p.sim = { ...p.sim, all_years: false };
    checkPaths(p, Object.keys(over));
    for (const [k, v] of Object.entries(over)) setPath(p, k, v);
    return p;
  }
  // The engine takes an override path it does not read without complaint (a mistyped path is created and changes nothing),
  // so say so before the run. Batch overrides are applied in the engine; they are checked once per path, not per case.
  function checkPaths(p, keys) {
    for (const k of keys) {
      if (GUI_ONLY.has(k)) print(escapeHtml(`${k} is not an input of the engine; only the layout and the equipment library use it`), 'warn');
      else if (getPath(p, k) === undefined) print(escapeHtml(`${k} is not in the project; the engine ignores unknown inputs`), 'warn');
    }
  }
  function help() {
    print(`<b>Workspace</b>  P (project inputs, live) · project (copy) · sim · opt · hourly · pvr · forecast · equipment · design
<b>Vectors</b>     linspace colon zeros ones rand randn weibull(n,c,k) lognormal(n,mu,sigma)
<b>Statistics</b>  sum mean median std variance min max prctile cumsum diff sort corrcoef movmean histcounts trapz
<b>Element-wise</b> add sub mul div pow abs sqrt exp log log10 round floor ceil dot find
<b>Matrices</b>    reshape transpose mtimes eye inv mldivide (A\\b)
<b>Fitting</b>     polyfit polyval interp1
<b>Energy</b>      monthly(a,'sum'|'mean') daily(a) duration(a)  (8760 h series)
<b>Engine</b>      await simulate({'pv.capacity_kwp': 2e4}, {fast:true})  await batch([...])  await sweep({key:[...]}, r => ({...}))
              await montecarlo(n, i => ({...overrides}), r => ({...metrics}))  await optimize({...})  await pvYield({...})
<b>Output</b>      disp table figure plot bar scatter hist heatmap xlabel ylabel title
<b>Files</b>       exportCSV exportXLSX saveJSON  await readCSV()  await loadFile()`, 'info');
  }

  // ------------------------------------------------------------------ examples
  const EXAMPLES = {
    'Load duration curve & statistics': `// Load duration curve and basic statistics of the 8760-h load
const L = P.load.kw;
disp('mean', mean(L), 'kW   P90', prctile(L, 90), 'kW   peak', max(L), 'kW');
figure('Load duration curve');
plot(linspace(0, 100, L.length), duration(L), {name: 'Load', xlabel: '% of hours', ylabel: 'kW'});`,
    'Parametric sweep: PV × BESS → LCOE': `// Full-factorial sweep run in parallel by the C++ engine (year-1 fast mode)
const res = await sweep({
  'pv.capacity_kwp': linspace(0, 2 * P.pv.capacity_kwp, 6),
  'bess.energy_kwh': [0, P.bess.energy_kwh, 2 * P.bess.energy_kwh, 4 * P.bess.energy_kwh],
}, r => ({ lcoe: r.result.econ.lcoe, re: r.result.re_fraction, fuel_kL: r.result.fuel_l_y1 / 1000 }), {fast: true});
table(res);
figure('LCOE vs PV size for each battery size');
for (const e of [...new Set(res.map(r => r['bess.energy_kwh']))]) {
  const s = res.filter(r => r['bess.energy_kwh'] === e);
  plot(s.map(r => r['pv.capacity_kwp']), s.map(r => r.lcoe), {name: 'BESS ' + e + ' kWh', xlabel: 'PV kWp', ylabel: 'LCOE', markers: true});
}`,
    'Monte Carlo: diesel price & irradiance uncertainty': `// 200 runs: diesel price ~ normal(μ, 15 %), PV yield scaled by a lognormal factor (P50 = 1)
const n = 200, base = P.econ.fuel_price;
const res = await montecarlo(n, i => ({
  'econ.fuel_price': Math.max(0.1, base * (1 + 0.15 * randn(1)[0])),
  'pv.availability': Math.min(1, P.pv.availability * lognormal(1, 0, 0.05)[0]),
}), r => ({ npv: r.comparison.npv_savings, lcoe: r.result.econ.lcoe }), {fast: true});
const npv = res.map(r => r.npv);
disp('NPV of savings  P10', prctile(npv, 10), '  P50', prctile(npv, 50), '  P90', prctile(npv, 90));
disp('Probability NPV < 0:', find(npv, x => x < 0).length / n);
figure('NPV of savings distribution'); hist(npv, {name: 'NPV', xlabel: P.econ.currency, bins: 25});`,
    'Curve fit: fuel vs PV size (polyfit)': `// Fit a quadratic to year-1 fuel use vs PV capacity
const pv = linspace(0, 2 * P.pv.capacity_kwp, 9);
const res = await batch(pv.map(v => ({'pv.capacity_kwp': v})), {fast: true});
const fuel = res.map(r => r.result.fuel_l_y1 / 1000);
const p = polyfit(pv, fuel, 2);
disp('fuel [kL] ≈', p[0], '·PV² +', p[1], '·PV +', p[2]);
figure('Fuel vs PV capacity');
scatter(pv, fuel, {name: 'simulated', xlabel: 'PV kWp', ylabel: 'fuel kL/yr'});
plot(pv, polyval(p, pv), {name: 'quadratic fit', dash: 'dash'});`,
    'Monthly energy balance table': `// Monthly balance from the last simulation (run one first)
if (!hourly) throw new Error('Run a simulation first');
const rows = MONTHS.map((m, i) => ({ month: m,
  load_MWh: monthly(hourly.load)[i] / 1000, pv_MWh: monthly(hourly.pv_to_load)[i] / 1000,
  bess_MWh: monthly(hourly.bess_dis)[i] / 1000, diesel_MWh: monthly(hourly.gen_to_load)[i] / 1000,
  fuel_kL: monthly(hourly.fuel_l)[i] / 1000 }));
table(rows);
exportCSV('monthly_balance', rows);`,
    'Weibull wind resource & turbine power curve': `// Wind speed sampling (Weibull, inverse CDF) and a cubic power curve
const v = weibull(20000, 8, 2);             // scale c = 8 m/s, shape k = 2
const Pr = 1500, vin = 3, vr = 12, vout = 25;
const P_ = v.map(x => x < vin || x >= vout ? 0 : x >= vr ? Pr : Pr * (x**3 - vin**3) / (vr**3 - vin**3));
disp('mean wind', mean(v), 'm/s   capacity factor', mean(P_) / Pr);
figure('Wind speed distribution'); hist(v, {name: 'v', xlabel: 'm/s', bins: 40});`,
  };

  function init() {
    out = $('#scOut');
    const sel = $('#scExamples');
    sel.innerHTML = '<option value="">Examples…</option>' + Object.keys(EXAMPLES).map((k) => `<option>${escapeHtml(k)}</option>`).join('');
    sel.onchange = () => { if (sel.value) { $('#scCode').value = EXAMPLES[sel.value]; sel.value = ''; } };
    $('#scCode').value = storeGet('soloptima.script') || EXAMPLES['Load duration curve & statistics'];
    $('#scRun').onclick = run;
    $('#scClear').onclick = () => { out.innerHTML = ''; $('#scFigs').innerHTML = ''; figs = []; cur = null; };
    $('#scSave').onclick = () => {
      const name = prompt('Script name:', 'analysis');
      if (!name) return;
      P.scripts = (P.scripts || []).filter((s) => s.name !== name).concat([{ name, code: $('#scCode').value }]);
      autosave(); renderSaved();
    };
    $('#scCode').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd); t.selectionStart = t.selectionEnd = s + 2; }
    });
    renderSaved();
    print('Soloptima script console. Type help() for the function list, or pick an example.', 'info');
  }
  function renderSaved() {
    $('#scSaved').innerHTML = (P.scripts || []).map((s, i) => `<span class="chip" data-sc="${i}">${escapeHtml(s.name)}</span>`).join('');
    $$('[data-sc]').forEach((c) => (c.onclick = () => { $('#scCode').value = P.scripts[+c.dataset.sc].code; }));
  }
  async function run() {
    const code = $('#scCode').value;
    storeSet('soloptima.script', code);
    figs = []; cur = null; $('#scFigs').innerHTML = '';
    print(`<span class="info">» run ${new Date().toLocaleTimeString()}</span>`);
    const ws = { P, project: clone(P), sim: SIM, opt: OPT, hourly: SIM ? SIM.result.hourly : null, pvr: PVR, forecast: ForecastLab.result,
                 equipment: P.equipment, design: Electrical.design, MONTHS, HOURS };
    const env = { ...M, ...G, ...ws };
    const names = Object.keys(env).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
    const t0 = performance.now();
    try {
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn(...names, '"use strict";\n' + code);
      const r = await fn(...names.map((k) => env[k]));
      if (r !== undefined) disp(r);
      print(`<span class="info">done in ${((performance.now() - t0) / 1000).toFixed(2)} s</span>`);
    } catch (e) {
      const m = (e.stack || '').match(/<anonymous>:(\d+):(\d+)/);
      print(escapeHtml(`Error: ${e.message}${m ? `  (line ${+m[1] - 3})` : ''}`), 'err');
    }
  }
  return { init, renderSaved };
})();
