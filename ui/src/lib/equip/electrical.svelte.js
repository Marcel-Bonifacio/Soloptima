// The electrical design of the open project: the calculation (cached until an input or a result changes), the cable and loss
// actions, the load flow and the single-line diagram. The design belongs to nobody's saved data: it is computed from the project
// (project.electrical, project.equipment), the last PV yield and the last simulation whenever they change.
import { forms } from '../state.svelte.js';
import { res, data } from '../results.svelte.js';
import { saveFile } from '../ipc.js';
import { eq } from './equipment.svelte.js';
import { computeDesign, autoSize, applyLosses, applyText } from './design.js';
import { runLoadFlow, busVoltages } from './loadflow.js';
import { buildSld, SLD_W, SLD_H } from './sld.js';
import { toast } from '../toast.js';
import { W } from '../ws/state.js';
import { onFieldChange } from '../ws/project.js';
import { refreshForms } from '../state.svelte.js';

export const el = $state({ rev: 0, pv: 0, active: false, cables: true, lfRev: 0, lfHour: 0 });

let cache = { key: '', D: null };
let rteBase = null;       // the battery efficiency before the cable and transformer derating, so repeated Apply does not compound it
let LF = null;            // the load flow of the last run (large arrays: not Svelte state; lfRev says it changed)

const ctx = () => ({ PVR: W.PVR, SIM: data.sim });

// The design; reads the counters that change it, so a component that calls it is drawn again when any of them moves.
export function design(force = false) {
  const key = [forms.rev, res.rev, el.rev, el.pv, eq.rev].join('|');
  if (force || cache.key !== key || !cache.D) cache = { key, D: computeDesign(W.P, ctx()) };
  return cache.D;
}

export const setActive = (on) => { el.active = on; if (on) el.rev++; };
export const pvChanged = () => { el.pv++; };
export function resetElectrical() { rteBase = null; LF = null; cache = { key: '', D: null }; el.lfRev++; el.rev++; }

const edited = (key = 'electrical') => { onFieldChange(key); el.rev++; };

export function setBasis(key, value) { W.P.electrical[key] = value; edited('electrical.' + key); }
export function setCable(key, id) { W.P.electrical.cable[key] = id; edited(); }
export function setRuns(key, v) { W.P.electrical.runs[key] = Math.max(1, +v | 0); edited(); }
export function setLength(key, v) { W.P.electrical.len[key] = Math.max(0, +v); edited(); }

export function auto() {
  const n = autoSize(W.P, ctx());
  edited();
  toast(`Auto-sized ${n} circuit(s): smallest cable meeting current rating and voltage-drop limits, fewest parallel runs.`);
}

export function apply() {
  const P = W.P, D = design(true);
  try { rteBase = applyLosses(P, D, rteBase); } catch (e) { toast(e.message, true); return; }
  refreshForms();
  onFieldChange('electrical.apply');
  el.rev++;
  toast(applyText(P, D));
}

// ---------------------------------------------------------------- load flow
export const loadFlow = () => { el.lfRev; return LF; };

export function runLf() {
  if (!data.sim) { toast('Run a simulation first: the load flow uses the hourly dispatch.', true); return; }
  LF = runLoadFlow(W.P, design(), data.sim);
  el.lfHour = LF.hours[0].h;
  el.lfRev++;
}
export const lfBuses = () => (LF && data.sim ? busVoltages(LF, data.sim, el.lfHour) : null);

// ---------------------------------------------------------------- single-line diagram
export const sldText = (cables = true) => buildSld(design(), W.P, cables);
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

