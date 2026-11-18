//! Battery ageing by rainflow counting and Miner's rule against a cycle-life curve, and genset commitment with minimum up and
//! down times and a start cost in the predictive plan.
mod common;
use common::*;
use soloptima_engine::sim::ageing::{cycles_at, rainflow, wear_cost, Miner};
use soloptima_engine::sim::{plan_input, result_to_json, FuelTable};
use soloptima_engine::{validate_project, HOURS};
use std::collections::VecDeque;

fn sorted(mut c: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    c.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    c
}

/// The rainflow example of ASTM E1049-85 (Fig. 6 and Table 4): ranges 3 (half), 4 (one and a half), 6 (half), 8 (one) and
/// 9 (half)
#[test]
fn rainflow_counts_the_astm_example() {
    let got = rainflow(&[-2.0, 1.0, -3.0, 5.0, -1.0, 3.0, -4.0, 4.0, -2.0]);
    let mut by_range: Vec<(f64, f64)> = Vec::new();
    for (r, c) in got {
        match by_range.iter_mut().find(|x| x.0 == r) { Some(x) => x.1 += c, None => by_range.push((r, c)) }
    }
    assert_eq!(sorted(by_range), vec![(3.0, 0.5), (4.0, 1.5), (6.0, 0.5), (8.0, 1.0), (9.0, 0.5)]);
}

/// Points that are not reversals (flat or still moving the same way) change nothing; a series with one value has no cycles
#[test]
fn rainflow_keeps_only_reversals() {
    let a = rainflow(&[0.2, 0.5, 0.5, 0.8, 0.4, 0.3, 0.3, 0.9, 0.1]);
    let b = rainflow(&[0.2, 0.8, 0.3, 0.9, 0.1]);
    assert_eq!(sorted(a), sorted(b));
    assert!(rainflow(&[0.5; 10]).is_empty());
    // full cycles inside a larger one: 0.2 -> 0.8 -> 0.4 -> 0.6 -> 0.4 -> 0.8 -> 0.2
    let c = rainflow(&[0.2, 0.8, 0.4, 0.6, 0.4, 0.8, 0.2]);
    let full: Vec<f64> = c.iter().filter(|x| x.1 == 1.0).map(|x| (x.0 * 1e9).round() / 1e9).collect();
    assert_eq!(full, vec![0.2, 0.4]);
}

/// Log-log between the points, the energy to end of life of the end points held outside them
#[test]
fn cycle_curve_interpolates_in_log_log() {
    let c = [(0.2, 25000.0), (0.8, 4000.0)];
    assert!((cycles_at(&c, 0.4) - 10000.0).abs() < 1e-6, "{}", cycles_at(&c, 0.4));   // sqrt(25000 x 4000)
    assert_eq!(cycles_at(&c, 0.2), 25000.0);
    assert!((cycles_at(&c, 0.1) - 50000.0).abs() < 1e-6);   // 25000 x 0.2 / 0.1
    assert!((cycles_at(&c, 1.0) - 3200.0).abs() < 1e-6);   // 4000 x 0.8 / 1.0
    let c4 = [(0.1, 40000.0), (0.3, 15000.0), (0.6, 8000.0), (1.0, 5000.0)];
    assert!((cycles_at(&c4, 0.3) - 15000.0).abs() < 1e-6);
    assert!(cycles_at(&c4, 0.45) < 15000.0 && cycles_at(&c4, 0.45) > 8000.0);
    // the planner's wear cost: the replacement cost over the energy to end of life of a cycle across the window
    assert!((wear_cost(&c, 150.0, 0.8) - 150.0 / (4000.0 * 0.8)).abs() < 1e-12);
}

/// Miner's rule against a hand count: the SOC 0.5 0.9 0.5 0.9 0.5 0.1 0.5 has the reversals 0.5 0.9 0.5 0.9 0.1 0.5. They give
/// three half cycles of 0.4 while the start point moves along, then the residue 0.9 0.1 0.5: half cycles of 0.8 and 0.4.
/// With N(0.4) = 10000 and N(0.8) = 4000, D = 2 / 10000 + 0.5 / 4000.
#[test]
fn miner_damage_matches_a_hand_count() {
    let c = [(0.2, 25000.0), (0.8, 4000.0)];
    let mut m = Miner::default();
    for (r, n) in rainflow(&[0.5, 0.9, 0.5, 0.9, 0.5, 0.1, 0.5]) { m.add(&c, r, n); }
    let want = 2.0 / 10000.0 + 0.5 / 4000.0;
    assert!((m.damage - want).abs() < 1e-15, "{} vs {want}", m.damage);
    assert!((m.cycles - 2.5).abs() < 1e-12);
}

