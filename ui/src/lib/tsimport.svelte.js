// Timestamped load and weather files (Upload CSV on Solar resource and Load) and the data checks of the project's weather and load.
// The import dialog previews the first rows and takes the columns, date order, year, time basis, timestamp label and units; the
// engine (import_series) turns the file into 8760 hourly means with an import report, which is shown before the data replace
// P.load.kw or P.weather. After every weather fetch or upload and every load upload, data_qc checks the data (P.weather.qc,
// P.load.qc). The flags alone change nothing; the timing fixes change the weather only when their button is clicked.
// The words are in tsimport/texts.js, the reading of the file in tsimport/guess.js.
import { call } from './ipc.js';
import { legacy } from './legacy.js';
import { openSession, engineOpt, clockOk } from './tsimport/guess.js';
import { importInfo, usedText, applyFix } from './tsimport/texts.js';

// dlg: the open dialog's session (see guess.js openSession) plus `years`, `sent`, `busy`; null while closed. The file text and the
// engine's answer (8760-value arrays) stay out of the proxy: result() and `rev`.
export const ts = $state({ dlg: null, rev: 0, qcRev: 0 });
let TEXT = '', RES = null;
export const result = () => { ts.rev; return RES; };

// What the guesses and the engine options take from the open project
function ctxFor(kind) {
  const P = legacy.project();
  return { tz: P.location.tz, utcOffset: P.location.utc_offset, isUtc: !!(P.weather_ui && P.weather_ui.is_utc),
    prev: (kind === 'load' ? P.load.import : P.weather && P.weather.import) || undefined };
}
export const clockAllowed = (tc) => !!(ts.dlg && clockOk(ts.dlg, tc, ctxFor(ts.dlg.kind)) && tc >= 0);

export async function openImport(kind, file) {
  const text = await file.text();
  const S = openSession(kind, file.name, text, ctxFor(kind));
  TEXT = text; RES = null;
  Object.assign(S, { years: null, sent: null, busy: false });
  ts.dlg = S;
  ts.rev++;
  check();
}

export function closeImport() { ts.dlg = null; TEXT = ''; RES = null; ts.rev++; }

// An option changed: the report no longer matches, and the long-gap fill is asked for again
export function setOpt(k, v) {
  const S = ts.dlg, o = S.opt;
  o[k] = v;
  if (k === 'time_col') {
    o.time2_col = -1;
    if (o.time_col < 0 && o.basis === 'local_clock') o.basis = 'local_standard';
    if (S.kind === 'load') o.cols = o.cols.filter((c) => c !== o.time_col);
  }
  changed();
}
export function toggleCol(i, on) {
  const o = ts.dlg.opt;
  o.cols = on ? [...new Set(o.cols.concat(i))].sort((a, b) => a - b) : o.cols.filter((x) => x !== i);
  changed();
}
function changed() {
  const S = ts.dlg;
  S.opt.fill_long = false;
  if (RES || S.err) S.stale = true;
}
export function fillLong() { ts.dlg.opt.fill_long = true; check(); }

// The file read again by the engine with the options as they are now
export async function check() {
  const s = ts.dlg;
  if (!s) return;
  const sent = $state.snapshot(s.opt), eo = engineOpt({ ...$state.snapshot(s), opt: sent }, ctxFor(s.kind));
  s.stale = false; s.err = ''; RES = null; s.busy = true; ts.rev++;
  try {
    const res = await call('import_series', { body: { text: TEXT, options: eo } });
    if (ts.dlg !== s) return;
    RES = res;
    s.sent = sent;
    if (res.report && res.report.years) s.years = res.report.years;
  } catch (e) { if (ts.dlg === s) s.err = e.message; }
  if (ts.dlg !== s) return;
  s.busy = false;
  if (JSON.stringify($state.snapshot(s.opt)) !== JSON.stringify(sent)) s.stale = true;   // options changed while the file was read
  ts.rev++;
}

export const canUse = () => { const S = ts.dlg; return !!(S && RES && !S.stale && !(S.kind === 'load' && !RES.kw)); };

export async function use() {
  const s = ts.dlg, res = RES;
  if (!s || !res || s.stale) return;
  const P = legacy.project(), R = res.report, info = importInfo(s.kind, s.file, s.sent, R), what = usedText(R), kind = s.kind, file = s.file;
  closeImport();
  if (kind === 'load') {
    P.load.kw = res.kw; P.load.source = 'csv'; P.load.import = info; P.load.qc = null;
    legacy.dataApplied('load', `✓ Loaded ${file} (${what}). Measured profile: template settings are ignored until you press Generate.`, true);
  } else {
    P.weather = { source: 'CSV: ' + file, is_utc: res.is_utc, time_offset: res.time_offset, ghi: res.ghi, dni: res.dni, dhi: res.dhi, tamb: res.tamb, wind: res.wind,
      note: `User file, ${what}.`, import: info };
    P.weather_ui.is_utc = !!res.is_utc;
    legacy.dataApplied('weather', `✓ Loaded ${file} (${what})`, true);
  }
  await runQc(kind);
}

// ---------------------------------------------------------------- data checks
// data_qc for one data set; the result is kept only while the data are still the ones checked. A measured load only.
export async function runQc(only) {
  const P = legacy.project(), W = P.weather, kw = P.load.kw;
  if (only === 'weather' ? !(W && W.ghi) : !(kw && P.load.source === 'csv')) return;
  try {
    const r = await call('data_qc', { body: { project: legacy.engineProject(false), only } });
    const now = legacy.project();
    if (only === 'weather' && now.weather === W) { W.qc = r.weather; legacy.dataApplied('weather'); }
    if (only === 'load' && now.load.kw === kw) { now.load.qc = r.load; legacy.dataApplied('load'); }
  } catch (e) { legacy.toast('Data checks: ' + e.message, true); }
}
const timers = {};
// Checks again shortly after the inputs they depend on change (site for the timing, genset fleet for the load unit check).
export function qcLater(only) { clearTimeout(timers[only]); timers[only] = setTimeout(() => runQc(only), 600); }

// The data checks blocks read the project again when this changes (the old pages draw them after every data change)
export const qcRefresh = () => { ts.qcRev++; };

export function fixWeather(what, x) {
  const W = legacy.project().weather;
  if (!W) return;
  const done = applyFix(W, what, x);
  if (what === 'utc') legacy.project().weather_ui.is_utc = W.is_utc;
  legacy.dataApplied('weather', `✓ Weather ${done}.`, true);
  runQc('weather');
}
