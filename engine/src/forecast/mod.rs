//! PV, load and wind forecasting for the predictive EMS and the Forecast Lab (src/forecast.{hpp,cpp}). Several methods behind
//! one interface, all causal. Most methods work on a normalised index y = actual / reference (PV: clear-sky output, so y is
//! the clear-sky index; load: mean load) and forecast y_hat(tgt) x reference(tgt).
mod mlp;
pub(crate) mod rng;
mod series;

pub use series::SeriesForecaster;

use crate::sim::Forecast;
use crate::EmsParams;

/// A forecasting method as the interface lists it
#[derive(Debug, Clone, Copy)]
pub struct MethodInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

const fn mi(id: &'static str, name: &'static str, description: &'static str) -> MethodInfo { MethodInfo { id, name, description } }

pub fn pv_forecast_methods() -> &'static [MethodInfo] {
    const M: [MethodInfo; 10] = [
        mi("smart_persistence", "Smart persistence", "Clear-sky output x clear-sky index of the last 3 h (short lead) blended into the last 24 h."),
        mi("persistence", "Persistence (same hour yesterday)", "Value at the same hour on the last observed day; reference for the skill score."),
        mi("climatology", "30-day climatology", "Clear-sky output x mean clear-sky index of that hour over the last 30 days."),
        mi("ets", "Exponential smoothing", "Exponentially smoothed clear-sky index per hour of day, plus a decaying correction from the latest hour."),
        mi("rls", "Adaptive regression (RLS)", "Lead-specific linear model on recent, daily, persistence, climatology and smoothed indices; coefficients learnt online by recursive least squares."),
        mi("analog", "Analog ensemble (k-NN)", "Finds the 7 past days whose last-24-h pattern best matches now and averages what followed."),
        mi("ensemble", "Adaptive ensemble", "Blend of smart persistence, climatology, smoothing, regression and analog forecasts, weighted by each method's error over the last 14 days (separately intraday / day-ahead)."),
        mi("mlp", "Neural network (MLP)", "Feed-forward network (10-16-16-1, ReLU, Adam) on lagged clear-sky indices, lead time and calendar; retrained every month on the preceding 330 days only."),
        mi("perfect", "Perfect forecast (benchmark)", "Uses the actual future: the upper bound for any forecaster."),
        mi("noisy", "Perfect + random error", "Actual values with correlated relative error: standard deviation sigma from 24 h lead, 0.3 sigma at lead 0. For robustness tests."),
    ];
    &M
}

pub fn load_forecast_methods() -> &'static [MethodInfo] {
    const M: [MethodInfo; 11] = [
        mi("profile", "7-day profile + persistence", "Mean of the same hour over the last 7 days, corrected by the latest observed deviation."),
        mi("persistence", "Persistence (same hour yesterday)", "Value at the same hour on the last observed day; reference for the skill score."),
        mi("weekly", "Seasonal naive (same hour last week)", "Captures weekday / weekend patterns."),
        mi("climatology", "30-day climatology", "Mean of that hour over the last 30 days."),
        mi("ets", "Exponential smoothing", "Smoothed level per hour of day plus a decaying correction from the latest hour."),
        mi("rls", "Adaptive regression (RLS)", "Lead-specific linear model learnt online by recursive least squares."),
        mi("analog", "Analog ensemble (k-NN)", "Averages what followed the 7 most similar past days."),
        mi("ensemble", "Adaptive ensemble", "Error-weighted blend of profile, weekly, smoothing, regression and analog forecasts."),
        mi("mlp", "Neural network (MLP)", "Feed-forward network (10-16-16-1, ReLU, Adam) on lagged load, lead time and calendar; retrained monthly on past data only."),
        mi("perfect", "Perfect forecast (benchmark)", "Uses the actual future."),
        mi("noisy", "Perfect + random error", "Actual values with correlated relative error: standard deviation sigma from 24 h lead, 0.3 sigma at lead 0. For robustness tests."),
    ];
    &M
}

/// The PV, load and wind forecasters of the EMS (Forecaster in src/forecast.hpp)
pub struct Forecaster {
    pv: SeriesForecaster,
    load: SeriesForecaster,
    wind: Option<SeriesForecaster>,
}

impl Forecaster {
    /// pv_act: actual AC output per kWp; pv_cs: clear-sky output per kWp (the reference); load: kW; wind: output per turbine
    /// (empty or all zero without turbines)
    pub fn new(m: &EmsParams, pv_act: &[f64], pv_cs: &[f64], load: &[f64], wind: &[f64]) -> Forecaster {
        // Wind has no deterministic daily shape: exponential smoothing with short-lead persistence (or perfect).
        let wind = if wind.iter().any(|&x| x > 0.0) {
            Some(SeriesForecaster::new(if m.pv_forecast == "perfect" { "perfect" } else { "ets" }, wind, &[], m.noise_sigma, 24680))
        } else { None };
        Forecaster {
            pv: SeriesForecaster::new(&m.pv_forecast, pv_act, pv_cs, m.noise_sigma, 12345),
            load: SeriesForecaster::new(&m.load_forecast, load, &[], m.noise_sigma, 67890),
            wind,
        }
    }
}

impl Forecast for Forecaster {
    fn pv(&self, issue: i32, tgt: i32) -> f64 { self.pv.at(issue, tgt) }
    fn load(&self, issue: i32, tgt: i32) -> f64 { self.load.at(issue, tgt) }
    fn wind(&self, issue: i32, tgt: i32) -> f64 { self.wind.as_ref().map_or(0.0, |w| w.at(issue, tgt)) }
}
