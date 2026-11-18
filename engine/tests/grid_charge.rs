//! Battery charging from the grid (before a scheduled outage, time-of-use arbitrage) and the frequency reserve held in the
//! battery while the grid is up, in the rule-based dispatch, the predictive EMS and its planner, on the example project.
mod common;
use common::*;
use soloptima_engine::sim::{plan_input, result_to_json, summary_json, FuelTable, GridHour, Hourly, Planner, SimResult};
use soloptima_engine::{parse_project, validate_project, Project, Value, HOURS};

/// A cheap, strong grid on the example with a battery that starts half full
fn with_grid(price: f64) -> Project {
    let mut q = example();
    q.sim.all_years = false;
    q.bess.soc_init = 0.5;
    q.grid.enabled = true;
    q.grid.import_price = price;
    q.grid.import_kw = 1e6;
    q
}

fn tou(q: &mut Project, f: impl Fn(usize) -> f64) {
    q.grid.tariff = "tou".into();
    q.grid.tou = (0..24).map(f).collect();
}

/// Load = PV + battery + gensets + grid to the load + unmet, and PV = to load + to battery + exported + curtailed, every hour;
/// the import to the load and to the battery stays within the limit and is zero while the grid is down
fn check(q: &Project, r: &SimResult) {
    let h: &Hourly = r.hourly.as_ref().unwrap();
    for t in 0..HOURS {
        let load = h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.grid_import[t] + h.unmet[t];
        assert!((h.load[t] - load).abs() < 0.05, "load balance at {t}");
        assert!((h.pv_avail[t] - (h.pv_to_load[t] + h.pv_to_bess[t] + h.grid_export[t] + h.pv_curtailed[t])).abs() < 0.05, "PV at {t}");
        let g2b = h.grid_to_bess.get(t).copied().unwrap_or(0.0);
        assert!(g2b >= 0.0 && h.grid_import[t] + g2b <= q.grid.import_kw + 1e-6, "import limit at {t}");
        if h.grid_up[t] < 0.5 { assert_eq!(g2b, 0.0, "grid charging while the grid is down at {t}"); }
    }
    // the year closes: the energy flow and the battery's own balance, with the grid on the input side
    let y = &r.years[0];
    let s = summary_json(&q.bess, r);
    assert!(s.at("flow").get("gap", 1.0).abs() < 1e-3 * y.load, "flow gap {}", s.at("flow").get("gap", 1.0));
    let ch: f64 = h.pv_to_bess.iter().chain(&h.gen_to_bess).chain(&h.wind_to_bess).chain(&h.grid_to_bess).sum();
    assert!((ch - y.bess_ch).abs() < 1e-6 * y.bess_ch.max(1.0), "charge sources {ch} against {}", y.bess_ch);
    if r.x.grid_charge {
        assert!((s.at("monthly").arr()[12].get("grid_ch", -1.0) - y.grid_to_bess).abs() < 1e-6 * y.grid_to_bess.max(1.0));
        assert_eq!(s.at("flow").get("grid_ch", -1.0), y.grid_to_bess);
    }
}

#[test]
fn charging_before_a_scheduled_outage_saves_diesel() {
    let mut q = with_grid(0.05);
    q.grid.availability = "pattern".into();
    q.grid.pattern = (0..24).map(|h| if (18..22).contains(&h) { 0.0 } else { 1.0 }).collect();
    let s = size(0.0, 6600.0, 2320.0);   // no PV: without the grid the battery has nothing to charge from
    for strat in ["load_following", "cycle_charging", "predictive"] {
        q.dg.strategy = strat.into();
        q.grid.charge_bess = false;
        let off = run(&q, s, true);
        q.grid.charge_bess = true;
        let on = run(&q, s, true);
        check(&q, &on);
        let (a, b) = (&off.years[0], &on.years[0]);
        assert!(b.grid_to_bess > 0.0, "{strat}: the battery charges from the grid");
        assert!(b.fuel_l < a.fuel_l - 1.0, "{strat}: fuel {} with grid charging, {} without", b.fuel_l, a.fuel_l);
        assert!(b.unmet <= a.unmet + 1e-6, "{strat}: unmet {} against {}", b.unmet, a.unmet);
        assert!(b.bess_dis > a.bess_dis, "{strat}: the stored energy rides through the outage");
        // the grid's energy into the battery is costed, counts against the renewable fraction and is not import to the load
        assert!(b.c_grid_import > b.grid_import * 0.05 * (1.0 - 1e-9), "{strat}");
        let non_re = b.gen_kwh - b.gen_dump + b.grid_import + b.grid_to_bess;
        assert!((b.re_fraction - (1.0 - non_re / b.served).clamp(0.0, 1.0)).abs() < 1e-12, "{strat}");
    }
}

