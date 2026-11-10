//! The loan scheduled in periods inside the annual model: semi-annual, quarterly or monthly debt service, and a loan in another
//! currency. Sizing, sculpting, interest during construction and the reserve account follow the periods; the annual rows of the
//! cash flow are the sums over the periods of each year.
use super::compute::Out;
use super::params::clamp;
use super::FinanceParams;
use crate::pv::min;
use crate::weather::max0;

/// One debt period: amounts in the project currency at the rate of its year
#[derive(Debug, Clone, Default)]
pub struct Period {
    pub year: usize,
    pub cfads: f64,
    pub interest: f64,
    pub principal: f64,
    pub ds: f64,
    /// opening balance, in the project currency and in the loan currency
    pub bal: f64,
    pub bal_fx: f64,
    /// reserve account at the end of the period
    pub dsra: f64,
    /// CFADS / debt service; NaN when nothing is due
    pub dscr: f64,
}

/// Share of the year's CFADS in each of the m periods: the monthly weights summed over the months of the period, or even
pub fn period_weights(f: &FinanceParams, m: usize) -> Vec<f64> {
    if f.cfads_months.len() != 12 { return vec![1.0 / m as f64; m]; }
    let total: f64 = f.cfads_months.iter().sum();
    let k = 12 / m;
    (0..m).map(|j| f.cfads_months[j * k..(j + 1) * k].iter().sum::<f64>() / total).collect()
}

/// Sizes and schedules the loan for one pass of the fixed-point iteration of `compute`, and returns the debt in the project
/// currency at COD. `cfads_sz` is the annual CFADS of the sizing case; `fx` the rate of each year (all 1 for a loan in the
/// project currency). Fills the debt rows of `o`, the reserve account at each year end and `o.periods`.
pub(super) fn schedule(o: &mut Out, f: &FinanceParams, cfads_sz: &[f64], fx: &[f64], pre_fin: f64, t_end: usize) -> f64 {
    let m = f.debt_periods.max(1) as usize;
    let r = f.interest;
    let i = r / m as f64;   // nominal annual rate over the periods
    let w = period_weights(f, m);
    let n_per = t_end * m;
    let tenor = f.tenor.min(t_end as i32).max(1) as usize;
    let grace = f.grace.min(tenor as i32 - 1).max(0) as usize;
    let (n_ten, n_gr) = (tenor * m, grace * m);
    let n_rep = (n_ten - n_gr).max(1);
    let fx0 = fx[0];
    let yr = |p: usize| (p - 1) / m + 1;
    // CFADS of the sizing case per period, in the loan currency
    let cs: Vec<f64> = (0..=n_per).map(|p| if p == 0 { 0.0 } else { cfads_sz[yr(p)] * w[(p - 1) % m] / fx[yr(p)] }).collect();
    let mut pv = 0.0;
    for k in 1..=n_rep {
        let p = n_gr + k;
        if p > n_per { break; }
        pv += max0(cs[p]) / f.dscr_target / (1.0 + i).powf(k as f64);
    }
    o.debt_dscr_cap = pv * fx0;
    o.tic = pre_fin + o.idc + o.fee + o.dsra[0];
    let d_gear = f.gearing * o.tic;
    let mut d = if f.sizing == "dscr" { o.debt_dscr_cap } else if f.sizing == "min" { min(d_gear, o.debt_dscr_cap) } else { d_gear };
    d = max0(min(d, o.tic));
    // interest during construction: annual periods keep the average drawn balance; shorter periods draw the loan in equal parts
    // at the start of each construction period and pay the interest on the drawn balance from the loan
    let cy = f64::from(f.construction_years);
    let n_c = f.construction_years.max(0) as usize * m;
    o.idc = if n_c == 0 { 0.0 } else if m == 1 { d * r * 0.5 * cy } else { d * i * (n_c + 1) as f64 / 2.0 };
    o.fee = f.upfront_fee * d;
    let df = d / fx0;
    o.debt_fx = df;
    let ann = if i > 0.0 { df * i / (1.0 - (1.0 + i).powf(-(n_rep as f64))) } else { df / n_rep as f64 };
    for v in [&mut o.bal, &mut o.interest, &mut o.principal, &mut o.ds, &mut o.fx_loss, &mut o.bal_fx] { v.iter_mut().for_each(|x| *x = 0.0); }
    o.periods.clear();
    let mut bal = df;
    for p in 1..=n_per {
        let t = yr(p);
        let x = fx[t];
        let int_f = i * bal;
        let mut prin = 0.0;
        if p > n_gr && p <= n_ten && bal > 1e-9 {
            prin = if f.repayment == "equal" { df / n_rep as f64 }
                else if f.repayment == "annuity" { ann - int_f }
                else { (if pv > 0.0 { max0(cs[p]) / f.dscr_target * (df / pv) } else { 0.0 }) - int_f };
            prin = clamp(prin, 0.0, bal);
            if p == n_ten { prin = bal; }
        }
        if (p - 1) % m == 0 { o.bal[t] = bal * x; o.bal_fx[t] = bal; }
        o.interest[t] += int_f * x;
        o.principal[t] += prin * x;
        o.fx_loss[t] += prin * (x - fx0);   // realised exchange loss on the principal repaid (gain if negative)
        o.periods.push(Period { year: t, interest: int_f * x, principal: prin * x, ds: (int_f + prin) * x, bal: bal * x, bal_fx: bal, dscr: f64::NAN, ..Default::default() });
        bal -= prin;
    }
    for t in 1..=t_end { o.ds[t] = o.interest[t] + o.principal[t]; }
    // reserve account: the debt service of the next `dsra_months` months (fractions of a period pro rata)
    let q = f.dsra_months * m as f64 / 12.0;
    let next = |start: usize| {
        let (mut left, mut s, mut p) = (q, 0.0, start);
        while left > 1e-12 && p <= n_per { let take = left.min(1.0); s += take * o.periods[p - 1].ds; left -= take; p += 1; }
        s
    };
    let ends: Vec<f64> = (1..=n_per).map(|p| next(p + 1)).collect();
    for t in 0..t_end { o.dsra[t] = next(t * m + 1); }
    o.dsra[t_end] = 0.0;
    for (p, e) in o.periods.iter_mut().zip(ends) { p.dsra = e; }
    d
}

/// After the last pass: CFADS and cover of each period, the lowest period cover, and the LLCR in the loan currency
pub(super) fn finish(o: &mut Out, f: &FinanceParams, fx: &[f64], d_debt: f64) {
    let m = f.debt_periods.max(1) as usize;
    let w = period_weights(f, m);
    let mut mn = f64::INFINITY;
    for (k, p) in o.periods.iter_mut().enumerate() {
        p.cfads = o.cfads[p.year] * w[k % m];
        if p.ds > 1e-6 { p.dscr = p.cfads / p.ds; mn = min(mn, p.dscr); }
    }
    o.dscr_min_period = if mn.is_finite() { mn } else { f64::NAN };
    if d_debt > 0.0 {
        let tenor = f.tenor.min(o.cfads.len() as i32 - 1).max(1) as usize;
        let mut pv = 0.0;
        for t in 1..=tenor { pv += o.cfads[t] / fx[t] / (1.0 + f.interest).powf(t as f64); }
        o.llcr = pv / (d_debt / fx[0]);
    }
}
