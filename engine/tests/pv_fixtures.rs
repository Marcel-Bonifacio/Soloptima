//! The PV models against the C++ engine: tests/gen_pv_fixtures.cpp ran the C++ PV code on the example project and on
//! variants that exercise each model (each one the example with a JSON patch and named operations, stored in the fixture),
//! and on the smaller PV functions, and wrote FNV-1a hashes of the bit patterns of the results (engine/tests/fixtures/pv.json).
//! Everything compares bit for bit: hourly profile, plane-of-array irradiance, cell temperature, local GHI, monthly balances,
//! loss steps, shade per table, near horizon envelope and the PV response document. No tolerance is needed: every case is
//! byte-identical, in debug and release builds.
//!
//! What it took: the compiled C++ takes the sine and cosine of one angle in one call where a function needs both (on Apple
//! systems __sincos_stret, which differs from separate sin and cos in the last bit for some angles; about 1 hour in 900 of
//! the sun position). The Rust code takes the same pairs through solar::sin_cos (sun position, plane and sun azimuth, tracker
//! axis, row rotation, view factors, diffuse IAM, rays to objects) and keeps apart, with solar::sin_apart and cos_apart, the
//! one pair the C++ leaves apart (the rotation of a tracker on a tilted axis), so its own optimizer cannot pair them either.
//! The fixture was written on macOS; with another libm, pow, exp, log, atan2 and the trigonometric functions may differ in
//! the last bit, and the fixture would need to be written there.
use soloptima_engine::pv::*;
use soloptima_engine::shading::{near_horizon, NearShading, ShadePoint};
use soloptima_engine::*;
use std::path::PathBuf;

fn root() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }
fn read(p: PathBuf) -> String { std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())) }
fn fixture() -> Value { Value::parse(&read(root().join("engine/tests/fixtures/pv.json"))).unwrap() }
fn example_text() -> String { read(root().join("web/examples/example_study.json")) }

/// FNV-1a over the little-endian bytes of each value's bit pattern, as tests/gen_pv_fixtures.cpp
fn fnv(v: &[f64]) -> String {
    let mut h: u64 = 1469598103934665603;
    for d in v {
        for b in d.to_bits().to_le_bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    }
    format!("{h:016x}")
}
fn fnv_text(t: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in t.bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    format!("{h:016x}")
}

/// Objects of the patch merged into the document member by member; any other value replaces the one there
fn merge(dst: &mut Value, src: &Value) {
    if let (Value::Obj(d), Value::Obj(s)) = (&mut *dst, src) {
        for (k, v) in s { merge(d.entry(k.clone()).or_insert(Value::Null), v); }
    } else {
        *dst = src.clone();
    }
}

fn apply_op(p: &mut Project, op: &str) {
    if op == "cold" { for t in &mut p.wx.tamb { *t -= 30.0; } }
    if op == "snow_hourly" {
        p.wx.snow = vec![0.0; HOURS];
        p.wx.snow[40 * 24 + 10] = 3.0;
        p.wx.snow[41 * 24 + 11] = 0.5;
        p.wx.snow[330 * 24 + 8] = 2.5;
        p.wx.snow[8750] = 4.0;
    }
}

fn project(example: &str, patch: &str, ops: &[Value]) -> Project {
    let mut doc = Value::parse(example).unwrap();
    merge(&mut doc, &Value::parse(patch).unwrap());
    let mut p = parse_project(&doc);
    for op in ops { apply_op(&mut p, op.str()); }
    p
}

