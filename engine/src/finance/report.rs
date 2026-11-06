//! `run_finance`: the tariff solver and the JSON answer (src/finance.cpp).
use super::compute::{compute, Out};
use super::{FinSim, FinanceParams};
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
            let x = if f.solve_for == "project" { o.proj_irr } else { o.eq_irr };
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
        years.push(y);
    }
    let cum = |cf: &[f64]| { let mut c = 0.0; Value::Arr(cf.iter().map(|x| { c += x; Value::Num(c) }).collect()) };
    let mut m = Value::object();
    metrics(&mut m, &o, scale, t_end);
    let mut out = Value::object();
    out.set("model", f.model.clone());
    out.set("years", years);
    out.set("equity_cum", cum(&o.eq_cf));
    out.set("project_cum", cum(&o.proj_cf));
    out.set("metrics", m);
    out.set("solved", solved);
    out
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
