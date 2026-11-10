//! `run_finance`: the tariff solver and the JSON answer (src/finance.cpp).
use super::compute::{compute, Out};
use super::{fx, FinSim, FinanceParams};
use crate::json::Value;
use crate::model::Project;

fn num_or_null(x: f64) -> Value { if x.is_finite() { Value::Num(x) } else { Value::Null } }

/// hybrid: simulation of the configured system; base: diesel-only simulation (same fleet, same rules). tariff_scale > 0: use this
/// multiplier of the input tariff instead of solving it (f.solve), e.g. the scale solved for the P50 case when the same contract is
/// evaluated in other weather years.
pub fn run_finance(p: &Project, f: &FinanceParams, h: &FinSim, b: &FinSim, tariff_scale: f64) -> Value {
    let mut scale = if tariff_scale > 0.0 { tariff_scale } else { 1.0 };
    let mut solved = Value::Null;
    if f.solve && f.model != "host" && !(tariff_scale > 0.0) {
        // bisection on a multiplier of the tariff so that the chosen IRR hits the target (IRR rises with the tariff)
        let metric = |s: f64| {
            let o = compute(p, f, h, b, s);
            // in a partnership flip the equity target is the sponsor's return
            let x = if f.solve_for == "project" { o.proj_irr } else if f.flip() { o.sp_irr } else { o.eq_irr };
            if x.is_finite() { x } else { -1.0 }
        };
        let (mut lo, mut hi) = (0.0f64, 1.0f64);
        let mut m_hi = metric(hi);
        while m_hi < f.target_irr && hi < 64.0 { hi *= 2.0; m_hi = metric(hi); }
        if m_hi >= f.target_irr {
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if metric(mid) < f.target_irr { lo = mid; } else { hi = mid; }
            }
            scale = hi;
            let mut s = Value::object();
            s.set("scale", scale);
            s.set("ok", true);
            solved = s;
        } else {
            let mut s = Value::object();
            s.set("ok", false);
            s.set("reason", "Target IRR not reached with up to 64 times the input tariff.");
            solved = s;
        }
    }
    let o = compute(p, f, h, b, scale);
    let t_end = o.revenue.len() - 1;
    let mut years = Value::array();
    for t in 0..=t_end {
        let mut y = Value::object();
        for (k, v) in [("year", t as f64), ("energy", o.energy[t]), ("billed", o.billed[t]), ("ace", o.ace[t]), ("tariff", o.tariff[t]), ("revenue", o.revenue[t]),
            ("opex_om", o.opex_sim[t]), ("replacements", o.replace[t]), ("fixed_opex", o.fixed[t]), ("insurance", o.insurance[t]), ("opex", o.opex[t]),
            ("ebitda", o.ebitda[t]), ("depreciation", o.dep[t]), ("interest", o.interest[t]), ("taxable", o.taxable[t]), ("tax", o.tax[t]),
            ("wht", o.wht[t]), ("net_income", o.net_income[t]), ("cfads", o.cfads[t]), ("principal", o.principal[t]), ("debt_service", o.ds[t]),
            ("debt_balance", o.bal[t]), ("dsra", o.dsra[t]), ("d_wc", o.dwc[t]), ("equity_cf", o.eq_cf[t]), ("project_cf", o.proj_cf[t]),
            ("host_baseline", o.host_base[t]), ("host_cost", o.host_cost[t]), ("host_saving", o.host_save[t])] {
            y.set(k, v);
        }
        y.set("dscr", if o.ds[t] > 1e-6 { Value::Num(o.dscr[t]) } else { Value::Null });
        if f.fx_on() {
            y.set("fx_rate", o.fx[t]);
            if f.debt_in_fx() { y.set("fx_loss", o.fx_loss[t]); y.set("debt_balance_fx", o.bal_fx[t]); }
        }
        if f.flip() {
            for (k, v) in [("tax_credits", &o.credits), ("distributable", &o.dist), ("te_cash", &o.te_cash), ("te_tax", &o.te_tax), ("te_cf", &o.te_cf),
                ("sponsor_cash", &o.sp_cash), ("sponsor_tax", &o.sp_tax), ("sponsor_cf", &o.sp_cf), ("te_cash_share", &o.te_share)] {
                y.set(k, v[t]);
            }
        }
        years.push(y);
    }
    let cum = |cf: &[f64]| { let mut c = 0.0; Value::Arr(cf.iter().map(|x| { c += x; Value::Num(c) }).collect()) };
    let mut m = Value::object();
    metrics(&mut m, &o, scale, t_end);
    if f.debt_periods > 1 {
        m.set("debt_periods", f.debt_periods);
        m.set("dscr_min_period", num_or_null(o.dscr_min_period));
    }
    if f.fx_on() {
        m.set("fx_rate_cod", o.fx[0]);
        m.set("fx_rate_end", o.fx[t_end]);
        if f.debt_in_fx() { m.set("debt_in_fx", o.debt_fx); }
        if f.tariff_in_fx() && o.fx[1] > 0.0 { m.set("tariff_y1_fx", o.tariff[1] / o.fx[1]); }
    }
    if f.flip() {
        for (k, v) in [("te_irr", num_or_null(o.te_irr)), ("sponsor_irr", num_or_null(o.sp_irr)), ("te_npv", Value::Num(o.te_npv)), ("sponsor_npv", Value::Num(o.sp_npv)),
            ("te_investment", Value::Num(o.te_inv)), ("sponsor_investment", Value::Num(o.sp_inv)), ("itc", Value::Num(o.itc)),
            ("tax_credits_total", Value::Num(o.credits.iter().sum())),
            ("flip_year", if o.flip_year > 0 { Value::Num(f64::from(o.flip_year)) } else { Value::Null })] {
            m.set(k, v);
        }
    }
    let mut out = Value::object();
    out.set("model", f.model.clone());
    out.set("years", years);
    out.set("equity_cum", cum(&o.eq_cf));
    out.set("project_cum", cum(&o.proj_cf));
    out.set("metrics", m);
    out.set("solved", solved);
    if f.debt_periods > 1 { out.set("periods", periods(&o, f.debt_periods)); }
    if f.fx_on() {
        out.set("fx_currency", f.fx_currency.clone());
        out.set("fx_sensitivity", fx_sensitivity(p, f, h, b, scale, &o));
    }
    out
}

