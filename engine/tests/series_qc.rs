//! Data checks against the C++ engine: tests/gen_qc_fixtures.cpp ran `data_qc` on the projects below (the data-check cases of
//! tests/test_engine.cpp and some with defects) and wrote its answers (engine/tests/fixtures/qc.json).
use soloptima_engine::solar::clearsky_ghi;
use soloptima_engine::{data_qc, Project, Value, HOURS};
use std::path::PathBuf;

fn make_project(lat: f64, lon: f64) -> Project {
    let mut p = Project::default();
    p.loc.lat = lat;
    p.loc.lon = lon;
    p.loc.utc_offset = (lon / 15.0).round();
    p.wx.is_utc = true;
    p.wx.time_offset = 0.5;
    p.wx.ghi = clearsky_ghi(&p);
    for i in 0..HOURS { p.wx.ghi[i] *= 0.6 + 0.35 * (((i / 24) as f64) * 1.7).sin(); }
    p.wx.tamb = vec![27.0; HOURS];
    p.wx.wind = vec![1.5; HOURS];
    p.load_kw = (0..HOURS).map(|i| 1000.0 + 200.0 * (((i % 24) as f64) / 24.0 * 6.283).sin()).collect();
    p.dg.unit_kw = 400.0;
    p.dg.units = 5;
    p
}
fn clear_project(lat: f64, lon: f64) -> Project { let mut t = make_project(lat, lon); t.wx.ghi = clearsky_ghi(&t); t }
fn step_load() -> Project {
    let mut l = make_project(-2.5, 115.5);
    for i in 0..HOURS {
        let x = i as f64;
        l.load_kw[i] *= (1.0 + 0.02 * (x * 0.7).sin() * (x * 0.13).sin()) * if i >= 200 * 24 { 1.2 } else { 1.0 };
    }
    l
}

fn scenarios() -> Vec<(&'static str, &'static str, Project)> {
    let mut cs = Vec::new();
    let t = clear_project(-2.5, 115.5);
    cs.push(("on time", "weather", t.clone()));
    let mut late = t.clone();
    for i in 0..HOURS { late.wx.ghi[i] = t.wx.ghi[(i + HOURS - 1) % HOURS]; }
    let mut local = t.clone();
    local.wx.is_utc = false;
    cs.push(("one hour late", "weather", late));
    cs.push(("utc as local", "weather", local));
    let mut n = t.clone();
    let off = t.loc.utc_offset as i64;
    n.wx.ghi[(100 * 24 - off) as usize] = 50.0;
    for h in 9..15 { n.wx.ghi[(150 * 24 + h - off) as usize] = 500.0; }
    cs.push(("night and flat", "weather", n));
    cs.push(("load step", "load", step_load()));
    let mut w = step_load();
    for x in &mut w.load_kw { *x *= 1000.0; }
    cs.push(("load in watts", "", w));
    let mut k = step_load();
    for x in &mut k.load_kw { *x *= 0.1; }
    cs.push(("load tiny", "load", k));
    let mut d = clear_project(-2.5, 115.5);
    d.wx.dhi = (0..HOURS).map(|i| 0.3 * d.wx.ghi[i]).collect();
    d.wx.dni = (0..HOURS).map(|i| 0.7 * d.wx.ghi[i] * if i % 7 == 0 { 1.6 } else { 1.0 }).collect();
    d.wx.dhi[1000] = d.wx.ghi[1000] * 2.0 + 80.0;
    d.wx.ghi[3000] = 5000.0;
    for i in 0..HOURS { d.wx.tamb[i] = 27.0 + 5.0 * (((i % 24) as f64) / 24.0 * 6.283).sin() + 0.01 * (i % 13) as f64; }
    d.wx.tamb[500] = 80.0;
    d.wx.tamb[600] = d.wx.tamb[599] + 15.0;
    for i in 1000..1007 { d.wx.tamb[i] = 30.0; }
    for dd in 50..53 { d.wx.tamb[dd * 24 + 10] = 31.5; }
    for i in 0..HOURS { d.wx.wind[i] = 3.0 + 2.0 * (i as f64 * 0.3).sin(); }
    d.wx.wind[700] = -1.0;
    d.wx.wind[800] = 50.0;
    for i in 2000..2008 { d.wx.wind[i] = 4.0; }
    for i in 4000..4010 { d.wx.ghi[i] = d.wx.ghi[4000]; }
    cs.push(("weather defects", "weather", d));
    let mut e = step_load();
    for i in 100..104 { e.load_kw[i] = 0.0; }
    for i in 300..310 { e.load_kw[i] = 1234.0; }
    for i in 500..510 { e.load_kw[i] = 900.0 + 7.5 * (i - 500) as f64; }
    e.load_kw[2000] = 5000.0;
    cs.push(("load defects", "load", e));
    let mut nd = t.clone();
    nd.wx.ghi.clear();
    nd.load_kw.clear();
    cs.push(("no data", "", nd));
    let mut np = clear_project(27.7, 85.3);
    np.loc.utc_offset = 5.75;
    cs.push(("nepal utc+5:45", "weather", np));
    cs.push(("switzerland", "weather", clear_project(47.0, 8.0)));
    let mut sy = clear_project(-33.9, 151.2);
    sy.wx.is_utc = false;
    sy.loc.utc_offset = 10.0;
    cs.push(("sydney local", "weather", sy));
    let mut bad = t.clone();
    bad.loc.lat = 95.0;
    cs.push(("bad latitude", "", bad));
    let mut bo = t.clone();
    bo.loc.utc_offset = 15.0;
    cs.push(("bad offset", "", bo));
    let mut bt = t;
    bt.wx.time_offset = 30.0;
    cs.push(("bad time offset", "", bt));
    cs
}

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/qc.json");
    Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn answer(p: &Project, only: &str) -> String {
    match data_qc(p, only) { Ok(v) => format!("OK {}", v.dump()), Err(e) => format!("ERR {e}") }
}

