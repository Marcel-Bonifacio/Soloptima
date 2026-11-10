//! The annual cash-flow model of one finance case (`compute` of src/finance.cpp): capital cost, revenue by structure, costs,
//! tax, debt sized and scheduled by iteration, equity and project returns, levelised values. Debt in periods or in another currency
//! is scheduled in `debt.rs`, the exchange rate path is `fx.rs`, and the partnership flip splits the equity in `flip.rs`.
use super::debt::{self, Period};
use super::params::clamp;
use super::{flip, fx, irr, npv, payback, FinSim, FinanceParams};
use crate::model::{pv_degradation_factor, Project};

#[derive(Default)]
pub struct Out {
    pub energy: Vec<f64>, pub billed: Vec<f64>, pub ace: Vec<f64>, pub tariff: Vec<f64>, pub revenue: Vec<f64>, pub opex: Vec<f64>,
    pub opex_sim: Vec<f64>, pub replace: Vec<f64>, pub fixed: Vec<f64>, pub insurance: Vec<f64>, pub ebitda: Vec<f64>, pub dep: Vec<f64>,
    pub interest: Vec<f64>, pub taxable: Vec<f64>, pub tax: Vec<f64>, pub wht: Vec<f64>, pub cfads: Vec<f64>, pub ds: Vec<f64>,
    pub principal: Vec<f64>, pub bal: Vec<f64>, pub dscr: Vec<f64>, pub dsra: Vec<f64>, pub dwc: Vec<f64>, pub eq_cf: Vec<f64>,
    pub proj_cf: Vec<f64>, pub net_income: Vec<f64>, pub host_base: Vec<f64>, pub host_cost: Vec<f64>, pub host_save: Vec<f64>,
    pub tic: f64, pub hard: f64, pub debt: f64, pub idc: f64, pub fee: f64, pub vat: f64, pub terminal: f64,
    pub eq_irr: f64, pub proj_irr: f64, pub eq_npv: f64, pub proj_npv: f64, pub eq_payback: f64, pub proj_payback: f64,
    pub dscr_min: f64, pub dscr_avg: f64, pub llcr: f64, pub lppa_nom: f64, pub lppa_real: f64, pub lcoe_nom: f64, pub lcoe_real: f64, pub pln_level: f64,
    pub host_npv: f64, pub host_pct: f64, pub debt_dscr_cap: f64,
    /// debt periods and the other currency: the exchange rate and realised exchange loss of each year, the opening balance in
    /// the loan currency, the periods, the lowest period cover and the loan in its own currency
    pub fx: Vec<f64>, pub fx_loss: Vec<f64>, pub bal_fx: Vec<f64>, pub periods: Vec<Period>, pub dscr_min_period: f64, pub debt_fx: f64,
    /// partnership flip: tax credits, distributable cash, each partner's cash, tax effect and cash flow, the investor's cash share
    pub credits: Vec<f64>, pub dist: Vec<f64>, pub te_cash: Vec<f64>, pub te_tax: Vec<f64>, pub te_cf: Vec<f64>, pub sp_cash: Vec<f64>,
    pub sp_tax: Vec<f64>, pub sp_cf: Vec<f64>, pub te_share: Vec<f64>,
    pub te_irr: f64, pub sp_irr: f64, pub te_npv: f64, pub sp_npv: f64, pub te_inv: f64, pub sp_inv: f64, pub flip_year: i32, pub itc: f64,
}

use crate::pv::{max, min};
use crate::weather::max0;

/// Depreciation schedule for one asset class. db: declining balance at 2/life, switching to straight line on the remaining value
/// when that is larger (fully depreciated by the end of the life), as allowed for Indonesian groups.
fn depreciation(base: f64, life: i32, method: &str, t_end: usize) -> Vec<f64> {
    let mut d = vec![0.0; t_end + 1];
    if base <= 0.0 || life <= 0 { return d; }
    let db = method == "db";
    let mut rem = base;
    for t in 1..=t_end {
        if t as i32 > life { break; }
        let x = min(if db { max(rem * 2.0 / f64::from(life), rem / f64::from(life - t as i32 + 1)) } else { base / f64::from(life) }, rem);
        d[t] = x;
        rem -= x;
    }
    d
}

