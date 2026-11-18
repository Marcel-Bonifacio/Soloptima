//! The critical-load tier (load.critical_share, grid.outage_critical_only, ems.voll_nc) and the outage survival study
//! (sim::resilience, gaps 17 and 18 of docs/LITERATURE.md), on the example project with the fixture PV (common/mod.rs).
mod common;
use common::*;
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::sim::{plan_input, resilience, result_to_json, summary_json, FuelTable, Planner, ResilienceSettings, SimInput, Sizing};
use soloptima_engine::{parse_project, validate_project, Project, Value, HOURS};
use std::sync::atomic::Ordering::Relaxed;

fn one_year() -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q
}

/// The example with too few gensets for its peak, so some load goes unserved
fn short() -> Project {
    let mut q = one_year();
    q.dg.units = 10;
    q
}

/// Unserved energy of each tier: the non-critical load of the hour first, the rest critical
fn split(q: &Project, h: &soloptima_engine::sim::Hourly) -> (f64, f64) {
    let c = q.sim.critical_share;
    (0..HOURS).fold((0.0, 0.0), |(a, b), t| {
        let nc = (1.0 - c) * (h.load[t] - h.aux[t]);
        let u_nc = h.unmet[t].min(nc);
        (a + h.unmet[t] - u_nc, b + u_nc)
    })
}

#[test]
fn off_by_default_and_nothing_changes() {
    let q = short();
    assert_eq!(q.sim.critical_share, 1.0);
    assert!(!q.grid.outage_critical_only && q.ems.voll_nc.is_none() && q.dg.fail_start == 0.0 && q.dg.mttf_h == 0.0);
    let a = result_to_json(&run(&q, HYB, true), true).dump();
    // critical-only supply and a non-critical value of lost load do nothing while all the load is critical
    let mut q2 = q.clone();
    q2.grid.outage_critical_only = true;
    q2.ems.voll_nc = Some(0.5);
    q2.dg.fail_start = 0.2;
    q2.dg.mttf_h = 500.0;
    assert_eq!(a, result_to_json(&run(&q2, HYB, true), true).dump());
    assert!(!a.contains("unmet_crit") && !a.contains("lol_nc_h") && !a.contains("nc_shed"));
}

#[test]
fn the_non_critical_load_is_shed_first_and_the_split_adds_up() {
    let mut q = short();
    let all = run(&q, HYB, true);
    q.sim.critical_share = 0.6;
    let r = run(&q, HYB, true);
    let (y0, y) = (&all.years[0], &r.years[0]);
    // the rule-based dispatch serves the same energy; only the accounting splits it
    assert_eq!(y0.unmet, y.unmet);
    assert_eq!(y0.fuel_l, y.fuel_l);
    assert!(y.unmet > 1000.0, "the short fleet leaves load unserved: {}", y.unmet);
    assert!((y.unmet_crit + y.unmet_nc - y.unmet).abs() < 1e-6 * y.unmet, "the split adds up");
    let (uc, unc) = split(&q, r.hourly.as_ref().unwrap());
    assert!((uc - y.unmet_crit).abs() < 1e-6 * y.unmet && (unc - y.unmet_nc).abs() < 1e-6 * y.unmet, "non-critical first");
    assert!(y.unmet_crit < y.unmet_nc, "most of the shortfall is non-critical: {} against {}", y.unmet_crit, y.unmet_nc);
    assert!((y.load_crit - (0.6 * (y.load - y.aux) + y.aux)).abs() < 1e-6 * y.load, "critical load {}", y.load_crit);
    assert!(y.lol_nc_h > 0.0 && y.lol_crit_h <= y.lol_nc_h, "an hour short of critical load has shed all the rest");
    assert!((r.unmet_crit_fraction - y.unmet_crit / y.load_crit).abs() < 1e-12);
    let j = result_to_json(&r, false);
    let jy = j.at("years").idx(0);
    for k in ["load_crit", "unmet_crit", "unmet_nc", "lol_crit_h", "lol_nc_h"] { assert!(jy.has(k), "{k}"); }
    assert!(!jy.has("nc_shed") && j.has("unmet_crit_fraction") && j.has("unmet_crit_fraction_max"));
}

