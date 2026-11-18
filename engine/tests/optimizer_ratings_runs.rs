//! Genset unit rating search, repeated metaheuristic runs and the MOPSO front statistics, on the example project scaled to a
//! small plant (about 230 kW of load and a 252 kW peak, 4 x 100 kW gensets) and simulated over year 1.
use soloptima_engine::optimizer::{hypervolume, optimize, parse_opt_settings, spacing, Progress};
use soloptima_engine::pv::compute_pv_profile;
use soloptima_engine::sim::{simulate, SimInput, Sizing};
use soloptima_engine::{parse_project, Project, Value};
use std::path::PathBuf;

fn small() -> Project {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json");
    let mut p = parse_project(&Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap());
    p.sim.all_years = false;
    for x in &mut p.load_kw { *x *= 0.01; }
    p.load_sub.clear();
    p.dg.unit_kw = 100.0;
    p.dg.units = 4;
    p.econ.diesel_capex_kw = 600.0;
    p
}

fn settings(p: &Project, block: &str) -> Result<soloptima_engine::optimizer::OptSettings, String> {
    parse_opt_settings(&Value::parse(block).unwrap(), p).map_err(|e| e.0)
}

fn run(p: &Project, block: &str) -> Value { optimize(p, &settings(p, block).unwrap(), &Progress::default()).unwrap() }

/// No PV and no battery: the gensets carry the whole load
const DIESEL: &str = r#""pv_min":0,"pv_max":1,"pv_steps":1,"bess_min":0,"bess_max":1,"bess_steps":1,"refine":false"#;
const META: &str = r#""pv_max":3000,"bess_max":12000,"max_unmet":0.02,"particles":6,"iterations":5"#;

