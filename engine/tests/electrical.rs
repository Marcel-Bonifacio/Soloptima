//! The electrical design in the engine (engine/src/electrical/) against the JavaScript it replaces: every case in
//! tests/fixtures/electrical/ was written by the interface's ui/src/lib/equip/ (design, auto-size, apply, load flow, short
//! circuit and protection) before the port, with each hourly series kept as a fingerprint (length, sum, min, max, 24 hours).
//! Numbers must agree to 1e-9 relative, texts exactly. The load flow and protection tests take the JavaScript design as their
//! input, so each module is checked on its own; the last test runs them on the engine's own design.
use soloptima_engine::electrical::{design, loadflow, protection, Req};
use soloptima_engine::Value;
use std::path::Path;

const HOURS: usize = 8760;

fn fixtures() -> Vec<(String, Value)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/electrical");
    let series = Value::parse(&std::fs::read_to_string(dir.join("_series.json")).unwrap()).unwrap();
    let mut out: Vec<(String, Value)> = std::fs::read_dir(&dir).unwrap().filter_map(|e| {
        let p = e.ok()?.path();
        let name = p.file_stem()?.to_str()?.to_string();
        (p.extension()? == "json" && !name.starts_with('_')).then(|| {
            let mut v = Value::parse(&std::fs::read_to_string(&p).unwrap()).unwrap();
            resolve(&mut v, &series);
            (name, v)
        })
    }).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(out.len() >= 10, "fixtures missing");
    out
}

// "@name" in a request stands for a series of _series.json
fn resolve(v: &mut Value, series: &Value) {
    match v {
        Value::Str(s) if s.starts_with('@') => *v = series.at(&s[1..]).clone(),
        Value::Arr(a) => a.iter_mut().for_each(|x| resolve(x, series)),
        Value::Obj(o) => o.values_mut().for_each(|x| resolve(x, series)),
        _ => {}
    }
}

// the fingerprint of an hourly series, as generate.mjs takes it
fn fingerprint(v: &Value) -> Value {
    match v {
        Value::Arr(a) if a.len() >= 8000 && a.iter().all(|x| matches!(x, Value::Num(_) | Value::Null)) => {
            let x: Vec<Option<f64>> = a.iter().map(|x| if let Value::Num(n) = x { Some(*n) } else { None }).collect();
            let mut o = Value::object();
            o.set("@series", Value::Num(a.len() as f64));
            o.set("sum", Value::Num(x.iter().fold(0.0, |s, v| s + v.unwrap_or(0.0))));
            o.set("min", Value::Num(x.iter().map(|v| v.unwrap_or(f64::INFINITY)).fold(f64::INFINITY, f64::min)));
            o.set("max", Value::Num(x.iter().map(|v| v.unwrap_or(f64::NEG_INFINITY)).fold(f64::NEG_INFINITY, f64::max)));
            let at: Vec<Value> = (0..24).map(|i| { let k = i * HOURS / 24 + (i * 7) % 24; a.get(k).cloned().unwrap_or(Value::Null) }).collect();
            o.set("at", Value::Arr(at));
            o
        }
        Value::Arr(a) => Value::Arr(a.iter().map(fingerprint).collect()),
        Value::Obj(o) => {
            let mut m = Value::object();
            for (k, x) in o { m.set(k, fingerprint(x)); }
            m
        }
        x => x.clone(),
    }
}

// Output keys added after the port, which the fixtures do not have: the weak-grid screening of the design (written whenever
// the utility short-circuit power is set). The reactive-power results are written only with a power factor asked at the
// point of connection, which no fixture sets, so they need no entry. The islanded N-1 screen (`islands`, with
// electrical.n1_check) and the unbalanced-fault screen (`unbalanced`, with electrical.ubf_vpos and a utility) need inputs no
// fixture has either; they are listed so a fixture written later with them still compares.
const NEW_KEYS: &[&str] = &["weakGrid", "islands", "unbalanced"];