/// Equal energy through the battery: shallow cycles age it less than deep ones with a real curve, and the same with a curve of
/// constant energy to end of life (cycles x depth), which is the linear model
#[test]
fn shallow_cycles_age_less_than_deep_ones() {
    let series = |depth: f64, n: usize| -> Vec<f64> { (0..2 * n + 1).map(|i| if i % 2 == 0 { 0.95 } else { 0.95 - depth }).collect() };
    let (deep, shallow) = (series(0.8, 25), series(0.2, 100));   // 20 nameplate cycles of energy each
    let damage = |c: &[(f64, f64)], x: &[f64]| { let mut m = Miner::default(); for (r, n) in rainflow(x) { m.add(c, r, n); } m.damage };
    let real = [(0.1, 60000.0), (0.5, 9000.0), (1.0, 4000.0)];
    assert!(damage(&real, &shallow) < 0.9 * damage(&real, &deep), "{} vs {}", damage(&real, &shallow), damage(&real, &deep));
    let flat = [(0.2, 30000.0), (1.0, 6000.0)];   // 6000 full cycles of energy at every depth
    let (s, d) = (damage(&flat, &shallow), damage(&flat, &deep));
    assert!((s / d - 1.0).abs() < 1e-9, "{s} vs {d}");
    assert!((d - 20.0 / 6000.0).abs() < 1e-12);
}

/// In the simulation: a curve of constant energy to end of life gives the fade of the linear model it matches, a curve that
/// rewards the shallow cycles of this plant moves the replacement later, and the figures are written only with a curve
#[test]
fn cycle_curve_moves_the_replacement_year() {
    let mut p = example();
    p.sim.all_years = false;
    p.bess.calendar_fade = 0.005;
    (p.bess.cycle_life, p.bess.cycle_life_dod) = (3000.0, 1.0);
    let lin = run(&p, HYB, false);
    let mut q = p.clone();
    q.bess.cycle_curve = vec![(0.1, 30000.0), (1.0, 3000.0)];
    validate_project(&q).unwrap();
    let flat = run(&q, HYB, false);
    let (a, b) = (lin.years[0].soh_loss_cyc, flat.years[0].soh_loss_cyc);
    assert!(a > 0.01 && (b / a - 1.0).abs() < 0.02, "linear {a}, curve of the same energy {b}");
    assert!(flat.years[0].rf_cycles > 0.0 && flat.years[0].rf_dod > 0.0 && flat.years[0].rf_dod <= 1.0);
    let first = |r: &soloptima_engine::sim::SimResult| r.years.iter().position(|y| y.bess_replaced);
    assert_eq!(first(&lin), first(&flat));

    q.bess.cycle_curve = vec![(0.1, 100000.0), (0.5, 12000.0), (1.0, 3000.0)];
    let real = run(&q, HYB, false);
    assert!(real.years[0].soh_loss_cyc < 0.8 * a, "{} vs {a}", real.years[0].soh_loss_cyc);
    let (fl, fr) = (first(&lin).expect("the linear model replaces the battery"), first(&real).unwrap_or(usize::MAX));
    assert!(fr > fl, "replacement in year {} with the curve, {} without", fr + 1, fl + 1);
    // fast mode repeats year 1, so every year has the same damage
    assert!(real.years.iter().all(|y| y.bess_damage == real.years[0].bess_damage));

    let j = result_to_json(&real, false);
    assert!(j.at("years").idx(0).has("rf_cycles") && j.at("years").idx(0).has("bess_damage"));
    assert!(!result_to_json(&lin, false).at("years").idx(0).has("rf_cycles"));
    // the planner's wear cost follows the curve
    let fuel = FuelTable::new(&q.dg).unwrap();
    let w = q.bess.soc_max - q.bess.soc_min;
    assert!((plan_input(&q, &fuel).cycle_cost - wear_cost(&q.bess.cycle_curve, q.econ.bess_replace_kwh, w)).abs() < 1e-12);
}

