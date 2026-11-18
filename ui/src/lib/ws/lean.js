// Inputs added to the project since earlier versions go to the engine only when they are used, so a project that does not use
// them keeps the engine inputs, and the fingerprints of its saved results, it had (plain functions; ui/tests/fleet.test.js).
import { isMixed, engineGroups } from '../fleet-view.js';

// The engine project p (core.js engineProject) with the unused new inputs left out. PV or PCS outages draw the genset seed too.
export function leanProject(p) {
  const pv = leanKeys(leanOutages(p.pv, 'pv'), PV_OFF), bess = leanCurve(leanOutages(p.bess, 'bess'));
  const drawn = (pv && pv.inverter_outage_rate > 0) || (bess && bess.pcs_outage_rate > 0);
  const grid = p.grid ? { grid: leanGrid(p.grid) } : {};
  return { ...p, ...grid, pv, bess, wind: leanKeys(p.wind, WIND_OFF), diesel: leanDiesel(p.diesel, drawn), ems: leanEms(p.ems), econ: leanEcon(p.econ), sim: leanSim(p.sim) };
}
// PV inputs added later (the irradiance scale, the MPP tracking loss) and the wind speed scale, left out at their defaults
const PV_OFF = Object.freeze({ irradiance_scale: 1, mppt_loss: 0, mppt_local: false });
const WIND_OFF = Object.freeze({ speed_scale: 1 });

// The diesel inputs: the further genset groups only for a mixed fleet; the outage seed while any outages are drawn
// (`keepSeed`: inverter blocks or PCS units fail at random too)
export function leanDiesel(d, keepSeed = false) {
  if (!d) return d;
  const { more_groups, ...rest } = leanDieselOff(d, keepSeed);
  return isMixed(d) ? { ...rest, more_groups: engineGroups(d) } : rest;
}
// Diesel inputs added later, left out at their defaults (no ramp limit, start time or forced outages, no N-1 check, no
// minimum up or down time, no failure to start or running hours to failure)
const DIESEL_OFF = Object.freeze({ ramp_pct_min: 0, start_min: 0, outage_rate: 0, n1_check: false, min_up_h: 0, min_down_h: 0, fail_start: 0, mttf_h: 0 });
function leanDieselOff(d, keepSeed) {
  const out = dropDefaults(d, DIESEL_OFF);
  if (!(out.outage_rate > 0)) { delete out.repair_h; if (!keepSeed) delete out.outage_seed; }
  return out;
}

// A copy of x without the keys of defs that are blank or at their default: equal as values (dropDefaults) or as numbers (leanKeys,
// so false and 0 match)
const dropBy = (same) => (x, defs) => {
  if (!x) return x;
  const out = { ...x };
  for (const [k, v] of Object.entries(defs)) if (out[k] == null || same(out[k], v)) delete out[k];
  return out;
};
export const dropDefaults = dropBy((a, b) => a === b);
export const leanKeys = dropBy((a, b) => +a === +b);

// The battery's cycle-life curve, added later: only when it has points
export function leanCurve(b) {
  if (!b || !('cycle_curve' in b) || (Array.isArray(b.cycle_curve) && b.cycle_curve.length)) return b;
  const { cycle_curve, ...rest } = b;
  return rest;
}

// Random outages of the inverter blocks (PV) or PCS units (battery), added later: their inputs only while the rate is on
const OUTAGES = { pv: ['inverter_outage_rate', 'inverter_unit_kw', 'inverter_repair_h'], bess: ['pcs_outage_rate', 'pcs_unit_kw', 'pcs_repair_h'] };
export function leanOutages(x, kind) {
  if (!x || +x[OUTAGES[kind][0]] > 0) return x;
  const out = { ...x };
  for (const k of OUTAGES[kind]) delete out[k];
  return out;
}

const SIM_OFF = Object.freeze({ low_pv_frac: 0.5 });
// The simulation options: the time step, how hourly series fill it and the PV and wind ramp limit (when above 0) only for steps
// under an hour; the share that makes a low-PV day only when it is not 50 %
export function leanSim(s) {
  s = leanKeys(s, SIM_OFF);
  if (!s || !('step_min' in s || 'subhourly' in s || 're_ramp_pct_min' in s)) return s;
  const { step_min, subhourly, re_ramp_pct_min, ...rest } = s;
  if (!(+step_min < 60)) return rest;
  return { ...rest, step_min: +step_min, subhourly: subhourly || 'hold', ...(+re_ramp_pct_min > 0 ? { re_ramp_pct_min: +re_ramp_pct_min } : {}) };
}