#[test]
fn time_of_use_arbitrage_charges_only_when_the_spread_pays() {
    let s = size(0.0, 6600.0, 2320.0);
    let wear = example().econ.bess_replace_kwh / (example().bess.cycle_life * example().bess.cycle_life_dod);
    let mut q = with_grid(0.10);
    q.econ.fuel_price = 5.0;   // dear diesel, so the grid is the cheaper source in every hour and the gensets stay off
    q.grid.charge_bess = true;

    // a flat tariff never pays the round trip
    let flat = run(&q, s, true);
    check(&q, &flat);
    assert_eq!(flat.years[0].grid_to_bess, 0.0, "no arbitrage on a flat tariff");

    // a spread that does not cover losses and wear: 0.10 at night, 0.11 at the evening peak
    tou(&mut q, |h| if (17..22).contains(&h) { 0.11 } else { 0.10 });
    assert!(q.bess.rte * (0.11 - wear) < 0.10);
    let small = run(&q, s, true);
    assert_eq!(small.years[0].grid_to_bess, 0.0, "the spread does not pay");

    // a wide spread: charge outside the peak, use it in the peak
    tou(&mut q, |h| if (17..22).contains(&h) { 0.40 } else if h < 6 { 0.05 } else { 0.12 });
    let wide = run(&q, s, true);
    check(&q, &wide);
    let h = wide.hourly.as_ref().unwrap();
    for t in 0..HOURS {
        let hod = t % 24;
        if (17..22).contains(&hod) { assert_eq!(h.grid_to_bess[t], 0.0, "no charging in the peak at {t}"); }
        else { assert!(h.bess_dis[t] < 1e-9, "the battery holds outside the peak at {t}"); }
    }
    assert!(wide.years[0].grid_to_bess > 0.0 && wide.years[0].bess_dis > 0.0);
    q.grid.charge_bess = false;
    let base = run(&q, s, true);
    assert!(wide.years[0].c_grid < base.years[0].c_grid, "arbitrage lowers the grid bill: {} against {}", wide.years[0].c_grid, base.years[0].c_grid);

    // the predictive EMS does the same arbitrage through its plan
    q.dg.strategy = "predictive".into();
    let pb = run(&q, s, true);
    q.grid.charge_bess = true;
    let pr = run(&q, s, true);
    check(&q, &pr);
    assert!(pr.years[0].grid_to_bess > 0.0);
    assert!(pr.years[0].c_total < pb.years[0].c_total, "EMS cost {} against {}", pr.years[0].c_total, pb.years[0].c_total);
    let ph = pr.hourly.as_ref().unwrap();
    assert!((0..HOURS).filter(|t| (17..22).contains(&(t % 24))).all(|t| ph.grid_to_bess[t] == 0.0), "the EMS buys outside the peak");
}

/// The frequency reserve's band (kWh) for the example battery in year 1
fn band(q: &Project, kwh: f64) -> (f64, f64) {
    let eta = q.bess.rte.sqrt();
    let r_e = q.grid.reserve_kw * q.grid.reserve_min / 60.0;
    (kwh * q.bess.soc_min + r_e / eta, kwh * q.bess.soc_max - r_e * eta)
}

