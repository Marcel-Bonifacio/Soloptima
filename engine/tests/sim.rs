//! The C++ self-tests of the dispatch (tests/test_engine.cpp sections 3, 4, 5, 7, 14 and the battery balance of 15) and the
//! genset fuel model. The C++ tests run on a synthetic 1 MW project with its own PV model; these run on the example project
//! with the C++ PV profile of engine/tests/fixtures/sim.json and perfect forecasts (common/mod.rs). Sizes are scaled to the
//! example where the C++ figure only makes sense for its 1 MW load.
mod common;
use common::*;
use soloptima_engine::sim::{compare, FuelTable, Sizing};
use soloptima_engine::{DieselParams, HOURS};

/// Section 3: energy balance and invariants for every strategy
#[test]
fn energy_balance_per_strategy() {
    for strat in ["load_following", "cycle_charging", "predictive"] {
        let mut q = example();
        q.dg.strategy = strat.into();
        // the predictive EMS over 25 years takes half a minute in a debug build; 3 years still age and repeat the battery
        if strat == "predictive" { q.econ.lifetime = 3; }
        let r = run(&q, HYB, true);
        let h = r.hourly.as_ref().unwrap();
        let be = balance_error(h);
        assert!(be < 1e-6 * HYB.pv_kwp + 0.05, "{strat} balance error {be}");
        for t in 0..HOURS {
            assert!(h.soc[t] >= q.bess.soc_min - 1e-6 && h.soc[t] <= q.bess.soc_max + 1e-6, "{strat} SOC out of window at {t}");
            assert!(h.gen_units[t] >= f64::from(q.dg.min_units_online), "{strat} min units violated at {t}");
            if h.gen_units[t] > 0.0 {
                let g = h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t];
                assert!(g >= h.gen_units[t] * q.dg.unit_kw * q.dg.min_load - 1e-6, "{strat} genset below min load at {t}");
                assert!(g <= h.gen_units[t] * q.dg.unit_kw + 1e-6, "{strat} genset above rating at {t}");
            }
        }
        assert!(r.unmet_fraction < 1e-9, "{strat} unmet {}", r.unmet_fraction);
        assert_eq!(r.years.len(), q.econ.lifetime as usize, "{strat} years");
    }
}

/// Section 4: baseline without PV has no renewable share; adding PV never raises year-1 fuel (load following)
#[test]
fn baseline_and_pv_fuel() {
    let mut p = example();
    p.sim.all_years = false;   // only year 1 is checked
    let b = run(&p, Sizing::default(), false);
    assert!(b.re_fraction < 1e-9, "baseline RE {}", b.re_fraction);
    let mut prev = b.fuel_l_y1;
    // the C++ steps 300..2400 kWp on a 1 MW load, scaled to the 23 MW example load
    for kwp in [6000.0, 12000.0, 24000.0, 48000.0] {
        let r = run(&p, size(kwp, 0.0, 0.0), false);
        assert!(r.fuel_l_y1 <= prev + 1e-6, "fuel rose with PV {kwp} kWp: {} after {prev}", r.fuel_l_y1);
        prev = r.fuel_l_y1;
    }
}

/// Section 5: the perfect-forecast EMS costs at most 1 % more (NPC) than load following
#[test]
fn perfect_ems_vs_load_following() {
    let (mut a, mut b) = (example(), example());
    a.dg.strategy = "load_following".into();
    b.dg.strategy = "predictive".into();
    a.sim.all_years = false;
    b.sim.all_years = false;
    let (fa, fb) = (run(&a, HYB, false).econ.npc, run(&b, HYB, false).econ.npc);
    assert!(fb <= fa * 1.01, "perfect EMS NPC {fb} vs LF {fa}");
}

