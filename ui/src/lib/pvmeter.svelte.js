// Metered PV output against the yield model (the PV meter card of the PV & wind page). The meter belongs to the project
// (P.pv_meter: `kw`, 8760 local standard hours with null where the file has no data, its import report and the values Apply
// replaced), saved and exported with it as the measured load is. It is not an engine input, so it stays out of the simulation
// requests and the fingerprints of results. The comparison (engine pv_reconcile) is made again after every yield calculation and
// kept in memory only; Apply writes the fitted soiling and availability into the PV inputs, and Undo puts the old values back.
import { call } from './ipc.js';
import { toast } from './toast.js';
import { ask } from './ask.js';
import { W } from './ws/state.js';
import { engineProject, autosave } from './ws/core.js';
import { onFieldChange } from './ws/project.js';
import { calcPV } from './pv.svelte.js';
import { applyValues, canUndo, fitView } from './pvmeter-view.js';
import { fmtPct } from './format.js';

// rev: read the result again; mode: the soiling Apply writes ('constant' or 'monthly')
export const pm = $state({ rev: 0, busy: false, err: '', mode: 'constant' });
let RES = null, FOR = null, KW = null, seq = 0;

// The comparison of the project's meter with its current yield, or null (none yet, or made for other inputs)
export function meterResult() {
  pm.rev;
  const M = W.P && W.P.pv_meter;
  return RES && W.PVR && FOR === W.PVR && M && KW === M.kw ? RES : null;
}

export function reset() { seq++; RES = null; FOR = null; KW = null; Object.assign(pm, { busy: false, err: '', mode: 'constant' }); pm.rev++; }

// Compares the meter with the yield of W.PVR; called after every yield calculation (pv.svelte.js)
export async function reconcileMeter() {
  const P = W.P, M = P && P.pv_meter, pvr = W.PVR;
  if (!M || !Array.isArray(M.kw) || !pvr) return;
  const s = ++seq;
  pm.busy = true; pm.err = ''; pm.rev++;
  try {
    const r = await call('pv_reconcile', { body: { project: engineProject(), meter: { kw: M.kw } } });
    if (s !== seq || W.P !== P) return;
    RES = r; FOR = pvr; KW = M.kw;
  } catch (e) {
    if (s === seq) { RES = null; pm.err = e.message; }
  } finally {
    if (s === seq) { pm.busy = false; pm.rev++; }
  }
}

// A meter file was imported (tsimport.svelte.js): kept with the project, then compared with the yield
export function meterLoaded(kw, info) {
  const P = W.P;
  P.pv_meter = { kw, import: info, applied: null };
  RES = null;
  autosave();
  if (W.PVR) reconcileMeter(); else calcPV(true);
  pm.rev++;
}

export async function clearMeter() {
  if (!(await ask('Remove the metered PV output from this project? The PV inputs stay as they are.', 'Remove'))) return;
  W.P.pv_meter = null;
  reset();
  autosave();
}

export function applyFit() {
  const R = meterResult(), P = W.P;
  if (!R || !P.pv_meter) return;
  const mode = pm.mode === 'monthly' && fitView(R).monthly ? 'monthly' : 'constant', { values, prev } = applyValues(R, P.pv, mode);
  Object.assign(P.pv, values);
  P.pv_meter.applied = { mode, values, prev };
  onFieldChange('pv.soiling');
  toast(`Soiling ${mode === 'monthly' ? 'by month' : fmtPct(values.soiling)} and availability ${fmtPct(values.availability)} applied to the PV inputs. Run the simulation again to update the results.`);
}

export const undoAllowed = () => { pm.rev; const M = W.P && W.P.pv_meter; return !!(M && canUndo(M.applied, W.P.pv)); };

export function undoFit() {
  const P = W.P, A = P.pv_meter && P.pv_meter.applied;
  if (!A || !canUndo(A, P.pv)) return;
  Object.assign(P.pv, A.prev);
  P.pv_meter.applied = null;
  onFieldChange('pv.soiling');
  toast('The soiling and availability are back to the values before Apply.');
}
