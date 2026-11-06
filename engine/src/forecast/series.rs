//! One forecasting method on one series (SeriesForecaster in src/forecast.cpp): the normalised index, its smoothing and the
//! learnt models, and the forecast of hour `tgt` issued at hour `issue`. All methods are causal: a forecast issued at `issue`
//! only uses observations up to issue - 1. The year is cyclic, so a forecast in early January sees the previous December.
use super::mlp::{self, NI};
use super::rng::{Mt19937, Normal};
use crate::sim::forecast_wrap as wrap;
use crate::HOURS;

const H: i32 = HOURS as i32;
pub(super) const NF: usize = 6;                                            // RLS features
const NB: usize = 11;                                                      // RLS lead buckets
const REP_LEAD: [i32; NB] = [0, 1, 2, 3, 4, 7, 10, 15, 21, 30, 42];      // training lead per bucket
const ANALOG_DAYS: usize = 60;
const ANALOG_K: usize = 7;
const ENS_WINDOW: i32 = 14 * 24;

fn bucket(lead: i32) -> usize {
    match lead { 0..=3 => lead as usize, 4..=5 => 4, 6..=8 => 5, 9..=12 => 6, 13..=18 => 7, 19..=24 => 8, 25..=36 => 9, _ => 10 }
}

/// Sum over hours [a, b) from a cyclic prefix sum cum[0..=HOURS]
fn rsum(cum: &[f64], a: i32, b: i32) -> f64 {
    let f = |n: i32| { let q = if n >= 0 { n / H } else { -((-n + H - 1) / H) }; f64::from(q) * cum[HOURS] + cum[(n - q * H) as usize] };
    f(b) - f(a)
}

