//! Results of a simulation (SimResult and its parts in src/sim.hpp)
use crate::finance::{FinSim, FinYear};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Sizing {
    pub pv_kwp: f64,
    pub bess_kwh: f64,
    pub bess_kw: f64,
    pub wind_units: f64,
}

/// Year-1 time series, kW (= kWh per hour); load includes the auxiliary load aux. Forecasts (hour-ahead and day-ahead)
/// and the EMS state-of-charge target.
#[derive(Debug, Clone, Default)]
pub struct Hourly {
    pub load: Vec<f64>, pub aux: Vec<f64>, pub pv_avail: Vec<f64>, pub pv_to_load: Vec<f64>, pub pv_to_bess: Vec<f64>,
    pub pv_curtailed: Vec<f64>, pub bess_dis: Vec<f64>, pub gen_to_bess: Vec<f64>, pub gen_to_load: Vec<f64>, pub gen_dump: Vec<f64>,
    pub gen_units: Vec<f64>, pub fuel_l: Vec<f64>, pub unmet: Vec<f64>, pub soc: Vec<f64>, pub wind_avail: Vec<f64>,
    pub wind_to_load: Vec<f64>, pub wind_to_bess: Vec<f64>, pub wind_curtailed: Vec<f64>,
    pub pv_fc_h1: Vec<f64>, pub load_fc_h1: Vec<f64>, pub pv_fc_da: Vec<f64>, pub load_fc_da: Vec<f64>, pub soc_target: Vec<f64>,
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
                gen_kwh: y.gen_kwh, c_fuel: y.c_fuel, c_om_dg: y.c_om_dg, c_om_new: y.c_om_new, c_carbon: y.c_carbon,
                c_replace: y.c_replace, c_salvage: y.c_salvage,
            }).collect(),
            capex_pv: self.econ.capex_pv,
            capex_bess: self.econ.capex_bess,
            capex_wind: self.econ.capex_wind,
            capex_other: self.econ.capex_other,
        }
    }
}
