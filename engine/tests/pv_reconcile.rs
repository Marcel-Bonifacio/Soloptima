//! Metered PV output against the model (pv/reconcile.rs) and its import (series, kind "pv"): statistics, outages, the soiling and
//! availability fit, partial years, monthly sums, and bad input refused with a message.
use soloptima_engine::api::Engine;
use soloptima_engine::calendar::{civil_from_days, days_from_civil};
use soloptima_engine::pv::{pv_reconcile, reconcile, ModelBasis};
use soloptima_engine::weather::{MockHttp, WeatherService};
use soloptima_engine::{compute_pv_profile, import_series, parse_project, Project, Value, HOURS, MONTH_START};
use std::path::PathBuf;

const KWP: f64 = 100.0;

fn month(i: usize) -> usize { (0..12).rev().find(|&m| (i / 24) as i32 >= MONTH_START[m]).unwrap() }

/// A clear day every day: GHI and an AC output of 80 kW at noon, 06:00 to 18:00, a little lower in the middle of the year
fn basis() -> (Vec<f64>, Vec<f64>) {
    let mut kw = vec![0.0; HOURS];
    let mut ghi = vec![0.0; HOURS];
    for i in 0..HOURS {
        let h = (i % 24) as f64 + 0.5;
        if !(6.0..18.0).contains(&h) { continue; }
        let s = ((h - 6.0) / 12.0 * std::f64::consts::PI).sin();
        let season = 1.0 - 0.1 * ((i / 24) as f64 / 365.0 * std::f64::consts::PI).sin();
        ghi[i] = 1000.0 * s * season;
        kw[i] = 80.0 * s * season;
    }
    (kw, ghi)
}

fn run(kw: &[f64], ghi: &[f64], meter: &[f64], soiling: f64, availability: f64) -> Value {
    reconcile(&ModelBasis { kw, ghi, soiling: [soiling; 12], availability, kwp: KWP }, meter).unwrap()
}

fn close(a: f64, b: f64, tol: f64) -> bool { (a - b).abs() <= tol }

#[test]
fn a_perfect_match_has_no_error() {
    let (kw, ghi) = basis();
    let r = run(&kw, &ghi, &kw, 0.02, 0.99);
    for set in ["running", "all"] {
        let s = r.at("stats").at(set);
        assert_eq!(s.get("mbe", 1.0), 0.0, "{set}");
        assert_eq!(s.get("rmse_kw", 1.0), 0.0, "{set}");
        assert_eq!(s.get("r2", 0.0), 1.0, "{set}");
    }
    assert_eq!(r.get("outage_h", 1.0), 0.0);
    // no downtime at the meter: the project's 1 % availability loss shows as running loss, and the product is unchanged
    let f = r.at("fit");
    assert!(close(f.get("availability", 0.0), 1.0, 1e-12));
    assert!(close(1.0 - f.get("soiling", 0.0), 0.98 * 0.99, 1e-12));
    assert!(f.at("after").get("rmse_kw", 1.0) < 1e-9);
}

#[test]
fn a_model_at_ninety_percent_has_an_mbe_of_minus_ten() {
    let (kw, ghi) = basis();
    let model: Vec<f64> = kw.iter().map(|x| 0.9 * x).collect();
    let r = run(&model, &ghi, &kw, 0.0, 1.0);
    let s = r.at("stats").at("all");
    assert!(close(s.get("mbe", 0.0), -0.10, 1e-12), "{}", s.get("mbe", 0.0));
    assert!(s.get("rmse_kw", 0.0) > 0.0 && s.get("r2", 1.0) < 1.0);
    assert!(close(s.get("nrmse", 0.0), 0.10 * rms_over_mean(&kw), 1e-9));
}

/// RMS of the daylight values over their mean: the nRMSE of a model off by a constant 1 %
fn rms_over_mean(x: &[f64]) -> f64 {
    let d: Vec<f64> = x.iter().copied().filter(|&v| v > 0.0).collect();
    let n = d.len() as f64;
    (d.iter().map(|v| v * v).sum::<f64>() / n).sqrt() / (d.iter().sum::<f64>() / n)
}

