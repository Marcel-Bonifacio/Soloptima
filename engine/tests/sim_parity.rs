//! The dispatch against the C++ engine: tests/gen_sim_fixtures.cpp ran `simulate` on the example project for the cases in
//! engine/tests/fixtures/sim.json (a patch on the project, a sizing, perfect forecasts) and kept the C++ PV and wind
//! profiles, the hash of each result as JSON and its figures, and the hash of the project finance on two of them. The Rust
//! results must match to the byte.
use soloptima_engine::finance::{parse_finance, run_finance};
use soloptima_engine::sim::{compare, comparison_to_json, result_to_json, simulate, PerfectForecast, SimInput, Sizing};
use soloptima_engine::{parse_project, Value};
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

/// Paths of the numbers that differ between two documents (for a readable failure)
fn diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Obj(x), Value::Obj(y)) => for (k, v) in x { diff(&format!("{path}.{k}"), v, y.get(k).unwrap_or(&Value::Null), out); },
        (Value::Arr(x), Value::Arr(y)) => for (i, v) in x.iter().enumerate() { diff(&format!("{path}[{i}]"), v, y.get(i).unwrap_or(&Value::Null), out); },
        _ => if a != b { out.push(format!("{path}: rust {} c++ {}", a.dump(), b.dump())); },
    }
}

#[test]
fn simulate_matches_cpp() {
    let fx = Value::parse(&read("tests/fixtures/sim.json")).unwrap();
    let example = read("../web/examples/example_study.json");
    let base_patch = Value::parse(r#"{"ems":{"pv_forecast":"perfect","load_forecast":"perfect"}}"#).unwrap();
    let pvs: Vec<Vec<f64>> = fx.at("pv_profiles").arr().iter().map(|v| v.arr().iter().map(|x| x.num(0.0)).collect()).collect();
    let winds: Vec<Vec<f64>> = fx.at("wind_profiles").arr().iter().map(|v| v.arr().iter().map(|x| x.num(0.0)).collect()).collect();
    let mut results = Vec::new();
    let mut failed = Vec::new();
    for c in fx.at("cases").arr() {
        let name = c.at("name").str();
        let mut doc = Value::parse(&example).unwrap();
        merge(&mut doc, &base_patch);
        merge(&mut doc, c.at("patch"));
        let p = parse_project(&doc);
        let z = c.getv("sizing");
        let s = Sizing { pv_kwp: z[0], bess_kwh: z[1], bess_kw: z[2], wind_units: z[3] };
        let pv = &pvs[c.get("pv", 0.0) as usize];
        let wind: &[f64] = if c.at("wind").is_null() { &[] } else { &winds[c.get("wind", 0.0) as usize] };
        let fc = PerfectForecast::new(pv, &p.load_kw, wind);
        let inp = SimInput { pv_per_kwp: pv, wind_per_turbine: wind, forecast: Some(&fc) };
        let r = simulate(&p, &inp, &s, c.getb("hourly", false)).unwrap();
        let h = fnv(&result_to_json(&r, true).dump());
        if h != c.at("hash").str() {
            let mut res = result_to_json(&r, false);
            let ys = res.at("years").arr().to_vec();
            res.set("years", vec![ys[0].clone(), ys[ys.len() - 1].clone()]);
            let mut d = Vec::new();
            diff("", &res, c.at("result"), &mut d);
            failed.push(format!("{name}: hash {h}, {} figures differ; first: {:?}", d.len(), &d[..d.len().min(6)]));
        }
        results.push(r);
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
    assert_eq!(comparison_to_json(&compare(&results[0], &results[1])).dump(), fx.at("compare_base").dump());
    assert_eq!(comparison_to_json(&compare(&results[0], &results[2])).dump(), fx.at("compare_pv_only").dump());

    // The project finance on the simulated hybrid and baseline, through SimResult::fin_sim
    let mut doc = Value::parse(&example).unwrap();
    merge(&mut doc, &base_patch);
    let p = parse_project(&doc);
    let fin = run_finance(&p, &parse_finance(fx.at("finance")), &results[0].fin_sim(), &results[1].fin_sim(), 0.0);
    assert_eq!(fnv(&fin.dump()), fx.at("finance_hash").str());
}
