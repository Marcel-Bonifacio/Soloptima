//! Chronological hourly dispatch of PV + wind + battery + diesel fleet over the project life, battery ageing, fuel and the
//! lifecycle economics (src/sim.{hpp,cpp}, src/fuel.hpp and the planner of src/ems.cpp). Strategies: load following, cycle
//! charging and predictive (forecast-based EMS).
//!
//! The PV and wind output come in as plain hourly series (`SimInput`), so the PV port plugs in without the simulation
//! knowing its types; the forecasts of the predictive EMS are a `Forecast`, by default the `forecast::Forecaster` of `p.ems`.
mod dispatch;
mod econ;
mod forecast;
mod fuel;
mod out;
mod planner;
mod types;

pub use dispatch::simulate;
pub use econ::compare;
pub use forecast::{Forecast, PerfectForecast};
pub(crate) use forecast::wrap as forecast_wrap;
pub use fuel::FuelTable;
pub use out::{comparison_to_json, result_to_json};
pub use planner::{plan_input, reserve_cap, reserve_cap_step, PlanInput, Planner};
pub use types::*;

use crate::Project;

/// What the simulation takes besides the project and the sizing
#[derive(Clone, Copy)]
pub struct SimInput<'a> {
    /// AC output per kWp of every hour (8760, local standard time)
    pub pv_per_kwp: &'a [f64],
    /// clear-sky AC output per kWp (8760), the reference of the PV forecasters; empty: pv_per_kwp
    pub pv_cs_per_kwp: &'a [f64],
    /// output per wind turbine (8760); may be empty without turbines
    pub wind_per_turbine: &'a [f64],
    /// forecasts for the predictive strategy and the year-1 forecast skill, shared across runs; None: built from `p.ems`
    pub forecast: Option<&'a dyn Forecast>,
}

// std::min, std::max and std::clamp as the C++ engine evaluates them (argument order matters for signed zeros and NaN).
pub(crate) fn mn<T: PartialOrd>(a: T, b: T) -> T { if b < a { b } else { a } }
pub(crate) fn mx<T: PartialOrd>(a: T, b: T) -> T { if a < b { b } else { a } }
pub(crate) fn clamp<T: PartialOrd>(v: T, lo: T, hi: T) -> T { if v < lo { lo } else if hi < v { hi } else { v } }

/// Auxiliary load (kW) at ambient temperature tamb: battery HVAC and BMS (with a battery), plus plant auxiliaries (with PV,
/// wind or a battery) and the no-load loss of the PV step-up transformers (with PV) and the BESS ones (with a battery).
pub fn aux_kw(p: &Project, s: &Sizing, tamb: f64) -> f64 {
    let a = &p.aux;
    let has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    // HVAC/BMS by nameplate energy, PCS no-load by PCS rating. The PCS part counts in every hour, also with battery flow
    // (the aux array feeds unit commitment before dispatch), so there it overlaps slightly with the round-trip efficiency.
    let bess = if has_bess {
        s.bess_kwh / 1000.0 * a.bess_kw_per_mwh * (1.0 + a.bess_temp_coeff * mx(0.0, tamb - a.ref_c)) + s.bess_kw / 1000.0 * a.pcs_kw_per_mw
    } else { 0.0 };
    // Plant auxiliaries with any new asset; each step-up transformer's no-load only with the asset it serves.
    let has_pv = s.pv_kwp > 0.0;
    let plant_on = has_pv || has_bess || s.wind_units > 0.5;
    let plant = (if plant_on { a.plant_kw } else { 0.0 }) + (if has_pv { a.trafo_noload_kw } else { 0.0 })
        + (if has_bess { a.bess_trafo_noload_kw } else { 0.0 });
    bess + plant
}
