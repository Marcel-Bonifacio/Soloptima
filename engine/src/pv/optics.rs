//! Reflection (beam and diffuse incidence angle modifiers), the sky a terrain horizon leaves in view of a plane, and the
//! inverter part-load curve.
use super::{clamp, cosd, max, D2R};
use crate::solar::sin_cos;
use crate::model::PVParams;

/// Terrain horizon elevation (deg) at an azimuth, linear between the equal azimuth steps of the profile (from north, clockwise)
pub fn horizon_at(h: &[f64], az: f64) -> f64 {
    let n = h.len() as i32;
    let x = ((az % 360.0) + 360.0) % 360.0 * f64::from(n) / 360.0;
    let i = (x as i32 % n) as usize;
    h[i] + (x - x.floor()) * (h[(i + 1) % n as usize] - h[i])
}

/// Beam incidence angle modifier from cos(angle of incidence): ASHRAE 1 - b0 (1/cos - 1); Martin and Ruiz (2001); or the
/// physical model of De Soto et al. (2006): Fresnel transmission through the air-glass interface (and an antireflective
/// coating with multiple reflections between its two interfaces) and absorption in the glass, relative to normal incidence.
pub fn incidence_modifier(pv: &PVParams, c: f64) -> f64 {
    if c <= 0.0 { return 0.0; }
    if pv.iam_model == "martin_ruiz" { return (1.0 - (-c / pv.iam_ar).exp()) / (1.0 - (-1.0 / pv.iam_ar).exp()); }
    if pv.iam_model != "physical" { return clamp(1.0 - pv.iam_b0 * (1.0 / c - 1.0), 0.0, 1.0); }
    let (n2, n3) = (if pv.iam_n_ar > 0.0 { pv.iam_n_ar } else { pv.iam_n }, pv.iam_n);
    let sq = |x: f64| x * x;
    let s1 = (1.0 - c * c).sqrt();
    let s2 = s1 / n2;
    let c2 = (1.0 - s2 * s2).sqrt();
    let (r12s, r12p, r120) = (sq((c - n2 * c2) / (c + n2 * c2)), sq((c2 - n2 * c) / (c2 + n2 * c)), sq((1.0 - n2) / (1.0 + n2)));
    let (mut ts, mut tp, mut t0, mut cg) = (1.0 - r12s, 1.0 - r12p, 1.0 - r120, c2);
    if n3 != n2 {
        let s3 = n2 / n3 * s2;
        let c3 = (1.0 - s3 * s3).sqrt();
        let r23s = sq((n2 * c2 - n3 * c3) / (n2 * c2 + n3 * c3));
        let r23p = sq((n2 * c3 - n3 * c2) / (n2 * c3 + n3 * c2));
        let r230 = sq((n2 - n3) / (n2 + n3));
        ts *= (1.0 - r23s) / (1.0 - r23s * r12s);
        tp *= (1.0 - r23p) / (1.0 - r23p * r12p);
        t0 *= (1.0 - r230) / (1.0 - r230 * r120);
        cg = c3;
    }
    (ts + tp) / 2.0 * (-pv.iam_kl / cg).exp() / (t0 * (-pv.iam_kl).exp())
}

/// Diffuse IAM [sky, ground] of a plane at a tilt (deg, over 90 for the back of a module): the beam IAM averaged over the
/// isotropic sky and ground in its view, weighted by the cosine of incidence (Marion 2017, Solar Energy 147, 344-348)
pub fn diffuse_iam(pv: &PVParams, tilt: f64) -> [f64; 2] {
    let (mut sky, mut sky_w, mut gnd, mut gnd_w) = (0.0, 0.0, 0.0, 0.0);
    const NT: i32 = 90;
    const NP: i32 = 90;
    let (s_tilt, c_tilt) = sin_cos(tilt * D2R);   // pairs of one angle in one call, as the compiled C++ takes them
    for i in 0..NT {
        let th = (f64::from(i) + 0.5) * 90.0 / f64::from(NT);
        let (sn, c) = sin_cos(th * D2R);
        let f = incidence_modifier(pv, c) * c * sn;
        let wgt = c * sn;
        for j in 0..NP {
            let up = c * c_tilt + sn * cosd((f64::from(j) + 0.5) * 360.0 / f64::from(NP)) * s_tilt;   // vertical component
            if up > 0.0 { sky += f; sky_w += wgt; } else { gnd += f; gnd_w += wgt; }
        }
    }
    [if sky_w > 0.0 { sky / sky_w } else { 1.0 }, if gnd_w > 0.0 { gnd / gnd_w } else { 1.0 }]
}

