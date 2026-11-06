//! The sky: air mass, decomposition of GHI (Erbs, DISC, Boland), the Perez coefficients, the Ineichen clear sky with the
//! Linke turbidity from the weather, the PVSPEC spectral factor and the monthly snow loss of Townsend.
use super::{clamp, cosd, local_month, local_shift, max, min, sind, D2R};
use crate::json::Error;
use crate::model::{PVParams, Project, HOURS, MONTH_START};
use crate::solar::{haurwitz_ghi, sun_at};

pub(crate) fn erbs_diffuse_fraction(kt: f64) -> f64 {
    if kt <= 0.22 { return 1.0 - 0.09 * kt; }
    if kt <= 0.80 { return 0.9511 - 0.1604 * kt + 4.388 * kt * kt - 16.638 * kt * kt * kt + 12.336 * kt * kt * kt * kt; }
    0.165
}

/// Perez et al. 1990 (Solar Energy 44(5), 271-289), all-sites composite coefficients f11 f12 f13 f21 f22 f23 for the eight sky
/// clearness bins, whose upper limits are PEREZ_EPS
const PEREZ: [[f64; 6]; 8] = [[-0.008, 0.588, -0.062, -0.060, 0.072, -0.022], [0.130, 0.683, -0.151, -0.019, 0.066, -0.029],
                              [0.330, 0.487, -0.221, 0.055, -0.064, -0.026], [0.568, 0.187, -0.295, 0.109, -0.152, -0.014],
                              [0.873, -0.392, -0.362, 0.226, -0.462, 0.001], [1.132, -1.237, -0.412, 0.288, -0.823, 0.056],
                              [1.060, -1.600, -0.359, 0.264, -1.127, 0.131], [0.678, -0.327, -0.250, 0.156, -1.377, 0.251]];
const PEREZ_EPS: [f64; 7] = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];

/// Relative optical air mass of Kasten and Young (1989), zenith capped at 90 deg
pub(crate) fn air_mass(zenith_deg: f64) -> f64 {
    let zd = min(zenith_deg, 90.0);
    1.0 / (cosd(zd) + 0.50572 * (96.07995 - zd).powf(-1.6364))
}

/// Air pressure relative to sea level at an elevation in m (standard atmosphere), for the absolute air mass
pub(crate) fn pressure_ratio(elevation: f64) -> f64 { 100.0 * ((44331.514 - elevation) / 11880.516).powf(1.0 / 0.1902632) / 101325.0 }

/// Circumsolar (F1) and horizon (F2) brightening coefficients of the Perez model
pub(crate) fn perez_f(dhi: f64, dni: f64, zenith_deg: f64, e0: f64) -> (f64, f64) {
    let zd = min(zenith_deg, 90.0);
    let z = zd * D2R;
    let delta = dhi * air_mass(zenith_deg) / e0;   // sky brightness
    let kz3 = 1.041 * z * z * z;
    let eps = ((dhi + dni) / dhi + kz3) / (1.0 + kz3);   // sky clearness
    let f = &PEREZ[PEREZ_EPS.partition_point(|&e| !(eps < e))];   // std::upper_bound
    (max(0.0, f[0] + f[1] * delta + f[2] * z), f[3] + f[4] * delta + f[5] * z)
}

/// Diffuse fraction of the logistic model of Boland and Ridley (2008) from the clearness index
pub(crate) fn boland_diffuse_fraction(kt: f64) -> f64 { 1.0 / (1.0 + (8.645 * (kt - 0.613)).exp()) }

