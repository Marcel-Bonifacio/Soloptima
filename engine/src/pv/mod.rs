//! The PV models of src/pv.{hpp,cpp}: decomposition, clear sky, transposition, horizon and row shading, reflection, rear side,
//! spectrum, temperature, snow, inverter and the hourly loss chain. They give the numbers of the C++ engine to the bit (the
//! fixtures of tests/gen_pv_fixtures.cpp), so every expression keeps the C++ order of operations, and `max`, `min` and
//! `clamp` keep the semantics of std::max, std::min and std::clamp (which differ from f64::max for NaN and signed zeros).
mod optics;
mod pass;
mod profile;
mod rows;
mod sky;

pub use optics::{diffuse_iam, horizon_at, horizon_view, incidence_modifier, inverter_curve, sky_cells, sky_view, SkyCells};
pub use profile::{clearsky_pv_per_kwp, compute_pv_profile, compute_pv_profile_groups, pv_json, pv_reference_basis, tilt_scan,
                  libm_remainder, wind_per_turbine, PvReferenceBasis};
pub use rows::{ground_view, row_view, GroundView, RowView};
pub use sky::clearsky_ghi;

use crate::json::Error;
use crate::model::{month_of_day, Project, HOURS};
use std::f64::consts::PI;

pub(crate) const D2R: f64 = PI / 180.0;
pub(crate) const R2D: f64 = 180.0 / PI;
pub(crate) fn sind(d: f64) -> f64 { (d * D2R).sin() }
pub(crate) fn cosd(d: f64) -> f64 { (d * D2R).cos() }
pub(crate) fn max(a: f64, b: f64) -> f64 { if a < b { b } else { a } }
pub(crate) fn min(a: f64, b: f64) -> f64 { if b < a { b } else { a } }
pub(crate) fn clamp(v: f64, lo: f64, hi: f64) -> f64 { if v < lo { lo } else if hi < v { hi } else { v } }

/// Weather in UTC onto local standard time, UTC offset = n + f with 0 <= f < 1 (no shift for weather already in local time).
/// Local hour L takes f x UTC(L - n - 1) + (1 - f) x UTC(L - n), the exact mean over the local hour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalShift {
    pub n: i32,
    pub f: f64,
}

pub fn local_shift(p: &Project) -> Result<LocalShift, Error> {
    let (n, f) = crate::solar::local_shift(p)?;
    Ok(LocalShift { n, f })
}

/// Adds UTC hour i's value x to the local series v (8760, zeroed first) with the weights of s
pub fn put_local(v: &mut [f64], i: usize, x: f64, s: LocalShift) {
    let h = HOURS as i64;
    let at = |k: i64| (k.rem_euclid(h)) as usize;
    v[at(i as i64 + i64::from(s.n))] += (1.0 - s.f) * x;
    if s.f > 0.0 { v[at(i as i64 + i64::from(s.n) + 1)] += s.f * x; }
}

/// Local month (0-11) of UTC hour i, as the loss chain counts it
pub(crate) fn local_month(i: usize, sh: LocalShift) -> usize {
    let h = HOURS as i64;
    month_of_day(((i as i64 + i64::from(sh.n)).rem_euclid(h) / 24) as i32) as usize
}

/// Energy at each step of the loss chain, kWh per kWp-DC over year 1 (or kWh/m2 for irradiance steps)
#[derive(Debug, Clone, PartialEq)]
pub struct LossStep {
    pub name: String,
    pub value: f64,
    pub irradiance: bool,
}

/// The hourly PV profile and its loss chain (PVProfile of src/pv.hpp)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PVProfile {
    /// 8760, local standard time, kW AC per kWp DC
    pub ac_per_kwp: Vec<f64>,
    /// W/m2 plane-of-array (after shading), local time
    pub poa: Vec<f64>,
    /// deg C, local time
    pub tcell: Vec<f64>,
    /// W/m2, local time
    pub ghi_local: Vec<f64>,
    pub losses: Vec<LossStep>,
    /// kWh/kWp/yr AC
    pub specific_yield: f64,
    pub performance_ratio: f64,
    /// kWh/m2
    pub ghi_annual: f64,
    pub poa_annual: f64,
    /// irradiation on the back of bifacial modules, kWh/m2 (0 for monofacial)
    pub rear_annual: f64,
    /// with detail and objects: the share of each table's beam the objects hide, and the near horizon envelope
    pub table_shade: Vec<f64>,
    pub near_max: Vec<f64>,
    pub near_median: Vec<f64>,
    /// monthly balances by local month (kWh/m2, degC, kWh/kWp)
    pub m_ghi: [f64; 12],
    pub m_dhi: [f64; 12],
    pub m_tamb: [f64; 12],
    pub m_poa: [f64; 12],
    pub m_eff: [f64; 12],
    pub m_dc: [f64; 12],
    pub m_avail: [f64; 12],
}

impl PVProfile {
    pub fn step(&self, name: &str) -> Option<f64> { self.losses.iter().find(|l| l.name == name).map(|l| l.value) }
}
