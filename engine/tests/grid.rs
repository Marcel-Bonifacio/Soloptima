//! Grid connection in the dispatch: merit order against the gensets, import and export limits, outages, costs and the
//! project finance, on the example project with the fixture PV (common/mod.rs).
mod common;
use common::*;
use soloptima_engine::sim::{summary_json, Hourly, SimResult};
use soloptima_engine::{Project, HOURS};

fn with_grid(price: f64, imp: f64, exp: f64) -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q.grid.enabled = true;
    q.grid.import_price = price;
    q.grid.import_kw = imp;
    q.grid.export_kw = exp;
    q.grid.export_price = 0.05;
    q
}

/// Load = PV + wind + battery + gensets + grid import + unmet, and PV = to load + to battery + exported + curtailed, every hour
fn grid_balance(h: &Hourly) -> f64 {
    let mut e = 0.0f64;
    for t in 0..HOURS {
        e = e.max((h.load[t] - (h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.grid_import[t] + h.unmet[t])).abs());
        e = e.max((h.pv_avail[t] - (h.pv_to_load[t] + h.pv_to_bess[t] + h.grid_export[t] + h.pv_curtailed[t])).abs());
    }
    e
}

fn check(q: &Project, r: &SimResult) {
    let h = r.hourly.as_ref().unwrap();
    assert!(grid_balance(h) < 0.05, "balance {}", grid_balance(h));
    for t in 0..HOURS {
        assert!(h.grid_import[t] <= q.grid.import_kw + 1e-9 && h.grid_export[t] <= q.grid.export_kw + 1e-9, "limits at {t}");
        if h.grid_up[t] < 0.5 { assert!(h.grid_import[t] == 0.0 && h.grid_export[t] == 0.0, "flow while the grid is down at {t}"); }
        if h.gen_units[t] > 0.0 {
            let g = h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t];
            assert!(g >= h.gen_units[t] * q.dg.unit_kw * q.dg.min_load - 1e-6 && g <= h.gen_units[t] * q.dg.unit_kw + 1e-6, "genset loading at {t}");
        }
    }
}

#[test]
fn a_cheap_strong_grid_replaces_the_gensets_and_takes_the_surplus() {
    let q = with_grid(0.05, 1e6, 1e6);
    let r = run(&q, size(60000.0, 6600.0, 2320.0), true);   // twice the example's PV, so some is left over
    check(&q, &r);
    let (y, h) = (&r.years[0], r.hourly.as_ref().unwrap());
    assert_eq!(y.gen_kwh, 0.0, "no genset runs while a cheaper grid is up");
    assert!(h.gen_units.iter().all(|u| *u == 0.0), "no unit has to stay online");
    assert!(y.unmet < 1e-6 && y.pv_curtailed < 1e-6, "unmet {} curtailed {}", y.unmet, y.pv_curtailed);
    assert!(y.grid_import > 0.0 && y.grid_export > 0.0);
    assert!((y.re_fraction - (1.0 - y.grid_import / y.served)).abs() < 1e-12, "grid imports are not renewable");
    assert!(y.reserve_short_h == 0.0, "the grid carries the reserve");
    // costs: energy, demand charge on monthly peaks, export revenue, all in the year's total
    assert!((y.c_grid_import - y.grid_import * 0.05).abs() < 1e-6 * y.c_grid_import);
    assert!((y.c_grid_export - y.grid_export * 0.05).abs() < 1e-6 * y.c_grid_export);
    assert_eq!(y.c_grid_demand, 0.0);
    assert!((y.c_grid - (y.c_grid_import - y.c_grid_export)).abs() < 1e-6);
    // the finance sees the net grid cost as a running cost of the host
    let f = r.fin_sim();
    assert!((f.years[0].c_om_dg - (y.c_om_dg + y.c_grid)).abs() < 1e-9);
    assert_eq!(f.years[0].gen_kwh, y.gen_kwh + y.grid_import);
    // the energy flow closes with the grid on both sides
    let s = summary_json(&q.bess, &r);
    assert!(s.at("flow").get("gap", 1.0).abs() < 1e-3 * y.load, "flow gap {}", s.at("flow").get("gap", 1.0));
    assert_eq!(s.at("flow").get("grid_in", -1.0), y.grid_import);
    let m = s.at("monthly").arr();
    assert!((m[12].get("grid", 0.0) - y.grid_import).abs() < 1e-6 * y.grid_import);
}

#[test]
fn an_expensive_grid_only_backs_the_gensets_up() {
    let q = with_grid(5.0, 1e6, 0.0);
    let r = run(&q, HYB, true);
    check(&q, &r);
    let y = &r.years[0];
    assert!(y.grid_import < 1e-6, "the fleet covers the load, so a dearer grid is not used ({} kWh)", y.grid_import);
    assert!(y.gen_kwh > 0.0);
    // the grid's spare import is reserve: fewer unit-hours than the same plant islanded
    let mut island = q.clone();
    island.grid.enabled = false;
    let ri = run(&island, HYB, false);
    assert!(y.unit_hours < ri.years[0].unit_hours, "unit-hours {} vs islanded {}", y.unit_hours, ri.years[0].unit_hours);
}