// what the engine wrote (`got`) against what the JavaScript wrote (`want`); a key the JavaScript left undefined may be null
fn same(got: &Value, want: &Value, path: &str, errs: &mut Vec<String>) {
    if errs.len() > 30 { return; }
    match (got, want) {
        (Value::Num(a), Value::Num(b)) => {
            if (a - b).abs() > 1e-9 * b.abs().max(1.0) { errs.push(format!("{path}: {a} against {b}")); }
        }
        (Value::Str(a), Value::Str(b)) => if a != b { errs.push(format!("{path}: {a:?} against {b:?}")) },
        (Value::Bool(a), Value::Bool(b)) => if a != b { errs.push(format!("{path}: {a} against {b}")) },
        (Value::Null, Value::Null) => {}
        (Value::Arr(a), Value::Arr(b)) => {
            if a.len() != b.len() { errs.push(format!("{path}: {} items against {}", a.len(), b.len())); return; }
            for (i, (x, y)) in a.iter().zip(b).enumerate() { same(x, y, &format!("{path}[{i}]"), errs); }
        }
        (Value::Obj(a), Value::Obj(b)) => {
            for (k, y) in b {
                match a.get(k) { Some(x) => same(x, y, &format!("{path}.{k}"), errs), None => errs.push(format!("{path}.{k}: missing")) }
            }
            for (k, x) in a { if !b.contains_key(k) && !x.is_null() && !NEW_KEYS.contains(&k.as_str()) { errs.push(format!("{path}.{k}: not in the JavaScript result")); } }
        }
        _ => errs.push(format!("{path}: {} against {}", got.dump().chars().take(80).collect::<String>(), want.dump().chars().take(80).collect::<String>())),
    }
}

fn check(case: &str, what: &str, got: &Value, want: &Value) -> Vec<String> {
    let mut errs = vec![];
    same(&fingerprint(&Value::parse(&got.dump()).unwrap()), want, &format!("{case} {what}"), &mut errs);
    errs
}

fn report(errs: Vec<String>) { assert!(errs.is_empty(), "{} differences:\n{}", errs.len(), errs.join("\n")); }

#[test]
fn design_matches_the_javascript() {
    let mut errs = vec![];
    for (name, f) in fixtures() {
        let r = f.at("request");
        errs.extend(check(&name, "design", &design::compute_design(&Req::of(r)), f.at("design")));
    }
    report(errs);
}

#[test]
fn auto_size_and_apply_match_the_javascript() {
    let mut errs = vec![];
    for (name, f) in fixtures() {
        let r = f.at("request");
        let mut p = r.at("project").clone();
        let n = design::auto_size(&mut p, r.at("pvr"), r.at("sim"), r.at("lengths"));
        errs.extend(check(&name, "auto-size count", &Value::Num(n as f64), f.at("autosize").at("count")));
        errs.extend(check(&name, "auto-size", p.at("electrical"), f.at("autosize").at("electrical")));
        let mut p = r.at("project").clone();
        let d = design::compute_design(&Req::of(r));
        match design::apply_losses(&mut p, &d, &Value::Null) {
            Ok(rte) => {
                let a = f.at("apply");
                if a.has("error") { errs.push(format!("{name} apply: no error, the JavaScript said {}", a.at("error").str())); continue; }
                errs.extend(check(&name, "apply rte_base", &rte, a.at("rte_base")));
                for k in ["pv", "bess", "aux", "electrical"] { errs.extend(check(&name, &format!("apply {k}"), p.at(k), a.at(k))); }
            }
            Err(e) => errs.extend(check(&name, "apply error", &Value::Str(e), f.at("apply").at("error"))),
        }
    }
    report(errs);
}

#[test]
fn load_flow_matches_the_javascript() {
    let mut errs = vec![];
    for (name, f) in fixtures() {
        let r = f.at("request");
        let (p, d, sim) = (r.at("project"), f.at("design"), r.at("sim"));
        errs.extend(check(&name, "load flow", &loadflow::run_load_flow(p, d, sim), f.at("loadflow")));
        for h in f.at("bus_hours").arr() {
            let t = h.get("t", 0.0) as usize;
            errs.extend(check(&name, &format!("buses at {t}"), &loadflow::bus_voltages(p, d, sim, t), h.at("buses")));
        }
    }
    report(errs);
}

#[test]
fn short_circuit_and_protection_match_the_javascript() {
    let mut errs = vec![];
    for (name, f) in fixtures() {
        let r = f.at("request");
        errs.extend(check(&name, "protection", &protection::protection_study(r.at("project"), f.at("design")), f.at("protection")));
    }
    report(errs);
}

