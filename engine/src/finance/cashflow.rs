//! Cash-flow measures of a series with cf[0] at t = 0 (undiscounted), as `npv`, `irr` and `payback` of src/sim.cpp.

/// Net present value at rate `r`
pub fn npv(cf: &[f64], r: f64) -> f64 {
    let mut v = 0.0;
    for (t, x) in cf.iter().enumerate() { v += x / (1.0 + r).powf(t as f64); }
    v
}

/// Internal rate of return by bisection on [-0.99, 10]; None when the NPV does not change sign there
pub fn irr(cf: &[f64]) -> Option<f64> {
    let (mut lo, mut hi) = (-0.99, 10.0);
    let (mut flo, fhi) = (npv(cf, lo), npv(cf, hi));
    if !flo.is_finite() || !fhi.is_finite() || flo * fhi >= 0.0 { return None; }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if mid == lo || mid == hi { break; }   // interval cannot shrink further
        let fm = npv(cf, mid);
        if (fm > 0.0) == (flo > 0.0) { lo = mid; flo = fm; } else { hi = mid; }
    }
    Some(0.5 * (lo + hi))
}

/// Simple payback in years, interpolated within the year; 0 when cf[0] >= 0, -1 if never
pub fn payback(cf: &[f64]) -> f64 {
    let mut cum = cf[0];
    if cum >= 0.0 { return 0.0; }
    for t in 1..cf.len() {
        let prev = cum;
        cum += cf[t];
        if cum >= 0.0 { return (t - 1) as f64 + (-prev) / cf[t]; }
    }
    -1.0
}
