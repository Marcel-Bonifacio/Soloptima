//! Simulation results (SimResult and its parts in src/sim.hpp)
use crate::finance::{FinSim, FinYear};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Sizing {
    pub pv_kwp: f64,
    pub bess_kwh: f64,
    pub bess_kw: f64,
    pub wind_units: f64,
}

/// Year-1 time series, kW (= kWh per hour); load includes aux. Also the hour-ahead and day-ahead forecasts and the EMS SOC target.
#[derive(Debug, Clone, Default)]
pub struct Hourly {
    pub load: Vec<f64>, pub aux: Vec<f64>, pub pv_avail: Vec<f64>, pub pv_to_load: Vec<f64>, pub pv_to_bess: Vec<f64>,
    pub pv_curtailed: Vec<f64>, pub bess_dis: Vec<f64>, pub gen_to_bess: Vec<f64>, pub gen_to_load: Vec<f64>, pub gen_dump: Vec<f64>,
    pub gen_units: Vec<f64>, pub fuel_l: Vec<f64>, pub unmet: Vec<f64>, pub soc: Vec<f64>, pub wind_avail: Vec<f64>,
    pub wind_to_load: Vec<f64>, pub wind_to_bess: Vec<f64>, pub wind_curtailed: Vec<f64>,
    pub pv_fc_h1: Vec<f64>, pub load_fc_h1: Vec<f64>, pub pv_fc_da: Vec<f64>, pub load_fc_da: Vec<f64>, pub soc_target: Vec<f64>,
    /// with a grid connection only (empty otherwise): import to the load, export of PV and wind surplus, 1 while the grid is up
    pub grid_import: Vec<f64>, pub grid_export: Vec<f64>, pub grid_up: Vec<f64>,
}