#[test]
fn every_case_gives_the_cpp_profile_bit_for_bit() {
    let fx = fixture();
    let example = example_text();
    let mut failed = Vec::new();
    for c in fx.at("cases").arr() {
        let name = c.at("name").str();
        let p = project(&example, c.at("patch").str(), c.at("ops").arr());
        let detail = c.getb("detail", false);
        let prof = if detail { array_groups(&p).and_then(|g| compute_pv_profile_groups(&p, &g, true)) } else { compute_pv_profile(&p) };
        let prof = match prof {
            Ok(x) => x,
            Err(e) => { failed.push(format!("{name}: error {e}")); continue; }
        };
        assert!(!c.has("error"), "{name}: the C++ engine failed");
        let mut bad = Vec::new();
        let want_losses = c.at("losses").arr();
        if want_losses.len() != prof.losses.len() { bad.push(format!("{} loss steps vs {}", prof.losses.len(), want_losses.len())); }
        for (l, w) in prof.losses.iter().zip(want_losses) {
            let (wn, wv) = (w.idx(0).str(), w.idx(1).num(f64::NAN));
            if l.name != wn || l.value.to_bits() != wv.to_bits() { bad.push(format!("step {}: {:.17e} vs {} {:.17e}", l.name, l.value, wn, wv)); }
        }
        let months: Vec<f64> = [&prof.m_ghi, &prof.m_dhi, &prof.m_tamb, &prof.m_poa, &prof.m_eff, &prof.m_dc, &prof.m_avail].iter().flat_map(|m| m.iter().copied()).collect();
        let shade = fnv(&prof.table_shade) + &fnv(&prof.near_max) + &fnv(&prof.near_median);
        for (key, got) in [("ac", fnv(&prof.ac_per_kwp)), ("poa", fnv(&prof.poa)), ("tcell", fnv(&prof.tcell)), ("ghi", fnv(&prof.ghi_local)),
                           ("monthly", fnv(&months)), ("shade", shade), ("json", fnv_text(&pv_json(&prof).dump()))] {
            if got != c.at(key).str() { bad.push(format!("{key} differs")); }
        }
        if prof.specific_yield.to_bits() != c.get("specific_yield", f64::NAN).to_bits() {
            bad.push(format!("yield {:.17} vs {:.17}", prof.specific_yield, c.get("specific_yield", f64::NAN)));
        }
        if !bad.is_empty() { failed.push(format!("{name}: {}", bad.join("; "))); }
    }
    assert!(failed.is_empty(), "{} case(s) differ from the C++ engine:\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn the_smaller_functions_give_the_cpp_results_bit_for_bit() {
    let fx = fixture();
    let f = fx.at("functions");
    let ex = project(&example_text(), "{}", &[]);
    let mut got: Vec<(&str, String)> = Vec::new();

    let mut v = Vec::new();
    for eta in [0.97, 0.983] { for mx in [0.985, 0.99] { v.extend(inverter_curve(eta, mx)); } }
    got.push(("inverter_curve", fnv(&v)));

    let mut v = Vec::new();
    let mut pv = PVParams::default();
    for m in ["ashrae", "martin_ruiz", "physical"] {
        for nar in [0.0, 1.29] {
            pv.iam_model = m.into();
            pv.iam_n_ar = nar;
            for t in [0.0, 10.0, 35.0, 90.0, 145.0, 180.0] { v.extend(diffuse_iam(&pv, t)); }
            for c in [1.0, 0.8, 0.3, 0.05, 1e-6] { v.push(incidence_modifier(&pv, c)); }
        }
    }
    got.push(("iam", fnv(&v)));

    let mut v = Vec::new();
    for tilt in [0.0, 12.0, 30.0, 55.0] {
        for gcr in [0.3, 0.5, 0.8] {
            let r = row_view(tilt, gcr);
            v.extend([r.front_sky, r.front_ground, r.back_sky, r.back_ground]);
            let g = ground_view(tilt, gcr, 0.5);
            v.extend(&g.sky);
            v.extend(&g.front);
            v.extend(&g.back);
            for tp in [-2.0, -0.3, 0.0, 0.7, 3.0] { v.extend(g.reflected(tp, 600.0, 120.0)); }
        }
    }
    got.push(("rows", fnv(&v)));

    let h: Vec<f64> = (0..36).map(|k| 5.0 + 4.0 * (f64::from(k) * 0.7).sin()).collect();
    let mut v = Vec::new();
    for t in [0.0, 20.0, 90.0, 160.0] { for a in [0.0, 90.0, 180.0, 333.0] { v.extend(horizon_view(&h, t, a)); } }
    for a in [-725.0, 0.0, 3.3, 359.9, 1000.0] { v.push(horizon_at(&h, a)); }
    got.push(("horizon", fnv(&v)));

    let wall = Obstacle { height: 10.0, pts: vec![[-10.0, -10.0], [10.0, -10.0], [10.0, -11.0], [-10.0, -11.0]] };
    let tower = Obstacle {
        height: 20.0,
        pts: (0..16).map(|k| [30.0 + 6.0 * (f64::from(k) * 0.3927).sin(), 25.0 + 6.0 * (f64::from(k) * 0.3927).cos()]).collect(),
    };
    let objs = vec![wall, tower];
    let mut v = Vec::new();
    for xyz in [[0.0, 0.0, 0.0], [0.0, -10.5, 0.0], [0.0, 0.0, 11.0], [5.0, 3.0, 1.5], [-40.0, 60.0, 0.5]] {
        v.extend(near_horizon(xyz[0], xyz[1], xyz[2], &objs).iter().map(|&x| f64::from(x)));
    }
    let pt = |x: f64, y: f64, z: f64| ShadePoint { x, y, z, table: -1 };
    let ns = NearShading::new(vec![pt(0.0, 0.0, 0.0), pt(0.0, 100.0, 0.0), pt(20.0, 20.0, 2.0)], &objs, &[4.0; 36]);
    for az in [0.0, 45.0, 180.0, 200.0] { for el in [3.0, 10.0, 30.0, 50.0] { v.push(ns.shaded(az, el)); } }
    v.extend(&ns.sky().sky);
    v.extend(&ns.sky().band);
    got.push(("near", fnv(&v)));

    let mut q = ex.clone();
    q.pv.clearsky = "ineichen".into();
    got.push(("clearsky_ghi_ineichen", fnv(&clearsky_ghi(&q).unwrap())));
    got.push(("clearsky_ghi_haurwitz", fnv(&clearsky_ghi(&ex).unwrap())));
    got.push(("clearsky_pv_ineichen", fnv(&clearsky_pv_per_kwp(&q).unwrap())));
    got.push(("clearsky_pv_haurwitz", fnv(&clearsky_pv_per_kwp(&ex).unwrap())));
    let scan: Vec<f64> = tilt_scan(&ex, 0.0, 45.0, 7.5).unwrap().into_iter().flat_map(|(t, y)| [t, y]).collect();
    got.push(("tilt_scan", fnv(&scan)));
    let mut w = ex.clone();
    w.wind.units = 2;
    let mut wv = wind_per_turbine(&w).unwrap();
    w.wind.curve = "linear".into();
    w.loc.utc_offset = 2.5;
    wv.extend(wind_per_turbine(&w).unwrap());
    got.push(("wind", fnv(&wv)));

    let mut v = Vec::new();
    for mount in ["fixed", "tracker"] {
        let mut q = ex.clone();
        q.pv.mount = mount.into();
        q.pv.soiling_monthly = vec![0.015; 12];
        let b = pv_reference_basis(&q).unwrap();
        v.extend([b.kept, b.profile.specific_yield]);
    }
    got.push(("reference", fnv(&v)));

    let bad: Vec<&str> = got.iter().filter(|(k, h)| f.at(k).str() != h).map(|(k, _)| *k).collect();
    assert_eq!(got.len(), f.obj().unwrap().len());
    assert!(bad.is_empty(), "differ from the C++ engine: {bad:?}");
}
