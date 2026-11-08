// The simulation, optimisation and weather-year runs and their results. The results are plain objects with hourly arrays, so they
// are kept raw (no proxies). `setSim` and `setOpt` keep W.SIM and W.OPT
// (read by the report, finance and tornado) in step with this store.
import { call } from './ipc.js';
import { W } from './ws/state.js';
import { fmtNum } from './format.js';
import { toast } from './toast.js';
import { optRequest } from './plan.svelte.js';
import { setOpt } from './plan.svelte.js';
import { simRequest } from './sim.svelte.js';
import { setSim } from './sim.svelte.js';

export const res = $state({
  rev: 0,                       // bumped by anything that changes what the results screens show
  simBusy: false, simStatus: '', simKind: '',
  optBusy: false, optStatus: '', optKind: '', optProgress: 0, optJob: null,
  stale: null,                  // {list} while the result on show is from other inputs
  week: 0,                      // week of the hourly dispatch chart
});
export const data = $state.raw({ sim: null, prev: null, opt: null });

let queued = false, waiting = null;
const bump = () => { res.rev++; };

// New or reopened project: nothing to show until the next run
export function reset() {
  data.sim = null; data.prev = null; data.opt = null;
  cancelJob(res.optJob);   // an optimisation of the project that closed
  Object.assign(res, { simStatus: '', optStatus: '', stale: null, week: 0, simBusy: false, optBusy: false, optJob: null });
  bump();
}

export const setStale = (list) => { res.stale = list == null ? null : { list }; };
export const gotoWeek = (hour) => { res.week = Math.min(51, Math.floor(hour / 168)); };

// Polls a job of the engine: onProgress gets {progress, total} until it is done; resolves with the result, throws the job's error
export async function waitJob(id, onProgress, ms = 400) {
  for (;;) {
    await new Promise((r) => setTimeout(r, ms));
    const s = await call('job', { id });
    if (s.done) { if (s.error) throw new Error(s.error); return s.result; }
    onProgress(s);
  }
}
export const cancelJob = (id) => (id == null ? null : call('job_cancel', { id }).catch(() => {}));

// Simulates the open project. A run asked for while another runs waits for it and then runs once more on the latest inputs.
export async function runSim(quiet) {
  if (res.simBusy) { queued = true; return waiting; }
  const rq = simRequest();
  if (!rq) return null;
  const P = W.P;
  res.simBusy = true; res.simStatus = 'Simulating…'; res.simKind = '';
  /** @type {(v?: any) => void} */
  let done = () => {};
  waiting = new Promise((r) => (done = r));
  try {
    const t0 = performance.now(), sim = await call('simulate', { body: rq.req });
    if (W.P !== P) { queued = false; done(); return null; }   // another project opened meanwhile: the result is not its
    sim.all_years = rq.allYears; sim.sizing_key = rq.sizingKey; sim.key = rq.key; sim.snap = rq.snap;
    // the figures and inputs of the previous run are kept for the change shown on the tiles, not its hourly arrays
    const p = data.sim;
    data.prev = p && { result: { re_fraction: p.result.re_fraction, econ: { lcoe: p.result.econ.lcoe } }, comparison: p.comparison, comparison_bess: p.comparison_bess, snap: p.snap };
    data.sim = sim;
    setSim(sim, data.prev);
    res.simStatus = `✓ ${rq.allYears ? rq.years + ' years' : 'Year 1'} simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s`; res.simKind = 'ok';
    bump();
  } catch (e) {
    res.simStatus = e.message; res.simKind = 'err';
    if (!quiet) toast(e.message, true);
  }
  res.simBusy = false;
  if (queued) { queued = false; await runSim(true); }
  done();
}

// Optimises the sizes; the job reports how many lifecycle simulations are done
export async function runOpt() {
  const rq = optRequest();
  if (!rq) return;
  const P = W.P;
  Object.assign(res, { optBusy: true, optProgress: 0, optStatus: 'Starting…', optKind: '' });
  const t0 = performance.now();
  try {
    const { job } = await call('optimize', { body: rq.body });
    res.optJob = job;
    const opt = await waitJob(job, (s) => {
      res.optProgress = s.progress / Math.max(1, s.total);
      res.optStatus = `${fmtNum(s.progress)} / ${fmtNum(s.total)} lifecycle simulations…`;
    });
    if (W.P !== P) return;   // another project opened meanwhile (the job was cancelled)
    opt.all_years = rq.allYears; opt.sizing_key = rq.key;   // basis of the NPC values
    data.opt = opt;
    setOpt(opt);
    res.optStatus = `✓ ${fmtNum(opt.n_evaluated)} configurations evaluated in ${((performance.now() - t0) / 1000).toFixed(1)} s${opt.cancelled ? ' (cancelled)' : ''}`; res.optKind = 'ok';
    bump();
  } catch (e) {
    res.optStatus = e.message; res.optKind = 'err'; toast(e.message, true);
  }
  Object.assign(res, { optBusy: false, optJob: null });
}
