//! The ramp limit on PV and wind (sim.re_ramp_pct_min, gap 15 of docs/LITERATURE.md) in 15 minute steps: a step in PV held
//! hourly, so it rises and falls within one step, against a constant load, over year 1 of the example project.
mod common;
use common::*;
use soloptima_engine::api::run_simulation;
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::sim::{result_to_json, simulate, summary_json, Hourly, PerfectForecast, SimInput, SimResult};
use soloptima_engine::{parse_project, validate_project, Project, Value, HOURS};

/// The example with a constant load and no auxiliaries, 15 minute steps with hourly data held, two 1000 kW gensets without a
/// minimum loading, PV at a DC/AC ratio of 1 and the battery empty at the start. The limit: 1 % per minute, so 150 kW a step
/// for 1000 kWp.
fn project(load_kw: f64, limit: f64) -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q.sim.step_min = 15;
    q.sim.subhourly = "hold".into();
    q.sim.re_ramp_pct_min = limit;
    q.load_kw = vec![load_kw; HOURS];
    q.load_sub.clear();
    q.aux = Default::default();
    q.pv.dc_ac_ratio = 1.0;
    q.dg.units = 2;
    q.dg.unit_kw = 1000.0;
    q.dg.min_load = 0.0;
    q.bess.soc_init = q.bess.soc_min;
    q.bess.self_discharge = 0.0;
    q
}

/// PV per kWp: `level` from 10:00 to 14:00 every day, else nothing
fn step_pv(level: f64) -> Vec<f64> { (0..HOURS).map(|t| if (10..14).contains(&(t % 24)) { level } else { 0.0 }).collect() }

fn sim(q: &Project, pv: &[f64], kwh: f64, kw: f64) -> SimResult {
    let fc = PerfectForecast::new(pv, &q.load_kw, &[]);
    simulate(q, &SimInput { pv_per_kwp: pv, pv_clip_per_kwp: &[], pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: Some(&fc) }, &size(1000.0, kwh, kw), true)
        .unwrap()
}

/// Every step: the load and PV balances close and the state of charge stays within its window; the battery's own balance
/// closes over the year
fn check(q: &Project, r: &SimResult) {
    let h: &Hourly = r.steps.as_ref().unwrap();
    for i in 0..h.load.len() {
        let e = h.load[i] - (h.pv_to_load[i] + h.bess_dis[i] + h.gen_to_load[i] + h.unmet[i] + h.grid_import.get(i).unwrap_or(&0.0));
        assert!(e.abs() < 1e-6, "load balance {e} at step {i}");
        let e = h.pv_avail[i] - (h.pv_to_load[i] + h.pv_to_bess[i] + h.pv_curtailed[i] + h.grid_export.get(i).unwrap_or(&0.0));
        assert!(e.abs() < 1e-6, "PV balance {e} at step {i}");
        assert!(h.soc[i] >= q.bess.soc_min - 1e-9 && h.soc[i] <= q.bess.soc_max + 1e-9, "SOC {} at step {i}", h.soc[i]);
    }
    let y = &r.years[0];
    let eta = q.bess.rte.sqrt();
    let loss = y.bess_ch - y.bess_dis - (y.e_end - y.e_start);
    assert!((loss - (y.bess_ch * (1.0 - eta) + y.bess_dis * (1.0 / eta - 1.0))).abs() < 1e-6 * y.bess_ch, "battery losses {loss}");
    assert!(summary_json(&q.bess, r).at("flow").get("gap", 1.0).abs() < 1e-6 * y.load);
}

/// The step of day d at hour h, quarter q
fn at(d: usize, h: usize, q: usize) -> usize { (d * 24 + h) * 4 + q }

#[test]
fn a_rise_reaches_the_plant_at_the_limit_with_enough_battery() {
    // 200 kW of load and 800 kW of PV from 10:00: the battery, empty after the night, takes all above 150, 300, 450 ... kW
    let (pv, q) = (step_pv(0.8), project(200.0, 1.0));
    let r = sim(&q, &pv, 20000.0, 5000.0);
    check(&q, &r);
    let y = &r.years[0];
    assert!((y.re_ramp_bess_ch - 365.0 * (650.0 + 500.0 + 350.0 + 200.0 + 50.0) * 0.25).abs() < 1e-6 * y.re_ramp_bess_ch, "{}", y.re_ramp_bess_ch);
    assert_eq!((y.re_ramp_curtailed, y.re_ramp_viol, y.re_ramp_viol_kwh), (0.0, 0.0, 0.0));
    // the first quarter hour: 150 kW of PV to the load and the gensets give the rest; without the limit PV serves it all
    let st = r.steps.as_ref().unwrap();
    let i = at(100, 10, 0);
    assert!((st.pv_to_load[i] - 150.0).abs() < 1e-6 && (st.gen_to_load[i] - 50.0).abs() < 1e-6 && (st.pv_to_bess[i] - 650.0).abs() < 1e-6);
    let free = sim(&project(200.0, 0.0), &pv, 20000.0, 5000.0);
    assert!((free.steps.as_ref().unwrap().pv_to_load[i] - 200.0).abs() < 1e-6);
    let j = result_to_json(&r, true);
    assert!(j.at("years").idx(0).has("re_ramp_viol"));
    assert!(!result_to_json(&free, true).dump().contains("re_ramp"));
}

