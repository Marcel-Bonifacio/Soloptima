// The Optimisation and Forecast & EMS pages: the optimiser request and the sizes it suggests and applies, the forecast chart picks,
// and the operational day-ahead schedule (fetch, plan, CSV). The schedule itself is W.SCHED (plain, hourly rows stay unproxied);
// `plan.rev` tells the page to read it again.
import { W } from './ws/state.js';
import { engineProject, requireInputs, autosave } from './ws/core.js';
import { showTab } from './ws/tabs.svelte.js';
import { optionLabel } from './ws/util.js';
import { inputField } from './ws/diff.js';
import { refreshForms } from './state.svelte.js';
import { toast } from './toast.js';
import { call, saveFile } from './ipc.js';
import { runSim } from './results.svelte.js';
import { projectKey, sizingOverrides, optSettings, suggestRanges as suggest, applySizes, schedCsv } from './plan-view.js';

export const plan = $state({ rev: 0, busy: false, status: '', kind: '', variable: 'pv', week: 0 });

// New or reopened project: no schedule, no status, the forecast chart back at the first week
export function reset() {
  W.SCHED = null;
  Object.assign(plan, { busy: false, status: '', kind: '', variable: 'pv', week: 0 });
  plan.rev++;
}

// Fingerprint of the inputs the NPC of a design without a battery depends on (see sizingOverrides)
export const sizingKey = () => projectKey(engineProject(sizingOverrides(W.P)));

// The request of an optimiser run, or null when inputs are missing
export function optRequest() {
  if (!requireInputs()) return null;
  const P = W.P, O = P.optimizer;
  return { body: { project: engineProject(O.fast ? { sim: { all_years: false } } : null), optimizer: optSettings(O) }, allYears: !O.fast && !!P.sim.all_years, key: sizingKey() };
}
export function setOpt(opt) { W.OPT = opt; }
export const sensLabel = (v) => optionLabel(inputField('optimizer.sens_var').o, v);

export function suggestRanges() {
  const msg = suggest(W.P, W.PVR);
  if (msg == null) return;
  refreshForms(); autosave();
  toast(msg);
}

// "Apply" on a result row: the sizes go in the project, then the simulation runs
export function applySize(r) {
  const msg = applySizes(W.P, r);
  refreshForms(); autosave(); W.PVR = null;
  toast(msg);
  showTab('sim'); runSim();
}

export async function runSchedule() {
  const P = W.P;
  if (!P.load.kw) { toast('Define the load first.', true); return; }
  plan.busy = true;
  try {
    plan.status = 'Fetching weather forecast…'; plan.kind = '';
    const S = P.sched;
    const fc = await call('forecast_weather', { body: { provider: S.provider, lat: P.location.lat, lon: P.location.lon, days: S.days, api_key: S.api_key } });
    plan.status = 'Planning…';
    // The plan starts at the current hour of this computer's clock (UTC), where the SOC entered applies.
    const sched = await call('ems_schedule', { body: { project: engineProject(), forecast: fc, soc_now: S.soc_now, load_scale: S.load_scale,
      now_utc: new Date().toISOString().slice(0, 16), days: S.days } });
    if (W.P !== P) return;   // another project opened meanwhile
    sched.soc_now = S.soc_now;
    W.SCHED = sched;
    plan.status = ''; plan.kind = '';
  } catch (e) { plan.status = e.message; plan.kind = 'err'; }
  plan.busy = false;
  plan.rev++;
}

export async function exportSchedule() {
  if (!W.SCHED) return;
  await saveFile((W.P.name || 'schedule') + '_day_ahead.csv', schedCsv(W.SCHED), 'text/csv');
}