#[test]
fn critical_only_supply_sheds_the_rest_while_the_grid_is_down() {
    let mut q = one_year();
    q.grid.enabled = true;
    q.grid.import_kw = 1e6;
    q.grid.availability = "pattern".into();
    q.grid.pattern = (0..24).map(|h| if (19..23).contains(&h) { 0.0 } else { 1.0 }).collect();
    q.sim.critical_share = 0.5;
    let both = run(&q, HYB, true);
    q.grid.outage_critical_only = true;
    for strat in ["load_following", "predictive"] {
        q.dg.strategy = strat.into();
        let r = run(&q, HYB, true);
        let (h, y) = (r.hourly.as_ref().unwrap(), &r.years[0]);
        let mut shed = 0.0;
        for t in 0..HOURS {
            let served = h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.grid_import[t];
            assert!((h.load[t] - served - h.unmet[t]).abs() < 0.05, "{strat}: load balance at {t}");
            if h.grid_up[t] < 0.5 {
                // the plant serves at most the critical half of the site load and the auxiliaries
                let nc = 0.5 * (h.load[t] - h.aux[t]);
                assert!(served <= h.load[t] - nc + 0.05 && h.unmet[t] >= nc - 0.05, "{strat}: hour {t}");
                shed += nc;
            }
        }
        assert!((y.nc_shed - shed).abs() < 1e-6 * shed && y.unmet_nc >= y.nc_shed - 1e-6, "{strat}: shed {} against {shed}", y.nc_shed);
        assert!((y.unmet_crit + y.unmet_nc - y.unmet).abs() < 1e-6 * y.unmet, "{strat}");
        assert!(y.lol_h >= 365.0 * 4.0 - 1e-9, "{strat}: every outage hour loses its non-critical load");
        assert!(result_to_json(&r, false).at("years").idx(0).has("nc_shed"));
        let gap = summary_json(&q.bess, &r).at("flow").get("gap", 1.0);
        assert!(gap.abs() < 1e-3 * y.load, "{strat}: the energy flow closes with the shed load in load and unmet: {gap}");
        if strat == "load_following" {
            assert!(y.fuel_l < both.years[0].fuel_l, "{strat}: the gensets serve less: {} against {}", y.fuel_l, both.years[0].fuel_l);
            assert!(y.unmet_crit <= both.years[0].unmet_crit + 1e-6);
        }
    }
}

#[test]
fn the_plan_keeps_the_battery_for_the_critical_load() {
    // two hours, no gensets, 100 kWh above the minimum: the first hour's load is all non-critical, the second's critical
    let mut q = one_year();
    q.dg.units = 0;
    q.bess.rte = 1.0;
    let fuel = FuelTable::new(&q.dg).unwrap();
    let mut pl = Planner::new(&q.dg, &fuel);
    let mut i = plan_input(&q, &fuel);
    (i.e_min, i.e_max, i.pb, i.levels) = (0.0, 100.0, 100.0, 11);
    i.terminal_per_kwh = 0.0;
    i.cycle_cost = 0.0;
    i.nc_kw = vec![100.0, 0.0];
    i.voll_nc = 0.5;
    let (mut e, mut u) = (Vec::new(), Vec::new());
    pl.plan(&i, 100.0, &[100.0, 100.0], &[0.0, 0.0], &mut e, &mut u);
    assert!(e[1] > 99.0 && e[2] < 1.0, "the energy waits for the critical hour: {e:?}");
}

