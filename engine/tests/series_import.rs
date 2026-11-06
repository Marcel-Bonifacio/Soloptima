//! Import of load and weather files against the C++ engine. The scenarios are the files of the "import" cases of
//! tests/test_engine.cpp plus formats and errors; tests/gen_series_fixtures.cpp ran each through the C++ `import_series`
//! and wrote what it answered (engine/tests/fixtures/import.json). Hashes are FNV-1a, 64 bit.
use soloptima_engine::calendar::{civil_from_days, days_from_civil};
use soloptima_engine::{import_series, Value};
use std::path::PathBuf;

const HOURS: i64 = 8760;

fn fnv(s: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    format!("{h:016x}")
}
fn stamp(t: i64, style: char) -> String {
    let (y, m, d) = civil_from_days(t / 1440);
    let (hh, mm) = (t % 1440 / 60, t % 60);
    match style {
        'i' => format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}Z"),
        'w' => format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}"),
        _ => format!("{d:02}/{m:02}/{y:04} {hh:02}:{mm:02}"),
    }
}
fn f6(x: f64) -> String { format!("{x:.6}") }   // std::to_string(double)
fn v15(k: i64) -> f64 { 500.0 + (k * 37 % 101) as f64 + 0.25 * (k % 4) as f64 }

struct Case { name: String, text: String, opt: String }
fn case(name: &str, text: impl Into<String>, opt: impl Into<String>) -> Case { Case { name: name.into(), text: text.into(), opt: opt.into() } }

