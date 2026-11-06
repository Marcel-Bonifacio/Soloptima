//! The forecasts the predictive EMS plans on, and the year-1 forecast skill. The forecasting methods themselves
//! (src/forecast.cpp) are ported in session 2.11; until then the simulation takes any `Forecast`, and `PerfectForecast` is the
//! C++ "perfect" method (the actual future).
use crate::HOURS;

/// PV, load and wind forecasts issued at hour `issue` for hour `tgt` (both may run past the year, which is cyclic)
pub trait Forecast {
    /// kW per kWp
    fn pv(&self, issue: i32, tgt: i32) -> f64;
    /// kW (base year)
    fn load(&self, issue: i32, tgt: i32) -> f64;
    /// kW per turbine
    fn wind(&self, issue: i32, tgt: i32) -> f64;
}

pub(crate) fn wrap(t: i32) -> usize { t.rem_euclid(HOURS as i32) as usize }

/// The actual values of the target hour. Wind is forecast only when some hour has wind output, as in the C++ Forecaster.
#[derive(Debug, Clone)]
pub struct PerfectForecast {
    pv: Vec<f64>,
    load: Vec<f64>,
    wind: Vec<f64>,
}

impl PerfectForecast {
    pub fn new(pv_per_kwp: &[f64], load_kw: &[f64], wind_per_turbine: &[f64]) -> PerfectForecast {
        let wind = if wind_per_turbine.iter().any(|&x| x > 0.0) { wind_per_turbine.to_vec() } else { Vec::new() };
        PerfectForecast { pv: pv_per_kwp.to_vec(), load: load_kw.to_vec(), wind }
    }
}

impl Forecast for PerfectForecast {
    fn pv(&self, _issue: i32, tgt: i32) -> f64 { self.pv[wrap(tgt)] }
    fn load(&self, _issue: i32, tgt: i32) -> f64 { self.load[wrap(tgt)] }
    fn wind(&self, _issue: i32, tgt: i32) -> f64 { if self.wind.is_empty() { 0.0 } else { self.wind[wrap(tgt)] } }
}
