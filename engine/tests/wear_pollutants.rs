//! Genset wear (overhauls and replacements by run hours, salvage of the life left) and the further pollutants (PM2.5, CO,
//! prices per kg, embodied PV CO2), against hand calculations. Off by default: the results stay as they were.
mod common;
use common::*;
use soloptima_engine::sim::{compare, result_to_json, SimResult};
use soloptima_engine::{validate_project, Project, HOURS};

const NONE: soloptima_engine::sim::Sizing = soloptima_engine::sim::Sizing { pv_kwp: 0.0, bess_kwh: 0.0, bess_kw: 0.0, wind_units: 0.0, gen_units: None };

/// Diesel only on a flat 900 kW load growing 5 % a year, two 1000 kW units, no reserve, 8 years: one unit runs the whole year
/// in years 1 to 3 (8760 unit-hours, 4380 h for each unit) and two from year 4 on (load 1042 kW; 8760 h for each unit)
fn flat() -> Project {
    let mut p = example();
    p.load_kw = vec![900.0; HOURS];
    p.sim.load_growth = 0.05;
    (p.dg.units, p.dg.unit_kw, p.dg.reserve_load, p.dg.reserve_pv) = (2, 1000.0, 0.0, 0.0);
    p.econ.lifetime = 8;
    p
}

fn with_wear(mut p: Project) -> Project {
    (p.econ.diesel_overhaul_h, p.econ.diesel_overhaul_kw, p.econ.diesel_life_h, p.econ.diesel_replace_kw) = (10000.0, 100.0, 30000.0, Some(400.0));
    p
}

fn col(r: &SimResult, f: fn(&soloptima_engine::sim::YearResult) -> f64) -> Vec<f64> { r.years.iter().map(f).collect() }

#[test]
fn overhauls_and_replacements_fall_in_the_year_they_are_due() {
    let p = with_wear(flat());
    validate_project(&p).unwrap();
    let r = run(&p, NONE, false);
    assert_eq!(col(&r, |y| y.unit_hours), vec![8760.0, 8760.0, 8760.0, 17520.0, 17520.0, 17520.0, 17520.0, 17520.0]);
    // each unit at the end of each year: 4380, 8760, 13140, 21900, 30660, 39420, 48180, 56940 h. Overhauls at 10 000 and
    // 20 000 h, replacement at 30 000 h, overhauls at 40 000 and 50 000 h of the unit's whole running; both units at once.
    assert_eq!(col(&r, |y| y.gen_overhauls), vec![0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0], "the overhaul at 50 000 h is in the last year: not booked");
    assert_eq!(col(&r, |y| y.gen_replacements), vec![0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0]);
    assert_eq!(col(&r, |y| y.c_gen_overhaul), vec![0.0, 0.0, 2e5, 2e5, 0.0, 0.0, 2e5, 0.0]);
    assert_eq!(col(&r, |y| y.c_gen_replace), vec![0.0, 0.0, 0.0, 0.0, 8e5, 0.0, 0.0, 0.0]);
    // salvage: 56 940 - 30 000 = 26 940 h of a 30 000 h life used, 2 x 1000 kW at 400 per kW
    let salv = -2.0 * 1000.0 * 400.0 * (30000.0 - 26940.0) / 30000.0;
    assert!((r.years[7].c_gen_salvage - salv).abs() < 1e-6, "salvage {} against {salv}", r.years[7].c_gen_salvage);
    assert!(r.years[..7].iter().all(|y| y.c_gen_salvage == 0.0));

    // booked as replacements and salvage, and discounted like them
    let off = run(&flat(), NONE, false);
    for (a, b) in r.years.iter().zip(&off.years) {
        assert!((a.c_replace - b.c_replace - a.c_gen_overhaul - a.c_gen_replace).abs() < 1e-6);
        assert!((a.c_salvage - b.c_salvage - a.c_gen_salvage).abs() < 1e-6);
        assert_eq!(a.c_fuel, b.c_fuel);
    }
    let d = p.econ.discount_rate;
    let want: f64 = r.years.iter().map(|y| (y.c_gen_overhaul + y.c_gen_replace + y.c_gen_salvage) / (1.0 + d).powi(y.year)).sum();
    assert!((r.econ.npc - off.econ.npc - want).abs() < 1e-6 * want.abs(), "NPC change {} against {want}", r.econ.npc - off.econ.npc);
    let hand = 2e5 / 1.08f64.powi(3) + 2e5 / 1.08f64.powi(4) + 8e5 / 1.08f64.powi(5) + 2e5 / 1.08f64.powi(7) + salv / 1.08f64.powi(8);
    assert!((want - hand).abs() < 1e-6, "{want} against {hand}");
    assert!(r.econ.lcoe > off.econ.lcoe);

    // the project finance takes the wear as the host's running cost, not as a replacement of the new assets
    let (f, g) = (r.fin_sim(), off.fin_sim());
    for (a, b) in f.years.iter().zip(&g.years) {
        assert!((a.c_replace - b.c_replace).abs() < 1e-6 && (a.c_salvage - b.c_salvage).abs() < 1e-6);
    }
    assert!((f.years[4].c_om_dg - g.years[4].c_om_dg - 8e5).abs() < 1e-6);
}

