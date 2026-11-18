// The outage survival study (Simulation results): its run as an engine job with progress and cancel, and the last result
// (W.RESIL = {key, res}, plain data kept for the session, not saved with the project).
import { W } from './ws/state.js';
import { call } from './ipc.js';
import { fmtNum } from './format.js';
import { runJob, resetJob, cancelJob } from './results.svelte.js';
import { engineProject, requireInputs, autosave } from './ws/core.js';
import { projectKey } from './ws/keys.js';

export const rsl = $state({ rev: 0, busy: false, progress: 0, status: '', kind: '', job: null });

// The settings sent with the project
const settings = (P) => ({ stride: +P.resilience.stride || 1, max_h: +P.resilience.max_h || 336 });
// Fingerprint of the inputs of a study: of the engine project (pk) and the settings
const keyOf = (pk, s) => pk + JSON.stringify(s);
// pk: the fingerprint of the open project, when the caller has it
export const resilStale = (pk = projectKey()) => !!W.RESIL && W.RESIL.key !== keyOf(pk, settings(W.P));

// A new or reopened project: no study, no status text (a running one is cancelled)
export function reset() {
  resetJob(rsl);
  W.RESIL = null;
  rsl.rev++;
}

export const cancelResilience = () => cancelJob(rsl.job);

// The outage length the strip shows (saved with the project)
export function setStrip(d) { W.P.resilience.strip_h = d; autosave(); rsl.rev++; }

export async function runResilience() {
  if (rsl.busy || !requireInputs()) return;
  const eng = engineProject(), s = settings(W.P);
  await runJob(rsl, { first: 'Simulating year 1…', ms: 250, quietCancel: true,
    start: () => call('resilience', { body: { project: eng, resilience: s } }),
    progress: (st) => (st.progress > 0 ? `${fmtNum(st.progress)} / ${fmtNum(st.total)} start hours…` : ''),
    done: (out, secs) => {
      W.RESIL = { key: keyOf(projectKey(eng), s), res: out };
      return `✓ ${fmtNum(out.starts)} start hours, outages up to ${fmtNum(out.max_h)} h, in ${secs} s`;
    } });
  rsl.rev++;
}
