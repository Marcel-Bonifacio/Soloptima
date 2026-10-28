// Default project and declarative input forms (rendered + two-way bound by renderForms()).
'use strict';

function defaultProject() {
  return {
    name: 'New hybrid project',
    // utc_offset: the standard offset of the IANA zone tz, unless typed (utc_offset_src: zone | typed | longitude when no zone
    // was found | saved, kept from a project made before the zone lookup)
    location: { lat: -6.2, lon: 106.85, utc_offset: 7, tz: 'Asia/Jakarta', utc_offset_src: 'zone', elevation: 0 },
    weather: null,
    weather_ui: { source: 'pvgis_tmy', year: 2023, is_utc: true },
    // Inter-annual variability run (Solar resource): inputs, the last summary (never the weather years) and the P90/P50 factor
    // last set by "Use for debt sizing" (basis: P90 of one year or of a 10-year average).
    resource_years: { source: 'pvgis', from: 2005, to: 2023, unc_dataset: 0.05, unc_model: 0.02, unc_soiling: 0.015, basis: 1, result: null, applied: null },
    // import: the uploaded file and its import report ({file, interval_min, label, basis, units, report}); qc: the data checks
    // of a measured load (web/js/tsimport.js). P.weather keeps the same two for its own data.
    load: {
      kw: null, growth: 0, template: 'continuous', source: 'synthetic',
      daily: new Array(24).fill(1000), monthly: new Array(12).fill(1),
      target_avg: 0, weekend_factor: 1, var_day: 0.03, var_hour: 0.02, seed: 1, import: null, qc: null,
    },
    pv: {
      thermal_model: 'uc_uv', noct: 45,
      capacity_kwp: 1000, module_wp: 600, module_eff: 0.22, module_length: 2.278, module_width: 1.134,
      gamma_pmax: -0.0034, low_irr_loss_200: 0.02, mount: 'fixed', tilt: 10, azimuth_auto: true, azimuth: 180,
      gcr: 0.45, tracker_axis_azimuth: 0, tracker_max_angle: 55, backtracking: true, row_shading: true, albedo: 0.2,
      iam_b0: 0.05, soiling: 0.02, uc: 29, uv: 0, absorptance: 0.9, mismatch: 0.02, dc_wiring: 0.015, dc_wiring_basis: 'annual',
      lid: 0.015, module_quality: 0, dc_ac_ratio: 1.2, inverter_eff: 0.983, ac_losses: 0.015, availability: 0.99, degradation: 0.005,
    },
    bess: { energy_kwh: 1000, power_kw: 500, rte: 0.88, soc_min: 0.1, soc_max: 1, soc_init: 0.5, calendar_fade: 0.01,
            cycle_life: 6000, cycle_life_dod: 1, eol_soh: 0.7, replace_soh: null, soh_init: 1, warranty_efc_yr: 0,
            provides_reserve: true, reserve_duration_h: 1, self_discharge: 0 },
    aux: { bess_kw_per_mwh: 0, bess_temp_coeff: 0, ref_c: 25, plant_kw: 0, trafo_noload_kw: 0, bess_trafo_noload_kw: 0, pcs_kw_per_mw: 0 },
    wind: { units: 0, rated_kw: 1500, v_in: 3, v_rated: 12, v_out: 25, hub_height: 80, ref_height: 10, shear_alpha: 0.143,
            curve: 'cubic', losses: 0.08, availability: 0.97 },
    diesel: {
      unit_kw: 500, units: 4, min_load: 0.3, min_units_online: 1, reserve_load: 0.1, reserve_pv: 0.5,
      strategy: 'load_following', cc_setpoint: 0.8, fuel_model: 'table', fuel_intercept: 0.0165, fuel_slope: 0.2423,
      fuel_curve: [[0.25, 3.22], [0.3, 3.37], [0.4, 3.6], [0.5, 3.76], [0.6, 3.85], [0.7, 3.92], [0.75, 3.94], [0.8, 3.97], [0.9, 3.98], [1, 3.97]],
    },
    ems: { pv_forecast: 'smart_persistence', load_forecast: 'profile', noise_sigma: 0.15, horizon: 24, replan: 1,
           soc_levels: 21, terminal_value: 0.9, firm_commitment: false, voll: 5 },
    econ: {
      currency: 'USD', lifetime: 25, discount_rate: 0.08, om_escalation: 0.02, fuel_price: 1.0, fuel_escalation: 0.02,
      pv_capex_kwp: 600, pv_om_kwp: 10, pv_life: 25, inverter_replacement_year: 12, inverter_replacement_kwac: 40,
      bess_capex_kwh: 220, bess_capex_kw: 80, bess_om_kwh: 4, bess_replace_kwh: 150, bess_cost_decline: 0.03,
      diesel_capex_kw: 0, diesel_om_kwh: 0.01, diesel_om_unit_hour: 2, co2_kg_per_l: 2.68, carbon_price_t: 0, other_capex_frac: 0,
      nox_g_per_l: 35, sox_g_per_l: 0.8, wind_capex_kw: 1400, wind_om_kw: 40, wind_life: 20,
      jobs_pv_per_mw: 2.7, jobs_wind_per_mw: 1.1, jobs_bess_per_mwh: 0.01, population: 0,
    },
    sim: { all_years: true },
    report: { imagery: true, figures: [] },   // report figures: satellite image under the layout drawing, and images supplied by the user
    layout: { polygons: [], orientation: 'portrait', modules_across: 2, modules_per_table: 28, table_gap: 0.5, setback: 10,
              google_key: '', result: null },
    optimizer: { pv_min: 0, pv_max: 0, pv_steps: 16, bess_min: 0, bess_max: 0, bess_steps: 12, c_rates_text: '0.5',
                 objective: 'npc', max_unmet: 0.001, min_re: 0, max_curtail: 1, max_pv_kwp: 0, max_capex: 0, max_lole_h: -1, max_reserve_short_h: -1, refine: true,
                 fast: false, sens_var: '', sens_values_text: '', algorithm: 'grid', particles: 24, iterations: 40, seed: 42,
                 wind_min: 0, wind_max: 0, mo_second: 're' },
    sched: { provider: 'open_meteo', api_key: '', days: 2, soc_now: 0.5, load_scale: 1 },
    tornado: { metric: 'npv', fast: false, bess_together: false, vars: TORNADO_VARS() },
    equipment: { lib: defaultLibrary(), sel: { pv: 'pv600', inverter: 'inv330', battery: 'bat5', genset: 'dg500' } },
    electrical: {
      mv_kv: 20, pf_load: 0.9, t_min: null, t_cell_max: 70, modules_per_string: 0, derate: 0.8,
      trafo_pv: 'tr3150', trafo_bess: 'tr5000', trafo_gen: 'tr2500', gens_per_trafo: 1, gen_mv: false, trafo_load: '',
      pv_per_feeder: 4, dv_dc: 1.5, dv_lv: 1.5, dv_mv: 1.0,
      len: { dc: 60, lv_pv: 120, mv_pv: 800, lv_bess: 30, mv_bess: 400, lv_gen: 60, mv_gen: 250, load: 500 },
      cable: { dc: 'dc6', lv_pv: 'lv240al', mv_pv: 'mv240al', lv_bess: 'lv400al', mv_bess: 'mv240al', lv_gen: 'lv630cu', mv_gen: 'mv150al', load: 'mv400al' },
      runs: { dc: 1, lv_pv: 2, mv_pv: 1, lv_bess: 4, mv_bess: 1, lv_gen: 4, mv_gen: 1, load: 2 },
      applied: null,   // losses last set by "Apply losses to the model" (dc_wiring, ac_losses, dc_ac_ratio, trafo_noload_kw, bess_trafo_noload_kw)
    },
    scripts: [],
    finance: {
      model: 'host', term: 0, construction_years: 1, inflation: 0.03, equity_discount: 0.12,
      land: 0, dev_fixed: 0, contingency_pct: 0.02, vat_pct: 0, vat_recoverable: false,
      tariff_mode: 'components', components: [{ name: 'Energy tariff', v1: 0.12, v2: 0.12, idx: 0.02, pct: 0 }], stage2_year: 0,
      diesel_discount: 0.25, tariff_vat: 0, take_or_pay: 0, ace_factor: 1, deemed_share: 0, penalty_threshold: 0, penalty_rate: 0,
      solve: false, solve_for: 'equity', target_irr: 0.12,
      fixed_opex: 0, insurance_pct: 0.005, land_lease: 0,
      tax_rate: 0.22, wht_pct: 0, loss_cf_years: 5, tax_holiday_years: 0, host_taxable: true, sme_31e: false, sme_low: 4.8e9, sme_high: 50e9,
      dep_method: 'sl', dep_life: 20, dep_life_bess: 8, dep_preset: 'custom',
      gearing: 0.7, dscr_target: 1.3, interest: 0.08, upfront_fee: 0.02, tenor: 12, grace: 0, sizing: 'min', repayment: 'sculpted',
      dsra_months: 6, p90_factor: 1, receivable_days: 0, payable_days: 0, terminal: 'salvage',
    },
    // Records of the existing diesel plant (Diesel & control), checked against the modelled diesel-only case on Simulation results.
    // Not an engine input. A blank value is null; blank and zero values are left out of the check. monthly_fuel_l holds 12 values
    // (null = no record; a zero is stored as null).
    site_records: { period: '', source: '', scope: '', annual_load_mwh: null, peak_kw: null, annual_gen_mwh: null, annual_fuel_l: null, unit_hours: null,
                    monthly_fuel_l: new Array(12).fill(null) },
  };
}