#[test]
fn the_reserve_band_and_power_hold_in_the_dispatch() {
    let s = size(30000.0, 6600.0, 2320.0);
    for strat in ["load_following", "cycle_charging", "predictive"] {
        let mut q = with_grid(0.30);
        q.grid.export_kw = 0.0;
        q.grid.reserve_kw = 1000.0;
        q.grid.reserve_min = 60.0;
        q.dg.strategy = strat.into();
        let r = run(&q, s, true);
        check(&q, &r);
        let (h, y) = (r.hourly.as_ref().unwrap(), &r.years[0]);
        let (lo, hi) = band(&q, 6600.0);
        let p_max = 2320.0 - 1000.0;
        for t in 0..HOURS {
            let e = h.soc[t] * 6600.0;
            assert!(e >= lo - 1e-6 && e <= hi + 1e-6, "{strat}: stored energy {e} outside [{lo}, {hi}] at {t}");
            let ch = h.pv_to_bess[t] + h.gen_to_bess[t] + h.grid_to_bess[t];
            assert!(h.bess_dis[t] <= p_max + 1e-6 && ch <= p_max + 1e-6, "{strat}: power at {t}");
        }
        assert_eq!(y.fr_held_h, HOURS as f64, "{strat}: held all year");
    }
}

#[test]
fn the_planner_keeps_the_reserve_band() {
    let mut q = with_grid(0.10);
    q.grid.reserve_kw = 1000.0;
    q.grid.reserve_min = 60.0;
    let fuel = FuelTable::new(&q.dg).unwrap();
    let mut pin = plan_input(&q, &fuel);
    (pin.e_min, pin.e_max, pin.pb) = (6600.0 * q.bess.soc_min, 6600.0 * q.bess.soc_max, 2320.0);
    // dear evening hours tempt the plan to empty the battery, and a free midday to fill it
    pin.grid = (0..24).map(|j| GridHour { up: true, cheap: true, imp: 1e6, exp: 0.0, price: if j >= 17 { 2.0 } else { 0.10 }, exp_price: 0.0 }).collect();
    let load = vec![20000.0; 24];
    let pv: Vec<f64> = (0..24).map(|j| if (9..15).contains(&j) { 25000.0 } else { 0.0 }).collect();
    let (lo, hi) = band(&q, 6600.0);
    let mut planner = Planner::new(&q.dg, &fuel);
    let (mut e_traj, mut u) = (Vec::new(), Vec::new());
    planner.plan(&pin, 0.5 * 6600.0, &load, &pv, &mut e_traj, &mut u);
    let eta = pin.eta;
    for j in 1..=24 {
        assert!(e_traj[j] >= lo - 1e-6 && e_traj[j] <= hi + 1e-6, "level {} outside [{lo}, {hi}] at {j}", e_traj[j]);
        let de = e_traj[j] - e_traj[j - 1];
        let b = if de < 0.0 { -de * eta } else { -de / eta };
        assert!(b.abs() <= 2320.0 - 1000.0 + 1e-6, "power {b} at {j}");
    }
    assert!(e_traj.iter().any(|&e| e < 0.4 * 6600.0), "the battery still works within the band");
    // without the reserve the same plan leaves the band
    pin.fr_kw = 0.0;
    planner.plan(&pin, 0.5 * 6600.0, &load, &pv, &mut e_traj, &mut u);
    assert!(e_traj.iter().any(|&e| e < lo - 1.0 || e > hi + 1.0));
}