#[test]
fn a_small_battery_curtails_rises_and_misses_falls() {
    // 1000 kW of load, 600 kW of PV, a 100 kW battery that is empty when the PV stops at 14:00
    let (pv, q) = (step_pv(0.6), project(1000.0, 1.0));
    let r = sim(&q, &pv, 2000.0, 100.0);
    check(&q, &r);
    let y = &r.years[0];
    // rises of 450, 300 and 150 kW above the limit, of which the battery takes 100 kW each
    assert!((y.re_ramp_curtailed - 365.0 * (350.0 + 200.0 + 50.0) * 0.25).abs() < 1e-6 * y.re_ramp_curtailed, "{}", y.re_ramp_curtailed);
    // the fall of 600 kW: 150 kW is allowed, the gensets take the other 450 kW once a day
    assert_eq!(y.re_ramp_viol, 365.0);
    assert!((y.re_ramp_viol_kwh - 365.0 * 450.0 * 0.25).abs() < 1e-6 * y.re_ramp_viol_kwh, "{}", y.re_ramp_viol_kwh);
    // curtailed by the limit is part of the PV curtailed
    assert!(y.pv_curtailed >= y.re_ramp_curtailed - 1e-6);
    // a larger battery with PV surplus to charge from (a load of 500 kW) follows the fall itself: no violation
    let q = project(500.0, 1.0);
    let big = sim(&q, &pv, 20000.0, 2000.0);
    check(&q, &big);
    assert_eq!(big.years[0].re_ramp_viol, 0.0);
    assert!(big.years[0].re_ramp_curtailed < 1e-6);
}

#[test]
fn a_battery_held_back_by_its_strategy_still_meets_the_fall() {
    // cycle charging holds the battery while the gensets charge it; a fall beyond the limit draws on it all the same
    let cc = |limit: f64| {
        let mut q = project(1000.0, limit);
        q.dg.strategy = "cycle_charging".into();
        q.dg.cc_setpoint = 0.8;
        q
    };
    let (pv, q) = (step_pv(0.6), cc(1.0));
    let r = sim(&q, &pv, 20000.0, 2000.0);
    check(&q, &r);
    let y = &r.years[0];
    assert!(y.re_ramp_bess_dis > 0.0 && y.re_ramp_viol == 0.0, "{} kWh, {} violations", y.re_ramp_bess_dis, y.re_ramp_viol);
    // without the limit the gensets take the fall
    let free = sim(&cc(0.0), &pv, 20000.0, 2000.0);
    let st = free.steps.as_ref().unwrap();
    let i = at(100, 14, 0);
    assert!(st.gen_to_load[i] - st.gen_to_load[i - 1] > 450.0, "{} to {}", st.gen_to_load[i - 1], st.gen_to_load[i]);
    let st = r.steps.as_ref().unwrap();
    assert!(st.gen_to_load[i] - st.gen_to_load[i - 1] <= 150.0 + 1e-6, "{} to {}", st.gen_to_load[i - 1], st.gen_to_load[i]);
}

#[test]
fn a_frequency_reserve_keeps_its_power_free() {
    // with 50 kW of a 100 kW battery held for the reserve, rises above the limit charge it at 50 kW at most
    let (pv, mut q) = (step_pv(0.6), project(1000.0, 1.0));
    q.grid.enabled = true;
    q.grid.import_kw = 5000.0;
    q.grid.export_kw = 0.0;
    q.grid.reserve_kw = 50.0;
    q.grid.reserve_min = 15.0;
    let r = sim(&q, &pv, 2000.0, 100.0);
    check(&q, &r);
    let y = &r.years[0];
    assert!((y.re_ramp_curtailed - 365.0 * (400.0 + 250.0 + 100.0) * 0.25).abs() < 1e-6 * y.re_ramp_curtailed, "{}", y.re_ramp_curtailed);
    let st = r.steps.as_ref().unwrap();
    let (enom, eta) = (2000.0 * q.bess.soh_init, q.bess.rte.sqrt());
    let hi = q.bess.soc_max - 50.0 * 0.25 * eta / enom;
    for i in 0..st.load.len() {
        assert!(st.pv_to_bess[i] + st.grid_to_bess[i] <= 50.0 + 1e-6 && st.bess_dis[i] <= 50.0 + 1e-6, "battery power at step {i}");
        assert!(st.soc[i] <= hi + 1e-9, "SOC {} above the band at step {i}", st.soc[i]);
    }
}

