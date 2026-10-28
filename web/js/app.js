// Main controller: state, tabs, data inputs, simulation / optimisation / EMS dashboards.
'use strict';

let P = null;          // project (inputs)
let PVR = null;        // last PV yield result
let PVREF = null;      // last PVGIS reference yield (PV & wind page)
let SIM = null;        // last simulation response
let OPT = null;        // last optimisation result
let SCHED = null;      // last day-ahead schedule
let OPTIONS = null;    // last operating options comparison (Compare options)
let TORNADO = null;    // last tornado run (What drives the result)
const STORE_KEY = 'soloptima.project.v1';

// ---------------------------------------------------------------- boot
document.addEventListener('DOMContentLoaded', async () => {
  Reports.init();
  P = defaultProject();   // placeholder until the landing page opens a saved project
  generateLoad(false);
  renderForms(P, onFieldChange);
  $('#projName').value = P.name;
  $('#projName').onchange = (e) => { P.name = e.target.value; autosave(); };
  Layout.init(P, onFieldChange);
  setupEditors();
  wireButtons();
  ForecastLab.init();
  Equipment.init(P, onFieldChange);
  Electrical.init(P, onFieldChange);
  Console.init();
  Finance.init();
  setupWhatIf();
  refreshAll();
  setupTabs();   // last: opening a tab may render modules initialised above
  try {
    const h = await api('/api/health');
    $('#engineInfo').textContent = `engine · C++ · ${h.threads} threads`;
  } catch (e) { $('#engineInfo').textContent = 'engine offline'; toast(e.message, true); }
  await Home.boot();
});

function migrate(p) {
  // projects saved before the time-zone lookup: store the site's zone but keep the offset; the site info and the Site check
  // warn when it differs from the zone's standard offset
  if (p.location && p.location.tz === undefined) {
    const L = p.location, z = siteZone(L.lat, L.lon), unset = L.utc_offset == null;
    if (unset) L.utc_offset = z ? z.std : Math.round(+L.lon / 15) || 0;
    L.tz = z ? z.tz : '';
    L.utc_offset_src = z && z.std === +L.utc_offset ? 'zone' : unset ? 'longitude' : 'saved';
  }
  const d = defaultProject();
  for (const k of Object.keys(d)) {
    if (p[k] == null) p[k] = d[k];
    else if (typeof d[k] === 'object' && !Array.isArray(d[k]) && d[k] !== null) for (const kk of Object.keys(d[k])) if (p[k][kk] === undefined) p[k][kk] = d[k][kk];
  }
  p.econ.currency = String(p.econ.currency).replace(/[<>&"']/g, '');
  // datasheets copied from an older built-in library keep its note text; bring it in line with the current one
  for (const list of Object.values((p.equipment && p.equipment.lib) || {}))
    if (Array.isArray(list)) list.forEach((e) => { if (e.notes === 'Generic typical values \u2014 replace with the manufacturer datasheet.') e.notes = GEN; });
  // built-in PV modules copied before Cells in series existed: fill it in unless the user changed Voc (a field cleared on purpose is null)
  const lib0 = defaultLibrary();
  ((p.equipment && p.equipment.lib && p.equipment.lib.pv) || []).forEach((e) => {
    const b = lib0.pv.find((x) => x.id === e.id);
    if (b && e.n_cells_series === undefined && e.voc === b.voc) e.n_cells_series = b.n_cells_series;
  });
  // built-in datasheets copied from an older library: drop a bracketed suffix the built-in name no longer has, and take the
  // current note when the old one has the same opening and the generic ending
  for (const [cat, list] of Object.entries((p.equipment && p.equipment.lib) || {}))
    if (Array.isArray(list)) list.forEach((e) => {
      const b = (lib0[cat] || []).find((x) => x.id === e.id);
      if (b && typeof e.name === 'string' && e.name.startsWith(b.name + ' (') && e.name.endsWith(')')) e.name = b.name;
      if (b && b.notes && typeof e.notes === 'string' && e.notes !== b.notes && e.notes.endsWith(GEN) && e.notes.slice(0, 16) === b.notes.slice(0, 16)) e.notes = b.notes;
    });
  if (p.pv.thermal_model !== 'noct') p.pv.thermal_model = 'uc_uv';
  // layout geometry from a file: bounded sizes and finite numbers only (the layout runs again from the areas when needed)
  const fin = (q) => Array.isArray(q) && q.length === 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1]);
  p.layout.polygons = (Array.isArray(p.layout.polygons) ? p.layout.polygons : []).filter((g) => g && Array.isArray(g.latlngs) && g.latlngs.length >= 3 && g.latlngs.length <= 5000 && g.latlngs.every(fin)).slice(0, 50);
  const LR = p.layout.result;
  if (LR && typeof LR === 'object' && !(Array.isArray(LR.tables) && LR.tables.length <= MAX_LAYOUT_TABLES && LR.tables.every((t) => Array.isArray(t) && t.length === 4 && t.every(fin)))) LR.tables = [];
  Report.cleanReport(p);
  // a daily load template that no longer exists: the stored 24 values become a custom shape
  if (!LOAD_TEMPLATES[p.load.template]) p.load.template = p.load._tpl = 'custom';
  // existing plant records (filled above for older projects): 12 monthly fuel values, null for a month without a record (blank
  // or zero, as the editor stores it)
  const mf = p.site_records.monthly_fuel_l;
  p.site_records.monthly_fuel_l = MONTHS.map((_, i) => (Array.isArray(mf) && typeof mf[i] === 'number' && isFinite(mf[i]) && mf[i] > 0 ? mf[i] : null));
}
let staleTimer = null;
function autosave() {
  Home.queueSave();   // saved projects go to disk through the engine
  // every edit passes here: the stale banners follow it on the pages that show them (debounced, the check stringifies the project)
  if (SIM && ($('#tab-sim').classList.contains('active') || $('#tab-fin').classList.contains('active'))) { clearTimeout(staleTimer); staleTimer = setTimeout(showSimStale, 300); }
}

let pvTimer = null;
const LAYOUT_KEYS = ['pv.tilt', 'pv.gcr', 'pv.mount', 'pv.module_length', 'pv.module_width', 'pv.module_wp', 'pv.azimuth', 'pv.azimuth_auto', 'pv.tracker_axis_azimuth'];
function onFieldChange(key) {
  autosave();
  if (key.startsWith('load.') && P.load.source === 'synthetic') { generateLoad(true); }
  if (key === 'location.lat' || key === 'location.lon') { Layout.moveMarker(); }
  if (key === 'location.utc_offset') { P.location.utc_offset_src = 'typed'; Layout.refreshInfo(); }
  if (key.startsWith('diesel.fuel') || key === 'diesel.min_load' || key === 'diesel.unit_kw') drawFuel();
  if (key === 'diesel.strategy') strategyHelp();
  if (key.startsWith('layout.') && key !== 'layout.result' && key !== 'layout.polygons' && key !== 'layout.base' || LAYOUT_KEYS.includes(key)) Layout.scheduleRelayout();
  if (key.startsWith('pv.') || (key.startsWith('location') && key !== 'location.utc_offset_src') || key === 'equipment.apply' || key === 'electrical.apply') {
    // Yield is cheap to recompute: refresh it automatically shortly after the last edit (applying datasheets or losses included).
    PVR = null; PVREF = null; clearTimeout(pvTimer);
    if (P.weather) { setStatus('#pvStatus', 'Recalculating…'); pvTimer = setTimeout(() => calcPV(true), 500); }
  }
  if (key === 'econ.currency') refreshAll();
  if (key.startsWith('wind.')) drawWind();
  if (key.startsWith('finance.')) Finance.onKey(key);
  if (key.startsWith('site_records.') && SIM) drawCalibration();   // records are not engine inputs: the check follows them
  // the data checks follow the site (timing against the sun) and the genset fleet (load unit check); 'location' alone is a site
  // picked on the map or a zone offset taken with Use
  if (/^location(\.(lat|lon|utc_offset))?$/.test(key) && P.weather && P.weather.qc) TsImport.qcLater('weather');
  if ((key === 'diesel.units' || key === 'diesel.unit_kw') && P.load.qc) TsImport.qcLater('load');
  if (SIM && $('#liveSim').checked && /^(pv|bess|aux|diesel|econ|ems|sim)\./.test(key) && $('#tab-sim').classList.contains('active')) runSim(true);
  syncWhatIf();
  updateChecks();
}