#[test]
fn off_by_default_answers_as_before() {
    let p = small();
    for alg in ["grid", "pso", "hshoa", "mopso"] {
        let base = format!(r#""algorithm":"{alg}","pv_max":3000,"pv_steps":3,"bess_max":12000,"bess_steps":3,"particles":5,"iterations":3"#);
        let a = run(&p, &format!("{{{base}}}"));
        let b = run(&p, &format!(r#"{{{base},"gen_ratings":[],"repeat_runs":1,"pareto_stats":false,"mo_pick":"knee"}}"#));
        assert_eq!(a.dump(), b.dump(), "{alg}");
        for k in ["runs", "pareto_quality", "lpsp_table", "architectures"] { assert!(!a.has(k), "{alg}: {k}"); }
        assert!(!a.at("best").has("gen_kw") && !a.at("best").has("co2_t") && !a.at("settings").has("gen_ratings"));
    }
    // repeat runs mean nothing to the grid search
    let base = format!("{{{DIESEL}}}");
    assert_eq!(run(&p, &base).dump(), run(&p, &format!(r#"{{{DIESEL},"repeat_runs":5}}"#)).dump());
}

#[test]
fn bad_inputs_are_refused() {
    let p = small();
    for (block, msg) in [
        (r#"{"repeat_runs":0}"#, "Repeat runs"), (r#"{"repeat_runs":51}"#, "Repeat runs"), (r#"{"repeat_runs":2.5}"#, "Repeat runs"),
        (r#"{"mo_pick":"best"}"#, "knee or fuzzy"), (r#"{"gen_ratings":[{"kw":0}]}"#, "above 0"), (r#"{"gen_ratings":{"kw":500}}"#, "at most 12"),
        (r#"{"gen_ratings":[{"kw":500,"min_load":1}]}"#, "minimum load"), (r#"{"gen_ratings":[{"kw":500,"fuel_curve":[[0.5,3.5]]}]}"#, "fuel curve"),
        (r#"{"gen_ratings":[{"kw":500,"capex_kw":-1}]}"#, "non-negative"),
    ] {
        let e = settings(&p, block).unwrap_err();
        assert!(e.contains(msg), "{block}: {e}");
    }
    let o = settings(&p, r#"{"gen_ratings":[{"kw":800},{"kw":200,"name":"small"},{"kw":500}]}"#).unwrap();
    assert_eq!(o.gen_ratings.iter().map(|r| r.kw).collect::<Vec<_>>(), [200.0, 500.0, 800.0], "sorted by rating");
}

/// Four ratings for a 252 kW peak with no PV or battery. Units of 60 kW at a high minimum load and costly per kW and per run
/// hour lose; three 120 kW units or one 600 kW unit cost more than one 300 kW unit at the same price per kW, since the large
/// unit runs at low loading and the small ones add run hours. One 300 kW unit is the answer.
const RATINGS: &str = r#""gen_ratings":[{"kw":600,"min_load":0.3,"capex_kw":400},{"kw":60,"min_load":0.6,"capex_kw":900,"om_unit_hour":6},
    {"kw":300,"min_load":0.3,"capex_kw":400},{"kw":120,"min_load":0.3,"capex_kw":400}],"size_gensets":true,"gen_units_min":1,"gen_units_max":6"#;

#[test]
fn the_rating_search_picks_one_large_unit() {
    let p = small();
    let r = run(&p, &format!("{{{DIESEL},{RATINGS}}}"));
    let b = r.at("best");
    assert_eq!((b.get("gen_kw", 0.0), b.get("gen_units", 0.0), b.get("gen_rating", -1.0)), (300.0, 1.0, 2.0), "best {}", b.dump());
    // 4 ratings x 6 counts, one PV and battery point
    assert_eq!(r.at("grid").len(), 24);
    let kws: Vec<f64> = r.at("settings").at("gen_ratings").arr().iter().map(|g| g.get("kw", 0.0)).collect();
    assert_eq!(kws, [60.0, 120.0, 300.0, 600.0]);
    // the best design was simulated with its own rating and price
    assert_eq!(r.at("best_detail").at("econ").get("capex_diesel", 0.0), 300.0 * 400.0);
    // the diesel-only reference keeps the project's 4 x 100 kW at 600 per kW
    assert_eq!(r.at("baseline").at("econ").get("capex_diesel", 0.0), 4.0 * 100.0 * 600.0);
    // the system type table reports the rating too
    let arch = r.at("architectures").arr();
    assert!(arch.iter().any(|a| a.at("best").get("gen_kw", 0.0) == 300.0), "{}", r.at("architectures").dump());
    // the cheapest design of each rating: more small units than large ones
    let units_at = |kw: f64| r.at("ranked").arr().iter().find(|c| c.get("gen_kw", 0.0) == kw).map(|c| c.get("gen_units", 0.0));
    assert_eq!(units_at(120.0), Some(3.0));
    assert!(units_at(60.0).is_none_or(|n| n >= 5.0));

    // the metaheuristics treat the rating as an integer dimension and find the same answer
    let r = run(&p, &format!(r#"{{"algorithm":"pso","particles":10,"iterations":10,{DIESEL},{RATINGS}}}"#));
    let ev = r.at("evaluated").arr();
    let seen: std::collections::BTreeSet<i64> = ev.iter().map(|c| c.get("gen_kw", 0.0) as i64).collect();
    assert!(seen.len() > 2 && seen.iter().all(|k| [60, 120, 300, 600].contains(k)), "{seen:?}");
    assert_eq!((r.at("best").get("gen_kw", 0.0), r.at("best").get("gen_units", 0.0)), (300.0, 1.0), "best {}", r.at("best").dump());
}

#[test]
fn a_rating_brings_its_own_fuel_curve() {
    let p = small();
    let double: Vec<Value> = p.dg.fuel_curve.iter().map(|&(lf, e)| Value::Arr(vec![lf.into(), (2.0 * e).into()])).collect();
    let block = format!(r#"{{{DIESEL},"gen_ratings":[{{"kw":100}},{{"kw":100,"fuel_curve":{}}}]}}"#, Value::Arr(double).dump());
    let r = run(&p, &block);
    let g = r.at("grid").arr();
    assert_eq!(g.len(), 2);
    let (own, twice) = (g[0].get("fuel", 0.0), g[1].get("fuel", 0.0));
    assert!(own > 0.0 && ((twice / own) - 0.5).abs() < 1e-9, "{own} {twice}");
    assert!(r.at("settings").at("gen_ratings").idx(1).getb("own_fuel_curve", false));
    // a rating equal to the project's, without a curve, is the project as it is
    let plain = run(&p, &format!("{{{DIESEL}}}"));
    assert_eq!(plain.at("grid").idx(0).get("npc", 0.0), g[0].get("npc", 1.0));
    // and the curve reaches the simulation as if typed into the project
    let mut q = p.clone();
    for pt in &mut q.dg.fuel_curve { pt.1 *= 2.0; }
    let prof = compute_pv_profile(&q).unwrap();
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &[], wind_per_turbine: &[], forecast: None };
    let s = simulate(&q, &si, &Sizing::default(), false).unwrap();
    assert_eq!(s.fuel_l_y1, twice);
}

#[test]
fn repeat_runs_give_statistics() {
    let p = small();
    let block = format!(r#"{{"algorithm":"pso",{META},"repeat_runs":4}}"#);
    let r = run(&p, &block);
    let st = r.at("runs");
    assert_eq!((st.get("n", 0.0), st.at("metric").str(), st.getb("higher_is_better", true)), (4.0, "npc", false));
    let rows = st.at("rows").arr();
    assert_eq!(rows.len(), 4);
    // distinct seeds, the first is the project's; every run evaluates particles x (iterations + 1) positions
    let seeds: std::collections::BTreeSet<i64> = rows.iter().map(|x| x.get("seed", 0.0) as i64).collect();
    assert_eq!(seeds.len(), 4);
    assert_eq!(rows[0].get("seed", 0.0), 42.0);
    assert!(rows.iter().all(|x| x.get("evaluations", 0.0) == 36.0));
    // best, mean, worst and the sample standard deviation by hand
    let v: Vec<f64> = rows.iter().map(|x| x.get("value", f64::NAN)).collect();
    assert!(v.iter().all(|x| x.is_finite()));
    let mean = v.iter().sum::<f64>() / 4.0;
    let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / 3.0).sqrt();
    let (lo, hi) = v.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, &x| (a.0.min(x), a.1.max(x)));
    let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * b.abs().max(1.0);
    assert!(close(st.get("mean", 0.0), mean) && close(st.get("std", 0.0), sd) && st.get("best", 0.0) == lo && st.get("worst", 0.0) == hi);
    assert!(lo <= mean && mean <= hi);
    // the reported best is the best run's design
    let k = st.get("best_run", 0.0) as usize;
    assert_eq!(v[k - 1], lo);
    assert_eq!(r.at("best").get("npc", 0.0), lo);
    // the first run is the single run of the same seed
    let one = run(&p, &format!(r#"{{"algorithm":"pso",{META}}}"#));
    assert_eq!(one.at("best").get("npc", 0.0), v[0]);
    // reproducible, whatever the number of threads
    assert_eq!(run(&p, &block).dump(), r.dump());
    assert_eq!(run(&p, &format!(r#"{{"algorithm":"pso",{META},"repeat_runs":4,"threads":1}}"#)).dump(), r.dump());

    // the hybrid reports its larger budget per run: n + iterations x (2 n + 1)
    let h = run(&p, &format!(r#"{{"algorithm":"hshoa",{META},"repeat_runs":2}}"#));
    assert!(h.at("runs").at("rows").arr().iter().all(|x| x.get("evaluations", 0.0) == 6.0 + 5.0 * 13.0));

    // MOPSO: the hypervolume of each run's front, higher is better, and the front of the best run is reported
    let m = run(&p, &format!(r#"{{"algorithm":"mopso",{META},"repeat_runs":3}}"#));
    let st = m.at("runs");
    assert_eq!((st.at("metric").str(), st.getb("higher_is_better", false)), ("hypervolume", true));
    let hv: Vec<f64> = st.at("rows").arr().iter().map(|x| x.get("value", f64::NAN)).collect();
    assert!(hv.iter().all(|x| (0.0..=1.0).contains(x)));
    assert!(st.get("best", 0.0) >= st.get("mean", 0.0) && st.get("mean", 0.0) >= st.get("worst", 0.0));
    let k = st.get("best_run", 0.0) as usize;
    assert_eq!(st.at("rows").idx(k - 1).get("front", 0.0), m.at("pareto").len() as f64);
}

#[test]
fn spacing_and_hypervolume_by_hand() {
    // an evenly spread front has spacing 0
    assert_eq!(spacing(&[(0.0, 4.0), (1.0, 3.0), (2.0, 2.0), (3.0, 1.0), (4.0, 0.0)]), Some(0.0));
    // nearest distances 2, 2 and 4: mean 8/3, sample deviation sqrt((4/9 + 4/9 + 16/9) / 2) = sqrt(4/3)
    let s = spacing(&[(0.0, 3.0), (1.0, 2.0), (3.0, 0.0)]).unwrap();
    assert!((s - (4.0f64 / 3.0).sqrt()).abs() < 1e-12, "{s}");
    assert_eq!(spacing(&[(1.0, 1.0)]), None);
    // two points against (2, 2): [0, 2] x [1, 2] and [1, 2] x [0, 1]
    assert_eq!(hypervolume(&[(0.0, 1.0), (1.0, 0.0)], (2.0, 2.0)), 3.0);
    // a dominated point and one beyond the reference add nothing
    assert_eq!(hypervolume(&[(0.0, 1.0), (1.0, 0.0), (1.5, 1.5), (3.0, -1.0)], (2.0, 2.0)), 3.0);
}

#[test]
fn the_lpsp_table_and_the_other_objectives() {
    let p = small();
    let mo = r#""algorithm":"mopso","pv_max":3000,"bess_max":12000,"particles":10,"iterations":8,"size_gensets":true,"gen_units_min":0,"gen_units_max":4,"pareto_stats":true"#;
    let r = run(&p, &format!(r#"{{{mo},"mo_second":"lpsp","max_unmet":0.15}}"#));
    let front = r.at("pareto").arr();
    assert!(front.len() > 2);
    // the front runs from cheap designs with unmet load to dearer ones without, listed by LPSP
    assert!(front.windows(2).all(|w| w[0].get("unmet", 0.0) <= w[1].get("unmet", 0.0)));
    assert!(front.iter().all(|c| c.has("co2_t")));
    let table = r.at("lpsp_table").arr();
    assert_eq!(table.iter().map(|t| t.get("target", -1.0)).collect::<Vec<_>>(), [0.0, 0.01, 0.02, 0.05, 0.10]);
    let mut met = 0;
    for t in table {
        let target = t.get("target", 0.0);
        let cheapest = front.iter().filter(|c| c.get("unmet", 1.0) <= target + 1e-9).map(|c| c.get("npc", 0.0)).fold(f64::INFINITY, f64::min);
        if cheapest.is_finite() {
            met += 1;
            assert_eq!(t.at("best").get("npc", 0.0), cheapest, "target {target}");
            assert!(t.at("best").get("unmet", 1.0) <= target + 1e-9 && t.at("best").has("fuel") && t.at("best").has("co2_t"));
        } else {
            assert!(t.at("best").is_null());
        }
    }
    assert!(met >= 2, "{}", r.at("lpsp_table").dump());
    // a looser target never costs more
    let npc: Vec<f64> = table.iter().filter(|t| !t.at("best").is_null()).map(|t| t.at("best").get("npc", 0.0)).collect();
    assert!(npc.windows(2).all(|w| w[1] <= w[0]));
    let q = r.at("pareto_quality");
    assert_eq!(q.get("points", 0.0), front.len() as f64);
    assert!(q.get("spacing", -1.0) >= 0.0 && (0.0..=1.0).contains(&q.get("hypervolume", -1.0)));
    assert!(q.get("ref_cost", 0.0) > front.iter().map(|c| c.get("npc", 0.0)).fold(0.0, f64::max));

    // CO2 as the second objective, at the default unmet-load limit: less CO2 costs more along the front
    let r = run(&p, &format!(r#"{{{mo},"mo_second":"co2"}}"#));
    let front = r.at("pareto").arr();
    assert!(front.len() > 1 && front.windows(2).all(|w| w[0].get("co2_t", 0.0) <= w[1].get("co2_t", 0.0) && w[0].get("npc", 0.0) >= w[1].get("npc", 0.0)));

    // the fuzzy choice: the largest sum of memberships, each 1 at the objective's best on the front and 0 at its worst
    let r = run(&p, &format!(r#"{{{mo},"mo_second":"lpsp","max_unmet":0.15,"mo_pick":"fuzzy"}}"#));
    let front = r.at("pareto").arr();
    let f: Vec<(f64, f64)> = front.iter().map(|c| (c.get("npc", 0.0), c.get("unmet", 0.0))).collect();
    let (lo, hi) = f.iter().fold(((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY)),
        |a, p| ((a.0 .0.min(p.0), a.0 .1.min(p.1)), (a.1 .0.max(p.0), a.1 .1.max(p.1))));
    let mu = |p: &(f64, f64)| (hi.0 - p.0) / (hi.0 - lo.0) + (hi.1 - p.1) / (hi.1 - lo.1);
    let best = f.iter().map(mu).fold(f64::NEG_INFINITY, f64::max);
    let b = r.at("best");
    assert!((mu(&(b.get("npc", 0.0), b.get("unmet", 0.0))) - best).abs() < 1e-12);
    assert_eq!(r.at("settings").at("mo_pick").str(), "fuzzy");
}
