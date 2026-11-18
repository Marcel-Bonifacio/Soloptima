//! The results check (engine/src/sim/checks.rs) stays quiet on sound projects: the example project and the cases of the
//! simulation fixtures, run through the app's simulate route.
use soloptima_engine::api::run_simulation;
use soloptima_engine::{parse_project, Value};
use std::path::PathBuf;

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

/// The failed checks of the example with a patch and sizes (PV kWp, BESS kWh, BESS kW, wind turbines)
fn checks(patch: &Value, size: &[f64]) -> Vec<String> {
    let mut doc = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    merge(&mut doc, &Value::parse(r#"{"ems":{"pv_forecast":"perfect","load_forecast":"perfect"}}"#).unwrap());
    merge(&mut doc, patch);
    if !size.is_empty() {
        let mut s = Value::object();
        s.set("pv", Value::parse(&format!(r#"{{"capacity_kwp":{}}}"#, size[0])).unwrap());
        s.set("bess", Value::parse(&format!(r#"{{"energy_kwh":{},"power_kw":{}}}"#, size[1], size[2])).unwrap());
        s.set("wind", Value::parse(&format!(r#"{{"units":{}}}"#, size[3])).unwrap());
        merge(&mut doc, &s);
    }
    let out = run_simulation(&parse_project(&doc), &doc).unwrap();
    out.at("result").at("summary").at("checks").arr().iter().map(|c| c.dump()).collect()
}

#[test]
fn the_example_raises_nothing() {
    let c = checks(&Value::object(), &[]);
    assert!(c.is_empty(), "{c:?}");
}

/// Every case of the simulation fixtures; the predictive ones only in a release build (a few seconds each there)
fn fixture_cases(predictive: bool) {
    let fx = Value::parse(&read("tests/fixtures/sim.json")).unwrap();
    let mut failed = Vec::new();
    for c in fx.at("cases").arr() {
        if c.at("patch").at("diesel").at("strategy").str() == "predictive" && !predictive { continue; }
        let r = checks(c.at("patch"), &c.getv("sizing"));
        if !r.is_empty() { failed.push(format!("{}: {r:?}", c.at("name").str())); }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn the_fixture_cases_raise_nothing() { fixture_cases(cfg!(not(debug_assertions))); }
