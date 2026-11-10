//! Project data model parsed from the project JSON (src/model.hpp). Field names, units and defaults are those of the C++ engine.
use serde::{Deserialize, Serialize};

pub const HOURS: usize = 8760;
/// First day of each month of a non-leap year (0-based day of year)
pub const MONTH_START: [i32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
pub fn month_of_day(d: i32) -> i32 { MONTH_START.partition_point(|&s| s <= d) as i32 - 1 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
    /// hours, local standard time = UTC + offset
    pub utc_offset: f64,
    /// m above sea level
    pub elevation: f64,
}

/// Hourly meteorological year; arrays are 8760 long, index 0 = Jan 1 00:00-01:00
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Weather {
    pub is_utc: bool,
    pub time_offset: f64,
    pub ghi: Vec<f64>,
    pub dni: Vec<f64>,
    pub dhi: Vec<f64>,
    pub tamb: Vec<f64>,
    pub wind: Vec<f64>,
    /// snowfall, cm per hour (optional)
    pub snow: Vec<f64>,
    /// relative humidity, % (optional)
    pub rh: Vec<f64>,
    /// the beam irradiance is already blocked by the terrain horizon (PVGIS fetches it so)
    pub horizon_in_beam: bool,
}
impl Default for Weather {
    fn default() -> Self {
        Weather { is_utc: true, time_offset: 0.5, ghi: vec![], dni: vec![], dhi: vec![], tamb: vec![], wind: vec![], snow: vec![], rh: vec![], horizon_in_beam: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PVParams {
    pub capacity_kwp: f64,
    pub module_eff: f64,
    pub gamma_pmax: f64,
    /// relative efficiency loss at 200 W/m2
    pub low_irr_loss_200: f64,
    /// fixed | tracker
    pub mount: String,
    pub tilt: f64,
    /// surface azimuth, degrees clockwise from north (180 = south-facing)
    pub azimuth: f64,
    /// true: face the equator and ignore `azimuth`
    pub azimuth_auto: bool,
    pub gcr: f64,
    pub tracker_axis_azimuth: f64,
    pub tracker_axis_tilt: f64,
    pub tracker_cross_slope: f64,
    pub tracker_max_angle: f64,
    pub backtracking: bool,
    pub row_shading: bool,
    /// linear | blocks
    pub shade_model: String,
    pub bypass_blocks: i32,
    pub modules_up: i32,
    pub portrait: bool,
    pub diffuse_shading: bool,
    pub mount_height: f64,
    pub row_width: f64,
    pub albedo: f64,
    pub albedo_monthly: Vec<f64>,
    /// hay_davies | perez
    pub transposition: String,
    /// erbs | disc | boland
    pub decomposition: String,
    /// haurwitz | ineichen
    pub clearsky: String,
    pub linke_turbidity: f64,
    pub horizon: Vec<f64>,
    /// auto | apply | data
    pub horizon_beam: String,
    pub near_shading: bool,
    pub bifaciality: f64,
    pub rear_loss: f64,
    /// ashrae | martin_ruiz | physical
    pub iam_model: String,
    pub iam_b0: f64,
    pub iam_ar: f64,
    pub iam_n: f64,
    pub iam_kl: f64,
    pub iam_n_ar: f64,
    /// none | monosi | multisi | cigs | cdte | asi
    pub spectral: String,
    pub soiling: f64,
    pub soiling_monthly: Vec<f64>,
    pub snow_monthly: Vec<f64>,
    pub snow_events: Vec<f64>,
    pub snow_rh: f64,
    /// uc_uv (anything but "noct") | noct
    pub thermal_model: String,
    pub noct: f64,
    pub uc: f64,
    pub uv: f64,
    pub absorptance: f64,
    pub mismatch: f64,
    pub dc_wiring: f64,
    pub lid: f64,
    pub module_quality: f64,
    /// annual | stc
    pub dc_wiring_basis: String,
    pub dc_ac_ratio: f64,
    pub inverter_eff: f64,
    pub ac_losses: f64,
    pub availability: f64,
    /// constant | curve
    pub inverter_model: String,
    pub inverter_eff_max: f64,
    pub degradation: f64,
    /// compound | linear
    pub degradation_model: String,
    /// the first and the last row see more sky and open ground (beam, diffuse row shading and the rear side)
    pub edge_rows: bool,
    /// rows of the array when the layout has no tables (0: many rows, none at an edge)
    pub row_count: f64,
    /// shares of the tables with no table in front of them and with none behind them, set for each orientation of the array
    #[serde(skip)]
    pub edge_share: [f64; 2],
    /// slope of the ground under fixed rows (deg) and the azimuth it falls towards (below 0: the way the modules face)
    pub ground_slope: f64,
    pub ground_slope_azimuth: f64,
    /// electrical effect of near shading on the strings: linear | bypass | string | factor, the share of the string effect
    /// for factor, and the modules along a table (from the layout)
    pub near_model: String,
    pub near_factor: f64,
    pub modules_along: i32,
}
impl Default for PVParams {
    fn default() -> Self {
        let s = |x: &str| x.to_string();
        PVParams {
            capacity_kwp: 1000.0, module_eff: 0.22, gamma_pmax: -0.0034, low_irr_loss_200: 0.02, mount: s("fixed"), tilt: 10.0, azimuth: 180.0,
            azimuth_auto: true, gcr: 0.4, tracker_axis_azimuth: 0.0, tracker_axis_tilt: 0.0, tracker_cross_slope: 0.0, tracker_max_angle: 55.0,
            backtracking: true, row_shading: true, shade_model: s("linear"), bypass_blocks: 0, modules_up: 2, portrait: true,
            diffuse_shading: false, mount_height: 1.5, row_width: 4.556, albedo: 0.2, albedo_monthly: vec![], transposition: s("hay_davies"),
            decomposition: s("erbs"), clearsky: s("haurwitz"), linke_turbidity: 0.0, horizon: vec![], horizon_beam: s("auto"), near_shading: true,
            bifaciality: 0.0, rear_loss: 0.05, iam_model: s("ashrae"), iam_b0: 0.05, iam_ar: 0.16, iam_n: 1.526, iam_kl: 0.008, iam_n_ar: 0.0,
            spectral: s("none"), soiling: 0.02, soiling_monthly: vec![], snow_monthly: vec![], snow_events: vec![], snow_rh: 0.8,
            thermal_model: s("uc_uv"), noct: 45.0, uc: 29.0, uv: 0.0, absorptance: 0.9, mismatch: 0.02, dc_wiring: 0.015, lid: 0.015,
            module_quality: 0.0, dc_wiring_basis: s("annual"), dc_ac_ratio: 1.2, inverter_eff: 0.983, ac_losses: 0.015, availability: 0.99,
            inverter_model: s("constant"), inverter_eff_max: 0.99, degradation: 0.005, degradation_model: s("compound"),
            edge_rows: false, row_count: 0.0, edge_share: [0.0, 0.0], ground_slope: 0.0, ground_slope_azimuth: -1.0,
            near_model: s("linear"), near_factor: 1.0, modules_along: 24,
        }
    }
}

/// PV output in project year `y` relative to year 1: (1 - d)^(y-1), or 1 - d (y - 1) for the linear model, not below 0
pub fn pv_degradation_factor(pv: &PVParams, y: i32) -> f64 {
    if pv.degradation_model == "linear" { let x = 1.0 - pv.degradation * f64::from(y - 1); if 0.0 < x { x } else { 0.0 } } else { (1.0 - pv.degradation).powf(f64::from(y - 1)) }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BessParams {
    pub energy_kwh: f64,
    pub power_kw: f64,
    /// AC-AC round-trip
    pub rte: f64,
    pub soc_min: f64,
    pub soc_max: f64,
    pub soc_init: f64,
    /// SOH loss per year
    pub calendar_fade: f64,
    pub cycle_life: f64,
    pub cycle_life_dod: f64,
    pub eol_soh: f64,
    /// replace when SOH falls to this; < 0: at eol_soh
    pub replace_soh: f64,
    pub soh_init: f64,
    pub warranty_efc_yr: f64,
    pub provides_reserve: bool,
    pub reserve_duration_h: f64,
    pub self_discharge: f64,
}
impl Default for BessParams {
    fn default() -> Self {
        BessParams {
            energy_kwh: 0.0, power_kw: 0.0, rte: 0.88, soc_min: 0.10, soc_max: 1.0, soc_init: 0.5, calendar_fade: 0.01, cycle_life: 6000.0,
            cycle_life_dod: 1.0, eol_soh: 0.70, replace_soh: -1.0, soh_init: 1.0, warranty_efc_yr: 0.0, provides_reserve: true,
            reserve_duration_h: 1.0, self_discharge: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindParams {
    pub units: i32,
    pub rated_kw: f64,
    pub v_in: f64,
    pub v_rated: f64,
    pub v_out: f64,
    pub hub_height: f64,
    pub ref_height: f64,
    pub shear_alpha: f64,
    /// cubic | linear
    pub curve: String,
    pub losses: f64,
    pub availability: f64,
}
impl Default for WindParams {
    fn default() -> Self {
        WindParams {
            units: 0, rated_kw: 1500.0, v_in: 3.0, v_rated: 12.0, v_out: 25.0, hub_height: 80.0, ref_height: 10.0, shear_alpha: 1.0 / 7.0,
            curve: "cubic".into(), losses: 0.08, availability: 0.97,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DieselParams {
    pub unit_kw: f64,
    pub units: i32,
    pub min_load: f64,
    pub min_units_online: i32,
    pub reserve_load: f64,
    pub reserve_pv: f64,
    /// load_following | cycle_charging | predictive
    pub strategy: String,
    pub cc_setpoint: f64,
    /// "table": (load fraction, kWh per litre) points | "linear": L/h = intercept * rated kW + slope * output kW
    pub fuel_model: String,
    pub fuel_intercept: f64,
    pub fuel_slope: f64,
    pub fuel_curve: Vec<(f64, f64)>,
    /// Further genset groups beside the one above (a mixed fleet). Empty: N identical units, as before.
    pub more_groups: Vec<GensetGroup>,
    /// ramp limit of the online fleet, % of its rating per minute (0: none), and minutes from start to load (0: at once)
    pub ramp_pct_min: f64,
    pub start_min: f64,
    /// forced outages: per unit and year, mean repair time (h), seed of the draw (rate 0: none)
    pub outage_rate: f64,
    pub repair_h: f64,
    pub outage_seed: i64,
    /// check every step that the loss of the largest online unit is covered (N-1)
    pub n1_check: bool,
}

/// A group of identical gensets of a mixed fleet. Missing costs take those of the main group (the Costs page).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GensetGroup {
    pub name: String,
    pub units: i32,
    pub unit_kw: f64,
    pub min_load: f64,
    /// table | linear, as DieselParams
    pub fuel_model: String,
    pub fuel_intercept: f64,
    pub fuel_slope: f64,
    pub fuel_curve: Vec<(f64, f64)>,
    /// per kW installed, per kWh generated, per unit run-hour
    pub capex_kw: Option<f64>,
    pub om_kwh: Option<f64>,
    pub om_unit_hour: Option<f64>,
}
impl Default for DieselParams {
    fn default() -> Self {
        DieselParams {
            unit_kw: 1000.0, units: 1, min_load: 0.30, min_units_online: 1, reserve_load: 0.10, reserve_pv: 0.50, strategy: "load_following".into(),
            cc_setpoint: 0.80, fuel_model: "table".into(), fuel_intercept: 0.0165, fuel_slope: 0.2423,
            fuel_curve: vec![(0.25, 3.22), (0.30, 3.37), (0.40, 3.60), (0.50, 3.76), (0.60, 3.85), (0.70, 3.92), (0.75, 3.94), (0.80, 3.97),
                             (0.90, 3.98), (1.00, 3.97)],
            more_groups: vec![], ramp_pct_min: 0.0, start_min: 0.0, outage_rate: 0.0, repair_h: 24.0, outage_seed: 1, n1_check: false,
        }
    }
}

/// Connection to a utility grid (optional). Prices are in the project currency of year 1 and escalate with `escalation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridParams {
    pub enabled: bool,
    /// most power drawn from and fed into the grid, kW
    pub import_kw: f64,
    pub export_kw: f64,
    /// flat | tou
    pub tariff: String,
    /// flat import price per kWh
    pub import_price: f64,
    /// time of use: 24 prices by hour of the day (every month) or 288 (12 months of 24 hours, January first)
    pub tou: Vec<f64>,
    /// paid per kWh fed in
    pub export_price: f64,
    /// per kW of the highest import of each month
    pub demand_charge: f64,
    /// per year, on the import price, the export price and the demand charge
    pub escalation: f64,
    /// kg CO2 per kWh imported
    pub co2_kg_per_kwh: f64,
    /// always | pattern | random
    pub availability: String,
    /// pattern: 24 values (hour of the day, every day) or 8760, above 0.5 = grid up
    pub pattern: Vec<f64>,
    /// random: outages per year, their mean length (h) and the seed of the draw
    pub outages_per_year: f64,
    pub outage_hours: f64,
    pub seed: i64,
}
impl Default for GridParams {
    fn default() -> Self {
        GridParams {
            enabled: false, import_kw: 0.0, export_kw: 0.0, tariff: "flat".into(), import_price: 0.10, tou: vec![], export_price: 0.0,
            demand_charge: 0.0, escalation: 0.0, co2_kg_per_kwh: 0.0, availability: "always".into(), pattern: vec![], outages_per_year: 0.0,
            outage_hours: 4.0, seed: 1,
        }
    }
}

/// Forecasters and DP planner for diesel strategy "predictive"
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmsParams {
    pub pv_forecast: String,
    pub load_forecast: String,
    pub noise_sigma: f64,
    pub horizon: i32,
    pub replan: i32,
    pub soc_levels: i32,
    pub terminal_value: f64,
    pub firm_commitment: bool,
    pub voll: f64,
    /// the plan's hour costs depend on the stored energy, so the SOC path can keep reserve energy in the battery
    pub reserve_energy: bool,
}
impl Default for EmsParams {
    fn default() -> Self {
        EmsParams {
            pv_forecast: "smart_persistence".into(), load_forecast: "profile".into(), noise_sigma: 0.15, horizon: 24, replan: 1, soc_levels: 21,
            terminal_value: 0.9, firm_commitment: false, voll: 5.0, reserve_energy: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EconParams {
    pub currency: String,
    pub lifetime: i32,
    pub discount_rate: f64,
    pub om_escalation: f64,
    pub fuel_price: f64,
    pub fuel_escalation: f64,
    pub pv_capex_kwp: f64,
    pub pv_om_kwp: f64,
    pub pv_life: f64,
    pub inverter_replacement_year: i32,
    pub inverter_replacement_kwac: f64,
    pub bess_capex_kwh: f64,
    pub bess_capex_kw: f64,
    pub bess_om_kwh: f64,
    pub bess_replace_kwh: f64,
    pub bess_cost_decline: f64,
    /// 0 when the gensets already exist
    pub diesel_capex_kw: f64,
    pub diesel_om_kwh: f64,
    pub diesel_om_unit_hour: f64,
    pub co2_kg_per_l: f64,
    pub carbon_price_t: f64,
    pub nox_g_per_l: f64,
    pub sox_g_per_l: f64,
    pub wind_capex_kw: f64,
    pub wind_om_kw: f64,
    pub wind_life: f64,
    pub jobs_pv_per_mw: f64,
    pub jobs_wind_per_mw: f64,
    pub jobs_bess_per_mwh: f64,
    /// 0 = do not compute HDI
    pub population: f64,
    pub other_capex_frac: f64,
}
impl Default for EconParams {
    fn default() -> Self {
        EconParams {
            currency: "USD".into(), lifetime: 25, discount_rate: 0.08, om_escalation: 0.02, fuel_price: 1.0, fuel_escalation: 0.02, pv_capex_kwp: 600.0,
            pv_om_kwp: 10.0, pv_life: 25.0, inverter_replacement_year: 12, inverter_replacement_kwac: 40.0, bess_capex_kwh: 220.0, bess_capex_kw: 80.0,
            bess_om_kwh: 4.0, bess_replace_kwh: 150.0, bess_cost_decline: 0.03, diesel_capex_kw: 0.0, diesel_om_kwh: 0.01, diesel_om_unit_hour: 2.0,
            co2_kg_per_l: 2.68, carbon_price_t: 0.0, nox_g_per_l: 35.0, sox_g_per_l: 0.8, wind_capex_kw: 1400.0, wind_om_kw: 40.0, wind_life: 20.0,
            jobs_pv_per_mw: 2.70, jobs_wind_per_mw: 1.10, jobs_bess_per_mwh: 0.01, population: 0.0, other_capex_frac: 0.0,
        }
    }
}

/// Auxiliary and standby loads (kW), served like the site load every hour
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuxParams {
    pub bess_kw_per_mwh: f64,
    pub bess_temp_coeff: f64,
    pub ref_c: f64,
    pub plant_kw: f64,
    pub trafo_noload_kw: f64,
    pub bess_trafo_noload_kw: f64,
    pub pcs_kw_per_mw: f64,
}
impl Default for AuxParams {
    fn default() -> Self {
        AuxParams { bess_kw_per_mwh: 0.0, bess_temp_coeff: 0.0, ref_c: 25.0, plant_kw: 0.0, trafo_noload_kw: 0.0, bess_trafo_noload_kw: 0.0, pcs_kw_per_mw: 0.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimOptions {
    /// simulate every project year (degradation, load growth)
    pub all_years: bool,
    pub load_growth: f64,
    /// dispatch time step: 60, 30 or 15 minutes
    pub step_min: i32,
    /// hourly series (PV, wind, auxiliaries, a load without finer data) in a shorter step: hold | interpolate
    pub subhourly: String,
}
impl Default for SimOptions {
    fn default() -> Self { SimOptions { all_years: true, load_growth: 0.0, step_min: 60, subhourly: "hold".into() } }
}

impl SimOptions {
    /// time steps per hour
    pub fn steps_per_hour(&self) -> usize { if self.step_min == 15 { 4 } else if self.step_min == 30 { 2 } else { 1 } }
}

/// Metres east (x) and north (y) of the site location
pub type PlanPoint = [f64; 2];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutArea {
    pub pts: Vec<PlanPoint>,
    /// height of the surface the tables stand on (a roof) above the ground, m
    pub base: f64,
    /// own orientation of fixed tables; NaN: the project's
    pub tilt: f64,
    pub azimuth: f64,
    /// tables in back-to-back pairs facing azimuth and azimuth + 180
    pub east_west: bool,
    /// tables side by side in one plane: no row shading, diffuse row shading or rear-side gain
    pub canopy: bool,
    /// slope of the ground under fixed rows (deg) and the azimuth it falls towards (NaN: the way the tables face)
    pub slope: f64,
    pub slope_azimuth: f64,
}
impl Default for LayoutArea {
    fn default() -> Self {
        LayoutArea { pts: vec![], base: 0.0, tilt: f64::NAN, azimuth: f64::NAN, east_west: false, canopy: false, slope: 0.0, slope_azimuth: f64::NAN }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Obstacle {
    pub pts: Vec<PlanPoint>,
    /// top above the ground, m
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SiteLayout {
    pub areas: Vec<LayoutArea>,
    pub obstacles: Vec<Obstacle>,
    /// corners: [0]-[1] the upper edge, [3]-[2] the lower edge below them
    pub tables: Vec<[PlanPoint; 4]>,
    /// the area each table was filled into (index in areas); empty: unknown
    pub table_area: Vec<i32>,
    /// per object: empty for a solid one, or the share of the beam its crown passes in each local month
    pub transmission: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub loc: Location,
    pub wx: Weather,
    /// 8760, local standard time
    pub load_kw: Vec<f64>,
    /// the load at the dispatch step when it was given finer than hourly (8760 x steps per hour), else empty
    pub load_sub: Vec<f64>,
    pub pv: PVParams,
    pub bess: BessParams,
    pub wind: WindParams,
    pub dg: DieselParams,
    pub grid: GridParams,
    pub ems: EmsParams,
    pub econ: EconParams,
    pub aux: AuxParams,
    pub sim: SimOptions,
    pub layout: SiteLayout,
}
