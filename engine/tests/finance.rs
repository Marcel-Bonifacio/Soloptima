//! Project finance against the C++ engine: tests/gen_finance_fixtures.cpp ran `run_finance` on a synthetic simulation for the
//! finance blocks below and wrote the hash and the metrics of each answer (engine/tests/fixtures/finance.json).
use soloptima_engine::finance::{irr, npv, parse_finance, payback, run_finance, FinSim, FinYear};
use soloptima_engine::{Project, Value};
use std::path::PathBuf;

fn fnv(s: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    format!("{h:016x}")
}

/// The synthetic hybrid and diesel-only simulations of the generator
fn build(n: i32) -> (FinSim, FinSim) {
    let (mut h, mut b) = (FinSim::default(), FinSim::default());
    for i in 1..=n {
        let x = f64::from(i);
        let g = 1.02f64.powf(x);
        h.years.push(FinYear {
            served_site: 900000.0 * (1.0 - 0.004 * f64::from(i - 1)),
            re_fraction: 0.55 - 0.002 * x,
            pv_curtailed: 20000.0 + 300.0 * x,
            wind_curtailed: 1000.0 * f64::from(i % 3),
            gen_kwh: 400000.0 + 2000.0 * x,
            c_fuel: 380000.0 * g,
            c_om_dg: 40000.0 * g,
            c_carbon: 3000.0 * x,
            c_om_new: 70000.0 * g,
            c_replace: if i == 12 { 250000.0 } else if i == 8 { 90000.0 } else { 0.0 },
            c_salvage: if i == n { -150000.0 } else { 0.0 },
        });
        b.years.push(FinYear { gen_kwh: 900000.0 * (1.0 - 0.004 * f64::from(i - 1)), c_fuel: 900000.0 * g, c_om_dg: 60000.0 * g, c_carbon: 5000.0 * x, ..Default::default() });
    }
    h.capex_pv = 900000.0;
    h.capex_bess = 600000.0;
    h.capex_wind = 150000.0;
    h.capex_other = 50000.0;
    (h, b)
}

