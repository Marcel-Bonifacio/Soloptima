//! Neural network forecaster: a small multilayer perceptron after Rajendran & Gebremedhin (2024, Front. Energy Res.
//! 12:1363895), made causal: inputs are only quantities known at issue time (lagged indices, lead, calendar of the target
//! hour), and the network is retrained at the start of every month on targets from the preceding 330 days.
use super::rng::{Mt19937, Normal};
use super::series::SeriesForecaster;
use crate::sim::forecast_wrap as wrap;
use crate::MONTH_START;

pub(super) const NI: usize = 10;
const NH: usize = 16;
const NP: usize = NH * NI + NH + NH * NH + NH + NH + 1;   // weights + biases
// offsets of W1, b1, W2, b2, W3, b3
const B1: usize = NH * NI;
const W2: usize = B1 + NH;
const B2: usize = W2 + NH * NH;
const W3: usize = B2 + NH;
const B3: usize = W3 + NH;

fn layers(w: &[f64], inp: &[f64; NI], h1: &mut [f64; NH], h2: &mut [f64; NH]) -> f64 {
    for j in 0..NH { let mut a = w[B1 + j]; for k in 0..NI { a += w[j * NI + k] * inp[k]; } h1[j] = if a > 0.0 { a } else { 0.0 }; }
    for j in 0..NH { let mut a = w[B2 + j]; for k in 0..NH { a += w[W2 + j * NH + k] * h1[k]; } h2[j] = if a > 0.0 { a } else { 0.0 }; }
    let mut o = w[B3];
    for k in 0..NH { o += w[W3 + k] * h2[k]; }
    o
}

pub(super) fn forward(w: &[f64], inp: &[f64; NI]) -> f64 { layers(w, inp, &mut [0.0; NH], &mut [0.0; NH]) }

/// sin and cos of one angle. Optimised builds for macOS merge the two calls into `__sincos_stret` (clang does the same for the
/// C++ engine), which differs from separate sin and cos in the last bit for some angles; calling it always keeps debug and
/// release builds equal to the C++ engine.
#[cfg(target_os = "macos")]
fn sin_cos(x: f64) -> (f64, f64) {
    #[repr(C)]
    struct SinCos { s: f64, c: f64 }
    extern "C" { fn __sincos_stret(x: f64) -> SinCos; }
    // SAFETY: a pure libm function of a double that returns both values by value
    let r = unsafe { __sincos_stret(x) };
    (r.s, r.c)
}
#[cfg(not(target_os = "macos"))]
fn sin_cos(x: f64) -> (f64, f64) { x.sin_cos() }

pub(super) fn inputs(f: &SeriesForecaster, issue: i32, tgt: i32, inp: &mut [f64; NI]) {
    let x = f.features(issue, tgt);
    let lead = (tgt - issue).max(0);
    let t = wrap(tgt) as i32;
    let hod = (f64::from(t % 24) + 0.5) / 24.0 * 2.0 * 3.14159265358979;
    let doy = (f64::from(t / 24) + 0.5) / 365.0 * 2.0 * 3.14159265358979;
    inp[..5].copy_from_slice(&x[1..6]);
    inp[5] = f64::from(lead.min(48)) / 48.0;
    (inp[6], inp[7]) = sin_cos(hod);
    (inp[8], inp[9]) = sin_cos(doy);
}

/// The weights at the start of each month (12 snapshots), trained with Adam on mini-batches of 32
pub(super) fn train(f: &SeriesForecaster, seed: u32) -> Vec<Vec<f64>> {
    let mut rng = Mt19937::new(seed ^ 0x9e37_79b9);
    let mut nd = Normal::default();
    let (mut w, mut m, mut v, mut g) = (vec![0.0; NP], vec![0.0; NP], vec![0.0; NP], vec![0.0; NP]);
    // He initialisation
    for i in 0..NH * NI { w[i] = nd.sample(&mut rng) * (2.0 / NI as f64).sqrt(); }
    for i in 0..NH * NH { w[W2 + i] = nd.sample(&mut rng) * (2.0 / NH as f64).sqrt(); }
    for i in 0..NH { w[W3 + i] = nd.sample(&mut rng) * (1.0 / NH as f64).sqrt(); }
    w[B3] = 1.0;   // output bias starts at y = 1
    const LEADS: [i32; 12] = [0, 1, 2, 3, 6, 9, 12, 18, 24, 30, 36, 42];
    let (lr, b1, b2, eps): (f64, f64, f64, f64) = (3e-3, 0.9, 0.999, 1e-8);
    let mut step: i64 = 0;
    let mut snaps = Vec::with_capacity(12);
    let mut samples: Vec<([f64; NI], f64)> = Vec::with_capacity(330 * 24 * 3);
    let (mut h1, mut h2) = ([0.0; NH], [0.0; NH]);
    for mo in 0..12 {
        // training window: targets in the 330 days before this month (cyclic year = the previous year's data)
        samples.clear();
        let start = MONTH_START[mo] * 24;
        for t in start - 330 * 24..start {
            let tw = wrap(t);
            if !f.y[tw].is_finite() { continue; }
            for _ in 0..3 {
                let lead = LEADS[rng.below(12) as usize];
                let mut inp = [0.0; NI];
                inputs(f, t - lead, t, &mut inp);
                samples.push((inp, f.y[tw]));
            }
        }
        let epochs = if mo == 0 { 8 } else { 2 };   // warm start after the first month
        for _ in 0..epochs {
            rng.shuffle(&mut samples);
            let mut b0 = 0;
            while b0 < samples.len() {
                g.iter_mut().for_each(|x| *x = 0.0);
                let b1e = (b0 + 32).min(samples.len());
                for (inp, yv) in &samples[b0..b1e] {
                    let out = layers(&w, inp, &mut h1, &mut h2);
                    let d = 2.0 * (out - yv) / (b1e - b0) as f64;   // dMSE/dout
                    let mut d1 = [0.0; NH];
                    for k in 0..NH { g[W3 + k] += d * h2[k]; }
                    g[B3] += d;
                    for j in 0..NH {
                        if h2[j] <= 0.0 { continue; }
                        let d2 = d * w[W3 + j];
                        g[B2 + j] += d2;
                        for k in 0..NH { g[W2 + j * NH + k] += d2 * h1[k]; d1[k] += d2 * w[W2 + j * NH + k]; }
                    }
                    for j in 0..NH {
                        if h1[j] <= 0.0 { continue; }
                        g[B1 + j] += d1[j];
                        for k in 0..NI { g[j * NI + k] += d1[j] * inp[k]; }
                    }
                }
                step += 1;   // Adam update
                let c1 = 1.0 - b1.powf(step as f64);
                let c2 = 1.0 - b2.powf(step as f64);
                for i in 0..NP {
                    m[i] = b1 * m[i] + (1.0 - b1) * g[i];
                    v[i] = b2 * v[i] + (1.0 - b2) * g[i] * g[i];
                    w[i] -= lr * (m[i] / c1) / ((v[i] / c2).sqrt() + eps);
                }
                b0 += 32;
            }
        }
        snaps.push(w.clone());
    }
    snaps
}