/// Loss carry-forward with expiry, tax holiday, Art. 31E (reduced rate on small turnover)
fn tax_of(f: &FinanceParams, host: bool, revenue: &[f64], taxable: &[f64], tax: &mut [f64]) {
    let t_end = taxable.len() - 1;
    let mut losses: Vec<(i32, f64)> = Vec::new();   // (year incurred, remaining loss)
    for t in 1..=t_end {
        let mut ti = taxable[t];
        if ti < 0.0 {
            if f.loss_cf_years >= 0 { losses.push((t as i32, -ti)); }
            tax[t] = 0.0;
            continue;
        }
        for l in losses.iter_mut() {
            if f.loss_cf_years > 0 && t as i32 - l.0 > f.loss_cf_years { continue; }
            let used = min(l.1, ti);
            l.1 -= used;
            ti -= used;
        }
        let mut rate = if (host && !f.host_taxable) || t as i32 <= f.tax_holiday_years { 0.0 } else { f.tax_rate };
        if f.sme_31e && revenue[t] > 0.0 && revenue[t] <= f.sme_high { rate *= 1.0 - 0.5 * min(1.0, f.sme_low / revenue[t]); }
        tax[t] = max0(rate * ti);
    }
}

/// One pass of the annual loan schedule: sizes the loan, fills interest, principal, debt service, balance and the reserve account,
/// and returns the debt
fn annual_schedule(o: &mut Out, f: &FinanceParams, cfads_sz: &[f64], pre_fin: f64, t_end: usize, tenor: i32, grace: i32, n_rep: i32) -> f64 {
    let r = f.interest;
    // capacity of the cash flow to carry debt at the target DSCR (sculpted annuity value)
    let mut pv_ds = 0.0;
    let mut k = 1;
    while k <= n_rep && ((grace + k) as usize) <= t_end {
        pv_ds += max0(cfads_sz[(grace + k) as usize]) / f.dscr_target / (1.0 + r).powf(f64::from(k));
        k += 1;
    }
    o.debt_dscr_cap = pv_ds;
    o.tic = pre_fin + o.idc + o.fee + o.dsra[0];
    let d_gear = f.gearing * o.tic;
    let mut d_debt = if f.sizing == "dscr" { pv_ds } else if f.sizing == "min" { min(d_gear, pv_ds) } else { d_gear };
    d_debt = max0(min(d_debt, o.tic));
    o.idc = if f.construction_years > 0 { d_debt * r * 0.5 * f64::from(f.construction_years) } else { 0.0 };   // average drawn balance
    o.fee = f.upfront_fee * d_debt;
    // schedule
    let mut bal = d_debt;
    let ann = if r > 0.0 { d_debt * r / (1.0 - (1.0 + r).powf(-f64::from(n_rep))) } else { d_debt / f64::from(n_rep) };
    for t in 1..=t_end {
        o.bal[t] = bal;
        o.interest[t] = r * bal;
        let mut prin = 0.0;
        if t as i32 > grace && t as i32 <= tenor && bal > 1e-9 {
            prin = if f.repayment == "equal" { d_debt / f64::from(n_rep) }
                else if f.repayment == "annuity" { ann - o.interest[t] }
                else {
                    let ds = if pv_ds > 0.0 { max0(cfads_sz[t]) / f.dscr_target * (d_debt / pv_ds) } else { 0.0 };
                    ds - o.interest[t]
                };
            prin = clamp(prin, 0.0, bal);
            if t as i32 == tenor { prin = bal; }
        }
        o.principal[t] = prin;
        o.ds[t] = o.interest[t] + prin;
        bal -= prin;
    }
    // DSRA (dsra[0] funded at COD): next year's debt service x months/12, released when the loan is repaid
    for t in 0..t_end { o.dsra[t] = f.dsra_months / 12.0 * o.ds[t + 1]; }
    d_debt
}