#[test]
fn the_new_inputs_are_read_and_checked() {
    let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    let mut load = v.at("load").clone();
    load.set("critical_share", 0.7);
    v.set("load", load);
    let mut dg = v.at("diesel").clone();
    dg.set("fail_start", 0.05);
    dg.set("mttf_h", 1500.0);
    v.set("diesel", dg);
    v.set("ems", Value::parse(r#"{"voll_nc":0.4}"#).unwrap());
    v.set("grid", Value::parse(r#"{"enabled":true,"import_kw":500,"outage_critical_only":true}"#).unwrap());
    let p = parse_project(&v);
    assert_eq!((p.sim.critical_share, p.dg.fail_start, p.dg.mttf_h, p.ems.voll_nc), (0.7, 0.05, 1500.0, Some(0.4)));
    assert!(p.grid.outage_critical_only && validate_project(&p).is_ok());
    for (k, x) in [("share", 1.5), ("share", -0.1), ("fts", 1.2), ("mttf", 0.5), ("voll", -1.0)] {
        let mut q = p.clone();
        match k {
            "share" => q.sim.critical_share = x,
            "fts" => q.dg.fail_start = x,
            "mttf" => q.dg.mttf_h = x,
            _ => q.ems.voll_nc = Some(x),
        }
        assert!(validate_project(&q).is_err(), "{k} = {x}");
    }
}

#[test]
fn the_optimiser_limits_the_critical_shortfall() {
    // the short fleet leaves load unserved; with a critical share the unmet-load limit holds for the critical load only
    let mut q = short();
    q.sim.critical_share = 0.5;
    let o = parse_opt_settings(&Value::parse(r#"{"pv_max":30000,"pv_steps":2,"bess_max":6600,"bess_steps":2,"refine":false,"max_unmet":0.001}"#).unwrap(), &q).unwrap();
    let res = optimize(&q, &o, &Progress::default()).unwrap();
    for c in res.at("grid").arr() {
        let r = run(&q, size(c.get("pv_kwp", 0.0), c.get("bess_kwh", 0.0), c.get("bess_kw", 0.0)), false);
        assert!((c.get("unmet", -1.0) - r.unmet_crit_fraction.max(r.unmet_crit_fraction_max)).abs() < 1e-12);
        assert!(r.unmet_fraction > c.get("unmet", 0.0), "the total shortfall is larger");
        assert_eq!(c.getb("feasible", false), c.get("unmet", 1.0) <= 0.001 + 1e-9 || c.gets("why", "") != "unmet load");
    }
}

/// A plant of one size on the fixture PV, the study at every hour (or `stride`) up to `max_h`
fn study(q: &Project, s: Sizing, stride: usize, max_h: usize) -> Value {
    let fx = fixture();
    let si = SimInput { pv_per_kwp: &fx.pv, pv_clip_per_kwp: &[], pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
    resilience(q, &si, &s, &ResilienceSettings { stride, max_h }, &Progress::default()).unwrap()
}

fn series(v: &Value, a: &str, b: &str) -> Vec<f64> { v.at(a).at(b).arr().iter().map(|x| x.num(f64::NAN)).collect() }

/// A small flat load of `kw` on the example site
fn small(kw: f64) -> Project {
    let mut q = one_year();
    q.load_kw = vec![kw; HOURS];
    q
}

#[test]
fn survival_is_one_with_ample_battery_and_zero_without_at_night() {
    // 100 kW against 30 MWp: every day's PV refills a 20 MWh battery, which carries any night or cloudy days
    let mut q = small(100.0);
    q.dg.units = 0;
    q.bess.soc_init = 1.0;
    let r = study(&q, size(30000.0, 20000.0, 2000.0), 1, 336);
    assert!(series(&r, "cum", "min").iter().all(|&x| x == 1.0), "an ample battery serves every outage");
    assert_eq!(r.get("starts", 0.0), 8760.0);
    // no battery, no gensets: every outage of a day or longer meets a night
    let r = study(&q, size(30000.0, 0.0, 0.0), 1, 336);
    let (mean, below) = (series(&r, "cum", "mean"), series(&r, "cum", "below90"));
    assert!(mean[23..].iter().all(|&x| x == 0.0) && below[23..].iter().all(|&x| x == 1.0), "{:?}", &mean[20..26]);
    assert!(mean[0] > 0.3 && mean[0] < 0.7, "one hour: served in daylight hours only, {}", mean[0]);
}

#[test]
fn failure_to_start_and_to_run_follow_the_unit_reliability() {
    // one 1000 kW genset, 500 kW load, no PV or battery: survival = (1 - FTS) e^(-d / MTTF) at every start
    let mut q = small(500.0);
    (q.dg.units, q.dg.unit_kw, q.dg.fail_start, q.dg.mttf_h) = (1, 1000.0, 0.1, 200.0);
    let r = study(&q, size(0.0, 0.0, 0.0), 24, 336);
    let rel = |d: f64| 0.9 * (-d / 200.0).exp();
    for (k, which) in [("cum", "min"), ("cum", "p5"), ("cum", "mean"), ("hourly", "mean")].into_iter() {
        for (i, x) in series(&r, k, which).into_iter().enumerate() { assert!((x - rel(i as f64 + 1.0)).abs() < 1e-6, "{k}.{which} at {} h: {x}", i + 1); }
    }
    assert_eq!(r.get("starts", 0.0), 365.0);
    // availability from the forced-outage rate, MTTF from it too when not given
    (q.dg.outage_rate, q.dg.repair_h, q.dg.mttf_h) = (2.0, 48.0, 0.0);
    let r = study(&q, size(0.0, 0.0, 0.0), 168, 100);
    let oa = 1.0 / (1.0 + 2.0 * 48.0 / 8760.0);
    let mean = series(&r, "cum", "mean");
    assert!((mean[99] - oa * 0.9 * (-100.0 / 4380.0f64).exp()).abs() < 1e-6, "{}", mean[99]);
    assert!((r.get("availability", 0.0) - oa).abs() < 1e-12 && r.get("mttf_h", 0.0) == 4380.0);
    // two units where one is enough: 1 - (1 - q)^2
    (q.dg.units, q.dg.outage_rate, q.dg.mttf_h) = (2, 0.0, 200.0);
    let r = study(&q, size(0.0, 0.0, 0.0), 168, 336);
    for (i, x) in series(&r, "cum", "min").into_iter().enumerate() {
        let p = rel(i as f64 + 1.0);
        assert!((x - (1.0 - (1.0 - p).powi(2))).abs() < 1e-6, "{} h: {x}", i + 1);
    }
}

#[test]
fn cumulative_survival_never_rises_with_the_outage_length() {
    let mut q = one_year();
    (q.dg.units, q.dg.fail_start, q.dg.mttf_h) = (14, 0.05, 1000.0);
    q.sim.critical_share = 0.8;
    let r = study(&q, HYB, 7, 336);
    for k in ["min", "p5", "mean"] {
        let v = series(&r, "cum", k);
        assert!(v.windows(2).all(|w| w[1] <= w[0] + 1e-12), "cum.{k} rises");
        assert!(v.iter().all(|&x| (0.0..=1.0).contains(&x)));
    }
    let (cum, hr, sv) = (series(&r, "cum", "mean"), series(&r, "hourly", "mean"), r.at("served_mean").arr());
    assert!(cum.iter().zip(&hr).all(|(c, h)| c <= &(h + 1e-6)), "the hourly chance is never below the cumulative one");
    assert!(cum[335] < cum[0] && sv.len() == 336);
    // each start's strip falls with the outage length too
    let rows = r.at("strip").at("values").arr();
    assert_eq!(r.at("strip").at("durations").arr().last().unwrap().num(0.0), 336.0);
    for s in 0..rows[0].len() {
        let col: Vec<f64> = rows.iter().map(|row| row.idx(s).num(0.0)).collect();
        assert!(col.windows(2).all(|w| w[1] <= w[0] + 1e-9), "start {s}: {col:?}");
    }
}

#[test]
fn a_cancel_stops_the_study() {
    let q = one_year();
    let fx = fixture();
    let si = SimInput { pv_per_kwp: &fx.pv, pv_clip_per_kwp: &[], pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
    let prog = Progress::default();
    prog.cancel.store(true, Relaxed);
    let e = resilience(&q, &si, &HYB, &ResilienceSettings::default(), &prog).unwrap_err();
    assert_eq!(e.0, "Cancelled.");
    // and the settings are checked
    for bad in [r#"{"stride":0}"#, r#"{"max_h":721}"#, r#"{"stride":1.5}"#] {
        assert!(soloptima_engine::sim::parse_resilience(&Value::parse(bad).unwrap()).is_err(), "{bad}");
    }
}

#[test]
fn the_study_runs_as_a_job_and_can_be_cancelled() {
    use soloptima_engine::api::Engine;
    use soloptima_engine::weather::{MockHttp, WeatherService};
    let dir = std::env::temp_dir().join(format!("soloptima-resilience-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let e = Engine::with_weather(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".."), dir.to_str().unwrap(),
                                 WeatherService::new(Box::new(MockHttp::default()))).unwrap();
    let mut body = Value::object();
    body.set("project", Value::parse(&read("../web/examples/example_study.json")).unwrap());
    body.set("resilience", Value::parse(r#"{"stride":168,"max_h":48}"#).unwrap());
    let id = Value::parse(&e.resilience(&body).unwrap()).unwrap().get("job", 0.0).to_string();
    let t0 = std::time::Instant::now();
    let done = loop {
        let s = Value::parse(&e.job(&id).unwrap()).unwrap();
        if s.getb("done", false) { break s; }
        assert!(t0.elapsed().as_secs() < 120, "the job did not finish");
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let r = done.at("result");
    assert_eq!((r.get("starts", 0.0), r.at("cum").at("mean").len()), (53.0, 48));
    // a long study cancelled at once answers the cancel
    body.set("resilience", Value::parse(r#"{"stride":1,"max_h":720}"#).unwrap());
    let id = Value::parse(&e.resilience(&body).unwrap()).unwrap().get("job", 0.0).to_string();
    e.job_cancel(&id).unwrap();
    let done = loop {
        let s = Value::parse(&e.job(&id).unwrap()).unwrap();
        if s.getb("done", false) { break s; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(done.gets("error", ""), "Cancelled.");
    body.set("resilience", Value::parse(r#"{"stride":200}"#).unwrap());
    assert!(e.resilience(&body).is_err(), "the settings are checked before the job starts");
    let _ = std::fs::remove_dir_all(&dir);
}