fn scenarios() -> Vec<Case> {
    let t25 = days_from_civil(2025, 1, 1) * 1440;
    let mut c = Vec::new();
    let mut q = String::from("time,load_kw,flag\n");
    for k in 0..35040 { if k / 4 != 1000 { q += &format!("{},{},1\n", stamp(t25 + 15 * k, 'i'), f6(v15(k))); } }
    let load = |basis: &str, label: &str, units: &str, off: i32, extra: &str| format!(r#"{{"kind":"load","time_col":0,"cols":[1{extra}],"time_basis":"{basis}","label":"{label}","units":"{units}","utc_offset":{off}}}"#);
    c.push(case("15 min utc", &q, load("utc", "start", "kw", 0, "")));
    c.push(case("15 min kwh", &q, load("utc", "start", "kwh_interval", 0, "")));
    c.push(case("15 min utc+8", &q, load("utc", "start", "kw", 8, "")));
    c.push(case("15 min w", &q, load("utc", "start", "w", 0, "")));
    c.push(case("15 min fill_long", &q, load("utc", "instant", "kw", 0, ",2").replace("}", r#","fill_long":true}"#)));
    let mut e = String::from("Timestamp;Load (kW)\n");
    for k in 0..HOURS { e += &format!("{};{},5\n", stamp(t25 + 60 * (k + 1), 'w'), 1000 + k); }
    c.push(case("end stamps", e, load("local_standard", "auto", "kw", 8, "")));
    let (mut d, mut dm) = (String::from("time,kw\n"), String::from("date,kw\n"));
    for k in 0..HOURS {
        d += &format!("{},{}\n", stamp(t25 + 60 * k, 'w'), 2000 + k);
        dm += &format!("{},{}\n", stamp(t25 + 60 * k, 'd'), 2000 + k);
    }
    d += &format!("{},2510\n", stamp(t25 + 60 * 500, 'w'));
    let hourly = load("local_standard", "start", "kw", 8, "");
    c.push(case("duplicate", &d, &hourly));
    c.push(case("negative", d.replacen(",2000\n", ",-5\n", 1), &hourly));
    c.push(case("dmy", &dm, &hourly));
    c.push(case("dmy ambiguous", &dm[..dm.find("13/01/2025").unwrap()], &hourly));
    let mut xs = String::from("serial,kw\n");
    for k in 0..HOURS { xs += &format!("{:.8},{}\n", 45658.0 + k as f64 / 24.0, 2000 + k); }
    c.push(case("excel", xs, &hourly));
    let mut two = String::from("time,kw\n");
    let t24 = days_from_civil(2024, 1, 1) * 1440;
    for k in 0..(366 + 365) * 24 { two += &format!("{},{}\n", stamp(t24 + 60 * k, 'w'), k / 24); }
    let y = |extra: &str| format!(r#"{{"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start",{extra}"utc_offset":0}}"#);
    c.push(case("year 2024", &two, y(r#""year":2024,"#)));
    c.push(case("year auto", &two, y("")));
    c.push(case("year 2030", &two, y(r#""year":2030,"#)));
    let l12 = y(r#""year":"last12","#);
    c.push(case("last12 two years", &two, &l12));
    let mut last12 = |name: &str, a: (i32, u32, u32), b: (i32, u32, u32)| {
        let (a, b) = (days_from_civil(a.0, a.1, a.2), days_from_civil(b.0, b.1, b.2));
        let mut f = String::from("time,kw\n");
        for k in 0..(b - a + 1) * 24 { f += &format!("{},{}\n", stamp(a * 1440 + 60 * k, 'w'), k / 24); }
        c.push(case(name, f, &l12));
    };
    last12("last12 jul-jun", (2023, 7, 1), (2024, 6, 30));
    last12("last12 mar-feb leap", (2023, 3, 1), (2024, 2, 29));
    last12("last12 2022-23", (2022, 7, 1), (2023, 6, 30));
    let wx = |from: i64, to: i64| {
        let mut w = String::from("time,ghi,temp\n");
        for k in 0..HOURS {
            if k < from || k >= to { w += &format!("{},{},27\n", stamp(t25 + 60 * k, 'i'), f6((900.0 * (((k % 24 - 6) as f64) / 12.0 * 3.14159).sin()).max(0.0))); }
        }
        w
    };
    let wopt = r#"{"kind":"weather","time_col":0,"ghi":1,"tamb":2,"time_basis":"utc","label":"start","utc_offset":8}"#;
    c.push(case("weather gap 5", wx(4000, 4005), wopt));
    c.push(case("weather gap 80", wx(2000, 2080), wopt));
    c.push(case("weather gap 2 at start", wx(0, 2), wopt));
    c.push(case("weather metadata", format!("Latitude (decimal degrees):\t45.000\nElevation (m):\t250\n\n\nSlope: 0 deg. \n{}", wx(0, 0)), wopt));
    c.push(case("weather kelvin km/h", wx(0, 0), r#"{"kind":"weather","time_col":0,"ghi":1,"tamb":2,"wind":2,"temp_units":"k","wind_units":"km_h","irr_units":"wh_m2_interval","time_basis":"local_standard","label":"end","utc_offset":-5}"#));
    c.push(case("weather no ghi", "time,x\n2025-01-01 00:00,1\n2025-01-01 01:00,2\n", wopt));
    let mut lt = String::from("Logger export; site A\n");
    for k in 0..HOURS { lt += &format!("{},{}\n", stamp(t25 + 60 * k, 'w'), 2000 + k); }
    c.push(case("title line", lt, &hourly));
    let mut pos = String::from("load\n");
    for k in 0..35040 { pos += &format!("{}\n", f6(v15(k))); }
    let popt = r#"{"kind":"load","time_col":-1,"cols":[0],"time_basis":"local_standard","units":"kw","utc_offset":8}"#;
    c.push(case("positional", &pos, popt));
    let third = pos.match_indices('\n').nth(2).unwrap().0 + 1;
    let mut pbad = pos.clone();
    pbad.replace_range(third..third + 3, "n/a");
    c.push(case("positional bad", pbad, popt));
    c.push(case("positional short", "load\n1\n2\n3\n", popt));
    let mut wpos = String::from("ghi,temp\n");
    for k in 0..HOURS {
        let g = if k == 100 { String::new() } else { f6(if k % 24 > 6 && k % 24 < 18 { 600.0 } else { 0.0 }) };
        wpos += &format!("{g},20\n");
    }
    c.push(case("positional weather", wpos, r#"{"kind":"weather","time_col":-1,"ghi":0,"tamb":1,"time_basis":"utc","utc_offset":3}"#));
    let mut cl = String::from("time,kw\n");
    let (dst_on, dst_off) = (days_from_civil(2025, 3, 30) * 1440 + 60, days_from_civil(2025, 10, 26) * 1440 + 60);
    for k in 0..HOURS {
        let u = t25 - 60 + 60 * k;
        cl += &format!("{},{}\n", stamp(u + if u >= dst_on && u < dst_off { 120 } else { 60 }, 'w'), k);
    }
    c.push(case("clock dst", &cl, format!(r#"{{"kind":"load","time_col":0,"cols":[1],"time_basis":"local_clock","label":"start","utc_offset":1,"clock":{{"start":1,"changes":[[{dst_on},2],[{dst_off},1]]}}}}"#)));
    c.push(case("clock as standard", &cl, load("local_standard", "start", "kw", 1, "")));
    let stamps = |style: &str| {
        let mut f = String::from("t,kw\n");
        for k in 0..24 * 40 {
            let t = t25 + 60 * k;
            let (y, m, dd) = civil_from_days(t / 1440);
            let hh = t % 1440 / 60;
            let s = match style {
                "us12" => format!("{m}/{dd}/{y:04} {}:00 {}", if hh % 12 == 0 { 12 } else { hh % 12 }, if hh < 12 { "AM" } else { "PM" }),
                "pvgis" => format!("{y:04}{m:02}{dd:02}:{hh:02}10"),
                "tz" => format!("{y:04}-{m:02}-{dd:02}T{hh:02}:00:00+08:00"),
                "dots" => format!("{dd:02}.{m:02}.{y:04} {hh:02}:00:00"),
                _ => format!("{m}/{dd}/{:02} {hh}:00", y % 100),
            };
            f += &format!("{s},{}\n", k % 50);
        }
        f
    };
    for s in ["us12", "pvgis", "tz", "dots", "short"] {
        c.push(case(&format!("stamp {s}"), stamps(s), r#"{"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","utc_offset":2}"#));
    }
    let mut two_col = String::from("date,time,kw\n");
    for k in 0..24 * 40 { let w = stamp(t25 + 60 * k, 'w'); two_col += &format!("{},{},{}\n", &w[..10], &w[11..], k % 17); }
    c.push(case("date and time columns", two_col, r#"{"kind":"load","time_col":0,"time2_col":1,"cols":[2],"time_basis":"utc","label":"start"}"#));
    c.push(case("no options", "a\n1\n", "[]"));
    c.push(case("unknown unit", &hourly, r#"{"kind":"load","time_col":0,"cols":[1],"units":"gw"}"#));
    c.push(case("no cols", &hourly, r#"{"kind":"load","time_col":0,"cols":[]}"#));
    c.push(case("same col", &hourly, r#"{"kind":"load","time_col":1,"cols":[1]}"#));
    c.push(case("empty file", "  \n\n", &hourly));
    c.push(case("offset 20", &hourly, r#"{"kind":"load","time_col":0,"cols":[1],"utc_offset":20}"#));
    c.push(case("load last12 weather", wx(0, 0), r#"{"kind":"weather","time_col":0,"ghi":1,"year":"last12"}"#));
    c.push(case("unreadable times", "t,kw\nfoo,1\nbar,2\n", &hourly));
    c
}

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/import.json");
    Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn every_scenario_gives_what_the_cpp_import_gives() {
    let want = fixture();
    let cases = scenarios();
    assert_eq!(cases.len(), want.len());
    for (c, w) in cases.iter().zip(want.arr()) {
        assert_eq!(c.name, w.at("name").str());
        assert_eq!(fnv(&c.text), w.at("text").str(), "the file of {:?} differs from the C++ one", c.name);
        let got = import_series(&c.text, &Value::parse(&c.opt).unwrap());
        match got {
            Err(e) => assert_eq!(format!("ERR {e}"), w.at("status").str(), "{}", c.name),
            Ok(r) => {
                assert_eq!(w.at("status").str(), "OK", "{} answered, C++ refused", c.name);
                assert_eq!(r.at("report").dump(), w.at("report").str(), "report of {}", c.name);
                assert_eq!(fnv(&r.dump()), w.at("hash").str(), "result of {}", c.name);
            }
        }
    }
}

fn run(text: &str, opt: &str) -> Value { import_series(text, &Value::parse(opt).unwrap()).unwrap() }
fn kw(r: &Value, h: usize) -> f64 { r.at("kw").idx(h).num(0.0) }

// the checks of tests/test_engine.cpp, on values
#[test]
fn quarter_hours_become_exact_hourly_means_with_the_gap_filled() {
    let cs = scenarios();
    let a = run(&cs[0].text, &cs[0].opt);
    let rep = a.at("report");
    let mut worst = 0.0f64;
    for h in 0..HOURS as usize {
        if h != 1000 { worst = worst.max((kw(&a, h) - (v15(4 * h as i64) + v15(4 * h as i64 + 1) + v15(4 * h as i64 + 2) + v15(4 * h as i64 + 3)) / 4.0).abs()); }
    }
    assert!(a.at("kw").len() == 8760 && worst == 0.0 && rep.get("interval_min", 0.0) == 15.0 && rep.get("missing_h", 0.0) == 1.0 && rep.get("filled_h", 0.0) == 1.0);
    assert!((kw(&a, 1000) - (kw(&a, 999) + kw(&a, 1001)) / 2.0).abs() < 1e-9);
    let b = run(&cs[1].text, &cs[1].opt);
    assert!((0..8760).all(|h| (kw(&b, h) - 4.0 * kw(&a, h)).abs() < 1e-9));
    let c8 = run(&cs[2].text, &cs[2].opt);
    assert!((8..8760).filter(|&h| h - 8 != 1000).all(|h| kw(&c8, h) == kw(&a, h - 8)));
    assert_eq!((c8.at("report").get("missing_h", 0.0), c8.at("report").get("year", 0.0)), (9.0, 2025.0));
}

#[test]
fn interval_end_stamps_duplicates_dates_and_excel_serials() {
    let cs = scenarios();
    let by = |n: &str| cs.iter().find(|c| c.name == n).unwrap();
    let en = run(&by("end stamps").text, &by("end stamps").opt);
    assert!(kw(&en, 0) == 1000.5 && kw(&en, 8759) == 1000.5 + 8759.0 && en.at("report").gets("label", "") == "end");
    let du = run(&by("duplicate").text, &by("duplicate").opt);
    assert!(kw(&du, 500) == 2505.0 && kw(&du, 501) == 2501.0 && du.at("report").get("duplicates", 0.0) == 1.0 && du.at("report").get("out_of_order", 0.0) == 1.0);
    let neg = import_series(&by("negative").text, &Value::parse(&by("negative").opt).unwrap()).unwrap_err();
    assert!(neg.0.contains("negative in 1 h"));
    let dd = run(&by("dmy").text, &by("dmy").opt);
    assert!(dd.at("report").gets("date_order", "") == "dmy" && (0..8760).all(|h| kw(&dd, h) == 2000.0 + h as f64));
    let xl = run(&by("excel").text, &by("excel").opt);
    assert!(xl.at("report").gets("first", "") == "2025-01-01 00:00" && xl.at("report").getb("excel", false) && kw(&xl, 0) == 2000.0 && kw(&xl, 8759) == 2000.0 + 8759.0);
}

#[test]
fn years_last_twelve_months_weather_gaps_and_clock_time() {
    let cs = scenarios();
    let by = |n: &str| cs.iter().find(|c| c.name == n).unwrap();
    let r = |n: &str| run(&by(n).text, &by(n).opt);
    let (y4, ya, yl) = (r("year 2024"), r("year auto"), r("last12 two years"));
    assert!(kw(&y4, 58 * 24) == 58.0 && kw(&y4, 59 * 24) == 60.0 && kw(&y4, 8759) == 365.0 && ya.at("report").get("year", 0.0) == 2024.0);
    assert!(kw(&yl, 0) == 366.0 && kw(&yl, 8759) == 730.0 && y4.at("report").get("missing_h", 1.0) == 0.0);
    assert_eq!(r("last12 jul-jun").at("report").gets("period", ""), "2023-07-01 to 2024-06-30");
    assert_eq!(r("last12 mar-feb leap").at("report").gets("period", ""), "2023-03-01 to 2024-02-28");
    assert_eq!(r("last12 2022-23").at("report").gets("period", ""), "2022-07-01 to 2023-06-30");
    let w5 = r("weather gap 5");
    assert!(w5.at("ghi").len() == 8760 && w5.at("report").at("missing").get("ghi", 0.0) == 5.0 && w5.at("report").get("filled_h", 0.0) == 5.0
        && w5.getb("is_utc", false) && w5.get("time_offset", 0.0) == 0.5 && w5.at("wind").is_empty());
    assert!(import_series(&by("weather gap 80").text, &Value::parse(&by("weather gap 80").opt).unwrap()).unwrap_err().0.contains("72 h"));
    let wm = r("weather metadata");
    assert!(wm.at("report").gets("delimiter", "") == "," && wm.at("report").get("header_lines", 0.0) == 4.0);
    assert_eq!(r("title line").at("report").gets("delimiter", ""), ",");
    let pbad = import_series(&by("positional bad").text, &Value::parse(&by("positional bad").opt).unwrap()).unwrap_err();
    assert!(pbad.0.contains("Line 4"));
    let (ck, cs2) = (r("clock dst"), r("clock as standard"));
    assert!((0..8760).all(|h| kw(&ck, h) == h as f64));
    assert!(ck.at("report").get("missing_h", 1.0) == 0.0 && ck.at("report").get("duplicates", 1.0) == 0.0 && !ck.at("report").getb("dst_suspect", true));
    assert!(cs2.at("report").getb("dst_suspect", false) && cs2.at("report").get("duplicates", 0.0) == 1.0);
}
