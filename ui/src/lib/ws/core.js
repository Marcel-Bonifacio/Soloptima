// What every page of the workspace needs from the open project: the project as the engine takes it, the
// check that the inputs are there, autosave. The page owners import from here; project.js (open, field changes) builds on it.
import { W } from './state.js';
import { toast } from '../toast.js';
import { queueSave } from '../projects.svelte.js';
import { isUsed } from '../layout/edit.svelte.js';
import { showTab } from './tabs.svelte.js';
import { leanDiesel, leanEms, leanSim, leanLoad } from './lean.js';

export const autosave = () => queueSave();   // saved projects go to disk through the engine

// Project as the engine expects it (UI-only blocks stripped).
export function engineProject(overrides) {
  const P = W.P;
  const p = { name: P.name, location: engineLocation(P.location), weather: engineWeather(P.weather), load: leanLoad(P.load, P.sim),
    pv: P.pv, bess: P.bess, aux: P.aux, wind: P.wind, diesel: P.diesel, ems: P.ems, econ: P.econ, sim: P.sim, finance: P.finance, layout: engineLayout(),
    // only a grid that is switched on: a project without one keeps the inputs (and the fingerprints of its results) it had
    ...(P.grid && P.grid.enabled ? { grid: P.grid } : {}) };
  const out = overrides ? { ...p, ...overrides } : p;
  return { ...out, diesel: leanDiesel(out.diesel), ems: leanEms(out.ems), sim: leanSim(out.sim) };  // lean.js: unused new inputs left out
}
// The layout as the engine takes it: the table width up the slope (modules across x module side) sets the row geometry of diffuse
// shading and bifacial gain; the PV areas, tables and objects go along only when the engine uses them, for the shading by
// buildings and trees or for areas with their own orientation (fixed tables), as layout_used in the engine.
export function engineLayout() {
  const L = W.P.layout, out = { orientation: L.orientation, modules_across: L.modules_across };
  if (isUsed()) {
    out.polygons = (L.polygons || []).filter((x) => x.type !== 'exclusion');
    out.result = { tables: (L.result && L.result.tables) || [], table_area: (L.result && L.result.table_area) || [] };
  }
  return out;
}
// The weather without its import report and data checks (P.weather.import, P.weather.qc): they are not engine inputs, so they stay
// out of the request and of the fingerprints of results.
function engineWeather(Wx) {
  if (!Wx || (Wx.qc === undefined && Wx.import === undefined)) return Wx;
  const { qc, import: imp, ...w } = Wx;
  return w;
}
// The location without the GUI's time-zone fields (tz, utc_offset_src): where the offset came from neither reaches the engine nor
// makes a result stale.
function engineLocation(L) {
  if (!L || (L.tz === undefined && L.utc_offset_src === undefined)) return L;
  const { tz, utc_offset_src, ...loc } = L;
  return loc;
}
export function requireInputs() {
  const P = W.P;
  if (!P.weather || !P.weather.ghi) { toast('Get solar data first (tab 2 · Solar resource).', true); showTab('resource'); return false; }
  if (!P.load.kw || P.load.kw.length !== 8760) { toast('Define the load first (tab 3 · Load).', true); showTab('load'); return false; }
  return true;
}
