//! The forecasting methods against the C++ engine: tests/gen_forecast_fixtures.cpp ran every PV and load method (and the wind
//! forecaster) on the example project and kept the hash of the forecasts at leads 0-47 h for every hour plus 48 samples
//! (engine/tests/fixtures/forecast.json), and the predictive dispatch on the project's own forecasters. All must match to
//! the byte, including the random parts (noisy, MLP), which follow libc++'s random number algorithms.
use soloptima_engine::forecast::{load_forecast_methods, pv_forecast_methods, SeriesForecaster};
use soloptima_engine::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use soloptima_engine::sim::{result_to_json, simulate, SimInput, Sizing};
use soloptima_engine::{parse_project, Value, HOURS};
use std::path::PathBuf;
#[path = "common/bless.rs"]
mod bless;

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

fn project(patches: &[&Value]) -> soloptima_engine::Project {
    let mut doc = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    for p in patches { merge(&mut doc, p); }
    parse_project(&doc)
}

/// The mismatch of one forecaster against its fixture entry, if any
fn check(name: &str, f: &SeriesForecaster, fx: &Value, path: &str, upd: &mut Vec<(String, Value)>) -> Option<String> {
    let mut all = Vec::with_capacity(7 * HOURS);
    for lead in [0, 1, 3, 6, 24, 36, 47] { for t in 0..HOURS as i32 { all.push(f.at(t - lead, t)); } }
    let h = fnv(&Value::from(all).dump());
    if h == fx.at("hash").str() { return None; }
    let s: Vec<f64> = (0..48).map(|k| f.at(4000, 4000 + k)).collect();
    let want = fx.getv("samples");
    if bless::on() { upd.push((format!("{path}/hash"), h.into())); upd.push((format!("{path}/samples"), s.into())); return None; }
    let k = (0..48).find(|&k| s[k] != want[k]);
    Some(format!("{name}: hash {h}; first differing sample {k:?}: rust {:?} c++ {:?}", k.map(|k| s[k]), k.map(|k| want[k])))
}

#[test]
fn forecasters_match_cpp() {
    let fx = Value::parse(&read("tests/fixtures/forecast.json")).unwrap();
    let p = project(&[]);
    let (pv, cs) = (compute_pv_profile(&p).unwrap().ac_per_kwp, clearsky_pv_per_kwp(&p).unwrap());
    let (mut bad, mut upd) = (Vec::new(), Vec::new());
    for m in pv_forecast_methods() { bad.extend(check(&format!("pv {}", m.id), &SeriesForecaster::new(m.id, &pv, &cs, 0.15, 12345), fx.at("pv").at(m.id), &format!("pv/{}", m.id), &mut upd)); }
    for m in load_forecast_methods() { bad.extend(check(&format!("load {}", m.id), &SeriesForecaster::new(m.id, &p.load_kw, &[], 0.2, 67890), fx.at("load").at(m.id), &format!("load/{}", m.id), &mut upd)); }
    bad.extend(check("unknown pv method", &SeriesForecaster::new("nonsense", &pv, &cs, 0.15, 1), fx.at("unknown_pv"), "unknown_pv", &mut upd));
    let pw = project(&[&Value::parse(r#"{"wind":{"units":3,"rated_kw":2000}}"#).unwrap()]);
    bad.extend(check("wind ets", &SeriesForecaster::new("ets", &wind_per_turbine(&pw).unwrap(), &[], 0.15, 24680), fx.at("wind_ets"), "wind_ets", &mut upd));
    bless::write("tests/fixtures/forecast.json", upd);
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn predictive_dispatch_matches_cpp() {
    let fx = Value::parse(&read("tests/fixtures/forecast.json")).unwrap();
    let base = Value::parse(r#"{"diesel":{"strategy":"predictive"},"sim":{"all_years":false}}"#).unwrap();
    let (mut bad, mut upd) = (Vec::new(), Vec::new());
    for (i, c) in fx.at("sims").arr().iter().enumerate() {
        let q = project(&[&base, c.at("patch")]);
        let (pv, cs) = (compute_pv_profile(&q).unwrap().ac_per_kwp, clearsky_pv_per_kwp(&q).unwrap());
        let wind = if q.wind.units > 0 { wind_per_turbine(&q).unwrap() } else { vec![] };
        let s = Sizing { pv_kwp: 30000.0, bess_kwh: 6600.0, bess_kw: 2320.0, wind_units: f64::from(q.wind.units) };
        let inp = SimInput { pv_per_kwp: &pv, pv_clip_per_kwp: &[], pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
        let r = simulate(&q, &inp, &s, true).unwrap();
        let h = fnv(&result_to_json(&r, true).dump());
        if h != c.at("hash").str() && bless::on() {
            upd.extend([(format!("sims/{i}/hash"), h.into()), (format!("sims/{i}/fuel_l_y1"), r.fuel_l_y1.into()),
                        (format!("sims/{i}/forecast"), result_to_json(&r, false).at("forecast").clone())]);
        } else if h != c.at("hash").str() {
            bad.push(format!("{}: hash {h}, fuel {} vs {}, forecast {} vs {}", c.at("name").str(), r.fuel_l_y1, c.get("fuel_l_y1", 0.0),
                             result_to_json(&r, false).at("forecast").dump(), c.at("forecast").dump()));
        }
    }
    bless::write("tests/fixtures/forecast.json", upd);
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}