// The grid extension (break-even distance) only while it has a cost per km
export const leanGridExt = (x) => (x && +x.cost_per_km > 0 ? x : undefined);

// The load as the engine takes it: hourly, or the imported 15 or 30 minute values when the dispatch step is that short
// (15 minute values averaged in pairs for 30 minute steps)
export function leanLoad(L, s) {
  const step = s && +s.step_min < 60 ? +s.step_min : 60, sub = L.kw_sub, m = +L.sub_min;
  let kw = L.kw;
  if (step < 60 && Array.isArray(sub) && (m === 15 || m === 30) && m <= step) {
    const n = step / m;
    kw = n === 1 ? sub : Array.from({ length: sub.length / n }, (_, i) => sub.slice(i * n, i * n + n).reduce((a, b) => a + b, 0) / n);
  }
  // the critical share only below 1 (all the load critical, as before), the deferrable load only when on
  const out = L.critical_share != null && +L.critical_share !== 1 ? { kw, growth: L.growth, critical_share: +L.critical_share } : { kw, growth: L.growth };
  const dl = leanDeferrable(L.deferrable);
  return dl ? { ...out, deferrable: dl } : out;
}

// The deferrable load in energy as the engine takes it (water times the energy per m³), or undefined while it is off
export function leanDeferrable(D) {
  if (!D) return undefined;
  const w = D.unit === 'water', k = w ? +D.kwh_m3 : 1, kwh = (w ? +D.m3_day : +D.kwh_day) * k;
  if (!(kwh > 0)) return undefined;
  return { kwh_day: kwh, kw: +D.kw, start_h: +D.start_h, end_h: +D.end_h, tank_kwh: (+(w ? D.tank_m3 : D.tank_kwh) || 0) * k, tank_fill: +D.tank_fill, first: D.first };
}

// Grid inputs added later (battery charging from the grid, the frequency reserve), left out at their defaults
const GRID_OFF = Object.freeze({ charge_bess: false, reserve_kw: 0, reserve_min: 15, reserve_price: 0, outage_critical_only: false });
export const leanGrid = (g) => dropDefaults(g, GRID_OFF);

// The EMS inputs added later (reserve_energy, plan_starts): only when on; the value of lost non-critical load only when set
const EMS_OFF = ['reserve_energy', 'plan_starts'];
export function leanEms(e) {
  if (!e) return e;
  const out = { ...e };
  for (const k of EMS_OFF) if (!out[k]) delete out[k];
  if (out.voll_nc == null) delete out.voll_nc;
  return out;
}

// Cost inputs added later (genset wear, the further pollutants and their prices, embodied PV CO2), left out at their defaults
const ECON_OFF = Object.freeze({ diesel_overhaul_h: 0, diesel_overhaul_kw: 0, diesel_life_h: 0, pm25_g_per_l: 0, co_g_per_l: 0, nox_price_kg: 0,
  sox_price_kg: 0, pm25_price_kg: 0, co_price_kg: 0, pv_co2_kg_per_kwh: 0 });
export function leanEcon(e) {
  const out = leanKeys(e, ECON_OFF);
  if (out && out.diesel_replace_kw == null) delete out.diesel_replace_kw;   // 0 is a price (a free replacement): only blank is left out
  return out;
}

// Engine inputs left out while they have their own default, as dotted paths: the engine project has no value for them, yet a
// case that changes one sends it (tornado-view.js). Inputs left out because another input turns them off are not in it.
const OFF = { pv: PV_OFF, wind: WIND_OFF, diesel: DIESEL_OFF, grid: GRID_OFF, econ: ECON_OFF, sim: SIM_OFF };
export const LEFT_AT_DEFAULT = new Set([...Object.entries(OFF).flatMap(([b, t]) => Object.keys(t).map((k) => `${b}.${k}`)),
  'econ.diesel_replace_kw', ...EMS_OFF.map((k) => `ems.${k}`), 'ems.voll_nc', `pv.${OUTAGES.pv[0]}`, `bess.${OUTAGES.bess[0]}`]);
