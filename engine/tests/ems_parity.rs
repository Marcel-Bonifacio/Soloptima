//! The day-ahead schedule and the Forecast Lab against the C++ engine: tests/gen_ems_fixtures.cpp ran day_ahead_schedule (after
//! the checks of its route) and forecast_benchmark on the example project for the cases in engine/tests/fixtures/ems.json (a
//! patch on the project, the forecast document and the arguments) and kept the hash of each answer as JSON, or the error
//! message, and a readable part of the answer. The Rust answers must match to the byte and to the message.
use soloptima_engine::ems::{day_ahead_schedule, forecast_benchmark};
use soloptima_engine::sim::Sizing;
use soloptima_engine::{parse_project, Project, Value};
use std::path::PathBuf;

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

/// Paths of the values that differ between two documents (for a readable failure)
fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Obj(x), Value::Obj(y)) => for (k, v) in x { diff(&format!("{path}.{k}"), v, y.get(k).unwrap_or(&Value::Null), out); },
        (Value::Arr(x), Value::Arr(y)) => for (i, v) in x.iter().enumerate() { diff(&format!("{path}[{i}]"), v, y.get(i).unwrap_or(&Value::Null), out); },
        _ => if a != b { out.push(format!("{path}: rust {} c++ {}", a.dump(), b.dump())); },
    }
}

fn fixture() -> (Value, String) { (Value::parse(&read("tests/fixtures/ems.json")).unwrap(), read("../web/examples/example_study.json")) }

fn project(example: &str, patch: &Value) -> Project {
    let mut doc = Value::parse(example).unwrap();
    merge(&mut doc, patch);
    parse_project(&doc)
}

#[test]
fn day_ahead_schedule_matches_cpp() {
    let (fx, example) = fixture();
    let mut failed = Vec::new();
    let cases = fx.at("schedules").arr();
    assert!(cases.len() >= 20, "fixture has {} schedule cases", cases.len());
    for c in cases {
        let name = c.at("name").str();
        let p = project(&example, c.at("patch"));
        // the route plans with the project's own sizing
        let s = Sizing { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, wind_units: f64::from(p.wind.units) };
        let r = day_ahead_schedule(&p, &s, c.at("forecast"), c.get("soc_now", 0.5), c.get("load_scale", 1.0), c.at("now_utc").str(),
                                   c.get("max_hours", 0.0) as i32);
        match (r, c.has("error")) {
            (Ok(v), false) => {
                let h = fnv(&v.dump());
                if h != c.at("hash").str() {
                    let rows = v.at("rows").arr();
                    let mut res = v.clone();
                    res.set("rows", vec![rows[0].clone(), rows[rows.len() - 1].clone()]);
                    res.set("n_rows", rows.len());
                    let mut d = Vec::new();
                    diff("", &res, c.at("result"), &mut d);
                    failed.push(format!("{name}: hash {h}, {} values differ; first: {:?}", d.len(), &d[..d.len().min(6)]));
                }
            }
            (Err(e), true) => if e.0 != c.at("error").str() { failed.push(format!("{name}: error {:?}, C++ {:?}", e.0, c.at("error").str())); },
            (Ok(_), true) => failed.push(format!("{name}: no error, C++ {:?}", c.at("error").str())),
            (Err(e), false) => failed.push(format!("{name}: error {:?}, C++ none", e.0)),
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

fn benchmark_case(name: &str) {
    let (fx, example) = fixture();
    let c = fx.at("benchmarks").arr().iter().find(|c| c.at("name").str() == name).unwrap_or_else(|| panic!("no case {name}"));
    let p = project(&example, c.at("patch"));
    soloptima_engine::validate_project(&p).unwrap();
    let r = forecast_benchmark(&p, c.getb("with_value", false)).unwrap();
    let h = fnv(&r.dump());
    if h == c.at("hash").str() { return; }
    // the readable part, as the generator keeps it
    let mut sum = Value::object();
    for k in ["pv", "load"] {
        for m in r.at(k).at("methods").arr() {
            let at = |f: &str, l: usize| m.at(f).idx(l).clone();
            sum.set(&format!("{k}.{}", m.at("id").str()), vec![at("nmae", 0), at("nmae", 23), at("skill", 23)]);
        }
    }
    let mut d = Vec::new();
    diff("summary", &sum, c.at("summary"), &mut d);
    if c.getb("with_value", false) { diff("value", r.at("value"), c.at("value"), &mut d); }
    panic!("{name}: hash {h}, C++ {}; {} values differ; first: {:?}", c.at("hash").str(), d.len(), &d[..d.len().min(8)]);
}

#[test]
fn forecast_benchmark_matches_cpp() { benchmark_case("example"); }

// The value runs simulate year 1 with the predictive EMS 22 times per case: about 20 s each in a debug build, 1 s in release.
#[test]
#[cfg_attr(debug_assertions, ignore)]
fn forecast_benchmark_value_matches_cpp() { benchmark_case("example with value"); }

#[test]
#[cfg_attr(debug_assertions, ignore)]
fn forecast_benchmark_value_with_wind_matches_cpp() { benchmark_case("wind and noise with value"); }
