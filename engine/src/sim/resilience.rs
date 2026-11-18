//! Outage survival (gap 17 of docs/LITERATURE.md, after Marqusee et al. 2021): for each start hour of year 1 and outages of 1 to
//! D hours, the probability that the plant, cut off from the grid, serves its critical load in full. It starts from the stored
//! energy the normal simulation had at that hour and runs PV, wind, the battery and the gensets that work.
//!
//! Gensets: each unit is available when the outage begins with probability OA (from the forced-outage rate and repair time),
//! starts with probability 1 - FTS and then runs for an exponential time of mean MTTF, so it is still working after d hours with
//! probability q(d) = OA (1 - FTS) e^(-d / MTTF), and a failed unit is not repaired within the outage. For every combination of
//! working units the outage is simulated with those units throughout; the number working at hour d is binomial with q(d) in
//! each group. More units never serve less (the rule below), and a unit that fails part way through ran before it failed, so
//! taking the units still working at hour d as working from the start gives a slightly low (safe) probability where the battery
//! bridges a gap between failures. It is exact without a battery. No random draws: the answer is the same every run.
//!
//! The outage dispatch, every hour: PV and wind to the critical load; the working gensets cover what is left and recharge the
//! battery from their spare capacity (units committed for that, at least their minimum loading); the battery covers the rest.
//! There is no spinning reserve, no ramp limit and no fuel limit.
use super::{clamp, mn, mx, simulate, Fleet, SimInput, Sizing};
use crate::json::{obj, Error, Value};
use crate::optimizer::Progress;
use crate::validate::need;
use crate::{Project, HOURS};
use rayon::prelude::*;
use std::sync::atomic::Ordering::Relaxed;

/// Every `stride` hours of year 1 a start, outages of 1 to `max_h` hours
#[derive(Debug, Clone, Copy)]
pub struct ResilienceSettings {
    pub stride: usize,
    pub max_h: usize,
}

impl Default for ResilienceSettings {
    fn default() -> Self { ResilienceSettings { stride: 1, max_h: 336 } }
}

/// The "resilience" block of a request: `stride` (1 to 168 h, default 1) and `max_h` (1 to 720 h, default 336)
pub fn parse_resilience(v: &Value) -> Result<ResilienceSettings, Error> {
    let d = ResilienceSettings::default();
    let (stride, max_h) = (v.get("stride", d.stride as f64), v.get("max_h", d.max_h as f64));
    need(stride.fract() == 0.0 && (1.0..=168.0).contains(&stride), "The resilience study needs a start every 1 to 168 hours.")?;
    need(max_h.fract() == 0.0 && (1.0..=720.0).contains(&max_h), "The longest outage of the resilience study must be 1 to 720 hours.")?;
    Ok(ResilienceSettings { stride: stride as usize, max_h: max_h as usize })
}

/// Outage lengths of the start-hour strip (cumulative survival of every start at each)
const STRIP_H: [usize; 14] = [1, 2, 4, 8, 12, 24, 48, 72, 96, 168, 240, 336, 504, 720];

/// Binomial probability of k of n units working, each with probability q (log form, so large fleets do not overflow)
fn binom(n: i32, k: i32, q: f64, lnf: &[f64]) -> f64 {
    if q <= 0.0 { return if k == 0 { 1.0 } else { 0.0 }; }
    if q >= 1.0 { return if k == n { 1.0 } else { 0.0 }; }
    let (n, k) = (n as usize, k as usize);
    (lnf[n] - lnf[k] - lnf[n - k] + k as f64 * q.ln() + (n - k) as f64 * (1.0 - q).ln()).exp()
}

/// The p-quantile of sorted values (linear between neighbours)
fn quantile(v: &[f32], p: f64) -> f64 {
    let x = p * (v.len() - 1) as f64;
    let (i, f) = (x.floor() as usize, x - x.floor());
    let a = f64::from(v[i]);
    if i + 1 < v.len() { a + (f64::from(v[i + 1]) - a) * f } else { a }
}

/// One start: per outage length d (index d - 1), the probability that the critical load was served in full in every hour so
/// far (cumulative), in hour d alone (hourly), and the expected share of the critical energy served so far
struct Start { cum: Vec<f32>, hourly: Vec<f64>, served: Vec<f64> }

