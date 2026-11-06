//! The C++ self-tests of battery ageing, auxiliary loads, operational adequacy with the planner's reserve credit and cycle
//! charging (tests/test_engine.cpp sections 11, 12, 13 and 17), on the example project with the C++ PV profile and perfect
//! forecasts (common/mod.rs). Sizes are scaled to the example where the C++ figure only makes sense for its 1 MW load.
mod common;
use common::*;
use soloptima_engine::sim::{aux_kw, plan_input, FuelTable, Planner, Sizing};
use soloptima_engine::{parse_project, validate_project, AuxParams, Project, Value, HOURS};

fn first_repl(p: &Project) -> i32 { run(p, HYB, false).years.iter().find(|y| y.bess_replaced).map_or(1000, |y| y.year) }

/// Section 11: battery ageing: DC cycles against the cycle life at its rated DoD, replacement threshold, initial SOH
#[test]
fn battery_ageing() {
    let d = parse_project(&Value::parse(r#"{"bess":{"replace_soh":null}}"#).unwrap()).bess;
    assert!(d.cycle_life_dod == 1.0 && d.replace_soh == -1.0 && d.soh_init == 1.0 && d.warranty_efc_yr == 0.0, "battery ageing defaults");
    let mut q = example();
    q.sim.all_years = false;
    q.econ.lifetime = 25;
    q.dg.strategy = "cycle_charging".into();   // cycles enough to need several replacements
    q.bess.rte = 1.0;
    let r = run(&q, HYB, false);
    let y1 = &r.years[0];
    assert!(!y1.bess_replaced && y1.bess_efc_dc == y1.bess_efc, "RTE 1: DC and AC cycles differ");
    let soh2 = 1.0 - q.bess.calendar_fade - y1.bess_efc * (1.0 - q.bess.eol_soh) / q.bess.cycle_life;
    assert!((r.years[1].bess_soh - soh2).abs() < 1e-12, "SOH after year 1 {} vs {soh2}", r.years[1].bess_soh);
    assert!((y1.soh_loss_cal + y1.soh_loss_cyc - (1.0 - soh2)).abs() < 1e-12, "SOH loss split");
    assert!(y1.max_c_rate > 0.0 && y1.max_c_rate <= HYB.bess_kw / HYB.bess_kwh + 1e-12, "max C-rate {}", y1.max_c_rate);
    q.bess.rte = 0.88;
    let y88 = run(&q, HYB, false).years[0].clone();
    assert!((y88.bess_efc_dc * 0.88f64.sqrt() - y88.bess_efc).abs() < 1e-9 * y88.bess_efc, "DC cycles = AC cycles / one-way efficiency");

    let n_repl = |p: &Project| run(p, HYB, false).bess_replacements;
    let f10 = first_repl(&q);
    assert!(f10 < q.econ.lifetime, "no battery replacement within {} years", q.econ.lifetime);
    let mut a = q.clone();
    a.bess.cycle_life_dod = 0.9;
    assert!(first_repl(&a) <= f10, "cycle life at 90 % DoD replaced in year {}, at 100 % in year {f10}", first_repl(&a));
    let (mut b6, mut b7) = (q.clone(), q.clone());
    b6.bess.replace_soh = 0.6;
    b7.bess.replace_soh = 0.7;
    assert!(n_repl(&b6) <= n_repl(&b7), "replacing at 60 % gives {} replacements, at 70 % {}", n_repl(&b6), n_repl(&b7));
    let mut old = q.clone();
    old.bess.soh_init = 0.8;
    assert!(first_repl(&old) < f10, "initial SOH 80 % replaced in year {}, new battery in year {f10}", first_repl(&old));

    // a second-life battery that is not replaced: salvage measures the SOH left against the SOH it was installed at
    let mut sl = q.clone();
    sl.bess.soh_init = 0.9;
    sl.econ.lifetime = 3;
    sl.dg.strategy = "load_following".into();
    let rs = run(&sl, HYB, false);
    let yl = rs.years.last().unwrap();
    let soh_end = yl.bess_soh - yl.soh_loss_cal - yl.soh_loss_cyc;
    let pv_salv = rs.econ.capex_pv * (sl.econ.pv_life - f64::from(sl.econ.lifetime)) / sl.econ.pv_life;
    let b_salv = rs.econ.capex_bess * (soh_end - sl.bess.eol_soh) / (0.9 - sl.bess.eol_soh);
    assert!(rs.bess_replacements == 0 && b_salv > 0.0 && (-yl.c_salvage - pv_salv - b_salv).abs() < 1e-6 * b_salv,
            "second-life battery salvage {}, expected {b_salv}", -yl.c_salvage - pv_salv);
    // without a battery the reported SOH stays at 100 % whatever the initial SOH
    assert!(run(&old, size(HYB.pv_kwp, 0.0, 0.0), false).years.iter().all(|y| y.bess_soh == 1.0), "no battery: SOH reported below 100 %");
    // a replacement threshold of 0 % is rejected, blank (-1) and 60 % are accepted
    let valid = |r: f64| { let mut x = q.clone(); x.bess.replace_soh = r; validate_project(&x).is_ok() };
    assert!(!valid(0.0) && valid(-1.0) && valid(0.6), "replacement SOH 0 / blank / 60 %");
}

/// Section 12: auxiliary loads: battery HVAC/BMS per MWh (with temperature rise), PCS no-load, plant auxiliaries, transformer
/// no-load. The ambient is set to 27 degC throughout as in the C++ synthetic year, so the expected energies stay closed
/// form; the per-MWh and per-MW figures follow the example battery (6.6 MWh, 2.32 MW instead of 2 MWh, 1 MW).
#[test]
fn auxiliary_loads() {
    let d = parse_project(&Value::parse("{}").unwrap()).aux;
    assert!(d == AuxParams { bess_kw_per_mwh: 0.0, bess_temp_coeff: 0.0, ref_c: 25.0, plant_kw: 0.0, trafo_noload_kw: 0.0, bess_trafo_noload_kw: 0.0, pcs_kw_per_mw: 0.0 },
            "auxiliary load defaults");
    let mut q = example();
    q.sim.all_years = false;
    q.wx.tamb = vec![27.0; HOURS];
    let hrs = HOURS as f64;
    let (mwh, mw) = (HYB.bess_kwh / 1000.0, HYB.bess_kw / 1000.0);
    let r0 = run(&q, HYB, true);
    let z = &r0.years[0];
    assert!(z.aux == 0.0 && z.served_site == z.served, "zero auxiliary load changed the served energy");
    assert!(q.load_kw == r0.hourly.as_ref().unwrap().load, "zero auxiliary load changed the dispatched load");
    // the C++ test pins the fuel recorded before auxiliary loads existed; here, the C++ engine's fuel for the same case
    assert!((r0.fuel_l_y1 / cpp_fuel("load following") - 1.0).abs() < 1e-9, "fuel without auxiliary load {} L", r0.fuel_l_y1);

    // PCS no-load loss: kW per MW of PCS rating in every hour, only with a battery, and it follows the candidate's PCS size
    let mut c = q.clone();
    c.aux.pcs_kw_per_mw = 2.0;
    let aux_c = |s: Sizing| run(&c, s, false).years[0].aux;
    let rc = run(&c, HYB, true);
    assert!((rc.years[0].aux - z.aux - 2.0 * mw * hrs).abs() < 1e-6, "PCS no-load {} kWh", rc.years[0].aux - z.aux);
    let twice = size(HYB.pv_kwp, HYB.bess_kwh, 2.0 * HYB.bess_kw);
    assert!((aux_c(twice) - 2.0 * (2.0 * mw * hrs)).abs() < 1e-6, "PCS no-load with twice the PCS {} kWh", aux_c(twice));
    assert!(aux_c(size(HYB.pv_kwp, 0.0, 0.0)) == 0.0, "PCS no-load counted without a battery");
    let bc = balance_error(rc.hourly.as_ref().unwrap());
    assert!(rc.fuel_l_y1 > r0.fuel_l_y1 && bc < 0.05, "PCS no-load: fuel {} vs {} L, balance {bc}", rc.fuel_l_y1, r0.fuel_l_y1);
    assert!(aux_kw(&c, &HYB, 25.0) == 2.0 * mw && aux_kw(&c, &size(HYB.pv_kwp, 0.0, 0.0), 25.0) == 0.0, "PCS no-load in the auxiliary load");
    c.aux.pcs_kw_per_mw = -1.0;
    assert!(validate_project(&c).is_err(), "negative PCS no-load loss accepted");

    q.aux.bess_kw_per_mwh = 1.0;
    let r1 = run(&q, HYB, true);
    let y1 = &r1.years[0];
    assert!((y1.aux - mwh * hrs).abs() < 1e-6, "battery auxiliary {} kWh", y1.aux);
    assert!(r1.fuel_l_y1 > r0.fuel_l_y1, "auxiliary load did not raise fuel ({} vs {} L)", r1.fuel_l_y1, r0.fuel_l_y1);
    let b1 = balance_error(r1.hourly.as_ref().unwrap());
    assert!(b1 < 0.05, "energy balance with auxiliary load {b1}");
    // C++: within 1e-6 kWh of a 9 GWh load; the 200 GWh example load sums with rounding of about 3e-5 kWh, so relative here
    assert!((y1.served_site - (y1.served - y1.aux)).abs() < 1e-9 && (y1.load - y1.aux - z.load).abs() < 1e-12 * z.load,
            "site energy: {} kWh off", y1.load - y1.aux - z.load);
    let disc: f64 = r1.years.iter().map(|y| y.served_site / (1.0 + q.econ.discount_rate).powi(y.year)).sum();
    assert!((r1.econ.lcoe - r1.econ.npc / disc).abs() < 1e-12 * r1.econ.lcoe, "LCOE not on served site energy");
    assert!((r1.econ.coe - r1.econ.tac / y1.served_site).abs() < 1e-12 * r1.econ.coe, "COE not on served site energy");
    assert!(run(&q, Sizing::default(), false).years[0].aux == 0.0, "diesel-only baseline has auxiliary load");

    q.aux.bess_temp_coeff = 0.02;   // 2 %/degC above 25 degC at 27 degC
    q.aux.plant_kw = 10.0;
    q.aux.trafo_noload_kw = 5.0;
    let aux_of = |p: &Project, s: Sizing| run(p, s, false).years[0].aux;
    let hvac = mwh * 1.04;
    assert!((aux_of(&q, HYB) - (hvac + 15.0) * hrs).abs() < 1e-6, "temperature rise or plant auxiliaries");
    assert!((aux_of(&q, size(HYB.pv_kwp, 0.0, 0.0)) - 15.0 * hrs).abs() < 1e-6, "PV-only plant auxiliaries");
    // each step-up transformer's no-load only with the asset it serves; plant auxiliaries also with wind alone
    q.aux.bess_trafo_noload_kw = 3.0;
    assert!((aux_of(&q, HYB) - (hvac + 18.0) * hrs).abs() < 1e-6, "hybrid auxiliaries {}", aux_of(&q, HYB));
    assert!((aux_of(&q, size(HYB.pv_kwp, 0.0, 0.0)) - 15.0 * hrs).abs() < 1e-6, "PV-only auxiliaries with BESS transformer no-load");
    assert!((aux_of(&q, size(0.0, HYB.bess_kwh, HYB.bess_kw)) - (hvac + 13.0) * hrs).abs() < 1e-6, "battery-only auxiliaries");
    let mut w = q.clone();
    w.aux = AuxParams { plant_kw: 20.0, trafo_noload_kw: 12.4, ..Default::default() };
    w.wind.units = 3;
    w.wind.rated_kw = 2000.0;
    assert!((aux_of(&w, Sizing { wind_units: 3.0, ..Default::default() }) - 20.0 * hrs).abs() < 1e-6, "wind + diesel plant auxiliaries");
    assert!(aux_of(&w, Sizing::default()) == 0.0, "diesel-only baseline with auxiliaries");
    // no gensets: in dark hours the auxiliaries go unserved too, so the energy served to the site never turns negative
    let mut dk = q.clone();
    dk.dg.units = 0;
    dk.aux = AuxParams { plant_kw: 200.0, ..Default::default() };
    let rd = run(&dk, HYB, true);
    let h = rd.hourly.as_ref().unwrap();
    let site: f64 = (0..HOURS).map(|t| (h.load[t] - h.aux[t] - h.unmet[t]).max(0.0)).sum();
    let worst = rd.years.iter().fold(f64::INFINITY, |a, y| a.min(y.served_site));
    assert!(site > 0.0 && worst > 0.0 && (rd.years[0].served_site - site).abs() < 1e-6 * site && rd.years[0].lol_h > 0.0,
            "served site {} vs hourly {site} (lowest year {worst})", rd.years[0].served_site);
}

/// Section 13: operational adequacy (reserve shortfall, loss-of-load events, battery reserve duration) and the planner's
/// reserve credit
#[test]
fn operational_adequacy() {
    assert!(parse_project(&Value::parse("{}").unwrap()).bess.reserve_duration_h == 1.0, "default battery reserve duration");
    let mut q = example();
    q.sim.all_years = false;
    // the real-time rules are unchanged: the C++ test pins its recorded fuel, here the C++ engine's fuel for the same cases
    let (mut lf, mut cc) = (q.clone(), q.clone());
    lf.dg.strategy = "load_following".into();
    cc.dg.strategy = "cycle_charging".into();
    let (f_lf, f_cc) = (run(&lf, HYB, false).fuel_l_y1, run(&cc, HYB, false).fuel_l_y1);
    assert!((f_lf / cpp_fuel("load following") - 1.0).abs() < 1e-12, "load-following fuel {f_lf} L changed");
    assert!((f_cc / cpp_fuel("cycle charging") - 1.0).abs() < 1e-12, "cycle-charging fuel {f_cc} L changed");
    // with spare units the reserve left after allocation covers the requirement, also with gensets held at minimum loading
    for s in [HYB, size(80000.0, 0.0, 0.0), Sizing::default()] {
        let y = &run(&q, s, false).years[0];
        assert!(y.fleet_full_h == 0.0 && y.reserve_short_h == 0.0 && y.lol_h == 0.0, "{s:?}: {} h short of reserve with spare units", y.reserve_short_h);
    }
    // a longer reserve duration counts less battery reserve, so more gensets run
    let unit_h = |h: f64| { let mut x = q.clone(); x.bess.reserve_duration_h = h; run(&x, HYB, false).years[0].unit_hours };
    let (uh25, uh1, uh4) = (unit_h(0.25), unit_h(1.0), unit_h(4.0));
    assert!(uh25 <= uh1 && uh1 < uh4, "unit-hours with reserve duration 0.25 / 1 / 4 h: {uh25} / {uh1} / {uh4}");

    // 15 x 1800 kW (27 MW) for a 16-25.2 MW load: diesel only cannot hold 10 % reserve at the peak. The C++ fleet (3 x 400 kW
    // for 0.8-1.2 MW) runs in full every hour; the example load swings more, so the fleet is full only in part of the year.
    let mut f15 = q.clone();
    f15.dg.units = 15;
    let b15 = run(&f15, Sizing::default(), false).years[0].clone();
    assert!(b15.reserve_short_h > 0.0 && b15.reserve_short_max_kw > 0.0 && b15.lol_h == 0.0, "15 units: {} h short of reserve, {} h loss of load", b15.reserve_short_h, b15.lol_h);
    assert!(b15.max_units == 15.0 && b15.fleet_full_h >= b15.reserve_short_h, "15 units: max online {}, fleet fully online {} h", b15.max_units, b15.fleet_full_h);

    // 12 x 1800 kW: loss-of-load hours, events and the longest event match the hourly series
    let mut f12 = q.clone();
    f12.dg.units = 12;
    let r12 = run(&f12, HYB, true);
    let (y, h) = (&r12.years[0], r12.hourly.as_ref().unwrap());
    let (mut n, mut ev, mut run_h, mut longest) = (0, 0, 0, 0);
    for t in 0..HOURS {
        let lol = h.unmet[t] > 1e-3 * h.load[t];
        run_h = if lol { run_h + 1 } else { 0 };
        n += i32::from(lol);
        ev += i32::from(run_h == 1);
        longest = longest.max(run_h);
    }
    assert!(y.lol_h == f64::from(n) && y.lol_events == f64::from(ev) && y.lol_max_h == f64::from(longest),
            "loss of load {} h / {} events / {} h longest vs hourly {n} / {ev} / {longest}", y.lol_h, y.lol_events, y.lol_max_h);
    assert!(y.lol_events >= 1.0 && y.lol_max_h >= 1.0 && y.max_units == 12.0, "12 units: no loss-of-load event");
    let mut grow = f12.clone();
    grow.sim.all_years = true;
    grow.sim.load_growth = 0.02;
    let rg = run(&grow, HYB, false);
    assert!(rg.unmet_fraction_max > rg.unmet_fraction, "load growth: worst-year unmet {} vs year 1 {}", rg.unmet_fraction_max, rg.unmet_fraction);

    // Planner, on the C++ fleet (5 x 400 kW) so its 1-1.2 MW loads apply: with an almost empty battery, units are committed
    // with at most (E - Emin) x eta / reserve_h of battery reserve
    q.dg.unit_kw = 400.0;
    q.dg.units = 5;
    let fuel = FuelTable::new(&q.dg).unwrap();
    let mut pl = Planner::new(&q.dg, &fuel);
    let mut inp = plan_input(&q, &fuel);
    (inp.e_min, inp.e_max, inp.pb) = (200.0, 2000.0, 1000.0);
    let b_of = |de: f64, eta: f64| if de < 0.0 { -de * eta } else { -de / eta };
    let (lf12, pf12) = (vec![1100.0; 12], vec![0.0; 12]);
    let (mut e_traj, mut u_plan) = (Vec::new(), Vec::new());
    pl.plan(&inp, inp.e_min + 5.0, &lf12, &pf12, &mut e_traj, &mut u_plan);
    let mut more = 0;
    for j in 0..12 {
        let b = b_of(e_traj[j + 1] - e_traj[j], inp.eta);
        let credit = (e_traj[j].min(e_traj[j + 1]) - inp.e_min).max(0.0) * inp.eta / inp.reserve_h;
        let need = (lf12[j] - pf12[j] - b).max(0.0) + (q.dg.reserve_load * lf12[j] - credit).max(0.0);
        let u_min = q.dg.units.min((need / q.dg.unit_kw - 1e-9).ceil() as i32);
        assert!(u_plan[j] >= u_min, "hour {j}: {} units planned, reserve credit of {credit} kW needs {u_min}", u_plan[j]);
        let u_old = pl.hour_cost(&inp, lf12[j], pf12[j], b, f64::INFINITY).1;   // battery power alone as reserve, as before
        more += i32::from(u_plan[j] > u_old);
    }
    assert!(more > 0, "the reserve energy limit never raised the planned units");
    // at a 4 h reserve duration the plan commits exactly the units the real-time rule needs for the plan's own discharge
    inp.reserve_h = 4.0;
    let lf24: Vec<f64> = (0..24).map(|j| 1000.0 + 200.0 * (2.0 * std::f64::consts::PI * f64::from(j) / 24.0).sin()).collect();
    let pf24 = vec![0.0; 24];
    pl.plan(&inp, inp.e_max, &lf24, &pf24, &mut e_traj, &mut u_plan);
    for j in 0..24 {
        let b = b_of(e_traj[j + 1] - e_traj[j], inp.eta);
        let res = (inp.pb.min((e_traj[j] - inp.e_min) * inp.eta / inp.reserve_h) - b.max(0.0)).max(0.0);
        let need = (lf24[j] - pf24[j] - b).max(0.0) + (q.dg.reserve_load * lf24[j] - res).max(0.0);
        let n = if need > 1e-6 { (need / q.dg.unit_kw - 1e-9).ceil() as i32 } else { 0 };
        let u_rt = n.max(q.dg.min_units_online).min(q.dg.units);
        assert_eq!(u_plan[j], u_rt, "reserve 4 h, hour {j}: units planned vs real time");
    }
}

/// Section 17: cycle charging: once genset charging has begun the battery holds its energy until the setpoint, so it is not
/// topped up in one hour and emptied in the next; the hour in which a charge starts or ends is shared, so cycles and fuel
/// change smoothly with the state of health and the setpoint
#[test]
fn cycle_charging() {
    let mut q = example();
    q.dg.strategy = "cycle_charging".into();
    q.bess.self_discharge = 0.0;
    q.sim.all_years = false;   // only year 1 is checked
    let sz = HYB;
    let r = run(&q, sz, true);
    let h = r.hourly.as_ref().unwrap();
    let sp = q.bess.soc_max.min(q.bess.soc_min.max(q.dg.cc_setpoint));
    let eta = q.bess.rte.sqrt();
    let mut hold = false;
    let (mut held, mut freed, mut bad, mut crumbs, mut unfreed) = (0, 0, 0, 0, 0);
    for t in 0..HOURS {
        let cap = h.gen_units[t] * q.dg.unit_kw;
        let gen = h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t];
        let soc0 = if t > 0 { h.soc[t - 1] } else { q.bess.soc_init };
        let top = soc0 + (h.pv_to_bess[t] + h.wind_to_bess[t] + h.gen_to_bess[t]) * eta / sz.bess_kwh;   // after charging
        if hold {
            held += 1;
            if h.bess_dis[t] > 1e-6 && top < sp - 1e-6 && gen < cap - 1e-6 { bad += 1; }   // below the setpoint only at full genset output
        } else {
            if h.bess_dis[t] > 1e-6 { freed += 1; }
            // outside a hold a battery with energy left covers the deficit before the gensets go above minimum loading
            if soc0 > q.bess.soc_min + 1e-5 && h.bess_dis[t] <= 0.0 && h.gen_to_load[t] > (cap * q.dg.min_load).min(h.load[t]) + 1e-6 { unfreed += 1; }
        }
        if h.bess_dis[t] > 0.0 && h.bess_dis[t] < 1e-3 && gen < cap - 1e-6 { crumbs += 1; }   // rounding remainders count as empty
        let excess = (cap * q.dg.min_load - h.load[t]).max(0.0);                          // unavoidable excess at minimum loading
        hold = (hold || h.gen_to_bess[t] > excess + 1e-6) && (if hold { top } else { h.soc[t] }) < sp - 1e-6;
    }
    assert!(held > 100 && freed > 100 && bad == 0 && unfreed == 0,
            "cycle charging: {held} hours holding, {freed} discharging, {bad} discharges while holding, {unfreed} idle outside a hold");
    assert!(crumbs == 0, "cycle charging: {crumbs} hours discharging a rounding remainder below 1 W");
    // the setpoint is capped at the maximum SOC
    let (mut a, mut b) = (q.clone(), q.clone());
    a.bess.soc_max = 0.9;
    b.bess.soc_max = 0.9;
    a.dg.cc_setpoint = 1.0;
    b.dg.cc_setpoint = 0.9;
    let (ya, yb) = (run(&a, sz, false).years[0].clone(), run(&b, sz, false).years[0].clone());
    assert!(ya.fuel_l == yb.fuel_l && ya.bess_efc == yb.bess_efc && ya.bess_efc > 50.0, "setpoint 1.0 above SOC max 0.9: fuel {} vs {} L, {} vs {} cycles",
            ya.fuel_l, yb.fuel_l, ya.bess_efc, yb.bess_efc);
    // a fleet too small for the peak (12 x 1800 kW for 25.2 MW; the C++ test has 2 x 400 kW for 1.2 MW): the battery still
    // covers what the gensets cannot while it holds
    let mut f = q.clone();
    f.dg.units = 12;
    let rf = run(&f, sz, true);
    let hf = rf.hourly.as_ref().unwrap();
    let left = (0..HOURS).filter(|&t| hf.unmet[t] > 1e-6 && hf.bess_dis[t] < sz.bess_kw - 1e-6 && hf.soc[t] > f.bess.soc_min + 1e-6).count();
    assert!(rf.years[0].unmet > 0.0 && left == 0, "12 units: {left} hours with unmet load while the battery had power and energy left");
    // year-1 cycles and fuel against the state of health and the setpoint, also on the fixture's small battery (2 MWh, 0.5 MW;
    // the C++ test uses 300 kWh, 100 kW) that charges in a few hours
    let (mut worst_c, mut worst_f) = (0.0f64, 0.0f64);
    for z in [sz, size(30000.0, 2000.0, 500.0)] {
        for by_soh in [true, false] {
            let (mut pc, mut pf) = (0.0, 0.0);
            for i in 0..=40 {
                let mut x = q.clone();
                if by_soh { x.bess.soh_init = 0.95 - 0.0025 * f64::from(i); } else { x.dg.cc_setpoint = 0.70 + 0.0025 * f64::from(i); }
                let y = &run(&x, z, false).years[0];
                if i > 0 { worst_c = worst_c.max((y.bess_efc / pc - 1.0).abs()); worst_f = worst_f.max((y.fuel_l / pf - 1.0).abs()); }
                (pc, pf) = (y.bess_efc, y.fuel_l);
            }
        }
    }
    assert!(worst_c < 0.04 && worst_f < 1.5e-3, "cycle charging jumps between neighbouring states of health or setpoints: cycles {} %, fuel {} %",
            worst_c * 100.0, worst_f * 100.0);
}
