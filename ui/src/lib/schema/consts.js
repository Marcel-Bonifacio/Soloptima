// Constants of the project forms and the tornado. Moved from web/js/schema.js.
// Default inputs of the tornado (Simulation results). mode x: low and high multiply the base value; +: added to it; =: the value itself.
// Values are in engine units (fractions for percentages); 'load.kw' scales the whole 8760-h load profile.
export const TORNADO_VARS = () => [
  { path: 'econ.fuel_price', label: 'Diesel price', mode: 'x', lo: 0.8, hi: 1.2 },
  { path: 'econ.fuel_escalation', label: 'Fuel price escalation', mode: '+', lo: -0.01, hi: 0.01 },
  { path: 'econ.discount_rate', label: 'Discount rate', mode: '+', lo: -0.02, hi: 0.02 },
  { path: 'econ.pv_capex_kwp', label: 'PV capex', mode: 'x', lo: 0.8, hi: 1.2 },
  { path: 'econ.bess_capex_kwh', label: 'Battery energy capex', mode: 'x', lo: 0.8, hi: 1.2 },
  { path: 'econ.bess_replace_kwh', label: 'Battery replacement price', mode: 'x', lo: 0.7, hi: 1.3 },
  { path: 'econ.bess_cost_decline', label: 'Battery price decline', mode: 'x', lo: 0, hi: 2 },
  { path: 'bess.cycle_life', label: 'Battery cycle life', mode: 'x', lo: 0.7, hi: 1.3 },
  { path: 'bess.calendar_fade', label: 'Battery calendar fade', mode: 'x', lo: 0.5, hi: 2 },
  { path: 'pv.degradation', label: 'PV degradation', mode: '=', lo: 0.003, hi: 0.008 },
  { path: 'pv.availability', label: 'PV availability', mode: '+', lo: -0.03, hi: 0 },
  { path: 'econ.diesel_om_unit_hour', label: 'Genset O&M per run hour', mode: 'x', lo: 0.7, hi: 1.3 },
  { path: 'load.kw', label: 'Load', mode: 'x', lo: 0.9, hi: 1.1 },
];

// Daily load shapes (fraction of peak); scaled to the chosen average in the Load tab.
export const LOAD_TEMPLATES = {
  continuous: { name: 'Continuous industrial (24/7)', shape: [0.97, 0.96, 0.96, 0.95, 0.96, 0.97, 0.99, 1, 1, 1, 0.99, 1, 0.98, 1, 1, 0.99, 0.99, 0.98, 0.98, 0.98, 0.97, 0.97, 0.97, 0.97] },
  process: { name: 'Continuous process plant with a shift-change dip', shape: [0.913, 0.945, 1, 0.911, 0.942, 0.946, 0.901, 0.905, 0.975, 0.939, 0.927, 0.995, 0.981, 0.931, 0.918, 0.942, 0.911, 0.89, 0.881, 0.88, 0.634, 0.885, 0.935, 0.933] },
  dayshift: { name: 'Day-shift industrial (2 shifts)', shape: [0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.6, 0.95, 1, 1, 1, 0.9, 0.85, 1, 1, 1, 0.95, 0.9, 0.85, 0.8, 0.6, 0.4, 0.3, 0.25] },
  commercial: { name: 'Commercial / hotel', shape: [0.45, 0.42, 0.4, 0.4, 0.42, 0.5, 0.62, 0.75, 0.85, 0.92, 0.97, 1, 1, 1, 0.98, 0.95, 0.92, 0.9, 0.9, 0.85, 0.75, 0.65, 0.55, 0.48] },
  residential: { name: 'Village / residential mini-grid', shape: [0.3, 0.27, 0.25, 0.25, 0.28, 0.38, 0.5, 0.48, 0.42, 0.4, 0.4, 0.42, 0.43, 0.42, 0.42, 0.45, 0.55, 0.78, 1, 0.98, 0.9, 0.75, 0.55, 0.4] },
  custom: { name: 'Custom (edit the 24 values)', shape: null },
};

export const PCT = 'pct';
// Mounting styles of the heat-loss thermal model: the factor Uc (W/m²K) for modules with free air behind them, with an air gap
// under them (flush on a roof, a canopy with a closed back) or with none (roof-integrated). A typed Uc or Uv that matches none is 'custom'.
export const MOUNT_STYLES = { open: { uc: 29, uv: 0 }, flush: { uc: 20, uv: 0 }, integrated: { uc: 15, uv: 0 } };
export const mountStyleOf = (pv) => Object.keys(MOUNT_STYLES).find((k) => MOUNT_STYLES[k].uc === pv.uc && MOUNT_STYLES[k].uv === pv.uv) || 'custom';
export const PV_FC_METHODS = [['ensemble', 'Adaptive ensemble'], ['mlp', 'Neural network (MLP)'], ['ets', 'Exponential smoothing'], ['rls', 'Adaptive regression (RLS)'], ['analog', 'Analog ensemble (k-NN)'],
  ['smart_persistence', 'Smart persistence (clear-sky index)'], ['climatology', '30-day climatology'], ['persistence', 'Persistence (yesterday)'],
  ['perfect', 'Perfect (benchmark)'], ['noisy', 'Perfect + random error']];
export const LOAD_FC_METHODS = [['ensemble', 'Adaptive ensemble'], ['mlp', 'Neural network (MLP)'], ['profile', '7-day profile + persistence'], ['rls', 'Adaptive regression (RLS)'], ['analog', 'Analog ensemble (k-NN)'],
  ['ets', 'Exponential smoothing'], ['climatology', '30-day climatology'], ['weekly', 'Same hour last week'], ['persistence', 'Same hour yesterday'],
  ['perfect', 'Perfect (benchmark)'], ['noisy', 'Perfect + random error']];