/// The outage survival of size `s`; `inp` as for `simulate`. Progress counts the start hours; a cancel stops it.
pub fn resilience(p: &Project, inp: &SimInput, s: &Sizing, rs: &ResilienceSettings, prog: &Progress) -> Result<Value, Error> {
    // Year 1 as the plant normally runs: the stored energy at the start of each hour, the PV and wind, the load
    let mut q = p.clone();
    q.sim.all_years = false;
    let r = simulate(&q, inp, s, true)?;
    let h = r.hourly.as_ref().expect("hourly series");
    let crit = p.sim.critical_share;
    // the critical load: the critical share of the site load and the auxiliaries (the shed load of critical-only supply is in
    // load; a deferrable load is not, it waits for the outage to end)
    let site = |t: usize| h.load[t] - h.dl_at(t);
    let ckw: Vec<f64> = (0..HOURS).map(|t| site(t) - (1.0 - crit) * (site(t) - h.aux[t])).collect();
    let re: Vec<f64> = (0..HOURS).map(|t| h.pv_avail[t] + h.wind_avail[t]).collect();

    let bp = &p.bess;
    let has_bess = s.has_bess();
    let enom = if has_bess { s.bess_kwh * bp.soh_init } else { 0.0 };
    let (emin, emax, pb, eta) = (enom * bp.soc_min, enom * bp.soc_max, if has_bess { s.bess_kw } else { 0.0 }, bp.rte.sqrt());
    let e_at = |t: usize| if !has_bess { 0.0 } else if t == 0 { clamp(s.bess_kwh * bp.soc_init, emin, emax) } else { clamp(h.soc[t - 1] * enom, emin, emax) };

    // The gensets: every combination of working units of each group (merit order), and its chance at each outage length
    let dgs = s.diesel(&p.dg);
    let dg = &*dgs;
    let fleet = Fleet::new(dg, &p.econ)?;
    let units: Vec<i32> = fleet.groups.iter().map(|g| g.units.max(0)).collect();
    let n_combo = units.iter().try_fold(1usize, |a, &n| a.checked_mul(n as usize + 1)).unwrap_or(usize::MAX);
    need(n_combo <= 1024, "The resilience study handles fleets of up to 1024 combinations of working units (the units of each group plus one, multiplied).")?;
    let combos: Vec<Vec<i32>> = (0..n_combo).map(|mut i| {
        let mut c = vec![0; units.len()];
        for g in (0..units.len()).rev() { let b = units[g] as usize + 1; c[g] = (i % b) as i32; i /= b; }
        c
    }).collect();
    let fleets: Vec<Fleet> = combos.iter().map(|c| fleet.with_available(c)).collect();
    let oa = if dg.outage_rate > 0.0 { 1.0 / (1.0 + dg.outage_rate * dg.repair_h / HOURS as f64) } else { 1.0 };
    let mttf = if dg.mttf_h > 0.0 { dg.mttf_h } else if dg.outage_rate > 0.0 { HOURS as f64 / dg.outage_rate } else { f64::INFINITY };
    let dmax = rs.max_h;
    let rel: Vec<f64> = (1..=dmax).map(|d| oa * (1.0 - dg.fail_start) * (-(d as f64) / mttf).exp()).collect();
    let nmax = units.iter().copied().max().unwrap_or(0).max(0) as usize;
    let mut lnf = vec![0.0; nmax + 1];
    for k in 1..=nmax { lnf[k] = lnf[k - 1] + (k as f64).ln(); }
    // prob[d * n_combo + c]: combination c working at the end of hour d + 1
    let prob: Vec<f64> = rel.iter().flat_map(|&qd| combos.iter().map(|c| c.iter().zip(&units).map(|(&k, &n)| binom(n, k, qd, &lnf)).product::<f64>()).collect::<Vec<_>>()).collect();
    let live: Vec<bool> = (0..n_combo).map(|c| (0..dmax).any(|d| prob[d * n_combo + c] > 0.0)).collect();

    let starts: Vec<usize> = (0..HOURS).step_by(rs.stride).collect();
    prog.total.store(starts.len() as i64, Relaxed);
    prog.done.store(0, Relaxed);
    let sd = if has_bess { bp.self_discharge } else { 0.0 };
    let one = |s0: usize| -> Option<Start> {
        if prog.cancel.load(Relaxed) { return None; }
        let (mut cum, mut hourly, mut served) = (vec![0.0f64; dmax], vec![0.0f64; dmax], vec![0.0f64; dmax]);
        let mut crit_e = vec![0.0; dmax];
        let mut acc = 0.0;
        for (k, c) in crit_e.iter_mut().enumerate() { acc += ckw[(s0 + k) % HOURS]; *c = acc; }
        let mut whole: Vec<usize> = Vec::new();   // combinations that serve every hour of the longest outage
        for ci in 0..n_combo {
            if !live[ci] { continue; }
            // more working units never serve less, so one that covers a combination that held throughout holds too
            if whole.iter().any(|&w| combos[w].iter().zip(&combos[ci]).all(|(a, b)| a <= b)) {
                for d in 0..dmax { let pr = prob[d * n_combo + ci]; cum[d] += pr; hourly[d] += pr; served[d] += pr; }
                continue;
            }
            let fl = &fleets[ci];
            let (mut e, mut failed, mut got) = (e_at(s0), false, 0.0);
            for k in 0..dmax {
                let t = (s0 + k) % HOURS;
                if sd > 0.0 { e -= e * sd; }
                let net = ckw[t] - re[t];
                let ch_cap = mn(pb, mx(0.0, emax - e) / eta);
                let (mut ch, mut dis, mut unmet) = (0.0, 0.0, 0.0);
                if net > 0.0 {
                    // the working gensets cover the load and recharge the battery from their spare capacity
                    let need_kw = net + ch_cap;
                    let u = mn(fl.units_for(need_kw), fl.units);
                    let g = if u > 0 { clamp(need_kw, fl.gmin(u), fl.cap(u)) } else { 0.0 };
                    let g_load = mn(g, net);
                    ch = mn(g - g_load, ch_cap);
                    dis = mn(net - g_load, mn(pb, mx(0.0, e - emin) * eta));
                    unmet = net - g_load - dis;
                } else if ch_cap > 0.0 {
                    ch = mn(-net, ch_cap);
                }
                e = clamp(e + ch * eta - dis / eta, 0.0, mx(emax, 0.0));
                let ok = unmet <= 1e-3 * ckw[t];   // as a loss-of-load hour: more than 0.1 % unserved
                failed |= !ok;
                got += ckw[t] - unmet;
                let pr = prob[k * n_combo + ci];
                if !failed { cum[k] += pr; }
                if ok { hourly[k] += pr; }
                served[k] += pr * if crit_e[k] > 0.0 { got / crit_e[k] } else { 1.0 };
            }
            if !failed { whole.push(ci); }
        }
        prog.done.fetch_add(1, Relaxed);
        let c01 = |v: Vec<f64>| v.into_iter().map(|x| clamp(x, 0.0, 1.0)).collect::<Vec<f64>>();
        Some(Start { cum: c01(cum).into_iter().map(|x| x as f32).collect(), hourly: c01(hourly), served: c01(served) })
    };
    // In blocks of start hours: each start's cumulative survival is kept (for the percentiles and the strip), the rest summed
    let mut res: Vec<Vec<f32>> = Vec::with_capacity(starts.len());
    let (mut h_min, mut h_sum, mut s_sum) = (vec![1.0f64; dmax], vec![0.0f64; dmax], vec![0.0f64; dmax]);
    for block in starts.chunks(1024) {
        let part: Vec<Option<Start>> = block.par_iter().map(|&s0| one(s0)).collect();
        for x in part {
            let Some(x) = x else { return Err(Error("Cancelled.".into())) };
            for d in 0..dmax { h_min[d] = h_min[d].min(x.hourly[d]); h_sum[d] += x.hourly[d]; s_sum[d] += x.served[d]; }
            res.push(x.cum);
        }
    }

    // Over the start hours, for each outage length
    let n = res.len() as f64;
    let (mut c_min, mut c_p5, mut c_mean, mut c_below) = (vec![], vec![], vec![], vec![]);
    let mut col: Vec<f32> = Vec::with_capacity(res.len());
    for d in 0..dmax {
        col.clear();
        col.extend(res.iter().map(|x| x[d]));
        col.sort_by(f32::total_cmp);
        c_min.push(f64::from(col[0]));
        c_p5.push(quantile(&col, 0.05));
        c_mean.push(col.iter().map(|&x| f64::from(x)).sum::<f64>() / n);
        c_below.push(col.iter().filter(|&&x| x < 0.9).count() as f64 / n);
    }
    let (h_mean, s_mean): (Vec<f64>, Vec<f64>) = (h_sum.iter().map(|x| x / n).collect(), s_sum.iter().map(|x| x / n).collect());
    let mut sd_h: Vec<usize> = STRIP_H.iter().copied().filter(|&d| d <= dmax).collect();
    if sd_h.last() != Some(&dmax) { sd_h.push(dmax); }
    let round3 = |x: f32| (f64::from(x) * 1000.0).round() / 1000.0;
    let strip = obj(vec![
        ("durations", Value::from(sd_h.iter().map(|&d| d as f64).collect::<Vec<f64>>())),
        ("values", Value::Arr(sd_h.iter().map(|&d| Value::from(res.iter().map(|x| round3(x[d - 1])).collect::<Vec<f64>>())).collect())),
    ]);
    Ok(obj(vec![
        ("stride", (rs.stride as f64).into()), ("max_h", (dmax as f64).into()), ("starts", n.into()),
        ("critical_share", crit.into()), ("critical_kw_mean", (ckw.iter().sum::<f64>() / HOURS as f64).into()),
        ("units", (units.iter().sum::<i32>() as f64).into()), ("fail_start", dg.fail_start.into()),
        ("mttf_h", if mttf.is_finite() { Value::Num(mttf) } else { Value::Null }), ("availability", oa.into()),
        ("unit_reliability", Value::from(rel)),
        ("cum", obj(vec![("min", Value::from(c_min)), ("p5", Value::from(c_p5)), ("mean", Value::from(c_mean)), ("below90", Value::from(c_below))])),
        ("hourly", obj(vec![("min", Value::from(h_min)), ("mean", Value::from(h_mean))])),
        ("served_mean", Value::from(s_mean)),
        ("strip", strip),
    ]))
}