#[test]
fn a_bad_curve_or_up_time_is_refused() {
    let mut p = example();
    for c in [vec![(0.5, 5000.0)], vec![(0.5, 5000.0), (0.3, 8000.0)], vec![(0.2, 5000.0), (0.8, 8000.0)], vec![(0.0, 9000.0), (1.0, 5000.0)],
              vec![(0.2, f64::NAN), (1.0, 5000.0)], vec![(0.1, 9.0), (0.2, 8.0), (0.3, 7.0), (0.4, 6.0), (0.5, 5.0)]] {
        p.bess.cycle_curve = c.clone();
        assert!(validate_project(&p).is_err(), "{c:?}");
    }
    p.bess.cycle_curve = vec![(0.2, 8000.0), (0.8, 8000.0)];
    assert!(validate_project(&p).is_ok());
    p.dg.min_up_h = -1.0;
    assert!(validate_project(&p).is_err());
    p.dg.min_up_h = 4.0;
    p.dg.min_down_h = 200.0;
    assert!(validate_project(&p).is_err());
}

/// Starts and stops of a units online series that break a minimum up time and a minimum down time (hours), with units alike:
/// a stop takes the unit that has run longest, a start the one that has been off longest (the rule the dispatch states)
fn broken(u: &[f64], units: usize, up: usize, down: usize) -> (f64, f64) {
    let (mut on, mut off): (VecDeque<i64>, VecDeque<i64>) = (VecDeque::new(), vec![i64::MIN / 2; units].into());
    let (mut up_bad, mut down_bad) = (0.0, 0.0);
    for (t, &x) in u.iter().enumerate() {
        let (t, x) = (t as i64, x as usize);
        while on.len() > x { if t - on.pop_front().unwrap() < up as i64 { up_bad += 1.0; } off.push_back(t); }
        while on.len() < x { if t - off.pop_front().unwrap() < down as i64 { down_bad += 1.0; } on.push_back(t); }
    }
    (up_bad, down_bad)
}

/// No unit stops within its minimum up time, and none starts within its minimum down time except the starts the dispatch
/// reports as needed for the load. Without the limits the same plant breaks both.
#[test]
fn minimum_up_and_down_times_hold() {
    let (up, down) = (12usize, 6usize);
    for strategy in ["load_following", "cycle_charging", "predictive"] {
        let mut p = example();
        p.sim.all_years = false;
        p.dg.strategy = strategy.into();
        let free = run(&p, HYB, true);
        (p.dg.min_up_h, p.dg.min_down_h) = (up as f64, down as f64);
        let r = run(&p, HYB, true);
        let n = p.dg.units as usize;
        let (up_bad, down_bad) = broken(&r.hourly.as_ref().unwrap().gen_units, n, up, down);
        let (up_free, down_free) = broken(&free.hourly.as_ref().unwrap().gen_units, n, up, down);
        let y = &r.years[0];
        assert!(up_free > 0.0 && down_free > 0.0, "{strategy}: the limits bind ({up_free}, {down_free})");
        assert_eq!(up_bad, 0.0, "{strategy}: minimum up time broken");
        assert_eq!(down_bad, y.min_down_override, "{strategy}: starts within the down time against those reported");
        assert!(y.starts < free.years[0].starts, "{strategy}: {} starts against {} without the limits", y.starts, free.years[0].starts);
        assert!(balance_error(r.hourly.as_ref().unwrap()) < 0.05);
        assert!(result_to_json(&r, false).at("years").idx(0).has("min_down_override"));
        assert!(!result_to_json(&free, false).at("years").idx(0).has("min_down_override"));
    }
}

/// A unit stopped within its minimum down time starts again when the load would otherwise go unserved: the load takes three
/// units, PV covers it for one hour every day, and nothing else can carry it
#[test]
fn minimum_down_time_yields_to_the_load() {
    let mut p = example();
    p.sim.all_years = false;
    p.econ.lifetime = 1;
    (p.dg.units, p.dg.unit_kw, p.dg.min_units_online, p.dg.min_down_h) = (3, 1000.0, 0, 6.0);
    (p.dg.reserve_load, p.dg.reserve_pv) = (0.0, 0.0);
    p.load_kw = vec![2500.0; HOURS];
    let mut pv = vec![0.0; HOURS];
    for d in 0..365 { pv[d * 24 + 10] = 1.0; }
    let fc = soloptima_engine::sim::PerfectForecast::new(&pv, &p.load_kw, &[]);
    let s = size(3000.0, 0.0, 0.0);
    let si = soloptima_engine::sim::SimInput { pv_per_kwp: &pv, pv_clip_per_kwp: &[], pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: Some(&fc) };
    let r = soloptima_engine::sim::simulate(&p, &si, &s, false).unwrap();
    let y = &r.years[0];
    assert!(y.unmet < 1e-6, "unmet {}", y.unmet);
    assert_eq!(y.min_down_override, 3.0 * 365.0, "the three units an hour after they stopped, every day");
}