#[test]
fn every_scenario_gives_what_the_cpp_checks_give() {
    let want = fixture();
    let cs = scenarios();
    assert_eq!(cs.len(), want.len());
    for ((name, only, p), w) in cs.iter().zip(want.arr()) {
        assert_eq!(*name, w.at("name").str());
        let got = answer(p, only);
        let at = got.bytes().zip(w.at("result").str().bytes()).take_while(|(a, b)| a == b).count();
        let ctx = |s: &str| s[at.saturating_sub(60)..(at + 60).min(s.len())].to_string();
        assert!(got == w.at("result").str(), "{name}: first difference at byte {at}\n rust: {}\n c++:  {}", ctx(&got), ctx(w.at("result").str()));
    }
}

fn weather(p: &Project) -> Value { data_qc(p, "weather").unwrap().at("weather").clone() }
fn flag_hours(qc: &Value, id: &str) -> f64 {
    qc.at("flags").arr().iter().find(|f| f.at("id").str() == id).map_or(-1.0, |f| f.get("hours", 0.0))
}

// the checks of tests/test_engine.cpp
#[test]
fn timing_against_the_sun() {
    let cs = scenarios();
    let by = |n: &str| cs.iter().find(|c| c.0 == n).unwrap().2.clone();
    let (t0, t1, tl) = (weather(&by("on time")).at("timing").clone(), weather(&by("one hour late")).at("timing").clone(), weather(&by("utc as local")).at("timing").clone());
    assert!(t0.get("median_min", 99.0).abs() < 5.0 && t0.gets("verdict", "") == "ok" && t0.get("n_days", 0.0) >= 30.0);
    assert!((t1.get("median_min", 0.0) - 60.0).abs() <= 5.0 && t1.gets("verdict", "") == "hours" && t1.get("shift_h", 0.0) == 1.0);
    let t = by("on time");
    assert!((tl.get("median_min", 0.0) + 60.0 * t.loc.utc_offset).abs() <= 10.0 && tl.gets("verdict", "") == "utc");
}

#[test]
fn night_flatline_level_shift_and_unit_hints() {
    let cs = scenarios();
    let by = |n: &str| cs.iter().find(|c| c.0 == n).unwrap().2.clone();
    let (qn, q0) = (weather(&by("night and flat")), weather(&by("on time")));
    assert!(flag_hours(&qn, "night") == 1.0 && flag_hours(&qn, "flat_ghi") == 6.0 && flag_hours(&q0, "night") == 0.0 && flag_hours(&q0, "flat_ghi") == 0.0
        && q0.get("n_flagged", 1.0) == 0.0 && qn.at("days").len() == 2);
    let ql = data_qc(&by("load step"), "load").unwrap().at("load").clone();
    let step_day = ql.at("set").arr().iter().filter(|s| s.at("id").str() == "level_shift" && s.at("shifts").len() == 1).map(|s| s.at("shifts").idx(0).get("day", -1.0) as i64).next().unwrap_or(-1);
    assert!((step_day - 200).abs() <= 3 && flag_hours(&ql, "spike") == 0.0, "step at day {step_day}");
    let qw = data_qc(&by("load in watts"), "").unwrap();
    let hint = qw.at("load").at("set").arr().iter().any(|s| s.at("id").str() == "units" && s.getb("above", false) && s.at("hints").arr().iter().any(|h| h.str() == "w"));
    assert!(hint);
}
