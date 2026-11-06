//! The C++ self-tests of the forecast-based EMS (tests/test_engine.cpp): section 3 for the predictive strategy on its own
//! forecasters (sim.rs runs it on perfect forecasts), the auxiliary-load and day-ahead parts of section 19 (UTC offsets) and
//! section 20 (the day-ahead schedule: current hour, 29 February, the end of the data, wind turbines, errors). They run on
//! the synthetic 1 MW project of the C++ tests. The comparison with the C++ answers themselves is in ems_parity.rs.
use soloptima_engine::ems::day_ahead_schedule;
use soloptima_engine::pv::{clearsky_ghi, clearsky_pv_per_kwp, compute_pv_profile};
use soloptima_engine::sim::{simulate, SimInput, SimResult, Sizing};
use soloptima_engine::weather::{epoch_h_to_iso, iso_to_epoch_h};
use soloptima_engine::*;

/// Synthetic clear-ish year: GHI from the clear-sky model scaled by a daily cloud factor (make_project of test_engine.cpp)
fn make_project(lat: f64, lon: f64) -> Project {
    let mut p = Project::default();
    p.loc.lat = lat;
    p.loc.lon = lon;
    p.loc.utc_offset = (lon / 15.0).round();
    p.wx.is_utc = true;
    p.wx.time_offset = 0.5;
    p.wx.ghi = clearsky_ghi(&p).unwrap();
    for i in 0..HOURS { p.wx.ghi[i] *= 0.6 + 0.35 * (((i / 24) as f64) * 1.7).sin(); }
    p.wx.tamb = vec![27.0; HOURS];
    p.wx.wind = vec![1.5; HOURS];
    p.load_kw = (0..HOURS).map(|i| 1000.0 + 200.0 * (((i % 24) as f64) / 24.0 * 6.283).sin()).collect();
    p.dg.unit_kw = 400.0;
    p.dg.units = 5;
    p.pv.capacity_kwp = 1500.0;
    p.pv.azimuth = if lat >= 0.0 { 180.0 } else { 0.0 };
    p.bess.energy_kwh = 2000.0;
    p.bess.power_kw = 1000.0;
    p.econ.lifetime = 20;
    p
}

const SZ: Sizing = Sizing { pv_kwp: 1500.0, bess_kwh: 2000.0, bess_kw: 1000.0, wind_units: 0.0 };
const SZW: Sizing = Sizing { pv_kwp: 1500.0, bess_kwh: 2000.0, bess_kw: 1000.0, wind_units: 2.0 };

/// simulate as the C++ engine calls it: the project's PV, clear-sky reference and wind, forecasters built from p.ems
fn sim(p: &Project, s: Sizing, hourly: bool) -> SimResult {
    let pv = compute_pv_profile(p).unwrap().ac_per_kwp;
    let cs = clearsky_pv_per_kwp(p).unwrap();
    let wind = if s.wind_units > 0.5 { pv::wind_per_turbine(p).unwrap() } else { vec![] };
    simulate(p, &SimInput { pv_per_kwp: &pv, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None }, &s, hourly).unwrap()
}

fn num(v: &Value, k: &str) -> f64 { v.at(k).num(f64::NAN) }
fn time(v: &Value) -> &str { v.at("time_utc").str() }