const STEP_ORDER = ['site', 'resource', 'load', 'pv', 'bess', 'diesel', 'econ', 'equip', 'elec', 'sim', 'opt', 'ems', 'fin', 'script', 'report'];
function setupTabs() {
  $$('#nav a').forEach((a) => a.addEventListener('click', () => showTab(a.dataset.tab)));
  // previous / next step buttons at the foot of every page
  const label = (t) => { const a = $(`#nav a[data-tab="${t}"]`); return a ? a.textContent.replace(/^\s*\d+\s*/, '').trim() : t; };
  STEP_ORDER.forEach((t, i) => {
    const sec = $('#tab-' + t);
    if (!sec || sec.querySelector('.step-nav')) return;
    const nav = document.createElement('div');
    nav.className = 'step-nav';
    const prev = STEP_ORDER[i - 1], next = STEP_ORDER[i + 1];
    nav.innerHTML = `${prev ? `<button class="btn ghost" data-go="${prev}">← <span>Back:</span> ${escapeHtml(label(prev))}</button>` : '<span></span>'}
      ${next ? `<button class="btn" data-go="${next}"><span>Next:</span> ${escapeHtml(label(next))} →</button>` : ''}`;
    sec.appendChild(nav);
  });
  $$('[data-go]').forEach((b) => (b.onclick = () => { showTab(b.dataset.go); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
}
function showTab(name) {
  Layout.exitFullScreen();   // a full-screen map would otherwise come back over the next page
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  Home.tabChanged(name);
  if (name === 'fin') { Finance.paint(); Finance.render(); }
  if (name === 'sim' || name === 'fin') showSimStale();
  if (name === 'site') setTimeout(Layout.invalidate, 50);
  if (name === 'report') { Report.renderFigures(); Report.preview(); }
  if (name === 'ems') drawForecast();
  if (name === 'equip') Equipment.render();
  if (name === 'elec') Electrical.render();
  if (name === 'pv') drawPvBalance();
  setTimeout(resizeVisibleCharts, 30);
}

function wireButtons() {
  $('#btnSave').onclick = exportProject;
  $('#btnRunTop').onclick = () => { showTab('sim'); runSim(); };
  $('#btnRun').onclick = () => runSim();
  $('#btnCsv').onclick = exportCsv;
  $('#btnOptions').onclick = runOptions;
  $('#btnTornado').onclick = runTornado;
  $('#tornadoMetric').onchange = (e) => { P.tornado.metric = e.target.value; autosave(); if (TORNADO) renderTornado(); };
  $('#tornadoFast').onchange = (e) => { P.tornado.fast = e.target.checked; autosave(); };
  $('#tornadoTogether').onchange = (e) => { P.tornado.bess_together = e.target.checked; autosave(); drawTornadoVars(true); };
  $('#tornadoAdd').onclick = () => { P.tornado.vars.push({ path: '', label: '', mode: 'x', lo: 0.8, hi: 1.2 }); autosave(); drawTornadoVars(true); };
  $('#tornadoReset').onclick = () => { P.tornado.vars = TORNADO_VARS(); autosave(); drawTornadoVars(true); };
  tornadoPathList();
  $('#btnFetchWx').onclick = fetchWeather;
  $('#btnRy').onclick = runResourceYears;
  $('#btnRyUse').onclick = ryApply;
  $('#ryBasis').onchange = (e) => { P.resource_years.basis = +e.target.value; autosave(); drawResourceYears(); };
  $('#fileWx').onchange = uploadWeather;
  $('#btnLoadGen').onclick = () => { P.load.source = 'synthetic'; P.load.import = null; P.load.qc = null; generateLoad(true); toast('Generated 8760-hour load profile'); };
  $('#fileLoad').onchange = uploadLoad;
  $('#btnPvCalc').onclick = () => calcPV();
  $('#btnTilt').onclick = tiltScan;
  $('#btnFuelAdd').onclick = () => { P.diesel.fuel_curve.push([1, 3.9]); drawFuel(); autosave(); };
  $('#weekSlider').oninput = () => { $('#weekGo').value = ''; drawDispatch(); };
  $('#weekGo').onchange = (e) => { const v = e.target.value; if (v !== '') { jump(+v); e.target.value = v; } };
  $('#btnOpt').onclick = runOpt;
  $('#btnOptAuto').onclick = suggestRanges;
  $('#heatMetric').onchange = drawOptHeat;
  $('#heatCrate').onchange = drawOptHeat;
  $('#btnApplyBest').onclick = () => OPT && OPT.best && applySize(OPT.best);
  $('#fcVar').onchange = drawForecast;
  $('#fcWeek').oninput = drawForecast;
  $('#btnSched').onclick = runSchedule;
  $('#btnSchedCsv').onclick = exportSchedule;
  $('#btnPrint').onclick = () => Report.printPdf();
  $('#btnRepHtml').onclick = () => Report.exportHtml();
  $('#btnRepPreview').onclick = () => Report.preview();
  $('#btnXlsx').onclick = () => Report.exportXlsx();
  $('#btnRepJson').onclick = () => $('#btnSave').click();
  Report.initFigures();
}

// Export .json (top bar, and Export on a project card of the landing page): a project file is made to be shared, so the API keys
// stay out of it. Autosave to the data folder keeps them.
const hasKeys = (p) => !!((p.layout && p.layout.google_key) || (p.sched && p.sched.api_key));
function withoutKeys(p) {
  const q = clone(p);
  if (q.layout) q.layout.google_key = '';
  if (q.sched) q.sched.api_key = '';
  return q;
}
function exportProject() {
  download((P.name || 'project').replace(/[^\w\- ]+/g, '_') + '.json', JSON.stringify(withoutKeys(P)), 'application/json');
  if (hasKeys(P)) toast('API keys were left out of the exported file');
}

function setProject(p) {
  P = p; migrate(P);
  if (!P.load.kw || P.load.source === 'synthetic') generateLoad(false);
  PVR = null; PVREF = null; SIM = null; SIM_PREV = null; OPT = null; SCHED = null; OPTIONS = null; TORNADO = null; ForecastLab.reset();
  $('#pvStats').innerHTML = ''; ['chPvLoss', 'chPvMonthly', 'chTilt'].forEach((id) => Plotly.purge(id));
  drawPvBalance(); $('#pvRef').hidden = true; pvRefSeq++;
  ['#wxStatus', '#ryStatus', '#loadStatus', '#pvStatus', '#simStatus', '#optStatus', '#schedStatus', '#optionsStatus', '#tornadoStatus'].forEach((s) => setStatus(s, ''));
  renderForms(P, onFieldChange);
  $('#projName').value = P.name || '';
  Layout.reload(P);
  Equipment.reload(P);
  Electrical.reload(P);
  setupEditors();
  refreshAll();
  autosave();
}

function refreshAll() {
  syncWhatIf();
  drawWind();
  drawWeather(); drawResourceYears(); drawLoad(); drawFuel(); strategyHelp(); updateChecks();
  $('#simEmpty').hidden = !!SIM; $('#simBody').hidden = !SIM;
  $('#optBody').hidden = !OPT; $('#emsEmpty').hidden = !!SIM; $('#emsBody').hidden = !SIM;
  $('#schedBody').hidden = !SCHED; $('#btnSchedCsv').hidden = !SCHED;
  if (SIM) renderSim();
  Finance.paint(); Finance.render();
}
function updateChecks() {
  const set = (k, ok) => { const d = $(`[data-check="${k}"]`); if (d) d.classList.toggle('ok', !!ok); };
  set('site', P.location && isFinite(P.location.lat));
  const site = $('[data-check="site"]'), tzWarn = !!(site && P.location && zoneCheck(P.location).warn);
  if (site) { site.classList.toggle('warn', tzWarn); site.title = tzWarn ? 'Check the UTC offset of the site' : ''; }
  set('resource', P.weather && P.weather.ghi && P.weather.ghi.length >= 8760);
  set('load', P.load.kw && P.load.kw.length === 8760);
  set('pv', !!PVR);
  // overall progress: the core inputs plus a simulation and a financial run
  const steps = [P.location && isFinite(P.location.lat), P.weather && P.weather.ghi, P.load.kw && P.load.kw.length === 8760, !!PVR, !!SIM, !!(SIM && SIM.finance)];
  const done = steps.filter(Boolean).length;
  $('#navBar').style.width = (100 * done / steps.length) + '%'; $('#navProgress').textContent = `${done} of ${steps.length} key steps done`;
}

// Project as the engine expects it (UI-only blocks stripped).
function engineProject(overrides) {
  const p = { name: P.name, location: engineLocation(P.location), weather: engineWeather(P.weather), load: { kw: P.load.kw, growth: P.load.growth },
              pv: P.pv, bess: P.bess, aux: P.aux, wind: P.wind, diesel: P.diesel, ems: P.ems, econ: P.econ, sim: P.sim, finance: P.finance };
  return overrides ? { ...p, ...overrides } : p;
}
// The weather without its import report and data checks (P.weather.import, P.weather.qc): they are not engine inputs, so they
// stay out of the request and of the fingerprints of results. Weather without them is passed on unchanged.
function engineWeather(W) {
  if (!W || (W.qc === undefined && W.import === undefined)) return W;
  const { qc, import: imp, ...w } = W;
  return w;
}
// The location without the GUI's time-zone fields (tz, utc_offset_src): the engine reads lat, lon and utc_offset, so where the
// offset came from neither reaches the engine nor makes a result stale.
function engineLocation(L) {
  if (!L || (L.tz === undefined && L.utc_offset_src === undefined)) return L;
  const { tz, utc_offset_src, ...loc } = L;
  return loc;
}
function requireInputs() {
  if (!P.weather || !P.weather.ghi) { toast('Get solar data first (tab 2 · Solar resource).', true); showTab('resource'); return false; }
  if (!P.load.kw || P.load.kw.length !== 8760) { toast('Define the load first (tab 3 · Load).', true); showTab('load'); return false; }
  return true;
}
async function busy(btn, fn) {
  const b = typeof btn === 'string' ? $(btn) : btn;
  const txt = b.textContent; b.disabled = true; b.textContent = '… ' + txt.replace(/^[^\w]+/, '');
  try { return await fn(); } finally { b.disabled = false; b.textContent = txt; }
}

// ---------------------------------------------------------------- weather
async function fetchWeather() {
  const src = P.weather_ui.source;
  setStatus('#wxStatus', 'Downloading hourly data… (PVGIS ~5 s, NASA POWER ~20 s)');
  await busy('#btnFetchWx', async () => {
    try {
      const w = await api('/api/weather', { source: src, lat: P.location.lat, lon: P.location.lon, year: P.weather_ui.year });
      P.weather = w;
      if (w.elevation) P.location.elevation = w.elevation;
      setStatus('#wxStatus', `✓ ${w.source}: ${w.note}`, 'ok');
      PVR = null; PVREF = null; drawWeather(); updateChecks(); autosave();
      TsImport.runQc('weather');
    } catch (e) { setStatus('#wxStatus', e.message, 'err'); }
  });
}
// Weather CSV: the import dialog (web/js/tsimport.js) previews it, reads it through the engine and shows the import report
// before the data replace P.weather.
async function uploadWeather(e) {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { await TsImport.open('weather', f); } catch (err) { setStatus('#wxStatus', err.message, 'err'); }
}
// UTC weather onto local standard time with the engine's weights (put_local in src/pv.hpp): for an offset n + f, local hour
// L = f x UTC hour L - n - 1 + (1 - f) x UTC hour L - n.
function localSeries(arr) {
  if (!P.weather || !P.weather.is_utc) return arr;
  const off = +P.location.utc_offset || 0, n = Math.floor(off), f = off - n, o = new Array(HOURS).fill(0);
  for (let i = 0; i < HOURS; i++) {
    o[(((i + n) % HOURS) + HOURS) % HOURS] += (1 - f) * arr[i];
    if (f > 0) o[(((i + n + 1) % HOURS) + HOURS) % HOURS] += f * arr[i];
  }
  return o;
}
function drawWeather() {
  const W = P.weather;
  if (!W || !W.ghi) {
    $('#wxStats').innerHTML = '<p class="hint">No data yet. Choose a database and press Fetch.</p>';
    $('#wxQc').innerHTML = '';
    ['chWxMonthly', 'chWxTemp', 'chWxHeat'].forEach((id) => Plotly.purge(id));
    return;
  }
  const ghi = localSeries(W.ghi), t = localSeries(W.tamb);
  const gm = monthlySum(ghi).map((x) => x / 1000);
  const tm = monthlySum(t).map((x, i) => x / (MDAYS[i] * 24));
  const tmax = new Array(12).fill(-99); t.forEach((v, i) => { const m = MONTH_OF_HOUR[i]; if (v > tmax[m]) tmax[m] = v; });
  $('#wxStats').innerHTML = kpis([
    ['Annual GHI', fmtNum(sum(ghi) / 1000, 0), 'kWh/m²·yr', true],
    ['Daily average', fmtNum(sum(ghi) / 1000 / 365, 2), 'kWh/m²·day'],
    ['Mean temperature', fmtNum(sum(t) / HOURS, 1), '°C'],
    ['Max temperature', fmtNum(maxOf(t), 1), '°C'],
    ['Mean wind', W.wind && W.wind.length ? fmtNum(sum(W.wind) / HOURS, 1) : '–', 'm/s'],
    ['Source', W.source, W.lat != null ? `${(+W.lat).toFixed(3)}, ${(+W.lon).toFixed(3)}` : ''],
  ]);
  const c = COL();
  monthlyBars('chWxMonthly', [{ name: 'GHI', y: gm, color: c.pv, unit: 'kWh/m²' }], 'kWh/m²');
  plot('chWxTemp', [
    { type: 'scatter', mode: 'lines+markers', name: 'Mean', x: MONTHS, y: tm, line: { color: c.gen, width: 2 }, marker: { size: 8 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Maximum', x: MONTHS, y: tmax, line: { color: c.unmet, width: 2 }, marker: { size: 8 } },
  ], { yaxis: { title: { text: '°C' } } });
  heatmap('chWxHeat', dayHourMatrix(ghi), '', [[0, c.surface2], [0.3, '#f6d27a'], [0.7, '#eda100'], [1, '#8a5a00']], 'W/m²', W.qc ? W.qc.days : null);
  $('#wxQc').innerHTML = TsImport.pageHtml('weather');
  TsImport.wire($('#wxQc'));
}

// ---------------------------------------------------------------- inter-annual variability (P50/P90)
// Year 1 of the plant simulated with every historical weather year (/api/resource-years, a background job). The summary is
// kept in P.resource_years.result; the weather years stay in the engine's memory.
const RY_METRICS = [['yield', 'Specific yield'], ['fuel_saved', 'Fuel saved'], ['re', 'Renewable fraction'], ['revenue', 'Revenue'], ['fuel_used', 'Fuel used']];
function ryFmt(k, v) {
  if (v == null || !isFinite(v)) return '–';
  return k === 'yield' ? fmtNum(v) + ' kWh/kWp' : k === 're' ? fmtPct(v) : k === 'revenue' ? fmtMoney(v, P.econ.currency) : fmtNum(v / 1000) + ' kL';
}
// Fingerprint of the run's inputs; the debt-sizing factor it sets does not make it stale. The run is saved with the project and
// the engine saves objects with sorted keys and numbers with 7 significant digits (%.7g), so the fingerprint is taken on that form
// and still matches after the project is reopened.
function ryKey() {
  const R = P.resource_years;
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(7) : v);
  return projectKey(canon({ ...engineProject({ finance: { ...P.finance, p90_factor: 1 } }), ry: [R.source, R.from, R.to, R.unc_dataset, R.unc_model, R.unc_soiling] }));
}
// Figures of the last run (shared by the card, the report and the workbook): table rows, the revenue P90/P50 factors, the
// factor in use for debt sizing when it still comes from this run, and how far the project weather is from the multi-year mean
// (dev = P50 ÷ mean − 1 of the specific yield, with its note and a warning above 2 %). That gap moves P50 and the whole base
// case, not the P90 ÷ P50 factors, which are ratios.
function resourceYearsSummary() {
  const X = P.resource_years.result, rev = X.stats.revenue, A = P.resource_years.applied, sy = X.stats.yield;
  const rows = RY_METRICS.map(([k, label]) => ({ k, label: k === 'revenue' ? (X.model === 'host' ? 'Revenue (avoided diesel cost)' : 'Revenue, year 1') : label, ...X.stats[k] }));
  const ratio = (v) => (rev.p50 > 0 ? Math.max(0, v / rev.p50) : null);
  const dev = sy.mean > 0 ? sy.p50 / sy.mean - 1 : null, db = `${X.database} ${X.range.from}–${X.range.to}`;
  const devNote = dev == null ? '' : `The project weather (${X.weather || 'not recorded'}) gives a specific yield ${fmtPct(Math.abs(dev))} ${dev >= 0 ? 'above' : 'below'} the multi-year mean of ${db}. P50 is on the project weather, so the gap moves P50 and the whole base case, but not the P90 ÷ P50 factors, which are ratios.`;
  // whether the project weather comes from the run's database: its label ends in "(db)" for PVGIS, or is "NASA POWER yyyy"
  const w = X.weather || '', tmy = /TMY/i.test(w);
  const same = X.database === 'NASA POWER' ? /^NASA POWER \d{4}$/.test(w) : w.includes(`(${X.database})`);
  const devWarn = dev == null || Math.abs(dev) <= 0.02 ? ''
    : tmy && same ? `The project weather is already a typical year from ${X.database}; the gap comes from its period and its choice of months against the mean of ${db}. Cross-check before relying on the base case.`
    : tmy ? `The project weather is already a typical year, so the gap is a difference between its database and ${X.database} at this site; cross-check them before relying on the base case.`
    : same ? `The P50 base case rests on a ${dev > 0 ? 'better' : 'poorer'} than average year; use a TMY or a long-term average weather file for the base case.`
    : `The P50 base case rests on weather ${dev > 0 ? 'better' : 'poorer'} than the multi-year mean of ${db}: an unusual year, a different database, or both. Use a TMY or a long-term average weather file for the base case.`;
  return { X, rows, f1: ratio(rev.p90_1), f10: ratio(rev.p90_10), applied: A && A.p90_factor === P.finance.p90_factor ? A : null, stale: X.key !== ryKey(),
           dev, devNote, devWarn };
}
async function runResourceYears() {
  if (!requireInputs()) return;
  const R = P.resource_years, key = ryKey(), t0 = performance.now();
  const body = { project: engineProject(), source: R.source, from: R.from, to: R.to, budget: { dataset: R.unc_dataset, model: R.unc_model, soiling: R.unc_soiling } };
  $('#btnRy').disabled = true; $('#btnRyCancel').hidden = false; $('#ryProg').hidden = false; $('#ryProg div').style.width = '0%';
  setStatus('#ryStatus', 'Starting…');
  try {
    const { job } = await api('/api/resource-years', body);
    $('#btnRyCancel').onclick = () => api('/api/job/cancel?id=' + job, {}, 'POST').catch(() => {});
    let res;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const s = await api('/api/job?id=' + job);
      if (s.done) { if (s.error) throw new Error(s.error); res = s.result; break; }
      $('#ryProg div').style.width = (100 * s.progress / Math.max(1, s.total)).toFixed(1) + '%';
      setStatus('#ryStatus', s.progress > 0 ? `${fmtNum(s.progress)} / ${fmtNum(s.total)} simulations…`
        : `Downloading the weather years from ${R.source === 'pvgis' ? 'PVGIS (about a minute)' : 'NASA POWER (about 20 s per three years)'}…`);
    }
    R.result = { ...res, key, model: P.finance.model, weather: P.weather.source, budget: body.budget, requested: { from: R.from, to: R.to } };
    autosave();
    setStatus('#ryStatus', `✓ ${res.years.length} weather years (${res.database} ${res.range.from}–${res.range.to}) simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
    drawResourceYears();
  } catch (e) { setStatus('#ryStatus', e.message, 'err'); toast(e.message, true); }
  finally { $('#btnRy').disabled = false; $('#btnRyCancel').hidden = true; $('#ryProg').hidden = true; }
}
function drawResourceYears() {
  const X = P.resource_years.result;
  $('#ryBody').hidden = !X;
  $('#ryBasis').value = P.resource_years.basis === 10 ? '10' : '1';
  if (!X) { Plotly.purge('chRy'); return; }
  const S = resourceYearsSummary(), c = COL(), yrs = X.years.map((y) => y.year), x0 = yrs[0] - 0.5, x1 = yrs[yrs.length - 1] + 0.5;
  // bars from 100 % (the multi-year mean); the worst year of each result is outlined
  const bars = (k, field, name, color) => {
    const st = X.stats[k];
    return { type: 'bar', name, x: yrs, base: 100, y: X.years.map((y) => (st.mean ? 100 * y[field] / st.mean - 100 : null)),
      marker: { color, cornerradius: 3, line: { color: c.unmet, width: yrs.map((y) => (y === st.worst_year ? 2.5 : 0)) } },
      customdata: X.years.map((y) => ryFmt(k, y[field])), hovertemplate: `%{x}: %{customdata}, %{y:+.1f} % from the mean<extra>${name}</extra>` };
  };
  const level = (name, v, color, dash) => ({ type: 'scatter', mode: 'lines', name, x: [x0, x1], y: [v, v], line: { color, width: 1.5, dash }, hovertemplate: `${name}: %{y:.1f} %<extra></extra>` });
  // P50 and P90 on the bars' basis: P50 is the project weather, which need not be an average year
  const rel = (k, q) => (X.stats[k].mean ? 100 * X.stats[k][q] / X.stats[k].mean : null);
  plot('chRy', [bars('yield', 'sy', 'Specific yield', c.pv), bars('fuel_saved', 'fuel_saved', 'Fuel saved', c.gen), level('Multi-year mean', 100, c.muted, 'solid'),
    level('P50, specific yield', rel('yield', 'p50'), c.pv, 'dot'), level('P50, fuel saved', rel('fuel_saved', 'p50'), c.gen, 'dot'),
    level('P90 1-yr, specific yield', rel('yield', 'p90_1'), c.pv, 'dash'), level('P90 1-yr, fuel saved', rel('fuel_saved', 'p90_1'), c.gen, 'dash')],
  { barmode: 'group', xaxis: { title: { text: 'Weather year' }, dtick: 1, range: [x0, x1] }, yaxis: { title: { text: '% of the multi-year mean' } } });
  const th = ['Result', 'P50', 'P75', 'P90 1-yr', 'P99 1-yr', 'P90 10-yr', 'Inter-annual σ', 'Elasticity', 'Worst year'];
  $('#ryTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${t}</th>`).join('')}</tr>${S.rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td>
    ${['p50', 'p75_1', 'p90_1', 'p99_1', 'p90_10'].map((q) => `<td>${escapeHtml(ryFmt(r.k, r[q]))}</td>`).join('')}<td>${fmtPct(r.sigma_iav)}</td>
    <td>${fmtNum(r.elasticity, 2)}</td><td>${r.worst_year} (${escapeHtml(ryFmt(r.k, r.worst))})</td></tr>`).join('')}</table>`;
  $('#ryFactor').textContent = S.f1 == null ? 'Revenue P50 is zero: no factor to apply.'
    : `Revenue P90 ÷ P50: ${fmtNum(S.f1, 3)} for one year, ${fmtNum(S.f10, 3)} for a 10-year average.${S.applied ? ` Debt sizing uses ${S.applied.p90_factor} (${S.applied.basis === 10 ? '10-year average' : 'one year'}).` : ''}`;
  const b = X.budget || {}, note = [];
  if (S.stale) note.push('⚠ The inputs have changed since this run: press Run weather years again.');
  note.push(`${X.years.length} weather years of ${escapeHtml(X.database)} ${X.range.from}–${X.range.to}${X.requested && (X.range.from > X.requested.from || X.range.to < X.requested.to) ? ' (the years the database covers)' : ''}.
    ${S.devNote ? escapeHtml(S.devNote) : `P50 is on the project's weather, ${escapeHtml(X.weather || '–')}.`}${S.devWarn ? ' ⚠ ' + escapeHtml(S.devWarn) : ''}
    Systematic uncertainty ${fmtPct(X.sigma_sys)} (root-sum-square of ${fmtPct(b.dataset)}, ${fmtPct(b.model)} and ${fmtPct(b.soiling)}), scaled by each result's elasticity: its relative change per relative change of irradiance at P50.
    The 10-year values assume independent years. The worst year of each result is outlined in red.`);
  if (P.wind && P.wind.units > 0) note.push('With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource.');
  if (X.note) note.push(escapeHtml(X.note));
  $('#ryNote').innerHTML = note.join(' ');
}
// Sets the debt-sizing haircut (Project finance) to the revenue P90 ÷ P50 of the last run.
function ryApply() {
  if (!P.resource_years.result) return;
  const S = resourceYearsSummary(), basis = P.resource_years.basis === 10 ? 10 : 1, f = basis === 10 ? S.f10 : S.f1;
  if (f == null) { toast('Revenue P50 is zero: no factor to apply.', true); return; }
  const v = Math.round(f * 1e4) / 1e4;
  P.finance.p90_factor = v;
  P.resource_years.applied = { p90_factor: v, basis, database: S.X.database, from: S.X.range.from, to: S.X.range.to };
  syncForms(P); onFieldChange('finance.p90_factor'); drawResourceYears();
  toast(`Debt sizing now uses revenue × ${v} (P90 of ${basis === 10 ? 'a 10-year average' : 'one year'}). Run the financial analysis to update it.`);
}

// ---------------------------------------------------------------- load
function setupEditors() {
  const de = $('#dailyEditor'); de.innerHTML = '';
  P.load.daily.forEach((v, h) => {
    const d = document.createElement('div');
    d.innerHTML = `<span>${String(h).padStart(2, '0')}:00</span><input type="number" step="any" value="${+(+v).toFixed(2)}" data-h="${h}">`;
    de.appendChild(d);
  });
  $$('input', de).forEach((inp) => {
    inp.addEventListener('change', () => { P.load.daily[+inp.dataset.h] = Math.max(0, +inp.value || 0); P.load.template = 'custom'; syncForms(P); P.load.source = 'synthetic'; generateLoad(true); autosave(); });
    inp.addEventListener('paste', (e) => {
      const nums = (e.clipboardData.getData('text').match(/-?\d+(\.\d+)?/g) || []).map(Number);
      if (nums.length < 2) return;
      e.preventDefault();
      const h0 = +inp.dataset.h;
      nums.slice(0, 24 - h0).forEach((n, k) => (P.load.daily[h0 + k] = Math.max(0, n)));
      P.load.template = 'custom'; P.load.source = 'synthetic'; setupEditors(); syncForms(P); generateLoad(true); autosave();
    });
  });
  const me = $('#monthlyEditor'); me.innerHTML = '';
  P.load.monthly.forEach((v, m) => {
    const d = document.createElement('div');
    d.innerHTML = `<span>${MONTHS[m]}</span><input type="number" step="0.01" value="${+v}" data-m="${m}">`;
    me.appendChild(d);
  });
  $$('input', me).forEach((inp) => inp.addEventListener('change', () => { P.load.monthly[+inp.dataset.m] = Math.max(0, +inp.value || 0); P.load.source = 'synthetic'; generateLoad(true); autosave(); }));
  // monthly fuel of the existing plant records (Diesel & control); a blank or zero cell is a month without a record (null)
  const re = $('#recFuelEditor'); re.innerHTML = '';
  P.site_records.monthly_fuel_l.forEach((v, m) => {
    const d = document.createElement('div');
    d.innerHTML = `<span>${MONTHS[m]}</span><input type="number" step="any" min="0" value="${v > 0 ? +v : ''}" data-m="${m}" aria-label="Fuel in ${MONTHS[m]} (L)">`;
    re.appendChild(d);
  });
  const recSet = (m, s) => { const v = Number(s); P.site_records.monthly_fuel_l[m] = s !== '' && isFinite(v) && v > 0 ? v : null; };
  const recDone = () => { autosave(); if (SIM) drawCalibration(); };
  $$('input', re).forEach((inp) => {
    inp.addEventListener('change', () => {
      const m = +inp.dataset.m;
      recSet(m, inp.value.trim());
      if (P.site_records.monthly_fuel_l[m] == null) inp.value = '';   // a typed zero is no record either
      recDone();
    });
    // values pasted from a spreadsheet row or column: cells split on tabs and line breaks (blank cells kept, so only the final
    // line break is dropped), thousands separators dropped
    inp.addEventListener('paste', (e) => {
      const t = e.clipboardData.getData('text'), cells = /[\t\n]/.test(t) ? t.replace(/\r?\n$/, '').split(/\t|\r?\n/) : t.trim().split(/[\s;]+/);
      if (cells.length < 2) return;
      e.preventDefault();
      const m0 = +inp.dataset.m;
      cells.slice(0, 12 - m0).forEach((c, k) => recSet(m0 + k, c.replace(/[,\s]/g, '')));
      setupEditors(); recDone();
    });
  });
}

// Synthetic load: daily shape x month factor x weekend factor x random day and hour perturbations.
function generateLoad(redraw) {
  const L = P.load;
  const tpl = LOAD_TEMPLATES[L.template];
  if (tpl && tpl.shape && L._tpl !== L.template) {
    const peak = maxOf(L.daily) > 0 ? maxOf(L.daily) : 1000;
    L.daily = tpl.shape.map((s) => +(s * peak).toFixed(3));
    L._tpl = L.template;
    if ($('#dailyEditor').children.length) setupEditors();
  }
  const R = rng(L.seed || 1), out = new Array(HOURS);
  for (let d = 0; d < 365; d++) {
    const dayF = 1 + (L.var_day || 0) * R.normal();
    const weekend = d % 7 >= 5;
    for (let h = 0; h < 24; h++) {
      const i = d * 24 + h;
      const v = L.daily[h] * L.monthly[MONTH_OF_HOUR[i]] * (weekend ? L.weekend_factor : 1) * dayF * (1 + (L.var_hour || 0) * R.normal());
      out[i] = Math.max(0, v);
    }
  }
  if (L.target_avg > 0) { const k = L.target_avg / (sum(out) / HOURS); for (let i = 0; i < HOURS; i++) out[i] *= k; }
  L.kw = out.map((x) => Math.round(x * 100) / 100);
  if (redraw) { drawLoad(); updateChecks(); autosave(); }
}
// Load CSV: the import dialog (web/js/tsimport.js) previews it, reads it through the engine and shows the import report before
// the data replace P.load.kw.
async function uploadLoad(e) {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { await TsImport.open('load', f); } catch (err) { setStatus('#loadStatus', err.message, 'err'); }
}
function drawLoad() {
  const kw = P.load.kw; if (!kw) return;
  const tot = sum(kw), peak = maxOf(kw), avg = tot / HOURS;
  $('#loadStats').innerHTML = kpis([
    ['Annual energy', fmtEnergy(tot), '', true], ['Average load', fmtPower(avg), ''], ['Peak load', fmtPower(peak), ''],
    ['Load factor', fmtPct(avg / peak), ''], ['Daily energy', fmtEnergy(tot / 365), 'average'],
    ['Source', P.load.source === 'csv' ? 'Measured (CSV)' : 'Synthetic', P.load.source === 'csv' ? '' : (LOAD_TEMPLATES[P.load.template] || {}).name || ''],
  ]);
  if (P.load.source !== 'csv') setStatus('#loadStatus', 'Synthetic profile, regenerated when you edit the shape or settings.');
  const c = COL();
  const mean = new Array(24).fill(0), mx = new Array(24).fill(0), mn = new Array(24).fill(Infinity);
  for (let i = 0; i < HOURS; i++) { const h = i % 24; mean[h] += kw[i] / 365; mx[h] = Math.max(mx[h], kw[i]); mn[h] = Math.min(mn[h], kw[i]); }
  const hrs = Array.from({ length: 24 }, (_, h) => h);
  plot('chLoadDaily', [
    { type: 'scatter', mode: 'lines', name: 'Min', x: hrs, y: mn, line: { width: 0, shape: 'hv' }, showlegend: false, hoverinfo: 'skip' },
    { type: 'scatter', mode: 'lines', name: 'Range (min–max)', x: hrs, y: mx, fill: 'tonexty', fillcolor: c.surface2, line: { width: 0, shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>max</extra>' },
    { type: 'scatter', mode: 'lines', name: 'Average day', x: hrs, y: mean, line: { color: c.load, width: 2, shape: 'hv' }, hovertemplate: '%{x}:00 %{y:,.0f} kW<extra>average</extra>' },
  ], { xaxis: { title: { text: 'Hour of day' }, dtick: 3 }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } });
  monthlyBars('chLoadMonthly', [{ name: 'Energy', y: monthlySum(kw).map((x) => x / 1000), color: c.gen, unit: 'MWh' }], 'MWh');
  const measured = P.load.source === 'csv';
  heatmap('chLoadHeat', dayHourMatrix(kw), '', null, 'kW', measured && P.load.qc ? P.load.qc.days : null);
  $('#loadQc').innerHTML = measured ? TsImport.pageHtml('load') : '';
  TsImport.wire($('#loadQc'));
}

// ---------------------------------------------------------------- PV
async function calcPV(quiet) {
  if (!P.weather) { if (!quiet) { toast('Get solar data first.', true); showTab('resource'); } return; }
  await busy('#btnPvCalc', async () => {
    try {
      PVR = await api('/api/pv', engineProject());
      const kwp = P.pv.capacity_kwp;
      setStatus('#pvStatus', '✓ Yield calculated', 'ok');
      $('#pvStats').innerHTML = kpis([
        ['Specific yield', fmtNum(PVR.specific_yield, 0), 'kWh/kWp·yr', true],
        ['Annual energy', fmtEnergy(PVR.specific_yield * kwp), `for ${fmtNum(kwp)} kWp`],
        ['Performance ratio', fmtPct(PVR.performance_ratio), 'on plane-of-array'],
        ['Plane-of-array irr.', fmtNum(PVR.poa_annual, 0), 'kWh/m²·yr'],
        ['Capacity factor', fmtPct(PVR.specific_yield / 8760), 'DC basis'],
        ['Peak AC output', fmtPower(maxOf(PVR.ac_per_kwp) * kwp), ''],
      ]);
      lossChart('chPvLoss', PVR.losses);
      const c = COL();
      monthlyBars('chPvMonthly', [{ name: 'Yield', y: monthlySum(PVR.ac_per_kwp), color: c.pv, unit: 'kWh/kWp' }], 'kWh/kWp');
      drawPvBalance();
      pvReference();
      updateChecks();
      if ($('#tab-elec').classList.contains('active')) Electrical.render(true);   // P99.9 cell temperature of the string sizing
    } catch (e) { setStatus('#pvStatus', e.message, 'err'); }
  });
}
// Monthly PV energy curtailed (Lu) and used (load and battery) in kWh/kWp from the last simulation, or null when that
// simulation does not match the PV capacity or the yield shown (PV inputs changed since).
function pvUse() {
  const H = SIM && SIM.result.hourly, kwp = SIM && SIM.result.size.pv_kwp;
  if (!PVR || !H || !(kwp > 0) || Math.abs(kwp - P.pv.capacity_kwp) > 1e-6 * kwp || Math.abs(sum(H.pv_avail) / kwp / PVR.specific_yield - 1) > 1e-6) return null;
  return { lu: monthlySum(H.pv_curtailed).map((x) => x / kwp), used: monthlySum(H.pv_to_load.map((v, i) => v + H.pv_to_bess[i])).map((x) => x / kwp) };
}
// Monthly PV balances (shared by the PV page, the report and the workbook): irradiation in kWh/m², energy in kWh/kWp,
// normalised production in kWh/kWp/day (Yr = GlobInc, Ya = EArray, Yf = E_avail; Lc = Yr − Ya, Ls = Ya − Yf) and the PR.
// With a matching simulation, Lu = curtailed PV and prUsed = PV used ÷ GlobInc. The last row is the year.
function pvBalance() {
  const M = PVR && PVR.monthly;
  if (!M) return null;
  const U = pvUse(), row = (label, i, days) => {
    const g = (k) => (i < 12 ? M[k][i] : sum(M[k]));
    const x = { label, days, ghi: g('ghi'), dhi: g('dhi'), tamb: i < 12 ? M.tamb[i] : sum(M.tamb.map((t, m) => t * MDAYS[m])) / 365, poa: g('poa'), eff: g('eff'),
                earray: g('earray'), eavail: g('eavail'), lu: U ? (i < 12 ? U.lu[i] : sum(U.lu)) : null, used: U ? (i < 12 ? U.used[i] : sum(U.used)) : null };
    return Object.assign(x, { pr: x.poa > 0 ? x.eavail / x.poa : null, prUsed: U && x.poa > 0 ? x.used / x.poa : null,
      yr: x.poa / days, ya: x.earray / days, yf: x.eavail / days });
  };
  return { rows: MONTHS.map((m, i) => row(m, i, MDAYS[i])).concat([row('Year', 12, 365)]), sim: !!U, stale: !!(SIM && SIM.result.size.pv_kwp > 0 && !U) };
}
function drawPvBalance() {
  const B = pvBalance();
  $('#pvBalCard').hidden = !B;
  if (!B) { Plotly.purge('chPvNorm'); return; }
  const kwp = P.pv.capacity_kwp, c = COL(), dE = kwp >= 1000 ? 0 : kwp >= 100 ? 1 : 2, mo = B.rows.slice(0, 12);
  const th = ['', 'GlobHor kWh/m²', 'DiffHor kWh/m²', 'T_amb °C', 'GlobInc kWh/m²', 'GlobEff kWh/m²', 'EArray MWh', 'E_avail MWh', 'PR'];
  $('#pvBalTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${t}</th>`).join('')}</tr>${B.rows.map((x) => `<tr${x.label === 'Year' ? ' class="total"' : ''}>
    <td>${x.label}</td><td>${fmtNum(x.ghi, 1)}</td><td>${fmtNum(x.dhi, 1)}</td><td>${fmtNum(x.tamb, 1)}</td><td>${fmtNum(x.poa, 1)}</td><td>${fmtNum(x.eff, 1)}</td>
    <td>${fmtNum(x.earray * kwp / 1000, dE)}</td><td>${fmtNum(x.eavail * kwp / 1000, dE)}</td><td>${fmtPct(x.pr)}</td></tr>`).join('')}</table>`;
  const bar = (name, y, color) => ({ type: 'bar', name, x: MONTHS, y, marker: { color }, hovertemplate: '%{x}: %{y:.2f} kWh/kWp/day<extra>' + name + '</extra>' });
  const line = (name, y, dash) => ({ type: 'scatter', mode: 'lines+markers', name, x: MONTHS, y: y.map((v) => v * 100), yaxis: 'y2', line: { color: c.text, width: 2, dash }, marker: { size: 6 },
    hovertemplate: '%{x}: %{y:.1f} %<extra>' + name + '</extra>' });
  const prs = mo.map((x) => x.pr).concat(B.sim ? mo.map((x) => x.prUsed) : []).filter((v) => v != null);
  plot('chPvNorm', [
    bar(B.sim ? 'Yf: PV energy used' : 'Yf: final yield', mo.map((x) => (B.sim ? x.used / x.days : x.yf)), c.pv),
    ...(B.sim ? [bar('Lu: unused (curtailed)', mo.map((x) => x.lu / x.days), c.curt)] : []),
    bar('Ls: system losses', mo.map((x) => x.ya - x.yf), c.muted),
    bar('Lc: array capture losses', mo.map((x) => x.yr - x.ya), c.text2 + '66'),
    line('PR', mo.map((x) => x.pr)),
    ...(B.sim ? [line('PR delivered', mo.map((x) => x.prUsed), 'dot')] : []),
  ], { barmode: 'stack', yaxis: { title: { text: 'kWh/kWp/day' } },
       yaxis2: { title: { text: 'Performance ratio (%)' }, overlaying: 'y', side: 'right', showgrid: false, range: [prs.length ? Math.max(0, Math.floor(Math.min(...prs) * 10 - 1) * 10) : 0, 100] } });
  $('#pvBalNote').textContent = B.stale ? 'The last simulation does not match the current PV inputs: run it again to add the unused energy Lu and the delivered PR.' : '';
}
// Independent check of the yield against PVGIS PVcalc (long-term average of the PVGIS radiation database), run after every
// yield calculation. PVGIS is asked again only when the site or orientation changes. No line when offline.
let pvRefSeq = 0;
async function pvReference() {
  const seq = ++pvRefSeq, el = $('#pvRef');
  try {
    const r = await api('/api/pv-reference', engineProject());
    if (seq !== pvRefSeq) return;
    PVREF = r;
    el.textContent = pvRefText(r).join(' ');
    el.hidden = false;
  } catch (e) {
    if (seq !== pvRefSeq) return;
    PVREF = null;
    const offline = /^(Download failed|Cannot reach)/.test(e.message);
    el.textContent = offline ? '' : 'PVGIS reference not available: ' + e.message;
    el.hidden = offline;
  }
}
// The PVGIS comparison as sentences (PV page and report).
function pvRefText(r) {
  const out = [`PVGIS reference ${fmtNum(r.pvgis_ey)} kWh/kWp, Soloptima comparable ${fmtNum(r.soloptima_ey)} kWh/kWp (${r.diff >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.diff) * 100, 1)} %).`];
  if (Math.abs(r.diff) > 0.08) out.push('⚠ More than 8 % apart: check the weather data, the loss inputs and the thermal model.');
  out.push(`Comparable means without row shading and inverter clipping, which PVGIS does not model${r.tracker ? ', and true tracking without backtracking or a rotation limit' : ''}; PVGIS gets the losses it does not model itself as its system loss (${fmtNum(r.loss_pct, 1)} %). PVGIS uses its own thermal and spectral models and the ${r.radiation_db} average of ${r.year_min}–${r.year_max}.`);
  const wx = (P.weather && P.weather.source) || '';
  if (!/^PVGIS/.test(wx)) out.push('Not like for like: the weather data of this project is not from PVGIS.');
  else if (!/^PVGIS TMY/.test(wx)) out.push(`Not like for like: the weather data of this project is a single PVGIS year, PVGIS the ${r.year_min}–${r.year_max} average, so part of the gap is that year's weather.`);
  return out;
}
async function tiltScan() {
  if (!P.weather) { toast('Get solar data first.', true); return; }
  await busy('#btnTilt', async () => {
    try {
      const r = await api('/api/tilt-scan', engineProject());
      const best = r.points.reduce((a, b) => (b[1] > a[1] ? b : a));
      const c = COL();
      plot('chTilt', [{ type: 'scatter', mode: 'lines+markers', x: r.points.map((p) => p[0]), y: r.points.map((p) => p[1]), line: { color: c.pv, width: 2 }, marker: { size: 8 }, hovertemplate: '%{x}°: %{y:,.0f} kWh/kWp<extra></extra>' },
                       { type: 'scatter', mode: 'markers+text', x: [best[0]], y: [best[1]], text: [`best ${best[0]}°`], textposition: 'top center', marker: { size: 12, color: c.accent }, hoverinfo: 'skip' }],
           { showlegend: false, xaxis: { title: { text: 'Tilt (°)' } }, yaxis: { title: { text: 'kWh/kWp' } }, margin: { l: 56, r: 16, t: 28, b: 40 } });
      toast(`Best tilt ${best[0]}° → ${fmtNum(best[1])} kWh/kWp (row shading at the current GCR included)`);
    } catch (e) { toast(e.message, true); }
  });
}

// Wind resource preview: hub-height speed and per-turbine energy from the weather file.
function drawWind() {
  const W = P.weather, w = P.wind;
  if (!W || !W.wind || !W.wind.length) { $('#windStats').textContent = 'Fetch weather data to see the wind resource.'; Plotly.purge('chWind'); return; }
  const sh = Math.pow(Math.max(1, w.hub_height) / Math.max(1, w.ref_height), w.shear_alpha);
  const pc = (v) => (v < w.v_in || v >= w.v_out ? 0 : v >= w.v_rated ? w.rated_kw : w.curve === 'linear' ? w.rated_kw * (v - w.v_in) / (w.v_rated - w.v_in)
    : w.rated_kw * (v ** 3 - w.v_in ** 3) / (w.v_rated ** 3 - w.v_in ** 3));
  const vh = W.wind.map((v) => Math.max(0, v) * sh);
  const e = vh.map((v) => pc(v) * (1 - w.losses) * w.availability);
  const c = COL();
  plot('chWind', [{ type: 'bar', name: 'Energy per turbine', x: MONTHS, y: monthlySum(e).map((x) => x / 1000), marker: { color: c.wind, cornerradius: 4 }, hovertemplate: '%{x}: %{y:,.1f} MWh<extra></extra>' }],
       { showlegend: false, yaxis: { title: { text: 'MWh per turbine' } } });
  $('#windStats').textContent = `Mean speed ${fmtNum(sum(W.wind) / W.wind.length, 2)} m/s at ${w.ref_height} m → ${fmtNum(sum(vh) / vh.length, 2)} m/s at hub; capacity factor ${fmtPct(sum(e) / (w.rated_kw * HOURS))}; ${fmtNum(sum(e) / 1000)} MWh/yr per turbine${w.units ? `, ${fmtNum(sum(e) * w.units / 1000)} MWh/yr for ${w.units} turbines` : ''}.`;
}

// ---------------------------------------------------------------- diesel
function drawFuel() {
  const box = $('#fuelTable');
  const D = P.diesel;
  if (D.fuel_model === 'table') {
    box.innerHTML = `<table class="data"><tr><th>Load (%)</th><th>Efficiency (kWh/L)</th><th>Fuel (L/h per unit)</th><th></th></tr>${
      D.fuel_curve.map(([lf, ef], i) => `<tr><td><input type="number" step="1" value="${+(lf * 100).toFixed(2)}" data-i="${i}" data-c="0" style="width:80px"></td>
        <td><input type="number" step="0.01" value="${+ef}" data-i="${i}" data-c="1" style="width:90px"></td>
        <td>${fmtNum(lf * D.unit_kw / ef, 1)}</td><td><button class="btn small ghost" data-del="${i}">✕</button></td></tr>`).join('')}</table>`;
    $$('input', box).forEach((inp) => inp.addEventListener('change', () => {
      const i = +inp.dataset.i, c = +inp.dataset.c; let v = +inp.value;
      if (c === 0) v /= 100;
      D.fuel_curve[i][c] = v; D.fuel_curve.sort((a, b) => a[0] - b[0]); drawFuel(); autosave();
    }));
    $$('[data-del]', box).forEach((b) => b.addEventListener('click', () => { if (D.fuel_curve.length > 2) { D.fuel_curve.splice(+b.dataset.del, 1); drawFuel(); autosave(); } }));
    $('#btnFuelAdd').hidden = false;
  } else { box.innerHTML = '<p class="hint">Fuel (L/h) = intercept × rated kW + slope × output kW.</p>'; $('#btnFuelAdd').hidden = true; }
  const xs = Array.from({ length: 19 }, (_, i) => 0.1 + i * 0.05);
  const rate = (lf) => {
    if (D.fuel_model === 'linear') return D.fuel_intercept + D.fuel_slope * lf;
    const pts = D.fuel_curve.map(([l, e]) => [l, l / e]).sort((a, b) => a[0] - b[0]);
    let j = 1; while (j < pts.length - 1 && lf > pts[j][0]) j++;
    const [x0, y0] = pts[j - 1], [x1, y1] = pts[j];
    return Math.max(0, y0 + (y1 - y0) * (lf - x0) / (x1 - x0));
  };
  const c = COL();
  plot('chFuel', [{ type: 'scatter', mode: 'lines', name: 'Efficiency', x: xs.map((x) => x * 100), y: xs.map((x) => x / rate(x)), line: { color: c.gen, width: 2 }, hovertemplate: '%{x:.0f} %: %{y:.2f} kWh/L<extra></extra>' },
                    ...(D.fuel_model === 'table' ? [{ type: 'scatter', mode: 'markers', name: 'Datasheet points', x: D.fuel_curve.map((p) => p[0] * 100), y: D.fuel_curve.map((p) => p[1]), marker: { color: c.gen, size: 9 } }] : [])],
       { xaxis: { title: { text: 'Loading (% of rating)' } }, yaxis: { title: { text: 'kWh per litre' } }, showlegend: false,
         shapes: [{ type: 'line', x0: D.min_load * 100, x1: D.min_load * 100, yref: 'paper', y0: 0, y1: 1, line: { color: c.unmet, dash: 'dot', width: 1.5 } }] });
}
function strategyHelp() {
  const s = P.diesel.strategy;
  const txt = {
    load_following: 'Load following: PV first, battery covers the deficit, gensets only produce what the load needs. Genset minimum loading can force PV curtailment.',
    cycle_charging: 'Cycle charging: the battery covers the deficit as in load following until it is empty (or until gensets at minimum loading plus PV cover the load); the running gensets then charge it from their spare capacity up to the SOC setpoint, and until it gets there it discharges only to cover load the gensets cannot. No genset is started only to charge. The battery then carries load again so fewer gensets run. Each cycle loses 1 − RTE of its energy.',
    predictive: 'Predictive EMS: every re-plan interval the EMS forecasts PV and load, then dynamic programming over the battery SOC chooses charge/discharge set-points and genset commitment that minimise fuel, run-hours and battery wear across the horizon. In real time the battery compensates forecast errors only where that avoids an unplanned genset start; gensets take the rest.',
  }[s];
  $('#strategyHelp').textContent = txt || '';
  $('#emsBox').hidden = s !== 'predictive';
}

// ---------------------------------------------------------------- simulation
let SIM_PREV = null, simBusy = false, simQueued = false, simDone = null;
async function runSim(quiet) {
  if (simBusy) { simQueued = true; return simDone; }   // settles after the queued run, so an awaited call ends on the latest inputs
  if (!requireInputs()) return;
  setStatus('#simStatus', 'Simulating…');
  simBusy = true;
  let done;
  simDone = new Promise((r) => (done = r));
  await busy('#btnRun', async () => {
    try {
      // The request is built once and the result keeps its fingerprint and snapshot, so an edit made while the engine runs
      // marks the result stale.
      const t0 = performance.now(), allYears = !!P.sim.all_years, key = sizingKey(), req = engineProject(), inKey = simKey(req), snap = inputSnapshot(simInputs(req));
      const res = await api('/api/simulate', req);
      res.all_years = allYears; res.sizing_key = key;   // basis of the NPC, to compare with an optimisation result
      res.key = inKey; res.snap = snap;
      SIM_PREV = SIM; SIM = res;
      Home.queueSave();   // the landing-page badges follow the new result
      setStatus('#simStatus', `✓ ${P.sim.all_years ? P.econ.lifetime + ' years' : 'Year 1'} simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
      $('#simEmpty').hidden = true; $('#simBody').hidden = false; $('#emsEmpty').hidden = true; $('#emsBody').hidden = false;
      renderSim();
    } catch (e) { setStatus('#simStatus', e.message, 'err'); if (!quiet) toast(e.message, true); }
  });
  simBusy = false;
  if (simQueued) { simQueued = false; await runSim(true); }
  done();
}
// Engine inputs of a simulation: without the name and the site elevation, which the engine does not read (engineProject already
// leaves out the zone name and where the offset came from).
function simInputs(p) {
  const { elevation, ...location } = p.location || {};
  return { ...p, name: '', location };
}
// Fingerprint of the engine inputs of a simulation.
const simKey = (p) => projectKey(simInputs(p));
// The result on show is from other inputs. Stringifies the engine project (about 0.6 MB, a few ms): call it on render, tab change,
// report build and project save, never per keystroke.
const simStale = () => !!SIM && SIM.key !== simKey(engineProject());
// Inputs changed after the run on show, as a list of the first n ('' when none can be named).
const simChanges = (n) => (SIM ? diffList(inputDiff(SIM.snap, inputSnapshot(simInputs(engineProject()))), n) : '');
// Banners on Simulation results and Project finance while the result on show is from other inputs.
function showSimStale() {
  const stale = simStale(), list = stale ? simChanges(6) : '';
  for (const id of ['#simStale', '#finStale']) {
    const el = $(id);
    el.hidden = !stale;
    if (!stale) continue;
    el.innerHTML = `⚠ ${escapeHtml(list ? `The inputs changed after this run: ${list}.` : 'The inputs changed after this run.')} The results below are from the earlier inputs.
      <button type="button" class="btn small">Run again</button>`;
    $('button', el).onclick = async () => { await runSim(); if ($('#tab-fin').classList.contains('active')) Finance.render(); };
  }
}

// Live what-if sliders (Simulation tab) are bound directly to the project values.
function setupWhatIf() {
  const bind = (id, set, fmt) => {
    const el = $('#' + id);
    el.addEventListener('input', () => { set(+el.value); $('#' + id + 'V').textContent = fmt(+el.value); syncForms(P); autosave(); if ($('#liveSim').checked && SIM) runSim(true); });
  };
  bind('wiPv', (v) => (P.pv.capacity_kwp = v), (v) => fmtNum(v) + ' kWp');
  bind('wiBe', (v) => { const cr = P.bess.energy_kwh > 0 ? P.bess.power_kw / P.bess.energy_kwh : 0.5; P.bess.energy_kwh = v; P.bess.power_kw = Math.round(v * cr); }, (v) => fmtNum(v) + ' kWh');
  bind('wiCr', (v) => (P.bess.power_kw = Math.round(P.bess.energy_kwh * v)), (v) => v.toFixed(2) + ' C');
  bind('wiFp', (v) => (P.econ.fuel_price = v), (v) => P.econ.currency + ' ' + v.toFixed(2) + '/L');
  $$('#wiStrat button').forEach((b) => b.addEventListener('click', () => {
    P.diesel.strategy = b.dataset.v; syncForms(P); strategyHelp(); syncWhatIf(); autosave(); runSim(!!SIM);
  }));
  syncWhatIf();
}
function syncWhatIf() {
  const avg = P.load.kw ? sum(P.load.kw) / HOURS : 1000;
  const pvMax = Math.max(3 * P.pv.capacity_kwp, P.optimizer.pv_max || 0, (P.layout.result && P.layout.result.kwp) || 0, 2 * avg, 100);
  const beMax = Math.max(3 * P.bess.energy_kwh, P.optimizer.bess_max || 0, 12 * avg, 100);
  const set = (id, max, step, v, txt) => { const el = $('#' + id); if (max) { el.max = max; el.step = step; } if (document.activeElement !== el) el.value = v; $('#' + id + 'V').textContent = txt; };
  const stepOf = (m) => Math.pow(10, Math.max(0, Math.floor(Math.log10(m)) - 2));
  set('wiPv', Math.ceil(pvMax), stepOf(pvMax), P.pv.capacity_kwp, fmtNum(P.pv.capacity_kwp) + ' kWp');
  set('wiBe', Math.ceil(beMax), stepOf(beMax), P.bess.energy_kwh, fmtNum(P.bess.energy_kwh) + ' kWh');
  const cr = P.bess.energy_kwh > 0 ? P.bess.power_kw / P.bess.energy_kwh : 0.5;
  set('wiCr', 0, 0, cr, cr.toFixed(2) + ' C');
  const fpMax = Math.max(3, 3 * P.econ.fuel_price), fpStep = Math.pow(10, Math.floor(Math.log10(fpMax)) - 2);
  $('#wiFp').min = Math.max(0.2, fpStep);
  set('wiFp', fpMax, fpStep, P.econ.fuel_price, P.econ.currency + ' ' + (+P.econ.fuel_price).toFixed(2) + '/L');
  $$('#wiStrat button').forEach((b) => b.classList.toggle('on', b.dataset.v === P.diesel.strategy));
}
// Change vs previous run, as a short "▲ +1.2 pp" text. better: +1 if higher is better, -1 if lower is better.
function delta(cur, prev, fmt, better) {
  if (prev == null || cur == null || !isFinite(cur) || !isFinite(prev)) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9 * Math.max(1, Math.abs(prev))) return '= same as last run';
  const good = d * better > 0;
  return `${good ? '▲' : '▼'} ${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} vs last run`;
}
// items: [label, value, subtitle, hero (true, or 'bad' for a value shown in red), change vs last run]
// A tile value: the number large, a leading currency code and the unit after the last digit small, on one line
function kpiValue(v) {
  const t = String(v == null ? '' : v), last = t.search(/\d[^\d]*$/);
  if (last < 0) return escapeHtml(t);
  const cur = (t.match(/^[A-Z]{3}\s/) || [''])[0], num = t.slice(cur.length, last + 1), unit = t.slice(last + 1);
  return `${cur ? `<span class="u">${escapeHtml(cur.trim())}</span> ` : ''}${escapeHtml(num)}${unit ? `<span class="u">${escapeHtml(unit)}</span>` : ''}`;
}
function kpis(items) {
  return items.map(([l, v, s, hero, d]) => `<div class="kpi${hero === 'bad' ? ' bad' : hero ? ' hero' : ''}"><div class="l">${escapeHtml(l)}</div><div class="v" title="${escapeHtml(v)}">${kpiValue(v)}</div><div class="s">${escapeHtml(s || '')}</div>${
    d ? `<div class="d ${d.startsWith('▲') ? 'up' : d.startsWith('▼') ? 'down' : ''}">${escapeHtml(d)}</div>` : ''}</div>`).join('');
}
function renderSim() {
  const R = SIM.result, B = SIM.baseline, C = SIM.comparison, cur = P.econ.currency, y1 = R.years[0], b1 = B.years[0];
  const PR = SIM_PREV ? SIM_PREV.result : null, PC = SIM_PREV ? SIM_PREV.comparison : null;
  const aux1 = y1.aux || 0;   // auxiliary consumption, part of the load
  // The battery's own value against the same PV and wind without it, and against the cheapest PV-only design of the last optimisation
  // (PV only at the hybrid's kWp usually curtails more than an optimised PV-only design, which flatters the battery).
  const CB = SIM.comparison_bess, PCB = SIM_PREV && SIM_PREV.comparison_bess, pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
  const pvBest = CB && OPT && OPT.ranked ? OPT.ranked.filter((r) => r.bess_kwh < 1e-6).reduce((a, r) => (!a || r.npc < a.npc ? r : a), null) : null;
  const pvGap = pvBest && OPT.all_years === SIM.all_years && OPT.sizing_key === SIM.sizing_key ? pvBest.npc - R.econ.npc : null;
  $('#simKpis').innerHTML = kpis([
    ['Renewable fraction', fmtPct(R.re_fraction), 'year 1', true, PR && delta(R.re_fraction * 100, PR.re_fraction * 100, (x) => x.toFixed(1) + ' pp', 1)],
    ['Fuel saved', fmtNum(C.fuel_saved_l_y1 / 1000, 0) + ' kL', fmtPct(C.fuel_saved_l_y1 / B.fuel_l_y1) + ' vs diesel-only', true, PC && delta(C.fuel_saved_l_y1 / 1000, PC.fuel_saved_l_y1 / 1000, (x) => fmtNum(x) + ' kL', 1)],
    ['LCOE', `${cur} ${fmtNum(R.econ.lcoe, 4)}`, `diesel-only ${fmtNum(C.lcoe_base, 4)} /kWh`, true, PR && delta(R.econ.lcoe, PR.econ.lcoe, (x) => fmtNum(x, 4), -1)],
    ['NPV of savings', fmtMoney(C.npv_savings, cur), 'hybrid vs diesel-only', false, PC && delta(C.npv_savings, PC.npv_savings, (x) => fmtMoney(x, cur), 1)],
    ['IRR', C.irr == null ? '–' : fmtPct(C.irr), 'on incremental investment', false, PC && PC.irr != null && C.irr != null ? delta(C.irr * 100, PC.irr * 100, (x) => x.toFixed(1) + ' pp', 1) : ''],
    ['Payback', C.payback_years == null ? '> life' : fmtNum(C.payback_years, 1) + ' yr', 'simple, nominal'],
    ...(CB ? [['Battery adds', fmtMoney(CB.npv_savings, cur), `NPV vs ${pvLbl} · IRR ${CB.irr == null ? '–' : fmtPct(CB.irr)} · fuel ${CB.fuel_saved_l_y1 >= 0 ? '−' : '+'}${fmtNum(Math.abs(CB.fuel_saved_l_y1) / 1000, 0)} kL/yr`,
      CB.npv_savings < 0 ? 'bad' : false, PCB && delta(CB.npv_savings, PCB.npv_savings, (x) => fmtMoney(x, cur), 1)]] : []),
    ...(pvBest ? [['Best PV-only design', fmtNum(pvBest.pv_kwp) + ' kWp', pvGap == null
      ? `NPC ${fmtMoney(pvBest.npc, cur)} from the last optimisation (${OPT.all_years !== SIM.all_years ? (OPT.all_years ? 'every project year' : 'year 1 only') : 'other inputs'}), not comparable with this run`
      : `NPC ${fmtMoney(pvBest.npc, cur)} from the last optimisation; hybrid ${fmtMoney(Math.abs(pvGap), cur)} ${pvGap >= 0 ? 'lower' : 'higher'}`, pvGap != null && pvGap < 0 ? 'bad' : false]] : []),
    ['Capex (excl. gensets)', fmtMoney(R.econ.capex_pv + R.econ.capex_bess + R.econ.capex_wind + R.econ.capex_other, cur), ''],
    ['CO₂ avoided', fmtNum(C.co2_saved_t_y1, 0) + ' t/yr', ''],
    ['PV curtailed', fmtPct(R.curtail_fraction), fmtEnergy(y1.pv_curtailed)],
    ['Unmet load', fmtPct(R.unmet_fraction, 3), fmtEnergy(y1.unmet)],
    ['Genset run-hours', fmtNum(y1.unit_hours, 0), `${fmtNum(b1.unit_hours - y1.unit_hours, 0)} fewer · ${fmtNum(y1.starts)} starts`],
    ['Battery cycles', fmtNum(y1.bess_efc, 0) + ' /yr', `${R.bess_replacements} replacement(s)`],
    ['Auxiliary consumption', fmtNum(aux1 / 1000, 1) + ' MWh/yr', aux1 > 0 ? fmtPct(aux1 / (y1.load - aux1), 2) + ' of site load' : 'none set (Battery tab)'],
  ]);
  // the inputs behind the change of the tiles
  const changed = SIM_PREV && SIM_PREV.snap ? inputDiff(SIM_PREV.snap, SIM.snap) : null;
  $('#simChanged').hidden = !changed;
  if (changed) $('#simChanged').textContent = changed.length ? `Changed since the previous run: ${diffList(changed)}.` : 'No input changed since the previous run.';
  showSimStale();
  drawCalibration();
  const Mt = R.metrics || {};
  const worst = R.years.reduce((a, y) => (y.lol_h > a.lol_h ? y : a), y1);   // year with the most loss-of-load hours (load growth)
  $('#simMetrics').innerHTML = kpis([
    ['Loss-of-load hours', fmtNum(y1.lol_h) + ' h', `${fmtNum(y1.lol_events)} events, longest ${fmtNum(y1.lol_max_h)} h${worst.lol_h > y1.lol_h ? ` · ${fmtNum(worst.lol_h)} h in year ${worst.year}` : ''}`, y1.lol_h > 0 ? 'bad' : false],
    ['Reserve shortfall', fmtNum(y1.reserve_short_h) + ' h', `max ${fmtNum(y1.reserve_short_max_kw)} kW · diesel-only ${fmtNum(b1.reserve_short_h)} h, max ${fmtNum(b1.reserve_short_max_kw)} kW`, y1.reserve_short_h > 0 ? 'bad' : false],
    ['Gensets needed', `${fmtNum(y1.max_units)} of ${fmtNum(P.diesel.units)}`, `diesel-only ${fmtNum(b1.max_units)} · whole fleet online ${fmtNum(y1.fleet_full_h)} h`],
    ['Low-load running', fmtNum(y1.minload_h) + ' h', `every online unit at minimum · longest run ${fmtNum(y1.minload_run_max_h)} h`],
    ['LPSP', fmtPct(Mt.lpsp, 3), 'loss of power supply'], ['REP (reliability)', fmtNum(Mt.rep, 2) + ' %', '100 (1 − LPSP)'],
    ['SSSI', fmtPct(Mt.sssi), 'direct RE use / load'], ['SSCI', fmtPct(Mt.ssci), 'direct RE use / RE available'],
    ['Excess energy', fmtEnergy(Mt.excess_kwh), fmtPct(Mt.excess_fraction) + ' of load'],
    ['CO₂ / NOx / SOx', `${fmtNum(Mt.co2_t)} t`, `${fmtNum(Mt.nox_kg)} kg NOx · ${fmtNum(Mt.sox_kg)} kg SOx`],
    ['Jobs created', fmtNum(Mt.jobs, 1), 'job-years (factor method)'], ['HDI', Mt.hdi == null ? '–' : Mt.hdi.toFixed(3), Mt.hdi == null ? 'set population in Costs' : 'from per-capita electricity'],
    ['TAC', fmtMoney(R.econ.tac, cur) + '/yr', `CRF ${fmtNum(R.econ.crf, 4)}`], ['COE', `${cur} ${fmtNum(R.econ.coe, 4)}/kWh`, 'TAC / energy served to the site (yr 1)'],
  ]);
  const c = COL();
  const hasWind = y1.wind_avail > 0, hasAux = aux1 > 0;
  // Auxiliaries are part of the load the sources serve: shown as a consumption bar, not added to the supply.
  const mixNames = ['PV → load', ...(hasWind ? ['Wind used'] : []), 'Battery → load', 'Diesel → load', ...(hasAux ? ['Auxiliaries (own use)'] : []), 'RE curtailed', 'Unmet'];
  const mixVals = [y1.pv_to_load, ...(hasWind ? [y1.wind_used] : []), y1.bess_dis, y1.gen_to_load, ...(hasAux ? [aux1] : []), y1.pv_curtailed + (y1.wind_curtailed || 0), y1.unmet].map((x) => x / 1000);
  plot('chMix', [{ type: 'bar', orientation: 'h', y: mixNames.slice().reverse(), x: mixVals.slice().reverse(),
                   marker: { color: [c.pv, ...(hasWind ? [c.wind] : []), c.bess, c.gen, ...(hasAux ? [c.load] : []), c.curt, c.unmet].reverse(), cornerradius: 4 },
                   text: mixVals.slice().reverse().map((v) => fmtEnergy(v * 1000)), textposition: 'auto', textfont: { color: c.text },
                   hovertemplate: '%{y}: %{x:,.0f} MWh<extra></extra>' }],
       { xaxis: { title: { text: 'MWh (year 1)' } }, showlegend: false, margin: { l: 10, r: 10, t: 10, b: 40 } });

  // With a battery the table adds PV only (same PV and wind), and the last column is what the battery adds (hybrid − PV only).
  const V = SIM.pv_only, VA = V || { econ: {} }, v1 = V ? V.years[0] : {};
  const row = (l, a, v, b, f) => `<tr><td>${l}</td><td>${f(a)}</td>${V ? `<td>${f(v)}</td>` : ''}<td>${f(b)}</td><td>${f(b - (V ? v : a))}</td></tr>`;
  $('#cmpTitle').textContent = V ? `Hybrid vs diesel only and ${pvLbl}` : 'Hybrid vs diesel-only';
  $('#cmpTable').innerHTML = `<table class="data cmp${V ? ' four' : ''}"><tr><th></th><th>Diesel only</th>${V ? `<th>${pvLbl}</th>` : ''}<th>Hybrid</th>${V ? '<th title="Hybrid − PV only">Battery adds</th>' : '<th>Change</th>'}</tr>
    ${row('Fuel (L/yr)', b1.fuel_l, v1.fuel_l, y1.fuel_l, (x) => fmtNum(x))}
    ${row('Diesel energy (MWh/yr)', b1.gen_kwh / 1000, v1.gen_kwh / 1000, y1.gen_kwh / 1000, (x) => fmtNum(x))}
    ${row('Genset run-hours', b1.unit_hours, v1.unit_hours, y1.unit_hours, (x) => fmtNum(x))}
    ${row('Genset starts', b1.starts, v1.starts, y1.starts, (x) => fmtNum(x))}
    ${row('Avg genset loading (%)', B.avg_gen_load * 100, VA.avg_gen_load * 100, R.avg_gen_load * 100, (x) => fmtNum(x, 1))}
    ${row('CO₂ (t/yr)', b1.co2_t, v1.co2_t, y1.co2_t, (x) => fmtNum(x))}
    ${row('Fuel cost yr 1 (' + cur + ')', b1.c_fuel, v1.c_fuel, y1.c_fuel, (x) => fmtNum(x))}
    ${row('Capex (' + cur + ')', B.econ.capex_total, VA.econ.capex_total, R.econ.capex_total, (x) => fmtNum(x))}
    ${row('Net present cost (' + cur + ')', B.econ.npc, VA.econ.npc, R.econ.npc, (x) => fmtNum(x))}
    ${row('LCOE (' + cur + '/kWh)', B.econ.lcoe, VA.econ.lcoe, R.econ.lcoe, (x) => fmtNum(x, 4))}</table>`;
  renderOptions();

  const H = R.hourly;
  const ms = (a) => monthlySum(a).map((x) => x / 1000);
  plot('chMonthly', [
    { type: 'bar', name: 'PV → load', x: MONTHS, y: ms(H.pv_to_load), marker: { color: c.pv } },
    ...(hasWind ? [{ type: 'bar', name: 'Wind → load', x: MONTHS, y: ms(H.wind_to_load), marker: { color: c.wind } }] : []),
    { type: 'bar', name: 'Battery → load', x: MONTHS, y: ms(H.bess_dis), marker: { color: c.bess } },
    { type: 'bar', name: 'Diesel → load', x: MONTHS, y: ms(H.gen_to_load), marker: { color: c.gen } },
    { type: 'bar', name: 'Unmet', x: MONTHS, y: ms(H.unmet), marker: { color: c.unmet } },
    { type: 'bar', name: 'RE curtailed', x: MONTHS, y: ms(hasWind ? H.pv_curtailed.map((v, i) => v + H.wind_curtailed[i]) : H.pv_curtailed), marker: { color: c.curt } },
  ].map((t) => ({ ...t, hovertemplate: '%{x}: %{y:,.0f} MWh<extra>' + t.name + '</extra>' })).concat(hasAux && H.aux ? [
    // part of the supply above, drawn below zero so it is not counted twice
    { type: 'bar', name: 'Auxiliaries (own use)', x: MONTHS, y: ms(H.aux).map((v) => -v), customdata: ms(H.aux), marker: { color: c.load }, hovertemplate: '%{x}: %{customdata:,.1f} MWh<extra>Auxiliaries (own use)</extra>' },
  ] : []), { barmode: 'relative', yaxis: { title: { text: 'MWh' } } });
  const MB = monthBalance(R), dM = (v) => fmtNum(v / 1000, MB[12].load >= 1e7 ? 0 : 1);
  const mth = ['', 'Load MWh', 'PV direct', ...(hasWind ? ['Wind direct'] : []), 'Battery → load', 'Diesel → load', 'Unmet', 'RE curtailed', 'Genset dump', 'Fuel kL', 'RE fraction'];
  $('#simMonthTable').innerHTML = `<table class="data"><tr>${mth.map((t) => `<th>${t}</th>`).join('')}</tr>${MB.map((x) => `<tr${x.label === 'Year' ? ' class="total"' : ''}>
    <td>${x.label}</td><td>${dM(x.load)}</td><td>${dM(x.pv)}</td>${hasWind ? `<td>${dM(x.wind)}</td>` : ''}<td>${dM(x.bess)}</td><td>${dM(x.gen)}</td><td>${dM(x.unmet)}</td>
    <td>${dM(x.curt)}</td><td>${dM(x.dump)}</td><td>${fmtNum(x.fuel / 1000)}</td><td>${fmtPct(x.re)}</td></tr>`).join('')}</table>`;
  drawFlow();
  if ($('#tab-pv').classList.contains('active')) drawPvBalance();   // Lu and the delivered PR; also redrawn when the PV page opens

  drawDispatch();
  const picks = weekPicks(R);
  $('#weekGo').innerHTML = '<option value="">Go to…</option>' + WEEK_PICKS.filter(([k]) => picks[k] != null)
    .map(([k, l]) => `<option value="${picks[k]}">${l}: ${dateOfHour(picks[k])} to ${dateOfHour(picks[k] + 167)}</option>`).join('');
  // genset loading histogram (unit-hours by loading band)
  const bands = new Array(10).fill(0), Pr = P.diesel.unit_kw;
  for (let t = 0; t < HOURS; t++) {
    const u = H.gen_units[t]; if (!u) continue;
    const lf = (H.gen_to_load[t] + H.gen_to_bess[t] + H.gen_dump[t]) / (u * Pr);
    bands[Math.min(9, Math.floor(lf * 10))] += u;
  }
  plot('chGenLoad', [{ type: 'bar', x: bands.map((_, i) => `${i * 10}–${i * 10 + 10}%`), y: bands, marker: { color: c.gen, cornerradius: 4 }, hovertemplate: '%{x}: %{y:,.0f} unit-hours<extra></extra>' }],
       { xaxis: { title: { text: 'Loading per online unit' } }, yaxis: { title: { text: 'Unit-hours' } }, showlegend: false,
         shapes: [{ type: 'line', x0: P.diesel.min_load * 10 - 0.5, x1: P.diesel.min_load * 10 - 0.5, yref: 'paper', y0: 0, y1: 1, line: { color: c.unmet, dash: 'dot' } }] });
  // units online duration curve: every hour of year 1 sorted from most to fewest gensets online
  const dur = (a) => Array.from(Float64Array.from(a).sort().reverse()), hrs = Array.from({ length: HOURS }, (_, i) => i + 1), BH = SIM.baseline_hourly;
  plot('chUnitsDur', [
    ...(BH && BH.gen_units ? [{ type: 'scatter', mode: 'lines', name: 'Diesel only', x: hrs, y: dur(BH.gen_units), line: { color: c.unmet, width: 2, dash: 'dot', shape: 'hv' }, hovertemplate: '%{x:,} h: %{y} units<extra>Diesel only</extra>' }] : []),
    { type: 'scatter', mode: 'lines', name: 'Hybrid', x: hrs, y: dur(H.gen_units), line: { color: c.gen, width: 2, shape: 'hv' }, hovertemplate: '%{x:,} h: %{y} units<extra>Hybrid</extra>' },
  ], { xaxis: { title: { text: 'Hours of the year' }, range: [0, HOURS] }, yaxis: { title: { text: 'Gensets online' }, rangemode: 'tozero' } });
  if (P.bess.energy_kwh > 0) heatmap('chSocHeat', dayHourMatrix(H.soc, 100), '', [[0, c.surface2], [0.5, '#9085e9'], [1, '#3d2e9e']], '%');
  else { Plotly.purge('chSocHeat'); $('#chSocHeat')._drill = false; }
  // Drill-down: click a day in the heatmap or a month bar to open that week in the dispatch chart.
  const el = $('#chSocHeat');
  if (el.on && !el._drill) { el._drill = true; el.on('plotly_click', (ev) => jump((ev.points[0].x - 1) * 24)); }
  const mel = $('#chMonthly');
  if (mel.on && !mel._drill) { mel._drill = true; mel.on('plotly_click', (ev) => jump(MDAYS.slice(0, MONTHS.indexOf(ev.points[0].x)).reduce((a, b) => a + b, 0) * 24)); }

  drawBessHealth();
  renderTornado();
  const yrs = R.years.map((y) => y.year);
  const cf = (k) => R.years.map((y) => -y[k]);
  plot('chCash', [
    { type: 'bar', name: 'Capex', x: [0], y: [-R.econ.capex_total], marker: { color: c.text2 } },
    { type: 'bar', name: 'Fuel', x: yrs, y: cf('c_fuel'), marker: { color: c.gen } },
    { type: 'bar', name: 'O&M', x: yrs, y: cf('c_om'), marker: { color: c.bess } },
    { type: 'bar', name: 'Replacements', x: yrs, y: cf('c_replace'), marker: { color: c.soc } },
    { type: 'bar', name: 'Salvage', x: yrs, y: cf('c_salvage'), marker: { color: c.pv } },
    { type: 'scatter', mode: 'lines', name: 'Diesel-only fuel + O&M', x: B.years.map((y) => y.year), y: B.years.map((y) => -y.c_total), line: { color: c.unmet, dash: 'dot', width: 2 } },
  ].map((t) => ({ ...t, hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra>' + t.name + '</extra>' })), { barmode: 'relative', yaxis: { title: { text: cur + ' (negative = cost)' } }, xaxis: { title: { text: 'Project year' } } });

  const th = ['Year', 'Load MWh', 'PV used MWh', 'Curtailed MWh', 'BESS out MWh', 'Diesel MWh', 'Fuel kL', 'RE %', 'Unmet MWh', 'LOL h', 'Reserve short h', 'Unit-h', 'SOH %', 'EFC', 'Repl.', 'Cost ' + cur];
  $('#yearTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${t}</th>`).join('')}</tr>${R.years.map((y) => `<tr>
    <td>${y.year}</td><td>${fmtNum(y.load / 1000)}</td><td>${fmtNum((y.pv_to_load + y.pv_to_bess) / 1000)}</td><td>${fmtNum(y.pv_curtailed / 1000)}</td>
    <td>${fmtNum(y.bess_dis / 1000)}</td><td>${fmtNum(y.gen_kwh / 1000)}</td><td>${fmtNum(y.fuel_l / 1000)}</td><td>${fmtNum(y.re_fraction * 100, 1)}</td>
    <td>${fmtNum(y.unmet / 1000, 1)}</td><td>${fmtNum(y.lol_h)}</td><td>${fmtNum(y.reserve_short_h)}</td><td>${fmtNum(y.unit_hours)}</td><td>${fmtNum(y.bess_soh * 100, 1)}</td><td>${fmtNum(y.bess_efc)}</td><td>${y.bess_replaced ? '●' : ''}</td><td>${fmtNum(y.c_total)}</td></tr>`).join('')}</table>`;
  if ($('#tab-ems').classList.contains('active')) drawForecast();
  if ($('#tab-fin').classList.contains('active')) Finance.render();
  updateChecks();
}
// Monthly energy balance of year 1 (kWh, fuel in L), 12 months and the year: load = PV + wind + battery + diesel to the load
// + unmet; RE fraction as the engine computes it. Shared by the Monthly energy supply card, the report and the workbook.
function monthBalance(R) {
  const H = R.hourly, z = new Array(HOURS).fill(0), ms = (a) => monthlySum(a || z);
  const k = { load: ms(H.load), pv: ms(H.pv_to_load), wind: ms(H.wind_to_load), bess: ms(H.bess_dis), gen: ms(H.gen_to_load), gch: ms(H.gen_to_bess), unmet: ms(H.unmet),
              curt: ms(H.pv_curtailed.map((v, i) => v + (H.wind_curtailed ? H.wind_curtailed[i] : 0))), dump: ms(H.gen_dump), fuel: ms(H.fuel_l) };
  const row = (label, f) => {
    const x = { label };
    for (const [key, a] of Object.entries(k)) x[key] = f(a);
    const served = x.load - x.unmet;
    x.re = served > 0 ? Math.min(1, Math.max(0, 1 - (x.gen + x.gch) / served)) : 0;
    return x;
  };
  return MONTHS.map((m, i) => row(m, (a) => a[i])).concat([row('Year', sum)]);
}
// Year-1 energy flow (Sankey): sources, the battery and the load, and where the energy ends. Battery losses close the battery's
// own balance: charged − discharged − self-discharge − change in stored energy. Shared by the Energy flow card and the report.
function energyFlow(y) {
  const dE = y.e_end - y.e_start, loss = y.bess_ch - y.bess_dis - y.self_discharge - dE, aux = y.aux || 0;
  const thru = y.bess_ch + y.bess_dis, showDE = Math.abs(dE) > 1e-3 * thru, reUsed = y.pv_to_load + y.pv_to_bess + y.wind_to_load + y.wind_to_bess;
  const inp = y.pv_avail + y.wind_avail + y.gen_kwh + y.unmet - Math.min(0, dE);
  const out = y.load + y.pv_curtailed + y.wind_curtailed + y.gen_dump + loss + y.self_discharge + Math.max(0, dE);
  return { dE, loss, aux, thru, showDE, inp, out, gap: inp - out, direct: reUsed > 0 ? (y.pv_to_load + y.wind_to_load) / reUsed : null };
}
function drawFlow() {
  const y = SIM.result.years[0], F = energyFlow(y), c = COL(), wind = y.wind_avail > 0;
  const S = { pv: ['PV available', c.pv], wind: ['Wind available', c.wind], gen: ['Gensets', c.gen], unmet: ['Unmet (not served)', c.unmet], drawn: ['Drawn from storage', c.soc],
              bess: ['Battery', c.bess], load: ['Load', c.load], curt: ['Curtailed', c.curt], dump: ['Genset dump (minimum loading)', c.curt], loss: ['Battery losses', c.bess + '99'],
              sd: ['Self-discharge', c.bess + '99'], stored: ['Added to storage', c.soc], site: ['Site load', c.load], aux: ['Auxiliaries', c.load + '99'] };
  const nodes = [], idx = {}, links = [];
  const node = (k) => { if (idx[k] == null) { idx[k] = nodes.length; nodes.push({ label: S[k][0], color: S[k][1] }); } return idx[k]; };
  const L = (a, b, v) => { if (v > 1e-6 * Math.max(1, y.load)) links.push([node(a), node(b), v / 1000]); };
  L('pv', 'load', y.pv_to_load); L('pv', 'bess', y.pv_to_bess); L('pv', 'curt', y.pv_curtailed);
  if (wind) { L('wind', 'load', y.wind_to_load); L('wind', 'bess', y.wind_to_bess); L('wind', 'curt', y.wind_curtailed); }
  L('gen', 'load', y.gen_to_load); L('gen', 'bess', y.gen_to_bess); L('gen', 'dump', y.gen_dump);
  L('unmet', 'load', y.unmet);
  if (F.showDE && F.dE < 0) L('drawn', 'bess', -F.dE);
  L('bess', 'load', y.bess_dis); L('bess', 'loss', F.loss); L('bess', 'sd', y.self_discharge);
  if (F.showDE && F.dE > 0) L('bess', 'stored', F.dE);
  if (F.aux > 0) { L('load', 'site', y.load - F.aux); L('load', 'aux', F.aux); }
  plot('chFlow', [{ type: 'sankey', arrangement: 'snap', valueformat: ',.0f', valuesuffix: ' MWh',
    node: { label: nodes.map((n) => n.label), color: nodes.map((n) => n.color), pad: 16, thickness: 16, line: { width: 0 },
            hovertemplate: '%{label}: %{value:,.0f} MWh<extra></extra>' },
    link: { source: links.map((l) => l[0]), target: links.map((l) => l[1]), value: links.map((l) => l[2]), color: links.map((l) => nodes[l[0]].color.slice(0, 7) + '55'),
            hovertemplate: '%{source.label} → %{target.label}: %{value:,.0f} MWh<extra></extra>' } }],
    { margin: { l: 10, r: 10, t: 10, b: 10 } });
  const bess = y.bess_ch > 0 || y.bess_dis > 0;
  $('#flowKpis').innerHTML = kpis([
    ...(F.direct != null ? [['Direct RE share', fmtPct(F.direct), `of the ${wind ? 'PV and wind' : 'PV'} used${bess ? '; the rest is stored first' : ' (no battery)'}`, true]] : []),
    ...(bess ? [['Battery losses', fmtEnergy(F.loss), y.bess_ch > 0 ? `${fmtPct(F.loss / y.bess_ch)} of the energy charged` : 'on discharge only (nothing charged)'],
      ...(y.self_discharge > 0 ? [['Self-discharge', fmtEnergy(y.self_discharge), '']] : []),
      ['Stored-energy change', fmtEnergy(F.dE), 'end of year 1 − start']] : []),
  ]);
  const note = [];
  if (Math.abs(F.gap) > 1e-3 * y.load) note.push(`⚠ Inputs and outputs differ by ${fmtEnergy(F.gap)} (${fmtPct(F.gap / y.load, 2)} of the load).`);
  if (bess && !F.showDE) note.push(`The change in stored energy (${fmtEnergy(F.dE)}) is below 0.1 % of the battery throughput and is not drawn.`);
  $('#flowNote').textContent = note.join(' ');
}

// ---------------------------------------------------------------- diesel-only baseline against the site's records
// Every result is measured against the modelled diesel-only case, so the existing plant's records (Diesel & control) check it.
// Rows: [key, label, unit, tolerance]; a difference beyond the tolerance is flagged.
const CAL_ROWS = [['load', 'Site load', 'MWh/yr', 0.03], ['peak', 'Peak load', 'kW', 0.05], ['gen', 'Genset generation', 'MWh/yr', 0.03],
  ['fuel', 'Fuel', 'L/yr', 0.05], ['sfc', 'Specific fuel consumption', 'L/kWh', 0.05], ['hours', 'Genset run hours, all units', 'h/yr', 0.1]];
const calFmt = (k, v) => (k === 'sfc' ? fmtNum(v, 3) : (k === 'load' || k === 'gen') && v < 100 ? fmtNum(v, 1) : fmtNum(v));
const calPct = (d) => (d == null || !isFinite(d) ? '–' : Math.abs(d) < 5e-4 ? fmtPct(0) : `${d > 0 ? '+' : '−'}${fmtPct(Math.abs(d))}`);
// The diesel-only case of the last simulation (year 1, no auxiliary loads) against the records, with only the records that have a
// value (above zero); differences are model ÷ site − 1. The diagnosis follows fixed rules and is never applied to the model.
// Shared by the Simulation results card, the report and the workbook; null without a simulation or a record.
function calibration() {
  const S = P.site_records;
  if (!SIM || !S) return null;
  const given = (v) => typeof v === 'number' && isFinite(v) && v > 0;
  const b = SIM.baseline.years[0], H = SIM.result.hourly, BH = SIM.baseline_hourly;
  // the run's own year-1 site load (hourly load less the auxiliaries), so the check stays with the run when the load is edited later
  const peak = H && H.load ? maxOf(H.load.map((v, i) => v - (H.aux ? H.aux[i] : 0))) : null;
  const site = { load: S.annual_load_mwh, peak: S.peak_kw, gen: S.annual_gen_mwh, fuel: S.annual_fuel_l, hours: S.unit_hours,
                 sfc: given(S.annual_fuel_l) && given(S.annual_gen_mwh) ? S.annual_fuel_l / (1000 * S.annual_gen_mwh) : null };
  const model = { load: b.load / 1000, peak, gen: b.gen_kwh / 1000, fuel: b.fuel_l, hours: b.unit_hours, sfc: b.gen_kwh > 0 ? b.fuel_l / b.gen_kwh : null };
  const rows = CAL_ROWS.filter(([k]) => given(site[k]) && model[k] != null).map(([k, label, unit, tol]) => {
    const d = model[k] / site[k] - 1;
    return { k, label, unit, tol, site: site[k], model: model[k], d, flag: Math.abs(d) > tol + 1e-9 };   // 1e-9: not on rounding noise at the limit
  });
  // monthly fuel: CV(RMSE) over the months with a record, and the months more than 15 % off
  const mf = Array.isArray(S.monthly_fuel_l) ? S.monthly_fuel_l : [], mm = BH && BH.fuel_l ? monthlySum(BH.fuel_l) : null;
  const months = mm ? MONTHS.map((label, i) => ({ label, site: given(mf[i]) ? mf[i] : null, model: mm[i], d: given(mf[i]) ? mm[i] / mf[i] - 1 : null })) : [];
  const rec = months.filter((x) => x.site != null), off = rec.filter((x) => Math.abs(x.d) > 0.15);
  const cv = rec.length ? Math.sqrt(sum(rec.map((x) => (x.model - x.site) ** 2)) / rec.length) / (sum(rec.map((x) => x.site)) / rec.length) : null;
  if (!rows.length && !rec.length) return null;

  const r = Object.fromEntries(rows.map((x) => [x.k, x])), diag = [];
  const sfcFix = !!(r.gen && !r.gen.flag && r.sfc && r.sfc.flag);
  if (sfcFix) {
    const f = r.sfc.site / r.sfc.model;   // factor on the fuel per kWh at every loading that matches the records
    diag.push(`Generation matches the records but the specific fuel consumption does not (model ${calPct(r.sfc.d)}): check the fuel curve. A fuel curve ${fmtPct(Math.abs(f - 1))} ${f > 1 ? 'higher' : 'lower'} would match the records (${P.diesel.fuel_model === 'linear' ? 'intercept and slope' : 'fuel per kWh at every loading'} × ${fmtNum(f, 3)}${P.diesel.fuel_model === 'linear' ? '' : `, the efficiencies in kWh/L ÷ ${fmtNum(f, 3)}`}).`);
  }
  if (r.load && !r.load.flag && r.fuel && r.fuel.flag && !sfcFix)
    diag.push(`The site load matches the records but the fuel does not (model ${calPct(r.fuel.d)}): check the fuel curve and the number of units online (spinning reserve, units always online).`);
  if (r.hours && r.hours.flag && r.hours.model > 0 && r.hours.site > r.hours.model)   // the run-hours row is beyond its tolerance
    diag.push(`The records show ${fmtPct(r.hours.site / r.hours.model - 1)} more run hours than the model: the operators run more units than the reserve rule needs. Check Spinning reserve as share of load and Units always online. The hybrid's savings assume the modelled practice: every extra unit online adds its minimum loading as must-run generation, which displaces PV.`);
  const lp = [['load', 'site load'], ['peak', 'peak load'], ['gen', 'generation']].filter(([k]) => r[k] && r[k].flag).map(([, l]) => l);
  if (lp.length)
    diag.push(`The ${lp.length > 1 ? lp.slice(0, -1).join(', ') + ' and ' + lp[lp.length - 1] + ' differ' : lp[0] + ' differs'} from the records: check the load profile (station service, network losses, the metering point of the records, load changes since their period). The diesel-only case serves the year-1 load without auxiliary loads, and its generation adds only the energy dumped at minimum loading.`);
  if (!diag.length && !rows.some((x) => x.flag) && !off.length && !(cv > 0.15)) diag.push('The modelled diesel-only case matches every record within its tolerance.');
  // leverage: the saving is the difference of two fuel figures, so an error in the baseline alone moves it more than 1 % per 1 %
  const saved = SIM.comparison.fuel_saved_l_y1, lever = saved > 0 ? b.fuel_l / saved : null;
  if (lever != null)
    diag.push(`Each 1 % of baseline fuel error moves the fuel saved by ${fmtNum(lever, 1)} % (diesel only ${fmtNum(b.fuel_l / 1000)} kL, saved ${fmtNum(saved / 1000)} kL in year 1), when the hybrid's own fuel is right. An error in the fuel curve moves both by about the same share, and the fuel saved by about 1 % per 1 %.`);
  const monthNote = !rec.length ? '' : `CV(RMSE) of the monthly fuel ${fmtPct(cv)} over ${rec.length} month${rec.length > 1 ? 's' : ''}${cv > 0.15 ? ', above the 15 % of ASHRAE Guideline 14 for calibration to monthly data' : ''}. ${off.length
    ? `More than 15 % off: ${off.map((x) => `${x.label} (${calPct(x.d)})`).join(', ')}.` : 'No month is more than 15 % off.'} Fuel records are often deliveries, so a change in tank stock moves fuel between months.`;
  const txt = (v) => String(v == null ? '' : v).trim();
  const recs = { period: txt(S.period), source: txt(S.source), scope: txt(S.scope) };
  const basis = `${recs.source || recs.period || recs.scope ? `Records${recs.source ? ' from ' + recs.source : ''}${recs.period ? ', ' + recs.period : ''}${recs.scope ? '; scope: ' + recs.scope : ''}. ` : ''}Model: the diesel-only case of the last simulation, year 1, with ${+P.diesel.units} × ${fmtNum(P.diesel.unit_kw)} kW gensets and no auxiliary loads. Difference = model ÷ site − 1.`;
  return { rows, months, monthly: rec.length > 0, cv, nMonths: rec.length, off, lever, diag, monthNote, basis, recs };
}
function drawCalibration() {
  const K = calibration();
  $('#calCard').hidden = !K;
  if (!K) { Plotly.purge('chCal'); return; }
  $('#calBasis').textContent = K.basis;
  $('#calTable').innerHTML = !K.rows.length ? '' : `<table class="data"><tr><th>Record</th><th>Site</th><th>Model</th><th>Difference</th></tr>${K.rows.map((x) => `<tr>
    <td>${escapeHtml(x.label)} (${escapeHtml(x.unit)})</td><td>${calFmt(x.k, x.site)}</td><td>${calFmt(x.k, x.model)}</td>
    <td>${calPct(x.d)}<span class="${x.flag ? 'why' : 'tol'}">${x.flag ? 'beyond' : 'within'} ±${fmtNum(x.tol * 100)} %</span></td></tr>`).join('')}</table>`;
  $('#calMonthly').hidden = !K.monthly;
  if (K.monthly) {
    const c = COL();
    plot('chCal', [
      { type: 'bar', name: 'Site records', x: MONTHS, y: K.months.map((x) => (x.site == null ? null : x.site / 1000)), marker: { color: c.load, cornerradius: 3 }, hovertemplate: '%{x}: %{y:,.1f} kL<extra>Site records</extra>' },
      { type: 'bar', name: 'Model, diesel only', x: MONTHS, y: K.months.map((x) => x.model / 1000), marker: { color: c.gen, cornerradius: 3 },
        customdata: K.months.map((x) => (x.d == null ? 'no record' : calPct(x.d) + ' vs records')), hovertemplate: '%{x}: %{y:,.1f} kL, %{customdata}<extra>Model, diesel only</extra>' },
    ], { barmode: 'group', yaxis: { title: { text: 'Fuel (kL)' } } });
    $('#calMonthNote').textContent = K.monthNote;
  } else Plotly.purge('chCal');
  $('#calDiag').innerHTML = K.diag.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
}
// Years as compact ranges: [1, 2, 3, 7] -> "1–3, 7".
function yearList(ys) {
  const out = [];
  for (let i = 0; i < ys.length; i++) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++;
    out.push(j > i ? `${ys[i]}–${ys[j]}` : String(ys[i]));
    i = j;
  }
  return out.join(', ');
}
// Battery replacement threshold as the engine applies it: blank or negative = end-of-life state of health.
const bessThreshold = () => (P.bess.replace_soh != null && P.bess.replace_soh >= 0 ? P.bess.replace_soh : P.bess.eol_soh);
// Battery health figures of a simulation result (shared by the Battery health card and the report).
function bessHealth(R) {
  const Y = R.years, y1 = Y[0], last = Y[Y.length - 1], thr = bessThreshold();
  const fade = y1.soh_loss_cal + y1.soh_loss_cyc, cap = +P.bess.warranty_efc_yr || 0;
  return {
    thr, fade, cap,
    maxEfc: Math.max(...Y.map((y) => y.bess_efc)), maxEfcDc: Math.max(...Y.map((y) => y.bess_efc_dc)), maxC: Math.max(...Y.map((y) => y.max_c_rate)),
    life: fade > 0 ? (1 - thr) / fade : null, cycShare: fade > 0 ? y1.soh_loss_cyc / fade : 0,
    repl: Y.filter((y) => y.bess_replaced).map((y) => y.year),
    sohEnd: last.bess_soh - last.soh_loss_cal - last.soh_loss_cyc,
    over: cap > 0 ? Y.filter((y) => y.bess_efc > cap).map((y) => y.year) : [],
  };
}
function drawBessHealth() {
  const R = SIM.result, Y = R.years, c = COL();
  const has = R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6;
  $('#bessHealth').hidden = !has;
  if (!has) { Plotly.purge('chSoh'); Plotly.purge('chSohLoss'); return; }
  const h = bessHealth(R), yrs = (n) => (n > 1 ? 'years ' : 'year ');
  $('#bessKpis').innerHTML = kpis([
    ['Cycles per year (max)', fmtNum(h.maxEfc), `AC; ${fmtNum(h.maxEfcDc)} at the cells (DC)`],
    ['Max C-rate used', fmtNum(h.maxC, 2) + ' C', `rating ${fmtNum(R.size.bess_kw / R.size.bess_kwh, 2)} C`],
    ['Expected life', h.life == null ? '–' : fmtNum(h.life, 1) + ' yr', h.life == null ? 'no fade' : 'new battery at year-1 use; '
      + (h.cycShare > 0.5 ? `limited by cycling (${fmtPct(h.cycShare, 0)} of the fade)` : `limited by calendar fade (${fmtPct(1 - h.cycShare, 0)} of the fade)`)],
    ['Replacements', String(h.repl.length), h.repl.length ? 'in ' + yrs(h.repl.length) + yearList(h.repl) : 'none in the project life'],
    ['SOH at end of project', fmtPct(h.sohEnd), `replacement threshold ${fmtPct(h.thr, 0)}`],
    h.cap > 0 ? ['Warranty cycle cap', fmtNum(h.cap) + ' /yr', h.over.length ? `exceeded in ${yrs(h.over.length)}${yearList(h.over)}` : 'not exceeded', h.over.length ? 'bad' : false]
      : ['Warranty cycle cap', '–', 'none set (Battery tab)'],
  ]);
  // SOH at every year boundary: start of year y at x = y − 1, end of year y at x = y; a replacement jumps back to 100 %.
  const x = [], s = [], rx = [], rs = [];
  Y.forEach((y) => {
    const end = y.bess_soh - y.soh_loss_cal - y.soh_loss_cyc;
    x.push(y.year - 1, y.year); s.push(y.bess_soh * 100, end * 100);
    if (y.bess_replaced) { rx.push(y.year); rs.push(end * 100); }
  });
  const lo = Math.min(h.thr * 100, ...s);
  plot('chSoh', [
    { type: 'scatter', mode: 'lines', name: 'State of health', x, y: s, line: { color: c.bess, width: 2 }, hovertemplate: 'after %{x} yr: %{y:.1f} %<extra></extra>' },
    { type: 'scatter', mode: 'lines', name: 'Replacement threshold', x: [0, Y.length], y: [h.thr * 100, h.thr * 100], line: { color: c.unmet, dash: 'dash', width: 1.5 }, hoverinfo: 'skip' },
    ...(rx.length ? [{ type: 'scatter', mode: 'markers', name: 'Replacement', x: rx, y: rs, marker: { color: c.unmet, size: 9, symbol: 'x' }, hovertemplate: 'replaced at the end of year %{x}<extra></extra>' }] : []),
  ], { xaxis: { title: { text: 'Years of operation' } }, yaxis: { title: { text: 'State of health (%)' }, range: [Math.max(0, lo - 5), 102] } });
  plot('chSohLoss', [
    { type: 'bar', name: 'Calendar fade', x: Y.map((y) => y.year), y: Y.map((y) => y.soh_loss_cal * 100), marker: { color: c.text2 } },
    { type: 'bar', name: 'Cycle fade', x: Y.map((y) => y.year), y: Y.map((y) => y.soh_loss_cyc * 100), marker: { color: c.bess } },
  ].map((t) => ({ ...t, hovertemplate: 'year %{x}: %{y:.2f} pp<extra>' + t.name + '</extra>' })),
       { barmode: 'stack', xaxis: { title: { text: 'Project year' } }, yaxis: { title: { text: 'SOH lost (percentage points)' } } });
}
// Dispatch weeks (the 52 slider positions) that stand out, as start hours: the "Go to" list and the report's second dispatch figure.
const WEEK_PICKS = [['unmet', 'Highest unmet load'], ['units', 'Most gensets online'], ['re', 'Lowest renewable share'], ['curt', 'Highest curtailment'],
  ['soc', 'Lowest battery SOC'], ['lowload', 'Longest low-load run'], ['pv', 'Best PV week']];
function weekPicks(R) {
  const H = R.hourly, gmin1 = P.diesel.unit_kw * P.diesel.min_load, bess = R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6;
  const out = {}, best = {};
  const put = (k, v, s, ok) => { if (ok && (best[k] == null || v > best[k])) { best[k] = v; out[k] = s; } };
  for (let w = 0; w < 52; w++) {
    const s = Math.min(w * 168, HOURS - 168);
    let unmet = 0, units = 0, served = 0, gen = 0, curt = 0, soc = 0, pv = 0, run = 0, longest = 0;
    for (let t = s; t < s + 168; t++) {
      const u = H.gen_units[t], g = H.gen_to_load[t] + H.gen_to_bess[t];
      unmet += H.unmet[t]; units += u; served += H.load[t] - H.unmet[t]; gen += g; soc += H.soc[t]; pv += H.pv_avail[t];
      curt += H.pv_curtailed[t] + (H.wind_curtailed ? H.wind_curtailed[t] : 0);
      run = u > 0 && g + H.gen_dump[t] <= u * gmin1 * (1 + 1e-6) + 1e-3 ? run + 1 : 0;   // every online unit at minimum loading
      longest = Math.max(longest, run);
    }
    put('unmet', unmet, s, unmet > 1e-6); put('units', units, s, units > 0); put('re', gen / served, s, served > 0); put('curt', curt, s, curt > 1e-6);
    put('soc', -soc, s, bess); put('lowload', longest, s, longest > 0); put('pv', pv, s, pv > 0);
  }
  return out;
}
// Open the dispatch week that contains this hour of the year.
function jump(hour) { $('#weekGo').value = ''; $('#weekSlider').value = Math.min(51, Math.floor(hour / 168)); drawDispatch(); $('#chDispatch').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function drawDispatch() {
  if (!SIM) return;
  const w = +$('#weekSlider').value, start = Math.min(w * 168, HOURS - 168);
  $('#weekLabel').textContent = `${dateOfHour(start)} to ${dateOfHour(start + 167)}`;
  dispatchChart('chDispatch', SIM.result.hourly, start, 168, { socTarget: P.diesel.strategy === 'predictive' });
}
function exportCsv() {
  if (!SIM) { toast('Run a simulation first.', true); return; }
  const H = SIM.result.hourly;
  const cols = ['load', 'aux', 'pv_avail', 'pv_to_load', 'pv_to_bess', 'pv_curtailed', 'bess_dis', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'gen_units', 'fuel_l', 'unmet', 'soc', 'soc_target', 'pv_fc_h1', 'load_fc_h1', 'pv_fc_da', 'load_fc_da', 'wind_avail', 'wind_to_load', 'wind_to_bess', 'wind_curtailed'];
  const lines = ['hour,date,hour_of_day,' + cols.join(',')];
  for (let t = 0; t < HOURS; t++) lines.push(`${t},${dateOfHour(t)},${t % 24},` + cols.map((k) => (H[k] ? +(+H[k][t]).toFixed(4) : '')).join(','));
  download((P.name || 'results') + '_hourly.csv', lines.join('\n'), 'text/csv');
}

// ---------------------------------------------------------------- operating options
// One batch of the project as it is, with one setting changed per row: the diesel-only reference (no PV, battery or wind),
// no battery, then every dispatch strategy with the battery, and the predictive EMS with perfect forecasts as a benchmark.
const OPTION_IDS = ['lf', 'cc60', 'cc80', 'cc100', 'pred'];   // dispatch strategies with the battery
const ccSetpoint = (id) => Math.min(+id.slice(2) / 100, +P.bess.soc_max);   // the engine caps the setpoint at the maximum SOC
const optionShort = (id) => (id === 'lf' ? 'load following' : id === 'pred' ? 'predictive EMS' : `cycle charging to ${Math.round(ccSetpoint(id) * 100)} %`);
function optionCases() {
  const fc = (list, k) => (list.find(([v]) => v === k) || [k, k])[1];
  return [
    ['diesel', 'Diesel only', { 'pv.capacity_kwp': 0, 'bess.energy_kwh': 0, 'bess.power_kw': 0, 'wind.units': 0 }],
    ['pv', P.wind.units > 0 ? 'PV + wind only' : 'PV only', { 'bess.energy_kwh': 0, 'bess.power_kw': 0 }],
    ['lf', 'Battery, load following', { 'diesel.strategy': 'load_following' }],
    ...['cc60', 'cc80', 'cc100'].filter((id, i, a) => a.findIndex((j) => ccSetpoint(j) === ccSetpoint(id)) === i)   // rows that coincide after the cap run once
      .map((id) => [id, `Battery, cycle charging to ${Math.round(ccSetpoint(id) * 100)} % SOC${ccSetpoint(id) < +id.slice(2) / 100 ? ' (maximum SOC)' : ''}`, { 'diesel.strategy': 'cycle_charging', 'diesel.cc_setpoint': ccSetpoint(id) }]),
    ['pred', `Battery, predictive EMS: ${fc(PV_FC_METHODS, P.ems.pv_forecast)} / ${fc(LOAD_FC_METHODS, P.ems.load_forecast)}`, { 'diesel.strategy': 'predictive' }],
    ['perfect', 'Battery, predictive EMS with perfect forecasts (benchmark)', { 'diesel.strategy': 'predictive', 'ems.pv_forecast': 'perfect', 'ems.load_forecast': 'perfect' }],
  ];
}
// Fingerprint of the engine inputs, to tell when a stored comparison no longer matches the project.
function projectKey(p = engineProject()) {
  const s = JSON.stringify(p);
  return fnv1a(s) + ':' + s.length;
}
// Fingerprint of the inputs the option rows depend on: every battery row sets its own strategy (and setpoint), rows without a
// battery ignore them, and the name is not an engine input.
const optionsKey = () => projectKey(engineProject({ name: '', diesel: { ...P.diesel, strategy: '', cc_setpoint: 0 } }));
// Inputs the NPC of a design without a battery depends on: everything but the sizes the optimiser varies, the dispatch
// (every strategy reduces to load following without a battery) and the financing (not part of the NPC).
function sizingKey() {
  return projectKey(engineProject({ name: '', pv: { ...P.pv, capacity_kwp: 0 }, bess: { ...P.bess, energy_kwh: 0, power_kw: 0 },
    wind: { ...P.wind, units: 0 }, diesel: { ...P.diesel, strategy: '', cc_setpoint: 0 }, finance: null }));
}
// First optimiser constraint (Optimise sizing) a simulation result breaks, as the optimiser checks them; '' when it meets them all.
function infeasible(R) {
  const O = P.optimizer, worst = (k) => Math.max(...R.years.map((y) => y[k] || 0));
  if (Math.max(R.unmet_fraction, R.unmet_fraction_max || 0) - O.max_unmet > 1e-9) return 'unmet load';
  if (O.min_re - R.re_fraction > 1e-9) return 'renewable fraction';
  if (R.curtail_fraction - O.max_curtail > 1e-9) return 'curtailment';
  if (O.max_lole_h >= 0 && worst('lol_h') - O.max_lole_h > 1e-9) return 'loss-of-load hours';
  if (O.max_reserve_short_h >= 0 && worst('reserve_short_h') - O.max_reserve_short_h > 1e-9) return 'reserve shortfall hours';
  if (O.max_pv_kwp > 0 && R.size.pv_kwp - O.max_pv_kwp > 1e-9) return 'land / PV limit';
  if (O.max_capex > 0 && R.econ.capex_total - O.max_capex > 1e-9) return 'capex budget';
  return '';
}
async function runOptions() {
  if (!requireInputs()) return;
  if (!(P.bess.energy_kwh > 0 && P.bess.power_kw > 0)) { setStatus('#optionsStatus', 'Set a battery size (Battery tab) to compare operating options.', 'err'); return; }
  const fast = $('#optionsFast').checked, cases = optionCases();
  setStatus('#optionsStatus', `Simulating ${cases.length} options…`);
  await busy('#btnOptions', async () => {
    try {
      const t0 = performance.now(), key = optionsKey();
      const r = await api('/api/batch', { project: engineProject(), cases: cases.map(([, , o]) => ({ overrides: fast ? { ...o, 'sim.all_years': false } : o })) });
      OPTIONS = { key, fast: fast || !P.sim.all_years, rows: cases.map(([id, label], i) => ({ id, label, res: r.results[i] })) };
      setStatus('#optionsStatus', `✓ ${cases.length} options simulated (${OPTIONS.fast ? 'year 1, repeated' : P.econ.lifetime + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
      renderOptions();
    } catch (e) { setStatus('#optionsStatus', e.message, 'err'); toast(e.message, true); }
  });
}
// Figures of the last comparison (shared by the Operating options card, the report and the workbook): every row with its NPC change
// from the row above, the lowest feasible NPC, the options within 0.5 % of it, and the NPC steps for the waterfall.
function optionsSummary() {
  const rows = OPTIONS.rows.map((r) => {
    const x = { id: r.id, label: r.label, err: r.res.error || '' };
    if (x.err) return x;
    const R = r.res.result, y = R.years[0], C = r.res.comparison || {}, F = r.res.finance || {}, ref = r.id === 'diesel';
    return Object.assign(x, { fuel: y.fuel_l, re: R.re_fraction, uh: y.unit_hours, starts: y.starts, load: R.avg_gen_load, efc: y.bess_efc, repl: R.bess_replacements,
      curt: R.curtail_fraction, unmet: R.unmet_fraction, capex: R.econ.capex_total, npc: R.econ.npc, lcoe: R.econ.lcoe,
      npv: ref ? null : C.npv_savings, irr: ref ? null : C.irr, eqIrr: ref ? null : F.equity_irr, why: infeasible(R) });
  });
  rows.forEach((x, i) => {
    const p = rows[i - 1];
    if (p && x.npc != null && p.npc != null) { x.dnpc = x.npc - p.npc; x.close = Math.abs(x.dnpc) < 0.005 * Math.abs(x.npc); }
  });
  const by = Object.fromEntries(rows.map((x) => [x.id, x]));
  const cheapest = (ids, feasible) => ids.map((k) => by[k]).filter((x) => x && x.npc != null && (!feasible || !x.why)).reduce((a, x) => (!a || x.npc < a.npc ? x : a), null);
  const ops = ['diesel', 'pv', ...OPTION_IDS];   // the perfect forecast is a benchmark, not an option
  const best = cheapest(ops, true), strat = cheapest(OPTION_IDS, true) || cheapest(OPTION_IDS, false);
  const near = best ? rows.filter((x) => x !== best && ops.includes(x.id) && x.npc != null && !x.why && x.npc - best.npc < 0.005 * Math.abs(best.npc)) : [];
  const D = by.diesel, V = by.pv, L = by.lf;
  const fall = D && V && L && strat && [D, V, L].every((x) => x.npc != null) ? { D, V, L, S: strat } : null;
  return { rows, by, best, strat, near, fall, fast: OPTIONS.fast, stale: OPTIONS.key !== optionsKey() };
}
function renderOptions() {
  $('#optionsBody').hidden = !OPTIONS;
  if (!OPTIONS) { Plotly.purge('chOptFall'); return; }
  const S = optionsSummary(), cur = P.econ.currency, c = COL(), m = (v) => (v === 0 ? '0' : fmtMoney(v, '').trim());
  const th = ['Option', 'Fuel kL/yr', 'RE', 'Unit-h', 'Starts', 'Avg genset load', 'EFC', 'Repl.', 'Curtailed', 'Unmet', 'Capex ' + cur, 'NPC ' + cur, 'LCOE', 'NPV vs diesel ' + cur, 'IRR', 'Equity IRR', 'NPC change ' + cur];
  $('#optionsTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${t}</th>`).join('')}</tr>${S.rows.map((x) => (x.err
    ? `<tr><td>${escapeHtml(x.label)}</td><td colspan="${th.length - 1}">${escapeHtml(x.err)}</td></tr>`
    : `<tr class="${x === S.best ? 'best' : ''}"><td>${escapeHtml(x.label)}${x.why ? `<span class="why">infeasible: ${x.why}</span>` : ''}</td>
    <td>${fmtNum(x.fuel / 1000)}</td><td>${fmtPct(x.re)}</td><td>${fmtNum(x.uh)}</td><td>${fmtNum(x.starts)}</td><td>${fmtPct(x.load)}</td><td>${fmtNum(x.efc)}</td><td>${fmtNum(x.repl)}</td>
    <td>${fmtPct(x.curt)}</td><td>${fmtPct(x.unmet, 3)}</td><td>${m(x.capex)}</td><td>${m(x.npc)}</td><td>${fmtNum(x.lcoe, 4)}</td><td>${m(x.npv)}</td><td>${fmtPct(x.irr)}</td><td>${fmtPct(x.eqIrr)}</td>
    <td>${x.dnpc == null ? '–' : (x.dnpc < 0 ? '−' : '+') + m(Math.abs(x.dnpc))}${x.close ? '<span class="close">within model accuracy</span>' : ''}</td></tr>`)).join('')}</table>`;
  const note = [];
  if (S.stale) note.push('⚠ The inputs have changed since this comparison: press Compare options again.');
  note.push(S.best ? `Lowest net present cost meeting the constraints: <b>${escapeHtml(S.best.label)}</b> (${fmtMoney(S.best.npc, cur)}).${S.near.length
    ? ` Within 0.5 % of it, which is within model accuracy: ${S.near.map((x) => escapeHtml(x.label)).join('; ')}.` : ''}` : 'No option meets the optimiser constraints.');
  note.push('NPV and IRR are against diesel only; NPC change is against the row above, and changes below 0.5 % of NPC are within model accuracy. The perfect-forecast row is a benchmark, not an option, and is never highlighted. The EMS plans over a rolling horizon, so perfect forecasts do not always give a lower NPC.');
  if (S.fast) note.push('Year 1 is simulated and repeated over the project life: PV degradation and load growth are left out; battery ageing is still counted.');
  $('#optionsNote').innerHTML = note.join(' ');
  if (!S.fall) { Plotly.purge('chOptFall'); return; }
  const F = S.fall, pv = F.V.label === 'PV only' ? 'PV' : 'PV and wind';
  const steps = [F.D.npc, F.V.npc - F.D.npc, F.L.npc - F.V.npc, F.S.npc - F.L.npc, F.S.npc];
  plot('chOptFall', [{ type: 'waterfall', measure: ['absolute', 'relative', 'relative', 'relative', 'total'],
    x: ['Diesel only', '+ ' + pv, '+ battery<br>(load following)', '+ best strategy<br>(' + optionShort(F.S.id) + ')', 'Hybrid<br>(' + optionShort(F.S.id) + ')'], y: steps,
    text: steps.map((v, i) => (i && i < 4 ? `${cur} ${v < 0 ? '−' : '+'}${fmtMoney(Math.abs(v), '').trim()}` : fmtMoney(v, cur))), textposition: 'outside', textfont: { color: c.text },
    increasing: { marker: { color: c.unmet } }, decreasing: { marker: { color: c.bess } }, totals: { marker: { color: c.gen } }, connector: { line: { color: c.border } },
    hovertemplate: '%{x}: %{y:,.0f} ' + cur + '<extra></extra>' }],
  { showlegend: false, yaxis: { title: { text: 'Net present cost (' + cur + ')' } } });
}

// ---------------------------------------------------------------- tornado
// The design as it is set now, simulated at the low and the high value of one input at a time (P.tornado.vars, see TORNADO_VARS),
// in one batch with the base case. The sizes stay fixed; the sensitivity cases of Optimise sizing re-optimise them instead.
const TORNADO_METRICS = {
  npv: ['NPV of savings', (r) => r.comparison.npv_savings],
  lcoe: ['LCOE', (r) => r.result.econ.lcoe],
  irr: ['IRR', (r) => r.comparison.irr],
  eq_irr: ['Equity IRR', (r) => (r.finance ? r.finance.equity_irr : null)],
  fuel: ['Fuel saved in year 1', (r) => r.comparison.fuel_saved_l_y1],
};
const TORNADO_PATHS = /^(pv|bess|aux|wind|diesel|ems|econ|finance)\.|^load\.growth$/;   // inputs the engine reads
const GUI_ONLY = new Set(['pv.module_wp', 'pv.module_length', 'pv.module_width']);   // inputs of the layout and the equipment library only
function tornadoFmt(m, v) {
  if (v == null || !isFinite(v)) return '–';
  const cur = P.econ.currency;
  return m === 'npv' ? (v === 0 ? cur + ' 0' : fmtMoney(v, cur)) : m === 'lcoe' ? `${cur} ${fmtNum(v, 4)}/kWh` : m === 'fuel' ? fmtNum(v) + ' L' : fmtPct(v, 2);
}
const tornadoSwing = (m, v) => (m === 'irr' || m === 'eq_irr' ? fmtNum(v * 100, 2) + ' pp' : tornadoFmt(m, v));
const tornadoAxis = (m) => ({ npv: [1e-6, `NPV of savings (M ${P.econ.currency})`], lcoe: [1, `LCOE (${P.econ.currency}/kWh)`], irr: [100, 'IRR (%)'],
  eq_irr: [100, 'Equity IRR (%)'], fuel: [1e-3, 'Fuel saved in year 1 (kL)'] }[m]);
// Numeric input field of a project path in the input forms (label, unit, percentage), or null.
function formField(path) {
  for (const fs of Object.values(FORMS)) { const f = fs.find((x) => x.k === path && x.t !== 'sel' && x.t !== 'chk' && x.t !== 'text'); if (f) return f; }
  return null;
}
const tornadoLabel = (v) => v.label || (v.path === 'load.kw' ? 'Load' : (formField(v.path) || {}).l || v.path || 'New input');
const tornadoPct = (v) => v.mode !== 'x' && (formField(v.path) || {}).t === PCT;   // low and high typed in % or pp
function tornadoUnit(v) {
  const f = formField(v.path) || {}, u = f.u || '';
  if (v.mode === 'x') return '';
  if (f.t === PCT) return v.mode === '+' ? 'pp' : u;
  return u.startsWith('/') ? P.econ.currency + u : u;
}
// Input value of one case: x multiplies the base value (every hour of an array), + adds to it, = replaces it; null when it cannot apply.
function tornadoValue(v, x) {
  const b = getPath(P, v.path), f = formField(v.path);
  if (typeof x !== 'number' || !isFinite(x)) return null;
  if (Array.isArray(b)) return v.mode === 'x' ? b.map((y) => y * x) : null;
  if (v.mode !== '=' && (typeof b !== 'number' || !isFinite(b))) return null;
  const val = v.mode === 'x' ? b * x : v.mode === '+' ? b + x : x;
  return f && f.t === 'int' ? Math.round(val) : val;
}
// An input value as text, in the units of its input field.
function tornadoInput(v, val) {
  if (val == null) return '–';
  if (Array.isArray(val)) return fmtPower(sum(val) / val.length) + ' average';
  if (typeof val !== 'number') return String(val);
  const f = formField(v.path) || {}, u = f.u || '';
  if (f.t === PCT) return `${+(val * 100).toFixed(3)} ${u}`;
  return u.startsWith('/') ? `${P.econ.currency} ${fmtSig(val)}${u}` : `${fmtSig(val)}${u ? ' ' + u : ''}`;
}
// Overrides of one case. With "battery prices move together" the energy capex also scales the power capex and the replacement price.
function tornadoOverrides(v, val) {
  const o = { [v.path]: val }, E = P.econ;
  if (P.tornado.bess_together && v.path === 'econ.bess_capex_kwh' && E.bess_capex_kwh > 0) {
    const f = val / E.bess_capex_kwh;
    o['econ.bess_capex_kw'] = E.bess_capex_kw * f; o['econ.bess_replace_kwh'] = E.bess_replace_kwh * f;
  }
  return o;
}
// Low and high values to start from after the change type of a row changes.
function tornadoRange(v) {
  const b = getPath(P, v.path), f = formField(v.path) || {};
  if (v.mode === 'x' || typeof b !== 'number') return { lo: 0.8, hi: 1.2 };
  if (v.mode === '+') return f.t === PCT ? { lo: -0.01, hi: 0.01 } : { lo: -0.2 * Math.abs(b), hi: 0.2 * Math.abs(b) };
  return { lo: 0.8 * b, hi: 1.2 * b };
}
function tornadoPathList() {
  const seen = new Set(['load.kw']), opts = ['<option value="load.kw">Load in every hour (× only)</option>'];
  for (const fs of Object.values(FORMS))
    for (const f of fs)
      if (f.t !== 'sel' && f.t !== 'chk' && f.t !== 'text' && TORNADO_PATHS.test(f.k) && !GUI_ONLY.has(f.k) && !seen.has(f.k)) { seen.add(f.k); opts.push(`<option value="${f.k}">${escapeHtml(f.l)}</option>`); }
  $('#tornadoPaths').innerHTML = opts.join('');
}
// Editable table of the inputs. A redraw from renderSim skips it while the user is typing in it.
function drawTornadoVars(force) {
  const box = $('#tornadoVars'), a = document.activeElement, T = P.tornado;
  if (!force && box.contains(a)) return;
  const focus = box.contains(a) ? [a.dataset.ti, a.dataset.tk] : null;
  const disp = (v, x) => (x == null ? '' : tornadoPct(v) ? +(x * 100).toFixed(6) : +x);
  box.innerHTML = `<table class="data tornado-vars"><tr><th>Input</th><th>Path</th><th>Change<button type="button" class="info" data-k="tornado.mode" data-title="Tornado inputs" aria-label="About Tornado inputs" aria-expanded="false">i</button></th>
    <th>Low</th><th>High</th><th>Low · base · high</th><th></th></tr>${T.vars.map((v, i) => `<tr>
    <td>${escapeHtml(tornadoLabel(v))}${T.bess_together && v.path === 'econ.bess_capex_kwh' ? '<span class="close">with power and replacement prices</span>' : ''}</td>
    <td><input class="path" list="tornadoPaths" data-ti="${i}" data-tk="path" value="${escapeHtml(v.path)}" aria-label="Input path"></td>
    <td><select data-ti="${i}" data-tk="mode" aria-label="Change"${Array.isArray(getPath(P, v.path)) ? ' disabled' : ''}>${[['x', '× base'], ['+', '+ base'], ['=', 'set to']].map(([k, l]) => `<option value="${k}"${v.mode === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
    ${['lo', 'hi'].map((k) => `<td><input type="number" step="any" data-ti="${i}" data-tk="${k}" value="${disp(v, v[k])}" aria-label="${k === 'lo' ? 'Low' : 'High'}"><span class="u">${escapeHtml(tornadoUnit(v))}</span></td>`).join('')}
    <td>${escapeHtml([tornadoValue(v, v.lo), getPath(P, v.path), tornadoValue(v, v.hi)].map((x) => tornadoInput(v, x)).join(' · '))}</td>
    <td><button class="btn small ghost" data-tdel="${i}" aria-label="Remove input">✕</button></td></tr>`).join('')}</table>`;
  $$('[data-tk]', box).forEach((el) => el.addEventListener('change', () => {
    const v = T.vars[+el.dataset.ti], k = el.dataset.tk;
    if (k === 'path') { v.path = el.value.trim(); v.label = ''; if (Array.isArray(getPath(P, v.path)) && v.mode !== 'x') { v.mode = 'x'; Object.assign(v, tornadoRange(v)); } }
    else if (k === 'mode') { v.mode = el.value; Object.assign(v, tornadoRange(v)); }
    else { const x = Number(el.value); if (el.value.trim() === '' || !isFinite(x)) return; v[k] = tornadoPct(v) ? x / 100 : x; }
    autosave(); drawTornadoVars(true);
  }));
  $$('[data-tdel]', box).forEach((b) => b.addEventListener('click', () => { T.vars.splice(+b.dataset.tdel, 1); autosave(); drawTornadoVars(true); }));
  if (focus) { const el = box.querySelector(`[data-ti="${focus[0]}"][data-tk="${focus[1]}"]`); if (el) el.focus(); }
}
async function runTornado() {
  if (!requireInputs()) return;
  const T = P.tornado, fast = !!T.fast, basis = fast ? { 'sim.all_years': false } : {}, eng = engineProject();
  const cases = [{ overrides: basis }], rows = [];
  for (const v of T.vars) {
    if (!v.path) continue;
    const row = { path: v.path, mode: v.mode, lo: v.lo, hi: v.hi, label: tornadoLabel(v) + (T.bess_together && v.path === 'econ.bess_capex_kwh' ? ' (with power and replacement prices)' : ''),
                  base: tornadoInput(v, getPath(P, v.path)), vals: [], idx: [], err: '' };
    // the engine ignores a path it does not read (or creates it), which would draw a zero bar, as if the input did not matter
    const ignored = v.path !== 'load.kw' && (GUI_ONLY.has(v.path) || getPath(eng, v.path) === undefined);
    for (const x of [v.lo, v.hi]) {
      const val = tornadoValue(v, x);
      row.vals.push(tornadoInput(v, val));
      if (ignored) { row.err = 'not an input of the engine'; row.idx.push(-1); }
      else if (val == null || (!Array.isArray(val) && !isFinite(val))) { row.err = `cannot change ${v.path} this way`; row.idx.push(-1); }
      else if ((v.mode === 'x' && x === 1) || (v.mode === '+' && x === 0) || (v.mode === '=' && val === getPath(P, v.path))) row.idx.push(0);   // the base case
      else { row.idx.push(cases.length); cases.push({ overrides: { ...basis, ...tornadoOverrides(v, val) } }); }
    }
    rows.push(row);
  }
  if (!rows.length) { setStatus('#tornadoStatus', 'Add at least one input.', 'err'); return; }
  setStatus('#tornadoStatus', `Simulating ${cases.length} cases…`);
  await busy('#btnTornado', async () => {
    try {
      const t0 = performance.now(), key = projectKey();
      const r = await api('/api/batch', { project: engineProject(), cases });
      if (r.results[0].error) throw new Error(r.results[0].error);
      TORNADO = { key, fast: fast || !P.sim.all_years, together: !!T.bess_together, base: r.results[0],
                  rows: rows.map((row) => ({ ...row, res: row.idx.map((i) => (i < 0 ? null : r.results[i])) })) };
      setStatus('#tornadoStatus', `✓ ${cases.length} cases simulated (${TORNADO.fast ? 'year 1, repeated' : P.econ.lifetime + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
      renderTornado();
    } catch (e) { setStatus('#tornadoStatus', e.message, 'err'); toast(e.message, true); }
  });
}
// Figures of the last run for one metric (shared by the card, the report and the workbook): result at the low and high input value
// (vLo, vHi), and the swing = the span of both results and the base value. Sorted by swing, largest first.
function tornadoSummary(metric) {
  const m = TORNADO_METRICS[metric] ? metric : 'npv', [name, get] = TORNADO_METRICS[m];
  const val = (res) => { if (!res || res.error) return null; const x = get(res); return x == null || !isFinite(x) ? null : x; };
  const base = val(TORNADO.base);
  const rows = TORNADO.rows.map((row) => {
    const err = row.err || (row.res.find((x) => x && x.error) || {}).error || '', vLo = err ? null : val(row.res[0]), vHi = err ? null : val(row.res[1]);
    const xs = [vLo, vHi, base].filter((x) => x != null);
    return { ...row, err, vLo, vHi, swing: base == null || xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs) };
  }).sort((a, b) => b.swing - a.swing);
  return { metric: m, name, base, rows, fast: TORNADO.fast, together: TORNADO.together, stale: TORNADO.key !== projectKey() };
}
function renderTornado() {
  const T = P.tornado;
  drawTornadoVars();
  $('#tornadoMetric').value = T.metric; $('#tornadoFast').checked = !!T.fast; $('#tornadoTogether').checked = !!T.bess_together;
  $('#tornadoBody').hidden = !TORNADO;
  if (!TORNADO) { Plotly.purge('chTornado'); return; }
  const S = tornadoSummary(T.metric), c = COL(), [sc, title] = tornadoAxis(S.metric), b = S.base;
  const ok = S.rows.filter((x) => !x.err && b != null && (x.vLo != null || x.vHi != null)).reverse();   // categories run bottom-up: largest swing on top
  // The shorter bar of a row is drawn over the longer one, so both show when the low and high values move the result the same way.
  const loTop = ok.map((x) => x.vLo != null && x.vHi != null && Math.abs(x.vLo - b) < Math.abs(x.vHi - b));
  const bar = (k, name, color, top) => ({ type: 'bar', orientation: 'h', name, legendgroup: k, showlegend: !top, y: ok.map((x) => x.label), base: b * sc,
    x: ok.map((x, j) => (x[k] != null && (k === 'vLo' ? loTop[j] : !loTop[j]) === top ? (x[k] - b) * sc : null)),
    customdata: ok.map((x) => [x.vals[k === 'vLo' ? 0 : 1], tornadoFmt(S.metric, x[k])]), marker: { color, cornerradius: 4 },
    hovertemplate: `%{y}<br>${name}: %{customdata[0]}<br>${escapeHtml(S.name)}: %{customdata[1]}<extra></extra>` });
  $('#chTornado').style.height = Math.max(260, 100 + 30 * ok.length) + 'px';
  plot('chTornado', [bar('vLo', 'Low input value', c.gen, false), bar('vHi', 'High input value', c.pv, false), bar('vLo', 'Low input value', c.gen, true), bar('vHi', 'High input value', c.pv, true)],
    { barmode: 'overlay', xaxis: { title: { text: title } }, margin: { l: 10, r: 16, t: 28, b: 40 },
      shapes: b == null ? [] : [{ type: 'line', x0: b * sc, x1: b * sc, yref: 'paper', y0: 0, y1: 1, line: { color: c.text2, width: 1.5 } }],
      annotations: b == null ? [] : [{ x: b * sc, y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false, text: 'base ' + escapeHtml(tornadoFmt(S.metric, b)), font: { color: c.text2, size: 11 } }] });
  const th = ['Input', 'Low value', 'High value', S.name + ' at low', S.name + ' at high', 'Swing'];
  $('#tornadoTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${escapeHtml(t)}</th>`).join('')}</tr>${S.rows.map((x) => `<tr><td>${escapeHtml(x.label)}</td>
    <td>${escapeHtml(x.vals[0])}</td><td>${escapeHtml(x.vals[1])}</td>${x.err ? `<td colspan="3"><span class="why">${escapeHtml(x.err)}</span></td>`
    : `<td>${escapeHtml(tornadoFmt(S.metric, x.vLo))}</td><td>${escapeHtml(tornadoFmt(S.metric, x.vHi))}</td><td>${escapeHtml(S.base == null || (x.vLo == null && x.vHi == null) ? '–' : tornadoSwing(S.metric, x.swing))}</td>`}</tr>`).join('')}</table>`;
  const note = [];
  if (S.stale) note.push('⚠ The inputs have changed since this run: press Run tornado again.');
  note.push(`Base ${escapeHtml(S.name)}: ${escapeHtml(tornadoFmt(S.metric, b))}. Swing is the span of the low, base and high results.`);
  if ((S.metric === 'irr' || S.metric === 'eq_irr') && b == null) note.push('The base design has no IRR (the investment does not pay back), so the chart has no bars; the table shows the cases that have one.');
  else if ((S.metric === 'irr' || S.metric === 'eq_irr') && S.rows.some((x) => !x.err && (x.vLo == null || x.vHi == null))) note.push('A dash means the IRR has no value in that case (the investment does not pay back).');
  if (S.together) note.push('Battery energy capex moves the power capex and the replacement price by the same factor.');
  if (S.fast) note.push('Year 1 is simulated and repeated over the project life: PV degradation and load growth are left out, so their bars show little or no effect; battery ageing is still counted.');
  $('#tornadoNote').innerHTML = note.join(' ');
}

// ---------------------------------------------------------------- optimisation
function suggestRanges() {
  if (!P.load.kw) return;
  const annual = sum(P.load.kw), sy = PVR ? PVR.specific_yield : 1300;
  const O = P.optimizer;
  O.pv_min = 0; O.pv_max = Math.round(1.2 * annual / sy / 100) * 100;
  if (P.optimizer.max_pv_kwp > 0) O.pv_max = Math.min(O.pv_max, P.optimizer.max_pv_kwp);
  O.bess_min = 0; O.bess_max = Math.round(annual / 365 * 0.5 / 100) * 100;
  syncForms(P); autosave();
  toast(`Ranges: PV 0–${fmtNum(O.pv_max)} kWp (≈120 % of annual load), BESS 0–${fmtNum(O.bess_max)} kWh (12 h of average load)`);
}
async function runOpt() {
  if (!requireInputs()) return;
  const O = P.optimizer;
  const nums = (s) => (s || '').split(/[,;\s]+/).map(Number).filter((x) => isFinite(x) && x > 0);
  const settings = { ...O, c_rates: nums(O.c_rates_text).length ? nums(O.c_rates_text) : [0.5], sens_values: O.sens_var ? nums(O.sens_values_text) : [] };
  if (O.sens_var === 'discount_rate' || O.sens_var === 'fuel_escalation') settings.sens_values = (O.sens_values_text || '').split(/[,;\s]+/).map(Number).filter(isFinite);
  // inputs that can be zero (no fade, free replacement, no degradation)
  if (['bess_calendar_fade', 'bess_replace_kwh', 'bess_prices_scale', 'pv_degradation', 'diesel_om_unit_hour'].includes(O.sens_var))
    settings.sens_values = (O.sens_values_text || '').split(/[,;\s]+/).filter((x) => x !== '').map(Number).filter((x) => isFinite(x) && x >= 0);
  const body = { project: engineProject(O.fast ? { sim: { all_years: false } } : null), optimizer: settings };
  const allYears = !O.fast && !!P.sim.all_years, key = sizingKey();
  $('#btnOpt').disabled = true; $('#btnOptCancel').hidden = false; $('#optProg').hidden = false;
  setStatus('#optStatus', 'Starting…');
  const t0 = performance.now();
  try {
    const { job } = await api('/api/optimize', body);
    $('#btnOptCancel').onclick = () => api('/api/job/cancel?id=' + job, {}, 'POST').catch(() => {});
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const s = await api('/api/job?id=' + job);
      if (!s.done) {
        $('#optProg div').style.width = (100 * s.progress / Math.max(1, s.total)).toFixed(1) + '%';
        setStatus('#optStatus', `${fmtNum(s.progress)} / ${fmtNum(s.total)} lifecycle simulations…`);
        continue;
      }
      if (s.error) throw new Error(s.error);
      OPT = s.result;
      OPT.all_years = allYears;   // basis of the NPC values
      OPT.sizing_key = key;
      break;
    }
    setStatus('#optStatus', `✓ ${fmtNum(OPT.n_evaluated)} configurations evaluated in ${((performance.now() - t0) / 1000).toFixed(1)} s${OPT.cancelled ? ' (cancelled)' : ''}`, 'ok');
    renderOpt();
  } catch (e) { setStatus('#optStatus', e.message, 'err'); toast(e.message, true); }
  finally { $('#btnOpt').disabled = false; $('#btnOptCancel').hidden = true; $('#optProg').hidden = true; }
}
function renderOpt() {
  $('#optBody').hidden = false;
  const cur = P.econ.currency, b = OPT.best;
  const warn = [];
  if (!b) warn.push('No configuration satisfies the constraints. Relax the unmet-load / loss-of-load / reserve / renewable / curtailment limits or widen the search space.');
  (OPT.at_boundary || []).forEach((e) => warn.push({ pv_max: 'Optimum PV at the upper bound of the search range: raise "PV max".',
    bess_max: 'Optimum battery at the upper bound of the search range: raise "BESS max".', pv_min: 'Optimum PV at the lower bound of the search range: lower "PV min".', bess_min: 'Optimum battery at the lower bound of the search range: lower "BESS min".' }[e]));
  $('#optWarn').hidden = !warn.length; $('#optWarn').innerHTML = warn.map((w) => '⚠ ' + escapeHtml(w)).join('<br>');
  if (b) {
    const C = OPT.comparison || {};
    $('#optKpis').innerHTML = kpis([
      ['Optimal PV', fmtNum(b.pv_kwp, 0) + ' kWp', OPT.settings.algorithm_id === 'mopso' ? 'Pareto knee (compromise)' : OPT.settings.algorithm, true], ['Optimal battery', fmtNum(b.bess_kwh, 0) + ' kWh', fmtNum(b.bess_kw, 0) + ' kW', true],
      ...(b.wind_units > 0 ? [['Wind turbines', fmtNum(b.wind_units), `${fmtNum(b.wind_units * P.wind.rated_kw)} kW`, true]] : []),
      ['Net present cost', fmtMoney(b.npc, cur), 'diesel-only ' + fmtMoney(OPT.baseline.econ.npc, cur)], ['LCOE', `${cur} ${fmtNum(b.lcoe, 4)}`, '/kWh'],
      ['Renewable fraction', fmtPct(b.re), ''], ['Fuel saved', fmtNum((OPT.baseline.fuel_l_y1 - b.fuel) / 1000, 0) + ' kL/yr', fmtPct(1 - b.fuel / OPT.baseline.fuel_l_y1)],
      ['IRR', b.irr == null ? '–' : fmtPct(b.irr), ''], ['Payback', b.payback == null ? '–' : fmtNum(b.payback, 1) + ' yr', ''],
      ['Capex', fmtMoney(b.capex, cur), ''], ['Curtailment', fmtPct(b.curtail), ''],
    ]);
  } else $('#optKpis').innerHTML = '';
  const sel = $('#heatCrate');
  const isGrid = OPT.settings.algorithm_id === 'grid';
  sel.innerHTML = OPT.settings.c_rates.map((cr, i) => `<option value="${i}">C-rate ${cr}</option>`).join('');
  if (b) sel.value = b.crate_idx;
  sel.hidden = !isGrid || OPT.settings.c_rates.length < 2;
  $('#convCard').hidden = !(OPT.history && OPT.history.length);
  if (OPT.history && OPT.history.length) {
    const c = COL(), ob = OPT.settings.objective, mo = OPT.settings.algorithm_id === 'mopso';
    const sc = ob === 're' && !mo ? -100 : ob === 'lcoe' ? 1 : 1e-6;
    plot('chConv', [{ type: 'scatter', mode: 'lines+markers', x: OPT.history.map((_, i) => i + 1), y: OPT.history.map((v) => v * sc), line: { color: c.accent, width: 2 }, marker: { size: 6 },
      hovertemplate: 'iteration %{x}: %{y:,.4f}<extra></extra>' }],
      { showlegend: false, xaxis: { title: { text: 'Iteration' } }, yaxis: { title: { text: mo ? 'Lowest cost in Pareto archive' : ob === 're' ? 'Best renewable fraction (%)' : ob === 'lcoe' ? 'Best LCOE' : 'Best NPC (M ' + P.econ.currency + ')' } } });
  }
  drawOptHeat(); drawPareto(); drawRanked(); drawSens();
}
function drawOptHeat() {
  if (!OPT) return;
  const metric = $('#heatMetric').value, c = COL(), cur = P.econ.currency;
  const scale = { npc: 1e-6, lcoe: 1, re: 100, fuel: 1e-3, curtail: 100 }[metric];
  const unit = { npc: cur + ' M', lcoe: cur + '/kWh', re: '%', fuel: 'kL/yr', curtail: '%' }[metric];
  const blues = [[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']];
  const lay = { xaxis: { title: { text: 'PV capacity (kWp)' } }, yaxis: { title: { text: 'Battery energy (kWh)' } }, showlegend: false, margin: { l: 70, r: 10, t: 20, b: 50 } };
  if (OPT.settings.algorithm_id !== 'grid') {
    // Metaheuristic: scatter of every evaluated configuration, coloured by the chosen metric.
    const ev = OPT.evaluated || [], fe = ev.filter((g) => g.feasible), inf = ev.filter((g) => !g.feasible);
    const tr = [{ type: 'scatter', mode: 'markers', name: 'Feasible', x: fe.map((g) => g.pv_kwp), y: fe.map((g) => g.bess_kwh),
      marker: { size: 8, color: fe.map((g) => g[metric] * scale), colorscale: blues, reversescale: metric === 're', colorbar: { title: { text: unit, side: 'right' }, thickness: 12 } },
      text: fe.map((g) => `${fmtNum(g.bess_kw)} kW${g.wind_units ? ' · ' + g.wind_units + ' WT' : ''}`), hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh · %{text}<br>%{marker.color:,.3f} ' + unit + '<extra></extra>' }];
    if (inf.length) tr.push({ type: 'scatter', mode: 'markers', name: 'Infeasible', x: inf.map((g) => g.pv_kwp), y: inf.map((g) => g.bess_kwh), marker: { symbol: 'x-thin', size: 7, line: { color: c.muted, width: 1.2 } }, hovertemplate: 'infeasible<extra></extra>' });
    if (OPT.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [OPT.best.pv_kwp], y: [OPT.best.bess_kwh], marker: { symbol: 'star', size: 18, color: c.pv, line: { color: c.surface, width: 2 } }, hovertemplate: 'optimum<extra></extra>' });
    plot('chOptHeat', tr, lay);
    return;
  }
  const ci = +$('#heatCrate').value || 0;
  const px = OPT.pv_axis, bx = OPT.bess_axis;
  const z = bx.map(() => px.map(() => null)), txt = bx.map(() => px.map(() => ''));
  OPT.grid.filter((g) => g.crate_idx === ci).forEach((g) => {
    z[g.j][g.i] = g.feasible ? g[metric] * scale : null;
    txt[g.j][g.i] = g.feasible ? '' : 'infeasible: ' + g.why;
  });
  const traces = [{ type: 'heatmap', x: px, y: bx, z, text: txt, colorscale: blues, reversescale: metric === 're',
                    colorbar: { title: { text: unit, side: 'right' }, thickness: 12 }, hoverongaps: false,
                    hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh<br>%{z:,.3f} ' + unit + '<br>%{text}<extra></extra>' }];
  const inf = OPT.grid.filter((g) => g.crate_idx === ci && !g.feasible);
  if (inf.length) traces.push({ type: 'scatter', mode: 'markers', name: 'Infeasible', x: inf.map((g) => px[g.i]), y: inf.map((g) => bx[g.j]), marker: { symbol: 'x-thin', size: 8, line: { color: c.muted, width: 1.5 } }, hovertemplate: 'infeasible<extra></extra>' });
  if (OPT.best) traces.push({ type: 'scatter', mode: 'markers+text', name: 'Optimum', x: [OPT.best.pv_kwp], y: [OPT.best.bess_kwh], text: ['★ optimum'], textposition: 'top center', textfont: { color: c.text },
                              marker: { symbol: 'star', size: 18, color: c.pv, line: { color: c.surface, width: 2 } }, hovertemplate: 'optimum<extra></extra>' });
  plot('chOptHeat', traces, lay);
}
function drawPareto() {
  const c = COL(), cur = P.econ.currency;
  const all = (OPT.grid.length ? OPT.grid : OPT.evaluated || []).filter((g) => g.feasible), pf = OPT.pareto.slice().sort((a, b) => a.re - b.re);
  const tr = [
    { type: 'scatter', mode: 'markers', name: 'Feasible systems', x: all.map((r) => r.re * 100), y: all.map((r) => r.lcoe), marker: { color: c.border, size: 8 },
      text: all.map((r) => `PV ${fmtNum(r.pv_kwp)} kWp · BESS ${fmtNum(r.bess_kwh)} kWh`), hovertemplate: '%{text}<br>RE %{x:.1f} %, LCOE %{y:.4f}<extra></extra>' },
    { type: 'scatter', mode: 'lines+markers', name: 'Cheapest for each RE level', x: pf.map((r) => r.re * 100), y: pf.map((r) => r.lcoe), line: { color: c.accent, width: 2 }, marker: { size: 8 },
      text: pf.map((r) => `PV ${fmtNum(r.pv_kwp)} kWp · BESS ${fmtNum(r.bess_kwh)} kWh`), hovertemplate: '%{text}<br>RE %{x:.1f} %, LCOE %{y:.4f}<extra></extra>' },
    { type: 'scatter', mode: 'markers', name: 'Diesel only', x: [0], y: [OPT.baseline.econ.lcoe], marker: { color: c.unmet, size: 12, symbol: 'diamond' }, hovertemplate: 'Diesel only: %{y:.4f}<extra></extra>' },
  ];
  if (OPT.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [OPT.best.re * 100], y: [OPT.best.lcoe], marker: { symbol: 'star', size: 18, color: c.pv, line: { color: c.surface, width: 2 } } });
  plot('chPareto', tr, { xaxis: { title: { text: 'Renewable fraction (%)' } }, yaxis: { title: { text: 'LCOE (' + cur + '/kWh)' } } });
}
function drawRanked() {
  const cur = P.econ.currency;
  const wcol = OPT.ranked.some((r) => r.wind_units > 0);
  const th = ['#', 'PV kWp', 'BESS kWh', 'BESS kW', ...(wcol ? ['Wind units'] : []), 'Capex', 'NPC', 'LCOE', 'RE', 'Fuel kL/yr', 'Curtail', 'IRR', 'Payback', ''];
  $('#rankTable').innerHTML = `<table class="data"><tr>${th.map((t) => `<th>${t}</th>`).join('')}</tr>${OPT.ranked.slice(0, 60).map((r, i) => `<tr class="${i === 0 ? 'best' : ''}">
    <td>${i + 1}</td><td>${fmtNum(r.pv_kwp)}</td><td>${fmtNum(r.bess_kwh)}</td><td>${fmtNum(r.bess_kw)}</td>${wcol ? `<td>${r.wind_units}</td>` : ''}<td>${fmtMoney(r.capex, cur)}</td><td>${fmtMoney(r.npc, cur)}</td>
    <td>${fmtNum(r.lcoe, 4)}</td><td>${fmtPct(r.re)}</td><td>${fmtNum(r.fuel / 1000)}</td><td>${fmtPct(r.curtail)}</td><td>${r.irr == null ? '–' : fmtPct(r.irr)}</td>
    <td>${r.payback == null ? '–' : fmtNum(r.payback, 1)}</td><td><button class="btn small" data-apply="${i}">Apply</button></td></tr>`).join('')}</table>`;
  $$('[data-apply]').forEach((btn) => (btn.onclick = () => applySize(OPT.ranked[+btn.dataset.apply])));
}
function drawSens() {
  const S = OPT.sensitivity;
  $('#sensCard').hidden = !S;
  if (!S) return;
  const c = COL(), cur = P.econ.currency, rows = S.rows;
  const label = { fuel_price: 'Diesel price', discount_rate: 'Discount rate', pv_capex_kwp: 'PV capex', bess_capex_kwh: 'BESS capex', fuel_escalation: 'Fuel escalation', load_scale: 'Load multiplier',
    bess_life_scale: 'Battery life multiplier', bess_cycle_life: 'Battery cycle life', bess_calendar_fade: 'Battery calendar fade', bess_replace_kwh: 'BESS replacement cost /kWh',
    bess_prices_scale: 'Battery price multiplier', bess_replace_soh: 'Battery replacement SOH', pv_degradation: 'PV degradation', diesel_om_unit_hour: 'Genset O&M per run hour' }[S.variable] || S.variable;
  plot('chSens', [
    { type: 'scatter', mode: 'lines+markers', name: 'Optimal hybrid LCOE', x: rows.map((r) => r.value), y: rows.map((r) => (r.best ? r.best.lcoe : null)), line: { color: c.accent, width: 2 }, marker: { size: 9 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Diesel-only LCOE', x: rows.map((r) => r.value), y: rows.map((r) => r.baseline_lcoe), line: { color: c.unmet, width: 2, dash: 'dot' }, marker: { size: 9 } },
  ], { xaxis: { title: { text: label } }, yaxis: { title: { text: cur + '/kWh' } } });
  $('#sensTable').innerHTML = `<table class="data"><tr><th>${escapeHtml(label)}</th><th>Optimal PV kWp</th><th>Optimal BESS kWh</th><th>NPC</th><th>LCOE</th><th>RE</th><th>Diesel-only LCOE</th></tr>${rows.map((r) => `<tr>
    <td>${fmtSig(r.value)}</td><td>${r.best ? fmtNum(r.best.pv_kwp) : '–'}</td><td>${r.best ? fmtNum(r.best.bess_kwh) : '–'}</td><td>${r.best ? fmtMoney(r.best.npc, cur) : '–'}</td>
    <td>${r.best ? fmtNum(r.best.lcoe, 4) : '–'}</td><td>${r.best ? fmtPct(r.best.re) : '–'}</td><td>${fmtNum(r.baseline_lcoe, 4)}</td></tr>`).join('')}</table>`;
}
function applySize(r) {
  P.pv.capacity_kwp = Math.round(r.pv_kwp); P.bess.energy_kwh = Math.round(r.bess_kwh); P.bess.power_kw = Math.round(r.bess_kw);
  if (r.wind_units != null) P.wind.units = Math.round(r.wind_units);
  syncForms(P); autosave(); PVR = null;
  toast(`Applied PV ${fmtNum(r.pv_kwp)} kWp, BESS ${fmtNum(r.bess_kwh)} kWh / ${fmtNum(r.bess_kw)} kW. Simulating…`);
  showTab('sim'); runSim();
}

// ---------------------------------------------------------------- forecast & EMS
function drawForecast() {
  if (!SIM) return;
  const fcName = (list, k) => (list.find(([v]) => v === k) || [k, k])[1];
  const R = SIM.result, F = R.forecast, H = R.hourly, c = COL();
  const pred = P.diesel.strategy === 'predictive';
  $('#fcKpis').innerHTML = kpis([
    ['PV forecast error, hour-ahead', fmtPct(F.pv_nmae_h1), 'MAE / mean PV · ' + fcName(PV_FC_METHODS, P.ems.pv_forecast), true],
    ['PV forecast error, day-ahead', fmtPct(F.pv_nmae_da), 'bias ' + fmtPct(F.pv_bias_da)],
    ['Load forecast error, hour-ahead', fmtPct(F.load_nmae_h1), 'MAE / mean load · ' + fcName(LOAD_FC_METHODS, P.ems.load_forecast)],
    ['Load forecast error, day-ahead', fmtPct(F.load_nmae_da), 'bias ' + fmtPct(F.load_bias_da)],
    ['EMS re-plans (year 1)', pred ? fmtNum(F.plans) : 'n/a', pred ? `every ${P.ems.replan} h, ${P.ems.horizon} h horizon` : 'select Predictive EMS'],
    ['Net-load forecast error', pred ? fmtEnergy(F.net_error_kwh) : 'n/a', 'sum of |error|, year 1'],
    ['Battery compensation', pred ? fmtEnergy(F.bess_compensation_kwh) : 'n/a', 'deviation from plan to avoid unplanned starts'],
  ]);
  const w = +$('#fcWeek').value, s = Math.min(w * 168, HOURS - 168), idx = Array.from({ length: 168 }, (_, i) => s + i);
  const v = $('#fcVar').value;
  // the load forecasts are of the site load, so the actual leaves out the auxiliaries
  const act = v === 'pv' ? H.pv_avail : H.aux ? H.load.map((l, i) => l - H.aux[i]) : H.load, h1 = v === 'pv' ? H.pv_fc_h1 : H.load_fc_h1, da = v === 'pv' ? H.pv_fc_da : H.load_fc_da;
  const actName = v === 'load' && H.aux && H.aux.some((x) => x > 0) ? 'Actual site load' : 'Actual';
  const ticks = idx.filter((h) => h % 24 === 0);
  const color = v === 'pv' ? c.pv : c.load;
  plot('chFc', [
    { type: 'scatter', mode: 'lines', name: actName, x: idx, y: idx.map((h) => act[h]), line: { color, width: 2.5 } },
    { type: 'scatter', mode: 'lines', name: 'Hour-ahead forecast', x: idx, y: idx.map((h) => h1[h]), line: { color: c.gen, width: 1.5 } },
    { type: 'scatter', mode: 'lines', name: 'Day-ahead forecast', x: idx, y: idx.map((h) => da[h]), line: { color: c.soc, width: 1.5, dash: 'dash' } },
  ].map((t) => ({ ...t, hovertemplate: '%{y:,.0f} kW<extra>' + t.name + '</extra>' })),
  { hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour) }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } });
  if (pred && P.bess.energy_kwh > 0) {
    if (!$('#chPlan').data) $('#chPlan').textContent = '';
    plot('chPlan', [
      { type: 'scatter', mode: 'lines', name: 'Actual SOC', x: idx, y: idx.map((h) => H.soc[h] * 100), line: { color: c.soc, width: 2.5 } },
      { type: 'scatter', mode: 'lines', name: 'EMS target', x: idx, y: idx.map((h) => H.soc_target[h] * 100), line: { color: c.soc, width: 1.5, dash: 'dash' } },
      { type: 'scatter', mode: 'lines', name: 'Gensets online', x: idx, y: idx.map((h) => H.gen_units[h]), yaxis: 'y2', line: { color: c.gen, width: 2, shape: 'hv' } },
    ], { hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour), anchor: 'y2' },
         yaxis: { title: { text: 'SOC (%)' }, domain: [0.38, 1], range: [0, 100] }, yaxis2: { title: { text: 'Units' }, domain: [0, 0.3], rangemode: 'tozero' } });
  } else {
    Plotly.purge('chPlan');
    $('#chPlan').innerHTML = '<p class="hint" style="padding:20px">Select "Predictive EMS" in Diesel &amp; control and re-run the simulation to see the EMS plan.</p>';
  }
}

async function runSchedule() {
  if (!P.load.kw) { toast('Define the load first.', true); return; }
  await busy('#btnSched', async () => {
    try {
      setStatus('#schedStatus', 'Fetching weather forecast…');
      const S = P.sched;
      const fc = await api('/api/forecast-weather', { provider: S.provider, lat: P.location.lat, lon: P.location.lon, days: S.days, api_key: S.api_key });
      setStatus('#schedStatus', 'Planning…');
      // The plan starts at the current hour of this computer's clock (UTC), where the SOC entered applies.
      SCHED = await api('/api/ems/schedule', { project: engineProject(), forecast: fc, soc_now: S.soc_now, load_scale: S.load_scale,
                                               now_utc: new Date().toISOString().slice(0, 16), days: S.days });
      SCHED.soc_now = S.soc_now;
      drawSchedule();
    } catch (e) { setStatus('#schedStatus', e.message, 'err'); }
  });
}
function localLabel(iso, off) {
  const d = new Date(Date.parse(iso + ':00Z') + off * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
// Hours from a row's time_utc to the start of its hour: -1 for Open-Meteo (stamps the end of the hour), 0 for MET Norway.
function schedLead(S) {
  const l = S.plan_start_utc && S.rows.length ? (Date.parse(S.plan_start_utc + ':00Z') - Date.parse(S.rows[0].time_utc + ':00Z')) / 3600e3 : 0;
  return Number.isFinite(l) ? l : 0;
}
function drawSchedule() {
  const S = SCHED, rows = S.rows, c = COL(), off = S.utc_offset, T = S.totals, wind = P.wind.units > 0;
  $('#schedBody').hidden = false; $('#btnSchedCsv').hidden = false;
  // When the forecast was fetched and, for MET Norway, how old its model run was then (site local time, as the rows).
  const at = (iso) => (iso ? localLabel(iso.slice(0, 16), off) : '–');
  const age = S.model_updated_utc && S.issued_utc ? (Date.parse(S.issued_utc) - Date.parse(S.model_updated_utc)) / 3600e3 : null;
  setStatus('#schedStatus', `✓ ${rows.length} h planned. Forecast from ${S.provider}, fetched ${at(S.issued_utc)}${age != null && isFinite(age) ? `; model run updated ${fmtNum(age, 1)} h earlier` : ''}. ` +
    `Plan from ${at(S.plan_start_utc)}; the SOC you entered applies at that time. ${S.note}`, 'ok');
  $('#schedWarn').hidden = !(age > 12);
  $('#schedWarn').textContent = age > 12 ? `⚠ The ${S.provider} model run was updated ${fmtNum(age, 1)} h before the forecast was fetched, so the forecast may be out of date. Fetch it again later.` : '';
  $('#schedKpis').innerHTML = kpis([
    ['Planned fuel', fmtNum(T.fuel_l, 0) + ' L', `next ${rows.length} h`, true], ['PV used', fmtEnergy(T.pv_used_kwh), fmtPct(T.pv_used_kwh / T.load_kwh) + ' of load'],
    ...(wind ? [['Wind used', fmtEnergy(T.wind_used_kwh), fmtPct(T.wind_used_kwh / T.load_kwh) + ' of load']] : []),
    ['Diesel energy', fmtEnergy(T.gen_kwh), ''], [wind ? 'PV and wind curtailed' : 'PV curtailed', fmtEnergy(T.curtail_kwh), ''], ['Peak units online', fmtNum(Math.max(...rows.map((r) => r.units))), 'of ' + P.diesel.units],
  ]);
  const x = rows.map((r) => localLabel(r.time_utc, off + schedLead(S)));   // each row by the start of its hour, as Plan from
  plot('chSched', [
    { type: 'bar', name: 'Diesel', x, y: rows.map((r) => r.gen_kw), marker: { color: c.gen } },
    { type: 'bar', name: 'Battery (+ discharge / − charge)', x, y: rows.map((r) => r.bess_kw), marker: { color: c.bess } },
    { type: 'scatter', mode: 'lines', name: 'PV forecast', x, y: rows.map((r) => r.pv_kw), line: { color: c.pv, width: 2 } },
    ...(wind ? [{ type: 'scatter', mode: 'lines', name: 'Wind forecast', x, y: rows.map((r) => r.wind_kw), line: { color: c.wind, width: 2 } }] : []),
    { type: 'scatter', mode: 'lines', name: 'Load forecast', x, y: rows.map((r) => r.load_kw), line: { color: c.load, width: 2, shape: 'hv' } },
    { type: 'scatter', mode: 'lines', name: 'SOC target', x, y: rows.map((r) => r.soc * 100), yaxis: 'y2', line: { color: c.soc, width: 2 } },
    { type: 'scatter', mode: 'lines', name: 'Gensets online', x, y: rows.map((r) => r.units), yaxis: 'y3', line: { color: c.gen, width: 2, shape: 'hv' } },
  ], { barmode: 'relative', hovermode: 'x unified', xaxis: { anchor: 'y3', nticks: 16 },
       yaxis: { title: { text: 'kW' }, domain: [0.42, 1] }, yaxis2: { title: { text: 'SOC %' }, domain: [0.2, 0.37], range: [0, 100] },
       yaxis3: { title: { text: 'Units' }, domain: [0, 0.15], rangemode: 'tozero' }, legend: { orientation: 'h', y: -0.1 } });
  $('#schedTable').innerHTML = `<table class="data"><tr><th>Hour from (local)</th><th>Load kW</th><th>PV kW</th>${wind ? '<th>Wind kW</th>' : ''}<th>Battery kW</th><th>SOC</th><th>Units</th><th>Diesel kW</th><th>Curtail kW</th><th>Fuel L</th></tr>${rows.map((r, i) => `<tr>
    <td>${x[i]}</td><td>${fmtNum(r.load_kw)}</td><td>${fmtNum(r.pv_kw)}</td>${wind ? `<td>${fmtNum(r.wind_kw)}</td>` : ''}<td>${fmtNum(r.bess_kw)}</td><td>${fmtPct(r.soc, 0)}</td><td>${r.units}</td><td>${fmtNum(r.gen_kw)}</td><td>${fmtNum(r.curtail_kw)}</td><td>${fmtNum(r.fuel_l)}</td></tr>`).join('')}</table>`;
}
function exportSchedule() {
  if (!SCHED) return;
  const S = SCHED, v = (s) => s || 'none';
  const lines = [`# provider ${v(S.provider)}, fetched UTC ${v(S.issued_utc)}, model updated UTC ${v(S.model_updated_utc)}, plan start UTC ${v(S.plan_start_utc)}, SOC now ${S.soc_now}`,
    'time_utc,time_local,load_kw,pv_kw,wind_kw,bess_kw,soc,units,gen_kw,curtail_kw,fuel_l,start_local'];
  // time_utc and time_local are the provider's stamp; start_local is the start of the hour the row covers
  const lead = schedLead(S);
  S.rows.forEach((r) => lines.push([r.time_utc, localLabel(r.time_utc, S.utc_offset), r.load_kw, r.pv_kw, r.wind_kw || 0, r.bess_kw, r.soc, r.units, r.gen_kw, r.curtail_kw, r.fuel_l,
    localLabel(r.time_utc, S.utc_offset + lead)].map((x) => (typeof x === 'number' ? +x.toFixed(3) : x)).join(',')));
  download((P.name || 'schedule') + '_day_ahead.csv', lines.join('\n'), 'text/csv');
}