#[test]
fn a_limited_import_leaves_the_rest_to_the_gensets() {
    let q = with_grid(0.05, 5000.0, 2000.0);
    let r = run(&q, HYB, true);
    check(&q, &r);
    let y = &r.years[0];
    assert!(y.gen_kwh > 0.0 && y.unmet < 1e-6);
    assert!((y.grid_peak_kw - 5000.0).abs() < 1e-9, "peak import {}", y.grid_peak_kw);
    let mut q2 = q.clone();
    q2.grid.demand_charge = 10.0;
    let y2 = run(&q2, HYB, false).years[0].clone();
    assert!((y2.c_grid_demand - 12.0 * 5000.0 * 10.0).abs() < 1e-6, "demand charge {}", y2.c_grid_demand);
}

#[test]
fn outages_fall_to_the_gensets_and_the_battery() {
    let mut q = with_grid(0.05, 1e6, 0.0);
    q.grid.availability = "pattern".into();
    q.grid.pattern = (0..24).map(|h| if (18..22).contains(&h) { 0.0 } else { 1.0 }).collect();
    let r = run(&q, HYB, true);
    check(&q, &r);
    let (y, h) = (&r.years[0], r.hourly.as_ref().unwrap());
    assert_eq!(y.grid_up_h, (HOURS - 4 * 365) as f64);
    assert_eq!(y.grid_outages, 365.0);
    assert!(y.unmet < 1e-6, "unmet {}", y.unmet);
    for t in 0..HOURS {
        if h.grid_up[t] < 0.5 { assert!(h.gen_units[t] >= f64::from(q.dg.min_units_online), "units always online during an outage at {t}"); }
    }
    // random outages: the same seed gives the same year, another seed another one
    q.grid.availability = "random".into();
    q.grid.outages_per_year = 12.0;
    q.grid.outage_hours = 8.0;
    let (a, b) = (run(&q, HYB, false), run(&q, HYB, false));
    assert_eq!(a.years[0].fuel_l, b.years[0].fuel_l);
    assert!(a.years[0].grid_outages > 0.0 && a.years[0].fuel_l > 0.0);
    q.grid.seed = 7;
    assert_ne!(run(&q, HYB, false).years[0].grid_up_h, a.years[0].grid_up_h);
}

#[test]
fn every_strategy_balances_with_a_grid() {
    for strat in ["cycle_charging", "predictive"] {
        let mut q = with_grid(0.30, 8000.0, 3000.0);
        q.grid.tariff = "tou".into();
        q.grid.tou = (0..24).map(|h| if (17..22).contains(&h) { 0.60 } else { 0.10 }).collect();
        q.grid.availability = "pattern".into();
        q.grid.pattern = (0..24).map(|h| if h == 19 { 0.0 } else { 1.0 }).collect();
        q.dg.strategy = strat.into();
        let r = run(&q, HYB, true);
        check(&q, &r);
        assert!(r.years[0].unmet < 1e-3 * r.years[0].load, "{strat} unmet {}", r.years[0].unmet);
        assert!(r.years[0].grid_import > 0.0, "{strat}");
    }
}

#[test]
fn the_baseline_has_the_grid_too() {
    let q = with_grid(0.05, 1e6, 1e6);
    let b = run(&q, Default::default(), false);
    assert_eq!(b.years[0].gen_kwh, 0.0);
    assert!((b.years[0].grid_import - b.years[0].load).abs() < 1e-6 * b.years[0].load);
    assert_eq!(b.years[0].grid_export, 0.0);
}

#[test]
fn grid_inputs_are_read_and_checked() {
    use soloptima_engine::{parse_project, validate_project, Value};
    let doc = |patch: &str| {
        let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
        let g = Value::parse(patch).unwrap();
        v.set("grid", g);
        parse_project(&v)
    };
    let p = doc(r#"{"enabled":true,"import_kw":500,"export_kw":100,"tariff":"tou","tou":[0.1,0.2],"availability":"random","outages_per_year":5,"outage_hours":3,"seed":9}"#);
    assert!(p.grid.enabled && p.grid.import_kw == 500.0 && p.grid.tou == vec![0.1, 0.2] && p.grid.seed == 9);
    assert!(validate_project(&p).unwrap_err().0.contains("time-of-use"));
    let mut q = p.clone();
    q.grid.tou = vec![0.1; 288];
    assert!(validate_project(&q).is_ok());
    q.grid.outages_per_year = 2000.0;
    assert!(validate_project(&q).unwrap_err().0.contains("outages"));
    q.grid.outages_per_year = 5.0;
    q.grid.availability = "pattern".into();
    assert!(validate_project(&q).unwrap_err().0.contains("pattern"));
    q.grid.import_kw = -1.0;
    assert!(validate_project(&q).unwrap_err().0.contains("limits"));
    // switched off, the grid inputs are not checked and change nothing
    let off = doc(r#"{"enabled":false,"import_kw":-1}"#);
    assert!(validate_project(&off).is_ok());
    let mut a = example();
    a.sim.all_years = false;
    let mut b = off.clone();
    b.sim.all_years = false;
    let (ra, rb) = (run(&a, HYB, false), run(&b, HYB, false));
    assert_eq!(ra.years[0].fuel_l, rb.years[0].fuel_l);
    assert!(!rb.has_grid);
}