/// With the start cost in the plan the predictive EMS starts gensets less often; the economics carry the cost of the starts
#[test]
fn start_cost_in_the_plan_cuts_starts() {
    let mut p = example();
    p.sim.all_years = false;
    p.dg.strategy = "predictive".into();
    p.econ.diesel_start_cost = 60.0;
    let base = run(&p, HYB, false);
    p.ems.plan_starts = true;
    let pl = run(&p, HYB, false);
    let (a, b) = (base.years[0].starts, pl.years[0].starts);
    assert!(b < 0.9 * a, "starts {b} with the cost in the plan, {a} without");
    for r in [&base, &pl] {
        for y in &r.years {
            let esc = (1.0 + p.econ.om_escalation).powf(f64::from(y.year - 1));
            assert!((y.c_starts - y.starts * 60.0 * esc).abs() < 1e-6);
        }
        assert!(result_to_json(r, false).at("years").idx(0).has("c_starts"));
    }
    // fewer starts for a little more fuel: with perfect forecasts the plan is cheaper over the life
    assert!(pl.econ.npc < base.econ.npc, "NPC {} with the cost in the plan, {} without", pl.econ.npc, base.econ.npc);
    p.econ.diesel_start_cost = 0.0;
    assert!(!result_to_json(&run(&p, HYB, false), false).at("years").idx(0).has("c_starts"));
}

/// The plan with starts is the cheapest path once starts are priced, and with a start cost near zero it costs what the plan
/// without starts costs
#[test]
fn the_plan_with_starts_is_the_cheapest_path() {
    use soloptima_engine::sim::{PlanInput, Planner};
    let mut q = example();
    (q.dg.unit_kw, q.dg.units) = (400.0, 5);
    let fuel = FuelTable::new(&q.dg).unwrap();
    let mut pl = Planner::new(&q.dg, &fuel);
    let mut i = plan_input(&q, &fuel);
    (i.e_min, i.e_max, i.pb, i.u0) = (200.0, 2000.0, 600.0, 2);
    // a load that dips for an hour or two now and then, and a PV day
    let lf: Vec<f64> = (0..24).map(|j| if j % 5 == 2 { 450.0 } else { 1150.0 + 250.0 * (f64::from(j) * 0.7).sin() }).collect();
    let pf: Vec<f64> = (0..24).map(|j| if (9..15).contains(&j) { 900.0 } else { 0.0 }).collect();
    // hour costs (as the table has them), starts and the terminal value of a path
    let cost = |pl: &Planner, i: &PlanInput, e: &[f64]| -> (f64, f64) {
        let (mut c, mut starts, mut up) = (0.0, 0.0, i.u0);
        for j in 0..lf.len() {
            let de = e[j + 1] - e[j];
            let b = if de < 0.0 { -de * i.eta } else { -de / i.eta };
            let (h, u) = pl.hour_cost(i, lf[j], pf[j], b, f64::INFINITY);
            c += h;
            starts += f64::from((u - up).max(0));
            up = u;
        }
        (c - i.terminal_per_kwh * e[lf.len()], starts)
    };
    let (mut e0, mut e1, mut u) = (Vec::new(), Vec::new(), Vec::new());
    pl.plan(&i, 800.0, &lf, &pf, &mut e0, &mut u);
    let (c0, s0) = cost(&pl, &i, &e0);
    i.start_cost = 1e-9;
    pl.plan(&i, 800.0, &lf, &pf, &mut e1, &mut u);
    assert!((cost(&pl, &i, &e1).0 - c0).abs() < 1e-6, "{} vs {c0}", cost(&pl, &i, &e1).0);
    i.start_cost = 200.0;
    pl.plan(&i, 800.0, &lf, &pf, &mut e1, &mut u);
    let (c1, s1) = cost(&pl, &i, &e1);
    assert!(c1 + 200.0 * s1 <= c0 + 200.0 * s0 + 1e-6, "with starts priced: {} against {}", c1 + 200.0 * s1, c0 + 200.0 * s0);
    assert!(s1 < s0, "starts {s1} against {s0}");
}