/// Section 7: wind turbines, literature indicators, self-discharge. The wind is the C++ profile of the fixture's wind
/// case (3 x 2000 kW on the example's weather) rather than the synthetic 5 +- 3 m/s wind of the C++ test.
#[test]
fn wind_indicators_self_discharge() {
    let mut q = example();
    q.sim.all_years = false;
    q.wind.units = 3;
    q.wind.rated_kw = 2000.0;
    let s = Sizing { wind_units: 3.0, ..HYB };
    let r = run(&q, s, true);
    assert!(r.years[0].wind_avail > 0.0, "wind produced nothing");
    let be = balance_error(r.hourly.as_ref().unwrap());
    assert!(be < 0.05, "energy balance with wind {be}");
    let m = &r.metrics;
    assert!(m.sssi > 0.0 && m.sssi <= 1.0 && m.ssci > 0.0 && m.ssci <= 1.0, "SSSI {} / SSCI {} out of range", m.sssi, m.ssci);
    assert!((m.rep - 100.0 * (1.0 - m.lpsp)).abs() < 1e-9, "REP {} LPSP {}", m.rep, m.lpsp);
    assert!(r.econ.crf > 0.0 && (r.econ.tac - r.econ.npc * r.econ.crf).abs() < 1e-6 * r.econ.tac, "TAC");
    let mut sd = q.clone();
    sd.bess.self_discharge = 0.001;
    assert!(run(&sd, s, false).years[0].self_discharge > 0.0, "self-discharge not applied");
}

/// Section 14: the battery's own value, with PV only (same PV, no battery) as the reference of compare()
#[test]
fn pv_only_reference() {
    let p = example();
    let ps = size(HYB.pv_kwp, 0.0, 0.0);
    let pvo = run(&p, ps, true);
    let flow = pvo.years.iter().fold(0.0f64, |a, y| a.max(y.bess_dis).max(y.bess_ch));
    assert!(pvo.years.len() == p.econ.lifetime as usize && flow == 0.0 && pvo.bess_replacements == 0,
            "PV only: battery flow {flow} kWh, {} replacements", pvo.bess_replacements);
    let be = balance_error(pvo.hourly.as_ref().unwrap());
    assert!(be < 0.05, "PV-only energy balance {be}");
    let hyb = run(&p, HYB, false);
    let cb = compare(&hyb, &pvo);
    assert!((cb.npv_savings - (pvo.econ.npc - hyb.econ.npc)).abs() < 1e-6, "battery NPV {} vs NPC difference {}", cb.npv_savings, pvo.econ.npc - hyb.econ.npc);
    assert!((hyb.econ.capex_total - pvo.econ.capex_total - hyb.econ.capex_bess).abs() < 1e-6, "incremental capex is not the battery capex");
    // the incremental cash flow (battery capex, O&M, replacements, salvage) discounts to the NPV of savings, and to zero at the IRR
    let (d, cf0) = (p.econ.discount_rate, pvo.econ.capex_total - hyb.econ.capex_total);
    let (mut at_d, mut at_irr) = (cf0, cf0);
    for (i, (b, h)) in pvo.years.iter().zip(&hyb.years).enumerate() {
        let cf = b.c_total - h.c_total;
        at_d += cf / (1.0 + d).powi(i as i32 + 1);
        if let Some(irr) = cb.irr { at_irr += cf / (1.0 + irr).powi(i as i32 + 1); }
    }
    assert!((at_d - cb.npv_savings).abs() < 1e-6 * cb.npv_savings.abs().max(1.0), "incremental cash flow NPV {at_d} vs {}", cb.npv_savings);
    assert!(cb.irr.is_none() || at_irr.abs() < 1e-6 * cf0.abs(), "incremental NPV at the battery IRR {at_irr}");
    // without a battery every strategy reduces to load following
    for strat in ["cycle_charging", "predictive"] {
        let mut q = p.clone();
        q.dg.strategy = strat.into();
        let f = run(&q, ps, false).fuel_l_y1;
        assert!(f == pvo.fuel_l_y1, "{strat} without a battery: fuel {f} L vs load following {} L", pvo.fuel_l_y1);
    }
}

