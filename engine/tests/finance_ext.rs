//! Project finance beyond the annual model, on the synthetic simulation of tests/finance.rs: debt in semi-annual, quarterly and
//! monthly periods (sizing, sculpting, interest during construction, reserve account), a loan or tariff in another currency with
//! its sensitivity table, and the partnership flip. Each case is checked against values worked out by hand from the inputs.
use soloptima_engine::finance::{irr, parse_finance, run_finance, FinSim, FinYear};
use soloptima_engine::{Project, Value};

fn build(n: i32) -> (FinSim, FinSim) {
    let (mut h, mut b) = (FinSim::default(), FinSim::default());
    for i in 1..=n {
        let x = f64::from(i);
        let g = 1.02f64.powf(x);
        h.years.push(FinYear {
            served_site: 900000.0 * (1.0 - 0.004 * f64::from(i - 1)), re_fraction: 0.55 - 0.002 * x, pv_curtailed: 20000.0 + 300.0 * x,
            wind_curtailed: 1000.0 * f64::from(i % 3), gen_kwh: 400000.0 + 2000.0 * x, c_fuel: 380000.0 * g, c_om_dg: 40000.0 * g, c_carbon: 3000.0 * x,
            c_om_new: 70000.0 * g, c_replace: if i == 12 { 250000.0 } else { 0.0 }, c_salvage: 0.0,
        });
        b.years.push(FinYear { gen_kwh: 900000.0, c_fuel: 900000.0 * g, c_om_dg: 60000.0 * g, c_carbon: 5000.0 * x, ..Default::default() });
    }
    (h.capex_pv, h.capex_bess, h.capex_wind, h.capex_other) = (900000.0, 600000.0, 150000.0, 50000.0);
    (h, b)
}

fn run(js: &str) -> Value {
    let mut p = Project::default();
    p.econ.lifetime = 25;
    let (h, b) = build(25);
    run_finance(&p, &parse_finance(&Value::parse(js).unwrap()), &h, &b, 0.0)
}

fn with(base: &str, extra: &str) -> String { format!("{},{}", &base[..base.len() - 1], &extra[1..]) }
fn m(r: &Value, k: &str) -> f64 { r.at("metrics").get(k, f64::NAN) }
fn col(r: &Value, k: &str) -> Vec<f64> { r.at("years").arr().iter().map(|y| y.get(k, f64::NAN)).collect() }
fn pcol(r: &Value, k: &str) -> Vec<f64> { r.at("periods").arr().iter().map(|y| y.get(k, f64::NAN)).collect() }
fn close(a: f64, b: f64, rel: f64) -> bool { (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0) }

const PPA: &str = r#"{"model":"ppa","components":[{"v1":1.0}],"gearing":0.7,"sizing":"gearing","interest":0.08,"tenor":10,"construction_years":1,"dsra_months":6}"#;

