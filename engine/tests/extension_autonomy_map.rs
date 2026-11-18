//! The grid-extension break-even, reliability in time (low-PV days, unserved hours, days of autonomy), the resource scales and
//! the two-way map of the optimiser. The optimiser cases run the example project at 1 % of its load over year 1.
use soloptima_engine::api::run_simulation;
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::pv::{compute_pv_profile, wind_per_turbine};
use soloptima_engine::sim::{grid_extension, reliability_json, simulate, Hourly, SimInput, SimResult, Sizing, YearResult};
use soloptima_engine::{parse_project, validate_project, Project, Value, HOURS};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

fn doc() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json");
    Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn example() -> Project {
    let mut p = parse_project(&doc());
    p.sim.all_years = false;
    p
}

/// The example at 1 % of its load with 4 x 100 kW gensets
fn small() -> Project {
    let mut p = example();
    for x in &mut p.load_kw { *x *= 0.01; }
    p.load_sub.clear();
    p.dg.unit_kw = 100.0;
    p.dg.units = 4;
    p
}

fn run(p: &Project, block: &str, prog: &Progress) -> Value {
    optimize(p, &parse_opt_settings(&Value::parse(block).unwrap(), p).unwrap(), prog).unwrap()
}

const SMALL: &str = r#""pv_max":3000,"pv_steps":3,"bess_max":6000,"bess_steps":3,"refine":false"#;

fn sim(p: &Project, s: Sizing) -> SimResult {
    let prof = compute_pv_profile(p).unwrap();
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
    simulate(p, &si, &s, false).unwrap()
}

#[test]
fn break_even_distance_against_a_hand_calculation() {
    let mut p = Project::default();
    p.econ.discount_rate = 0.1;
    p.econ.om_escalation = 0.0;
    let mut r = SimResult::default();
    r.econ.npc = 30_000.0;
    r.years = (1..=2).map(|year| YearResult { year, load: 1100.0, aux: 100.0, ..Default::default() }).collect();
    assert!(grid_extension(&p, &r).is_none(), "off while the cost per km is 0");

    p.grid_ext.cost_per_km = 10_000.0;
    p.grid_ext.connection_cost = 5_000.0;
    p.grid_ext.om_per_km_yr = 200.0;
    p.grid_ext.price = 0.1;
    p.grid_ext.escalation = 0.05;
    let g = grid_extension(&p, &r).unwrap();
    // 1000 kWh of site load a year at 0.10, the second year 5 % dearer, discounted at 10 %
    let fixed = 5_000.0 + 1000.0 * 0.1 / 1.1 + 1000.0 * 0.1 * 1.05 / 1.21;
    let per_km = 10_000.0 + 200.0 / 1.1 + 200.0 / 1.21;
    assert!((g.get("npc_fixed", 0.0) - fixed).abs() < 1e-9);
    assert!((g.get("npc_per_km", 0.0) - per_km).abs() < 1e-9);
    assert!((g.get("break_even_km", 0.0) - (30_000.0 - fixed) / per_km).abs() < 1e-9);
    assert!((g.get("break_even_km", 0.0) - 2.398_962).abs() < 1e-6);
    assert_eq!(g.get("energy_kwh", 0.0), 2000.0);

    // a grid that costs more than the plant even at the substation: 0 km
    r.econ.npc = 1_000.0;
    assert_eq!(grid_extension(&p, &r).unwrap().get("break_even_km", -1.0), 0.0);
}