#[test]
fn the_engine_runs_the_whole_study_on_its_own_design() {
    let mut errs = vec![];
    for (name, f) in fixtures() {
        let r = f.at("request");
        let d = design::compute_design(&Req::of(r));
        errs.extend(check(&name, "protection on the engine's design", &protection::protection_study(r.at("project"), &d), f.at("protection")));
        errs.extend(check(&name, "load flow on the engine's design", &loadflow::run_load_flow(r.at("project"), &d, r.at("sim")), f.at("loadflow")));
    }
    report(errs);
}

// ---------------------------------------------------------------- what the design must do, whatever the numbers
// (the checks the interface's JavaScript tests made before the port)

fn case(name: &str) -> Value { fixtures().into_iter().find(|(n, _)| n == name).expect(name).1.at("request").clone() }
// v.a.b... = x
fn put(v: &mut Value, path: &[&str], x: Value) {
    let Value::Obj(o) = v else { panic!("not an object at {path:?}") };
    if path.len() == 1 { o.insert(path[0].into(), x); } else { put(o.get_mut(path[0]).expect(path[0]), &path[1..], x); }
}
fn circuit<'a>(d: &'a Value, k: &str) -> &'a Value { d.at("circuits").arr().iter().find(|c| c.at("key").str() == k).expect(k) }

#[test]
fn the_design_sizes_strings_transformers_and_cables() {
    let r = case("base");
    let d = design::compute_design(&Req::of(&r));
    let s = d.at("str");
    assert!(s.get("ns", 0.0) >= s.get("nMin", 0.0) && s.get("ns", 0.0) <= s.get("nMax", 0.0));
    assert!(d.at("trafos").len() >= 3);
    assert!(circuit(&d, "dc").get("annual", 0.0) > 0.0);
    assert!(d.getb("hasProfiles", false) && d.at("loss").get("pvAc", 0.0) > 0.0 && d.at("loss").get("bess_ll", 0.0) > 0.0 && d.get("cost", 0.0) > 0.0);
    let mut bare = r.clone();
    put(&mut bare, &["pvr"], Value::Null);
    put(&mut bare, &["sim"], Value::Null);
    assert!(!design::compute_design(&Req::of(&bare)).getb("hasProfiles", true));
}

#[test]
fn auto_size_meets_the_limits_on_the_longest_run() {
    for name in ["base", "layout_lengths"] {
        let r = case(name);
        let mut p = r.at("project").clone();
        design::auto_size(&mut p, r.at("pvr"), r.at("sim"), r.at("lengths"));
        let mut r2 = r.clone();
        put(&mut r2, &["project"], p);
        let d = design::compute_design(&Req::of(&r2));
        for c in d.at("circuits").arr() {
            let dv = if c.at("dvMax").is_null() { c.get("dv", 0.0) } else { c.get("dvMax", 0.0) };
            assert!(c.get("util", 9.0) <= 1.0 && dv * 100.0 <= c.get("lim", 0.0) + 1e-9, "{name} {}: {}", c.at("key").str(), d.at("warn").dump());
        }
        assert!(!d.at("warn").arr().iter().any(|w| w.str().contains("longest run")), "{name}");
    }
}

#[test]
fn the_layout_measures_dc_and_mv_and_keeps_lv_typed() {
    let r = case("layout_lengths");
    let (d, l) = (design::compute_design(&Req::of(&r)), r.at("lengths"));
    for k in ["dc", "mv_pv", "mv_bess", "mv_gen", "load"] {
        assert!(circuit(&d, k).getb("fromLayout", false), "{k}");
        assert_eq!(circuit(&d, k).get("L", 0.0), l.at(k).get("len", -1.0), "{k}");
    }
    for k in ["lv_pv", "lv_bess", "lv_gen"] { assert!(circuit(&d, k).at("fromLayout").is_null(), "{k} stays typed"); }
    let dc = circuit(&d, "dc");
    assert!(dc.get("Lmax", 0.0) > dc.get("L", 0.0) && dc.get("dvMax", 0.0) > dc.get("dv", 0.0), "the longest string drops more");
    assert!(circuit(&d, "mv_bess").at("dvMax").is_null(), "one station is its own longest run");
    let mut off = r.clone();
    put(&mut off, &["project", "electrical", "len_from_layout"], Value::Bool(false));
    put(&mut off, &["lengths"], Value::Null);   // as the interface sends it with the box unticked (siteplan.js)
    let d = design::compute_design(&Req::of(&off));
    assert!(circuit(&d, "dc").at("fromLayout").is_null());
}