/// (name, finance block, simulated years, project lifetime, tariff scale)
fn cases() -> Vec<(&'static str, &'static str, i32, i32, f64)> {
    vec![
        ("host", r#"{"model":"host"}"#, 25, 25, 0.0),
        ("host no debt", r#"{"model":"host","gearing":0}"#, 25, 25, 0.0),
        ("ppa sculpted", r#"{"model":"ppa","components":[{"name":"E","v1":0.2}],"sizing":"dscr","repayment":"sculpted","dscr_target":1.35,"tenor":10,"interest":0.08,"construction_years":1}"#, 25, 25, 0.0),
        ("ppa solve equity", r#"{"model":"ppa","components":[{"name":"E","v1":0.1}],"solve":true,"target_irr":0.13,"gearing":0.6,"sizing":"gearing","repayment":"annuity"}"#, 25, 25, 0.0),
        ("ppa solve project", r#"{"model":"ppa","components":[{"v1":0.1}],"solve":true,"solve_for":"project","target_irr":0.09}"#, 25, 25, 0.0),
        ("ppa solve unreachable", r#"{"model":"ppa","components":[{"v1":0.001}],"solve":true,"target_irr":0.9}"#, 25, 25, 0.0),
        ("ppa solve with scale", r#"{"model":"ppa","components":[{"v1":0.1}],"solve":true,"target_irr":0.13}"#, 25, 25, 1.37),
        ("ppa loss cf 0 db", r#"{"model":"ppa","components":[{"v1":0.2}],"loss_cf_years":0,"dep_method":"db","dep_life":4,"gearing":0.8}"#, 25, 25, 0.0),
        ("ppa loss cf -1 db", r#"{"model":"ppa","components":[{"v1":0.2}],"loss_cf_years":-1,"dep_method":"db","dep_life":4,"gearing":0.8}"#, 25, 25, 0.0),
        ("ppa loss cf 2 db", r#"{"model":"ppa","components":[{"v1":0.12}],"loss_cf_years":2,"dep_method":"db","dep_life":6,"gearing":0.8}"#, 25, 25, 0.0),
        ("ppa two stages indexed adder", r#"{"model":"ppa","components":[{"v1":0.10,"v2":0.12,"idx":0.01},{"v1":0.03,"idx":0.02},{"pct":0.3}],"stage2_year":8}"#, 25, 25, 0.0),
        ("ppa diesel discount", r#"{"model":"ppa","tariff_mode":"diesel_discount","diesel_discount":0.15}"#, 25, 25, 0.0),
        ("tpo", r#"{"model":"tpo","components":[{"v1":0.22}],"tariff_vat":0.11}"#, 25, 25, 0.0),
        ("ppa top deemed penalty", r#"{"model":"ppa","components":[{"v1":0.2}],"take_or_pay":0.97,"ace_factor":1.05,"deemed_share":0.5,"penalty_threshold":0.9,"penalty_rate":0.5}"#, 25, 25, 0.0),
        ("ppa sme 31e", r#"{"model":"ppa","components":[{"v1":0.2}],"sme_31e":true,"sme_low":300000,"sme_high":50000000}"#, 25, 25, 0.0),
        ("ppa tax holiday wht", r#"{"model":"ppa","components":[{"v1":0.2}],"tax_holiday_years":3,"wht_pct":0.02}"#, 25, 25, 0.0),
        ("host not taxable", r#"{"model":"host","host_taxable":false}"#, 25, 25, 0.0),
        ("sizing dscr", r#"{"model":"ppa","components":[{"v1":0.2}],"sizing":"dscr","dscr_target":1.5}"#, 25, 25, 0.0),
        ("sizing min", r#"{"model":"ppa","components":[{"v1":0.2}],"sizing":"min","gearing":0.9}"#, 25, 25, 0.0),
        ("repayment equal grace", r#"{"model":"ppa","components":[{"v1":0.2}],"repayment":"equal","grace":2,"tenor":12}"#, 25, 25, 0.0),
        ("repayment annuity zero rate", r#"{"model":"ppa","components":[{"v1":0.2}],"repayment":"annuity","interest":0}"#, 25, 25, 0.0),
        ("construction 0", r#"{"model":"ppa","components":[{"v1":0.2}],"construction_years":0}"#, 25, 25, 0.0),
        ("construction 3", r#"{"model":"ppa","components":[{"v1":0.2}],"construction_years":9}"#, 25, 25, 0.0),
        ("vat recoverable", r#"{"model":"host","vat_pct":0.11,"vat_recoverable":true,"contingency_pct":0.05,"land":40000,"dev_fixed":60000}"#, 25, 25, 0.0),
        ("vat not recoverable", r#"{"model":"host","vat_pct":0.11,"contingency_pct":0.05}"#, 25, 25, 0.0),
        ("working capital", r#"{"model":"ppa","components":[{"v1":0.2}],"receivable_days":45,"payable_days":30}"#, 25, 25, 0.0),
        ("terminal transfer", r#"{"model":"ppa","components":[{"v1":0.2}],"terminal":"transfer"}"#, 25, 25, 0.0),
        ("p90 factor", r#"{"model":"ppa","components":[{"v1":0.2}],"p90_factor":0.9,"sizing":"dscr"}"#, 25, 25, 0.0),
        ("term 10", r#"{"model":"ppa","components":[{"v1":0.2}],"term":10,"tenor":15}"#, 25, 25, 0.0),
        ("term over years", r#"{"model":"host","term":40}"#, 20, 25, 0.0),
        ("lifetime 15", r#"{"model":"host"}"#, 25, 15, 0.0),
        ("fixed costs and lease", r#"{"model":"ppa","components":[{"v1":0.2}],"fixed_opex":20000,"land_lease":10000,"insurance_pct":0.01}"#, 25, 25, 0.0),
        ("no energy tariff zero", r#"{"model":"ppa","components":[{"v1":0}]}"#, 25, 25, 0.0),
        ("defaults ppa", r#"{"model":"ppa"}"#, 25, 25, 0.0),
        ("parse limits", r#"{"model":"ppa","gearing":2,"tenor":99,"grace":50,"dscr_target":0.5,"dep_life":0,"dep_life_bess":-3,"construction_years":-1}"#, 25, 25, 0.0),
        ("inflation and discount", r#"{"model":"ppa","components":[{"v1":0.2}],"inflation":0.06,"equity_discount":0.15}"#, 25, 25, 0.0),
        ("interest high", r#"{"model":"ppa","components":[{"v1":0.05}],"interest":0.2,"gearing":0.8}"#, 25, 25, 0.0),
    ]
}

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/finance.json");
    Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn run(js: &str, years: i32, lifetime: i32, scale: f64) -> Value {
    let mut p = Project::default();
    p.econ.lifetime = lifetime;
    let (h, b) = build(years);
    run_finance(&p, &parse_finance(&Value::parse(js).unwrap()), &h, &b, scale)
}

#[test]
fn every_finance_case_gives_what_the_cpp_engine_gives() {
    let want = fixture();
    let cs = cases();
    assert_eq!(cs.len() + 1, want.len());
    for ((name, js, years, life, scale), w) in cs.iter().zip(want.arr()) {
        assert_eq!(*name, w.at("name").str());
        let r = run(js, *years, *life, *scale);
        assert_eq!(r.at("metrics").dump(), w.at("metrics").str(), "metrics of {name}");
        assert_eq!(r.at("solved").dump(), w.at("solved").str(), "solver of {name}");
        assert_eq!(fnv(&r.dump()), w.at("hash").str(), "answer of {name}");
    }
}

#[test]
fn cash_flow_measures_match_the_cpp_ones() {
    let want = fixture();
    let series: [&[f64]; 8] = [&[-100.0, 30.0, 40.0, 50.0, 60.0], &[-100.0, 10.0, 10.0, 10.0], &[50.0, 10.0], &[-100.0, 200.0], &[-100.0, -10.0, -5.0], &[0.0, 0.0],
        &[-1e6, 3e5, 3e5, 3e5, 3e5, 3e5], &[100.0, -50.0, -50.0, -50.0, 400.0]];
    let w = want.arr().last().unwrap().at("series");
    for (s, x) in series.iter().zip(w.arr()) {
        assert_eq!(npv(s, 0.0), x.get("npv0", f64::NAN));
        assert_eq!(npv(s, 0.08), x.get("npv8", f64::NAN));
        assert_eq!(npv(s, -0.5), x.get("npv_neg", f64::NAN));
        assert_eq!(irr(s), if x.at("irr").is_null() { None } else { Some(x.get("irr", 0.0)) }, "{s:?}");
        assert_eq!(payback(s), x.get("payback", f64::NAN));
    }
}

// the checks of tests/test_engine.cpp
fn years(r: &Value) -> &[Value] { r.at("years").arr() }

#[test]
fn sculpted_debt_is_repaid_with_a_flat_dscr_and_the_equity_npv_is_zero_at_the_irr() {
    let r = run(r#"{"model":"ppa","components":[{"name":"E","v1":0.2}],"sizing":"dscr","repayment":"sculpted","dscr_target":1.35,"tenor":10,"interest":0.08,"construction_years":1}"#, 25, 25, 0.0);
    let d: Vec<f64> = years(&r).iter().filter(|y| !y.at("dscr").is_null()).map(|y| y.get("dscr", 0.0)).collect();
    assert!(d.iter().all(|x| (x - 1.35).abs() < 0.01), "{d:?}");
    let paid: f64 = years(&r).iter().map(|y| y.get("principal", 0.0)).sum();
    assert!((paid - r.at("metrics").get("debt", 0.0)).abs() < 1e-3 * paid.max(1.0));
    let eq: Vec<f64> = years(&r).iter().map(|y| y.get("equity_cf", 0.0)).collect();
    let rate = r.at("metrics").get("equity_irr", 0.0);
    assert!(npv(&eq, rate).abs() < 1e-3 * eq[0].abs());
}

#[test]
fn the_tariff_solver_hits_the_target_and_loss_carry_forward_lowers_tax() {
    let s = run(r#"{"model":"ppa","components":[{"name":"E","v1":0.1}],"solve":true,"target_irr":0.13,"gearing":0.6,"sizing":"gearing","repayment":"annuity"}"#, 25, 25, 0.0);
    assert!(s.at("solved").getb("ok", false) && (s.at("metrics").get("equity_irr", 0.0) - 0.13).abs() < 1e-4);
    let tax = |cf: i32| -> f64 {
        let js = r#"{"model":"ppa","components":[{"name":"E","v1":0.2}],"dep_method":"db","dep_life":4,"gearing":0.8,"loss_cf_years":CF}"#.replace("CF", &cf.to_string());
        years(&run(&js, 25, 25, 0.0)).iter().map(|y| y.get("tax", 0.0)).sum()
    };
    assert!(tax(0) <= tax(-1), "{} vs {}", tax(0), tax(-1));
}

#[test]
fn host_revenue_is_the_avoided_diesel_cost() {
    let r = run(r#"{"model":"host","gearing":0}"#, 25, 25, 0.0);
    let (h, b) = build(25);
    let want = b.years[0].c_fuel + b.years[0].c_om_dg + b.years[0].c_carbon - h.years[0].c_fuel - h.years[0].c_om_dg - h.years[0].c_carbon;
    let y1 = &years(&r)[1];
    assert!((y1.get("revenue", 0.0) - want).abs() < 1e-6 * want);
}