#[test]
fn quarterly_annuity_pays_a_level_amount_and_repays_the_loan() {
    let r = run(&with(PPA, r#"{"debt_periods":4,"repayment":"annuity"}"#));
    let ds = pcol(&r, "debt_service");
    let d = m(&r, "debt");
    let i = 0.08 / 4.0;
    let pay = d * i / (1.0 - (1.0 + i).powi(-40));   // 40 quarters
    assert_eq!(ds.len(), 25 * 4);
    assert!(ds[..40].iter().all(|x| close(*x, pay, 1e-9)), "{} vs {pay}", ds[0]);
    assert!(ds[40..].iter().all(|x| *x == 0.0));
    let paid: f64 = pcol(&r, "principal").iter().sum();
    assert!(close(paid, d, 1e-9));
    // the year rows are the sums of their four quarters; the annual cover is CFADS over that sum
    let (yds, yint) = (col(&r, "debt_service"), col(&r, "interest"));
    let pint = pcol(&r, "interest");
    for t in 1..=10 {
        assert!(close(yds[t], 4.0 * pay, 1e-9));
        assert!(close(yint[t], pint[(t - 1) * 4..t * 4].iter().sum(), 1e-12));
    }
    // reserve at COD: six months = the next two quarters
    assert!(close(m(&r, "dsra_initial"), 2.0 * pay, 1e-9));
    // interest during construction: drawn in four equal parts at the start of each quarter, 2 % a quarter on the drawn balance
    assert!(close(m(&r, "idc"), d * 0.02 * (1.0 + 2.0 + 3.0 + 4.0) / 4.0, 1e-9));
    assert_eq!(m(&r, "debt_periods"), 4.0);
}

#[test]
fn monthly_equal_principal_and_a_reserve_in_fractions_of_a_period() {
    let r = run(&with(PPA, r#"{"debt_periods":12,"repayment":"equal","dsra_months":4}"#));
    let pr = pcol(&r, "principal");
    let d = m(&r, "debt");
    assert!(pr[..120].iter().all(|x| close(*x, d / 120.0, 1e-9)));
    let ds = pcol(&r, "debt_service");
    // reserve at COD = the next 4 monthly payments
    assert!(close(m(&r, "dsra_initial"), ds[..4].iter().sum(), 1e-12));
    // quarterly, 4 months = one quarter and a third of the next
    let q = run(&with(PPA, r#"{"debt_periods":4,"repayment":"equal","dsra_months":4}"#));
    let qd = pcol(&q, "debt_service");
    assert!(close(m(&q, "dsra_initial"), qd[0] + qd[1] / 3.0, 1e-12));
    // the reserve at each year end funds the next months; the year rows show it
    let dsra = col(&q, "dsra");
    assert!(close(dsra[1], qd[4] + qd[5] / 3.0, 1e-12));
}

#[test]
fn sculpted_periods_hold_the_target_cover_in_every_period() {
    let js = with(PPA, r#"{"debt_periods":2,"sizing":"dscr","repayment":"sculpted","dscr_target":1.3}"#);
    let r = run(&js);
    let d: Vec<f64> = pcol(&r, "dscr").into_iter().filter(|x| x.is_finite()).collect();
    assert_eq!(d.len(), 20);
    assert!(d.iter().all(|x| (x - 1.3).abs() < 0.01), "{d:?}");
    assert!((m(&r, "dscr_min_period") - 1.3).abs() < 0.01);
    // uneven months: the period CFADS follow the weights, so an annuity's lowest period cover falls below the annual one
    let season = r#"{"debt_periods":4,"repayment":"annuity","cfads_months":"1,1,1,2,2,2,1,1,1,0.5,0.5,0.5"}"#;
    let s = run(&with(PPA, season));
    let cf = pcol(&s, "cfads");
    let ycf = col(&s, "cfads");
    assert!(close(cf[0], ycf[1] * 3.0 / 13.5, 1e-12) && close(cf[1], ycf[1] * 6.0 / 13.5, 1e-12));
    assert!(m(&s, "dscr_min_period") < m(&s, "dscr_min"));
}

#[test]
fn a_loan_in_another_currency_at_a_flat_rate_is_the_annual_loan() {
    let base = run(PPA);
    let fx = run(&with(PPA, r#"{"fx_currency":"USD","debt_fx":true,"fx_rate":15500}"#));
    for k in ["equity_irr", "project_irr", "debt", "idc", "dscr_min", "llcr", "equity_npv"] {
        assert!(close(m(&base, k), m(&fx, k), 1e-9), "{k}: {} vs {}", m(&base, k), m(&fx, k));
    }
    assert!(close(m(&fx, "debt_in_fx") * 15500.0, m(&fx, "debt"), 1e-12));
    assert!(col(&fx, "fx_loss").iter().all(|x| *x == 0.0));
}

#[test]
fn a_weakening_currency_raises_the_cost_of_a_foreign_loan() {
    let js = with(PPA, r#"{"repayment":"equal","fx_currency":"USD","debt_fx":true,"fx_rate":10,"fx_mode":"escalate","fx_escalation":0.05}"#);
    let r = run(&js);
    let df = m(&r, "debt_in_fx");
    let (pr, loss, rate) = (col(&r, "principal"), col(&r, "fx_loss"), col(&r, "fx_rate"));
    for t in 1..=10 {
        let x = 10.0 * 1.05f64.powi(t as i32);
        assert!(close(rate[t], x, 1e-12));
        assert!(close(pr[t], df / 10.0 * x, 1e-9));   // the same principal in dollars costs more each year
        assert!(close(loss[t], df / 10.0 * (x - 10.0), 1e-9));
    }
    // the realised exchange loss is deductible
    let (eb, dep, int, tx) = (col(&r, "ebitda"), col(&r, "depreciation"), col(&r, "interest"), col(&r, "taxable"));
    for t in 1..=10 { assert!(close(tx[t], eb[t] - dep[t] - int[t] - loss[t], 1e-9)); }
    assert!(m(&r, "equity_irr") < m(&run(PPA), "equity_irr"));
    // the sensitivity: six shocks, the middle one the case itself, the equity return falls as the currency weakens
    let s = r.at("fx_sensitivity").arr();
    assert_eq!(s.len(), 6);
    assert_eq!(s[2].get("shock", 1.0), 0.0);
    assert_eq!(s[2].get("equity_irr", 0.0), m(&r, "equity_irr"));
    assert!(s.windows(2).all(|w| w[1].get("equity_irr", 0.0) < w[0].get("equity_irr", 0.0)));
    assert_eq!(r.at("fx_currency").str(), "USD");
}

#[test]
fn a_tariff_in_another_currency_is_converted_each_year() {
    let usd = run(r#"{"model":"ppa","components":[{"v1":0.5}],"fx_currency":"USD","tariff_fx":true,"fx_rate":2}"#);
    let loc = run(r#"{"model":"ppa","components":[{"v1":1.0}]}"#);
    assert_eq!(m(&usd, "equity_irr"), m(&loc, "equity_irr"));
    assert_eq!(m(&usd, "tariff_y1_fx"), 0.5);
    let tab = run(r#"{"model":"ppa","components":[{"v1":0.5}],"fx_currency":"USD","tariff_fx":true,"fx_rate":2,"fx_mode":"table","fx_table":[2.2,2.4]}"#);
    let tr = col(&tab, "tariff");
    assert!(close(tr[1], 1.1, 1e-12) && close(tr[2], 1.2, 1e-12) && close(tr[20], 1.2, 1e-12));
    // revenue in dollars: a weaker local currency raises the return
    let s = tab.at("fx_sensitivity").arr();
    assert!(s.windows(2).all(|w| w[1].get("equity_irr", 0.0) > w[0].get("equity_irr", 0.0)));
    // no currency code, no conversion
    let off = run(r#"{"model":"ppa","components":[{"v1":1.0}],"tariff_fx":true,"fx_rate":2}"#);
    assert_eq!(off.dump(), loc.dump());
}

const FLIP: &str = r#"{"model":"flip","components":[{"v1":1.0}],"gearing":0.3,"sizing":"gearing","tax_rate":0.21,"dep_method":"db","dep_life":5,"dep_life_bess":5,"te_share":0.6,"te_pre_cash":0.25,"te_pre_tax":0.99,"te_post_cash":0.05,"te_post_tax":0.05,"te_target_irr":0.07,"flip_year":5,"itc_pct":0.3}"#;

#[test]
fn partnership_flip_allocates_cash_and_tax_and_flips_at_the_target() {
    let r = run(FLIP);
    let (te, sp, eq) = (col(&r, "te_cf"), col(&r, "sponsor_cf"), col(&r, "equity_cf"));
    for t in 0..te.len() { assert!(close(eq[t], te[t] + sp[t], 1e-12)); }
    assert!(col(&r, "tax").iter().all(|x| *x == 0.0), "the partnership pays no tax of its own");
    let fy = m(&r, "flip_year") as usize;
    assert!(fy >= 5, "flip year {fy}");
    // the investor reaches 7 % in the flip year, not before (unless the earliest flip year holds it back)
    assert!(irr(&te[..=fy]).unwrap() >= 0.07);
    if fy > 5 { assert!(irr(&te[..fy]).is_none_or(|v| v < 0.07)); }
    let share = col(&r, "te_cash_share");
    assert!(share[1..=fy].iter().all(|x| *x == 0.25) && share[fy + 1..].iter().all(|x| *x == 0.05));
    // year 1 by hand: investor = 25 % of the distributed cash + 99 % x (credits - 21 % x taxable income)
    let (dist, ti, cr) = (col(&r, "distributable"), col(&r, "taxable"), col(&r, "tax_credits"));
    assert!(close(te[1], 0.25 * dist[1] + 0.99 * (cr[1] - 0.21 * ti[1]), 1e-12));
    assert!(close(sp[1], 0.75 * dist[1] + 0.01 * (cr[1] - 0.21 * ti[1]), 1e-12));
    // investment tax credit 30 % of hard capex (no contingency here), in year 1; half of it comes off the depreciation base
    let hard = 1_700_000.0;
    assert!(close(m(&r, "itc"), 0.3 * hard, 1e-12) && close(cr[1], 0.3 * hard, 1e-12));
    let dep: f64 = col(&r, "depreciation").iter().sum();
    let base = hard + m(&r, "idc") + m(&r, "financing_fee") - 0.5 * 0.3 * hard;
    assert!(close(dep, base, 1e-9), "{dep} vs {base}");
    assert!(close(m(&r, "te_investment"), 0.6 * m(&r, "equity"), 1e-12));
    assert!(m(&r, "te_irr").is_finite() && m(&r, "sponsor_irr").is_finite());
}

#[test]
fn flip_by_date_and_the_tariff_solved_for_the_sponsor() {
    let r = run(&with(FLIP, r#"{"flip_trigger":"year","flip_year":7}"#));
    assert_eq!(m(&r, "flip_year"), 7.0);
    let s = run(&with(FLIP, r#"{"solve":true,"target_irr":0.11}"#));
    assert!(s.at("solved").getb("ok", false));
    assert!((m(&s, "sponsor_irr") - 0.11).abs() < 1e-4, "{}", m(&s, "sponsor_irr"));
    // production tax credit: rate x delivered kWh x inflation index, for the credit years only
    let p = run(&with(FLIP, r#"{"itc_pct":0,"ptc_rate":0.0275,"ptc_years":10,"inflation":0.02}"#));
    let (cr, e) = (col(&p, "tax_credits"), col(&p, "energy"));
    assert!(close(cr[3], 0.0275 * e[3] * 1.02f64.powi(2), 1e-12));
    assert_eq!(cr[11], 0.0);
}

#[test]
fn new_inputs_are_parsed_with_limits() {
    let f = parse_finance(&Value::parse(r#"{"debt_periods":3,"cfads_months":"1 2 3","fx_rate":-4,"fx_table":"15000; 16000, x, -1","te_share":3,"flip_year":0}"#).unwrap());
    assert_eq!(f.debt_periods, 1);
    assert!(f.cfads_months.is_empty());   // twelve weights or none
    assert_eq!(f.fx_rate, 1.0);
    assert_eq!(f.fx_table, vec![15000.0, 16000.0]);
    assert_eq!((f.te_share, f.flip_year), (1.0, 1));
    assert!(!f.fx_on());
    let g = parse_finance(&Value::parse(r#"{"debt_periods":12,"cfads_months":[1,1,1,1,1,1,1,1,1,1,1,1],"fx_currency":" USD ","debt_fx":true}"#).unwrap());
    assert_eq!((g.debt_periods, g.cfads_months.len(), g.fx_currency.as_str()), (12, 12, "USD"));
    assert!(g.periodic_debt() && g.debt_in_fx());
}

#[test]
fn a_tariff_box_left_ticked_does_nothing_without_a_tariff_of_components() {
    let host = run(r#"{"model":"host"}"#);
    let left = run(r#"{"model":"host","fx_currency":"USD","tariff_fx":true,"fx_rate":2}"#);
    assert_eq!(left.dump(), host.dump());
    let dd = run(r#"{"model":"tpo","tariff_mode":"diesel_discount","fx_currency":"USD","tariff_fx":true,"fx_rate":2}"#);
    assert!(dd.at("fx_sensitivity").is_null() && dd.at("metrics").at("tariff_y1_fx").is_null());
}

#[test]
fn an_investor_that_pays_nothing_flips_at_the_earliest_year() {
    let r = run(&with(FLIP, r#"{"te_share":0,"flip_year":3}"#));
    assert_eq!(m(&r, "flip_year"), 3.0);
    assert_eq!(m(&r, "te_investment"), 0.0);
}