/// Section 15 (battery part): the stored-energy balance closes every year: charge - discharge - self-discharge - change in
/// stored energy is the conversion loss at the one-way efficiency. The monthly PV balances need the PV model.
#[test]
fn battery_energy_balance() {
    let p = example();
    let eta = p.bess.rte.sqrt();
    for strat in ["load_following", "cycle_charging", "predictive"] {
        let mut q = p.clone();
        q.dg.strategy = strat.into();
        q.bess.self_discharge = 2e-4;
        if strat == "predictive" { q.econ.lifetime = 3; }   // debug builds, as in section 3
        let r = run(&q, HYB, true);
        let mut worst = 0.0f64;
        for y in &r.years {
            let loss = y.bess_ch - y.bess_dis - y.self_discharge - (y.e_end - y.e_start);
            let expect = (1.0 - eta) * y.bess_ch + (1.0 / eta - 1.0) * y.bess_dis;
            worst = worst.max((loss - expect).abs() / (y.bess_ch + y.bess_dis));
        }
        assert!(worst < 1e-6, "{strat} battery losses off by {worst} of throughput");
        let y1 = &r.years[0];
        let g_ch: f64 = r.hourly.as_ref().unwrap().gen_to_bess.iter().sum();
        assert!((y1.gen_to_bess - g_ch).abs() < 1e-6 * g_ch.max(1.0), "{strat} genset charging {} vs hourly {g_ch}", y1.gen_to_bess);
        assert!((y1.gen_kwh - y1.gen_to_load - y1.gen_to_bess - y1.gen_dump).abs() < 1e-6 * y1.gen_kwh, "{strat} genset energy split");
    }
}

/// The genset fuel table (src/fuel.hpp): linear and tabulated models, clamping, NaN, a curve too short
#[test]
fn fuel_table() {
    let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
    let lin = DieselParams { fuel_model: "linear".into(), fuel_intercept: 0.0165, fuel_slope: 0.2423, ..Default::default() };
    let f = FuelTable::new(&lin).unwrap();
    for lf in [0.0, 0.123, 0.5, 0.755, 1.0] { assert!(close(f.at(lf), 0.0165 + 0.2423 * lf), "linear at {lf}: {}", f.at(lf)); }
    assert!(f.at(f64::NAN) == f.at(0.0) && f.at(-0.5) == f.at(0.0) && f.at(1.7) == f.at(1.0), "linear clamping");

    // the table interpolates L/h (load fraction / kWh per litre) between the points and extends the end segments
    let d = DieselParams::default();
    let t = FuelTable::new(&d).unwrap();
    for &(lf, eff) in &d.fuel_curve { assert!(close(t.at(lf), lf / eff), "table at {lf}: {} vs {}", t.at(lf), lf / eff); }
    assert!(close(t.at(0.35), 0.5 * (0.3 / 3.37 + 0.4 / 3.60)), "between points {}", t.at(0.35));
    let (y0, y1) = (0.25 / 3.22, 0.3 / 3.37);
    assert!(close(t.at(0.1), y0 + (y1 - y0) * (0.1 - 0.25) / 0.05), "below the first point {}", t.at(0.1));
    assert!(t.at(f64::NAN) == t.at(0.0) && t.at(-1.0) == t.at(0.0) && t.at(2.0) == t.at(1.0), "table clamping");
    // the points may come in any order
    let mut rev = d.clone();
    rev.fuel_curve.reverse();
    let tr = FuelTable::new(&rev).unwrap();
    assert!((0..=100).all(|k| tr.at(k as f64 / 100.0) == t.at(k as f64 / 100.0)), "unsorted curve");
    // a steep curve extended below its first point stops at zero fuel
    let steep = DieselParams { fuel_curve: vec![(0.5, 1.0), (1.0, 0.5)], ..Default::default() };
    let ts = FuelTable::new(&steep).unwrap();
    assert!(ts.at(0.0) == 0.0 && ts.at(0.1) == 0.0 && close(ts.at(0.4), 0.2), "clamped at zero: {} {} {}", ts.at(0.0), ts.at(0.1), ts.at(0.4));

    for curve in [vec![], vec![(0.5, 3.5)]] {
        let e = FuelTable::new(&DieselParams { fuel_curve: curve, ..Default::default() }).unwrap_err();
        assert_eq!(e.to_string(), "Fuel curve needs at least 2 points.");
    }
    // the linear model needs no curve
    assert!(FuelTable::new(&DieselParams { fuel_curve: vec![], ..lin }).is_ok());
}
