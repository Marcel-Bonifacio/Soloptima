//! The predictive EMS with hour costs that depend on the stored energy (`ems.reserve_energy`): the plan keeps reserve energy
//! in the battery when that is cheaper than starting a genset for the reserve. On the example project (common/mod.rs).
mod common;
use common::*;
use soloptima_engine::sim::{plan_input, reserve_cap_step, FuelTable, PlanInput, Planner};

/// Cost of a planned path with the battery reserve limited by its stored energy, the terminal value included
fn path_cost(pl: &Planner, i: &PlanInput, e: &[f64], lf: &[f64], pf: &[f64]) -> f64 {
    let mut c = 0.0;
    for j in 0..lf.len() {
        let de = e[j + 1] - e[j];
        let b = if de < 0.0 { -de * i.eta } else { -de / i.eta };
        c += pl.hour_cost(i, lf[j], pf[j], b, reserve_cap_step(i, e[j], e[j + 1])).0;
    }
    c - i.terminal_per_kwh * e[lf.len()]
}

#[test]
fn the_plan_is_the_cheapest_once_reserve_needs_energy() {
    // the fleet of the battery test (5 x 400 kW), loads that need the battery's reserve, a battery near empty
    let mut q = example();
    q.dg.unit_kw = 400.0;
    q.dg.units = 5;
    let fuel = FuelTable::new(&q.dg).unwrap();
    let mut pl = Planner::new(&q.dg, &fuel);
    let mut i = plan_input(&q, &fuel);
    (i.e_min, i.e_max, i.pb) = (200.0, 2000.0, 1000.0);
    let lf: Vec<f64> = (0..24).map(|j| 1100.0 + 300.0 * (2.0 * std::f64::consts::PI * f64::from(j) / 24.0).sin()).collect();
    let pf: Vec<f64> = (0..24).map(|j| if (8..16).contains(&j) { 1500.0 } else { 0.0 }).collect();
    let (mut e_off, mut e_on, mut u) = (Vec::new(), Vec::new(), Vec::new());
    assert!(!i.reserve_energy, "off by default");
    pl.plan(&i, 400.0, &lf, &pf, &mut e_off, &mut u);
    i.reserve_energy = true;
    pl.plan(&i, 400.0, &lf, &pf, &mut e_on, &mut u);
    let (c_off, c_on) = (path_cost(&pl, &i, &e_off, &lf, &pf), path_cost(&pl, &i, &e_on, &lf, &pf));
    assert!(c_on <= c_off + 1e-6, "with the energy limit the plan costs {c_on}, the plan without it {c_off}");
    assert!(c_on < c_off - 1.0, "the energy limit should change the plan here ({c_on} vs {c_off})");
    // without battery reserve the option changes nothing
    i.provides_reserve = false;
    let mut e_nr = Vec::new();
    pl.plan(&i, 400.0, &lf, &pf, &mut e_nr, &mut u);
    i.reserve_energy = false;
    let mut e_nr0 = Vec::new();
    pl.plan(&i, 400.0, &lf, &pf, &mut e_nr0, &mut u);
    assert_eq!(e_nr, e_nr0);
}

#[test]
fn the_example_runs_with_fewer_genset_hours() {
    let mut a = example();
    a.sim.all_years = false;
    a.dg.strategy = "predictive".into();
    let mut b = a.clone();
    b.ems.reserve_energy = true;
    let (ra, rb) = (run(&a, HYB, true), run(&b, HYB, true));
    let (ya, yb) = (&ra.years[0], &rb.years[0]);
    assert!(balance_error(rb.hourly.as_ref().unwrap()) < 0.05);
    assert!(yb.unmet < 1e-6 && yb.reserve_short_h <= ya.reserve_short_h);
    assert!(yb.unit_hours < ya.unit_hours, "unit-hours {} vs {}", yb.unit_hours, ya.unit_hours);
    assert!(rb.econ.npc < ra.econ.npc * 1.001, "NPC {} vs {}", rb.econ.npc, ra.econ.npc);
}
