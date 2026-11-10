//! Dispatch in 30 and 15 minute steps, genset ramp limits and start time, forced unit outages and the N-1 check, on the
//! example project with the fixture PV (common/mod.rs).
mod common;
use common::*;
use soloptima_engine::sim::{result_to_json, Hourly};
use soloptima_engine::{parse_project, validate_project, Project, Value, HOURS};

fn steps(min: i32) -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q.sim.step_min = min;
    q
}

/// Every step: load = PV + wind + battery + gensets + unmet, and the SOC within its window
fn check_steps(q: &Project, h: &Hourly) {
    for i in 0..h.load.len() {
        let e = h.load[i] - (h.pv_to_load[i] + h.wind_to_load[i] + h.bess_dis[i] + h.gen_to_load[i] + h.unmet[i]);
        assert!(e.abs() < 0.05, "balance {e} at step {i}");
        assert!(h.soc[i] >= q.bess.soc_min - 1e-6 && h.soc[i] <= q.bess.soc_max + 1e-6, "SOC at step {i}");
    }
}

#[test]
fn quarter_hours_keep_the_energy_and_give_hourly_means() {
    let (a, b) = (run(&steps(60), HYB, true), run(&steps(15), HYB, true));
    let (ya, yb) = (&a.years[0], &b.years[0]);
    assert_eq!(b.step_min, 15);
    let st = b.steps.as_ref().unwrap();
    assert_eq!(st.load.len(), 4 * HOURS);
    check_steps(&steps(15), st);
    // held hourly data: the same load and PV energy; fuel and storage close to the hourly run
    assert!((ya.load - yb.load).abs() < 1e-6 * ya.load && (ya.pv_avail - yb.pv_avail).abs() < 1e-6 * ya.pv_avail);
    assert!((ya.fuel_l - yb.fuel_l).abs() < 0.02 * ya.fuel_l, "fuel {} vs {}", yb.fuel_l, ya.fuel_l);
    // the battery runs down within the hour, so units come on sooner and it discharges somewhat less than hour by hour
    assert!((ya.bess_dis - yb.bess_dis).abs() < 0.15 * ya.bess_dis, "battery {} vs {}", yb.bess_dis, ya.bess_dis);
    // the battery's own balance closes: charged - discharged - change in stored energy = conversion losses at the RTE
    let loss = yb.bess_ch - yb.bess_dis - yb.self_discharge - (yb.e_end - yb.e_start);
    let eta = example().bess.rte.sqrt();
    assert!((loss - (yb.bess_ch * (1.0 - eta) + yb.bess_dis * (1.0 / eta - 1.0))).abs() < 1.0, "battery losses {loss}");
    let summary = soloptima_engine::sim::summary_json(&steps(15).bess, &b);
    assert!(summary.at("flow").get("gap", 1.0).abs() < 1e-6 * yb.load);
    // hourly series are the means of the steps; fuel the sum
    let h = b.hourly.as_ref().unwrap();
    for t in [0, 4000, 8759] {
        let m = |x: &Vec<f64>| x[4 * t..4 * t + 4].iter().sum::<f64>() / 4.0;
        assert!((h.gen_to_load[t] - m(&st.gen_to_load)).abs() < 1e-6 && (h.load[t] - m(&st.load)).abs() < 1e-6);
        assert!((h.fuel_l[t] - 4.0 * m(&st.fuel_l)).abs() < 1e-6);
        assert_eq!(h.soc[t], st.soc[4 * t + 3]);
    }
    let j = result_to_json(&b, true);
    assert_eq!(j.get("step_min", 0.0), 15.0);
    assert_eq!(j.at("steps").at("load").len(), 4 * HOURS);
    assert!(result_to_json(&a, true).at("steps").is_null() && result_to_json(&a, true).at("step_min").is_null());
    // every strategy runs in 30 minute steps
    for strat in ["cycle_charging", "predictive"] {
        let mut q = steps(30);
        q.dg.strategy = strat.into();
        let r = run(&q, HYB, true);
        check_steps(&q, r.steps.as_ref().unwrap());
        assert!(r.years[0].unmet < 1e-3 * r.years[0].load, "{strat}");
    }
}

