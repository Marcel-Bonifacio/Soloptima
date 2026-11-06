// The weather-year (P50/P90) run of the Solar resource page. The result belongs to the project (project.resource_years.result,
// saved with it; the weather years stay in the engine), so this store holds only the state of a run.
import { call } from './ipc.js';
import { waitJob, cancelJob } from './results.svelte.js';
import { summary as summarize, chosenFactor } from './ry-view.js';
import { fmtNum } from './format.js';
import { toast } from './toast.js';
import { W } from './ws/state.js';
import { onFieldChange } from './ws/project.js';
import { ryRequest } from './data.svelte.js';

export const ry = $state({ busy: false, progress: 0, status: '', kind: '', job: null });

export async function runRy() {
  const rq = ryRequest();
  if (!rq) return;
  const P = W.P, R = P.resource_years, t0 = performance.now();
  Object.assign(ry, { busy: true, progress: 0, status: 'Starting…', kind: '' });
  try {
    const { job } = await call('resource_years', { body: rq.body });
    ry.job = job;
    const out = await waitJob(job, (s) => {
      ry.progress = s.progress / Math.max(1, s.total);
      ry.status = s.progress > 0 ? `${fmtNum(s.progress)} / ${fmtNum(s.total)} simulations…`
        : `Downloading the weather years from ${R.source === 'pvgis' ? 'PVGIS (about a minute)' : 'NASA POWER (about 20 s per three years)'}…`;
    }, 500);
    R.result = { ...out, key: rq.key, model: P.finance.model, weather: P.weather.source, budget: rq.body.budget, requested: { from: R.from, to: R.to } };
    onFieldChange('resource_years.result');   // saves the project and shows the result
    Object.assign(ry, { status: `✓ ${out.years.length} weather years (${out.database} ${out.range.from}–${out.range.to}) simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s`, kind: 'ok' });
  } catch (e) {
    Object.assign(ry, { status: e.message, kind: 'err' });
    toast(e.message, true);
  }
  Object.assign(ry, { busy: false, job: null });
}

export const resetRy = () => Object.assign(ry, { busy: false, progress: 0, status: '', kind: '', job: null });
export const cancelRy = () => cancelJob(ry.job);

export function setBasis(v) {
  W.P.resource_years.basis = v === 10 ? 10 : 1;
  onFieldChange('resource_years.basis');
}

// Sets the debt-sizing haircut (Project finance) to the revenue P90 ÷ P50 of the last run.
export function applyRy() {
  const P = W.P, R = P.resource_years;
  if (!R.result) return;
  const S = summarize(R.result, R.applied, P.finance.p90_factor, null), basis = R.basis === 10 ? 10 : 1, v = chosenFactor(S, basis);
  if (v == null) { toast('Revenue P50 is zero: no factor to apply.', true); return; }
  P.finance.p90_factor = v;
  R.applied = { p90_factor: v, basis, database: R.result.database, from: R.result.range.from, to: R.result.range.to };
  onFieldChange('finance.p90_factor');
  toast(`Debt sizing now uses revenue × ${v} (P90 of ${basis === 10 ? 'a 10-year average' : 'one year'}). Run the financial analysis to update it.`);
}
