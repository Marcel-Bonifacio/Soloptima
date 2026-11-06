//! Sun position and the Haurwitz clear sky (src/pv.cpp). The PV models (crate::pv) build on them; pv::clearsky_ghi follows the
//! project's clear-sky model.
use crate::json::Error;
use crate::model::{Project, HOURS};
use std::f64::consts::PI;

const D2R: f64 = PI / 180.0;
const R2D: f64 = 180.0 / PI;

#[derive(Debug, Clone, Copy)]
pub struct SunPos {
    pub zenith_deg: f64,
    /// clockwise from north
    pub azimuth_deg: f64,
    pub cos_zenith: f64,
    /// extraterrestrial normal irradiance, W/m2
    pub extra_normal: f64,
}

/// Equation of time in minutes for the day angle `b` (rad) of the year (Spencer 1971)
pub fn equation_of_time(b: f64) -> f64 {
    229.18 * (0.000075 + 0.001868 * b.cos() - 0.032077 * b.sin() - 0.014615 * (2.0 * b).cos() - 0.040849 * (2.0 * b).sin())
}

/// [sin x, cos x] in one call, as the C++ compiler makes them when a function takes both of one value: on Apple systems
/// __sincos_stret, which may differ from sin and cos in the last bit; elsewhere sincos, which gives sin and cos
pub fn sin_cos(x: f64) -> (f64, f64) {
    #[cfg(target_vendor = "apple")]
    {
        #[repr(C)]
        struct SinCos { s: f64, c: f64 }
        extern "C" { fn __sincos_stret(x: f64) -> SinCos; }
        // SAFETY: a pure libm function of one double, always present on Apple systems
        let r = unsafe { __sincos_stret(x) };
        (r.s, r.c)
    }
    #[cfg(not(target_vendor = "apple"))]
    { (x.sin(), x.cos()) }
}

/// sin x and cos x as two separate calls that the optimizer cannot merge, where the C++ compiler leaves them apart
#[inline(never)]
pub fn sin_apart(x: f64) -> f64 { x.sin() }
#[inline(never)]
pub fn cos_apart(x: f64) -> f64 { x.cos() }

/// doy: 1..365, utc_hour: fractional hour of day (0..24). Every sine and cosine comes in pairs of one value, so it takes them
/// together, as the C++ engine does once compiled.
pub fn sun_position(lat: f64, lon: f64, doy: i32, utc_hour: f64) -> SunPos {
    let b = 2.0 * PI * (f64::from(doy - 1) + (utc_hour - 12.0) / 24.0) / 365.0;
    let ((sb, cb), (s2b, c2b), (s3b, c3b)) = (sin_cos(b), sin_cos(2.0 * b), sin_cos(3.0 * b));
    let decl = 0.006918 - 0.399912 * cb + 0.070257 * sb - 0.006758 * c2b + 0.000907 * s2b - 0.002697 * c3b + 0.00148 * s3b;
    let eot = 229.18 * (0.000075 + 0.001868 * cb - 0.032077 * sb - 0.014615 * c2b - 0.040849 * s2b);   // equation_of_time(b)
    let tst = utc_hour * 60.0 + eot + 4.0 * lon;   // true solar time, minutes
    let ha = (tst / 4.0 - 180.0) * D2R;
    let phi = lat * D2R;
    let ((sp, cp), (sd, cd), (sh, ch)) = (sin_cos(phi), sin_cos(decl), sin_cos(ha));
    let cz = (sp * sd + cp * cd * ch).clamp(-1.0, 1.0);
    let zen = cz.acos() * R2D;
    let az = sh.atan2(ch * sp - decl.tan() * cp) * R2D + 180.0;
    let e0 = 1367.0 * (1.00011 + 0.034221 * cb + 0.00128 * sb + 0.000719 * c2b + 0.000077 * s2b);
    SunPos { zenith_deg: zen, azimuth_deg: (az + 360.0) % 360.0, cos_zenith: cz, extra_normal: e0 }
}

/// Clear-sky GHI of Haurwitz (1945) for the cosine of the zenith angle
pub fn haurwitz_ghi(cz: f64) -> f64 {
    if cz > 0.01 { 1098.0 * cz * (-0.057 / cz).exp() } else { 0.0 }
}

/// The sun at hour `i` of the weather file, at its representative instant (as `sun_at` in src/pv.cpp)
pub fn sun_at(p: &Project, i: usize) -> SunPos { sun_at_utc(p, sun_time(p, i)) }

/// The representative instant of hour `i` of the weather file in UTC hours of the year
pub fn sun_time(p: &Project, i: usize) -> f64 {
    let w = &p.wx;
    (i as f64 + w.time_offset - if w.is_utc { 0.0 } else { p.loc.utc_offset } + HOURS as f64) % HOURS as f64
}

/// The sun at `t` UTC hours of the year
pub fn sun_at_utc(p: &Project, t: f64) -> SunPos { sun_position(p.loc.lat, p.loc.lon, (t / 24.0) as i32 + 1, t % 24.0) }

/// Clear-sky GHI of every hour of the weather file (Haurwitz; pv::clearsky_ghi takes the project's model)
pub fn clearsky_ghi(p: &Project) -> Vec<f64> { (0..HOURS).map(|i| haurwitz_ghi(sun_at(p, i).cos_zenith)).collect() }

/// Hours the weather file's hours lie from local standard time: whole hours `n` and the fraction `f` (UTC files only)
pub fn local_shift(p: &Project) -> Result<(i32, f64), Error> {
    if !p.wx.is_utc { return Ok((0, 0.0)); }
    let off = p.loc.utc_offset;
    if !(off.abs() <= 14.0) { return Err(Error("UTC offset must be between -14 h and +14 h.".into())); }
    let n = off.floor();
    Ok((n as i32, off - n))
}
