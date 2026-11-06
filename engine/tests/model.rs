//! The model, JSON and validation against the C++ engine. The fixtures in tests/fixtures were written by the C++ engine
//! itself (tests/gen_model_fixtures.cpp); the cases below are ported from tests/test_engine.cpp.
use sha2::{Digest, Sha256};
use soloptima_engine::*;
use std::path::PathBuf;

const EXAMPLE_CANONICAL_SHA256: &str = "492a2f9ef0666175507fd9f49b6c1787dc0b5e1e297b2645c7d50789f1432dbc";
const EXAMPLE_CANONICAL_LEN: usize =   234901;

fn root() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }
fn read(p: PathBuf) -> String { std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())) }
fn example_text() -> String { read(root().join("web/examples/example_study.json")) }
fn fixture(name: &str) -> Value { Value::parse(&read(root().join("engine/tests/fixtures").join(name))).unwrap() }
fn project(text: &str) -> Project { project_from_text(text).unwrap() }
fn valid(p: &Project) -> bool { validate_project(p).is_ok() }

#[test]
fn example_project_round_trips_byte_identically() {
    let text = example_text();
    let doc = Value::parse(&text).unwrap();
    let saved = doc.dump();
    // exactly what the C++ engine writes for this document
    assert_eq!(saved.len(), EXAMPLE_CANONICAL_LEN);
    assert_eq!(format!("{:x}", Sha256::digest(saved.as_bytes())), EXAMPLE_CANONICAL_SHA256);
    // load, save, load, save: the same document, the same bytes
    let again = Value::parse(&saved).unwrap();
    assert_eq!(again, doc);
    assert_eq!(again.dump(), saved);
    // and the same through serde
    let via_serde: Value = serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
    assert_eq!(via_serde, doc);
}

#[test]
fn json_text_matches_the_cpp_parser_and_writer() {
    let cases = fixture("roundtrip.json");
    assert!(cases.len() > 60);
    for c in cases.arr() {
        let (text, want) = (c.at("text").str(), c.at("result").str());
        let got = match Value::parse(text) { Ok(v) => format!("OK {}", v.dump()), Err(e) => format!("ERR {e}") };
        assert_eq!(got, want, "input {text:.60}");
    }
}

