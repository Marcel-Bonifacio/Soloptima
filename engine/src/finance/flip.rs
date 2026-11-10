//! The partnership flip between a tax equity investor and a sponsor, who own the project company; it pays no income tax itself. Distributed
//! cash, taxable income and tax credits are allocated to the two partners, the investor taking most of the tax and some of the
//! cash until it reaches its target return (or a fixed year), and a small share of both afterwards.
use super::compute::Out;
use super::{irr, npv, FinanceParams};
use crate::pv::min;

/// Investment tax credit (year 1) and production tax credit (per kWh delivered, indexed with inflation) of each year
pub fn credits(f: &FinanceParams, hard_cont: f64, energy: &[f64]) -> Vec<f64> {
    let mut c = vec![0.0; energy.len()];
    if c.len() > 1 { c[1] = f.itc_pct * hard_cont; }
    for t in 1..c.len() {
        if t as i32 <= f.ptc_years { c[t] += f.ptc_rate * energy[t] * (1.0 + f.inflation).powf(t as f64 - 1.0); }
    }
    c
}

/// Splits the equity cash flow `o.eq_cf` (the partnership's distributable cash, no entity tax) between the partners, finds the
/// flip, and replaces `o.eq_cf` by the sum of both partners' after-tax cash flows.
pub(super) fn partners(o: &mut Out, f: &FinanceParams) {
    let t_end = o.eq_cf.len() - 1;
    let z = || vec![0.0; t_end + 1];
    let (mut tc, mut tt, mut sc, mut st, mut share) = (z(), z(), z(), z(), z());
    let (mut te, mut sp) = (z(), z());
    o.dist = o.eq_cf.clone();
    o.te_inv = -f.te_share * o.eq_cf[0];
    o.sp_inv = -(1.0 - f.te_share) * o.eq_cf[0];
    te[0] = -o.te_inv;
    sp[0] = -o.sp_inv;
    let rate = f.tax_rate;
    let (mut flipped, mut losses, mut cr_pool) = (false, 0.0, 0.0);
    o.flip_year = 0;
    for t in 1..=t_end {
        let (c, x) = if flipped { (f.te_post_cash, f.te_post_tax) } else { (f.te_pre_cash, f.te_pre_tax) };
        share[t] = c;
        let (ti, cr) = (o.taxable[t], o.credits[t]);
        tc[t] = c * o.dist[t];
        tt[t] = x * (cr - rate * ti);   // positive = tax saved by the investor
        sc[t] = (1.0 - c) * o.dist[t];
        st[t] = if f.sponsor_tax_use { (1.0 - x) * (cr - rate * ti) } else {
            // the sponsor carries its losses and credits forward against its later share of taxable income
            let (mut own, own_cr) = ((1.0 - x) * ti, (1.0 - x) * cr);
            if own < 0.0 { losses -= own; own = 0.0; } else { let u = min(losses, own); losses -= u; own -= u; }
            cr_pool += own_cr;
            let due = rate * own;
            let used = min(cr_pool, due);
            cr_pool -= used;
            -(due - used)
        };
        te[t] = tc[t] + tt[t];
        sp[t] = sc[t] + st[t];
        if !flipped && t as i32 >= f.flip_year {
            let hit = f.flip_trigger == "year" || irr(&te[..=t]).is_some_and(|v| v >= f.te_target_irr);
            if hit { flipped = true; o.flip_year = t as i32; }
        }
    }
    o.te_irr = irr(&te).unwrap_or(f64::NAN);
    o.sp_irr = irr(&sp).unwrap_or(f64::NAN);
    o.te_npv = npv(&te, f.te_target_irr);
    o.sp_npv = npv(&sp, f.equity_discount);
    for t in 0..=t_end { o.eq_cf[t] = te[t] + sp[t]; }
    (o.te_cash, o.te_tax, o.sp_cash, o.sp_tax, o.te_cf, o.sp_cf, o.te_share) = (tc, tt, sc, st, te, sp, share);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two partners, a 3-year project: hand-checked allocations and a flip in year 2
    #[test]
    fn allocations_and_flip_by_hand() {
        let f = FinanceParams { model: "flip".into(), tax_rate: 0.2, te_share: 0.5, te_pre_cash: 0.2, te_pre_tax: 0.9, te_post_cash: 0.1,
            te_post_tax: 0.1, flip_trigger: "irr".into(), te_target_irr: 0.0, flip_year: 1, ..Default::default() };
        let mut o = Out { eq_cf: vec![-100.0, 50.0, 60.0, 70.0], taxable: vec![0.0, -100.0, 20.0, 40.0], credits: vec![0.0, 30.0, 0.0, 0.0], ..Default::default() };
        partners(&mut o, &f);
        // year 1 (before the flip): investor cash 0.2 x 50 = 10, tax 0.9 x (30 + 0.2 x 100) = 45; investor -50 + 55 > 0, so it flips
        assert!((o.te_cash[1] - 10.0).abs() < 1e-12 && (o.te_tax[1] - 45.0).abs() < 1e-12);
        assert!((o.sp_cash[1] - 40.0).abs() < 1e-12 && (o.sp_tax[1] - 5.0).abs() < 1e-12);
        assert_eq!(o.flip_year, 1);
        // year 2 (after): investor 0.1 x 60 = 6 cash, 0.1 x (-0.2 x 20) = -0.4 tax
        assert!((o.te_cf[2] - 5.6).abs() < 1e-12);
        assert!((o.sp_cf[2] - (54.0 - 3.6)).abs() < 1e-12);
        for t in 0..4 { assert!((o.eq_cf[t] - o.te_cf[t] - o.sp_cf[t]).abs() < 1e-12); }
        assert_eq!(o.te_inv, 50.0);
    }

    #[test]
    fn sponsor_without_tax_capacity_carries_forward() {
        let f = FinanceParams { model: "flip".into(), tax_rate: 0.25, te_share: 0.0, te_pre_cash: 0.0, te_pre_tax: 0.0, flip_trigger: "year".into(),
            flip_year: 40, sponsor_tax_use: false, ..Default::default() };
        let mut o = Out { eq_cf: vec![-10.0, 0.0, 0.0, 0.0], taxable: vec![0.0, -40.0, 30.0, 30.0], credits: vec![0.0, 4.0, 0.0, 0.0], ..Default::default() };
        partners(&mut o, &f);
        // year 1: loss 40 and credit 4 carried; year 2: 30 - 30 = 0 taxable; year 3: 30 - 10 = 20 x 0.25 = 5, less the credit 4 = 1
        assert_eq!(o.sp_tax[1..].to_vec(), vec![0.0, 0.0, -1.0]);
        assert_eq!(o.flip_year, 0);
    }
}