/// Beam normal irradiance of the DISC model (Maxwell 1987) from the clearness index and Kasten's (1966) absolute air mass, capped at 12
pub(crate) fn disc_dni(kt: f64, zenith_deg: f64, pr: f64, e0: f64) -> f64 {
    let am = min(12.0, pr / (cosd(zenith_deg) + 0.15 * (93.885 - min(zenith_deg, 90.0)).powf(-1.253)));
    let (a, b, c) = if kt <= 0.6 {
        (0.512 + kt * (-1.56 + kt * (2.286 - 2.222 * kt)), 0.37 + 0.962 * kt, -0.28 + kt * (0.932 - 2.048 * kt))
    } else {
        (-5.743 + kt * (21.77 + kt * (-27.49 + 11.56 * kt)), 41.4 + kt * (-118.5 + kt * (66.05 + 31.9 * kt)),
         -47.01 + kt * (184.2 + kt * (-222.0 + 73.81 * kt)))
    };
    let knc = 0.866 + am * (-0.122 + am * (0.0121 + am * (-0.000653 + 1.4e-05 * am)));
    max(0.0, (knc - a - b * (c * am).exp()) * e0)
}

/// PVSPEC spectral mismatch factor M = a kc^b AMa^c (Pelland et al. 2020) coefficients of the paper's module types
pub(crate) fn pvspec_coeffs(kind: &str) -> Option<[f64; 3]> {
    match kind {
        "monosi" => Some([0.9845, -0.05169, 0.03034]),
        "multisi" => Some([0.9847, -0.05237, 0.03034]),
        "cigs" => Some([0.9791, -0.03904, 0.03096]),
        "cdte" => Some([1.002, -0.07108, 0.02465]),
        "asi" => Some([1.051, -0.1033, 0.009838]),
        _ => None,
    }
}

/// Ineichen and Perez (2002) clear sky [GHI, DNI, DHI] from cos(zenith), the absolute air mass, extraterrestrial irradiance,
/// elevation (m) and Linke turbidity, without the optional high air-mass enhancement term
pub(crate) fn ineichen(cz: f64, am: f64, e0: f64, elevation: f64, tl: f64) -> [f64; 3] {
    if cz <= 0.0 { return [0.0, 0.0, 0.0]; }
    let (fh1, fh2) = ((-elevation / 8000.0).exp(), (-elevation / 1250.0).exp());
    let (cg1, cg2) = (5.09e-05 * elevation + 0.868, 3.92e-05 * elevation + 0.0387);
    let ghi = cg1 * e0 * cz * (-cg2 * am * (fh1 + fh2 * (tl - 1.0))).exp();
    let b = 0.664 + 0.163 / fh1;
    let dni = min(b * e0 * (-0.09 * am * (tl - 1.0)).exp(),
                  ghi * max(0.0, (1.0 - (0.1 - 0.2 * (-tl).exp()) / (0.1 + 0.882 / fh1)) / cz));
    [ghi, dni, ghi - dni * cz]
}

/// Linke turbidity by local month for the Ineichen clear sky: the typed value, or the 5th percentile of the turbidity that
/// reproduces the GHI of each hour with the sun above 17.5 deg, limited to 2-8; a month with under 40 such hours takes the
/// year's value.
pub(crate) fn linke_by_month(p: &Project) -> Result<[f64; 12], Error> {
    let mut tl = [if p.pv.linke_turbidity > 0.0 { p.pv.linke_turbidity } else { 3.0 }; 12];
    if p.pv.linke_turbidity > 0.0 || p.wx.ghi.len() != HOURS { return Ok(tl); }
    let el = p.loc.elevation;
    let (pr, fh1, fh2) = (pressure_ratio(el), (-el / 8000.0).exp(), (-el / 1250.0).exp());
    let (cg1, cg2) = (5.09e-05 * el + 0.868, 3.92e-05 * el + 0.0387);
    let sh = local_shift(p)?;
    let mut by: [Vec<f64>; 12] = Default::default();
    let mut all = Vec::new();
    for i in 0..HOURS {
        let ghi = p.wx.ghi[i];
        if !(ghi > 0.0) { continue; }
        let s = sun_at(p, i);
        if s.cos_zenith < 0.3 { continue; }
        let x = ghi / (cg1 * s.extra_normal * s.cos_zenith);
        if !(x > 0.0) { continue; }
        let t = 1.0 + (-x.ln() / (cg2 * air_mass(s.zenith_deg) * pr) - fh1) / fh2;
        by[local_month(i, sh)].push(t);
        all.push(t);
    }
    let p5 = |v: &[f64]| {
        let mut v = v.to_vec();
        let k = v.len() / 20;
        *v.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)).1
    };
    if all.is_empty() { return Ok(tl); }
    let year = p5(&all);
    for m in 0..12 { tl[m] = clamp(if by[m].len() >= 40 { p5(&by[m]) } else { year }, 2.0, 8.0); }
    Ok(tl)
}