#[test]
fn hourly_steps_ignore_it_and_off_changes_nothing() {
    let doc = |sim: &str| {
        let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
        v.set("sim", Value::parse(sim).unwrap());
        v
    };
    // at 60 minutes the limit does nothing, and the simulate command says so
    let (a, b) = (doc(r#"{"all_years": false}"#), doc(r#"{"all_years": false, "re_ramp_pct_min": 1}"#));
    let (pa, pb) = (parse_project(&a), parse_project(&b));
    assert_eq!(pb.sim.re_ramp_pct_min, 1.0);
    assert_eq!(result_to_json(&run(&pa, HYB, true), true).dump(), result_to_json(&run(&pb, HYB, true), true).dump());
    let o = run_simulation(&pb, &b).unwrap();
    assert!(o.at("re_ramp_note").str().contains("15 or 30 minute"));
    assert!(!o.has("re_ramp_ref") && !o.at("result").dump().contains("re_ramp"));
    // at 0 it is off: the same project as without the key, in 15 minute steps too
    let c = doc(r#"{"all_years": false, "step_min": 15, "subhourly": "interpolate", "re_ramp_pct_min": 0}"#);
    let d = doc(r#"{"all_years": false, "step_min": 15, "subhourly": "interpolate"}"#);
    assert_eq!(parse_project(&c), parse_project(&d));
    let o = run_simulation(&parse_project(&d), &d).unwrap();
    assert!(!o.dump().contains("re_ramp"));
    // on in 15 minute steps: the figures, and the same design without the limit beside
    let e = doc(r#"{"all_years": false, "step_min": 15, "subhourly": "interpolate", "re_ramp_pct_min": 0.5}"#);
    let oe = run_simulation(&parse_project(&e), &e).unwrap();
    let (y, y0) = (oe.at("result").at("years").idx(0), o.at("result").at("years").idx(0));
    let rf = oe.at("re_ramp_ref");
    assert_eq!(rf.get("curtailed", -1.0), y0.get("pv_curtailed", f64::NAN) + y0.get("wind_curtailed", f64::NAN));
    assert_eq!(rf.get("fuel_l_y1", -1.0), o.at("result").get("fuel_l_y1", f64::NAN));
    assert!(y.get("re_ramp_viol", -1.0) >= 0.0 && y.get("pv_curtailed", 0.0) >= rf.get("curtailed", 0.0));
}

#[test]
fn inputs_are_checked() {
    let mut q = project(1000.0, 100.0);
    assert!(validate_project(&q).is_ok());
    for bad in [-0.1, 100.5] {
        q.sim.re_ramp_pct_min = bad;
        assert!(validate_project(&q).unwrap_err().0.contains("ramp limit"), "{bad}");
    }
}

#[test]
fn the_optimiser_limits_violations() {
    // the example at 1 % in 15 minute steps with a tight limit: designs with PV miss falls, the design without none
    let mut q = example();
    q.sim.all_years = false;
    for x in &mut q.load_kw { *x *= 0.01; }
    q.load_sub.clear();
    q.dg.unit_kw = 100.0;
    q.dg.units = 4;
    q.sim.step_min = 15;
    q.sim.subhourly = "interpolate".into();
    q.sim.re_ramp_pct_min = 0.3;
    let block = |extra: &str| Value::parse(&format!(r#"{{"pv_max":300,"pv_steps":2,"bess_max":400,"bess_steps":2,"refine":false{extra}}}"#)).unwrap();
    let opt = |extra: &str| optimize(&q, &parse_opt_settings(&block(extra), &q).unwrap(), &Progress::default()).unwrap();
    let a = opt("");
    let grid = a.at("grid").arr();
    assert!(grid.iter().all(|c| c.has("ramp_viol")));
    let worst = grid.iter().map(|c| c.get("ramp_viol", 0.0)).fold(0.0, f64::max);
    assert!(worst > 0.0, "no violations to limit");
    assert!(!a.at("settings").has("max_ramp_viol"));
    let b = opt(r#","max_ramp_viol":0"#);
    assert_eq!(b.at("settings").get("max_ramp_viol", -1.0), 0.0);
    for c in b.at("grid").arr() {
        if c.get("ramp_viol", 0.0) > 0.0 { assert!(!c.at("feasible").boolean(true) && !c.at("why").str().is_empty()); }
    }
    assert!(b.at("grid").arr().iter().any(|c| c.at("why").str() == "ramp violations"));
}
