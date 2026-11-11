//! Clipping under PV degradation, replacement of the battery PCS, genset start cost, battery autonomy and the air density of
//! the wind power curve.
mod common;
use common::*;
use soloptima_engine::compute_pv_profile;
use soloptima_engine::pv::wind_per_turbine;
use soloptima_engine::sim::{simulate, SimInput, Sizing};
use soloptima_engine::{pv_degradation_factor, HOURS};

/// The inverter's AC rating stays as the modules degrade: in year n the output is min(f (ac + clip), cap) per kWp, more than
/// f ac in the hours that clipped in year 1; year 1 is unchanged.
#[test]
fn clipping_falls_as_the_modules_degrade() {
    let mut p = example();
    p.pv.dc_ac_ratio = 1.6;
    p.pv.degradation = 0.01;
    p.econ.lifetime = 20;
    let prof = compute_pv_profile(&p).unwrap();
    assert!(prof.clip_per_kwp.iter().sum::<f64>() > 1.0, "a DC/AC ratio of 1.6 clips");
    let s = Sizing { pv_kwp: 30000.0, ..Default::default() };
    let sim = |clip: &[f64]| {
        let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: clip, pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
        simulate(&p, &si, &s, false).unwrap()
    };
    let (new, old) = (sim(&prof.clip_per_kwp), sim(&[]));
    assert_eq!(new.years[0].pv_avail, old.years[0].pv_avail, "year 1 unchanged");
    let y = 20;
    let f = pv_degradation_factor(&p.pv, y);
    let cap = (1.0 / p.pv.dc_ac_ratio) * (1.0 - p.pv.ac_losses) * p.pv.availability;
    let want: f64 = (0..HOURS).map(|t| s.pv_kwp * f64::min(f * (prof.ac_per_kwp[t] + prof.clip_per_kwp[t]), cap)).sum();
    let got = new.years[y as usize - 1].pv_avail;
    assert!((got / want - 1.0).abs() < 1e-9, "year {y}: {got} vs {want}");
    assert!(got > old.years[y as usize - 1].pv_avail * 1.005, "clipping comes back");
}

/// The PCS is replaced with the PV inverters; each genset start costs its price
#[test]
fn pcs_replacement_and_start_cost() {
    let mut p = example();
    p.sim.all_years = false;
    let r0 = run(&p, HYB, false);
    let yr = p.econ.inverter_replacement_year as usize;
    let want = (HYB.pv_kwp / p.pv.dc_ac_ratio + HYB.bess_kw) * p.econ.inverter_replacement_kwac;
    assert!((r0.years[yr - 1].c_replace - want).abs() < 1e-6, "{} vs {want}", r0.years[yr - 1].c_replace);

    // the PCS has its own year and price; year 0 never replaces it
    let mut q = p.clone();
    (q.econ.pcs_replacement_year, q.econ.pcs_replacement_kw) = (0, 99.0);
    let rq = run(&q, HYB, false);
    assert!((rq.years[yr - 1].c_replace - HYB.pv_kwp / p.pv.dc_ac_ratio * p.econ.inverter_replacement_kwac).abs() < 1e-6);

    p.econ.diesel_start_cost = 5.0;
    let r1 = run(&p, HYB, false);
    let y1 = &r1.years[0];
    assert!(y1.starts > 0.0);
    assert!((y1.c_om_dg - r0.years[0].c_om_dg - 5.0 * y1.starts).abs() < 1e-6);
    assert!(r1.econ.npc > r0.econ.npc);
    p.econ.diesel_start_cost = -1.0;
    assert!(soloptima_engine::validate_project(&p).is_err());
}

/// A start cost is a cost only: it does not change the dispatch (the plan sets battery targets, the real-time commitment
/// the starts, so a penalty in the plan moved the starts either way)
#[test]
fn start_cost_leaves_the_dispatch_alone() {
    let mut p = example();
    p.dg.strategy = "predictive".into();
    (p.sim.all_years, p.econ.lifetime) = (false, 1);
    let free = run(&p, HYB, false);
    p.econ.diesel_start_cost = 200.0;
    let priced = run(&p, HYB, false);
    assert_eq!(priced.years[0].starts, free.years[0].starts);
    assert_eq!(priced.years[0].fuel_l, free.years[0].fuel_l);
    assert!(priced.years[0].c_om_dg > free.years[0].c_om_dg);
}

/// Hours the usable energy of the battery at its starting state of health carries the year-1 mean load
#[test]
fn battery_autonomy() {
    let mut q = example();
    q.sim.all_years = false;
    q.bess.soh_init = 0.9;   // an existing battery: its autonomy is that of what is left
    let r = run(&q, HYB, false);
    let s = soloptima_engine::sim::summary_json(&q.bess, &r);
    let mean = r.years[0].load / HOURS as f64;
    let want = HYB.bess_kwh * 0.9 * (q.bess.soc_max - q.bess.soc_min) * q.bess.rte.sqrt() / mean;
    assert!((s.at("bess_health").get("autonomy_h", 0.0) - want).abs() < 1e-9);
}

/// Standard air (sea level, 15 C) leaves the power curve as it is; thin air at altitude lowers the output
#[test]
fn wind_power_follows_air_density() {
    let mut p = example();
    p.wind.units = 1;
    p.wx.wind = (0..HOURS).map(|i| 4.0 + (i % 9) as f64).collect();
    p.wx.tamb = vec![15.0; HOURS];
    p.loc.elevation = 0.0;
    let mut q = p.clone();
    let e_sea: f64 = wind_per_turbine(&p).unwrap().iter().sum();
    p.loc.elevation = 2000.0;
    let e_high: f64 = wind_per_turbine(&p).unwrap().iter().sum();
    assert!(e_high < 0.95 * e_sea, "{e_high} vs {e_sea}");
    p.loc.elevation = 0.0;
    p.wx.tamb = vec![35.0; HOURS];
    let e_hot: f64 = wind_per_turbine(&p).unwrap().iter().sum();
    assert!(e_hot < e_sea && e_hot > e_high);
    // above rated wind at the hub the density does not matter
    q.wx.wind = vec![15.0; HOURS];
    q.loc.elevation = 2000.0;
    let rated = wind_per_turbine(&q).unwrap();
    assert!((rated[100] - q.wind.rated_kw * (1.0 - q.wind.losses) * q.wind.availability).abs() < 1e-9);
}