/// One genset group of a mixed fleet in a project year (its units share the output at the fleet's loading)
#[derive(Debug, Clone, Default)]
pub struct GroupYear {
    /// index in the project's list (0 = the main group)
    pub index: usize,
    pub unit_hours: f64, pub gen_kwh: f64, pub fuel_l: f64, pub starts: f64,
    /// O&M of the group (per kWh and per run-hour, escalated)
    pub c_om: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ForecastStats {
    /// MAE / mean actual
    pub pv_nmae_h1: f64, pub pv_nmae_da: f64, pub load_nmae_h1: f64, pub load_nmae_da: f64,
    /// mean error / mean actual
    pub pv_bias_da: f64, pub load_bias_da: f64,
    /// sum |actual net load - forecast net load| (predictive EMS)
    pub net_error_kwh: f64,
    /// part of that absorbed by deviating the battery from plan
    pub bess_compensation_kwh: f64,
    pub plans: i64,
}

/// One project year. Energy in kWh; load includes the auxiliary load aux. Nominal cash flows (positive = cost).
#[derive(Debug, Clone, Default)]
pub struct YearResult {
    pub year: i32,
    pub load: f64, pub served: f64, pub unmet: f64,
    /// auxiliary consumption; energy served to the site load (served - aux)
    pub aux: f64, pub served_site: f64,
    pub pv_avail: f64, pub pv_to_load: f64, pub pv_to_bess: f64, pub pv_curtailed: f64,
    /// bess_soh at the start of the year (set by `simulate`), bess_efc = AC discharge / nameplate
    pub bess_dis: f64, pub bess_ch: f64, pub bess_soh: f64, pub bess_efc: f64,
    /// discharge at the cells (AC / one-way efficiency) / nameplate
    pub bess_efc_dc: f64,
    /// SOH lost to calendar and cycle fade; peak power / nameplate kWh
    pub soh_loss_cal: f64, pub soh_loss_cyc: f64, pub max_c_rate: f64,
    pub bess_replaced: bool,
    pub gen_kwh: f64, pub gen_to_load: f64, pub gen_dump: f64, pub fuel_l: f64, pub unit_hours: f64, pub starts: f64, pub max_unmet_kw: f64,
    pub gen_to_bess: f64, pub wind_to_load: f64, pub wind_to_bess: f64,
    /// Stored energy (kWh) at the start of the year (after the SOC window of the year is applied) and at its end. Battery
    /// conversion losses = bess_ch - bess_dis - self_discharge - (e_end - e_start).
    pub e_start: f64, pub e_end: f64,
    pub re_fraction: f64, pub co2_t: f64, pub nox_t: f64, pub sox_t: f64,
    /// Loss of load: unmet > 0.1 % of the hour's load; events are runs of such hours.
    pub lol_h: f64, pub lol_events: f64, pub lol_max_h: f64,
    /// spinning reserve left after allocation below the requirement
    pub reserve_short_h: f64, pub reserve_short_max_kw: f64,
    /// most gensets online; hours with the whole fleet online
    pub max_units: f64, pub fleet_full_h: f64,
    /// hours with every online genset at minimum loading; longest run
    pub minload_h: f64, pub minload_run_max_h: f64,
    /// most gensets started in one hour
    pub max_starts_h: f64,
    pub wind_avail: f64, pub wind_used: f64, pub wind_curtailed: f64, pub self_discharge: f64,
    /// sum of PV+wind available, sum of min(load, PV+wind)
    pub re_avail: f64, pub re_direct: f64,
    pub c_fuel: f64, pub c_om: f64, pub c_replace: f64, pub c_carbon: f64, pub c_salvage: f64, pub c_total: f64,
    /// O&M split: new assets (PV, BESS, wind) vs diesel fleet
    pub c_om_new: f64, pub c_om_dg: f64,
    /// Grid connection (zero without one): energy imported to the load and exported (with its PV and wind parts), hours
    /// up, outages, the highest import of the year and of each month (kW)
    pub grid_import: f64, pub grid_export: f64, pub pv_to_grid: f64, pub wind_to_grid: f64, pub grid_up_h: f64, pub grid_outages: f64,
    pub grid_peak_kw: f64, pub grid_month_peak: [f64; 12],
    /// imports valued at the year-1 tariff (time of use), escalated by `economics`
    pub grid_import_val: f64,
    /// grid energy, demand charges, export revenue (a positive number) and the net grid cost, also in c_total
    pub c_grid_import: f64, pub c_grid_demand: f64, pub c_grid_export: f64, pub c_grid: f64,
    /// each genset group of a mixed fleet in merit order (empty for one group)
    pub groups: Vec<GroupYear>,
    /// hours in which the ramp limit or the start time held genset output below what was asked (with either set)
    pub ramp_limited_h: f64,
    /// forced outages of genset units and the unit-hours they were out (with an outage rate)
    pub unit_outages: f64, pub unit_outage_h: f64,
    /// hours in which the loss of the largest online unit was not covered by the rest, and the largest gap (with the N-1 check)
    pub n1_short_h: f64, pub n1_short_max_kw: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Economics {
    pub capex_pv: f64, pub capex_bess: f64, pub capex_wind: f64, pub capex_diesel: f64, pub capex_other: f64, pub capex_total: f64,
    /// capital recovery factor, total annualised cost, TAC / served energy
    pub crf: f64, pub tac: f64, pub coe: f64,
    pub npc: f64, pub lcoe: f64,
}

/// Indicators from the studied literature (year 1): reliability, self-sufficiency, environment, social
#[derive(Debug, Clone)]
pub struct Metrics {
    pub lpsp: f64, pub ssci: f64, pub sssi: f64, pub rep: f64, pub excess_kwh: f64, pub excess_fraction: f64,
    pub co2_t: f64, pub nox_kg: f64, pub sox_kg: f64, pub jobs: f64,
    /// < 0: not computed (no population)
    pub hdi: f64,
}
impl Default for Metrics {
    fn default() -> Self {
        Metrics { lpsp: 0.0, ssci: 0.0, sssi: 0.0, rep: 0.0, excess_kwh: 0.0, excess_fraction: 0.0, co2_t: 0.0, nox_kg: 0.0, sox_kg: 0.0, jobs: 0.0, hdi: -1.0 }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SimResult {
    pub size: Sizing,
    pub years: Vec<YearResult>,
    pub econ: Economics,
    /// filled only when the simulation keeps the hourly series
    pub hourly: Option<Hourly>,
    /// headline (year 1 unless stated)
    pub re_fraction: f64, pub unmet_fraction: f64, pub curtail_fraction: f64, pub fuel_l_y1: f64, pub avg_gen_load: f64,
    /// highest unmet / load of any project year (load growth)
    pub unmet_fraction_max: f64,
    pub bess_replacements: i32,
    pub fc: ForecastStats,
    pub metrics: Metrics,
    /// the project has a grid connection (the grid figures are written only then)
    pub has_grid: bool,
    /// a mixed fleet's groups in merit order: (index in the project's list, units, unit kW, minimum loading); empty for one group
    pub fleet: Vec<(usize, i32, f64, f64)>,
    /// dispatch step in minutes; below 60 `hourly` holds hourly means and `steps` the series of every step (year 1)
    pub step_min: i32,
    pub steps: Option<Hourly>,
    /// the figures written only when used: ramp limits or start time, forced outages, the N-1 check
    pub ramps: bool, pub unit_outages: bool, pub n1: bool,
}

/// A hybrid system against a reference: the diesel-only baseline, or PV only (same PV and wind, no battery) for the
/// battery's own value. Capex, fuel, O&M, replacements and salvage all enter the incremental cash flow.
#[derive(Debug, Clone, Default)]
pub struct Comparison {
    pub npv_savings: f64,
    /// None when the incremental cash flow has no IRR (or no investment)
    pub irr: Option<f64>,
    /// -1: never
    pub payback_years: f64,
    pub fuel_saved_l_y1: f64,
    pub co2_saved_t_y1: f64,
    pub lcoe_base: f64,
}

impl SimResult {
    /// The years and new-asset capex as the project finance reads them
    pub fn fin_sim(&self) -> FinSim {
        FinSim {
            years: self.years.iter().map(|y| FinYear {
                served_site: y.served_site, re_fraction: y.re_fraction, pv_curtailed: y.pv_curtailed, wind_curtailed: y.wind_curtailed,
                // With a grid the conventional supply is grid + gensets: the finance reads gen_kwh and c_om_dg only as the
                // energy and running cost of that supply (the host's running cost, and the avoided cost per kWh of a tariff at a
                // discount to it), so grid imports and the net grid cost go there.
                gen_kwh: if self.has_grid { y.gen_kwh + y.grid_import } else { y.gen_kwh },
                c_fuel: y.c_fuel,
                c_om_dg: if self.has_grid { y.c_om_dg + y.c_grid } else { y.c_om_dg },
                c_om_new: y.c_om_new,
                c_carbon: y.c_carbon,
                c_replace: y.c_replace, c_salvage: y.c_salvage,
            }).collect(),
            capex_pv: self.econ.capex_pv,
            capex_bess: self.econ.capex_bess,
            capex_wind: self.econ.capex_wind,
            capex_other: self.econ.capex_other,
        }
    }
}