/// Section 3 for the predictive strategy with the project's forecasters (smart persistence for PV, the 7-day profile for
/// the load): the energy balance holds, the SOC stays in its window, gensets run within their limits and nothing is unmet.
#[test]
fn predictive_on_its_forecasters() {
    let mut q = make_project(-2.5, 115.5);
    q.dg.strategy = "predictive".into();
    q.econ.lifetime = 3;   // the predictive EMS over 20 years is slow in a debug build; 3 years still age the battery
    let r = sim(&q, SZ, true);
    let h = r.hourly.as_ref().unwrap();
    let mut be = 0.0f64;
    for t in 0..HOURS {
        be = be.max((h.load[t] - (h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.unmet[t])).abs());
        be = be.max((h.pv_avail[t] - (h.pv_to_load[t] + h.pv_to_bess[t] + h.pv_curtailed[t])).abs());
        assert!(h.soc[t] >= q.bess.soc_min - 1e-6 && h.soc[t] <= q.bess.soc_max + 1e-6, "SOC out of window at {t}");
        assert!(h.gen_units[t] >= f64::from(q.dg.min_units_online), "min units violated at {t}");
        if h.gen_units[t] > 0.0 {
            let g = h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t];
            assert!(g >= h.gen_units[t] * q.dg.unit_kw * q.dg.min_load - 1e-6 && g <= h.gen_units[t] * q.dg.unit_kw + 1e-6, "genset loading at {t}");
        }
    }
    assert!(be < 1e-6 * 1500.0 + 0.05, "balance error {be}");
    assert!(r.unmet_fraction < 1e-9, "unmet {}", r.unmet_fraction);
    assert_eq!(r.years.len(), 3);
    // the forecasts are real ones: neither perfect nor empty
    assert!(r.fc.pv_nmae_h1 > 0.0 && r.fc.pv_nmae_da > r.fc.pv_nmae_h1 * 0.5 && r.fc.load_nmae_da > 0.0 && r.fc.plans > 0,
            "forecast statistics {:?}", r.fc);
}