#[test]
fn the_replacement_cost_defaults_to_the_capex_and_overhauls_alone_have_no_salvage() {
    let mut p = with_wear(flat());
    (p.econ.diesel_replace_kw, p.econ.diesel_capex_kw) = (None, 300.0);
    let r = run(&p, NONE, false);
    assert_eq!(r.years[4].c_gen_replace, 2.0 * 1000.0 * 300.0);
    // gensets already on site (capex 0) wear out too, but a replacement left blank then costs nothing
    p.econ.diesel_capex_kw = 0.0;
    let r = run(&p, NONE, false);
    assert_eq!((r.years[4].gen_replacements, r.years[4].c_gen_replace, r.years[7].c_gen_salvage), (2.0, 0.0, 0.0));
    // overhauls only: every 10 000 h for good, no salvage
    p.econ.diesel_life_h = 0.0;
    let r = run(&p, NONE, false);
    assert_eq!(col(&r, |y| y.gen_overhauls), vec![0.0, 0.0, 2.0, 2.0, 2.0, 0.0, 2.0, 0.0]);
    assert!(r.years.iter().all(|y| y.gen_replacements == 0.0 && y.c_gen_salvage == 0.0));
}

#[test]
fn the_hybrid_runs_fewer_hours_and_replaces_fewer_units_than_diesel_only() {
    let mut p = example();
    p.sim.all_years = false;
    let (h0, b0) = (run(&p, HYB, false), run(&p, NONE, false));
    (p.econ.diesel_life_h, p.econ.diesel_replace_kw) = (20000.0, Some(350.0));
    let (h, b) = (run(&p, HYB, false), run(&p, NONE, false));
    let total = |r: &SimResult| r.years.iter().map(|y| y.gen_replacements).sum::<f64>();
    assert!(h.years[0].unit_hours < b.years[0].unit_hours);
    assert!(total(&b) > 0.0, "the diesel-only baseline wears out too");
    assert!(total(&h) < total(&b), "hybrid {} replacements, diesel only {}", total(&h), total(&b));
    // the saving of the hybrid grows by the wear it avoids
    let (c0, c) = (compare(&h0, &b0), compare(&h, &b));
    assert!(c.npv_savings > c0.npv_savings, "{} against {}", c.npv_savings, c0.npv_savings);
    // the year keys appear only with wear on
    let (on, off) = (result_to_json(&h, false), result_to_json(&h0, false));
    assert!(on.at("years").idx(0).at("gen_replacements").num(f64::NAN).is_finite() && off.at("years").idx(0).at("gen_replacements").is_null());
}

#[test]
fn a_mixed_fleet_wears_group_by_group() {
    let mut p = with_wear(flat());
    p.dg.units = 1;
    let mut g = soloptima_engine::GensetGroup {
        name: "spare".into(), units: 1, unit_kw: 1000.0, min_load: 0.3, fuel_model: p.dg.fuel_model.clone(), fuel_intercept: 0.0, fuel_slope: 0.0,
        fuel_curve: p.dg.fuel_curve.clone(), capex_kw: None, om_kwh: None, om_unit_hour: None, overhaul_h: None, overhaul_kw: Some(50.0), life_h: Some(0.0),
        replace_kw: None,
    };
    g.fuel_curve.iter_mut().for_each(|pt| pt.1 /= 1.1);   // dearer: runs second
    p.dg.more_groups.push(g);
    validate_project(&p).unwrap();
    let r = run(&p, NONE, false);
    for y in &r.years {
        assert_eq!(y.groups.iter().map(|g| g.overhauls).sum::<f64>(), y.gen_overhauls);
        assert_eq!(y.groups.iter().map(|g| g.replacements).sum::<f64>(), y.gen_replacements);
    }
    // the main unit runs all year, 8760 h a year: overhauls at 10 000, 20 000, 40 000 and 50 000 h, replacements at 30 000
    // and 60 000 h; the spare runs from year 4, overhauled every 10 000 h at its own cost, with no replacement life
    let (main, spare) = (col(&r, |y| y.groups[0].overhauls), col(&r, |y| y.groups[1].overhauls));
    assert_eq!(main, vec![0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
    assert_eq!(col(&r, |y| y.groups[0].replacements), vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0]);
    assert_eq!(spare, vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0]);
    assert!(r.years.iter().all(|y| y.groups[1].replacements == 0.0));
    assert_eq!(r.years[4].c_gen_overhaul, 1000.0 * 100.0 + 1000.0 * 50.0);
    assert_eq!(r.years[6].c_gen_overhaul, 1000.0 * 50.0);
    let js = result_to_json(&r, false);
    assert!(js.at("years").idx(0).at("groups").idx(1).at("overhauls").num(f64::NAN).is_finite());
}