#[test]
fn the_fit_recovers_ten_percent_soiling() {
    let (kw, ghi) = basis();
    let meter: Vec<f64> = kw.iter().map(|x| 0.9 * x).collect();
    let r = run(&kw, &ghi, &meter, 0.0, 1.0);
    let f = r.at("fit");
    assert!(close(f.get("soiling", 0.0), 0.10, 1e-12));
    assert!(!f.getb("at_bound", true));
    assert!(close(f.get("availability", 0.0), 1.0, 1e-12));
    assert!(f.at("soiling_monthly").arr().iter().all(|x| close(x.num(0.0), 0.10, 1e-12)));
    assert!(f.at("own_month").arr().iter().all(|x| x.boolean(false)));
    assert!(f.at("after").get("rmse_kw", 1.0) < 1e-9);
    assert!(close(f.get("rmse_gain", 0.0), 1.0, 1e-9));
    assert!(close(r.at("stats").at("all").get("mbe", 0.0), 1.0 / 0.9 - 1.0, 1e-12));
    // with the project's own soiling the fit adds to it: 0.9 x (1 - 2 %)
    let r2 = run(&kw, &ghi, &meter, 0.02, 1.0);
    assert!(close(r2.at("fit").get("soiling", 0.0), 1.0 - 0.9 * 0.98, 1e-12));
}

#[test]
fn a_monthly_profile_and_the_bound() {
    let (kw, ghi) = basis();
    let loss = |m: usize| 0.01 * m as f64;
    let meter: Vec<f64> = (0..HOURS).map(|i| kw[i] * (1.0 - loss(month(i)))).collect();
    let f = run(&kw, &ghi, &meter, 0.0, 1.0).at("fit").clone();
    for m in 0..12 { assert!(close(f.at("soiling_monthly").idx(m).num(0.0), loss(m), 1e-12), "month {m}"); }
    assert!(f.at("after_monthly").get("rmse_kw", 1.0) < 1e-9);
    assert!(f.get("rmse_gain_monthly", 0.0) > f.get("rmse_gain", 0.0));
    let half: Vec<f64> = kw.iter().map(|x| 0.5 * x).collect();
    let r = run(&kw, &ghi, &half, 0.0, 1.0);
    assert_eq!(r.at("fit").get("soiling", 0.0), 0.30);
    assert!(r.at("fit").getb("at_bound", false));
    assert!(r.at("notes").arr().iter().any(|n| n.str().contains("30 %")));
}

#[test]
fn zeros_in_good_sun_are_outages_and_left_out_of_the_fit() {
    let (kw, ghi) = basis();
    let mut meter = kw.clone();
    let mut out = Vec::new();
    for d in (10..360).step_by(7) {
        for h in 10..14 { let i = d * 24 + h; meter[i] = 0.0; out.push(i); }
        meter[d * 24 + 6] = 0.0;   // early morning, GHI below 200 W/m²: low output, not an outage
    }
    let r = run(&kw, &ghi, &meter, 0.0, 1.0);
    assert_eq!(r.get("outage_h", 0.0) as usize, out.len());
    assert_eq!(r.at("outages").len(), 20);
    let s = r.at("stats").at("running");
    assert!(s.get("rmse_kw", 0.0) > 0.0 && s.get("rmse_kw", 9.0) < 2.0, "only the morning hours differ");
    let f = r.at("fit");
    let lost: f64 = out.iter().map(|&i| kw[i]).sum::<f64>() / kw.iter().sum::<f64>();
    assert!(close(f.get("availability", 0.0), 1.0 - lost, 1e-12));
    assert!(f.get("soiling", 1.0) < 1e-3, "the outages do not count as soiling");
    assert_eq!(r.at("monthly").idx(0).get("outage_h", 0.0), 12.0);   // days 10, 17 and 24 in January
    assert!(f.get("rmse_gain", -1.0) > 0.0);
}

#[test]
fn a_partial_year_and_monthly_sums() {
    let (kw, ghi) = basis();
    let (a, b) = (MONTH_START[2] as usize * 24, MONTH_START[4] as usize * 24);   // March and April only
    let meter: Vec<f64> = (0..HOURS).map(|i| if (a..b).contains(&i) { 0.95 * kw[i] + 1.0 * f64::from(u8::from(kw[i] > 0.0)) } else { f64::NAN }).collect();
    let r = run(&kw, &ghi, &meter, 0.0, 1.0);
    assert_eq!(r.get("hours", 0.0) as usize, b - a);
    let mo = r.at("monthly");
    for m in 0..12 {
        let x = mo.idx(m);
        let h: Vec<usize> = (0..HOURS).filter(|&i| month(i) == m && !meter[i].is_nan()).collect();
        assert_eq!(x.get("hours", -1.0) as usize, h.len());
        assert!(close(x.get("meter_kwh", -1.0), h.iter().map(|&i| meter[i]).sum(), 1e-9));
        assert!(close(x.get("model_kwh", -1.0), h.iter().map(|&i| kw[i]).sum(), 1e-9));
        assert_eq!(x.at("dev").is_null(), h.is_empty(), "month {m}");
        assert_eq!(r.at("fit").at("own_month").idx(m).boolean(true), m == 2 || m == 3);
    }
    let dev = mo.idx(2).get("dev", 0.0);
    assert!(close(dev, mo.idx(2).get("model_kwh", 0.0) / mo.idx(2).get("meter_kwh", 1.0) - 1.0, 1e-12));
    assert!(r.at("notes").arr().iter().any(|n| n.str().contains("three months")));
    // a day of data is too little
    let day: Vec<f64> = (0..HOURS).map(|i| if i < 24 { kw[i] } else { f64::NAN }).collect();
    assert!(reconcile(&ModelBasis { kw: &kw, ghi: &ghi, soiling: [0.0; 12], availability: 1.0, kwp: KWP }, &day).unwrap_err().0.contains("at least 24"));
}