/// Share of each sky cell in view over a horizon: 180 azimuth cells of 2 deg (from north) by 90 elevation cells of 1 deg, and
/// the share of the horizon band (about 6.5 deg high) at each azimuth cell
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SkyCells {
    pub sky: Vec<f64>,
    pub band: Vec<f64>,
}

pub fn sky_cells(h: &[f64]) -> SkyCells {
    let mut c = SkyCells { sky: vec![0.0; 180 * 90], band: vec![0.0; 180] };
    for j in 0..180 {
        let hz = horizon_at(h, (j as f64 + 0.5) * 2.0);
        c.band[j] = clamp(1.0 - hz / 6.5, 0.0, 1.0);
        for k in 0..90 { c.sky[j * 90 + k] = clamp(k as f64 + 1.0 - hz, 0.0, 1.0); }
    }
    c
}

/// Shares [isotropic sky, horizon band] of the sky cells in view of a plane (tilt, azimuth): sky cells weighted by their
/// cosine of incidence, band azimuths by the horizontal cosine
pub fn sky_view(c: &SkyCells, tilt: f64, az_n: f64) -> [f64; 2] {
    let (mut all, mut vis, mut band, mut band_vis) = (0.0, 0.0, 0.0, 0.0);
    let (s_tilt, c_tilt) = sin_cos(tilt * D2R);   // pairs of one angle in one call, as the compiled C++ takes them
    for j in 0..180 {
        let az = (j as f64 + 0.5) * 2.0;
        let ca = cosd(az - az_n);
        band += max(0.0, ca);
        band_vis += max(0.0, ca) * c.band[j];
        for k in 0..90 {
            let e = k as f64 + 0.5;
            let (s_e, c_e) = sin_cos(e * D2R);
            let ci = s_e * c_tilt + c_e * s_tilt * ca;
            if ci <= 0.0 { continue; }
            all += ci * c_e;
            vis += ci * c_e * c.sky[j * 90 + k];
        }
    }
    [if all > 0.0 { vis / all } else { 1.0 }, if band > 0.0 { band_vis / band } else { 1.0 }]
}

/// Share [isotropic sky, horizon band] that a terrain horizon (elevations at equal azimuth steps from north) leaves in view of
/// a plane (tilt, azimuth in deg)
pub fn horizon_view(h: &[f64], tilt: f64, az_n: f64) -> [f64; 2] { sky_view(&sky_cells(h), tilt, az_n) }

/// Inverter part-load loss coefficients [k0, k2] (P_loss = k0 + k2 p^2 per unit of AC rating at AC output p; Schmidt and Sauer
/// 1996, Driesse et al. 2008). The peak efficiency 1 / (1 + 2 sqrt(k0 k2)) fixes k0 k2 and the European weighted efficiency
/// the load of the peak, sqrt(k0 / k2); of two loads that fit, the one nearer 40 % is taken.
pub fn inverter_curve(eta_w: f64, eta_max: f64) -> [f64; 2] {
    const EURO: [[f64; 2]; 6] = [[0.05, 0.03], [0.10, 0.06], [0.20, 0.13], [0.30, 0.10], [0.50, 0.48], [1.00, 0.20]];
    let r = (1.0 / eta_max - 1.0) / 2.0;
    let euro = |pk: f64| EURO.iter().fold(0.0, |e, x| e + x[1] * x[0] / (x[0] + r * pk + r / pk * x[0] * x[0]));
    let (mut best, mut err) = (0.4f64, 1e9f64);
    for i in 1..=1000 {
        let pk = 0.001 * f64::from(i);
        let d = (euro(pk) - eta_w).abs();
        if d < err - 2e-6 || (d < err + 2e-6 && (pk - 0.4).abs() < (best - 0.4).abs()) {
            err = super::min(err, d);
            best = pk;
        }
    }
    [r * best, r / best]
}
