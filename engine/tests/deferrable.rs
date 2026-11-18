//! The deferrable load (load.deferrable, gap 5 of docs/LITERATURE.md): its window, power limit and store, the surplus it
//! takes, the predictive plan, the energy balance and the optimiser's figure, on the example project with the fixture PV
//! (common/mod.rs) simulated over year 1.
mod common;
use common::*;
use soloptima_engine::api::run_simulation;
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::sim::{plan_input, result_to_json, FuelTable, Planner, SimResult};
use soloptima_engine::{parse_project, validate_project, DeferrableLoad, Project, Value, HOURS};

fn one_year() -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q
}

fn with_dl(mut q: Project, kwh_day: f64, kw: f64, start_h: i32, end_h: i32, tank_kwh: f64) -> Project {
    q.deferrable = DeferrableLoad { kwh_day, kw, start_h, end_h, tank_kwh, tank_fill: 0.0, battery_first: true };
    q
}

fn in_win(h: usize, s: usize, e: usize) -> bool { if s < e { h >= s && h < e } else { h >= s || h < e } }

/// Energy the deferrable load drew in the window that opens at hour `s` of day d and ends at hour e
fn window_sum(dl: &[f64], d: usize, s: usize, e: usize, k: usize) -> f64 {
    let len = if s < e { e - s } else { e + 24 - s };
    (0..len * k).map(|i| dl[(d * 24 + s) * k + i]).sum::<f64>() / k as f64
}