fn example() -> Project {
    let t = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json")).unwrap();
    parse_project(&Value::parse(&t).unwrap())
}

fn meter_of(v: Vec<Value>) -> Value {
    let mut o = Value::object();
    o.set("kw", v);
    o
}

#[test]
fn the_project_model_against_itself() {
    let p = example();
    let prof = compute_pv_profile(&p).unwrap();
    let kw: Vec<Value> = prof.ac_per_kwp.iter().map(|x| Value::from(x * p.pv.capacity_kwp)).collect();
    let r = pv_reconcile(&p, &meter_of(kw)).unwrap();
    assert_eq!(r.at("stats").at("all").get("rmse_kw", 1.0), 0.0);
    assert_eq!(r.at("project").get("soiling", 0.0), 0.02);
    assert!(r.at("project").at("soiling_monthly").is_null());
    // the request as the interface sends it, with a partial year in nulls
    let (e, dir) = engine();
    let mut v: Vec<Value> = prof.ac_per_kwp.iter().map(|x| Value::from(0.9 * x * p.pv.capacity_kwp)).collect();
    for x in v.iter_mut().skip(4000) { *x = Value::Null; }
    let t = format!(r#"{{"project":{},"meter":{}}}"#, std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json")).unwrap(), meter_of(v).dump());
    let r = Value::parse(&e.pv_reconcile(&Value::parse(&t).unwrap()).unwrap()).unwrap();
    assert_eq!(r.get("hours", 0.0), 4000.0);
    assert!(close(r.at("fit").get("soiling", 0.0), 1.0 - 0.9 * 0.98 * 0.99, 1e-9));
    assert!(e.pv_reconcile(&Value::parse(r#"{"project":{},"meter":{"kw":[]}}"#).unwrap()).unwrap_err().0.contains("weather"));
    std::fs::remove_dir_all(dir).ok();
}

fn engine() -> (Engine, PathBuf) {
    let dir = std::env::temp_dir().join(format!("soloptima-reconcile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    (Engine::with_weather(repo, dir.to_str().unwrap(), WeatherService::new(Box::new(MockHttp::default()))).unwrap(), dir)
}

#[test]
fn bad_meter_values_are_refused() {
    let mut p = example();
    let ok = || vec![Value::Null; HOURS];
    let err = |p: &Project, v: Vec<Value>| pv_reconcile(p, &meter_of(v)).unwrap_err().0;
    assert!(err(&p, vec![Value::Null; 100]).contains("8760"));
    assert!(pv_reconcile(&p, &Value::Null).unwrap_err().0.contains("8760"));
    let mut v = ok();
    v[12] = Value::from("5");
    assert!(err(&p, v).contains("not a number"));
    let mut v = ok();
    v[12] = Value::from(f64::INFINITY);
    assert!(err(&p, v).contains("finite"));
    let mut v = ok();
    v[12] = Value::from(-1.0);
    assert!(err(&p, v).contains("negative at 1 Jan 12:00"));
    let mut v = ok();
    v[12] = Value::from(1e9);
    assert!(err(&p, v).contains("ten times"));
    assert!(err(&p, ok()).contains("Only 0 daylight hours"));
    p.pv.capacity_kwp = 0.0;
    assert!(err(&p, ok()).contains("PV capacity"));
}

// ---------------------------------------------------------------- import (series, kind "pv")

fn stamp(t: i64) -> String {
    let (y, m, d) = civil_from_days(t.div_euclid(1440));
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", t.rem_euclid(1440) / 60, t % 60)
}

fn opt(extra: &str) -> Value {
    Value::parse(&format!(r#"{{"kind":"pv","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","units":"kw","utc_offset":7{extra}}}"#)).unwrap()
}

/// 15-minute PV output for days `from..to` of 2025 (local standard time), `f` giving the value of each quarter hour
fn file(from: i64, to: i64, f: impl Fn(i64) -> String) -> String {
    let t0 = days_from_civil(2025, 1, 1) * 1440;
    let mut s = String::from("time,pv_kw\n");
    for q in from * 96..to * 96 { s += &format!("{},{}\n", stamp(t0 + 15 * q), f(q)); }
    s
}

fn pv_q(q: i64) -> f64 { let h = (q % 96) as f64 / 4.0; if (6.0..18.0).contains(&h) { 50.0 } else { 0.0 } }

#[test]
fn import_a_partial_year_in_local_time() {
    let r = import_series(&file(31, 59, |q| pv_q(q).to_string()), &opt("")).unwrap();   // February
    let kw = r.at("kw").arr();
    assert_eq!(kw.len(), HOURS);
    assert!(kw[..31 * 24].iter().all(Value::is_null) && kw[59 * 24..].iter().all(Value::is_null));
    assert_eq!(kw[31 * 24 + 12].num(0.0), 50.0);
    assert_eq!(kw[31 * 24 + 3].num(-1.0), 0.0);
    let rep = r.at("report");
    assert_eq!(rep.get("missing_h", 0.0) as usize, HOURS - 28 * 24);
    assert_eq!(rep.get("filled_h", 1.0), 0.0);
    assert!(!r.has("long_gap") && !r.has("kw_sub"));
    // energy per interval: kWh per quarter hour is 4 x the mean kW
    let r = import_series(&file(31, 59, |q| (pv_q(q) / 4.0).to_string()), &opt(r#","units":"kwh_interval""#)).unwrap();
    assert_eq!(r.at("kw").idx(31 * 24 + 12).num(0.0), 50.0);
    // from UTC stamps: hour 12 local is hour 5 UTC
    let r = import_series(&file(31, 59, |q| pv_q(q).to_string()), &opt(r#","time_basis":"utc""#)).unwrap();
    assert_eq!(r.at("kw").idx(31 * 24 + 6 + 7).num(0.0), 50.0);
    assert_eq!(r.at("kw").idx(31 * 24 + 18 + 7).num(-1.0), 0.0);
}

#[test]
fn import_handles_bad_rows_duplicates_and_negatives() {
    // non-finite cells, a year out of range and a duplicate stamp: the rows are counted, nothing panics
    let mut s = file(31, 38, |q| match q % 400 { 0 => "NaN".into(), 1 => "inf".into(), _ => pv_q(q).to_string() });
    s += "2500-02-03 12:00,50\n2025-02-03 12:00,70\n";
    let r = import_series(&s, &opt("")).unwrap();
    let rep = r.at("report");
    assert_eq!(rep.get("n_bad", 0.0), 5.0);   // q = 3200, 3201, 3600, 3601 and the year 2500
    assert_eq!(rep.get("duplicates", 0.0), 1.0);
    assert_eq!(r.at("kw").idx(33 * 24 + 12).num(0.0), (50.0 * 3.0 + 60.0) / 4.0);   // the duplicate averaged into its quarter hour
    // a small negative at night (the inverters' own use) becomes 0 and is counted; a large one is refused
    let r = import_series(&file(31, 38, |q| if pv_q(q) > 0.0 { "50".into() } else { "-0.2".into() }), &opt("")).unwrap();
    assert_eq!(r.at("kw").idx(31 * 24 + 2).num(-1.0), 0.0);
    assert_eq!(r.at("report").get("negative_h", 0.0), 7.0 * 12.0);
    let e = import_series(&file(31, 38, |q| if pv_q(q) > 0.0 { "50".into() } else { "-5".into() }), &opt("")).unwrap_err().0;
    assert!(e.contains("negative in 84 h"), "{e}");
    // too little data, no output, no column
    assert!(import_series(&file(31, 31, |_| "1".into()), &opt("")).is_err());
    assert!(import_series(&file(31, 32, |_| "0".into()), &opt("")).unwrap_err().0.contains("never above zero"));
    let short = "time,pv\n2025-02-01 10:00,5\n2025-02-01 11:00,5\n";
    assert!(import_series(short, &opt("")).unwrap_err().0.contains("at least 24 h"));
    assert!(import_series(&file(31, 32, |_| "1".into()), &opt(r#","cols":[]"#)).unwrap_err().0.contains("PV columns"));
    assert!(import_series("time,pv\n", &opt("")).is_err());
    assert!(import_series("", &opt("")).unwrap_err().0.contains("empty"));
    // the size limit of the import command holds for PV files too
    let (e, dir) = engine();
    let mut big = Value::object();
    big.set("text", "1,".repeat(33 << 20));
    big.set("options", opt(""));
    assert!(e.import_series(&big).unwrap_err().0.contains("64 MB"));
    std::fs::remove_dir_all(dir).ok();
}
