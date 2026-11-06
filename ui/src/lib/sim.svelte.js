// The simulation page bound to the open project: the request of a run, the hand-over of
// its result, the stale check, the figures the report and other pages use, and the hourly CSV. The logic is in sim-extra.js.
import { W } from './ws/state.js';
import { autosave, engineProject, requireInputs } from './ws/core.js';
import { simInputs, simKey, simStale, simChanges, sizingKey } from './ws/keys.js';
import { inputDiff, inputSnapshot, diffList } from './ws/diff.js';
import { setStale, gotoWeek, res, data } from './results.svelte.js';
import { toast } from './toast.js';
import { saveFile } from './ipc.js';
import { dateOfHour } from './series.js';
import * as X from './sim-extra.js';

export const sim = $state({ stale: false, changes: '' });
let timer = null;

// The request of a simulation run, or null (with a notice) when weather or load are missing
export function simRequest() {
  if (!requireInputs()) return null;
  const P = W.P, req = engineProject();
  return { req, key: simKey(req), sizingKey: sizingKey(), snap: inputSnapshot(simInputs(req)), allYears: !!P.sim.all_years, years: P.econ.lifetime };
}
// A new result: kept for the report and the other pages; the landing-page badges follow it
export function setSim(s, prev) { W.SIM = s; W.SIM_PREV = prev; autosave(); }
// Is there a result on show (reactive: reads res.rev)
export const hasSim = () => { res.rev; return !!data.sim; };
export function changedText(a, b) {
  const d = inputDiff(a, b);
  return d.length ? `Changed since the previous run: ${diffList(d)}.` : 'No input changed since the previous run.';
}

// Stale check: stringifies the project, so after edits it runs 300 ms after the last one (see SimPage.svelte)
export function checkStale() {
  clearTimeout(timer);
  const stale = !!W.SIM && !!W.P && simStale(), list = stale ? simChanges(6) : '';
  sim.stale = stale; sim.changes = list;
  setStale(stale ? list : null);
}
export function checkStaleLater(ms = 300) { clearTimeout(timer); timer = setTimeout(checkStale, ms); }
export const afterRerun = checkStale;

// Figures of the last result for the open project (the report, the workbook and the cards)
export const monthBalance = (R) => X.monthBalance(R);
export const energyFlow = (R) => X.energyFlow(R);
export const calibration = () => X.calibrationOf(W.P, W.SIM);
export const bessThreshold = () => X.thresholdOf(W.P.bess);
export const bessHealth = (R) => X.bessHealthOf(R);
export const weekPicks = (R) => X.weekPicksOf(R, W.P.diesel);
export { calFmt, calPct, yearList } from './sim-extra.js';

// Opens the dispatch week that contains this hour of the year
export function jump(hour) {
  gotoWeek(hour);
  document.getElementById('chDispatch')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
export async function exportCsv() {
  if (!W.SIM) { toast('Run a simulation first.', true); return; }
  await saveFile((W.P.name || 'results') + '_hourly.csv', X.hourlyCsv(W.SIM.result.hourly, dateOfHour), 'text/csv');
}

// Another project opens: no result, no pending check
export function reset() {
  clearTimeout(timer);
  W.SIM = null; W.SIM_PREV = null;
  sim.stale = false; sim.changes = '';
  setStale(null);
}