#[test]
fn off_by_default_and_nothing_changes() {
    for strategy in ["load_following", "predictive"] {
        let mut q = one_year();
        q.dg.strategy = strategy.into();
        assert!(!q.deferrable.on());
        let a = result_to_json(&run(&q, HYB, true), true).dump();
        // the other inputs do nothing at 0 kWh a day
        q.deferrable = DeferrableLoad { kwh_day: 0.0, kw: 5000.0, start_h: 20, end_h: 6, tank_kwh: 1e5, tank_fill: 1.0, battery_first: false };
        assert_eq!(a, result_to_json(&run(&q, HYB, true), true).dump());
        assert!(!a.contains("dl_"));
    }
    // a block at 0 kWh a day is off
    let doc = |dl: &str| {
        let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
        let mut l = v.at("load").clone();
        if !dl.is_empty() { l.set("deferrable", Value::parse(dl).unwrap()); }
        v.set("load", l);
        parse_project(&v)
    };
    assert_eq!(doc("").deferrable, DeferrableLoad::default());
    assert!(!doc(r#"{"kwh_day": 0, "kw": 300, "start_h": 6, "end_h": 18, "tank_kwh": 500, "first": "deferrable"}"#).deferrable.on());
    let p = doc(r#"{"kwh_day": 1200, "kw": 300, "start_h": 22, "end_h": 6, "tank_kwh": 500, "tank_fill": 0.25, "first": "deferrable"}"#);
    assert_eq!(p.deferrable, DeferrableLoad { kwh_day: 1200.0, kw: 300.0, start_h: 22, end_h: 6, tank_kwh: 500.0, tank_fill: 0.25, battery_first: false });
}

#[test]
fn inputs_are_checked() {
    let ok = with_dl(one_year(), 1000.0, 200.0, 8, 13, 0.0);
    assert!(validate_project(&ok).is_ok());
    let err = |q: Project| validate_project(&q).unwrap_err().0;
    assert!(err(with_dl(one_year(), 1000.0, 199.0, 8, 13, 0.0)).contains("cannot draw its daily energy"));
    assert!(err(with_dl(one_year(), 1000.0, 0.0, 8, 13, 0.0)).contains("maximum power"));
    assert!(err(with_dl(one_year(), 1000.0, 200.0, 8, 24, 0.0)).contains("window"));
    assert!(err(with_dl(one_year(), 1000.0, 200.0, 8, 13, -1.0)).contains("store"));
    assert!(err(with_dl(one_year(), -1.0, 200.0, 8, 13, 0.0)).contains("non-negative"));
    // a window from an hour to the same hour is the whole day
    assert!(validate_project(&with_dl(one_year(), 4800.0, 200.0, 7, 7, 0.0)).is_ok());
}

#[test]
fn the_daily_energy_comes_from_surplus_when_there_is_enough() {
    // no battery, so every hour stands alone: on a day with more surplus than the load's power in every window hour, it draws
    // its energy from the surplus and the gensets run exactly as without it
    let s = size(70000.0, 0.0, 0.0);
    let base = run(&one_year(), s, true);
    let q = with_dl(one_year(), 15000.0, 3000.0, 9, 16, 0.0);
    let r = run(&q, s, true);
    let (hb, h) = (base.hourly.as_ref().unwrap(), r.hourly.as_ref().unwrap());
    let mut days = 0;
    for d in 0..365 {
        if !(9..16).all(|x| hb.pv_curtailed[d * 24 + x] > 3000.0 + 1.0) { continue; }
        days += 1;
        assert!((window_sum(&h.dl, d, 9, 16, 1) - 15000.0).abs() < 1e-6, "day {d}");
        for t in d * 24 + 9..d * 24 + 16 {
            assert_eq!(h.gen_to_load[t], hb.gen_to_load[t], "hour {t}");
            assert_eq!(h.fuel_l[t], hb.fuel_l[t], "hour {t}");
            assert!((h.pv_curtailed[t] - (hb.pv_curtailed[t] - h.dl[t])).abs() < 1e-6, "hour {t}");
        }
    }
    assert!(days > 30, "sunny days: {days}");
    let y = &r.years[0];
    assert_eq!(y.dl_unmet, 0.0);
    assert!(y.dl_re > 0.5 * y.dl_kwh, "most of it from PV: {} of {}", y.dl_re, y.dl_kwh);
}

#[test]
fn the_window_and_the_power_limit_hold() {
    // a window over midnight, in 15 minute steps
    let mut q = with_dl(one_year(), 40000.0, 6000.0, 20, 6, 0.0);
    q.sim.step_min = 15;
    let r = run(&q, HYB, true);
    let st = r.steps.as_ref().unwrap();
    assert_eq!(st.dl.len(), HOURS * 4);
    for (i, &x) in st.dl.iter().enumerate() {
        assert!(x <= 6000.0 + 1e-9, "step {i}: {x} kW");
        if x > 1e-9 { assert!(in_win((i / 4) % 24, 20, 6), "step {i} is outside the window"); }
    }
    // every full window draws its daily energy; the first one, already open at the start, its share of 6 h out of 10
    for d in 0..364 { assert!((window_sum(&st.dl, d, 20, 6, 4) - 40000.0).abs() < 1e-6, "window of day {d}"); }
    let first: f64 = st.dl[..6 * 4].iter().sum::<f64>() / 4.0;
    assert!((first - 24000.0).abs() < 1e-6, "{first}");
    let h = r.hourly.as_ref().unwrap();
    assert!(h.dl.iter().all(|&x| x <= 6000.0 + 1e-9));
    assert_eq!(r.years[0].dl_unmet, 0.0);
}

#[test]
fn the_store_carries_energy_across_days() {
    let s = size(70000.0, 0.0, 0.0);
    let none = run(&with_dl(one_year(), 60000.0, 10000.0, 8, 17, 0.0), s, true);
    let q = with_dl(one_year(), 60000.0, 10000.0, 8, 17, 300000.0);
    let r = run(&q, s, true);
    let (h, y) = (r.hourly.as_ref().unwrap(), &r.years[0]);
    assert!(h.dl_tank.iter().all(|&x| (-1e-9..=300000.0 + 1e-6).contains(&x)));
    assert!(h.dl_tank.iter().cloned().fold(0.0, f64::max) > 100000.0, "sunny days fill the store");
    // days that drew more than their energy (filling the store) and days that drew less (emptying it), none short
    let sums: Vec<f64> = (0..365).map(|d| window_sum(&h.dl, d, 8, 17, 1)).collect();
    assert!(sums.iter().any(|&x| x > 60000.0 + 1.0) && sums.iter().any(|&x| x < 60000.0 - 1.0));
    assert_eq!(y.dl_unmet, 0.0);
    // the store's balance over the year: it starts empty, and every window has closed by the last hour
    let end = h.dl_tank[HOURS - 1];
    assert!((end - (y.dl_kwh - 365.0 * 60000.0 + y.dl_unmet)).abs() < 1e-6 * y.dl_kwh, "{end}");
    // the store lets more of it run on surplus, so less on the gensets
    let y0 = &none.years[0];
    assert!(y.dl_kwh - y.dl_re < y0.dl_kwh - y0.dl_re, "{} against {}", y.dl_kwh - y.dl_re, y0.dl_kwh - y0.dl_re);
    assert!(y.fuel_l < y0.fuel_l);
}

/// Hourly and yearly balances with the deferrable load in the load
fn check_balance(r: &SimResult) {
    let (h, y) = (r.hourly.as_ref().unwrap(), &r.years[0]);
    assert!(balance_error(h) < 0.05, "{}", balance_error(h));
    let served = y.pv_to_load + y.wind_to_load + y.bess_dis + y.gen_to_load;
    assert!((y.load - y.unmet - served).abs() < 1e-6 * y.load);
    assert!((y.pv_avail - (y.pv_to_load + y.pv_to_bess + y.pv_curtailed)).abs() < 1e-6 * y.pv_avail);
    assert!((h.dl.iter().sum::<f64>() - y.dl_kwh).abs() < 1e-6 * y.dl_kwh);
    assert!(y.dl_re <= y.dl_kwh + 1e-6 && y.dl_re >= 0.0);
    assert!((r.unmet_fraction - y.unmet / (y.load - y.dl_kwh)).abs() < 1e-15, "unmet against the site load");
}

#[test]
fn the_energy_balance_closes() {
    for strategy in ["load_following", "cycle_charging", "predictive"] {
        for first in [true, false] {
            let mut q = with_dl(one_year(), 50000.0, 8000.0, 7, 19, 100000.0);
            q.deferrable.battery_first = first;
            q.dg.strategy = strategy.into();
            let r = run(&q, size(50000.0, 20000.0, 10000.0), true);
            check_balance(&r);
            assert!(r.years[0].dl_kwh > 300.0 * 50000.0, "{strategy}");
        }
    }
    // a plant too small for its load: the deferrable load is shed first and counted short when its window closes
    let mut q = with_dl(one_year(), 50000.0, 8000.0, 7, 19, 0.0);
    q.dg.units = 12;
    let r = run(&q, HYB, true);
    check_balance(&r);
    let y = &r.years[0];
    assert!(y.dl_unmet > 0.0 && y.unmet > 0.0);
    assert!((r.dl_unmet_fraction - y.dl_unmet / y.dl_demand).abs() < 1e-15);
    assert!((y.dl_demand - 365.0 * 50000.0).abs() < 1e-6);
    let j = result_to_json(&r, true);
    let jy = j.at("years").idx(0);
    for k in ["dl_demand", "dl_kwh", "dl_re", "dl_unmet"] { assert!(jy.has(k), "{k}"); }
    assert!(j.has("dl_unmet_fraction") && j.at("hourly").has("dl") && !j.at("hourly").has("dl_tank"));
}

#[test]
fn the_plan_puts_it_in_surplus_hours() {
    // the scheduling rule alone: 1000 kW of load, 3000 kW of PV from 10:00 to 14:00
    let p = one_year();
    let fuel = FuelTable::new(&p.dg).unwrap();
    let mut planner = Planner::new(&p.dg, &fuel);
    let pin = plan_input(&p, &fuel);
    let load = vec![1000.0; 24];
    let pv: Vec<f64> = (0..24).map(|j| if (10..14).contains(&j) { 3000.0 } else { 0.0 }).collect();
    let mut out = vec![0.0; 24];
    planner.schedule_deferrable(&pin, &load, &pv, &[(6, 20, 3000.0)], 1000.0, &mut out);
    assert!((out.iter().sum::<f64>() - 3000.0).abs() < 1e-9);
    assert!(out.iter().enumerate().all(|(j, &x)| x == 0.0 || (10..14).contains(&j)), "{out:?}");
    // more than the surplus hours hold: the rest in the window, never outside it
    planner.schedule_deferrable(&pin, &load, &pv, &[(6, 20, 9000.0)], 1000.0, &mut out);
    assert!((out.iter().sum::<f64>() - 9000.0).abs() < 1e-9 && (10..14).all(|j| out[j] == 1000.0));
    assert!(out.iter().enumerate().all(|(j, &x)| x == 0.0 || (6..20).contains(&j)));

    // in the simulation: with the battery charged first, the rules leave the load to the end of its long window, while the plan
    // moves it into the hours of PV surplus
    let s = size(45000.0, 20000.0, 10000.0);
    let share = |strategy: &str| {
        let mut q = with_dl(one_year(), 24000.0, 6000.0, 6, 22, 0.0);
        q.dg.strategy = strategy.into();
        let r = run(&q, s, true);
        let h = r.hourly.as_ref().unwrap();
        let in_surplus: f64 = (0..HOURS).filter(|&t| h.pv_avail[t] > h.load[t] - h.dl[t]).map(|t| h.dl[t]).sum();
        (in_surplus / r.years[0].dl_kwh, r)
    };
    let (rules, _) = share("load_following");
    let (plan, r) = share("predictive");
    assert!(plan > rules + 0.1, "share in surplus hours: plan {plan}, rules {rules}");
    check_balance(&r);
}

#[test]
fn curtailment_drops() {
    let s = size(70000.0, 0.0, 0.0);
    let y0 = run(&one_year(), s, false).years[0].clone();
    let y = run(&with_dl(one_year(), 30000.0, 6000.0, 8, 17, 0.0), s, false).years[0].clone();
    assert!(y.pv_curtailed < y0.pv_curtailed - 0.5 * y.dl_re, "{} against {}", y.pv_curtailed, y0.pv_curtailed);
    // the simulate command reports the design without it beside
    let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    v.set("sim", Value::parse(r#"{"all_years": false}"#).unwrap());
    let mut l = v.at("load").clone();
    l.set("deferrable", Value::parse(r#"{"kwh_day": 30000, "kw": 6000, "start_h": 8, "end_h": 17}"#).unwrap());
    v.set("load", l);
    let o = run_simulation(&parse_project(&v), &v).unwrap();
    let (r, d) = (o.at("result"), o.at("deferrable_ref"));
    assert!(d.get("curtailed", -1.0) >= r.at("years").idx(0).get("pv_curtailed", f64::NAN));
    assert!(d.has("fuel_l_y1") && d.has("curtail_fraction") && !d.has("grid_export"));
}

#[test]
fn the_optimiser_counts_its_shortfall_apart() {
    // the example at 1 % with 4 x 100 kW gensets, and a pump of 300 kW for 4 h at midday that the gensets alone cannot run
    let mut q = one_year();
    for x in &mut q.load_kw { *x *= 0.01; }
    q.load_sub.clear();
    q.dg.unit_kw = 100.0;
    q.dg.units = 4;
    let q = with_dl(q, 1200.0, 300.0, 10, 14, 0.0);
    let block = |extra: &str| Value::parse(&format!(r#"{{"pv_max":3000,"pv_steps":3,"bess_max":4000,"bess_steps":3,"refine":false{extra}}}"#)).unwrap();
    let opt = |extra: &str| optimize(&q, &parse_opt_settings(&block(extra), &q).unwrap(), &Progress::default()).unwrap();
    let a = opt("");
    let grid = a.at("grid").arr();
    assert!(grid.iter().all(|c| c.has("dl_unmet")));
    // without PV the pump falls short, which the limit (that of the unmet load by default) does not allow
    let no_pv = grid.iter().find(|c| c.get("pv_kwp", 1.0) == 0.0 && c.get("bess_kwh", 1.0) == 0.0).unwrap();
    assert!(no_pv.get("dl_unmet", 0.0) > 0.001 && !no_pv.at("feasible").boolean(true));
    assert_eq!(no_pv.at("why").str(), "deferrable load");
    assert!(no_pv.get("unmet", 1.0) <= 0.001, "the site load itself is served: {}", no_pv.get("unmet", 1.0));
    // a looser limit of its own makes it feasible
    let b = opt(r#","max_dl_unmet":1"#);
    let c = b.at("grid").arr().iter().find(|c| c.get("pv_kwp", 1.0) == 0.0 && c.get("bess_kwh", 1.0) == 0.0).unwrap();
    assert!(c.at("feasible").boolean(false), "{}", c.at("why").str());
    assert_eq!(b.at("settings").get("max_dl_unmet", -1.0), 1.0);
    assert!(!a.at("settings").has("max_dl_unmet"));
}
