//! The optimiser against the C++ engine: tests/gen_opt_fixtures.cpp ran parse_opt_settings on optimizer blocks, optimize on
//! the example project (grid with pattern search, PSO, MOPSO, SHO-QAO-GOA, constraints, C-rate and wind ranges, predictive
//! EMS, sensitivity) and run_batch with override paths, and kept the hash of each answer as JSON. The Rust answers must
//! match to the byte (and to the message), with any number of threads.
use soloptima_engine::optimizer::{optimize, parse_opt_settings, run_batch, OptSettings, Progress};
use soloptima_engine::{parse_project, validate_project, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering::Relaxed;

fn fnv(s: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    format!("{h:016x}")
}

fn read(rel: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn merge(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Obj(d), Value::Obj(s)) => for (k, v) in s { merge(d.entry(k.clone()).or_insert(Value::Null), v); },
        (d, s) => *d = s.clone(),
    }
}

fn doc(patch: &Value) -> Value {
    let mut d = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    merge(&mut d, patch);
    d
}

fn fx() -> Value { Value::parse(&read("tests/fixtures/opt.json")).unwrap() }

fn settings_json(o: &OptSettings) -> Value {
    let fin = |x: f64| if x.is_finite() { Value::Num(x) } else { Value::Null };
    let mut v = Value::object();
    v.set("pv_min", o.pv_min); v.set("pv_max", o.pv_max); v.set("pv_steps", o.pv_steps); v.set("bess_min", o.bess_min);
    v.set("bess_max", o.bess_max); v.set("bess_steps", o.bess_steps); v.set("c_rates", o.c_rates.clone());
    v.set("objective", o.objective.as_str()); v.set("max_unmet", o.max_unmet); v.set("max_lole_h", o.max_lole_h);
    v.set("max_reserve_short_h", o.max_reserve_short_h); v.set("min_re", o.min_re); v.set("max_curtail", o.max_curtail);
    v.set("max_pv_kwp", fin(o.max_pv_kwp)); v.set("max_capex", fin(o.max_capex)); v.set("refine", o.refine);
    v.set("threads", o.threads); v.set("sens_var", o.sens_var.as_str()); v.set("sens_values", o.sens_values.clone());
    v.set("algorithm", o.algorithm.as_str()); v.set("particles", o.particles); v.set("iterations", o.iterations);
    v.set("seed", o.seed); v.set("wind_min", o.wind_min); v.set("wind_max", o.wind_max); v.set("mo_second", o.mo_second.as_str());
    v
}

#[test]
fn settings_match_cpp() {
    let fx = fx();
    let p = parse_project(&doc(&Value::object()));
    for c in fx.at("parse").arr() {
        let got = parse_opt_settings(c.at("block"), &p);
        match got {
            Ok(o) => assert_eq!(settings_json(&o).dump(), c.at("settings").dump(), "{}", c.at("block").dump()),
            Err(e) => assert_eq!(e.0, c.at("error").str(), "{}", c.at("block").dump()),
        }
    }
}

/// Runs the fixture cases whose name passes `pick`; threads overrides the block's thread count (None: keep it)
fn run_cases(pick: impl Fn(&str) -> bool, threads: Option<f64>) {
    let fx = fx();
    let mut failed = Vec::new();
    for c in fx.at("cases").arr() {
        let name = c.at("name").str();
        if !pick(name) { continue; }
        let p = parse_project(&doc(c.at("patch")));
        validate_project(&p).unwrap();
        let mut block = c.at("optimizer").clone();
        if let Some(t) = threads { block.set("threads", t); }
        let o = parse_opt_settings(&block, &p).unwrap();
        let prog = Progress::default();
        let r = optimize(&p, &o, &prog).unwrap();
        let h = fnv(&r.dump());
        if h != c.at("hash").str() {
            failed.push(format!("{name}: hash {h}\n  best rust {}\n  best c++  {}\n  n_evaluated {} / {}, history rust {} c++ {}",
                r.at("best").dump(), c.at("best").dump(), r.at("n_evaluated").dump(), c.at("n_evaluated").dump(),
                r.at("history").dump(), c.at("history").dump()));
        }
        assert_eq!(prog.done.load(Relaxed) as f64, c.get("done", 0.0), "{name}: progress");
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn grid_matches_cpp() { run_cases(|n| n.starts_with("grid"), None); }

#[test]
fn metaheuristics_match_cpp() { run_cases(|n| !n.starts_with("grid"), None); }

/// The result does not depend on the number of threads
#[test]
fn single_thread_matches_cpp() { run_cases(|n| n == "grid c-rates refine" || n == "hshoa" || n == "mopso re", Some(1.0)); }

#[test]
fn batch_matches_cpp() {
    let fx = fx();
    let b = fx.at("batch");
    let r = run_batch(&doc(b.at("patch")), b.at("cases").arr()).unwrap();
    let brief: Vec<Value> = r.at("results").arr().iter()
        .map(|x| if x.at("error").is_string() { x.at("error").clone() } else { x.at("result").at("econ").at("npc").clone() }).collect();
    assert_eq!(Value::Arr(brief).dump(), b.at("brief").dump());
    assert_eq!(fnv(&r.dump()), b.at("hash").str());
    let many = vec![Value::object(); 20001];
    assert_eq!(run_batch(&doc(b.at("patch")), &many).unwrap_err().0, "Batch limited to 20000 cases.");
}

/// A run cancelled before it starts simulates only the baseline and says so
#[test]
fn cancel_stops_the_search() {
    let p = parse_project(&doc(&Value::parse(r#"{"sim":{"all_years":false}}"#).unwrap()));
    for alg in ["grid", "pso"] {
        let block = Value::parse(&format!(r#"{{"algorithm":"{alg}","pv_max":40000,"pv_steps":3,"bess_max":20000,"bess_steps":3,"particles":4,"iterations":3}}"#)).unwrap();
        let o = parse_opt_settings(&block, &p).unwrap();
        let prog = Progress::default();
        prog.cancel.store(true, Relaxed);
        let r = optimize(&p, &o, &prog).unwrap();
        assert!(r.at("cancelled").boolean(false), "{alg}");
        assert!(r.at("grid").is_empty() && r.at("best").is_null() && r.at("history").is_empty(), "{alg}: {}", r.at("best").dump());
        assert_eq!(prog.done.load(Relaxed), prog.total.load(Relaxed));
    }
}
