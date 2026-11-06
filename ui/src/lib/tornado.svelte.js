// The tornado run: its busy flag, status text and last result (W.TORNADO, plain data kept raw), and the editing of the table of inputs.
import { W } from './ws/state.js';
import { call } from './ipc.js';
import { toast } from './toast.js';
import { engineProject, requireInputs, autosave } from './ws/core.js';
import { projectKey } from './ws/keys.js';
import { TORNADO_VARS } from './schema/index.js';
import { summarize, tornadoCases, tornadoFmt as fmtIn, tornadoSwing as swingIn, tornadoUnit as unitIn, tornadoPct, TORNADO_METRICS } from './tornado-view.js';

export { tornadoPct, TORNADO_METRICS };
export const tor = $state({ rev: 0, busy: false, status: '', kind: '' });

// Functions for the report and the workbook: they read the open project.
export const tornadoFmt = (m, v) => fmtIn(W.P.econ.currency, m, v);
export const tornadoSwing = (m, v) => swingIn(W.P.econ.currency, m, v);
export const tornadoUnit = (v) => unitIn(W.P.econ.currency, v);

// Figures of the last run for one metric; call only while W.TORNADO is set.
export const tornadoSummary = (metric) => summarize(W.TORNADO, metric, W.TORNADO.key !== projectKey(engineProject()));

// A new or reopened project: no run, no status text.
export function reset() {
  W.TORNADO = null;
  Object.assign(tor, { busy: false, status: '', kind: '' });
  tor.rev++;
}

// A change of the settings or the table of inputs: saved with the project, the card draws again.
export function changed() { autosave(); tor.rev++; }

export function addInput() { W.P.tornado.vars.push({ path: '', label: '', mode: 'x', lo: 0.8, hi: 1.2 }); changed(); }
export function removeInput(i) { W.P.tornado.vars.splice(i, 1); changed(); }
export function resetInputs() { W.P.tornado.vars = TORNADO_VARS(); changed(); }

export async function runTornado() {
  if (tor.busy || !requireInputs()) return;
  const P = W.P, T = P.tornado, eng = engineProject();
  const { cases, rows } = tornadoCases(P, eng);
  if (!rows.length) { Object.assign(tor, { status: 'Add at least one input.', kind: 'err' }); return; }
  Object.assign(tor, { busy: true, status: `Simulating ${cases.length} cases…`, kind: '' });
  try {
    const t0 = performance.now(), key = projectKey(eng);
    const r = await call('batch', { body: { project: eng, cases } });
    if (W.P !== P) return;   // another project was opened meanwhile
    if (r.results[0].error) throw new Error(r.results[0].error);
    const fast = !!T.fast;
    W.TORNADO = { key, fast: fast || !P.sim.all_years, together: !!T.bess_together, base: r.results[0],
      rows: rows.map((row) => ({ ...row, res: row.idx.map((i) => (i < 0 ? null : r.results[i])) })) };
    Object.assign(tor, { status: `✓ ${cases.length} cases simulated (${W.TORNADO.fast ? 'year 1, repeated' : P.econ.lifetime + ' years'}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`, kind: 'ok' });
    tor.rev++;
  } catch (e) {
    Object.assign(tor, { status: e.message, kind: 'err' });
    toast(e.message, true);
  } finally {
    tor.busy = false;
  }
}
