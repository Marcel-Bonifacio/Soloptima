import { TORNADO_VARS } from './consts.js';
import { defaultLibrary } from '../equip/library.js';
// The default project (docs/ui.md).
export function defaultProject() {
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
    // of a measured load (ui/src/lib/tsimport.svelte.js). P.weather keeps the same two for its own data.
    load: {
      kw: null, growth: 0, template: 'continuous', source: 'synthetic',
      daily: new Array(24).fill(1000), monthly: new Array(12).fill(1),
      target_avg: 0, weekend_factor: 1, var_day: 0.03, var_hour: 0.02, seed: 1, import: null, qc: null,
    },
    pv: {
      thermal_model: 'uc_uv', noct: 45,
      capacity_kwp: 1000, module_wp: 600, module_eff: 0.22, module_length: 2.278, module_width: 1.134,
      gamma_pmax: -0.0034, low_irr_loss_200: 0.02, mount: 'fixed', mount_style: 'open', tilt: 10, azimuth_auto: true, azimuth: 180,
      gcr: 0.45, tracker_axis_azimuth: 0, tracker_max_angle: 55, backtracking: true, row_shading: true, albedo: 0.2,
      // projects saved before these inputs get the earlier models in migrate(): Hay-Davies, beam-only and linear row shading,
      // Erbs, Haurwitz, ASHRAE IAM, a constant inverter efficiency and compound degradation
      transposition: 'perez', diffuse_shading: true, mount_height: 1.5, bifaciality: 0, rear_loss: 0.05, soiling_monthly: null,
      decomposition: 'disc', clearsky: 'ineichen', linke_turbidity: null, horizon: null, horizon_beam: 'auto', albedo_monthly: null,
      tracker_axis_tilt: 0, tracker_cross_slope: 0, shade_model: 'blocks', bypass_blocks: null, spectral: 'none', near_shading: true,
      iam_model: 'martin_ruiz', iam_ar: 0.16, iam_n: 1.526, iam_kl: 0.008, iam_n_ar: 0,
      snow_monthly: null, snow_events: null, snow_rh: 0.8, inverter_model: 'curve', inverter_eff_max: 0.99, degradation_model: 'linear',
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
    variants: [],   // design variants: [{id, name, overrides: {dotted path: value}}], compared on the Design variants page
    report: { imagery: true, figures: [] },   // report figures: satellite image under the layout drawing, and images supplied by the user
    layout: { polygons: [], orientation: 'portrait', modules_across: 2, modules_per_table: 28, table_gap: 0.5, setback: 10,
              aisle_every: null, aisle_width: 4, removed: [], max_table_shade: null, shade_free_from: 9, shade_free_to: 15, google_key: '', result: null },
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