#[test]
fn simulate_reports_the_break_even_only_when_asked() {
    let mut d = doc();
    d.set("sim", Value::parse(r#"{"all_years":false}"#).unwrap());
    let a = run_simulation(&parse_project(&d), &d).unwrap();
    assert!(!a.has("grid_extension"));
    d.set("grid_ext", Value::parse(r#"{"cost_per_km":20000,"connection_cost":1e6,"om_per_km_yr":300,"price":0.12}"#).unwrap());
    let b = run_simulation(&parse_project(&d), &d).unwrap();
    let g = b.at("grid_extension");
    assert_eq!(g.get("npc_plant", 0.0), b.at("result").at("econ").get("npc", 1.0));
    let km = g.get("break_even_km", -1.0);
    assert!((g.get("npc_fixed", 0.0) + km * g.get("npc_per_km", 0.0) - g.get("npc_plant", 0.0)).abs() < 1e-6 * g.get("npc_plant", 0.0));
    // the rest of the answer is the same
    assert_eq!(a.at("result").dump(), b.at("result").dump());
    // a negative cost is refused
    d.set("grid_ext", Value::parse(r#"{"cost_per_km":-1}"#).unwrap());
    assert!(validate_project(&parse_project(&d)).is_err());
}

#[test]
fn low_pv_and_unserved_runs_on_hand_made_series() {
    // 5 kWh/kWp a day, with 4 dull days from day 100, 2 from day 200 and one middling day (300) above half the mean
    let mut pv = vec![0.0; HOURS];
    for d in 0..365 {
        let y = match d { 100..=103 => 1.0, 200 | 201 => 2.0, 300 => 2.6, _ => 5.0 };
        pv[d * 24 + 12] = y;
    }
    let mut h = Hourly { load: vec![10.0; HOURS], unmet: vec![0.0; HOURS], ..Default::default() };
    for i in 50..53 { h.unmet[i] = 5.0; }
    h.unmet[60] = 0.005;   // below 0.1 % of the load: not a loss of load
    for i in 1000..1006 { h.unmet[i] = 1.0; }
    let r = reliability_json(&pv, &h, 0.5);
    assert_eq!(r.get("low_pv_days", 0.0), 6.0);
    assert_eq!(r.get("low_pv_run_d", 0.0), 4.0);
    assert_eq!(r.get("low_pv_run_start", 0.0), 100.0);
    assert_eq!(r.get("unmet_run_h", 0.0), 6.0);
    assert_eq!(r.get("unmet_run_start", 0.0), 1000.0);
    // a higher threshold takes the middling day too, and the longest run stays
    let r = reliability_json(&pv, &h, 0.55);
    assert_eq!((r.get("low_pv_days", 0.0), r.get("low_pv_run_d", 0.0)), (7.0, 4.0));
    // no PV and no unserved load: no days, no run
    let r = reliability_json(&vec![0.0; HOURS], &Hourly { load: vec![1.0; HOURS], unmet: vec![0.0; HOURS], ..Default::default() }, 0.5);
    assert!(r.at("low_pv_run_d").is_null() && r.at("unmet_run_start").is_null());
    assert_eq!(r.get("unmet_run_h", -1.0), 0.0);
}

#[test]
fn simulate_summary_has_the_runs() {
    let mut d = doc();
    d.set("sim", Value::parse(r#"{"all_years":false,"low_pv_frac":0.6}"#).unwrap());
    let a = run_simulation(&parse_project(&d), &d).unwrap();
    let r = a.at("result").at("summary").at("reliability");
    assert_eq!(r.get("low_pv_frac", 0.0), 0.6);
    assert!(r.get("low_pv_run_d", 0.0) >= 1.0 && r.get("low_pv_days", 0.0) >= r.get("low_pv_run_d", 0.0));
    d.set("sim", Value::parse(r#"{"low_pv_frac":1}"#).unwrap());
    assert!(validate_project(&parse_project(&d)).is_err());
}

#[test]
fn autonomy_constraint_rejects_short_batteries() {
    let p = small();
    let free = run(&p, &format!("{{{SMALL}}}"), &Progress::default());
    assert!(!free.at("settings").has("min_autonomy_days") && !free.at("grid").idx(0).has("autonomy_d"));
    let n = 0.5;
    let r = run(&p, &format!(r#"{{{SMALL},"min_autonomy_days":{n}}}"#), &Progress::default());
    let (mut below, mut above) = (0, 0);
    let b = &p.bess;
    for (c, f) in r.at("grid").arr().iter().zip(free.at("grid").arr()) {
        let d = c.get("autonomy_d", -1.0);
        // the hand formula on the year-1 mean load of the candidate (simulated again here)
        if c.get("bess_kwh", 0.0) > 0.0 {
            let s = Sizing { pv_kwp: c.get("pv_kwp", 0.0), bess_kwh: c.get("bess_kwh", 0.0), bess_kw: c.get("bess_kw", 0.0), ..Default::default() };
            let mean = sim(&p, s).years[0].load / HOURS as f64;
            let want = s.bess_kwh * b.soh_init * (b.soc_max - b.soc_min) * b.rte.sqrt() / (24.0 * mean);
            assert!((d - want).abs() < 1e-9 * want, "{d} {want}");
        }
        if d < n {
            below += 1;
            assert!(!c.getb("feasible", true));
        } else {
            above += 1;
            assert_eq!(c.getb("feasible", false), f.getb("feasible", true), "a design above the autonomy keeps its feasibility");
        }
    }
    assert!(below > 0 && above > 0, "{below} below, {above} above");
    let best = r.at("best");
    assert!(best.get("autonomy_d", 0.0) >= n);
    // a stated load in place of the mean load
    let r2 = run(&p, &format!(r#"{{{SMALL},"min_autonomy_days":{n},"autonomy_load_kw":100}}"#), &Progress::default());
    let c = &r2.at("grid").arr()[r2.at("grid").arr().len() - 1];
    let want = c.get("bess_kwh", 0.0) * b.soh_init * (b.soc_max - b.soc_min) * b.rte.sqrt() / 2400.0;
    assert!((c.get("autonomy_d", 0.0) - want).abs() < 1e-9);
    assert!(parse_opt_settings(&Value::parse(r#"{"min_autonomy_days":-1}"#).unwrap(), &p).is_err());
}

#[test]
fn irradiance_scale_lowers_the_pv_yield_by_about_its_share() {
    let mut p = example();
    let base = compute_pv_profile(&p).unwrap();
    p.pv.irradiance_scale = 1.0;
    assert!(compute_pv_profile(&p).unwrap().ac_per_kwp == base.ac_per_kwp, "a scale of 1 changes nothing");
    p.pv.irradiance_scale = 0.9;
    let low = compute_pv_profile(&p).unwrap();
    let ratio = low.specific_yield / base.specific_yield;
    assert!((0.88..0.92).contains(&ratio), "{ratio}");
    assert!(ratio != 0.9, "the PV model answers to the irradiance, not a plain factor on the output");
    p.pv.irradiance_scale = 0.0;
    assert!(validate_project(&p).is_err());
}

#[test]
fn wind_scale_moves_the_speed_before_the_power_curve() {
    let mut p = example();
    p.wind.units = 1;
    let base = wind_per_turbine(&p).unwrap();
    p.wind.speed_scale = 1.15;
    let up = wind_per_turbine(&p).unwrap();
    // the same as faster wind in the weather file
    let mut q = example();
    q.wind.units = 1;
    for v in &mut q.wx.wind { *v *= 1.15; }
    assert!(up == wind_per_turbine(&q).unwrap());
    let (s0, s1): (f64, f64) = (base.iter().sum(), up.iter().sum());
    assert!(s1 > s0 && (s1 / s0 - 1.15).abs() > 0.01, "the power curve is not linear: {}", s1 / s0);
    // hours below cut-in start to turn and none passes the rating
    assert!(base.iter().zip(&up).any(|(a, b)| *a == 0.0 && *b > 0.0));
    assert!(up.iter().all(|&x| x <= p.wind.rated_kw));
    p.wind.speed_scale = 2.5;
    assert!(validate_project(&p).is_err());
}

#[test]
fn sensitivity_on_the_irradiance_reoptimises_with_the_scaled_pv() {
    let p = small();
    let r = run(&p, &format!(r#"{{{SMALL},"sens_var":"irradiance_scale","sens_values":[0.8]}}"#), &Progress::default());
    let mut q = p.clone();
    q.pv.irradiance_scale = 0.8;
    let one = run(&q, &format!("{{{SMALL}}}"), &Progress::default());
    assert_eq!(r.at("sensitivity").at("rows").idx(0).at("best").dump(), one.at("best").dump());
}

const MAP: &str = r#""map_x":"fuel_price","map_x_values":[0.6,1.4],"map_y":"irradiance_scale","map_y_values":[0.85,1]"#;

#[test]
fn map_cells_match_single_runs() {
    let p = small();
    let r = run(&p, &format!(r#"{{{SMALL},{MAP}}}"#), &Progress::default());
    let m = r.at("map");
    assert_eq!(m.gets("mode", ""), "optimize");
    assert_eq!(r.at("settings").gets("map_x", ""), "fuel_price");
    for (iy, &vy) in [0.85, 1.0].iter().enumerate() {
        for (ix, &vx) in [0.6, 1.4].iter().enumerate() {
            let mut q = p.clone();
            q.econ.fuel_price = vx;
            q.pv.irradiance_scale = vy;
            let one = run(&q, &format!("{{{SMALL}}}"), &Progress::default());
            let cell = m.at("cells").idx(iy).idx(ix);
            assert_eq!(cell.at("best").dump(), one.at("best").dump(), "cell {ix},{iy}");
            assert_eq!(cell.get("baseline_npc", 0.0), one.at("baseline").at("econ").get("npc", 1.0));
            assert!(!cell.gets("type", "").is_empty());
        }
    }
    // without a map the answer has none
    assert!(!run(&p, &format!("{{{SMALL}}}"), &Progress::default()).has("map"));
}

#[test]
fn fixed_map_simulates_the_best_design_of_each_system_type() {
    let p = small();
    let r = run(&p, &format!(r#"{{{SMALL},{MAP},"map_mode":"fixed"}}"#), &Progress::default());
    let m = r.at("map");
    let designs = m.at("designs").arr();
    assert!(designs.len() >= 2, "{}", m.at("designs").dump());
    let cell = m.at("cells").idx(0).idx(1);   // fuel 1.4, irradiance 0.85
    let mut q = p.clone();
    q.econ.fuel_price = 1.4;
    q.pv.irradiance_scale = 0.85;
    let mut best = (f64::INFINITY, String::new());
    for (k, d) in designs.iter().enumerate() {
        let s = Sizing { pv_kwp: d.get("pv_kwp", 0.0), bess_kwh: d.get("bess_kwh", 0.0), bess_kw: d.get("bess_kw", 0.0), wind_units: 0.0, gen_units: None };
        let npc = sim(&q, s).econ.npc;
        assert_eq!(cell.at("npc").idx(k).num(0.0), npc, "design {k}");
        if cell.at("feasible").idx(k).boolean(false) && npc < best.0 { best = (npc, d.gets("type", "")); }
    }
    assert_eq!(cell.gets("type", ""), best.1);
    assert_eq!(cell.at("best").get("npc", 0.0), best.0);
}

#[test]
fn map_settings_are_checked() {
    let p = small();
    let bad = |b: &str| parse_opt_settings(&Value::parse(b).unwrap(), &p).is_err();
    assert!(bad(r#"{"map_x":"fuel_price","map_x_values":[1],"map_y":"nonsense","map_y_values":[1]}"#));
    assert!(bad(r#"{"map_x":"fuel_price","map_x_values":[1],"map_y":"fuel_price","map_y_values":[1]}"#));
    assert!(bad(r#"{"map_x":"fuel_price","map_x_values":[],"map_y":"load_scale","map_y_values":[1]}"#));
    assert!(bad(r#"{"map_x":"fuel_price","map_x_values":[1,2,3,4,5,6,7,8,9,10,11],"map_y":"load_scale","map_y_values":[1]}"#));
    assert!(bad(r#"{"map_x":"irradiance_scale","map_x_values":[0],"map_y":"load_scale","map_y_values":[1]}"#));
    assert!(bad(r#"{"map_x":"fuel_price","map_x_values":[1],"map_y":"load_scale","map_y_values":[1],"map_mode":"other"}"#));
    assert!(!bad(r#"{"map_x":"fuel_price","map_x_values":[1],"map_y":"wind_speed_scale","map_y_values":[1.1],"map_mode":"fixed"}"#));
}

#[test]
fn cancel_stops_the_map() {
    let p = small();
    // cancelled before the start: no cell
    let prog = Progress::default();
    prog.cancel.store(true, Relaxed);
    let r = run(&p, &format!(r#"{{{SMALL},{MAP}}}"#), &prog);
    assert!(r.at("cancelled").boolean(false));
    assert!(r.at("map").at("cells").arr().iter().all(|row| row.arr().iter().all(Value::is_null)));
    assert_eq!(prog.done.load(Relaxed), prog.total.load(Relaxed));
    // cancelled while the map runs: the main search is there, the last cell is not
    let prog = Progress::default();
    let fin = AtomicBool::new(false);
    let r = std::thread::scope(|s| {
        s.spawn(|| {
            while !fin.load(Relaxed) {
                if prog.done.load(Relaxed) >= 12 { prog.cancel.store(true, Relaxed); break; }
                std::thread::yield_now();
            }
        });
        let r = run(&p, &format!(r#"{{{SMALL},{MAP}}}"#), &prog);
        fin.store(true, Relaxed);
        r
    });
    assert!(r.at("cancelled").boolean(false));
    assert!(!r.at("best").is_null());
    assert!(r.at("map").at("cells").idx(1).idx(1).is_null());
}