#[test]
fn the_protection_grades_flags_and_follows_typed_settings() {
    let r = case("base");
    let (p, d) = (r.at("project"), design::compute_design(&Req::of(&r)));
    let pr = protection::protection_study(p, &d);
    for g in pr.at("grading").arr() { assert!(g.getb("ok", false), "{}", g.dump()); }
    for x in pr.at("dev").obj().unwrap().values() {
        assert!(x.at("set").get("pickup", 0.0) <= x.at("brk").get("ir", 0.0), "{}: the breaker carries the pickup", x.at("key").str());
    }
    let warn = |pr: &Value| pr.at("warn").arr().iter().map(|w| w.str().to_string()).collect::<Vec<_>>().join(" ");
    // a typed setting replaces the suggestion and the grading follows it
    let mut q = p.clone();
    put(&mut q, &["electrical", "prot"], Value::parse(r#"{"mv_gen":{"tms":0.05}}"#).unwrap());
    let pr2 = protection::protection_study(&q, &d);
    assert_eq!(pr2.at("dev").at("mv_gen").at("set").get("tms", 0.0), 0.05);
    assert!(warn(&pr2).contains("grading margin"), "{}", warn(&pr2));
    // a breaker too weak for its bus is flagged
    let mut q = p.clone();
    put(&mut q, &["electrical", "breaker"], Value::parse(r#"{"lv_gen":"mccb630"}"#).unwrap());
    let pr3 = protection::protection_study(&q, &d);
    assert!(!pr3.at("dev").at("lv_gen").at("chk").is_empty());
    // neither device of a pair sees the fault: not coordinated
    let mut q = p.clone();
    put(&mut q, &["electrical", "prot"], Value::parse(r#"{"lv_bess":{"pickup":1e6},"mv_bess":{"pickup":1e6}}"#).unwrap());
    let pn = protection::protection_study(&q, &d);
    assert!(pn.at("grading").arr().iter().any(|g| g.at("down").str() == "lv_bess" && !g.getb("ok", true)));
    assert!(warn(&pn).contains("no overcurrent device clears it"), "{}", warn(&pn));
}

#[test]
fn the_load_flow_keeps_the_voltages_near_1_pu() {
    let r = case("base");
    let d = design::compute_design(&Req::of(&r));
    let lf = loadflow::run_load_flow(r.at("project"), &d, r.at("sim"));
    assert!(lf.get("lossTot", 0.0) > 0.0);
    let (lo, hi) = (lf.getv("vmin").into_iter().fold(9.0, f64::min), lf.getv("vmax").into_iter().fold(0.0, f64::max));
    assert!(lo > 0.9 && hi < 1.1, "{lo} {hi}");
}

// ---------------------------------------------------------------- the grid connection (added after the port)

// datasheet `id` of type t in a request's project, to change a value of it; the selected one when id is None
fn datasheet<'a>(r: &'a mut Value, t: &str, id: Option<&str>) -> &'a mut Value {
    let id = id.map_or_else(|| r.at("project").at("equipment").at("sel").at(t).str().to_string(), str::to_string);
    let mut v = r;
    for k in ["project", "equipment", "lib", t] { let Value::Obj(o) = v else { panic!("{k}") }; v = o.get_mut(k).expect(k); }
    let Value::Arr(list) = v else { panic!("{t}") };
    list.iter_mut().find(|x| x.at("id").str() == id).expect(t)
}
fn warns(d: &Value) -> String { d.at("warn").arr().iter().map(|w| w.str().to_string()).collect::<Vec<_>>().join("\n") }

#[test]
fn the_inverters_and_pcs_are_checked_on_kva_at_the_power_factor_asked() {
    let mut r = case("base");
    // base: 7 × 330 kW inverters for 2,997 kWp at DC/AC 1.3; one 2,500 kW PCS
    let d = design::compute_design(&Req::of(&r));
    assert!(d.at("reactive").is_null() && !warns(&d).contains("kVA"), "off without a power factor");
    put(&mut r, &["project", "electrical", "pf_poc"], Value::Num(1.0));
    assert!(design::compute_design(&Req::of(&r)).at("reactive").is_null(), "1 is off");
    put(&mut r, &["project", "electrical", "pf_poc"], Value::Num(0.95));
    let d = design::compute_design(&Req::of(&r));
    let (q, pv) = (d.at("reactive"), d.at("reactive").at("pv"));
    let p = 2997.0 / 1.3;
    assert!((pv.get("p", 0.0) - p).abs() < 1e-9 && pv.get("kva", 0.0) == 330.0 && pv.get("s", 0.0) == 2310.0);
    assert!((pv.get("sReq", 0.0) - p / 0.95).abs() < 1e-9 && pv.get("nReq", 0.0) == 8.0);
    assert!((pv.get("margin", 0.0) - (2310.0 * 0.95 / p - 1.0)).abs() < 1e-12 && pv.get("margin", 0.0) < 0.0);
    assert!((q.get("tan", 0.0) - 0.3287).abs() < 1e-4, "IEEE 2800: 0.3287 × P at 0.95");
    assert_eq!(q.at("bess").get("nReq", 0.0), 2.0);
    let w = warns(&d);
    assert!(w.contains("PV inverters: 7 × 330 kVA give 2,310 kVA, short of the 2,427 kVA") && w.contains("Use 8 units"), "{w}");
    assert!(w.contains("Battery PCS: 1 × 2,500 kVA give 2,500 kVA, short of the 2,632 kVA"), "{w}");
    // kVA ratings with room for the reactive power: no warning, a positive margin
    put(datasheet(&mut r, "inverter", None), &["kva"], Value::Num(360.0));
    put(datasheet(&mut r, "battery", None), &["kva"], Value::Num(2800.0));
    let d = design::compute_design(&Req::of(&r));
    let pv = d.at("reactive").at("pv");
    assert!((pv.get("margin", 0.0) - (2520.0 * 0.95 / p - 1.0)).abs() < 1e-12 && pv.get("margin", 0.0) > 0.0);
    assert!((pv.get("q", 0.0) - (2520.0f64.powi(2) - p * p).sqrt()).abs() < 1e-9 && pv.get("qRatio", 0.0) > 0.3287);
    assert!(!warns(&d).contains("kVA give"), "{}", warns(&d));
}

#[test]
fn the_load_flow_carries_reactive_power_only_with_a_power_factor_asked() {
    let r = case("base");
    let run = |r: &Value| loadflow::run_load_flow(r.at("project"), &design::compute_design(&Req::of(r)), r.at("sim"));
    let off = run(&r);
    assert!(off.at("reactive").is_null());
    let mut one = r.clone();
    put(&mut one, &["project", "electrical", "pf_poc"], Value::Num(1.0));
    assert_eq!(run(&one).dump(), off.dump(), "pf 1 changes nothing");
    let mut on = r.clone();
    put(&mut on, &["project", "electrical", "pf_poc"], Value::Num(0.9));
    let lf = run(&on);
    let q = lf.at("reactive");
    assert!(q.get("kvarh", 0.0) > 0.0 && q.get("pf", 0.0) == 0.9, "{}", q.dump());
    assert!((lf.get("lossTot", 0.0) - off.get("lossTot", 0.0)).abs() > 1.0, "losses move: {} against {}", lf.get("lossTot", 0.0), off.get("lossTot", 0.0));
    assert_ne!(lf.at("vmax").dump(), off.at("vmax").dump(), "voltages move");
    // units with room to spare hold the power factor every hour
    put(datasheet(&mut on, "inverter", None), &["kva"], Value::Num(1e4));
    put(datasheet(&mut on, "battery", None), &["kva"], Value::Num(1e5));
    assert_eq!(run(&on).at("reactive").get("shortH", -1.0), 0.0);
    // and the bus voltages of an hour follow the same rule
    let d = design::compute_design(&Req::of(&on));
    let t = 4000;
    assert_ne!(loadflow::bus_voltages(on.at("project"), &d, on.at("sim"), t).dump(), loadflow::bus_voltages(r.at("project"), &d, r.at("sim"), t).dump());
}

#[test]
fn the_short_circuit_ratio_and_the_energising_dip_by_hand() {
    let mut r = case("base");
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(200.0));
    let d = design::compute_design(&Req::of(&r));
    let g = d.at("weakGrid");
    // 7 × 330 kW inverters + 1 × 2,500 kW PCS = 4,810 kW
    assert_eq!(g.get("pIbr", 0.0), 4810.0);
    assert!((g.get("scr", 0.0) - 200_000.0 / 4810.0).abs() < 1e-9);
    // the largest transformer is the 5,000 kVA BESS unit; no inrush on its datasheet: a first peak of 8 × rated, a fundamental
    // of 4 × rated, 20 MVA against 200 MVA
    assert!(g.get("kva", 0.0) == 5000.0 && g.get("inrush", 0.0) == 8.0 && g.getb("inrushTyp", false));
    assert!((g.get("dip", 0.0) - 20_000.0 / 220_000.0).abs() < 1e-12);
    assert!(!warns(&d).contains("Short-circuit ratio") && !warns(&d).contains("Energising"), "no thresholds, no warnings");
    put(&mut r, &["project", "electrical", "scr_min"], Value::Num(50.0));
    put(&mut r, &["project", "electrical", "dip_max"], Value::Num(5.0));
    let w = warns(&design::compute_design(&Req::of(&r)));
    assert!(w.contains("Short-circuit ratio 41.6 at the point of connection (200 MVA against 4.8 MW of inverters and PCS) is below 50"), "{w}");
    assert!(w.contains("dips the MV bus by about 9.1 %, over the 5 % limit"), "{w}");
    // a datasheet inrush replaces the typical value
    let tr = r.at("project").at("electrical").at("trafo_bess").str().to_string();
    put(datasheet(&mut r, "transformer", Some(&tr)), &["inrush"], Value::Num(5.0));
    put(&mut r, &["project", "electrical", "scr_min"], Value::Num(3.0));
    let d = design::compute_design(&Req::of(&r));
    let g = d.at("weakGrid");
    assert!(!g.getb("inrushTyp", true) && (g.get("dip", 0.0) - 12_500.0 / 212_500.0).abs() < 1e-12);
    assert!(!warns(&d).contains("Short-circuit ratio"), "41.6 is above 3");
    // an isolated plant has no short-circuit ratio
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(0.0));
    assert!(design::compute_design(&Req::of(&r)).at("weakGrid").is_null());
}

// ---------------------------------------------------------------- the islanded N-1 screen and the unbalanced fault [32], [33]

fn rows(d: &Value) -> Vec<&Value> { d.at("islands").at("rows").arr().iter().collect() }
fn row<'a>(d: &'a Value, outage: &str) -> &'a Value { rows(d).into_iter().find(|r| r.at("outage").str() == outage).expect(outage) }
fn sources(r: &Value) -> Vec<&str> { r.at("sources").arr().iter().map(Value::str).collect() }
fn near(a: f64, b: f64) { assert!((a - b).abs() < 1e-9 * b.abs().max(1.0), "{a} against {b}"); }

#[test]
fn the_n1_screen_splits_the_network_by_hand() {
    let mut r = case("base");
    assert!(design::compute_design(&Req::of(&r)).at("islands").is_null(), "off without its input");
    put(&mut r, &["project", "electrical", "n1_check"], Value::Bool(true));
    // base: off-grid, one PV feeder, one BESS feeder with a 2,500 kW PCS, two 500 kW gensets on a feeder each, 1,100 kW peak
    let d = design::compute_design(&Req::of(&r));
    let names: Vec<&str> = rows(&d).iter().map(|x| x.at("outage").str()).collect();
    assert_eq!(names, ["None", "PV feeder", "BESS feeder", "Genset feeder (one of 2)", "Load feeder"]);
    let none = row(&d, "None");
    assert_eq!(none.get("islands", 0.0), 1.0);
    assert_eq!(sources(none), ["gensets", "battery PCS"], "off-grid: the PCS forms the grid");
    near(none.get("firm", 0.0), 3500.0);
    assert!(none.getb("ok", false) && none.get("load", 0.0) == 1100.0);
    // the BESS feeder out: two islands, the gensets alone carry the load
    let b = row(&d, "BESS feeder");
    assert_eq!(b.get("islands", 0.0), 2.0);
    assert_eq!(b.at("other").str(), "BESS station, no load");
    assert_eq!(sources(b), ["gensets"]);
    near(b.get("firm", 0.0), 1000.0);
    near(b.get("shed", 0.0), 100.0);
    assert!(!b.getb("ok", true));
    // one genset feeder out: one genset and the PCS
    near(row(&d, "Genset feeder (one of 2)").get("firm", 0.0), 3000.0);
    // the load's own feeder sheds all of it whatever the sources, and is left out of the summary and the warnings
    let l = row(&d, "Load feeder");
    assert!(l.getb("own", false) && l.get("shed", 0.0) == 1100.0 && sources(l).is_empty());
    let s = d.at("islands");
    assert!(s.get("outages", 0.0) == 3.0 && s.get("noShed", 0.0) == 2.0 && s.get("worst", 0.0) == 2.0, "{}", s.dump());
    let w = warns(&d);
    assert!(w.contains("Islanded N-1 screen: with the BESS feeder out, 100 kW of the 1,100 kW critical load cannot be served: the island has 1,000 kW of firm capacity."), "{w}");
    assert!(!w.contains("load feeder out"), "{w}");
}

#[test]
fn an_island_without_a_grid_forming_source_sheds_all_its_load() {
    let mut r = case("base");
    put(&mut r, &["project", "electrical", "n1_check"], Value::Bool(true));
    put(&mut r, &["project", "electrical", "pcs_grid_forming"], "no".into());
    put(&mut r, &["project", "diesel", "units"], Value::Num(0.0));
    let d = design::compute_design(&Req::of(&r));
    let none = row(&d, "None");
    assert!(!none.getb("formed", true) && sources(none).is_empty());
    assert!(none.get("firm", -1.0) == 0.0 && none.get("shed", 0.0) == 1100.0, "PV without a grid-former counts nothing");
    assert!(warns(&d).contains("with everything in service, 1,100 kW of the 1,100 kW critical load cannot be served: no source left in the island forms the grid"), "{}", warns(&d));
}

#[test]
fn the_shed_is_the_load_less_the_firm_capacity() {
    let mut r = case("base");
    put(&mut r, &["project", "electrical", "n1_check"], Value::Bool(true));
    // a share of the PV counts with a grid-former: the plant's AC rating is 2,997 kWp ÷ 1.3
    put(&mut r, &["project", "electrical", "n1_pv_share"], Value::Num(0.02));
    let d = design::compute_design(&Req::of(&r));
    let b = row(&d, "BESS feeder");
    let firm = 1000.0 + 0.02 * 2997.0 / 1.3;
    near(b.get("firm", 0.0), firm);
    near(b.get("shed", 0.0), 1100.0 - firm);
    near(b.get("critShed", 0.0), 1100.0 - firm);
    put(&mut r, &["project", "electrical", "n1_pv_share"], Value::Num(0.1));
    let d = design::compute_design(&Req::of(&r));
    assert!(row(&d, "BESS feeder").getb("ok", false) && d.at("islands").get("noShed", 0.0) == 3.0);
    assert!(!warns(&d).contains("Islanded"), "{}", warns(&d));
}

#[test]
fn the_n1_screen_keeps_the_critical_load_apart() {
    let mut r = case("base");
    put(&mut r, &["project", "electrical", "n1_check"], Value::Bool(true));
    put(&mut r, &["project", "load", "critical_share"], Value::Num(0.5));
    let d = design::compute_design(&Req::of(&r));
    let b = row(&d, "BESS feeder");
    near(b.get("critLoad", 0.0), 550.0);
    assert!(b.get("critShed", -1.0) == 0.0 && b.get("shed", 0.0) == 100.0, "{}", b.dump());
    assert!(!warns(&d).contains("Islanded"), "the critical half is served: {}", warns(&d));
    put(&mut r, &["project", "load", "critical_share"], Value::Num(0.95));
    let w = warns(&design::compute_design(&Req::of(&r)));
    assert!(w.contains("with the BESS feeder out, 45 kW of the 1,045 kW critical load cannot be served"), "{w}");
}

#[test]
fn with_the_grid_connected_the_main_island_holds_the_utility() {
    let mut r = case("base");
    put(&mut r, &["project", "electrical", "n1_check"], Value::Bool(true));
    put(&mut r, &["project", "grid"], Value::parse(r#"{"enabled": true, "import_kw": 800}"#).unwrap());
    let d = design::compute_design(&Req::of(&r));
    assert!(!d.at("islands").getb("pcsGf", true), "a grid-connected PCS follows the grid unless told");
    let none = row(&d, "None");
    assert_eq!(sources(none), ["utility", "gensets"]);
    near(none.get("firm", 0.0), 1800.0);
    let u = row(&d, "Utility supply");
    assert!(u.get("islands", 0.0) == 1.0 && sources(u) == ["gensets"]);
    near(u.get("shed", 0.0), 100.0);
    near(row(&d, "BESS feeder").get("firm", 0.0), 1800.0);
    put(&mut r, &["project", "electrical", "pcs_grid_forming"], "yes".into());
    let d = design::compute_design(&Req::of(&r));
    near(row(&d, "Utility supply").get("firm", 0.0), 3500.0);
    assert!(!warns(&d).contains("Islanded"), "{}", warns(&d));
}

// the hand values below come from V+ = (X·Vg+ + 0.9·Z²·K+) ÷ (X + Z²·K+), |I+| = (Z/X)·K+(0.9 − V+) and the current left
#[test]
fn the_unbalanced_fault_screen_by_hand() {
    let mut r = case("base");
    // base: 7 × 330 kVA inverters and a 2,500 kVA PCS, 4,810 kVA; X/R 10
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(48.1));
    assert!(design::compute_design(&Req::of(&r)).at("unbalanced").is_null(), "off without the grid voltages");
    for (k, v) in [("ubf_vpos", 0.7), ("ubf_vneg", 0.2), ("ubf_imax", 1.1), ("ubf_kpos", 2.0)] { put(&mut r, &["project", "electrical", k], Value::Num(v)); }
    // mode B, Z = 0.1 pu: the current left cannot cancel V−
    let d = design::compute_design(&Req::of(&r));
    let u = d.at("unbalanced");
    assert!((u.get("z", 0.0) - 0.1).abs() < 1e-12 && u.at("mode").str() == "B" && !u.getb("cancel", true));
    assert!((u.get("vPos", 0.0) - 0.733_471_761_655_36).abs() < 1e-9);
    assert!((u.get("iPos", 0.0) - 0.334_717_616_553_6).abs() < 1e-9);
    near(u.get("iPos", 0.0) + u.get("iNeg", 0.0), 1.1);
    assert!(u.get("spare", 1.0).abs() < 1e-12, "the whole limit is used");
    assert!((u.get("vNeg", 0.0) - 0.123_471_761_655_36).abs() < 1e-9 && (u.get("vuf", 0.0) - 0.168_338_807_450_06).abs() < 1e-9);
    near(u.get("vuf0", 0.0), 0.2 / 0.7);
    // each current is (Z/X) × its reactive part, the active part R/X of it
    near(u.get("iqNeg", 0.0).hypot(u.get("idNeg", 0.0)), u.get("iNeg", 0.0));
    near(u.get("idNeg", 0.0) / u.get("iqNeg", 0.0), 0.1);
    // mode A, Z = 0.5 pu: I− = Vg−/Z cancels V−
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(9.62));
    let u = design::compute_design(&Req::of(&r)).at("unbalanced").clone();
    assert!(u.at("mode").str() == "A" && u.getb("cancel", false));
    assert!((u.get("vPos", 0.0) - 0.800_248_757_758_22).abs() < 1e-9 && (u.get("iPos", 0.0) - 0.200_497_515_516_44).abs() < 1e-9);
    near(u.get("iNeg", 0.0), 0.4);
    assert!(u.get("vNeg", 1.0) == 0.0 && u.get("vuf", 1.0) == 0.0);
    assert!(u.get("iPos", 0.0) + u.get("iNeg", 0.0) <= 1.1);
    // a droop gain that asks for more than the limit: the positive sequence takes all of it and V− stays the grid's
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(48.1));
    put(&mut r, &["project", "electrical", "ubf_kpos"], Value::Num(20.0));
    let u = design::compute_design(&Req::of(&r)).at("unbalanced").clone();
    assert!(u.getb("short", false) && u.get("iPos", 0.0) == 1.1 && u.get("iNeg", 1.0) == 0.0);
    near(u.get("vPos", 0.0), 0.7 + 0.1 * 1.1);
    near(u.get("vNeg", 0.0), 0.2);
    // an isolated plant has none
    put(&mut r, &["project", "electrical", "grid_mva"], Value::Num(0.0));
    assert!(design::compute_design(&Req::of(&r)).at("unbalanced").is_null());
}