/// The debt periods: period number, year, CFADS, interest, principal, debt service, opening balance, reserve at the end, cover
fn periods(o: &Out, m: i32) -> Value {
    let mut a = Value::array();
    for (k, p) in o.periods.iter().enumerate() {
        let mut v = Value::object();
        for (key, x) in [("period", (k + 1) as f64), ("year", p.year as f64), ("month", (k % m as usize) as f64 * 12.0 / f64::from(m) + 1.0), ("cfads", p.cfads),
            ("interest", p.interest), ("principal", p.principal), ("debt_service", p.ds), ("debt_balance", p.bal), ("debt_balance_fx", p.bal_fx), ("dsra", p.dsra)] {
            v.set(key, x);
        }
        v.set("dscr", num_or_null(p.dscr));
        a.push(v);
    }
    a
}

/// The returns and the cover with the exchange rate of every operating year moved by each shock of `fx::SHOCKS`, the tariff
/// kept at the given scale (the contract does not change with the rate); `base` is the case itself, the shock of 1
fn fx_sensitivity(p: &Project, f: &FinanceParams, h: &FinSim, b: &FinSim, scale: f64, base: &Out) -> Value {
    let mut a = Value::array();
    for s in fx::SHOCKS {
        let shocked;
        let o = if s == 1.0 { base } else { shocked = compute(p, &FinanceParams { fx_shock: s, ..f.clone() }, h, b, scale); &shocked };
        let mut v = Value::object();
        v.set("shock", s - 1.0);
        v.set("fx_rate_y1", o.fx[1]);
        v.set("equity_irr", num_or_null(o.eq_irr));
        v.set("project_irr", num_or_null(o.proj_irr));
        v.set("equity_npv", o.eq_npv);
        v.set("dscr_min", num_or_null(if f.debt_periods > 1 { o.dscr_min_period } else { o.dscr_min }));
        if f.flip() { v.set("sponsor_irr", num_or_null(o.sp_irr)); v.set("te_irr", num_or_null(o.te_irr)); }
        a.push(v);
    }
    a
}

fn metrics(m: &mut Value, o: &Out, scale: f64, t_end: usize) {
    m.set("tariff_y1", o.tariff[1]);
    m.set("tariff_scale", scale);
    m.set("lppa_nominal", num_or_null(o.lppa_nom));
    m.set("lppa_real", num_or_null(o.lppa_real));
    m.set("lcoe_nominal", num_or_null(o.lcoe_nom));
    m.set("lcoe_real", num_or_null(o.lcoe_real));
    m.set("pln_levelised_tariff", num_or_null(o.pln_level));
    m.set("equity_irr", num_or_null(o.eq_irr));
    m.set("project_irr", num_or_null(o.proj_irr));
    m.set("equity_npv", o.eq_npv);
    m.set("project_npv", o.proj_npv);
    m.set("equity_payback", if o.eq_payback >= 0.0 { Value::Num(o.eq_payback) } else { Value::Null });
    m.set("project_payback", if o.proj_payback >= 0.0 { Value::Num(o.proj_payback) } else { Value::Null });
    m.set("dscr_min", num_or_null(o.dscr_min));
    m.set("dscr_avg", num_or_null(o.dscr_avg));
    m.set("llcr", num_or_null(o.llcr));
    m.set("debt", o.debt);
    m.set("debt_fraction", if o.tic > 0.0 { o.debt / o.tic } else { 0.0 });
    m.set("debt_dscr_capacity", o.debt_dscr_cap);
    m.set("equity", o.tic - o.debt);
    m.set("total_installed_cost", o.tic);
    m.set("hard_capex", o.hard);
    m.set("idc", o.idc);
    m.set("financing_fee", o.fee);
    m.set("dsra_initial", o.dsra[0]);
    m.set("vat_capex", o.vat);
    m.set("terminal_value", o.terminal);
    m.set("host_npv_savings", o.host_npv);
    m.set("host_saving_pct", o.host_pct);
    m.set("term", t_end);
}
