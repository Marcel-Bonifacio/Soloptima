//! Sections 6 and 8 of tests/test_engine.cpp on the example project in fast mode (one simulated year): the optimiser finds a
//! feasible optimum no dearer than diesel only, a longer battery life cannot make the best design dearer, a life scale of 0
//! is refused, and the metaheuristics come close to the grid optimum.
use soloptima_engine::optimizer::{optimize, parse_opt_settings, Progress};
use soloptima_engine::{parse_project, Project, Value};
use std::path::PathBuf;

fn example_fast() -> Project {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json");
    let mut p = parse_project(&Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap());
    p.sim.all_years = false;
    p
}

fn run(p: &Project, block: &str) -> Value {
    let o = parse_opt_settings(&Value::parse(block).unwrap(), p).unwrap();
    optimize(p, &o, &Progress::default()).unwrap()
}

fn npc(v: &Value) -> f64 { v.at("best").get("npc", f64::NAN) }

#[test]
fn optimum_and_battery_life_sensitivity() {
    let q = example_fast();
    let res = run(&q, r#"{"pv_max":120000,"pv_steps":6,"bess_max":120000,"bess_steps":5}"#);
    assert!(!res.at("best").is_null(), "optimiser found nothing");
    assert!(npc(&res) <= res.at("baseline").at("econ").get("npc", 0.0) + 1.0, "optimum worse than diesel only");
    // re-optimising sensitivity: a battery that lasts twice as long cannot make the best design dearer
    let sr = run(&q, r#"{"pv_max":120000,"pv_steps":3,"bess_max":120000,"bess_steps":3,"refine":false,"sens_var":"bess_life_scale","sens_values":[0.5,2]}"#);
    let rows = sr.at("sensitivity").at("rows").arr();
    assert!(rows.len() == 2 && !rows[0].at("best").is_null() && !rows[1].at("best").is_null(), "battery life sensitivity: {} rows", rows.len());
    assert!(npc(&rows[1]) <= npc(&rows[0]), "best NPC {} at life x2 above {} at life x0.5", npc(&rows[1]), npc(&rows[0]));
    let refused = parse_opt_settings(&Value::parse(r#"{"sens_var":"bess_life_scale","sens_values":[0]}"#).unwrap(), &q);
    assert!(refused.is_err(), "a battery life scale of 0 was accepted");
}

#[test]
fn metaheuristics_reach_the_grid_optimum() {
    let q = example_fast();
    let block = |alg: &str| format!(r#"{{"pv_max":150000,"pv_steps":9,"bess_max":150000,"bess_steps":7,"particles":16,"iterations":25,"algorithm":"{alg}"}}"#);
    let g = npc(&run(&q, &block("grid")));
    for alg in ["pso", "hshoa", "mopso"] {
        let r = run(&q, &block(alg));
        assert!(!r.at("best").is_null(), "{alg} found nothing");
        if alg != "mopso" {
            assert!(npc(&r) <= g * 1.01, "{alg} NPC {} vs grid {g}", npc(&r));
        } else {
            assert!(!r.at("pareto").is_empty() && npc(&r) <= g * 1.05, "MOPSO archive empty or far from the grid optimum");
        }
    }
}