#[test]
fn a_lone_surrogate_escape_becomes_the_replacement_character() {
    // the one known difference: C++ keeps the invalid bytes, a Rust string cannot
    assert_eq!(Value::parse(r#""\ud800""#).unwrap(), Value::Str("\u{fffd}".into()));
    assert_eq!(Value::parse(r#""\ud83dx""#).unwrap(), Value::Str("\u{fffd}x".into()));
}

#[test]
fn lenient_accessors_read_like_the_cpp_ones() {
    let v = Value::parse(r#"{"a":"2.5kW","b":true,"c":null,"d":"x","e":3,"f":[1,"2",null,true]}"#).unwrap();
    assert_eq!((v.get("a", 9.0), v.get("b", 9.0), v.get("c", 9.0), v.get("d", 9.0), v.get("e", 9.0), v.get("zz", 9.0)), (2.5, 1.0, 9.0, 9.0, 3.0, 9.0));
    assert_eq!(v.getv("f"), vec![1.0, 2.0, 0.0, 1.0]);
    assert!(v.getb("e", false) && !v.getb("c", false) && v.getb("c", true));
    assert_eq!(v.gets("a", "-"), "2.5kW");
    assert_eq!(v.gets("e", "-"), "-");
}

#[test]
fn validation_refuses_the_same_inputs_with_the_same_messages() {
    let text = example_text();
    let inputs = fixture("cases_in.json");
    let want = fixture("cases.json");
    assert_eq!(inputs.len(), want.len());
    assert!(inputs.len() > 100);
    for (case, expect) in inputs.arr().iter().zip(want.arr()) {
        assert_eq!(case.at("name"), expect.at("name"));
        let mut doc = Value::parse(&text).unwrap();
        for s in case.at("set").arr() { set_path(&mut doc, s.idx(0).str(), expand(s.idx(1))); }
        let got = match validate_project(&parse_project(&doc)) { Ok(()) => "OK".to_string(), Err(e) => format!("ERR {e}") };
        assert_eq!(got, expect.at("result").str(), "case {}", case.at("name").str());
    }
}

/// {"$repeat": [x, n]} stands for an array of n times x
fn expand(v: &Value) -> Value {
    if v.has("$repeat") { Value::Arr(vec![v.at("$repeat").idx(0).clone(); v.at("$repeat").idx(1).num(0.0) as usize]) } else { v.clone() }
}
fn set_path(root: &mut Value, path: &str, v: Value) {
    let mut cur = root;
    let segs: Vec<&str> = path.split('.').collect();
    for (i, seg) in segs.iter().enumerate() {
        let next = match (seg.parse::<usize>(), cur) {
            (Ok(n), Value::Arr(a)) => &mut a[n],
            (_, c) => {
                if !c.is_object() { *c = Value::Obj(Default::default()); }
                let Value::Obj(o) = c else { unreachable!() };
                o.entry(seg.to_string()).or_default()
            }
        };
        if i == segs.len() - 1 { *next = v; return; }
        cur = next;
    }
}

// ---- cases ported from tests/test_engine.cpp ----

fn base() -> Project { project_from_text(&example_text()).unwrap() }

#[test]
fn the_example_project_is_valid_and_has_its_series() {
    let p = base();
    assert!(valid(&p));
    assert_eq!((p.wx.ghi.len(), p.load_kw.len()), (HOURS, HOURS));
    assert_eq!(p.name, "Example study: off-grid industrial site");
}

#[test]
fn defaults_of_an_empty_project() {
    let d = project("{}");
    assert_eq!(d.name, "Untitled");
    assert_eq!(d.pv.dc_wiring_basis, "annual");
    assert!(d.pv.transposition == "hay_davies" && !d.pv.diffuse_shading && d.pv.bifaciality == 0.0 && d.pv.soiling_monthly.is_empty());
    assert!((d.pv.row_width - 2.0 * 2.278).abs() < 1e-12);
    assert!(d.pv.decomposition == "erbs" && d.pv.clearsky == "haurwitz" && d.pv.iam_model == "ashrae" && d.pv.shade_model == "linear"
        && d.pv.inverter_model == "constant" && d.pv.degradation_model == "compound" && d.pv.spectral == "none" && d.pv.horizon.is_empty()
        && d.pv.tracker_axis_tilt == 0.0 && d.pv.tracker_cross_slope == 0.0 && d.wx.snow.is_empty() && !d.wx.horizon_in_beam);
    let a = &d.aux;
    assert!(a.bess_kw_per_mwh == 0.0 && a.bess_temp_coeff == 0.0 && a.ref_c == 25.0 && a.plant_kw == 0.0 && a.trafo_noload_kw == 0.0
        && a.bess_trafo_noload_kw == 0.0 && a.pcs_kw_per_mw == 0.0);
    assert_eq!(d.bess.reserve_duration_h, 1.0);
    assert_eq!(d.dg.fuel_curve.len(), 10);
    assert_eq!(d.ems.horizon, 24);
    assert!(d.sim.all_years && d.sim.load_growth == 0.0);
    assert_eq!(d.loc.utc_offset, 0.0);
}

#[test]
fn battery_ageing_defaults_and_a_blank_replacement_soh() {
    let d = project(r#"{"bess":{"replace_soh":null}}"#);
    assert!(d.bess.cycle_life_dod == 1.0 && d.bess.replace_soh == -1.0 && d.bess.soh_init == 1.0 && d.bess.warranty_efc_yr == 0.0);
}

#[test]
fn replacement_soh_of_zero_is_refused_blank_and_sixty_percent_are_accepted() {
    for (r, ok) in [(0.0, false), (-1.0, true), (0.6, true)] {
        let mut p = base();
        p.bess.replace_soh = r;
        assert_eq!(valid(&p), ok, "replace_soh {r}");
    }
}

#[test]
fn utc_offset_range_and_its_default_from_the_longitude() {
    let at = |off: f64| { let mut p = base(); p.loc.utc_offset = off; p };
    assert!(valid(&at(12.75)) && valid(&at(-12.0)) && valid(&at(14.0)) && !valid(&at(14.5)) && !valid(&at(-15.0)));
    assert_eq!(project(r#"{"location":{"lon":115.2}}"#).loc.utc_offset, 8.0);
    assert_eq!(project(r#"{"location":{"lon":115.2,"utc_offset":5.75}}"#).loc.utc_offset, 5.75);
}

#[test]
fn table_width_from_the_layout() {
    let l = project(r#"{"pv":{"module_width":1.3},"layout":{"orientation":"landscape","modules_across":4}}"#);
    assert!((l.pv.row_width - 4.0 * 1.3).abs() < 1e-12 && !l.pv.portrait && l.pv.modules_up == 4);
}

#[test]
fn pvgis_weather_and_elevation() {
    assert!(project(r#"{"weather":{"source":"PVGIS TMY (PVGIS-SARAH3)","elevation":250}}"#).wx.horizon_in_beam);
    assert_eq!(project(r#"{"weather":{"elevation":250}}"#).loc.elevation, 250.0);
}

#[test]
fn series_of_other_resolutions_become_hourly() {
    let half: Vec<String> = (0..17520).map(|i| (i % 2).to_string()).collect();
    let p = project(&format!(r#"{{"load":{{"kw":[{}]}}}}"#, half.join(",")));
    assert_eq!((p.load_kw.len(), p.load_kw[0]), (HOURS, 0.5));
    let leap: Vec<String> = (0..8784).map(|i| i.to_string()).collect();
    let p = project(&format!(r#"{{"load":{{"kw":[{}]}}}}"#, leap.join(",")));
    assert_eq!((p.load_kw.len(), p.load_kw[1415], p.load_kw[1416]), (HOURS, 1415.0, 1440.0));
}

#[test]
fn irradiance_and_further_pv_inputs_invalid_accepted_or_valid_refused() {
    let bad = |f: &dyn Fn(&mut Project)| { let mut p = base(); f(&mut p); !valid(&p) };
    assert!(bad(&|x| x.pv.soiling_monthly = vec![0.01, 0.02]) && bad(&|x| x.pv.transposition = "perezz".into())
        && bad(&|x| { x.pv.bifaciality = 0.7; x.pv.gcr = 1.2; }) && !bad(&|x| x.pv.gcr = 1.2));
    assert!(bad(&|x| { x.pv.inverter_model = "curve".into(); x.pv.inverter_eff_max = 0.98; }) && bad(&|x| x.pv.horizon = vec![1.0, 2.0, 3.0])
        && bad(&|x| x.pv.iam_model = "fresnel".into()) && bad(&|x| x.pv.snow_monthly = vec![10.0; 12]) && !bad(&|x| x.pv.horizon = vec![5.0; 48]));
}

#[test]
fn pcs_no_load_loss_and_load_growth_and_genset_rating_limits() {
    let bad = |f: &dyn Fn(&mut Project)| { let mut p = base(); f(&mut p); !valid(&p) };
    assert!(!bad(&|_| {}) && bad(&|x| x.aux.pcs_kw_per_mw = -1.0));
    assert!(bad(&|x| x.sim.load_growth = f64::NAN) && bad(&|x| x.sim.load_growth = 1e308) && bad(&|x| x.dg.unit_kw = f64::INFINITY));
}

#[test]
fn layout_of_a_project_file() {
    let f = project(r#"{"location":{"lat":-8.5,"lon":115.2},"layout":{"polygons":[
        {"type":"site","latlngs":[[-8.5,115.2],[-8.5,115.201],[-8.499,115.201],[-8.499,115.2]],"base":6,"tilt":15,"azimuth":0,"east_west":false},
        {"type":"exclusion","latlngs":[[-8.5,115.2],[-8.5,115.2005],[-8.4995,115.2005]]},
        {"type":"obstacle","latlngs":[[-8.501,115.2],[-8.501,115.2002],[-8.5012,115.2002]],"height":12},
        {"type":"obstacle","kind":"tree","center":[-8.4985,115.2],"diameter":6,"height":9}],
        "result":{"tables":[[[-8.5,115.2],[-8.5,115.2001],[-8.49997,115.2001],[-8.49997,115.2]]]}}}"#);
    let (a, tree) = (&f.layout.areas[0], &f.layout.obstacles[1]);
    assert!(f.layout.areas.len() == 1 && a.base == 6.0 && a.tilt == 15.0 && (a.pts[2][1] - 110.574).abs() < 1e-6);
    assert!(f.layout.obstacles.len() == 2 && f.layout.obstacles[0].height == 12.0 && tree.pts.len() == 16 && f.layout.tables.len() == 1);
    let d = ((tree.pts[0][0] - tree.pts[8][0]).powi(2) + (tree.pts[0][1] - tree.pts[8][1]).powi(2)).sqrt();
    assert!((d - 6.0).abs() < 1e-9);
    let c = project(r#"{"location":{"lat":-8.5,"lon":115.2},"layout":{"polygons":[
        {"type":"site","latlngs":[[-8.5,115.2],[-8.5,115.201],[-8.499,115.201],[-8.499,115.2]],"canopy":true}]}}"#);
    assert!(c.layout.areas.len() == 1 && c.layout.areas[0].canopy && layout_used(&c));
}

#[test]
fn layout_checks_invalid_accepted_or_valid_refused() {
    let mut ob = base();
    ob.layout.obstacles = vec![Obstacle { pts: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]], height: 20.0 }];
    ob.layout.tables = vec![[[30.0, 0.0], [40.0, 0.0], [40.0, 5.0], [30.0, 5.0]]];
    ob.layout.areas = vec![LayoutArea { pts: vec![[0.0, 0.0], [100.0, 0.0], [100.0, 50.0]], ..Default::default() }];
    let bad = |f: &dyn Fn(&mut Project)| { let mut x = ob.clone(); f(&mut x); !valid(&x) };
    assert!(bad(&|x| x.layout.obstacles[0].height = 0.0) && bad(&|x| x.layout.areas[0].tilt = 95.0)
        && bad(&|x| x.layout.tables[0][2] = [6e4, 0.0]) && bad(&|x| x.layout.obstacles[0].pts.truncate(2))
        && bad(&|x| x.layout.obstacles[0].pts = vec![[50.0, 0.0]; 6000]) && bad(&|x| x.layout.table_area = vec![0, 0, 0, 7])
        && !bad(&|_| {}));
}

#[test]
fn degradation_factor_and_month_of_day() {
    let mut pv = PVParams::default();
    assert!((pv_degradation_factor(&pv, 3) - 0.995f64.powi(2)).abs() < 1e-15);
    pv.degradation_model = "linear".into();
    assert!((pv_degradation_factor(&pv, 3) - 0.99).abs() < 1e-15);
    assert_eq!((month_of_day(0), month_of_day(30), month_of_day(31), month_of_day(364)), (0, 0, 1, 11));
}

#[test]
fn the_model_serialises_with_serde() {
    let mut p = base();
    p.layout = SiteLayout::default();
    let back: Project = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
    assert_eq!(back, p);
}
