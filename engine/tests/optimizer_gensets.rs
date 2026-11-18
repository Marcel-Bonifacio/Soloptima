//! Genset fleet sizing in the optimiser and the best design per system type, on the example project scaled to a small plant
//! (about 230 kW of load, 4 x 100 kW gensets at a capex per kW) and simulated over year 1.
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::pv::compute_pv_profile;
use soloptima_engine::sim::{result_to_json, simulate, SimInput, SimResult, Sizing};
use soloptima_engine::{parse_project, GensetGroup, Project, Value};
use std::path::PathBuf;

fn example() -> Project {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json");
    let mut p = parse_project(&Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap());
    p.sim.all_years = false;
    p
}

/// The example at 1 % of its load with 4 x 100 kW gensets that cost 600 per kW
fn small() -> Project {
    let mut p = example();
    for x in &mut p.load_kw { *x *= 0.01; }
    p.load_sub.clear();
    p.dg.unit_kw = 100.0;
    p.dg.units = 4;
    p.econ.diesel_capex_kw = 600.0;
    p
}

fn settings(p: &Project, block: &str) -> Result<soloptima_engine::optimizer::OptSettings, String> {
    parse_opt_settings(&Value::parse(block).unwrap(), p).map_err(|e| e.0)
}

fn run(p: &Project, block: &str) -> Value { optimize(p, &settings(p, block).unwrap(), &Progress::default()).unwrap() }

fn sim(p: &Project, s: Sizing) -> SimResult {
    let prof = compute_pv_profile(p).unwrap();
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
    simulate(p, &si, &s, false).unwrap()
}

const SMALL: &str = r#""pv_max":3000,"pv_steps":4,"bess_max":12000,"bess_steps":4,"refine":false"#;

