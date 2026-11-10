// Inputs added to the project since earlier versions go to the engine only when they are used, so a project that does not use
// them keeps the engine inputs, and the fingerprints of its saved results, it had (plain functions; ui/tests/fleet.test.js).
import { isMixed, engineGroups } from '../fleet-view.js';

// The diesel inputs: the further genset groups only for a mixed fleet
export function leanDiesel(d) {
  if (!d) return d;
  const { more_groups, ...rest } = leanDieselOff(d);
  return isMixed(d) ? { ...rest, more_groups: engineGroups(d) } : rest;
}
// Diesel inputs added later, left out at their defaults (no ramp limit, start time or forced outages, no N-1 check)
const DIESEL_OFF = { ramp_pct_min: 0, start_min: 0, outage_rate: 0, n1_check: false };
function leanDieselOff(d) {
  const out = { ...d };
  for (const [k, v] of Object.entries(DIESEL_OFF)) if (out[k] === v || out[k] == null) delete out[k];
  if (!(out.outage_rate > 0)) { delete out.repair_h; delete out.outage_seed; }
  return out;
}

// The simulation options: the time step and how hourly series fill it only for steps under an hour
export function leanSim(s) {
  if (!s || !('step_min' in s || 'subhourly' in s)) return s;
  const { step_min, subhourly, ...rest } = s;
  return +step_min < 60 ? { ...rest, step_min: +step_min, subhourly: subhourly || 'hold' } : rest;
}

// The load as the engine takes it: hourly, or the imported 15 or 30 minute values when the dispatch step is that short
// (15 minute values averaged in pairs for 30 minute steps)
export function leanLoad(L, s) {
  const step = s && +s.step_min < 60 ? +s.step_min : 60, sub = L.kw_sub, m = +L.sub_min;
  let kw = L.kw;
  if (step < 60 && Array.isArray(sub) && (m === 15 || m === 30) && m <= step) {
    const n = step / m;
    kw = n === 1 ? sub : Array.from({ length: sub.length / n }, (_, i) => sub.slice(i * n, i * n + n).reduce((a, b) => a + b, 0) / n);
  }
  return { kw, growth: L.growth };
}

// The EMS inputs: reserve_energy only when on
export function leanEms(e) {
  if (!e || !('reserve_energy' in e) || e.reserve_energy) return e;
  const { reserve_energy, ...rest } = e;
  return rest;
}
