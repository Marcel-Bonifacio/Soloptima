//! Mixed genset fleets: several groups committed in merit order and sharing the load, on the example project (20 x 1800 kW)
//! with the fixture PV (common/mod.rs).
mod common;
use common::*;
use soloptima_engine::sim::{result_to_json, SimResult};
use soloptima_engine::{parse_project, validate_project, GensetGroup, Project, Value, HOURS};

fn group(name: &str, units: i32, unit_kw: f64) -> GensetGroup {
    let d = example().dg;
    GensetGroup { name: name.into(), units, unit_kw, min_load: d.min_load, fuel_model: d.fuel_model.clone(), fuel_intercept: d.fuel_intercept,
                  fuel_slope: d.fuel_slope, fuel_curve: d.fuel_curve.clone(), capex_kw: None, om_kwh: None, om_unit_hour: None }
}

fn year1(mut p: Project) -> Project { p.sim.all_years = false; p }

fn check_groups(r: &SimResult) {
    for y in &r.years {
        let sum = |f: fn(&soloptima_engine::sim::GroupYear) -> f64| y.groups.iter().map(f).sum::<f64>();
        assert!((sum(|g| g.gen_kwh) - y.gen_kwh).abs() < 1e-6 * y.gen_kwh.max(1.0), "group energy {} vs {}", sum(|g| g.gen_kwh), y.gen_kwh);
        assert!((sum(|g| g.fuel_l) - y.fuel_l).abs() < 1e-6 * y.fuel_l.max(1.0), "group fuel");
        assert_eq!(sum(|g| g.unit_hours), y.unit_hours, "group unit-hours");
        assert_eq!(sum(|g| g.starts), y.starts, "group starts");
        assert!((sum(|g| g.c_om) - y.c_om_dg).abs() < 1e-6 * y.c_om_dg.max(1.0), "group O&M");
    }
}

#[test]
fn an_old_project_and_one_split_into_equal_groups_agree() {
    // an empty list of further groups is the old fleet to the byte
    let doc = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    let mut d2 = doc.clone();
    let mut dg = d2.at("diesel").clone();
    dg.set("more_groups", Value::array());
    d2.set("diesel", dg);
    let (a, b) = (year1(parse_project(&doc)), year1(parse_project(&d2)));
    assert_eq!(result_to_json(&run(&a, HYB, true), true).dump(), result_to_json(&run(&b, HYB, true), true).dump());

    // 20 identical units as two groups of 10: the same dispatch, to rounding
    let mut q = a.clone();
    q.dg.units = 10;
    q.dg.more_groups.push(group("second half", 10, 1800.0));
    let (ra, rq) = (run(&a, HYB, true), run(&q, HYB, true));
    check_groups(&rq);
    let (ya, yq) = (&ra.years[0], &rq.years[0]);
    assert_eq!(ya.unit_hours, yq.unit_hours);
    assert!((ya.fuel_l - yq.fuel_l).abs() < 1e-9 * ya.fuel_l, "fuel {} vs {}", ya.fuel_l, yq.fuel_l);
    assert!((ra.econ.npc - rq.econ.npc).abs() < 1e-9 * ra.econ.npc);
    assert_eq!(rq.years[0].groups.len(), 2);
    assert!(result_to_json(&rq, false).at("years").idx(0).at("groups").is_array());
    assert!(result_to_json(&ra, false).at("years").idx(0).at("groups").is_null());
}

#[test]
fn the_cheaper_group_runs_first_and_reserve_spans_the_fleet() {
    // 10 x 1800 kW as before, plus 12 x 800 kW units that burn 15 % more fuel per kWh
    let mut q = year1(example());
    q.dg.units = 10;
    let mut small = group("small", 12, 800.0);
    for pt in small.fuel_curve.iter_mut() { pt.1 /= 1.15; }
    small.om_unit_hour = Some(1.0);
    small.capex_kw = Some(500.0);
    q.dg.more_groups.push(small);
    let r = run(&q, HYB, true);
    check_groups(&r);
    let (y, h) = (&r.years[0], r.hourly.as_ref().unwrap());
    let (big, sm) = (&y.groups[0], &y.groups[1]);
    assert_eq!((big.index, sm.index), (0, 1), "the main group is the cheaper one");
    assert!(big.unit_hours > sm.unit_hours, "big {} small {}", big.unit_hours, sm.unit_hours);
    assert!(y.unmet < 1e-6, "unmet {}", y.unmet);
    // a small unit runs only with every big unit online
    for t in 0..HOURS {
        let u = h.gen_units[t];
        assert!(u <= 22.0);
        if u > 10.0 { assert!(h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t] <= 10.0 * 1800.0 + (u - 10.0) * 800.0 + 1e-6); }
    }
    assert_eq!(r.econ.capex_diesel, q.econ.diesel_capex_kw * 18000.0 + 500.0 * 9600.0);
    assert!(r.avg_gen_load > 0.3 && r.avg_gen_load <= 1.0, "loading {}", r.avg_gen_load);
}

#[test]
fn every_strategy_runs_a_mixed_fleet() {
    for strat in ["cycle_charging", "predictive"] {
        let mut q = year1(example());
        q.dg.strategy = strat.into();
        q.dg.units = 12;
        let mut g = group("small", 10, 1000.0);
        g.fuel_model = "linear".into();
        q.dg.more_groups.push(g);
        let r = run(&q, HYB, true);
        check_groups(&r);
        let h = r.hourly.as_ref().unwrap();
        assert!(balance_error(h) < 0.05, "{strat} balance {}", balance_error(h));
        assert!(r.years[0].unmet < 1e-3 * r.years[0].load, "{strat} unmet");
    }
}

#[test]
fn groups_are_read_and_checked() {
    let mut doc = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    let mut dg = doc.at("diesel").clone();
    dg.set("more_groups", Value::parse(r#"[{"name":"B","units":2,"unit_kw":500,"om_kwh":0.02,"fuel_curve":[[0.5,3],[1,3.5]]},{"units":1}]"#).unwrap());
    doc.set("diesel", dg);
    let p = parse_project(&doc);
    let (b, c) = (&p.dg.more_groups[0], &p.dg.more_groups[1]);
    assert_eq!((b.name.as_str(), b.units, b.unit_kw, b.om_kwh, b.capex_kw), ("B", 2, 500.0, Some(0.02), None));
    assert_eq!(b.fuel_curve, vec![(0.5, 3.0), (1.0, 3.5)]);
    assert_eq!((c.unit_kw, c.min_load, &c.fuel_curve), (p.dg.unit_kw, p.dg.min_load, &p.dg.fuel_curve), "a group without values takes the main group's");
    assert!(validate_project(&p).is_ok());
    let mut q = p.clone();
    q.dg.more_groups[0].unit_kw = 0.0;
    assert!(validate_project(&q).unwrap_err().0.contains("Genset group B"));
    q.dg.more_groups[0].unit_kw = 500.0;
    q.dg.more_groups[1].fuel_curve.truncate(1);
    assert!(validate_project(&q).unwrap_err().0.contains("Genset group 3: the fuel curve"));
    q.dg.more_groups[1].fuel_curve = p.dg.fuel_curve.clone();
    q.dg.more_groups[1].om_unit_hour = Some(-1.0);
    assert!(validate_project(&q).unwrap_err().0.contains("costs"));
}