/// Section 19, the simulation and day-ahead parts: at +7.5 h the auxiliary load is the mean of +7 h and +8 h and its yearly
/// energy is unchanged; the schedule keeps PV on the forecast's UTC hours and averages the local-time load over each,
/// whichever end of the hour the forecast stamps.
#[test]
fn half_hour_offset_auxiliaries_and_schedule() {
    let mut a = make_project(-7.5, 112.5);
    for i in 0..HOURS {
        a.wx.wind[i] = 6.0 + 3.0 * (i as f64 * 0.37).sin() + 2.0 * (((i / 24) as f64) * 0.9).sin();
        a.wx.tamb[i] = 28.0 + 5.0 * (((i % 24) as f64) / 24.0 * 6.283 - 2.0).sin();
    }
    a.wind.units = 2;
    a.wind.rated_kw = 1000.0;
    a.aux.bess_kw_per_mwh = 1.0;
    a.aux.bess_temp_coeff = 0.03;
    a.aux.ref_c = 25.0;
    a.sim.all_years = false;
    let at = |off: f64| { let mut q = a.clone(); q.loc.utc_offset = off; q };
    let aux_of = |q: &Project| sim(q, SZW, true).hourly.unwrap().aux;
    let (x7, x75, x8) = (aux_of(&at(7.0)), aux_of(&at(7.5)), aux_of(&at(8.0)));
    let (mut e_x, mut d78, mut s7, mut s75) = (0.0f64, 0.0f64, 0.0, 0.0);
    for t in 0..HOURS {
        e_x = e_x.max((x75[t] - 0.5 * (x7[t] + x8[t])).abs());
        d78 = d78.max((x7[t] - x8[t]).abs());
        s7 += x7[t];
        s75 += x75[t];
    }
    assert!(e_x < 1e-12 && d78 > 0.0, "+7.5 h auxiliaries are not the mean of +7 h and +8 h: {e_x}");
    assert!((s75 / s7 - 1.0).abs() < 1e-12, "yearly auxiliary energy moves with the UTC offset: {s75} vs {s7} kWh");

    // day-ahead schedule: 36 forecast hours from 2023-03-01 00:00 UTC (written as the C++ test writes them, std::to_string)
    let (mut ts, mut ghi, mut tamb, mut wind) = (vec![], vec![], vec![], vec![]);
    for h in 0..36 {
        ts.push(format!("\"2023-03-{:02}T{:02}:00\"", 1 + h / 24, h % 24));
        ghi.push(format!("{:.6}", f64::max(0.0, 900.0 * (((h % 24) as f64 - 23.0) / 12.0 * 3.14159).sin())));   // daylight 00-11 UTC
        tamb.push((27 + h % 5).to_string());
        wind.push("5".to_string());
    }
    let js = format!(r#"{{"time_offset":0.5,"times":[{}],"ghi":[{}],"tamb":[{}],"wind":[{}]}}"#, ts.join(","), ghi.join(","), tamb.join(","), wind.join(","));
    let fc = Value::parse(&js).unwrap();
    let rows = |f: &Value, off: f64| {
        let mut q = at(off);
        q.aux = AuxParams::default();
        day_ahead_schedule(&q, &SZ, f, 0.5, 1.0, "", 0).unwrap().at("rows").arr().to_vec()
    };
    let (r55, r5) = (rows(&fc, 5.5), rows(&fc, 5.0));
    let (mut e_load, mut e_pvs, mut pv_sum) = (0.0f64, 0.0f64, 0.0);
    let hoy0 = 59 * 24;   // 1 March 00:00 UTC
    for i in 0..36 {
        let l = hoy0 + i + 5;   // UTC hour i spans the second half of local hour L and the first half of L + 1
        e_load = e_load.max((num(&r55[i], "load_kw") - 0.5 * (a.load_kw[l] + a.load_kw[l + 1])).abs());
        e_pvs = e_pvs.max((num(&r55[i], "pv_kw") - num(&r5[i], "pv_kw")).abs());
        pv_sum += num(&r55[i], "pv_kw");
    }
    assert!(r55.len() == 36 && e_load < 1e-9 && e_pvs == 0.0 && pv_sum > 1000.0,
            "schedule at +5.5 h: load off the mean of the two local hours by {e_load} kW, PV off the UTC hours by {e_pvs} kW");
    // the same forecast stamped at the end of each hour, as Open-Meteo does (time_offset -0.5), gives the same load and PV
    let mut fe = fc.clone();
    fe.set("time_offset", -0.5);
    let e0 = iso_to_epoch_h("2023-03-01T00:00").unwrap();
    fe.set("times", (0..36).map(|h| Value::from(epoch_h_to_iso(e0 + h + 1))).collect::<Vec<Value>>());
    let mut e_end = 0.0f64;
    for (off, rs) in [(5.0, &r5), (5.5, &r55)] {
        let re = rows(&fe, off);
        for i in 0..36 {
            e_end = e_end.max((num(&re[i], "load_kw") - num(&rs[i], "load_kw")).abs()).max((num(&re[i], "pv_kw") - num(&rs[i], "pv_kw")).abs());
        }
    }
    assert!(e_end == 0.0, "schedule on stamps at the end of the hour: load or PV off the rows stamped at the start by {e_end} kW");
}

/// `hours` rows from `start` (UTC) as the C++ test builds them; 29 February is cloudy. null_at: a row without irradiance.
fn forecast(start: &str, hours: i64, toff: f64, null_at: i64) -> Value {
    let (mut t, mut g, mut ta, mut w) = (vec![], vec![], vec![], vec![]);
    for h in 0..hours {
        let e = iso_to_epoch_h(start).unwrap() + h;
        let hh = e % 24;
        let day = if epoch_h_to_iso(e).starts_with("2028-02-29") { 0.3 } else { 1.0 };
        t.push(Value::from(epoch_h_to_iso(e)));
        g.push(if h == null_at { Value::Null } else { Value::from(day * f64::max(0.0, 950.0 * (3.14159 * (hh as f64 - 5.5) / 12.0).sin())) });
        ta.push(Value::from(27 + hh % 5));
        w.push(Value::from(8.0));
    }
    let mut f = Value::object();
    f.set("time_offset", toff);
    f.set("times", t);
    f.set("ghi", g);
    f.set("tamb", ta);
    f.set("wind", w);
    f
}

/// Section 20: the schedule starts at the current hour, runs on consecutive hours across 29 February, ends at the first hour
/// without irradiance and adds wind turbines. Without a current time every hour is kept.
#[test]
fn day_ahead_schedule_section_20() {
    let e0 = iso_to_epoch_h("2028-02-28T00:00").unwrap();
    assert!(iso_to_epoch_h("1970-01-01T00:00Z") == Some(0) && iso_to_epoch_h("2028-02-29T00:00:00Z") == Some(e0 + 24)
            && iso_to_epoch_h("2028-03-01T00:00") == Some(e0 + 48) && iso_to_epoch_h("2028-02-28T05:59") == Some(e0 + 5)
            && iso_to_epoch_h("2027-02-29T00:00").is_none() && iso_to_epoch_h("2028-02-28T05:20+08:00").is_none()
            && iso_to_epoch_h("2028-02-28T24:00").is_none() && iso_to_epoch_h("").is_none(), "ISO time to epoch hours");
    assert!(epoch_h_to_iso(e0 + 29) == "2028-02-29T05:00" && epoch_h_to_iso(e0 + 48) == "2028-03-01T00:00" && epoch_h_to_iso(-1) == "1969-12-31T23:00",
            "epoch hours to ISO time");

    // 72 h from 2028-02-28 00:00 UTC, stamped at the end of each hour as Open-Meteo does
    let mut p = make_project(0.5, 10.0);
    p.wind.rated_kw = 1000.0;
    let das = |p: &Project, s: &Sizing, f: &Value, now: &str, max_h: i32| day_ahead_schedule(p, s, f, 0.5, 1.0, now, max_h);
    let fc = forecast("2028-02-28T00:00", 72, -0.5, -1);
    let a = das(&p, &SZ, &fc, "2028-02-28T05:20", 0).unwrap();
    let ra = a.at("rows").arr();
    let mut consecutive = ra.len() == 66;
    let (mut pv28, mut pv29, mut pv01) = (0.0, 0.0, 0.0);
    for (k, r) in ra.iter().enumerate() {
        let t = time(r);
        consecutive = consecutive && t == epoch_h_to_iso(e0 + 6 + k as i64);
        *(if t < "2028-02-29" { &mut pv28 } else if t < "2028-03-01" { &mut pv29 } else { &mut pv01 }) += num(r, "pv_kw");
    }
    assert!(!ra.is_empty() && time(&ra[0]) == "2028-02-28T06:00" && a.at("plan_start_utc").str() == "2028-02-28T05:00",
            "schedule from 05:20 starts at {} (plan start {})", time(&ra[0]), a.at("plan_start_utc").str());
    assert!(consecutive && pv29 < 0.5 * pv28 && pv01 > 0.9 * pv28 && pv01 < 1.1 * pv28,
            "rows across 29 February: {} rows, consecutive {consecutive}, PV {pv28} / {pv29} / {pv01} kWh", ra.len());
    // MET Norway stamps the start of the hour: the row at 05:00 covers 05-06
    let m = das(&p, &SZ, &forecast("2028-02-28T00:00", 72, 0.5, -1), "2028-02-28T05:20", 24).unwrap();
    assert!(m.at("rows").len() == 24 && time(m.at("rows").idx(0)) == "2028-02-28T05:00" && m.at("plan_start_utc").str() == "2028-02-28T05:00",
            "MET Norway rows from 05:20");
    // the download time stands in for the current time
    let mut fi = forecast("2028-02-28T00:00", 72, -0.5, -1);
    fi.set("issued_utc", "2028-02-28T05:20:11Z");
    let ai = das(&p, &SZ, &fi, "", 0).unwrap();
    assert!(ai.at("rows").dump() == a.at("rows").dump() && ai.at("plan_start_utc").str() == "2028-02-28T05:00"
            && ai.at("issued_utc").str() == "2028-02-28T05:20:11Z", "the forecast's issued_utc does not set the plan start");

    // a null irradiance at 2028-03-01 10:00 ends the plan with the hour before
    let b = das(&p, &SZ, &forecast("2028-02-28T00:00", 72, -0.5, 58), "2028-02-28T05:20", 0).unwrap();
    assert!(b.at("rows").len() == 52 && time(b.at("rows").idx(51)) == "2028-03-01T09:00" && b.at("note").str().contains("No data from 2028-03-01T10:00"),
            "null irradiance: {} rows", b.at("rows").len());

    // two turbines in 8 m/s wind: wind output in every hour, less diesel, and every row balances
    let c = das(&p, &SZW, &fc, "2028-02-28T05:20", 48).unwrap();
    let (mut wmin, mut w0, mut bal) = (1e9f64, 0.0f64, 0.0f64);
    for r in c.at("rows").arr() {
        wmin = wmin.min(num(r, "wind_kw"));
        bal = bal.max((num(r, "load_kw") - (num(r, "pv_kw") + num(r, "wind_kw") + num(r, "bess_kw") + num(r, "gen_kw") + num(r, "unmet_kw")
            - num(r, "curtail_kw"))).abs());
    }
    let c0 = das(&p, &SZ, &fc, "2028-02-28T05:20", 48).unwrap();
    for r in c0.at("rows").arr() { w0 = w0.max(num(r, "wind_kw")); }
    let (g1, g0) = (num(c.at("totals"), "gen_kwh"), num(c0.at("totals"), "gen_kwh"));
    assert!(c.at("rows").len() == 48 && wmin > 0.0 && w0 == 0.0 && g1 < g0 && num(c.at("totals"), "wind_used_kwh") > 0.0 && bal < 1e-6,
            "wind in the schedule: least {wmin} kW, diesel {g1} vs {g0} kWh without, row balance {bal} kW");
    // the forecast wind is at 10 m whatever height the project's weather measures it at
    let mut p80 = p.clone();
    p80.wind.ref_height = 80.0;
    assert!(das(&p80, &SZW, &fc, "2028-02-28T05:20", 48).unwrap().at("rows").dump() == c.at("rows").dump(),
            "the schedule shears the forecast wind from the project's measurement height");

    // no current time: every hour is kept (2027 has no 29 February); dropping rows does not change the others
    let fnn = forecast("2027-02-27T00:00", 48, -0.5, -1);
    let d = das(&p, &SZ, &fnn, "", 0).unwrap();
    let d3 = das(&p, &SZ, &fnn, "2027-02-26T23:59", 48).unwrap();
    assert!(d.at("rows").len() == 48 && time(d.at("rows").idx(0)) == "2027-02-27T00:00" && d.at("plan_start_utc").str() == "2027-02-26T23:00"
            && d.dump() == d3.dump(), "schedule without a current time: {} rows", d.at("rows").len());
    let fails = |f: &Value, now: &str| das(&p, &SZ, f, now, 0).is_err();
    let mut gap = fnn.clone();
    if let Value::Obj(o) = &mut gap { if let Some(Value::Arr(t)) = o.get_mut("times") { t[10] = "2027-02-27T11:00".into(); } }
    assert!(fails(&gap, "") && fails(&fnn, "2027-03-02T00:00") && fails(&fnn, "yesterday") && !fails(&fnn, "2027-02-28T22:10"),
            "schedule accepts a gap in the hours, a forecast that has ended or a bad current time");
    assert!(fails(&forecast("2027-02-27T00:00", 48, 1e30, -1), "") && fails(&forecast("2027-02-27T00:00", 48, f64::NAN, -1), "")
            && fails(&forecast("2027-02-27T00:00", 48, 1.5, -1), "2027-02-27T05:20"), "schedule accepts a forecast time offset outside -1 h to +1 h");
}