#[test]
fn off_by_default_answers_as_before() {
    let p = small();
    let a = run(&p, &format!("{{{SMALL}}}"));
    // the bounds alone change nothing while sizing is off
    let b = run(&p, &format!(r#"{{{SMALL},"size_gensets":false,"gen_units_min":0,"gen_units_max":3}}"#));
    assert_eq!(a.dump(), b.dump());
    assert!(!a.has("architectures") && !a.at("best").has("gen_units") && !a.at("settings").has("size_gensets"));
    // a size that names the project's own count runs the project's fleet
    let s = Sizing { pv_kwp: 1000.0, bess_kwh: 2000.0, bess_kw: 1000.0, ..Default::default() };
    let own = sim(&p, Sizing { gen_units: Some(4), ..s });
    let mut j = result_to_json(&own, false);
    assert_eq!(j.at("size").at("gen_units").num(-1.0), 4.0);
    let mut size = j.at("size").clone();
    if let Value::Obj(o) = &mut size { o.remove("gen_units"); }
    j.set("size", size);
    assert_eq!(j.dump(), result_to_json(&sim(&p, s), false).dump());
}

#[test]
fn sizing_drops_units_that_large_pv_and_storage_make_redundant() {
    let p = small();
    let fixed = r#""pv_min":4000,"pv_max":4001,"pv_steps":1,"bess_min":12000,"bess_max":12001,"bess_steps":1,"c_rates":[0.25],"refine":false"#;
    // with a little unmet load allowed, PV and storage alone are enough: no gensets at all
    let r = run(&p, &format!(r#"{{{fixed},"max_unmet":0.02,"size_gensets":true,"gen_units_min":0,"gen_units_max":4}}"#));
    let b = r.at("best");
    assert_eq!(b.get("gen_units", -1.0), 0.0, "best {}", b.dump());
    assert!(b.get("fuel", 1.0) == 0.0 && b.get("unmet", 1.0) <= 0.02);
    assert_eq!(r.at("best_detail").at("size").get("gen_units", -1.0), 0.0);
    // the diesel-only reference keeps the project's 4 units, so the saving is against them
    assert!(!r.at("baseline").at("size").has("gen_units") && r.at("baseline").at("econ").get("capex_diesel", 0.0) == 4.0 * 100.0 * 600.0);
    assert!(r.at("comparison").get("fuel_saved_l_y1", 0.0) > 0.0);
    assert!(r.at("at_boundary").arr().iter().all(|e| e.str() != "gen_max"));

    // with the strict default limit some gensets stay, but fewer than the project's four
    let r = run(&p, &format!(r#"{{{fixed},"size_gensets":true,"gen_units_min":0,"gen_units_max":4}}"#));
    let n = r.at("best").get("gen_units", -1.0);
    assert!((0.0..4.0).contains(&n), "best {}", r.at("best").dump());
    // without PV and storage the full fleet is needed
    let r = run(&p, r#"{"pv_min":0,"pv_max":1,"pv_steps":1,"bess_min":0,"bess_max":1,"bess_steps":1,"refine":false,"size_gensets":true,"gen_units_min":0,"gen_units_max":4}"#);
    assert_eq!(r.at("best").get("gen_units", -1.0), 3.0, "a 252 kW peak needs three 100 kW units: {}", r.at("best").dump());
}

#[test]
fn the_metaheuristics_search_the_count_too() {
    let p = small();
    let r = run(&p, r#"{"algorithm":"pso","particles":8,"iterations":6,"pv_max":4000,"bess_max":12000,"max_unmet":0.02,"size_gensets":true,"gen_units_min":0,"gen_units_max":4}"#);
    let ev = r.at("evaluated").arr();
    let counts: std::collections::BTreeSet<i64> = ev.iter().map(|c| c.get("gen_units", -1.0) as i64).collect();
    assert!(counts.iter().all(|n| (0..=4).contains(n)) && counts.len() > 1, "counts {counts:?}");
    assert!(!r.at("best").is_null());
}

#[test]
fn the_count_reaches_dispatch_and_costs() {
    let p = small();
    let s = Sizing { pv_kwp: 500.0, bess_kwh: 500.0, bess_kw: 250.0, ..Default::default() };
    let (two, four) = (sim(&p, Sizing { gen_units: Some(2), ..s }), sim(&p, Sizing { gen_units: Some(4), ..s }));
    assert_eq!(two.econ.capex_diesel, 2.0 * 100.0 * 600.0);
    assert_eq!(four.econ.capex_diesel, 4.0 * 100.0 * 600.0);
    assert!(two.years[0].max_units <= 2.0 && four.years[0].max_units > 2.0, "{} {}", two.years[0].max_units, four.years[0].max_units);
    assert!(two.unmet_fraction > four.unmet_fraction, "two units cannot carry the night peak");

    // none: no fuel, run-hours or genset O&M, and the plant still balances
    let none = sim(&p, Sizing { gen_units: Some(0), ..s });
    let y = &none.years[0];
    assert!(none.econ.capex_diesel == 0.0 && y.fuel_l == 0.0 && y.gen_kwh == 0.0 && y.unit_hours == 0.0 && y.c_om_dg == 0.0 && y.c_fuel == 0.0);
    assert!(none.econ.npc.is_finite() && none.econ.lcoe.is_finite() && y.unmet > 0.0 && y.reserve_short_h > 0.0);
    assert!((y.served + y.unmet - y.load).abs() < 1e-6 * y.load);

    // a mixed fleet: only the main group is sized, the further group keeps its units and costs
    let mut q = small();
    q.dg.more_groups.push(GensetGroup { name: "spare".into(), units: 2, unit_kw: 150.0, min_load: 0.3, fuel_model: "linear".into(), fuel_intercept: 0.03,
        fuel_slope: 0.25, fuel_curve: vec![], capex_kw: Some(400.0), om_kwh: None, om_unit_hour: None,
        overhaul_h: None, overhaul_kw: None, life_h: None, replace_kw: None });
    let m = sim(&q, Sizing { gen_units: Some(0), ..s });
    assert_eq!(m.econ.capex_diesel, 2.0 * 150.0 * 400.0);
    assert!(m.years[0].gen_kwh > 0.0 && m.years[0].max_units <= 2.0);
    let main = m.fleet.iter().find(|g| g.0 == 0).unwrap();
    assert_eq!(main.1, 0, "main group sized to 0");
}

#[test]
fn one_best_design_per_system_type() {
    let p = small();
    let r = run(&p, r#"{"pv_max":3000,"pv_steps":3,"bess_max":12000,"bess_steps":3,"max_unmet":0.02,"size_gensets":true,"gen_units_min":0,"gen_units_max":3}"#);
    let rows = r.at("architectures").arr();
    let labels: Vec<&str> = rows.iter().map(|a| a.at("label").str()).collect();
    let mut uniq = labels.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), labels.len(), "{labels:?}");
    // PV 0 / 1500 / 3000 x BESS 0 / 6000 / 12000 x 0-3 units: all eight types without wind
    assert_eq!(rows.len(), 8, "{labels:?}");
    assert!(labels.contains(&"PV + battery") && labels.contains(&"PV + battery + diesel") && labels.contains(&"diesel") && labels.contains(&"no supply"));
    let ranked = r.at("ranked").arr();
    let mut last = f64::NEG_INFINITY;
    for a in rows {
        let b = a.at("best");
        assert!(a.get("n_feasible", 0.0) <= a.get("n_evaluated", 0.0));
        if b.is_null() { assert_eq!(a.get("n_feasible", -1.0), 0.0); continue; }
        assert!(b.at("feasible").boolean(false), "{}", a.dump());
        // the design is of its type
        assert_eq!(b.get("pv_kwp", 0.0) > 0.0, a.at("pv").boolean(false));
        assert_eq!(b.get("bess_kwh", 0.0) > 0.0, a.at("bess").boolean(false));
        assert_eq!(b.get("gen_units", 0.0) > 0.0, a.at("gensets").boolean(false));
        // and the cheapest of the feasible designs of that type
        let npc = b.get("npc", 0.0);
        assert!(npc >= last, "rows sorted by objective");
        last = npc;
        let same = |c: &Value| (c.get("pv_kwp", 0.0) > 0.0, c.get("bess_kwh", 0.0) > 0.0, c.get("gen_units", 0.0) > 0.0)
            == (b.get("pv_kwp", 0.0) > 0.0, b.get("bess_kwh", 0.0) > 0.0, b.get("gen_units", 0.0) > 0.0);
        assert!(ranked.iter().filter(|c| same(c)).all(|c| c.get("npc", 0.0) >= npc - 1e-6));
    }
    assert_eq!(rows[0].at("best").get("npc", 0.0), r.at("best").get("npc", 1.0), "the first type holds the overall optimum");
    // no feasible design without any supply
    let none = rows.iter().find(|a| a.at("label").str() == "no supply").unwrap();
    assert!(none.at("best").is_null());
}

#[test]
fn the_counts_are_checked() {
    let p = small();
    let err = |b: &str| settings(&p, b).unwrap_err();
    assert_eq!(err(r#"{"size_gensets":true,"gen_units_min":3,"gen_units_max":2}"#), "The least number of genset units must not exceed the most.");
    assert_eq!(err(r#"{"size_gensets":true,"gen_units_min":-1,"gen_units_max":2}"#), "The genset unit counts must not be negative.");
    assert_eq!(err(r#"{"size_gensets":true,"gen_units_min":0,"gen_units_max":-2}"#), "The genset unit counts must not be negative.");
    assert_eq!(err(r#"{"size_gensets":true,"gen_units_max":5000}"#), "At most 1000 genset units.");
    // the project's count when not given; not checked while sizing is off
    let o = settings(&p, r#"{"size_gensets":true}"#).unwrap();
    assert_eq!((o.gen_units_min, o.gen_units_max), (4, 4));
    assert!(settings(&p, r#"{"gen_units_min":3,"gen_units_max":2}"#).is_ok());
}