fn ar1_series(seed: u32, rho: f64) -> Vec<f64> {
    let (mut g, mut nd) = (Mt19937::new(seed), Normal::default());
    let s = (1.0 - rho * rho).sqrt();
    let mut x = 0.0;
    (0..HOURS).map(|_| { x = rho * x + s * nd.sample(&mut g); x }).collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Method { SmartPersistence, Profile, Persistence, Weekly, Climatology, Ets, Rls, Analog, Ensemble, Mlp, Perfect, Noisy }

const IDS: [(&str, Method); 12] = [
    ("smart_persistence", Method::SmartPersistence), ("profile", Method::Profile), ("persistence", Method::Persistence),
    ("weekly", Method::Weekly), ("climatology", Method::Climatology), ("ets", Method::Ets), ("rls", Method::Rls),
    ("analog", Method::Analog), ("ensemble", Method::Ensemble), ("mlp", Method::Mlp), ("perfect", Method::Perfect), ("noisy", Method::Noisy),
];

pub struct SeriesForecaster {
    method: Method,
    pub(super) pv: bool,
    sigma: f64,
    pub(super) act: Vec<f64>,
    pub(super) ref_: Vec<f64>,
    pub(super) y: Vec<f64>,
    pub(super) yff: Vec<f64>,
    cum_act: Vec<f64>,
    cum_ref: Vec<f64>,
    lev: Vec<f64>,
    s30a: Vec<f64>,
    s30r: Vec<f64>,
    z: Vec<f64>,
    /// RLS coefficients snapshot per day x bucket x feature
    theta: Vec<f64>,
    /// per issue hour: day-lags (1..60) sorted by pattern distance
    analog: Vec<u8>,
    members: Vec<SeriesForecaster>,
    /// ensemble: per member prefix sums of squared error
    cum_err_intra: Vec<f64>,
    cum_err_day: Vec<f64>,
    /// neural network weights, one snapshot per month
    mlp: Vec<Vec<f64>>,
}

impl SeriesForecaster {
    /// `refv` empty: a load series (reference = mean). noise_sigma is used by "noisy", seed by "noisy" and "mlp". An unknown
    /// method falls back to smart persistence (PV) or the profile (load).
    pub fn new(method: &str, act: &[f64], refv: &[f64], noise_sigma: f64, seed: u32) -> SeriesForecaster {
        let pv = !refv.is_empty();
        let mut a = act.to_vec();
        let fill = a.last().copied().unwrap_or(0.0);
        a.resize(HOURS, fill);
        let list = if pv { super::pv_forecast_methods() } else { super::load_forecast_methods() };
        let mut m = if pv { Method::SmartPersistence } else { Method::Profile };
        if list.iter().any(|x| x.id == method) { if let Some(&(_, k)) = IDS.iter().find(|(id, _)| *id == method) { m = k; } }
        let r = if pv {
            let mut r = refv.to_vec();
            r.resize(HOURS, 0.0);
            r
        } else {
            let mean = a.iter().fold(0.0, |s, x| s + x) / HOURS as f64;
            vec![if mean > 0.0 { mean } else { 1.0 }; HOURS]
        };
        let thr = if pv { 0.02 } else { -1.0 };
        let y: Vec<f64> = (0..HOURS).map(|t| if r[t] > thr { a[t] / r[t] } else { f64::NAN }).collect();
        // forward-filled index (cyclic): night hours carry the last daylight value
        let mut yff = y.clone();
        let mut last = 1.0;
        for _ in 0..2 { for t in 0..HOURS { if y[t].is_finite() { last = y[t]; } else { yff[t] = last; } } }
        let (mut cum_act, mut cum_ref) = (vec![0.0; HOURS + 1], vec![0.0; HOURS + 1]);
        for t in 0..HOURS {
            cum_act[t + 1] = cum_act[t] + a[t];
            cum_ref[t + 1] = cum_ref[t] + if r[t] > thr { r[t] } else { 0.0 };
        }
        let (mut s30a, mut s30r) = (vec![0.0; HOURS], vec![0.0; HOURS]);
        for t in 0..HOURS {
            for d in 1..=30 {
                let k = wrap(t as i32 - 24 * d);
                if r[k] > thr { s30a[t] += a[k]; s30r[t] += r[k]; }
            }
        }
        let mut f = SeriesForecaster {
            method: m, pv, sigma: noise_sigma, act: a, ref_: r, y, yff, cum_act, cum_ref, lev: vec![], s30a, s30r, z: vec![], theta: vec![],
            analog: vec![], members: vec![], cum_err_intra: vec![], cum_err_day: vec![], mlp: vec![],
        };
        if m == Method::Noisy { f.z = ar1_series(seed, 0.85); }
        f.build_ets();
        match m {
            Method::Rls => f.build_rls(),
            Method::Analog => f.build_analog(),
            Method::Ensemble => f.build_ensemble(seed),
            Method::Mlp => f.mlp = mlp::train(&f, seed),
            _ => {}
        }
        f
    }

    fn ratio(&self, a: i32, b: i32) -> f64 {
        let sr = rsum(&self.cum_ref, a, b);
        if sr > (if self.pv { 0.05 } else { 1e-9 }) { rsum(&self.cum_act, a, b) / sr } else { f64::NAN }
    }

    fn build_ets(&mut self) {
        let alpha = if self.pv { 0.25 } else { 0.3 };
        let mut lev = vec![1.0; HOURS];
        for h in 0..24 {   // initial level = annual mean index of that hour
            let (mut sa, mut sr) = (0.0, 0.0);
            for t in (h..HOURS).step_by(24) { if self.y[t].is_finite() { sa += self.act[t]; sr += self.ref_[t]; } }
            let init = if sr > 0.0 { sa / sr } else { 1.0 };
            for t in (h..HOURS).step_by(24) { lev[t] = init; }
        }
        for _ in 0..2 {   // second pass: start of year sees the end of the (cyclic) year
            for t in 0..HOURS {
                let prev = lev[wrap(t as i32 - 24)];
                lev[t] = if self.y[t].is_finite() { alpha * self.y[t] + (1.0 - alpha) * prev } else { prev };
            }
        }
        self.lev = lev;
    }

    pub(super) fn features(&self, issue: i32, tgt: i32) -> [f64; NF] {
        let lead = (tgt - issue).max(0);
        let kmin = lead / 24 + 1;
        let mut r24 = self.ratio(issue - 24, issue);
        if !r24.is_finite() { r24 = 1.0; }
        let mut r3 = self.ratio(issue - 3, issue);
        if !r3.is_finite() { r3 = self.yff[wrap(issue - 1)]; }
        let (tp, t1) = (wrap(tgt - 24 * kmin), wrap(tgt - 24 * (kmin - 1)));
        [1.0, r3, r24, if self.y[tp].is_finite() { self.y[tp] } else { self.yff[tp] },
         if self.s30r[t1] > 1e-9 { self.s30a[t1] / self.s30r[t1] } else { r24 }, self.lev[tp]]
    }

    /// One recursive-least-squares model per lead bucket, trained hour by hour on forecasts whose target has just been
    /// observed. Coefficients are snapshotted at the start of each day and used for that day's forecasts.
    fn build_rls(&mut self) {
        let lambda = 0.999;
        let (mut th, mut p) = (vec![0.0; NB * NF], vec![0.0; NB * NF * NF]);
        for b in 0..NB {
            th[b * NF + 3] = 0.5;   // start near "persistence / smoothing" blend
            th[b * NF + 5] = 0.5;
            for i in 0..NF { p[(b * NF + i) * NF + i] = 10.0; }
        }
        let mut theta = vec![0.0; 365 * NB * NF];
        let mut px = [0.0; NF];
        for pass in 0..2 {
            for d in 0..365 {
                if pass == 1 { theta[d * NB * NF..(d + 1) * NB * NF].copy_from_slice(&th); }
                for h in 0..24 {
                    let t = d * 24 + h;
                    if !self.y[t].is_finite() { continue; }
                    for b in 0..NB {
                        let x = self.features(t as i32 - REP_LEAD[b], t as i32);
                        let tb = &mut th[b * NF..(b + 1) * NF];
                        let pb = &mut p[b * NF * NF..(b + 1) * NF * NF];
                        let (mut den, mut pred) = (lambda, 0.0);
                        for i in 0..NF {
                            px[i] = 0.0;
                            for j in 0..NF { px[i] += pb[i * NF + j] * x[j]; }
                            den += x[i] * px[i];
                            pred += tb[i] * x[i];
                        }
                        let err = self.y[t] - pred;
                        for i in 0..NF { tb[i] += px[i] / den * err; }
                        for i in 0..NF { for j in 0..NF { pb[i * NF + j] = (pb[i * NF + j] - px[i] * px[j] / den) / lambda; } }
                    }
                }
            }
        }
        self.theta = theta;
    }

    fn build_analog(&mut self) {
        let mut analog = vec![0u8; HOURS * ANALOG_DAYS];
        let mut dist = vec![(0.0f64, 0i32); ANALOG_DAYS];
        let (mut ya, mut wa) = ([0.0; 24], [0.0; 24]);   // the last 24 h before i, and their weights
        for i in 0..HOURS {
            let ii = i as i32;
            for k in 1..=24 { let a = wrap(ii - k); ya[k as usize - 1] = self.yff[a]; wa[k as usize - 1] = if self.pv { self.ref_[a] } else { 1.0 }; }
            for m in 1..=ANALOG_DAYS as i32 {
                let mut s = 0.0;
                for k in 1..=24 {
                    let e = ya[k as usize - 1] - self.yff[wrap(ii - 24 * m - k)];
                    s += wa[k as usize - 1] * e * e;
                }
                dist[m as usize - 1] = (s, m);
            }
            dist.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            for m in 0..ANALOG_DAYS { analog[i * ANALOG_DAYS + m] = dist[m].1 as u8; }
        }
        self.analog = analog;
    }

    fn build_ensemble(&mut self, seed: u32) {
        let ids: [&str; 5] = if self.pv { ["smart_persistence", "climatology", "ets", "rls", "analog"] } else { ["profile", "weekly", "ets", "rls", "analog"] };
        let refv: &[f64] = if self.pv { &self.ref_ } else { &[] };
        self.members = ids.iter().map(|id| SeriesForecaster::new(id, &self.act, refv, self.sigma, seed)).collect();
        let n = self.members.len();
        let (mut ci, mut cd) = (vec![0.0; n * (HOURS + 1)], vec![0.0; n * (HOURS + 1)]);
        for (m, mem) in self.members.iter().enumerate() {
            let o = m * (HOURS + 1);
            for t in 0..HOURS {
                let ti = t as i32;
                let ei = mem.at(ti, ti) - self.act[t];
                let ed = mem.at(ti - 24, ti) - self.act[t];
                ci[o + t + 1] = ci[o + t] + ei * ei;
                cd[o + t + 1] = cd[o + t] + ed * ed;
            }
        }
        self.cum_err_intra = ci;
        self.cum_err_day = cd;
    }

    fn base(&self, m: Method, issue: i32, tgt: i32) -> f64 {
        let lead = (tgt - issue).max(0);
        let kmin = lead / 24 + 1;
        let t = wrap(tgt);
        match m {
            Method::SmartPersistence => {
                let mut k24 = self.ratio(issue - 24, issue);
                if !k24.is_finite() { k24 = 1.0; }
                let mut k3 = self.ratio(issue - 3, issue);
                if !k3.is_finite() { k3 = k24; }
                let w = (-f64::from(lead) / 3.0).exp();
                w * k3 + (1.0 - w) * k24
            }
            Method::Profile => {
                let prof = |tt: i32, k0: i32| { let mut s = 0.0; for k in k0..k0 + 7 { s += self.yff[wrap(tt - 24 * k)]; } s / 7.0 };
                let dev = self.yff[wrap(issue - 1)] - prof(issue - 1, 1);
                prof(tgt, kmin) + dev * (-f64::from(lead) / 4.0).exp()
            }
            Method::Climatology => {
                let t1 = wrap(tgt - 24 * (kmin - 1));
                if self.s30r[t1] > 1e-9 { self.s30a[t1] / self.s30r[t1] } else { self.base(Method::SmartPersistence, issue, tgt) }
            }
            Method::Ets => {
                let last = wrap(issue - 1);
                let resid = if self.y[last].is_finite() { self.y[last] - self.lev[wrap(issue - 1 - 24)] } else { 0.0 };
                self.lev[wrap(tgt - 24 * kmin)] + resid * (-f64::from(lead) / (if self.pv { 3.0 } else { 4.0 })).exp()
            }
            Method::Rls => {
                let x = self.features(issue, tgt);
                let o = ((wrap(issue) / 24) * NB + bucket(lead)) * NF;
                let mut v = 0.0;
                for i in 0..NF { v += self.theta[o + i] * x[i]; }
                if v.is_finite() { v } else { self.base(Method::Ets, issue, tgt) }
            }
            Method::Analog => {
                let need = (lead + 24) / 24;   // analog day must lie far enough back that its outcome is observed
                let ms = &self.analog[wrap(issue) * ANALOG_DAYS..(wrap(issue) + 1) * ANALOG_DAYS];
                let (mut s, mut n) = (0.0, 0);
                for &d in ms {
                    if n >= ANALOG_K { break; }
                    if i32::from(d) >= need { s += self.yff[wrap(issue - 24 * i32::from(d) + lead)]; n += 1; }
                }
                if n > 0 { s / n as f64 } else { self.base(Method::Ets, issue, tgt) }
            }
            Method::Mlp => {
                let mut inp = [0.0; NI];
                mlp::inputs(self, issue, tgt, &mut inp);
                let v = mlp::forward(&self.mlp[crate::month_of_day((wrap(issue) / 24) as i32) as usize], &inp);
                if v.is_finite() { v } else { self.base(Method::Ets, issue, tgt) }
            }
            Method::Noisy => {
                let f = (0.3 + 0.7 * f64::from(lead) / 24.0).min(1.0);
                self.yff[t] * (1.0 + self.sigma * f * self.z[t])
            }
            _ => self.yff[t],
        }
    }

    /// Forecast for hour `tgt` issued at hour `issue`, in the units of the series
    pub fn at(&self, issue: i32, tgt: i32) -> f64 {
        let t = wrap(tgt);
        let lead = (tgt - issue).max(0);
        match self.method {
            Method::Perfect => return self.act[t],
            _ if self.pv && self.ref_[t] <= 0.0 => return 0.0,
            Method::Persistence => return self.act[wrap(tgt - 24 * (lead / 24 + 1))],
            Method::Weekly => return self.act[wrap(tgt - 168 * (lead / 168 + 1))],
            Method::Ensemble => {
                let cum = if lead < 6 { &self.cum_err_intra } else { &self.cum_err_day };
                let (mut num, mut den) = (0.0, 0.0);
                for (m, mem) in self.members.iter().enumerate() {
                    let mse = rsum(&cum[m * (HOURS + 1)..(m + 1) * (HOURS + 1)], issue - ENS_WINDOW, issue) / f64::from(ENS_WINDOW);
                    let w = 1.0 / (mse + 1e-9 * self.ref_[t] * self.ref_[t] + 1e-12);
                    num += w * mem.at(issue, tgt);
                    den += w;
                }
                return crate::sim::mx(0.0, num / den);
            }
            _ => {}
        }
        let y = crate::sim::clamp(self.base(self.method, issue, tgt), 0.0, if self.pv { 1.35 } else { 5.0 });
        y * self.ref_[t]
    }
}
