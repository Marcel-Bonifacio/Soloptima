// The electrical design of the open project, computed by the engine (engine/src/electrical, the `electrical` command): the design
// with its short-circuit and protection study, cached until an input or a result changes; the cable and loss actions; the load
// flow and the single-line diagram. The design belongs to nobody's saved data: it is computed from the project
// (project.electrical, project.equipment), the last PV yield and the last simulation whenever they change.
import { forms } from '../state.svelte.js';
import { res, data } from '../results.svelte.js';
import { saveFile, call } from '../ipc.js';
import { eq } from './equipment.svelte.js';
import { plantLengths } from './siteplan.js';
import { buildSld, SLD_W, SLD_H } from './sld.js';
import { buildTcc } from './protection.js';
import { fmtNum, fmtPct } from '../format.js';
import { toast } from '../toast.js';
import { W } from '../ws/state.js';
import { onFieldChange } from '../ws/project.js';
import { refreshForms } from '../state.svelte.js';

export const el = $state({ rev: 0, pv: 0, active: false, cables: true, lfRev: 0, lfHour: 0, calc: 0, busy: false });

let cache = { key: '', D: null, PR: null, job: null };
let rteBase = null;       // the battery efficiency before the cable and transformer derating, so repeated Apply does not compound it
let LF = null, BUS = null, busHour = -1;   // the load flow of the last run, the buses of the hour shown and its hour (large: not Svelte state)
// the buses of every hour asked since the design inputs last changed (each ask sends the whole request)
const busCache = new Map();
let busKey = '';
const clearBuses = () => { BUS = null; busHour = -1; busCache.clear(); };

// What the engine needs of the project and its results: the inputs the design reads (the critical share and the grid
// connection for the islanded N-1 screen), the PV yield's hourly AC, cell
// temperature and plane irradiance, the dispatch's hourly flows and year 1, and the cable lengths measured on the layout map
const HOURLY = ['pv_avail', 'pv_to_load', 'pv_to_bess', 'bess_dis', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'gen_units', 'load', 'aux', 'wind_to_load', 'wind_to_bess', 'grid_to_bess'];
function request() {
  const P = W.P, PVR = W.PVR, S = data.sim;
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] != null).map((k) => [k, o[k]]));
  return {
    project: { location: P.location, econ: P.econ, load: { kw: P.load.kw, critical_share: P.load.critical_share }, pv: P.pv, bess: P.bess,
               diesel: P.diesel, aux: P.aux, grid: P.grid ? { enabled: P.grid.enabled, import_kw: P.grid.import_kw } : null,
               equipment: P.equipment, electrical: P.electrical, weather: P.weather && P.weather.tamb ? { tamb: P.weather.tamb } : null },
    pvr: PVR ? pick(PVR, ['ac_per_kwp', 'tcell', 'poa']) : null,
    sim: S ? { result: { hourly: pick(S.result.hourly, HOURLY), years: [pick(S.result.years[0], ['bess_dis', 'bess_ch', 'gen_kwh'])] } } : null,
    lengths: plantLengths(P),
  };
}
// the shell's commands take their JSON as `body` (src-tauri/src/commands.rs)
const electrical = (action, extra = {}) => call('electrical', { body: { action, request: request(), ...extra } });
const keyNow = () => [forms.rev, res.rev, el.rev, el.pv, eq.rev].join('|');

// The design as last computed (null until the first answer); reads the counters that change it, so a component that calls it
// is drawn again when any of them moves or the engine answers. A change asks the engine again; the latest answer wins.
export function design() {
  void el.calc;
  const key = keyNow();
  if (cache.key !== key) study(key);
  return cache.D;
}
function study(key) {
  cache.key = key;
  const job = electrical('study').then((r) => { if (cache.key === key) { cache.D = r.design; cache.PR = r.protection; el.calc++; } return r; },
    (e) => { if (cache.key === key) { cache.D = null; cache.PR = null; el.calc++; toast(e.message || 'The electrical design failed.', true); } throw e; });
  cache.job = job;
  return job;
}
// The design for the inputs as they are now, waiting for the engine when it is out of date (the report, the console, Apply)
export async function designNow() {
  const key = keyNow();
  if (cache.key !== key || !cache.job) study(key);
  try { await cache.job; } catch { /* told already */ }
  return cache.key === key ? cache.D : designNow();
}
// The short-circuit and protection study of the design, computed with it
export function protection() { design(); return cache.PR; }
export const setActive = (on) => { el.active = on; if (on) el.rev++; };
export const pvChanged = () => { el.pv++; };
export function resetElectrical() { rteBase = null; LF = null; clearBuses(); cache = { key: '', D: null, PR: null, job: null }; el.lfRev++; el.rev++; }

