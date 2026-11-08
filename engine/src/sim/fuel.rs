//! Genset fuel model shared by the dispatch and the EMS planner (src/fuel.hpp).
use crate::{DieselParams, Error};

/// Fuel use per unit as L/h per kW rated, tabulated over load fraction 0..1 for fast lookup
#[derive(Debug, Clone)]
pub struct FuelTable {
    rate: [f64; 101],
}

impl FuelTable {
    pub fn new(d: &DieselParams) -> Result<FuelTable, Error> {
        let mut rate = [0.0; 101];
        if d.fuel_model == "linear" {
            for (k, r) in rate.iter_mut().enumerate() { *r = super::mx(0.0, d.fuel_intercept + d.fuel_slope * (k as f64 / 100.0)); }
            return Ok(FuelTable { rate });
        }
        if d.fuel_curve.len() < 2 { return Err(Error("Fuel curve needs at least 2 points.".into())); }
        // Interpolate L/h (not kWh/L): fuel rate is near-linear in load, efficiency is not.
        let mut pts: Vec<(f64, f64)> = d.fuel_curve.iter().map(|&(lf, eff)| (lf, lf / eff)).collect();
        pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        for (k, r) in rate.iter_mut().enumerate() {
            let x = k as f64 / 100.0;
            let mut j = 1;
            while j + 1 < pts.len() && x > pts[j].0 { j += 1; }
            let (x0, y0) = pts[j - 1];
            let (x1, y1) = pts[j];
            let y = if x1 > x0 { y0 + (y1 - y0) * (x - x0) / (x1 - x0) } else { y0 };
            *r = super::mx(0.0, y);
        }
        Ok(FuelTable { rate })
    }

    /// L/h per kW rated at load fraction `lf` (clamped to 0..1, NaN as 0)
    pub fn at(&self, lf: f64) -> f64 {
        let lf = if lf.is_nan() { 0.0 } else { super::clamp(lf, 0.0, 1.0) * 100.0 };
        let k = super::mn(99, lf as i32) as usize;
        let f = lf - k as f64;
        self.rate[k] + (self.rate[k + 1] - self.rate[k]) * f
    }
}