// Default inputs of the tornado (Simulation results). mode x: low and high multiply the base value; +: added to it; =: the value itself.
// Values are in engine units (fractions for percentages); 'load.kw' scales the whole 8760-h load profile.
const TORNADO_VARS = () => [
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
const LOAD_TEMPLATES = {
  continuous: { name: 'Continuous industrial (24/7)', shape: [0.97, 0.96, 0.96, 0.95, 0.96, 0.97, 0.99, 1, 1, 1, 0.99, 1, 0.98, 1, 1, 0.99, 0.99, 0.98, 0.98, 0.98, 0.97, 0.97, 0.97, 0.97] },
  process: { name: 'Continuous process plant with a shift-change dip', shape: [0.913, 0.945, 1, 0.911, 0.942, 0.946, 0.901, 0.905, 0.975, 0.939, 0.927, 0.995, 0.981, 0.931, 0.918, 0.942, 0.911, 0.89, 0.881, 0.88, 0.634, 0.885, 0.935, 0.933] },
  dayshift: { name: 'Day-shift industrial (2 shifts)', shape: [0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.6, 0.95, 1, 1, 1, 0.9, 0.85, 1, 1, 1, 0.95, 0.9, 0.85, 0.8, 0.6, 0.4, 0.3, 0.25] },
  commercial: { name: 'Commercial / hotel', shape: [0.45, 0.42, 0.4, 0.4, 0.42, 0.5, 0.62, 0.75, 0.85, 0.92, 0.97, 1, 1, 1, 0.98, 0.95, 0.92, 0.9, 0.9, 0.85, 0.75, 0.65, 0.55, 0.48] },
  residential: { name: 'Village / residential mini-grid', shape: [0.3, 0.27, 0.25, 0.25, 0.28, 0.38, 0.5, 0.48, 0.42, 0.4, 0.4, 0.42, 0.43, 0.42, 0.42, 0.45, 0.55, 0.78, 1, 0.98, 0.9, 0.75, 0.55, 0.4] },
  custom: { name: 'Custom (edit the 24 values)', shape: null },
};

const PCT = 'pct';
const PV_FC_METHODS = [['ensemble', 'Adaptive ensemble'], ['mlp', 'Neural network (MLP)'], ['ets', 'Exponential smoothing'], ['rls', 'Adaptive regression (RLS)'], ['analog', 'Analog ensemble (k-NN)'],
  ['smart_persistence', 'Smart persistence (clear-sky index)'], ['climatology', '30-day climatology'], ['persistence', 'Persistence (yesterday)'],
  ['perfect', 'Perfect (benchmark)'], ['noisy', 'Perfect + random error']];
const LOAD_FC_METHODS = [['ensemble', 'Adaptive ensemble'], ['mlp', 'Neural network (MLP)'], ['profile', '7-day profile + persistence'], ['rls', 'Adaptive regression (RLS)'], ['analog', 'Analog ensemble (k-NN)'],
  ['ets', 'Exponential smoothing'], ['climatology', '30-day climatology'], ['weekly', 'Same hour last week'], ['persistence', 'Same hour yesterday'],
  ['perfect', 'Perfect (benchmark)'], ['noisy', 'Perfect + random error']];
const FORMS = {
  site: [
    { k: 'location.lat', l: 'Latitude', u: '°', t: 'num', step: 0.0001, lim: [-90, 90] },
    { k: 'location.lon', l: 'Longitude', u: '°', t: 'num', step: 0.0001, lim: [-180, 180] },
    { k: 'location.utc_offset', l: 'Time zone (UTC offset)', u: 'h', t: 'num', step: 0.25, lim: [-14, 14] },
    { k: 'econ.currency', l: 'Currency', t: 'text' },
  ],
  layout: [
    { k: 'layout.orientation', l: 'Module orientation', t: 'sel', o: [['portrait', 'Portrait'], ['landscape', 'Landscape']] },
    { k: 'layout.modules_across', l: 'Modules across table (rows)', t: 'int' },
    { k: 'layout.modules_per_table', l: 'Modules along table', t: 'int' },
    { k: 'pv.tilt', l: 'Tilt', u: '°', t: 'num', sl: [0, 45, 1] },
    { k: 'pv.gcr', l: 'Ground coverage ratio', t: 'num', step: 0.01, sl: [0.2, 0.9, 0.01] },
    { k: 'layout.table_gap', l: 'Gap between tables', u: 'm', t: 'num', step: 0.1 },
    { k: 'layout.setback', l: 'Boundary setback', u: 'm', t: 'num', sl: [0, 50, 1] },
    { k: 'layout.google_key', l: 'Google Maps API key', t: 'text' },
  ],
  weather: [
    { k: 'weather_ui.source', l: 'Database', t: 'sel', o: [['pvgis_tmy', 'PVGIS typical year (TMY)'], ['pvgis_year', 'PVGIS specific year'], ['nasa_power', 'NASA POWER specific year']] },
    { k: 'weather_ui.year', l: 'Year', t: 'int', show: (P) => P.weather_ui.source !== 'pvgis_tmy' },
    { k: 'weather_ui.is_utc', l: 'CSV timestamps in UTC', t: 'chk' },
  ],
  'resource-years': [
    { k: 'resource_years.source', l: 'Database', t: 'sel', o: [['pvgis', 'PVGIS hourly years (2005–2023)'], ['nasa_power', 'NASA POWER hourly years (2001 to last complete year)']] },
    { k: 'resource_years.from', l: 'From year', t: 'int' },
    { k: 'resource_years.to', l: 'To year', t: 'int' },
    { k: 'resource_years.unc_dataset', l: 'Irradiance dataset uncertainty', u: '%', t: PCT, step: 0.1 },
    { k: 'resource_years.unc_model', l: 'Transposition and PV model uncertainty', u: '%', t: PCT, step: 0.1 },
    { k: 'resource_years.unc_soiling', l: 'Soiling and availability uncertainty', u: '%', t: PCT, step: 0.1 },
  ],
  load: [
    { k: 'load.template', l: 'Daily shape template', t: 'sel', o: Object.entries(LOAD_TEMPLATES).map(([k, v]) => [k, v.name]) },
    { k: 'load.target_avg', l: 'Scale to average load', u: 'kW', t: 'num' },
    { k: 'load.weekend_factor', l: 'Weekend load', u: '%', t: PCT },
    { k: 'load.var_day', l: 'Day-to-day variability', u: '%', t: PCT },
    { k: 'load.var_hour', l: 'Hour-to-hour variability', u: '%', t: PCT },
    { k: 'load.seed', l: 'Random seed', t: 'int' },
    { k: 'load.growth', l: 'Annual load growth', u: '%/yr', t: PCT },
  ],
  'pv-module': [
    { k: 'pv.capacity_kwp', l: 'PV capacity (DC)', u: 'kWp', t: 'num' },
    { k: 'pv.module_wp', l: 'Module power', u: 'Wp', t: 'num' },
    { k: 'pv.module_eff', l: 'Module efficiency', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.module_length', l: 'Module length', u: 'm', t: 'num', step: 0.001 },
    { k: 'pv.module_width', l: 'Module width', u: 'm', t: 'num', step: 0.001 },
    { k: 'pv.gamma_pmax', l: 'Temp. coefficient Pmax', u: '%/°C', t: PCT, step: 0.01 },
    { k: 'pv.thermal_model', l: 'Cell temperature model', t: 'sel', o: [['uc_uv', 'Heat-loss factors (Uc, Uv)'], ['noct', 'NOCT (Tc = Ta + (NOCT−20)/800·G)']] },
    { k: 'pv.uc', l: 'Thermal loss factor Uc', u: 'W/m²K', t: 'num', show: (P) => P.pv.thermal_model !== 'noct' },
    { k: 'pv.uv', l: 'Thermal loss factor Uv', u: 'W/m²K/(m/s)', t: 'num', show: (P) => P.pv.thermal_model !== 'noct' },
    { k: 'pv.noct', l: 'NOCT', u: '°C', t: 'num', show: (P) => P.pv.thermal_model === 'noct' },
    { k: 'pv.degradation', l: 'Annual degradation', u: '%/yr', t: PCT, step: 0.05 },
  ],
  'pv-mount': [
    { k: 'pv.mount', l: 'Mounting', t: 'sel', o: [['fixed', 'Fixed tilt'], ['tracker', 'Single-axis tracker']] },
    { k: 'pv.tilt', l: 'Tilt', u: '°', t: 'num', show: (P) => P.pv.mount === 'fixed', sl: [0, 45, 1] },
    { k: 'pv.azimuth_auto', l: 'Face the equator', t: 'chk', show: (P) => P.pv.mount === 'fixed' },
    { k: 'pv.azimuth', l: 'Azimuth (0=N, 90=E, 180=S)', u: '°', t: 'num', show: (P) => P.pv.mount === 'fixed' && !P.pv.azimuth_auto },
    { k: 'pv.tracker_axis_azimuth', l: 'Tracker axis azimuth', u: '°', t: 'num', show: (P) => P.pv.mount === 'tracker' },
    { k: 'pv.tracker_max_angle', l: 'Max rotation', u: '°', t: 'num', show: (P) => P.pv.mount === 'tracker' },
    { k: 'pv.backtracking', l: 'Backtracking', t: 'chk', show: (P) => P.pv.mount === 'tracker' },
    { k: 'pv.gcr', l: 'Ground coverage ratio', t: 'num', step: 0.01, sl: [0.2, 0.9, 0.01] },
    { k: 'pv.row_shading', l: 'Row-to-row shading', t: 'chk' },
    { k: 'pv.albedo', l: 'Ground albedo', t: 'num', step: 0.01 },
  ],
  'pv-loss': [
    { k: 'pv.soiling', l: 'Soiling', u: '%', t: PCT, step: 0.1, sl: [0, 10, 0.1] },
    { k: 'pv.iam_b0', l: 'IAM b0 (ASHRAE)', t: 'num', step: 0.01 },
    { k: 'pv.low_irr_loss_200', l: 'Low-irradiance loss @200 W/m²', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.mismatch', l: 'Mismatch', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.dc_wiring', l: 'DC wiring', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.dc_wiring_basis', l: 'DC wiring loss basis', t: 'sel', o: [['annual', 'Constant fraction (annual)'], ['stc', 'At STC power']] },
    { k: 'pv.lid', l: 'LID / LeTID', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.module_quality', l: 'Module quality', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.dc_ac_ratio', l: 'DC/AC ratio', t: 'num', step: 0.01, sl: [1, 1.6, 0.01] },
    { k: 'pv.inverter_eff', l: 'Inverter efficiency', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.ac_losses', l: 'AC + transformer losses', u: '%', t: PCT, step: 0.1 },
    { k: 'pv.availability', l: 'Availability', u: '%', t: PCT, step: 0.1 },
  ],
  bess: [
    { k: 'bess.energy_kwh', l: 'Energy capacity', u: 'kWh', t: 'num' },
    { k: 'bess.power_kw', l: 'Power rating', u: 'kW', t: 'num' },
    { k: 'bess.rte', l: 'Round-trip efficiency (AC)', u: '%', t: PCT, sl: [70, 98, 0.5] },
    { k: 'bess.soc_min', l: 'Minimum SOC', u: '%', t: PCT, sl: [0, 50, 1] },
    { k: 'bess.soc_max', l: 'Maximum SOC', u: '%', t: PCT },
    { k: 'bess.soc_init', l: 'Initial SOC', u: '%', t: PCT },
    { k: 'bess.provides_reserve', l: 'Counts as spinning reserve', t: 'chk' },
    { k: 'bess.reserve_duration_h', l: 'Reserve duration', u: 'h', t: 'num', step: 0.05, show: (P) => P.bess.provides_reserve },
    { k: 'bess.self_discharge', l: 'Self-discharge', u: '%/h', t: PCT, step: 0.001 },
  ],
  wind: [
    { k: 'wind.units', l: 'Number of turbines (0 = none)', t: 'int' },
    { k: 'wind.rated_kw', l: 'Rated power per turbine', u: 'kW', t: 'num' },
    { k: 'wind.v_in', l: 'Cut-in speed', u: 'm/s', t: 'num', step: 0.1 },
    { k: 'wind.v_rated', l: 'Rated speed', u: 'm/s', t: 'num', step: 0.1 },
    { k: 'wind.v_out', l: 'Cut-out speed', u: 'm/s', t: 'num', step: 0.1 },
    { k: 'wind.curve', l: 'Power curve', t: 'sel', o: [['cubic', 'Cubic (P ∝ v³ − v_in³)'], ['linear', 'Linear']] },
    { k: 'wind.hub_height', l: 'Hub height', u: 'm', t: 'num' },
    { k: 'wind.ref_height', l: 'Measurement height', u: 'm', t: 'num' },
    { k: 'wind.shear_alpha', l: 'Wind shear exponent α', t: 'num', step: 0.01 },
    { k: 'wind.losses', l: 'Wake + electrical losses', u: '%', t: PCT },
    { k: 'wind.availability', l: 'Availability', u: '%', t: PCT },
    { k: 'econ.wind_capex_kw', l: 'Wind capex', u: '/kW', t: 'num' },
    { k: 'econ.wind_om_kw', l: 'Wind O&M', u: '/kW/yr', t: 'num' },
    { k: 'econ.wind_life', l: 'Wind turbine life', u: 'yr', t: 'int' },
  ],
  'bess-age': [
    { k: 'bess.calendar_fade', l: 'Calendar fade', u: '%/yr', t: PCT, step: 0.1 },
    { k: 'bess.cycle_life', l: 'Cycle life to end-of-life', u: 'cycles', t: 'num' },
    { k: 'bess.cycle_life_dod', l: 'Depth of discharge of the cycle life', u: '%', t: PCT },
    { k: 'bess.eol_soh', l: 'End-of-life state of health', u: '%', t: PCT },
    { k: 'bess.replace_soh', l: 'Replace at state of health', u: '%', t: PCT, ph: 'EOL' },
    { k: 'bess.soh_init', l: 'Initial state of health', u: '%', t: PCT },
    { k: 'bess.warranty_efc_yr', l: 'Warranty cycle cap (0 = none)', u: 'cycles/yr', t: 'num' },
  ],
  aux: [
    { k: 'aux.bess_kw_per_mwh', l: 'Battery HVAC, BMS and fire system', u: 'kW/MWh', t: 'num', step: 0.1 },
    { k: 'aux.bess_temp_coeff', l: 'Battery draw rise above reference', u: '%/°C', t: PCT, step: 0.1 },
    { k: 'aux.ref_c', l: 'Reference ambient temperature', u: '°C', t: 'num' },
    { k: 'aux.pcs_kw_per_mw', l: 'Battery inverter (PCS) no-load loss', u: 'kW/MW', t: 'num', step: 0.1 },
    { k: 'aux.plant_kw', l: 'Plant auxiliaries (SCADA, lighting, trackers)', u: 'kW', t: 'num', step: 0.1 },
    { k: 'aux.trafo_noload_kw', l: 'PV transformer no-load loss', u: 'kW', t: 'num', step: 0.1 },
    { k: 'aux.bess_trafo_noload_kw', l: 'BESS transformer no-load loss', u: 'kW', t: 'num', step: 0.1 },
  ],
  diesel: [
    { k: 'diesel.unit_kw', l: 'Unit rating (prime)', u: 'kW', t: 'num' },
    { k: 'diesel.units', l: 'Number of units', t: 'int' },
    { k: 'diesel.min_load', l: 'Minimum loading per unit', u: '%', t: PCT, sl: [0, 70, 1] },
    { k: 'diesel.min_units_online', l: 'Units always online', t: 'int' },
    { k: 'diesel.reserve_load', l: 'Spinning reserve as share of load', u: '%', t: PCT, sl: [0, 50, 1] },
    { k: 'diesel.reserve_pv', l: 'Spinning reserve as share of PV and wind', u: '%', t: PCT },
  ],
  // ph '': a blank field stores null and leaves the record out of the check
  records: [
    { k: 'site_records.period', l: 'Period of the records', t: 'text' },
    { k: 'site_records.source', l: 'Source of the records', t: 'text' },
    { k: 'site_records.scope', l: 'Scope of the records', t: 'text' },
    { k: 'site_records.annual_load_mwh', l: 'Site load', u: 'MWh/yr', t: 'num', ph: '' },
    { k: 'site_records.peak_kw', l: 'Peak load', u: 'kW', t: 'num', ph: '' },
    { k: 'site_records.annual_gen_mwh', l: 'Genset generation', u: 'MWh/yr', t: 'num', ph: '' },
    { k: 'site_records.annual_fuel_l', l: 'Fuel used', u: 'L/yr', t: 'num', ph: '' },
    { k: 'site_records.unit_hours', l: 'Genset run hours, all units', u: 'h/yr', t: 'num', ph: '' },
  ],
  control: [
    { k: 'diesel.strategy', l: 'Strategy', t: 'sel', o: [['load_following', 'Load following'], ['cycle_charging', 'Cycle charging'], ['predictive', 'Predictive EMS (forecast-based)']] },
    { k: 'diesel.cc_setpoint', l: 'Cycle-charging SOC setpoint', u: '%', t: PCT, show: (P) => P.diesel.strategy === 'cycle_charging' },
    { k: 'sim.all_years', l: 'Simulate every project year', t: 'chk' },
  ],
  ems: [
    { k: 'ems.pv_forecast', l: 'PV forecast', t: 'sel', o: PV_FC_METHODS },
    { k: 'ems.load_forecast', l: 'Load forecast', t: 'sel', o: LOAD_FC_METHODS },
    { k: 'ems.noise_sigma', l: 'Random error (σ)', u: '%', t: PCT, show: (P) => P.ems.pv_forecast === 'noisy' || P.ems.load_forecast === 'noisy' },
    { k: 'ems.horizon', l: 'Look-ahead horizon', u: 'h', t: 'int' },
    { k: 'ems.replan', l: 'Re-plan every', u: 'h', t: 'int' },
    { k: 'ems.soc_levels', l: 'SOC resolution (levels)', t: 'int' },
    { k: 'ems.terminal_value', l: 'Value of stored energy at horizon', u: '× fuel', t: 'num', step: 0.05 },
    { k: 'ems.firm_commitment', l: 'Firm (day-ahead) unit commitment', t: 'chk' },
    { k: 'ems.voll', l: 'Value of lost load', u: '/kWh', t: 'num' },
  ],
  fuel: [
    { k: 'diesel.fuel_model', l: 'Fuel model', t: 'sel', o: [['table', 'Efficiency table (datasheet)'], ['linear', 'Linear (intercept + slope)']] },
    { k: 'diesel.fuel_intercept', l: 'Intercept', u: 'L/h/kW', t: 'num', step: 0.0001, show: (P) => P.diesel.fuel_model === 'linear' },
    { k: 'diesel.fuel_slope', l: 'Slope', u: 'L/kWh', t: 'num', step: 0.0001, show: (P) => P.diesel.fuel_model === 'linear' },
  ],
  'econ-gen': [
    { k: 'econ.currency', l: 'Currency', t: 'text' },
    { k: 'econ.lifetime', l: 'Project lifetime', u: 'yr', t: 'int' },
    { k: 'econ.discount_rate', l: 'Discount rate (nominal)', u: '%', t: PCT, step: 0.1, sl: [0, 20, 0.1] },
    { k: 'econ.om_escalation', l: 'O&M escalation', u: '%/yr', t: PCT, step: 0.1 },
    { k: 'econ.fuel_price', l: 'Diesel price (delivered)', u: '/L', t: 'num', step: 0.01, sl: [0.2, 3, 0.01] },
    { k: 'econ.fuel_escalation', l: 'Fuel price escalation', u: '%/yr', t: PCT, step: 0.1 },
    { k: 'econ.other_capex_frac', l: 'Development / EPC margin on PV, BESS and wind', u: '%', t: PCT },
  ],
  'econ-cap': [
    { k: 'econ.pv_capex_kwp', l: 'PV capex (installed)', u: '/kWp', t: 'num' },
    { k: 'econ.pv_om_kwp', l: 'PV O&M', u: '/kWp/yr', t: 'num' },
    { k: 'econ.pv_life', l: 'PV useful life', u: 'yr', t: 'int' },
    { k: 'econ.inverter_replacement_year', l: 'Inverter replacement year', t: 'int' },
    { k: 'econ.inverter_replacement_kwac', l: 'Inverter replacement cost', u: '/kWac', t: 'num' },
    { k: 'econ.bess_capex_kwh', l: 'BESS energy capex', u: '/kWh', t: 'num' },
    { k: 'econ.bess_capex_kw', l: 'BESS power capex (PCS)', u: '/kW', t: 'num' },
    { k: 'econ.bess_om_kwh', l: 'BESS O&M', u: '/kWh/yr', t: 'num', step: 0.1 },
    { k: 'econ.bess_replace_kwh', l: 'BESS replacement cost (today)', u: '/kWh', t: 'num' },
    { k: 'econ.bess_cost_decline', l: 'Battery price decline', u: '%/yr', t: PCT, step: 0.1 },
  ],
  'econ-dg': [
    { k: 'econ.diesel_capex_kw', l: 'Genset capex (0 if existing)', u: '/kW', t: 'num' },
    { k: 'econ.diesel_om_kwh', l: 'Genset O&M per kWh', u: '/kWh', t: 'num', step: 0.001 },
    { k: 'econ.diesel_om_unit_hour', l: 'Genset O&M per run hour', u: '/unit·h', t: 'num', step: 0.1 },
    { k: 'econ.co2_kg_per_l', l: 'CO₂ emission factor', u: 'kg/L', t: 'num', step: 0.01 },
    { k: 'econ.carbon_price_t', l: 'Carbon price', u: '/tCO₂', t: 'num' },
    { k: 'econ.nox_g_per_l', l: 'NOx emission factor', u: 'g/L', t: 'num' },
    { k: 'econ.sox_g_per_l', l: 'SOx emission factor', u: 'g/L', t: 'num', step: 0.1 },
    { k: 'econ.jobs_pv_per_mw', l: 'Jobs from PV', u: 'jobs/MW', t: 'num', step: 0.01 },
    { k: 'econ.jobs_wind_per_mw', l: 'Jobs from wind', u: 'jobs/MW', t: 'num', step: 0.01 },
    { k: 'econ.jobs_bess_per_mwh', l: 'Jobs from battery', u: 'jobs/MWh', t: 'num', step: 0.001 },
    { k: 'econ.population', l: 'Population served (for HDI)', t: 'num' },
  ],
  'opt-alg': [
    { k: 'optimizer.algorithm', l: 'Algorithm', t: 'sel', o: [['grid', 'Grid search + pattern search (exhaustive)'], ['pso', 'Particle swarm (PSO)'], ['hshoa', 'Hybrid SHO–QAO–GOA'], ['mopso', 'Multi-objective PSO (Pareto)']] },
    { k: 'optimizer.particles', l: 'Population size', t: 'int', show: (P) => P.optimizer.algorithm !== 'grid' },
    { k: 'optimizer.iterations', l: 'Iterations', t: 'int', show: (P) => P.optimizer.algorithm !== 'grid' },
    { k: 'optimizer.mo_second', l: 'Second objective (maximise)', t: 'sel', o: [['re', 'Renewable fraction'], ['sssi', 'Self-sufficiency (SSSI)']], show: (P) => P.optimizer.algorithm === 'mopso' },
    { k: 'optimizer.wind_min', l: 'Wind turbines min', t: 'int', show: (P) => P.optimizer.algorithm !== 'grid' },
    { k: 'optimizer.wind_max', l: 'Wind turbines max', t: 'int', show: (P) => P.optimizer.algorithm !== 'grid' },
    { k: 'optimizer.seed', l: 'Random seed', t: 'int', show: (P) => P.optimizer.algorithm !== 'grid' },
  ],
  'opt-space': [
    { k: 'optimizer.pv_min', l: 'PV min', u: 'kWp', t: 'num' },
    { k: 'optimizer.pv_max', l: 'PV max', u: 'kWp', t: 'num' },
    { k: 'optimizer.pv_steps', l: 'PV grid points', t: 'int', show: (P) => P.optimizer.algorithm === 'grid' },
    { k: 'optimizer.bess_min', l: 'BESS min', u: 'kWh', t: 'num' },
    { k: 'optimizer.bess_max', l: 'BESS max', u: 'kWh', t: 'num' },
    { k: 'optimizer.bess_steps', l: 'BESS grid points', t: 'int', show: (P) => P.optimizer.algorithm === 'grid' },
    { k: 'optimizer.c_rates_text', l: 'BESS C-rates (kW/kWh)', t: 'text' },
    { k: 'optimizer.refine', l: 'Refine with pattern search', t: 'chk', show: (P) => P.optimizer.algorithm === 'grid' },
    { k: 'optimizer.fast', l: 'Fast mode (year 1 only)', t: 'chk' },
  ],
  'opt-obj': [
    { k: 'optimizer.objective', l: 'Objective', t: 'sel', o: [['npc', 'Minimise net present cost'], ['lcoe', 'Minimise LCOE'], ['re', 'Maximise renewable fraction']] },
    { k: 'optimizer.max_unmet', l: 'Max unmet load', u: '%', t: PCT, step: 0.01 },
    { k: 'optimizer.min_re', l: 'Min renewable fraction', u: '%', t: PCT },
    { k: 'optimizer.max_curtail', l: 'Max PV curtailment', u: '%', t: PCT },
    { k: 'optimizer.max_lole_h', l: 'Max loss-of-load hours (−1 = no limit)', u: 'h/yr', t: 'num' },
    { k: 'optimizer.max_reserve_short_h', l: 'Max reserve shortfall hours (−1 = no limit)', u: 'h/yr', t: 'num' },
    { k: 'optimizer.max_pv_kwp', l: 'Land limit (max PV)', u: 'kWp', t: 'num' },
    { k: 'optimizer.max_capex', l: 'Capex budget', t: 'num', help: '0 = none' },
  ],
  'opt-sens': [
    { k: 'optimizer.sens_var', l: 'Sensitivity variable', t: 'sel', o: [['', 'None'], ['fuel_price', 'Diesel price'], ['fuel_escalation', 'Fuel escalation'], ['discount_rate', 'Discount rate'], ['pv_capex_kwp', 'PV capex /kWp'], ['bess_capex_kwh', 'BESS capex /kWh'], ['load_scale', 'Load multiplier'],
      ['bess_life_scale', 'Battery life multiplier'], ['bess_cycle_life', 'Battery cycle life'], ['bess_calendar_fade', 'Battery calendar fade'], ['bess_replace_kwh', 'BESS replacement cost /kWh'],
      ['bess_prices_scale', 'Battery price multiplier'], ['bess_replace_soh', 'Battery replacement SOH'], ['pv_degradation', 'PV degradation'], ['diesel_om_unit_hour', 'Genset O&M per run hour']] },
    { k: 'optimizer.sens_values_text', l: 'Values', t: 'text', help: 'Comma separated, e.g. 0.8, 1.0, 1.2', show: (P) => !!P.optimizer.sens_var },
  ],
  'fin-cap': [
    { k: 'finance.term', l: 'Analysis / PPA term (0 = project life)', u: 'yr', t: 'int' },
    { k: 'finance.construction_years', l: 'Construction period', u: 'yr', t: 'int' },
    { k: 'finance.contingency_pct', l: 'Contingency on hard capex', u: '%', t: PCT, step: 0.1 },
    { k: 'finance.dev_fixed', l: 'Development cost (fixed)', t: 'num' },
    { k: 'finance.land', l: 'Land purchase (not depreciated)', t: 'num' },
    { k: 'finance.vat_pct', l: 'VAT on capex', u: '%', t: PCT, step: 0.1 },
    { k: 'finance.vat_recoverable', l: 'VAT recoverable (refunded in year 1)', t: 'chk', show: (P) => P.finance.vat_pct > 0 },
    { k: 'finance.inflation', l: 'Inflation (for real values)', u: '%', t: PCT, step: 0.1 },
    { k: 'econ.discount_rate', l: 'Project discount rate (nominal)', u: '%', t: PCT, step: 0.1 },
    { k: 'finance.equity_discount', l: 'Cost of equity', u: '%', t: PCT, step: 0.1 },
    { k: 'finance.terminal', l: 'End of term', t: 'sel', o: [['salvage', 'Salvage value of remaining life'], ['transfer', 'Transfer at no value (BOOT / lease end)']] },
  ],
  'fin-rev': [
    { k: 'finance.tariff_mode', l: 'Tariff', t: 'sel', o: [['components', 'Tariff components (table below)'], ['diesel_discount', 'Discount to the avoided diesel cost']], show: (P) => P.finance.model !== 'host' },
    { k: 'finance.diesel_discount', l: 'Discount to diesel cost', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' && P.finance.tariff_mode === 'diesel_discount' },
    { k: 'finance.stage2_year', l: 'Stage 2 starts in year (0 = none)', t: 'int', show: (P) => P.finance.model !== 'host' && P.finance.tariff_mode === 'components' },
    { k: 'finance.take_or_pay', l: 'Take-or-pay share of contracted energy', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.ace_factor', l: 'Contracted energy (× year-1 delivery)', t: 'num', step: 0.01, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.deemed_share', l: 'Curtailed energy paid as deemed', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.penalty_threshold', l: 'Shortfall threshold (× contracted)', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.penalty_rate', l: 'Shortfall penalty (× tariff)', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' && P.finance.penalty_threshold > 0 },
    { k: 'finance.tariff_vat', l: 'VAT on the tariff (host pays)', u: '%', t: PCT, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.solve', l: 'Solve the tariff for a target IRR', t: 'chk', show: (P) => P.finance.model !== 'host' },
    { k: 'finance.solve_for', l: 'Target', t: 'sel', o: [['equity', 'Equity IRR (after tax)'], ['project', 'Project IRR (after tax)']], show: (P) => P.finance.model !== 'host' && P.finance.solve },
    { k: 'finance.target_irr', l: 'Target IRR', u: '%', t: PCT, step: 0.1, show: (P) => P.finance.model !== 'host' && P.finance.solve },
  ],
  'fin-debt': [
    { k: 'finance.sizing', l: 'Debt sizing', t: 'sel', o: [['min', 'Lower of gearing and DSCR'], ['gearing', 'Gearing (% of cost)'], ['dscr', 'DSCR sculpting only']] },
    { k: 'finance.gearing', l: 'Gearing (debt / total cost)', u: '%', t: PCT, sl: [0, 90, 1] },
    { k: 'finance.dscr_target', l: 'Target DSCR', t: 'num', step: 0.05 },
    { k: 'finance.interest', l: 'Interest rate', u: '%', t: PCT, step: 0.05 },
    { k: 'finance.tenor', l: 'Tenor', u: 'yr', t: 'int' },
    { k: 'finance.grace', l: 'Grace (interest only)', u: 'yr', t: 'int' },
    { k: 'finance.repayment', l: 'Repayment', t: 'sel', o: [['sculpted', 'Sculpted to DSCR'], ['annuity', 'Annuity (level payment)'], ['equal', 'Equal principal']] },
    { k: 'finance.upfront_fee', l: 'Upfront fee', u: '%', t: PCT, step: 0.1 },
    { k: 'finance.dsra_months', l: 'Debt service reserve', u: 'months', t: 'num' },
    { k: 'finance.p90_factor', l: 'Revenue haircut for sizing (P90/P50)', t: 'num', step: 0.001 },
  ],
  'fin-tax': [
    { k: 'finance.host_taxable', l: 'Owner pays income tax', t: 'chk', show: (P) => P.finance.model === 'host' },
    { k: 'finance.tax_rate', l: 'Corporate income tax', u: '%', t: PCT, step: 0.5 },
    { k: 'finance.loss_cf_years', l: 'Loss carry-forward (0 = unlimited, −1 = none)', u: 'yr', t: 'int' },
    { k: 'finance.tax_holiday_years', l: 'Tax holiday', u: 'yr', t: 'int' },
    { k: 'finance.wht_pct', l: 'Withholding on revenue (creditable)', u: '%', t: PCT, step: 0.1, show: (P) => P.finance.model !== 'host' },
    { k: 'finance.sme_31e', l: 'Indonesia Art. 31E reduced rate', t: 'chk', help: '50 % of the tax rate on the share of taxable income matching turnover up to the lower threshold, for turnover up to the upper threshold' },
    { k: 'finance.sme_low', l: 'Art. 31E lower threshold', t: 'num', show: (P) => P.finance.sme_31e },
    { k: 'finance.sme_high', l: 'Art. 31E upper threshold', t: 'num', show: (P) => P.finance.sme_31e },
    { k: 'finance.dep_preset', l: 'Depreciation preset', t: 'sel', o: [['custom', 'Custom'], ['id_g2', 'Indonesia group 2 (8 yr, 25 % DB)'], ['id_g3', 'Indonesia group 3 (16 yr, 12.5 % DB)'], ['id_g4', 'Indonesia group 4 (20 yr, 10 % DB)'], ['sl_20', 'Straight line 20 yr, battery 10 yr'], ['sl_term', 'Straight line over the term']] },
    { k: 'finance.dep_method', l: 'Method', t: 'sel', o: [['sl', 'Straight line'], ['db', 'Declining balance (switch to SL)']] },
    { k: 'finance.dep_life', l: 'Life of PV, wind and other assets', u: 'yr', t: 'int' },
    { k: 'finance.dep_life_bess', l: 'Life of battery', u: 'yr', t: 'int' },
  ],
  'fin-op': [
    { k: 'finance.fixed_opex', l: 'Fixed operating cost (staff, office)', u: '/yr', t: 'num' },
    { k: 'finance.insurance_pct', l: 'Insurance (% of hard capex)', u: '%/yr', t: PCT, step: 0.05 },
    { k: 'finance.land_lease', l: 'Land lease', u: '/yr', t: 'num' },
    { k: 'finance.receivable_days', l: 'Receivable days', u: 'days', t: 'num' },
    { k: 'finance.payable_days', l: 'Payable days', u: 'days', t: 'num' },
  ],
  sched: [
    { k: 'sched.provider', l: 'Forecast provider', t: 'sel', o: [['open_meteo', 'Open-Meteo (irradiance)'], ['met_norway', 'MET Norway (cloud cover)']] },
    { k: 'sched.api_key', l: 'Open-Meteo API key', t: 'text', show: (P) => P.sched.provider === 'open_meteo' },
    { k: 'sched.days', l: 'Days ahead', t: 'int', lim: [1, 16] },
    { k: 'sched.soc_now', l: 'Battery SOC now', u: '%', t: PCT },
    { k: 'sched.load_scale', l: 'Load forecast multiplier', t: 'num', step: 0.01 },
  ],
};

// Render every [data-form] container and bind inputs to P. onChange(key) fires after each edit.
function renderForms(P, onChange) {
  $$('[data-form]').forEach((box) => {
    const fields = FORMS[box.dataset.form];
    if (!fields) return;
    box.innerHTML = '';
    fields.forEach((f) => {
      const id = 'f_' + box.dataset.form + '_' + f.k.replace(/\./g, '_');
      const lab = document.createElement('label');
      lab.htmlFor = id; lab.textContent = f.l;
      // explanation button: glossary entry, or the field's own short help text
      if (!HELP[f.k] && f.help) HELP[f.k] = [f.help, ''];
      if (HELP[f.k]) lab.insertAdjacentHTML('beforeend', infoBtn(f.k, f.l));
      const wrap = document.createElement('div');
      wrap.className = 'field';
      let inp;
      if (f.t === 'sel') {
        inp = document.createElement('select');
        f.o.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; inp.appendChild(o); });
      } else {
        inp = document.createElement('input');
        inp.type = f.t === 'chk' ? 'checkbox' : f.t === 'text' ? 'text' : 'number';
        if (f.t === 'int') inp.step = 1;
        else if (f.step) inp.step = f.step;
        else if (inp.type === 'number') inp.step = 'any';
        if (f.ph != null) inp.placeholder = f.ph;   // optional value: blank stores null, the engine then uses its default
        if (f.lim) { inp.min = f.lim[0]; inp.max = f.lim[1]; }
      }
      inp.id = id; inp.dataset.k = f.k; inp.dataset.t = f.t;
      wrap.appendChild(inp);
      if (f.u) { const u = document.createElement('span'); u.className = 'unit'; u.textContent = f.u; wrap.appendChild(u); }
      if (f.show) { lab.dataset.show = '1'; wrap.dataset.show = '1'; lab._show = f.show; wrap._show = f.show; }
      box.appendChild(lab); box.appendChild(wrap);
      if (f.sl) {
        // Range slider under the field: drag to change the value live (fires the normal change after a short pause).
        const row = document.createElement('div');
        row.className = 'slider-row';
        const rg = document.createElement('input');
        rg.type = 'range'; rg.min = f.sl[0]; rg.max = f.sl[1]; rg.step = f.sl[2]; rg.dataset.kr = f.k; rg.dataset.t = f.t;
        rg.dataset.min0 = f.sl[0]; rg.dataset.max0 = f.sl[1]; rg.dataset.step0 = f.sl[2];
        rg.setAttribute('aria-label', f.l + ' slider');
        let tm;
        rg.addEventListener('input', () => { inp.value = rg.value; clearTimeout(tm); tm = setTimeout(() => inp.dispatchEvent(new Event('change')), 150); });
        row.appendChild(rg);
        if (f.show) { row.dataset.show = '1'; row._show = f.show; }
        box.appendChild(row);
      }
      inp.addEventListener('change', () => {
        let v;
        if (f.t === 'chk') v = inp.checked;
        else if (f.t === 'text' || f.t === 'sel') v = inp.value;
        else if (f.ph != null && inp.value.trim() === '') v = null;
        else { v = Number(inp.value); if (!isFinite(v)) return; if (f.t === PCT) v = v / 100; if (f.t === 'int') v = Math.round(v); }
        if (f.lim && (v < f.lim[0] || v > f.lim[1])) { toast(`${f.l} must be between ${f.lim[0]} and ${f.lim[1]}.`, true); syncForms(P); return; }
        setPath(P, f.k, v);
        syncForms(P);  // same key may appear in several forms; visibility may change
        onChange(f.k);
      });
    });
  });
  syncForms(P);
}

function syncForms(P) {
  $$('.field [data-k]').forEach((inp) => {
    if (document.activeElement === inp) return;
    const v = getPath(P, inp.dataset.k);
    const t = inp.dataset.t;
    if (t === 'chk') inp.checked = !!v;
    else if (t === PCT) inp.value = v == null ? '' : +(v * 100).toFixed(6);
    else inp.value = v == null ? '' : v;
  });
  $$('[data-kr]').forEach((rg) => {
    const v = getPath(P, rg.dataset.kr);
    if (v == null || document.activeElement === rg) return;
    const x = rg.dataset.t === PCT ? v * 100 : v, big = rg.dataset.kr === 'econ.fuel_price' && x > +rg.dataset.max0;   // a diesel price in IDR
    const step = big ? Math.pow(10, Math.floor(Math.log10(3 * x)) - 2) : rg.dataset.step0;
    rg.min = big ? Math.max(+rg.dataset.min0, step) : rg.dataset.min0;   // step base on the grid, as for the what-if slider
    rg.max = big ? 3 * x : rg.dataset.max0;
    rg.step = step;
    rg.value = x;
  });
  $$('[data-show]').forEach((el) => { el.hidden = !el._show(P); });
}
