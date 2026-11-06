// The open project of the workspace: what happens when a value changes, when a project opens, and the
// copies made of it (landing-page badges, the file on disk, the exported file).
import { W } from './state.js';
import { autosave } from './core.js';
import { showTab, ws } from './tabs.svelte.js';
import { refreshForms, forms } from '../state.svelte.js';
import { queueSave } from '../projects.svelte.js';
import { toast } from '../toast.js';
import { clone, siteZone } from './util.js';
import { migrateProject } from '../migrate-project.js';
import { defaultProject, MOUNT_STYLES, mountStyleOf } from '../schema/index.js';
import { saveFile } from '../ipc.js';
import * as map from '../layout/map.svelte.js';
import { scheduleRelayout, isUsed } from '../layout/edit.svelte.js';
import { pvChanged as designPvChanged, resetElectrical } from '../equip/electrical.svelte.js';
import { resetEquipment } from '../equip/equipment.svelte.js';
import { resetForecast } from '../forecast.svelte.js';
import { reset as resetResults, runSim } from '../results.svelte.js';
import { resetRy } from '../resource-years.svelte.js';
import { setPvLosses } from '../plant.svelte.js';
import { qcLater } from '../tsimport.svelte.js';
import { simStale } from './keys.js';
import { generateLoad, reset as resetData } from '../data.svelte.js';
import { calcPV, pvStatus, reset as resetPv } from '../pv.svelte.js';
import { reset as resetSim } from '../sim.svelte.js';
import { reset as resetOptions } from '../options.svelte.js';
import { reset as resetVariants } from '../variants.svelte.js';
import { reset as resetTornado } from '../tornado.svelte.js';
import { reset as resetPlan } from '../plan.svelte.js';
import { onFinanceKey, reset as resetFinance } from '../finance.svelte.js';

let pvTimer = null, engineLayoutUsed = false;

// The yield is cheap to recompute: refreshed shortly after the last edit that changes it
export function pvChanged() {
  W.PVR = null; W.PVREF = null; clearTimeout(pvTimer); designPvChanged(); refreshForms();
  if (W.P.weather) { pvStatus('Recalculating…'); pvTimer = setTimeout(() => calcPV(true), 500); }
}
const LAYOUT_KEYS = ['pv.tilt', 'pv.gcr', 'pv.mount', 'pv.module_length', 'pv.module_width', 'pv.module_wp', 'pv.azimuth', 'pv.azimuth_auto', 'pv.tracker_axis_azimuth'];

// A value of the project was changed by a page: the other forms showing it, the saved copy and the recalculations follow
export function onFieldChange(key) {
  const P = W.P;
  // a mounting style sets the thermal loss factors; typing either factor moves the style to the one that matches, or Custom
  if (key === 'pv.mount_style' && MOUNT_STYLES[P.pv.mount_style]) Object.assign(P.pv, MOUNT_STYLES[P.pv.mount_style]);
  else if (key === 'pv.uc' || key === 'pv.uv') P.pv.mount_style = mountStyleOf(P.pv);
  refreshForms();
  autosave();
  if (key.startsWith('load.') && P.load.source === 'synthetic') generateLoad(true);
  if (key === 'location.lat' || key === 'location.lon') map.moveMarker();
  if (key === 'location.utc_offset') { P.location.utc_offset_src = 'typed'; map.siteInfo(); }
  if ((key.startsWith('layout.') && !['layout.result', 'layout.polygons', 'layout.base', 'layout.removed', 'layout.stations'].includes(key)) || LAYOUT_KEYS.includes(key)) scheduleRelayout();
  if (key.startsWith('pv.') || (key.startsWith('location') && key !== 'location.utc_offset_src') || key === 'equipment.apply' || key === 'electrical.apply' ||
      key === 'layout.orientation' || key === 'layout.modules_across') pvChanged();
  // the areas, tables and objects of the layout reach the yield when they shade it or set orientations (engineLayout)
  if (key === 'layout.polygons' || key === 'layout.result') {
    const used = isUsed();
    if (used || engineLayoutUsed) pvChanged();
    engineLayoutUsed = used;
  }
  if (key.startsWith('finance.')) onFinanceKey(key);
  // the data checks follow the site (timing against the sun) and the genset fleet (load unit check); 'location' alone is a site
  // picked on the map or a zone offset taken with Use
  if (/^location(\.(lat|lon|utc_offset))?$/.test(key) && P.weather && P.weather.qc) qcLater('weather');
  if ((key === 'diesel.units' || key === 'diesel.unit_kw') && P.load.qc) qcLater('load');
  if (W.SIM && ws.live && /^(pv|bess|aux|diesel|econ|ems|sim)\./.test(key) && ws.tab === 'sim') runSim(true);
}