pub fn compute(p: &Project, f: &FinanceParams, h: &FinSim, b: &FinSim, scale: f64) -> Out {
    let mut o = Out { eq_irr: f64::NAN, proj_irr: f64::NAN, eq_payback: -1.0, proj_payback: -1.0, dscr_min: f64::NAN, dscr_avg: f64::NAN, llcr: f64::NAN,
        lppa_nom: f64::NAN, lppa_real: f64::NAN, lcoe_nom: f64::NAN, lcoe_real: f64::NAN, pln_level: f64::NAN, dscr_min_period: f64::NAN,
        te_irr: f64::NAN, sp_irr: f64::NAN, ..Default::default() };
    let n_years = h.years.len();
    let t_end = (if f.term > 0 { f.term } else { p.econ.lifetime }).min(n_years as i32).max(1) as usize;
    let vec = || vec![0.0f64; t_end + 1];
    for v in [&mut o.energy, &mut o.billed, &mut o.ace, &mut o.tariff, &mut o.revenue, &mut o.opex, &mut o.opex_sim, &mut o.replace, &mut o.fixed,
              &mut o.insurance, &mut o.ebitda, &mut o.dep, &mut o.interest, &mut o.taxable, &mut o.tax, &mut o.wht, &mut o.cfads, &mut o.ds,
              &mut o.principal, &mut o.bal, &mut o.dscr, &mut o.dsra, &mut o.dwc, &mut o.eq_cf, &mut o.proj_cf, &mut o.net_income, &mut o.host_base,
              &mut o.host_cost, &mut o.host_save, &mut o.fx_loss, &mut o.bal_fx, &mut o.credits] {
        *v = vec();
    }
    let host = f.model == "host";
    let flip = f.flip();
    o.fx = fx::path(f, t_end);
    let debt_fx = if f.debt_in_fx() { o.fx.clone() } else { vec![1.0; t_end + 1] };
    let r = f.interest;

    let hard = h.capex_pv + h.capex_bess + h.capex_wind + h.capex_other;   // new assets only
    let bess_share = if hard > 0.0 { h.capex_bess / hard } else { 0.0 };
    let cont = hard * f.contingency_pct;
    o.vat = (hard + cont) * f.vat_pct;
    o.hard = hard;
    let pre_fin = hard + cont + f.land + f.dev_fixed + o.vat;   // before financing costs

    let e1 = h.years[0].served_site * h.years[0].re_fraction;   // auxiliary consumption is not billed
    for t in 1..=t_end {
        let (y, by) = (&h.years[t - 1], &b.years[t - 1]);
        let ti = t as i32;
        let esc = (1.0 + p.econ.om_escalation).powf(f64::from(ti - 1));
        o.energy[t] = y.served_site * y.re_fraction;   // renewable kWh delivered to the site load
        o.ace[t] = f.ace_factor * e1 * pv_degradation_factor(&p.pv, ti);
        o.host_base[t] = by.c_fuel + by.c_om_dg + by.c_carbon;   // diesel-only running cost
        let host_run = y.c_fuel + y.c_om_dg + y.c_carbon;   // diesel cost that remains with the hybrid
        if host {
            o.revenue[t] = o.host_base[t] - host_run;   // avoided diesel cost = the owner's "revenue"
            o.billed[t] = o.energy[t];
            o.tariff[t] = if o.energy[t] > 0.0 { o.revenue[t] / o.energy[t] } else { 0.0 };
        } else {
            let mut tariff;
            if f.tariff_mode == "diesel_discount" {
                let avoided_kwh = if by.gen_kwh > 0.0 { (by.c_fuel + by.c_om_dg) / by.gen_kwh } else { 0.0 };
                tariff = (1.0 - f.diesel_discount) * avoided_kwh;
            } else {
                let st2 = f.stage2_year > 0 && ti >= f.stage2_year;
                let mut fixed = 0.0;
                for c in &f.components { if c.pct <= 0.0 { fixed += (if st2 { c.v2 } else { c.v1 }) * (1.0 + c.idx).powf(f64::from(ti - 1)); } }
                let mut adders = 0.0;
                for c in &f.components { if c.pct > 0.0 { adders += c.pct * fixed; } }
                tariff = fixed + adders;
            }
            tariff *= scale;
            if f.tariff_in_fx() { tariff *= o.fx[t]; }
            let curtailed = y.pv_curtailed + y.wind_curtailed;
            o.billed[t] = max(o.energy[t], f.take_or_pay * o.ace[t]) + f.deemed_share * curtailed;
            let shortfall = max0(f.penalty_threshold * o.ace[t] - o.energy[t]);
            o.tariff[t] = tariff;
            o.revenue[t] = tariff * o.billed[t] - f.penalty_rate * tariff * shortfall;
            o.host_cost[t] = tariff * o.billed[t] * (1.0 + f.tariff_vat) + host_run - f.penalty_rate * tariff * shortfall;
            o.host_save[t] = o.host_base[t] - o.host_cost[t];
        }
        o.opex_sim[t] = y.c_om_new;
        o.replace[t] = y.c_replace;
        o.fixed[t] = (f.fixed_opex + f.land_lease) * esc;
        o.insurance[t] = f.insurance_pct * hard * esc;
        o.opex[t] = o.opex_sim[t] + o.replace[t] + o.fixed[t] + o.insurance[t];
        o.ebitda[t] = o.revenue[t] - o.opex[t];
        o.wht[t] = if host || flip { 0.0 } else { f.wht_pct * o.revenue[t] };   // a partnership pays no tax of its own
    }
    // working capital (receivables on revenue, payables on opex), released in the last year
    {
        let mut prev = 0.0;
        for t in 1..=t_end {
            let wc = f.receivable_days / 365.0 * o.revenue[t] - f.payable_days / 365.0 * o.opex[t];
            o.dwc[t] = wc - prev;
            prev = wc;
        }
        o.dwc[t_end] -= prev;
    }
    // terminal value: linear remaining life of the new assets, or zero for a transfer at the end of the term
    if f.terminal != "transfer" {
        let life = max(1.0, p.econ.pv_life);
        o.terminal = hard * (1.0 - bess_share) * max0((life - t_end as f64) / life);
        if t_end == n_years { o.terminal = max(o.terminal, -h.years[t_end - 1].c_salvage); }
    }

    // Depreciation bases: financing costs are capitalised into the main asset class; land and recoverable VAT are not depreciable
    let vat = o.vat;
    if flip {
        o.credits = flip::credits(f, hard + cont, &o.energy);
        o.itc = f.itc_pct * (hard + cont);
    }
    let itc_cut = f.itc_basis_cut * o.itc;   // the investment tax credit reduces the depreciation base
    let dep_for = |idc_fee: f64| {
        let cap_vat = if f.vat_recoverable { 0.0 } else { vat };
        let mut base_bess = (hard + cont + cap_vat) * bess_share;
        let mut base_main = (hard + cont + cap_vat) * (1.0 - bess_share) + f.dev_fixed + idc_fee;
        if itc_cut > 0.0 { base_bess -= itc_cut * bess_share; base_main -= itc_cut * (1.0 - bess_share); }
        let mut d1 = depreciation(base_main, f.dep_life, &f.dep_method, t_end);
        let d2 = depreciation(base_bess, f.dep_life_bess, &f.dep_method, t_end);
        for t in 0..=t_end { d1[t] += d2[t]; }
        d1
    };
    let vat_back = |t: usize| if f.vat_recoverable && t == 1 { vat } else { 0.0 };

    {
        let dep = dep_for(0.0);
        let mut ti = vec![0.0; t_end + 1];
        let mut tx = vec![0.0; t_end + 1];
        for t in 1..=t_end { ti[t] = o.ebitda[t] - dep[t]; }
        tax_of(f, host, &o.revenue, &ti, &mut tx);
        o.proj_cf[0] = -pre_fin;
        for t in 1..=t_end {
            // a partnership's partners use its losses and credits as they arise
            let paid = if flip { f.tax_rate * ti[t] - o.credits[t] } else { max(tx[t], o.wht[t]) };
            o.proj_cf[t] = o.ebitda[t] - paid - o.dwc[t] + vat_back(t);
            if t == t_end { o.proj_cf[t] += o.terminal; }
        }
    }

    // Debt sizing and schedule (iterated: tax depends on interest, sculpting depends on CFADS)
    let tenor = f.tenor.min(t_end as i32);
    let grace = f.grace.min(tenor - 1);
    let n_rep = (tenor - grace).max(1);
    let mut cfads_sz = vec![0.0; t_end + 1];
    for t in 1..=t_end { cfads_sz[t] = o.ebitda[t] - (1.0 - f.p90_factor) * o.revenue[t]; }   // first pass: pre-tax
    let mut d_debt = 0.0;
    for _ in 0..8 {
        d_debt = if f.periodic_debt() { debt::schedule(&mut o, f, &cfads_sz, &debt_fx, pre_fin, t_end) }
            else { annual_schedule(&mut o, f, &cfads_sz, pre_fin, t_end, tenor, grace, n_rep) };
        // levered tax and CFADS
        o.dep = dep_for(o.idc + o.fee);
        for t in 1..=t_end { o.taxable[t] = o.ebitda[t] - o.dep[t] - o.interest[t]; }
        if f.debt_in_fx() { for t in 1..=t_end { o.taxable[t] -= o.fx_loss[t]; } }
        let revenue = o.revenue.clone();
        let taxable = o.taxable.clone();
        if !flip { tax_of(f, host, &revenue, &taxable, &mut o.tax); }
        for t in 1..=t_end {
            let tax_cash = max0(o.tax[t] - o.wht[t]);   // withholding is a creditable prepayment
            o.cfads[t] = o.ebitda[t] - o.wht[t] - tax_cash - o.dwc[t] + vat_back(t);
            o.net_income[t] = o.taxable[t] - o.tax[t];
            // sizing case: optionally haircut revenue to a P90 energy level
            cfads_sz[t] = o.cfads[t] - (1.0 - f.p90_factor) * o.revenue[t];
        }
    }
    o.debt = d_debt;
    o.tic = pre_fin + o.idc + o.fee + o.dsra[0];

    // Equity cash flow and returns
    o.eq_cf[0] = -(o.tic - d_debt);
    for t in 1..=t_end { o.eq_cf[t] = o.cfads[t] - o.ds[t] - (o.dsra[t] - o.dsra[t - 1]) + if t == t_end { o.terminal } else { 0.0 }; }
    if flip { flip::partners(&mut o, f); }
    let (mut mn, mut sm, mut nd) = (1e300f64, 0.0, 0);
    for t in 1..=t_end {
        if o.ds[t] > 1e-6 {
            o.dscr[t] = o.cfads[t] / o.ds[t];
            mn = min(mn, o.dscr[t]);
            sm += o.dscr[t];
            nd += 1;
        }
    }
    if let Some(v) = irr(&o.eq_cf) { o.eq_irr = v; }
    if let Some(v) = irr(&o.proj_cf) { o.proj_irr = v; }
    o.eq_npv = npv(&o.eq_cf, f.equity_discount);
    o.proj_npv = npv(&o.proj_cf, p.econ.discount_rate);
    o.eq_payback = payback(&o.eq_cf);
    o.proj_payback = payback(&o.proj_cf);
    if nd > 0 { o.dscr_min = mn; o.dscr_avg = sm / f64::from(nd); }
    if f.periodic_debt() { debt::finish(&mut o, f, &debt_fx, d_debt); }
    else if d_debt > 0.0 {
        let mut pv = 0.0;
        for t in 1..=(tenor as usize) { pv += o.cfads[t] / (1.0 + r).powf(t as f64); }
        o.llcr = pv / d_debt;
    }
    // levelised values: costs and revenue at the nominal rate; energy at the nominal rate for the nominal value and at the
    // inflation-adjusted rate for the real value
    let dn = p.econ.discount_rate;
    let dr = (1.0 + dn) / (1.0 + f.inflation) - 1.0;
    let lev = |num: &[f64], den: &[f64], d_energy: f64| { let c = npv(den, d_energy); if c > 0.0 { npv(num, dn) / c } else { f64::NAN } };
    o.lppa_nom = lev(&o.revenue, &o.billed, dn);
    o.lppa_real = lev(&o.revenue, &o.billed, dr);
    let mut cost = vec![0.0; t_end + 1];
    cost[0] = pre_fin;
    for t in 1..=t_end { cost[t] = o.opex[t] - if t == t_end { o.terminal } else { 0.0 } - vat_back(t); }
    o.lcoe_nom = lev(&cost, &o.energy, dn);
    o.lcoe_real = lev(&cost, &o.energy, dr);
    {   // PLN-style levelised tariff: annuity of the tariff series (not energy weighted)
        let pv = npv(&o.tariff, dn);
        o.pln_level = if dn > 0.0 { pv * dn / (1.0 - (1.0 + dn).powf(-(t_end as f64))) } else { pv / t_end as f64 };
    }
    if !host {
        o.host_npv = npv(&o.host_save, dn);
        let (mut sb, mut ss) = (0.0, 0.0);
        for t in 1..=t_end { sb += o.host_base[t]; ss += o.host_save[t]; }
        o.host_pct = if sb > 0.0 { ss / sb } else { 0.0 };
    }
    o
}