#[test]
fn interpolation_keeps_each_hour_and_a_finer_load_is_used() {
    let mut q = steps(15);
    q.sim.subhourly = "interpolate".into();
    let r = run(&q, HYB, true);
    let (st, h) = (r.steps.as_ref().unwrap(), r.hourly.as_ref().unwrap());
    let fx = fixture();
    for t in (0..HOURS).step_by(97) {
        let m = st.pv_avail[4 * t..4 * t + 4].iter().sum::<f64>() / 4.0;
        assert!((m - fx.pv[t] * HYB.pv_kwp).abs() < 1e-6 * (1.0 + m), "PV mean of hour {t}");
        assert!((h.pv_avail[t] - m).abs() < 1e-6 * (1.0 + m));
    }
    assert!(st.pv_avail[4 * 12] != st.pv_avail[4 * 12 + 3], "interpolated within the hour");

    // a 15 minute load in the project keeps its resolution at 15 minute steps and is averaged otherwise
    let mut doc = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    let hourly: Vec<f64> = doc.at("load").getv("kw");
    let sub: Vec<f64> = hourly.iter().flat_map(|&x| [0.8 * x, 1.2 * x, 0.9 * x, 1.1 * x]).collect();
    let mut load = doc.at("load").clone();
    load.set("kw", sub.clone());
    doc.set("load", load);
    let mut sim = Value::object();
    sim.set("step_min", 15.0);
    sim.set("all_years", false);
    doc.set("sim", sim);
    let p = parse_project(&doc);
    assert_eq!(p.load_sub.len(), 4 * HOURS);
    assert!((p.load_kw[5] - hourly[5]).abs() < 1e-9 * hourly[5]);
    assert!(validate_project(&p).is_ok());
    let r = run(&p, HYB, true);
    let st = r.steps.as_ref().unwrap();
    assert!((st.load[21] - (sub[21] + st.aux[21])).abs() < 1e-6, "step load {} vs {}", st.load[21], sub[21]);
}

#[test]
fn ramps_and_start_time_hold_the_gensets_back() {
    let mut q = steps(15);
    q.bess.provides_reserve = false;
    q.dg.ramp_pct_min = 0.5;   // 7.5 % of the online rating per step
    let r = run(&q, size(30000.0, 0.0, 0.0), true);
    let st = r.steps.as_ref().unwrap();
    let y = &r.years[0];
    assert!(y.ramp_limited_h > 0.0, "the ramp limit never bound");
    let mut worst = 0.0f64;
    for i in 1..st.load.len() {
        let (g0, g1) = (st.gen_to_load[i - 1] + st.gen_to_bess[i - 1] + st.gen_dump[i - 1], st.gen_to_load[i] + st.gen_to_bess[i] + st.gen_dump[i]);
        let rk = 0.005 * 15.0 * st.gen_units[i].max(st.gen_units[i - 1]) * q.dg.unit_kw;
        worst = worst.max((g1 - g0).abs() - rk);
    }
    assert!(worst < 1e-6, "output moved {worst} kW beyond the ramp limit");
    assert!(y.unmet > 0.0, "without a battery a fast PV drop leaves load unmet");
    assert!(result_to_json(&r, false).at("years").idx(0).has("ramp_limited_h"));
    // a start time: units started in a step deliver less, so a run without battery leaves more unmet
    let mut s = steps(15);
    s.bess.provides_reserve = false;
    s.dg.start_min = 10.0;
    let rs = run(&s, size(30000.0, 0.0, 0.0), false);
    let r0 = run(&steps(15), size(30000.0, 0.0, 0.0), false);
    assert!(rs.years[0].unmet > r0.years[0].unmet && rs.years[0].ramp_limited_h > 0.0);
}

#[test]
fn forced_outages_take_units_away_and_n1_is_checked() {
    let mut q = steps(60);
    q.dg.outage_rate = 6.0;
    q.dg.repair_h = 48.0;
    q.dg.n1_check = true;
    let (a, b) = (run(&q, HYB, true), run(&q, HYB, false));
    let y = &a.years[0];
    assert_eq!(y.fuel_l, b.years[0].fuel_l, "the same seed gives the same year");
    assert!(y.unit_outages > 60.0 && y.unit_outages < 200.0, "outages {}", y.unit_outages);
    assert!(y.unit_outage_h > 1000.0, "unit-hours out {}", y.unit_outage_h);
    let j = result_to_json(&a, false);
    let jy = j.at("years").idx(0);
    assert!(jy.has("unit_outages") && jy.has("n1_short_h") && !jy.has("ramp_limited_h"));
    // a small fleet: outages cost reliability, and N-1 shows the exposure
    let mut s = q.clone();
    s.dg.units = 14;
    s.dg.min_units_online = 1;
    s.bess.provides_reserve = false;
    let (rs, mut s0) = (run(&s, HYB, true), s.clone());
    s0.dg.outage_rate = 0.0;
    let r0 = run(&s0, HYB, false);
    assert!(rs.years[0].unmet > r0.years[0].unmet, "outages leave load unmet with 14 units");
    assert!(rs.years[0].n1_short_h > 0.0 && rs.years[0].n1_short_max_kw > 0.0);
    let h = rs.hourly.as_ref().unwrap();
    assert!(h.gen_units.iter().all(|u| *u <= 14.0));
    q.dg.outage_seed = 9;
    assert_ne!(run(&q, HYB, false).years[0].unit_outages, y.unit_outages);
}

#[test]
fn settings_are_checked() {
    let mut q = steps(20);
    assert!(validate_project(&q).unwrap_err().0.contains("time step"));
    q.sim.step_min = 15;
    q.sim.subhourly = "spline".into();
    assert!(validate_project(&q).unwrap_err().0.contains("held or interpolated"));
    q.sim.subhourly = "hold".into();
    q.dg.start_min = 90.0;
    assert!(validate_project(&q).unwrap_err().0.contains("start time"));
    q.dg.start_min = 0.0;
    q.dg.repair_h = 0.0;
    assert!(validate_project(&q).unwrap_err().0.contains("repair"));
}
