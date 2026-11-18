//! Random outages of the PV inverter blocks and the battery's PCS units (pv.inverter_outage_rate, bess.pcs_outage_rate) on
//! the example project with the fixture PV (common/mod.rs): off by default, the expected unavailability over many years, the
//! energy they take, the battery power they take, the draw by seed, the EMS and short steps.
mod common;
use common::*;
use soloptima_engine::sim::result_to_json;
use soloptima_engine::{validate_project, Project};

fn one_year() -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q
}

// A unit that fails `rate` times a year and is repaired in a mean `repair` hours is out a share repair / (8760 / rate + repair)
// of the time (an alternating renewal process: the time to the next failure counts from the end of the repair)
fn unavailability(rate: f64, repair: f64) -> f64 { repair / (8760.0 / rate + repair) }

#[test]
fn off_by_default_and_nothing_changes() {
    let q = one_year();
    assert_eq!(q.pv.inverter_outage_rate, 0.0);
    assert_eq!(q.bess.pcs_outage_rate, 0.0);
    let (a, mut q2) = (run(&q, HYB, false), q.clone());
    // other unit sizes and repair times do nothing while the rates are 0
    q2.pv.inverter_unit_kw = 50.0;
    q2.bess.pcs_repair_h = 500.0;
    let b = run(&q2, HYB, false);
    assert_eq!(a.years[0].fuel_l, b.years[0].fuel_l);
    assert_eq!(a.years[0].pv_avail, b.years[0].pv_avail);
    let j = result_to_json(&a, false);
    assert!(!j.at("years").idx(0).has("inverter_outages") && !j.at("years").idx(0).has("pcs_outages"));
}

#[test]
fn inverter_outages_take_their_share_of_the_pv_over_the_years() {
    let mut q = example();
    q.sim.all_years = true;
    let base = run(&q, HYB, false);
    q.pv.inverter_unit_kw = 1000.0;   // 1 MW blocks: 30 MWp over the project's DC/AC ratio, about 25 of them
    let blocks = (HYB.pv_kwp / q.pv.dc_ac_ratio / 1000.0).ceil();
    q.pv.inverter_outage_rate = 2.0;
    q.pv.inverter_repair_h = 200.0;
    let r = run(&q, HYB, false);
    let (lost, avail): (f64, f64) = r.years.iter().fold((0.0, 0.0), |s, y| (s.0 + y.inverter_outage_kwh, s.1 + y.pv_avail));
    let share = lost / (lost + avail);
    let want = unavailability(2.0, 200.0);
    // some 25 blocks x 25 years: the share lost is the unavailability within a few tenths of a percent
    assert!((share - want).abs() < 0.006, "PV lost to inverter outages {share:.4} against {want:.4}");
    let n: f64 = r.years.iter().map(|y| y.inverter_outages).sum::<f64>() / blocks / 25.0;
    assert!((n - 2.0 * (1.0 - want)).abs() < 0.2, "failures per block and year {n}");
    let h: f64 = r.years.iter().map(|y| y.inverter_outage_h).sum::<f64>() / blocks / 25.0 / 8760.0;
    assert!((h - want).abs() < 0.006, "share of block-hours out {h:.4}");
    // the PV the outages take is energy the gensets make up: more fuel, never less
    let (f0, f1): (f64, f64) = (base.years.iter().map(|y| y.fuel_l).sum(), r.years.iter().map(|y| y.fuel_l).sum());
    assert!(f1 > f0, "fuel {f1} against {f0} without outages");
    let jy = result_to_json(&r, false);
    let y0 = jy.at("years").idx(0);
    assert!(y0.has("inverter_outages") && y0.has("inverter_outage_h") && y0.has("inverter_outage_kwh") && !y0.has("pcs_outages"));
}

#[test]
fn the_seed_draws_the_outages_and_each_kind_draws_apart() {
    let mut q = one_year();
    q.pv.inverter_outage_rate = 3.0;
    q.bess.pcs_outage_rate = 3.0;
    let (a, b) = (run(&q, HYB, false), run(&q, HYB, false));
    assert_eq!(a.years[0].fuel_l, b.years[0].fuel_l, "the same seed gives the same year");
    assert_eq!(a.years[0].inverter_outage_kwh, b.years[0].inverter_outage_kwh);
    q.dg.outage_seed = 7;
    let c = run(&q, HYB, false);
    assert_ne!(c.years[0].inverter_outage_kwh, a.years[0].inverter_outage_kwh, "another seed, other outages");
    // the gensets keep their own draw when the inverters and PCS units start failing
    let mut g = one_year();
    g.dg.outage_rate = 4.0;
    let mut g2 = g.clone();
    g2.pv.inverter_outage_rate = 3.0;
    assert_eq!(run(&g, HYB, false).years[0].unit_outage_h, run(&g2, HYB, false).years[0].unit_outage_h);
}

#[test]
fn a_pcs_unit_out_takes_the_battery_power_with_it() {
    let mut q = one_year();
    q.bess.pcs_unit_kw = 5000.0;   // one PCS unit for the 2.32 MW battery: when it fails the battery stands still
    q.bess.pcs_outage_rate = 6.0;
    q.bess.pcs_repair_h = 120.0;
    let (r0, r) = (run(&one_year(), HYB, true), run(&q, HYB, true));
    let y = &r.years[0];
    assert!(y.pcs_outages > 2.0 && y.pcs_outage_h > 300.0, "outages {} for {} h", y.pcs_outages, y.pcs_outage_h);
    let h = r.hourly.as_ref().unwrap();
    assert!(y.bess_dis < r0.years[0].bess_dis && y.fuel_l > r0.years[0].fuel_l, "the battery does less and the gensets more");
    assert!(balance_error(h) < 0.05);
    // several smaller units: an outage takes only part of the power, so the battery keeps working through it
    let mut m = q.clone();
    m.bess.pcs_unit_kw = 500.0;   // 5 units
    let rm = run(&m, HYB, false);
    assert!(rm.years[0].bess_dis > y.bess_dis, "five units lose less than one");
}

#[test]
fn the_predictive_ems_and_short_steps_run_with_outages() {
    let mut q = one_year();
    q.pv.inverter_outage_rate = 4.0;
    q.bess.pcs_outage_rate = 4.0;
    q.sim.step_min = 15;
    let r = run(&q, HYB, true);
    assert!(r.years[0].inverter_outages > 0.0 && r.years[0].pcs_outages > 0.0);
    assert!(balance_error(r.steps.as_ref().unwrap()) < 0.05);
    let mut e = one_year();
    e.pv.inverter_outage_rate = 4.0;
    e.bess.pcs_outage_rate = 4.0;
    e.dg.strategy = "predictive".into();
    let re = run(&e, HYB, false);
    assert!(re.years[0].unmet.is_finite() && re.years[0].fuel_l > 0.0);
}

#[test]
fn settings_are_checked() {
    let mut q = one_year();
    q.pv.inverter_outage_rate = -1.0;
    assert!(validate_project(&q).unwrap_err().0.contains("Inverter outages"));
    q.pv.inverter_outage_rate = 1.0;
    q.pv.inverter_unit_kw = 0.0;
    assert!(validate_project(&q).unwrap_err().0.contains("Inverter outages"));
    q.pv.inverter_unit_kw = 250.0;
    q.bess.pcs_repair_h = 0.0;
    assert!(validate_project(&q).unwrap_err().0.contains("PCS outages"));
    q.bess.pcs_repair_h = 72.0;
    assert!(validate_project(&q).is_ok());
}