const edited = (key = 'electrical') => { onFieldChange(key); el.rev++; };

export function setBasis(key, value) { W.P.electrical[key] = value; edited('electrical.' + key); }
export function setCable(key, id) { W.P.electrical.cable[key] = id; edited(); }
export function setRuns(key, v) { W.P.electrical.runs[key] = Math.max(1, +v | 0); edited(); }
export function setLength(key, v) { W.P.electrical.len[key] = Math.max(0, +v); edited(); }

export function setBreaker(key, id) { W.P.electrical.breaker = { ...(W.P.electrical.breaker || {}), [key]: id }; edited(); }
// a protection setting of a device typed over the suggestion (blank goes back to it)
export function setProt(key, field, value) {
  const all = { ...(W.P.electrical.prot || {}) }, o = { ...(all[key] || {}) };
  if (value === '' || value == null) delete o[field]; else o[field] = field === 'curve' ? value : +value;
  if (Object.keys(o).length) all[key] = o; else delete all[key];
  W.P.electrical.prot = all;
  edited();
}

export async function auto() {
  try {
    const r = await electrical('autosize');
    Object.assign(W.P.electrical, r.electrical);
    edited();
    toast(`Auto-sized ${r.count} circuit(s): smallest cable meeting current rating and voltage-drop limits, fewest parallel runs.`);
  } catch (e) { toast(e.message || 'Auto-size failed.', true); }
}

export async function apply() {
  const P = W.P;
  try {
    const D = await designNow(), r = await electrical('apply', { rte_base: rteBase });
    for (const k of ['pv', 'bess', 'aux', 'electrical']) Object.assign(P[k], r[k]);
    rteBase = r.rte_base;
    refreshForms();
    onFieldChange('electrical.apply');
    el.rev++;
    toast(applyText(P, D));
  } catch (e) { toast(e.message, true); }
}
const applyText = (P, D) => `Model updated: DC wiring ${fmtPct(P.pv.dc_wiring, 2)} (annual basis), AC losses ${fmtPct(P.pv.ac_losses, 2)} (cables and transformer load loss), DC/AC ${P.pv.dc_ac_ratio}, PV ${fmtNum(P.pv.capacity_kwp)} kWp${D && D.loss.bessThroughput ? ', BESS RTE ' + fmtPct(P.bess.rte, 1) : ''}. Transformer no-load loss PV ${fmtNum(P.aux.trafo_noload_kw, 1)} kW and BESS ${fmtNum(P.aux.bess_trafo_noload_kw, 1)} kW set as auxiliary loads (Battery tab). Re-run the simulation.`;

// ---------------------------------------------------------------- load flow
export const loadFlow = () => { void el.lfRev; return LF; };

export async function runLf() {
  if (!data.sim) { toast('Run a simulation first: the load flow uses the hourly dispatch.', true); return; }
  el.busy = true;
  try {
    LF = await electrical('loadflow');
    clearBuses();
    el.lfHour = LF.hours[0].h;
    el.lfRev++;
  } catch (e) { toast(e.message, true); } finally { el.busy = false; }
}
// The bus voltages of the hour shown, asked of the engine when the hour changes. A change of the inputs leaves the hour shown
// as it is, but the hours asked next come from the new inputs.
export function lfBuses() {
  void el.lfRev;
  const t = el.lfHour, key = keyNow();
  if (!LF || !data.sim) return null;
  if (busKey !== key) { busCache.clear(); busKey = key; }
  if (busHour !== t) {
    busHour = t;
    BUS = busCache.get(t) || null;   // never the buses of the hour shown before
    if (!BUS) electrical('buses', { t }).then((b) => { if (busKey === key) busCache.set(t, b); if (busHour === t) { BUS = b; el.lfRev++; } },
      (e) => { if (busHour === t) busHour = -1; toast(e.message, true); });   // asked again on the next draw
  }
  return BUS;
}

// ---------------------------------------------------------------- single-line diagram
export const sldText = (cables = true) => { const D = design(), PR = protection(); return D && PR ? buildSld(D, W.P, cables, PR.F) : ''; };
export const tccText = () => { const PR = protection(); return PR ? buildTcc(PR, W.P.electrical.mv_kv) : ''; };
const fileBase = () => (W.P.name || 'project');
export const exportSvg = () => saveFile(fileBase() + '_SLD.svg', sldText(el.cables), 'image/svg+xml');

export async function exportPng() {
  const svg = sldText(el.cables), scale = 2;
  try {
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
    const c = document.createElement('canvas');
    c.width = SLD_W * scale; c.height = SLD_H * scale;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    if (blob) await saveFile(fileBase() + '_SLD.png', blob, 'image/png');
  } catch (e) { toast('Cannot draw the diagram as an image: ' + (e.message || e), true); }
}