/// Clear-sky GHI on the weather file's own time base, of the project's clear-sky model (Haurwitz or Ineichen)
pub fn clearsky_ghi(p: &Project) -> Result<Vec<f64>, Error> {
    if p.pv.clearsky != "ineichen" { return Ok(crate::solar::clearsky_ghi(p)); }
    let tl = linke_by_month(p)?;
    let sh = local_shift(p)?;
    let pr = pressure_ratio(p.loc.elevation);
    Ok((0..HOURS).map(|i| {
        let s = sun_at(p, i);
        ineichen(s.cos_zenith, air_mass(s.zenith_deg) * pr, s.extra_normal, p.loc.elevation, tl[local_month(i, sh)])[0]
    }).collect())
}

/// Clear-sky GHI of an hour for the spectral index: Ineichen with the month's turbidity, or Haurwitz
pub(crate) fn clearsky_hour(ineichen_cs: bool, cz: f64, am: f64, e0: f64, elevation: f64, tl: f64) -> f64 {
    if ineichen_cs { ineichen(cz, am, e0, elevation, tl)[0] } else { haurwitz_ghi(cz) }
}

/// Monthly snow loss of Townsend and Powers (2011) with the string factor of Townsend and Previtali (2023): from snowfall (cm)
/// and snow days of the month and the month before, relative humidity, mean air temperature (deg C), plane-of-array
/// irradiation (kWh/m2), tilt, slant height and lower-edge height (the published constants take inches). Trackers count at
/// their largest rotation with half the table width.
pub(crate) fn townsend_loss(pv: &PVParams, poa_kwh: &[f64; 12], tamb: &[f64; 12]) -> [f64; 12] {
    let tracker = pv.mount == "tracker";
    let tilt = if tracker { pv.tracker_max_angle } else { pv.tilt };
    let slant = (if tracker { 0.5 } else { 1.0 }) * pv.row_width * 39.37;
    let lower = max(0.0, pv.mount_height - 0.5 * pv.row_width * sind(tilt)) * 39.37;
    let string_factor = if pv.modules_up > 1 { 0.75 } else { 1.0 };
    let eff = |m: usize| {   // effective snow, inches
        let (n, st) = (pv.snow_events[m], pv.snow_monthly[m] / 2.54);
        if n > 0.0 { 0.5 * st * (1.0 + 1.0 / max(n, 1.0)) } else { 0.0 }
    };
    let mut loss = [0.0; 12];
    for m in 0..12 {
        let se = eff((m + 11) % 12) / 3.0 + 2.0 * eff(m) / 3.0;
        if se <= 0.0 || poa_kwh[m] <= 0.0 { continue; }
        let gamma = slant * se * cosd(tilt) / max(0.1, lower * lower - se * se) * 2.0 * (40.0 * D2R).tan();
        loss[m] = clamp(5.7e4 * se * cosd(tilt) * cosd(tilt) * (1.0 - 0.51 * (-gamma).exp()) * pv.snow_rh
                            / ((tamb[m] + 273.15) * (tamb[m] + 273.15)) / poa_kwh[m].powf(0.67) * string_factor,
                        0.0, 1.0);
    }
    loss
}

pub(crate) fn monthly_tamb(p: &Project) -> Result<[f64; 12], Error> {
    let sh = local_shift(p)?;
    let mut m = [0.0; 12];
    for i in 0..HOURS { m[local_month(i, sh)] += if p.wx.tamb.len() == HOURS { p.wx.tamb[i] } else { 25.0 }; }
    for k in 0..12 { m[k] /= f64::from((if k < 11 { MONTH_START[k + 1] } else { 365 }) - MONTH_START[k]) * 24.0; }
    Ok(m)
}
