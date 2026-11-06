//! Inter-annual variability (src/resource.cpp): resource_years on the example project with synthetic weather years and
//! exceedance on its own, against fixtures/resource.json (tests/gen_resource_fixtures.cpp). Answers match to the byte.
use soloptima_engine::optimizer::Progress;
use soloptima_engine::resource::{exceedance, resource_years, UncertaintyBudget, WeatherYear};
use soloptima_engine::{parse_project, validate_project, Project, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering::Relaxed;

fn read(rel: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn merge(dst: &mut Value, src: &Value) {
    match (dst, src.obj()) {
        (Value::Obj(d), Some(s)) => for (k, v) in s { merge(d.entry(k.clone()).or_insert(Value::Null), v) },
        (d, _) => *d = src.clone(),
    }
}

fn years_of(p: &Project, spec: &Value) -> Vec<WeatherYear> {
    spec.arr().iter().map(|s| {
        let mut wx = p.wx.clone();
        let (f, dt, fw) = (s.idx(1).num(0.0), s.idx(2).num(0.0), s.idx(3).num(0.0));
        for v in [&mut wx.ghi, &mut wx.dni, &mut wx.dhi] { for x in v.iter_mut() { *x *= f; } }
        for x in wx.tamb.iter_mut() { *x += dt; }
        for x in wx.wind.iter_mut() { *x *= fw; }
        WeatherYear { year: s.idx(0).num(0.0) as i32, wx }
    }).collect()
}

#[test]
fn resource_years_match_cpp() {
    let fx = Value::parse(&read("tests/fixtures/resource.json")).unwrap();
    let example = Value::parse(&read("../web/examples/example_study.json")).unwrap();
    for c in fx.at("cases").arr() {
        let name = c.at("name").str();
        let mut doc = example.clone();
        merge(&mut doc, c.at("patch"));
        let p = parse_project(&doc);
        validate_project(&p).unwrap();
        let bj = c.at("budget");
        let d = UncertaintyBudget::default();
        let b = UncertaintyBudget { dataset: bj.get("dataset", d.dataset), model: bj.get("model", d.model), soiling: bj.get("soiling", d.soiling) };
        let prog = Progress::default();
        match resource_years(&p, &doc, &years_of(&p, c.at("years")), &b, &prog) {
            Ok(r) => {
                assert_eq!(r.dump(), c.at("result").dump(), "{name}");
                assert_eq!(prog.done.load(Relaxed) as f64, c.get("progress", -1.0), "{name}");
            }
            Err(e) => assert_eq!(e.0, c.gets("error", "(no error)"), "{name}"),
        }
    }
}

#[test]
fn exceedance_matches_cpp() {
    let fx = Value::parse(&read("tests/fixtures/resource.json")).unwrap();
    for x in fx.at("exceedance").arr() {
        let e = exceedance(x.get("m0", 0.0), &x.getv("ys"), x.get("el", 0.0), x.get("ss", 0.0), x.getb("benefit", true));
        let got = vec![e.p50, e.mean, e.sigma_iav, e.sigma_1, e.sigma_10, e.p75_1, e.p90_1, e.p99_1, e.p90_10];
        assert_eq!(Value::from(got).dump(), x.at("out").dump());
    }
}

#[test]
fn cancel_stops_the_run() {
    let p = parse_project(&Value::parse(&read("../web/examples/example_study.json")).unwrap());
    let years = vec![WeatherYear { year: 2020, wx: p.wx.clone() }, WeatherYear { year: 2021, wx: p.wx.clone() }];
    let prog = Progress::default();
    prog.cancel.store(true, Relaxed);
    let e = resource_years(&p, &Value::Null, &years, &UncertaintyBudget::default(), &prog).unwrap_err();
    assert_eq!(e.0, "Cancelled.");
}
