// The "Compare operating options" run: its busy flag, status text and last result (W.OPTIONS, plain data kept raw).
import { W } from './ws/state.js';
import { call } from './ipc.js';
import { toast } from './toast.js';
import { engineProject, requireInputs } from './ws/core.js';
import { optionsKey } from './ws/keys.js';
import { optionCases, summarize } from './options-view.js';

export const ops = $state({ rev: 0, busy: false, status: '', kind: '', fast: false });

export { optionsKey };

// Figures of the last comparison for the card, the report and the workbook; call only while W.OPTIONS is set.
export const optionsSummary = () => summarize(W.P, W.OPTIONS, W.OPTIONS.key !== optionsKey());

// A new or reopened project: no comparison, no status text.
export function reset() {
  W.OPTIONS = null;
  Object.assign(ops, { busy: false, status: '', kind: '' });
  ops.rev++;
}

export async function runOptions() {
  if (ops.busy || !requireInputs()) return;
  const P = W.P;
  if (!(P.bess.energy_kwh > 0 && P.bess.power_kw > 0)) { Object.assign(ops, { status: 'Set a battery size (Battery tab) to compare operating options.', kind: 'err' }); return; }
  const fast = ops.fast, cases = optionCases(P);
  Object.assign(ops, { busy: true, status: `Simulating ${cases.length} options…`, kind: '' });
  try {
    const t0 = performance.now(), key = optionsKey();
    const r = await call('batch', { body: { project: engineProject(), cases: cases.map(([, , o]) => ({ overrides: fast ? { ...o, 'sim.all_years': false } : o })) } });
    if (W.P !== P) return;   // another project was opened meanwhile
    W.OPTIONS = { key, fast: fast || !P.sim.all_years, rows: cases.map(([id, label], i) => ({ id, label, res: r.results[i] })) };
    Object.assign(ops, { status: `✓ ${cases.length} options simulated (${W.OPTIONS.fast ? 'year 1, repeated' : P.econ.lifetime + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`, kind: 'ok' });
    ops.rev++;
  } catch (e) {
    Object.assign(ops, { status: e.message, kind: 'err' });
    toast(e.message, true);
  } finally {
    ops.busy = false;
  }
}