#[test]
fn pollutants_and_their_prices_against_hand_calculations() {
    let mut p = example();
    p.sim.all_years = false;
    let off = run(&p, HYB, false);
    (p.econ.pm25_g_per_l, p.econ.co_g_per_l) = (1.2, 15.0);
    (p.econ.nox_price_kg, p.econ.sox_price_kg, p.econ.pm25_price_kg, p.econ.co_price_kg) = (8.0, 10.0, 50.0, 0.5);
    validate_project(&p).unwrap();
    let r = run(&p, HYB, false);
    let (y, y0) = (&r.years[0], &off.years[0]);
    assert_eq!(y.fuel_l, y0.fuel_l, "the prices do not change the dispatch off grid");
    let fuel = y.fuel_l;
    assert!((y.pm25_t - fuel * 1.2 / 1e6).abs() < 1e-9 && (y.co_t - fuel * 15.0 / 1e6).abs() < 1e-9);
    let cost = fuel * (35.0 * 8.0 + 0.8 * 10.0 + 1.2 * 50.0 + 15.0 * 0.5) / 1000.0;   // g/L x price per kg / 1000
    assert!((y.c_pollutants - cost).abs() < 1e-6 * cost, "{} against {cost}", y.c_pollutants);
    assert!((y.c_total - y0.c_total - cost).abs() < 1e-6 * cost);
    let d = p.econ.discount_rate;
    let want: f64 = r.years.iter().map(|y| y.c_pollutants / (1.0 + d).powi(y.year)).sum();
    assert!((r.econ.npc - off.econ.npc - want).abs() < 1e-6 * want);
    assert!((r.metrics.pm25_kg - fuel * 1.2 / 1000.0).abs() < 1e-6);
    // the diesel-only baseline pays more: the hybrid's saving grows
    let (b0, b) = { let mut q = p.clone(); let b = run(&q, NONE, false); q.econ = example().econ; (run(&q, NONE, false), b) };
    assert!(b.years[0].c_pollutants > y.c_pollutants);
    assert!(compare(&r, &b).npv_savings > compare(&off, &b0).npv_savings);
    // the project finance takes it with the carbon cost
    assert!((r.fin_sim().years[0].c_carbon - y.c_carbon - cost).abs() < 1e-6 * cost);
    let js = result_to_json(&r, false);
    assert!(js.at("metrics").at("co_kg").num(f64::NAN).is_finite() && js.at("years").idx(0).at("c_pollutants").num(f64::NAN).is_finite());
    assert!(result_to_json(&off, false).at("metrics").at("co_kg").is_null());
}

#[test]
fn embodied_pv_co2_adds_to_the_co2_and_its_cost() {
    let mut p = example();
    p.sim.all_years = false;
    p.econ.carbon_price_t = 40.0;
    let off = run(&p, HYB, false);
    p.econ.pv_co2_kg_per_kwh = 0.03;
    let r = run(&p, HYB, false);
    let (y, y0) = (&r.years[0], &off.years[0]);
    let pv_t = y.pv_avail * 0.03 / 1000.0;
    assert!((y.co2_pv_t - pv_t).abs() < 1e-9 && (y.co2_t - y0.co2_t - pv_t).abs() < 1e-9);
    assert!((y.c_carbon - y0.c_carbon - pv_t * 40.0).abs() < 1e-6);
    assert!((r.metrics.co2_t - y.co2_t).abs() < 1e-12);
    // no PV, no embodied CO2: the diesel-only baseline is unchanged
    let b = run(&p, NONE, false);
    assert_eq!(b.years[0].co2_pv_t, 0.0);
}

#[test]
fn absent_or_zero_the_new_inputs_change_nothing_and_bad_ones_are_refused() {
    let mut p = example();
    p.sim.all_years = false;
    let a = result_to_json(&run(&p, HYB, true), true).dump();
    (p.econ.diesel_overhaul_kw, p.econ.diesel_replace_kw, p.econ.pv_co2_kg_per_kwh) = (90.0, Some(300.0), 0.0);
    assert_eq!(result_to_json(&run(&p, HYB, true), true).dump(), a, "costs without intervals do nothing");
    let ok = example();
    let bad = |f: &dyn Fn(&mut Project)| { let mut q = ok.clone(); f(&mut q); validate_project(&q).is_err() };
    assert!(validate_project(&ok).is_ok());
    assert!(bad(&|q| q.econ.diesel_life_h = 50.0));
    assert!(bad(&|q| q.econ.diesel_overhaul_h = -1.0));
    assert!(bad(&|q| q.econ.diesel_replace_kw = Some(-1.0)));
    assert!(bad(&|q| q.econ.pm25_price_kg = -1.0));
    assert!(bad(&|q| q.econ.pv_co2_kg_per_kwh = f64::NAN));
    let mut g = flat();
    g.dg.more_groups.push(soloptima_engine::GensetGroup {
        name: "x".into(), units: 1, unit_kw: 500.0, min_load: 0.3, fuel_model: "linear".into(), fuel_intercept: 0.03, fuel_slope: 0.25, fuel_curve: vec![],
        capex_kw: None, om_kwh: None, om_unit_hour: None, overhaul_h: Some(20.0), overhaul_kw: None, life_h: None, replace_kw: None,
    });
    assert!(validate_project(&g).is_err());
}