#[test]
fn the_reserve_costs_energy_and_earns_its_price() {
    let s = size(60000.0, 6600.0, 2320.0);   // twice the example's PV, so the battery is often full
    let mut q = with_grid(0.10);
    q.grid.export_kw = 0.0;
    let free = run(&q, s, true);
    q.grid.reserve_kw = 1000.0;
    q.grid.reserve_min = 60.0;
    let held = run(&q, s, true);
    check(&q, &held);
    let (a, b) = (&free.years[0], &held.years[0]);
    assert!(b.fr_spill > 0.0 && b.fr_shift > 0.0, "spill {} shift {}", b.fr_spill, b.fr_shift);
    assert!(b.pv_curtailed > a.pv_curtailed, "the band leaves less room for PV: {} against {}", b.pv_curtailed, a.pv_curtailed);
    assert!(b.c_total > a.c_total, "unpaid, the reserve only costs");
    assert_eq!(b.c_fr, 0.0);

    q.grid.reserve_price = 50.0;
    q.grid.escalation = 0.02;
    q.sim.all_years = true;
    let paid = run(&q, s, false);
    q.grid.reserve_price = 0.0;
    let unpaid = run(&q, s, false);
    for (p, u) in paid.years.iter().zip(&unpaid.years) {
        let esc = 1.02f64.powi(p.year - 1);
        assert!((p.c_fr - 1000.0 * 50.0 * p.fr_held_h / HOURS as f64 * esc).abs() < 1e-6, "year {}", p.year);
        assert!((u.c_total - p.c_total - p.c_fr).abs() < 1e-6 * u.c_total.abs(), "year {}: the revenue comes off the yearly cost", p.year);
    }
    assert!(paid.econ.npc < unpaid.econ.npc);

    // a battery too small for the reserve does not offer it
    q.grid.reserve_kw = 5000.0;
    let small = run(&q, s, false);
    assert_eq!(small.years[0].fr_held_h, 0.0);
    assert_eq!(small.years[0].fuel_l, unpaid.years[0].fuel_l);
}

#[test]
fn the_reserve_is_refilled_from_the_grid_after_an_outage() {
    let mut q = with_grid(0.10);
    q.grid.availability = "pattern".into();
    q.grid.pattern = (0..24).map(|h| if (18..22).contains(&h) { 0.0 } else { 1.0 }).collect();
    q.grid.reserve_kw = 1000.0;
    q.grid.reserve_min = 60.0;
    let r = run(&q, size(0.0, 6600.0, 2320.0), true);
    check(&q, &r);
    let (y, h) = (&r.years[0], r.hourly.as_ref().unwrap());
    assert!(y.grid_to_bess > 0.0, "refilled from the grid, with grid charging off");
    assert!(y.fr_held_h > 0.0 && y.fr_held_h < y.grid_up_h);
    assert!((0..HOURS).any(|t| h.grid_up[t] < 0.5 && h.bess_dis[t] > 0.0), "the battery rides through the outage");
}

#[test]
fn off_grid_and_unset_options_change_nothing() {
    let base = |q: &Project| result_to_json(&run(q, HYB, true), true).dump();
    // off grid: neither option has any effect
    let mut a = example();
    a.sim.all_years = false;
    let mut b = a.clone();
    b.grid.charge_bess = true;
    b.grid.reserve_kw = 1000.0;
    b.grid.reserve_price = 50.0;
    assert_eq!(base(&a), base(&b));
    // with a grid, the options at their defaults give the same result as a document without them
    let mut c = with_grid(0.10);
    c.grid.reserve_min = 30.0;   // the duration alone does nothing
    let d = with_grid(0.10);
    let (rc, rd) = (base(&c), base(&d));
    assert_eq!(rc, rd);
    assert!(!rc.contains("grid_to_bess") && !rc.contains("fr_held_h"));
}

#[test]
fn the_new_inputs_are_read_and_checked() {
    let mut v = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    v.set("grid", Value::parse(r#"{"enabled":true,"import_kw":500,"charge_bess":true,"reserve_kw":200,"reserve_min":30,"reserve_price":40}"#).unwrap());
    let p = parse_project(&v);
    assert!(p.grid.charge_bess && p.grid.reserve_kw == 200.0 && p.grid.reserve_min == 30.0 && p.grid.reserve_price == 40.0);
    assert!(validate_project(&p).is_ok());
    for (k, x) in [("kw", -1.0), ("min", 0.0), ("min", 300.0), ("price", -5.0)] {
        let mut q = p.clone();
        match k { "kw" => q.grid.reserve_kw = x, "min" => q.grid.reserve_min = x, _ => q.grid.reserve_price = x }
        assert!(validate_project(&q).unwrap_err().0.contains("frequency reserve"), "{k} = {x}");
    }
    let d = parse_project(&Value::parse(&read("../web/examples/example_study.json")).unwrap());
    assert!(!d.grid.charge_bess && d.grid.reserve_kw == 0.0 && d.grid.reserve_price == 0.0);
}
