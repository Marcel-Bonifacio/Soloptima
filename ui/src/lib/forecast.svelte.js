// The Forecast Lab benchmark: the run, the result and what the page shows of it. The result is not saved with the project; the
// report and the script console read it through SoloptimaUI.forecast().
import { call } from './ipc.js';
import { legacy } from './legacy.js';

export const fl = $state({ busy: false, status: '', kind: '', variable: 'pv', horizon: 'da', metric: 'nmae', week: 20, picked: { pv: [], load: [] }, rev: 0 });
let B = null;   // the raw response (hourly arrays stay out of the proxy)

export const result = () => B;
export const hasResult = () => !!B;

export async function runBench() {
  const project = legacy.engineProject(true);
  if (!project) return;
  const t0 = performance.now(), E = legacy.project().ems;
  Object.assign(fl, { busy: true, status: 'Benchmarking all methods and re-running the EMS with each…', kind: '' });
  try {
    B = await call('forecast_benchmark', { body: { project, with_value: true } });
    fl.picked = { pv: [E.pv_forecast, 'persistence'], load: [E.load_forecast, 'persistence'] };
    Object.assign(fl, { status: `✓ done in ${((performance.now() - t0) / 1000).toFixed(1)} s`, kind: 'ok' });
    fl.rev++;
  } catch (e) { Object.assign(fl, { status: e.message, kind: 'err' }); }
  fl.busy = false;
}

export function resetForecast() { B = null; Object.assign(fl, { busy: false, status: '', kind: '', rev: fl.rev + 1 }); }

export function togglePick(id) {
  const s = fl.picked[fl.variable];
  fl.picked[fl.variable] = s.includes(id) ? s.filter((x) => x !== id) : [...s, id];
}

// "Use in EMS": the method becomes the forecaster of the EMS and the strategy predictive.
export function useMethod(id) {
  const m = B[fl.variable].methods.find((x) => x.id === id);
  legacy.useForecast(fl.variable, id);
  legacy.toast(`EMS now uses "${m.name}" for ${fl.variable === 'pv' ? 'PV' : 'load'} (strategy set to Predictive EMS). Re-run the simulation to see the effect.`);
  fl.rev++;
}
