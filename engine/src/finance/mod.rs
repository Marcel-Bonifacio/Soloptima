//! Project finance: annual after-tax cash flow built on the simulated yearly energy and cost flows of the hybrid and of the
//! diesel-only baseline (src/finance.cpp). Structures: host-owned (`host`), single owner / IPP selling renewable kWh under a PPA
//! (`ppa`), third-party ownership with the host's savings versus diesel only (`tpo`). Mechanics: construction period with
//! interest during construction, soft costs, debt by gearing and/or DSCR sculpting, equal / annuity / sculpted repayment, DSRA,
//! depreciation by asset class, loss carry-forward, tax holiday, withholding tax, Art. 31E, working capital, take-or-pay,
//! deemed energy, shortfall penalty, staged tariffs with indexation, tariff solving for a target IRR.
//!
//! The finance reads the few numbers it needs from `FinSim`, which a simulation result converts into (`SimResult::fin_sim`).
mod cashflow;
mod compute;
mod params;
mod report;

pub use cashflow::{irr, npv, payback};
pub use params::{parse_finance, FinanceParams, TariffComponent};
pub use report::run_finance;

/// What the finance takes from one simulated project year (nominal cash flows: positive = cost)
#[derive(Debug, Clone, Default)]
pub struct FinYear {
    /// energy served to the site load, and the renewable share of it
    pub served_site: f64,
    pub re_fraction: f64,
    pub pv_curtailed: f64,
    pub wind_curtailed: f64,
    pub gen_kwh: f64,
    pub c_fuel: f64,
    pub c_om_dg: f64,
    pub c_om_new: f64,
    pub c_carbon: f64,
    pub c_replace: f64,
    pub c_salvage: f64,
}

/// A simulation as far as the finance reads it: the years and the capex of the new assets
#[derive(Debug, Clone, Default)]
pub struct FinSim {
    pub years: Vec<FinYear>,
    pub capex_pv: f64,
    pub capex_bess: f64,
    pub capex_wind: f64,
    pub capex_other: f64,
}
