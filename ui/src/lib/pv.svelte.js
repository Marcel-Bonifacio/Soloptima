// The PV & wind page: the yield calculation, the tilt scan, the horizon from PVGIS and the PVGIS reference check. The result itself is `W.PVR` (raw object, not state); `pv.rev` tells the page to read it again.
import { W } from './ws/state.js';
import { engineProject } from './ws/core.js';
import { showTab } from './ws/tabs.svelte.js';
import { onFieldChange } from './ws/project.js';
import { call } from './ipc.js';
import { toast } from './toast.js';
import { fmtNum } from './format.js';
import { refreshForms } from './state.svelte.js';
import { setPvLosses } from './plant.svelte.js';
import { setShade } from './layout/edit.svelte.js';
import { pvChanged as designPvChanged } from './equip/electrical.svelte.js';
import { pvBalance as balanceOf, pvRefText as refTextOf, bestTilt, refErrorText } from './pv-view.js';

// busy: the yield is being calculated; status: the text next to the button (kind '' | 'ok' | 'err'); refErr: the PVGIS line when
// the reference failed (a note, no result)
export const pv = $state({ rev: 0, busy: false, tiltBusy: false, horizonBusy: false, status: '', kind: '', refErr: '' });
// The tilt scan points [tilt, kWh/kWp] shown by the page (raw, redrawn when pv.rev changes)
export const shown = { tilt: null };
// Set by the workspace when it needs to follow a new yield (the check marks of the navigation)
const pvHooks = { afterCalc: null };
let refSeq = 0;

// The status text of the page; the workspace also calls it ("Recalculating…") right after it cleared W.PVR, which redraws the page
export function pvStatus(text, kind = '') { pv.status = text || ''; pv.kind = kind; pv.rev++; }

export function reset() {
  refSeq++;
  shown.tilt = null;
  Object.assign(pv, { busy: false, tiltBusy: false, horizonBusy: false, status: '', kind: '', refErr: '' });
  pv.rev++;
}

let pvQueued = false;   // a calculation asked for while one runs: run once more on the latest inputs
export async function calcPV(quiet) {
  const P = W.P;
  if (!P.weather) { if (!quiet) { toast('Get solar data first.', true); showTab('resource'); } return; }
  if (pv.busy) { pvQueued = true; return; }
  pv.busy = true;
  try {
    const layoutAt = P.layout.result;
    const r = await call('pv', { body: engineProject() });
    if (W.P !== P) return;   // another project opened meanwhile: its yield is not this one
    W.PVR = r;
    refreshForms();
    pvStatus('✓ Yield calculated', 'ok');
    setPvLosses(W.PVR.losses);
    setShade(W.PVR.shade, layoutAt);
    pvReference();
    if (pvHooks.afterCalc) pvHooks.afterCalc();
    designPvChanged();   // the electrical design reads the cell temperature and the yield
  } catch (e) { if (W.P === P) pvStatus(e.message, 'err'); } finally { pv.busy = false; }
  if (pvQueued) { pvQueued = false; if (W.P === P) calcPV(true); }
}

// Independent check of the yield against PVGIS PVcalc (long-term average of the PVGIS radiation database), run after every
// yield calculation. PVGIS is asked again only when the site or orientation changes. No line when offline.
async function pvReference() {
  const seq = ++refSeq;
  try {
    const r = await call('pv_reference', { body: engineProject() });
    if (seq !== refSeq) return;
    W.PVREF = r; pv.refErr = '';
  } catch (e) {
    if (seq !== refSeq) return;
    W.PVREF = null; pv.refErr = refErrorText(e.message) || '';
  }
  pv.rev++;
  refreshForms();
}

// Terrain horizon of the site from PVGIS (its elevation model, 7.5° steps from north)
export async function horizonFromPvgis() {
  const P = W.P;
  pv.horizonBusy = true;
  try {
    const r = await call('horizon', { body: { lat: +P.location.lat, lon: +P.location.lon } });
    P.pv.horizon = r.horizon;
    refreshForms();
    onFieldChange('pv.horizon');
    toast(`Horizon from ${r.source}: ${r.horizon.length} points, highest ${fmtNum(Math.max(...r.horizon), 1)}°`);
  } catch (e) { toast(e.message, true); } finally { pv.horizonBusy = false; }
}

export async function tiltScan() {
  if (!W.P.weather) { toast('Get solar data first.', true); return; }
  pv.tiltBusy = true;
  try {
    const r = await call('tilt_scan', { body: engineProject() });
    shown.tilt = r.points; pv.rev++;
    const best = bestTilt(r.points);
    toast(`Best tilt ${best[0]}° → ${fmtNum(best[1])} kWh/kWp (row shading at the current GCR included)`);
  } catch (e) { toast(e.message, true); } finally { pv.tiltBusy = false; }
}

// Monthly PV balances of the open project (the report and the workbook read them); null without a yield
export const pvBalance = () => balanceOf(W.PVR, W.SIM, W.P.pv.capacity_kwp);
export const pvRefText = (r) => refTextOf(r, W.P);
