// The Solar resource and Load pages: fetching weather, the synthetic load and its editors, and what the CSV import hands over.
// The weather and the load belong to the open project (W.P); this store holds the status texts, the busy flag and `rev`, which
// the pages read again after a change of the data.
import { call } from './ipc.js';
import { W } from './ws/state.js';
import { autosave, engineProject, requireInputs } from './ws/core.js';
import { refreshForms } from './state.svelte.js';
import { qcRefresh, runQc, openImport } from './tsimport.svelte.js';
import { toast } from './toast.js';
import { applyTemplate, synthLoad, pastedNumbers, pasteInto, ryFingerprint, ryBody } from './data-view.js';

export const dat = $state({ rev: 0, wxBusy: false, wxStatus: '', wxKind: '', loadStatus: '', loadKind: '' });

export function reset() {
  Object.assign(dat, { wxBusy: false, wxStatus: '', wxKind: '', loadStatus: '', loadKind: '' });
  dat.rev++;
}

// ---------------------------------------------------------------- weather
const wxSet = (text, kind = '') => { dat.wxStatus = text; dat.wxKind = kind; };
const loadSet = (text, kind = '') => { dat.loadStatus = text; dat.loadKind = kind; };

export async function fetchWeather() {
  const P = W.P;
  if (!P || dat.wxBusy) return;
  wxSet('Downloading hourly data… (PVGIS ~5 s, NASA POWER ~20 s)');
  dat.wxBusy = true;
  try {
    const w = await call('weather', { body: { source: P.weather_ui.source, lat: P.location.lat, lon: P.location.lon, year: P.weather_ui.year } });
    if (W.P !== P) return;   // another project was opened meanwhile
    P.weather = w;
    if (w.elevation) P.location.elevation = w.elevation;
    wxSet(`✓ ${w.source}: ${w.note}`, 'ok');
    W.PVR = null; W.PVREF = null;
    dat.rev++; refreshForms(); autosave();
    runQc('weather');
  } catch (e) { if (W.P === P) wxSet(e.message, 'err'); } finally { dat.wxBusy = false; }
}

// A weather CSV goes through the import dialog, which previews it, reads it through the engine and shows the import report before
// the data replace P.weather.
export async function uploadWeather(file) {
  if (!file) return;
  try { await openImport('weather', file); } catch (e) { wxSet(e.message, 'err'); }
}

// ---------------------------------------------------------------- load
// Generates the synthetic load of project p (the open one by default) into p.load.kw. redraw: the pages follow and the project is
// saved (not needed while a project is being opened).
export function generateLoad(redraw, p = W.P) {
  const L = p.load;
  applyTemplate(L);
  L.kw = synthLoad(L);
  L.kw_sub = null; L.sub_min = null;   // a synthetic load is hourly
  if (redraw && p === W.P) { loadSet(''); dat.rev++; refreshForms(); autosave(); }
}

export async function uploadLoad(file) {
  if (!file) return;
  try { await openImport('load', file); } catch (e) { loadSet(e.message, 'err'); }
}

// "Generate 8760 profile": back to the synthetic source
export function generateButton() {
  const L = W.P.load;
  L.source = 'synthetic'; L.import = null; L.qc = null;
  generateLoad(true);
  toast('Generated 8760-hour load profile');
}

// The daily shape and monthly scaling editors. Each edit makes the profile synthetic again and generates it.
export function setDaily(h, text) {
  const L = W.P.load, v = Math.max(0, +text || 0);
  L.daily[h] = v; L.template = 'custom'; L.source = 'synthetic';
  generateLoad(true);
  return v;
}
export function pasteDaily(h0, text) {
  const nums = pastedNumbers(text);
  if (!nums) return false;
  const L = W.P.load;
  pasteInto(L.daily, h0, nums);
  L.template = 'custom'; L.source = 'synthetic';
  generateLoad(true);
  return true;
}
export function setMonthly(m, text) {
  const L = W.P.load, v = Math.max(0, +text || 0);
  L.monthly[m] = v; L.source = 'synthetic';
  generateLoad(true);
  return v;
}

// ---------------------------------------------------------------- what the CSV import and the data checks hand over
// kind: 'load' | 'weather'. status: the text under the upload button. full: the data were replaced (the PV yield and the checks
// depend on them); otherwise only the data checks changed.
export function applied(kind, status, full) {
  if (full) { W.PVR = null; W.PVREF = null; }
  if (status) (kind === 'load' ? loadSet : wxSet)(status, 'ok');
  dat.rev++;
  if (full) refreshForms();
  qcRefresh();
  autosave();
}

// ---------------------------------------------------------------- weather years (P50/P90)
// The card itself is screens/results/ResourceYears.svelte (store resource-years.svelte.js); what it needs from the open project is here.
// The run's fingerprint leaves out the debt-sizing factor it sets (p90_factor fixed at 1), so applying the factor does not make it stale.
export function ryKey() {
  const P = W.P;
  return ryFingerprint(engineProject({ finance: { ...P.finance, p90_factor: 1 } }), P.resource_years);
}
export function ryRequest() {
  if (!requireInputs()) return null;
  return { key: ryKey(), body: ryBody(engineProject(), W.P.resource_years) };
}