export const migrate = (p) => migrateProject(p, siteZone);

// a new or imported project made ready to save: defaults filled in, the synthetic load generated
export function prepare(p) {
  migrate(p);
  if (p.load.source === 'synthetic' || !p.load.kw) { const keep = W.P; W.P = p; generateLoad(false); W.P = keep; }
  return p;
}

// the badges of the project list; results from other inputs give none
export function meta(p) {
  const S = W.SIM;
  const m = { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, gensets: p.diesel.units, genset_kw: p.diesel.unit_kw,
    wind_units: p.wind ? p.wind.units : 0, lat: p.location.lat, lon: p.location.lon, currency: p.econ.currency, strategy: p.diesel.strategy };
  if (S && W.P === p && !simStale()) {
    m.re = S.result.re_fraction; m.lcoe = S.result.econ.lcoe; m.npv_savings = S.comparison.npv_savings;
    if (S.finance && S.finance.metrics) { m.equity_irr = S.finance.metrics.equity_irr; m.fin_model = S.finance.model; }
  }
  return m;
}
// the copy written to disk: the layout's tables are recomputed on load
export const saveCopy = () => ({ ...W.P, layout: { ...W.P.layout, result: W.P.layout.result ? { ...W.P.layout.result, tables: [] } : null } });

// Export .json (top bar, Report & export, and Export on a project card of the landing page): a project file is made to be shared,
// so the API keys stay out of it. Autosave to the data folder keeps them.
export function exportProject(p = W.P) {
  const q = clone(p);
  if (q.layout) q.layout.google_key = '';
  if (q.sched) q.sched.api_key = '';
  saveFile((p.name || 'project') + '.json', JSON.stringify(q), 'application/json');
  if ((p.layout && p.layout.google_key) || (p.sched && p.sched.api_key)) toast('API keys were left out of the exported file');
}

// the placeholder project the workspace starts with, until the landing page opens a saved one: made before the pages mount so
// they always have a project to read
export function placeholder() {
  W.P = defaultProject();
  generateLoad(false);
}

// A project opens in the workspace
export function setProject(p) {
  W.P = p; migrate(p);
  if (!p.load.kw || p.load.source === 'synthetic') generateLoad(false);
  W.PVR = null; W.PVREF = null; W.SIM = null; W.SIM_PREV = null; W.OPT = null; W.SCHED = null; W.OPTIONS = null; W.TORNADO = null; W.VARIANTS = null;
  clearTimeout(pvTimer);
  resetResults(); resetRy(); resetEquipment(); resetElectrical(); resetForecast(); setPvLosses(null);
  resetData(); resetPv(); resetSim(); resetOptions(); resetVariants(); resetTornado(); resetPlan(); resetFinance();
  refreshForms();
  map.reload();
  engineLayoutUsed = isUsed();
  if (engineLayoutUsed) pvChanged();   // the shade of buildings and trees on the layout map comes with the yield
  autosave();
}
// open a project and its page; the page that was open last, or the site
export function open(p, tab) {
  setProject(p);
  const t = tab || (p.ui && p.ui.tab) || 'site';
  showTab(t);
  return t;
}

// "Use in EMS" of the Forecast Lab: the method becomes the project's forecaster and the strategy the predictive one
export function useForecast(variable, id) {
  if (variable === 'pv') W.P.ems.pv_forecast = id; else W.P.ems.load_forecast = id;
  W.P.diesel.strategy = 'predictive';
  refreshForms(); autosave();
}
export { forms, queueSave };
