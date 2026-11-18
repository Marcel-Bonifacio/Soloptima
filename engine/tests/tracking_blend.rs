//! MPP tracking loss and the local-maximum rule of the bypass-diode model, forecast errors by weather class, and the blend of
//! two forecast providers with fixed weights. No test here touches the network: the fetch runs on saved responses.
use soloptima_engine::ems::{day_ahead_schedule, day_classes, forecast_benchmark, forecast_benchmark_with};
use soloptima_engine::pv::clearsky_ghi;
use soloptima_engine::shading::bypass_power;
use soloptima_engine::sim::Sizing;
use soloptima_engine::weather::{blend_forecasts, blend_weights, MockHttp, WeatherService};
use soloptima_engine::*;
use std::path::PathBuf;

/// Synthetic year with a daily cloud factor, as in pv_detail.rs
fn make_project(lat: f64, lon: f64) -> Project {
    let mut p = Project::default();
    p.loc.lat = lat;
    p.loc.lon = lon;
    p.loc.utc_offset = (lon / 15.0).round();
    p.wx.time_offset = 0.5;
    p.wx.ghi = clearsky_ghi(&p).unwrap();
    for i in 0..HOURS { p.wx.ghi[i] *= 0.6 + 0.35 * (((i / 24) as f64) * 1.7).sin(); }
    p.wx.tamb = vec![27.0; HOURS];
    p.wx.wind = vec![1.5; HOURS];
    p.load_kw = vec![1000.0; HOURS];
    p.pv.azimuth = if lat >= 0.0 { 180.0 } else { 0.0 };
    p
}
fn prof(p: &Project) -> PVProfile { compute_pv_profile(p).unwrap() }
fn close(a: f64, b: f64, tol: f64) -> bool { (a - b).abs() <= tol * b.abs().max(1e-12) }

#[test]
fn mppt_loss_scales_the_dc_power_before_the_inverter() {
    let mut p = make_project(20.0, 30.0);
    p.pv.dc_ac_ratio = 0.5;   // no clipping, so the chain after the tracker is linear
    let base = prof(&p);
    let mut zero = p.clone();
    zero.pv.mppt_loss = 0.0;
    assert_eq!(prof(&zero), base, "0 % changes nothing");
    assert!(base.step("After MPP tracking").is_none(), "no step at 0 %");

    let mut q = p.clone();
    q.pv.mppt_loss = 0.01;
    let r = prof(&q);
    let names: Vec<&str> = r.losses.iter().map(|l| l.name.as_str()).collect();
    let at = |n: &str| names.iter().position(|&x| x == n).unwrap();
    assert_eq!(at("After MPP tracking"), at("After mismatch, wiring, LID, quality") + 1);
    assert_eq!(at("After inverter efficiency"), at("After MPP tracking") + 1);
    assert_eq!(r.losses.len(), base.losses.len() + 1);
    // the DC side is untouched, everything from the tracker on falls by exactly the factor
    let dc = r.step("After mismatch, wiring, LID, quality").unwrap();
    assert_eq!(dc, base.step("After mismatch, wiring, LID, quality").unwrap());
    assert!(close(r.step("After MPP tracking").unwrap(), 0.99 * dc, 1e-9));
    for n in ["After inverter efficiency", "After inverter clipping", "After AC / transformer losses", "After availability (energy available)"] {
        assert!(close(r.step(n).unwrap(), 0.99 * base.step(n).unwrap(), 1e-12), "{n}");
    }
    assert!(close(r.specific_yield, 0.99 * base.specific_yield, 1e-12));
    assert_eq!(r.m_dc, base.m_dc, "EArray is the array's output, before the tracker");

    // validation and parsing like the other losses
    for (v, ok) in [(0.0, true), (0.1, true), (0.11, false), (-0.01, false)] {
        let mut x = p.clone();
        x.pv.mppt_loss = v;
        assert_eq!(validate_project(&x).is_ok(), ok, "{v}");
    }
    let parsed = parse_project(&Value::parse(r#"{"pv":{"mppt_loss":0.005,"mppt_local":true}}"#).unwrap());
    assert!(parsed.pv.mppt_loss == 0.005 && parsed.pv.mppt_local);
    let plain = parse_project(&Value::parse(r#"{"pv":{}}"#).unwrap());
    assert!(plain.pv.mppt_loss == 0.0 && !plain.pv.mppt_local);
}

#[test]
fn a_tracker_from_full_voltage_can_stop_at_a_lower_maximum() {
    // two strong substrings and two weak ones: maxima at 2 substrings (2.0) and at all 4 (0.8)
    let two_peak = [1.0, 0.2, 1.0, 0.2];
    let (g, l) = (bypass_power(&mut two_peak.clone(), false), bypass_power(&mut two_peak.clone(), true));
    assert_eq!(g, 0.5);
    assert_eq!(l, 0.2);
    // one maximum: both agree
    for b in [[1.0; 4], [1.0, 1.0, 1.0, 0.9], [0.5, 0.5, 0.5, 0.5], [0.0, 0.0, 0.0, 0.0]] {
        assert_eq!(bypass_power(&mut b.clone(), false), bypass_power(&mut b.clone(), true), "{b:?}");
    }
    // a fully shaded substring: the tracker climbs off the zero-power end
    assert_eq!(bypass_power(&mut [1.0, 1.0, 1.0, 0.0], true), 0.75);
    // never above the global maximum
    let mut x = 0.37f64;
    for _ in 0..500 {
        let mut b: Vec<f64> = (0..6).map(|_| { x = (x * 9301.0 + 0.4927).fract(); x }).collect();
        let g = bypass_power(&mut b.clone(), false);
        assert!(bypass_power(&mut b, true) <= g);
    }

    // on a shaded layout the option gives at most the yield of the global maximum, and nothing without bypass diodes
    let mut p = make_project(35.0, 10.0);
    p.pv.tilt = 25.0;
    p.pv.gcr = 0.4;
    p.pv.dc_ac_ratio = 1.0;
    let pitch = p.pv.row_width / p.pv.gcr;
    let depth = p.pv.row_width * p.pv.tilt.to_radians().cos();
    p.layout.areas.push(LayoutArea { pts: vec![[-200.0, -200.0], [200.0, -200.0], [200.0, 200.0], [-200.0, 200.0]], ..Default::default() });
    for r in 0..3 {
        for k in 0..4 {
            let (x, y) = (k as f64 * 21.0, -(r as f64) * pitch);
            p.layout.tables.push([[x, y + depth], [x + 20.0, y + depth], [x + 20.0, y], [x, y]]);
        }
    }
    let (cx, cy, rad) = (40.0, -32.0, 3.0);
    p.layout.obstacles.push(Obstacle { height: 10.0, pts: (0..16).map(|k| { let a = k as f64 * std::f64::consts::PI / 8.0; [cx + rad * a.sin(), cy + rad * a.cos()] }).collect(), ..Default::default() });
    p.pv.near_model = "bypass".into();
    let global = prof(&p).specific_yield;
    let mut q = p.clone();
    q.pv.mppt_local = true;
    let local = prof(&q).specific_yield;
    assert!(local <= global && local > 0.9 * global, "local {local}, global {global}");
    let mut lin = p.clone();
    lin.pv.near_model = "linear".into();
    let mut lin_local = lin.clone();
    lin_local.pv.mppt_local = true;
    assert_eq!(prof(&lin_local), prof(&lin), "the option acts only with bypass diodes");
}

#[test]
fn days_split_by_clear_sky_index() {
    // clear-sky output 10 at noon only, so the daily index is the noon output over 10 (0.7 and 0.3 exactly on the thresholds)
    let mut cs = vec![0.0; HOURS];
    for d in 0..365 { cs[d * 24 + 12] = 10.0; }
    let mut act = cs.clone();
    for (d, x) in [(0, 9.0), (1, 5.0), (2, 1.0), (3, 7.0), (4, 3.0), (5, 7.1), (6, 2.9)] { act[d * 24 + 12] = x; }
    cs[7 * 24 + 12] = 0.0;   // polar night
    act[7 * 24 + 12] = 0.0;
    let c = day_classes(&act, &cs);
    assert_eq!(c.len(), 365);
    assert_eq!(&c[..9], &[Some(0), Some(1), Some(2), Some(1), Some(1), Some(0), Some(2), None, Some(0)]);
}

#[test]
fn errors_by_weather_class_add_up_to_the_year() {
    let mut p = make_project(20.0, 30.0);
    p.load_kw = (0..HOURS).map(|i| 1000.0 + 300.0 * (i as f64 * 0.37).sin()).collect();   // persistence has an error
    let plain = forecast_benchmark(&p, false).unwrap();
    assert!(!plain.has("weather_classes"), "nothing new unless asked");
    let r = forecast_benchmark_with(&p, false, true).unwrap();
    for k in ["pv", "load"] { assert_eq!(r.at(k).dump(), plain.at(k).dump(), "{k} unchanged"); }
    let wc = r.at("weather_classes");
    assert_eq!(wc.at("thresholds").dump(), "[0.3,0.7]");
    let cl = wc.at("classes").arr();
    assert_eq!(cl.len(), 3);
    let days: f64 = cl.iter().map(|c| c.get("days", 0.0)).sum();
    assert_eq!(days, 365.0);
    assert!(cl.iter().filter(|c| c.get("days", 0.0) > 0.0).count() >= 2, "the synthetic year has more than one class");
    for var in ["pv", "load"] {
        let n: f64 = cl.iter().map(|c| c.at(var).get("hours", 0.0)).sum();
        for (m, all) in r.at(var).at("methods").arr().iter().enumerate() {
            for l in [0, 5, 23, 47] {
                let (mut ae, mut se) = (0.0, 0.0);
                for c in cl {
                    let (h, x) = (c.at(var).get("hours", 0.0), c.at(var).at("methods").idx(m));
                    assert_eq!(x.at("id").str(), all.at("id").str());
                    ae += h * x.at("nmae").idx(l).num(0.0);
                    se += h * x.at("nrmse").idx(l).num(0.0).powi(2);
                    if h > 0.0 && x.at("id").str() == "perfect" { assert_eq!(x.at("skill").idx(l).num(0.0), 1.0); }
                    if h > 0.0 && x.at("id").str() == "persistence" { assert_eq!(x.at("skill").idx(l).num(1.0), 0.0); }
                }
                let id = all.at("id").str();
                assert!(close(ae / n, all.at("nmae").idx(l).num(0.0), 1e-9), "{var} {id} lead {l}: nMAE");
                assert!(close((se / n).sqrt(), all.at("nrmse").idx(l).num(0.0), 1e-9), "{var} {id} lead {l}: nRMSE");
            }
        }
    }
}

/// An Open-Meteo style document (stamps the end of each hour) and a MET Norway style one (stamps the start)
fn om_doc(first_end: &str, n: usize) -> Value {
    let h0 = weather::iso_to_epoch_h(first_end).unwrap();
    let mut o = Value::object();
    o.set("provider", "Open-Meteo");
    o.set("time_offset", -0.5);
    o.set("issued_utc", "2026-06-01T05:10:00Z");
    o.set("times", Value::Arr((0..n).map(|i| weather::epoch_h_to_iso(h0 + i as i64).into()).collect()));
    let ghi: Vec<f64> = (0..n).map(|i| (((i % 24) as f64 - 6.0) / 12.0 * std::f64::consts::PI).sin().max(0.0) * 800.0).collect();
    o.set("dhi", ghi.iter().map(|g| g * 0.3).collect::<Vec<f64>>());
    o.set("dni", ghi.iter().map(|g| g * 0.9).collect::<Vec<f64>>());
    o.set("ghi", ghi);
    o.set("tamb", vec![28.0; n]);
    o.set("wind", vec![3.0; n]);
    o.set("note", "OM.");
    o
}
fn met_doc(first_start: &str, n: usize) -> Value {
    let h0 = weather::iso_to_epoch_h(first_start).unwrap();
    let mut o = Value::object();
    o.set("provider", "MET Norway");
    o.set("time_offset", 0.5);
    o.set("issued_utc", "2026-06-01T05:10:00Z");
    o.set("model_updated_utc", "2026-06-01T03:00:00Z");
    o.set("times", Value::Arr((0..n).map(|i| weather::epoch_h_to_iso(h0 + i as i64).into()).collect()));
    o.set("ghi", (0..n).map(|i| 100.0 + i as f64).collect::<Vec<f64>>());
    o.set("tamb", vec![24.0; n]);
    o.set("wind", vec![5.0; n]);
    o.set("note", "MET.");
    o
}

#[test]
fn blend_weights_sum_to_one_and_a_provider_with_all_of_it_comes_through() {
    let w = blend_weights(&[1.0, 3.0]).unwrap();
    assert_eq!(w, vec![0.25, 0.75]);
    assert!((blend_weights(&[0.2, 0.3, 0.5]).unwrap().iter().sum::<f64>() - 1.0).abs() < 1e-15);
    for bad in [&[0.0, 0.0][..], &[-0.1, 1.0], &[f64::NAN, 1.0], &[]] { assert!(blend_weights(bad).is_err(), "{bad:?}"); }

    // Open-Meteo from 00:00 UTC (first row ends 01:00), MET Norway from 05:00 for 10 h: the blend covers 05:00 to 14:00
    let (om, met) = (om_doc("2026-06-01T01:00", 72), met_doc("2026-06-01T05:00", 10));
    let b = blend_forecasts(&[(om.clone(), 1.0), (met.clone(), 1.0)]).unwrap();
    assert_eq!(b.at("times").len(), 10);
    assert_eq!(b.at("times").idx(0).str(), "2026-06-01T05:00");
    assert_eq!(b.get("time_offset", 0.0), 0.5);
    assert_eq!(b.gets("provider", ""), "Open-Meteo + MET Norway");
    assert_eq!(b.gets("model_updated_utc", ""), "2026-06-01T03:00:00Z");
    let ws: f64 = b.at("weights").arr().iter().map(|x| x.get("weight", 0.0)).sum();
    assert_eq!(ws, 1.0);
    // the hour 05:00-06:00 is Open-Meteo's row stamped 06:00 (index 5) and MET Norway's first row
    let g = 0.5 * om.at("ghi").idx(5).num(0.0) + 0.5 * met.at("ghi").idx(0).num(0.0);
    assert_eq!(b.at("ghi").idx(0).num(-1.0), g);
    assert_eq!(b.at("tamb").idx(0).num(0.0), 26.0);
    assert_eq!(b.at("dhi").idx(0).num(-1.0), g, "Open-Meteo dark, MET Norway light: all diffuse");
    let g = 0.5 * om.at("ghi").idx(8).num(0.0) + 0.5 * met.at("ghi").idx(3).num(0.0);
    assert!(om.at("ghi").idx(8).num(0.0) > 0.0 && close(b.at("dhi").idx(3).num(0.0), 0.3 * g, 1e-12), "Open-Meteo's diffuse share kept");

    let only_om = blend_forecasts(&[(om.clone(), 1.0), (met.clone(), 0.0)]).unwrap();
    let only_met = blend_forecasts(&[(om.clone(), 0.0), (met.clone(), 1.0)]).unwrap();
    for k in 0..10 {
        for key in ["ghi", "dhi", "dni", "tamb", "wind"] { assert_eq!(only_om.at(key).idx(k), om.at(key).idx(k + 5), "{key} {k}"); }
        for key in ["ghi", "tamb", "wind"] { assert_eq!(only_met.at(key).idx(k), met.at(key).idx(k), "{key} {k}"); }
    }
    // a value one provider lacks stays missing
    let mut gap = met.clone();
    let mut wind = gap.at("wind").arr().to_vec();
    wind[3] = Value::Null;
    gap.set("wind", wind);
    assert!(blend_forecasts(&[(om.clone(), 1.0), (gap, 1.0)]).unwrap().at("wind").idx(3).is_null());
    assert!(blend_forecasts(&[(om_doc("2026-06-05T01:00", 24), 1.0), (met, 1.0)]).is_err(), "no common hour");
}

fn example() -> Project {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/examples/example_study.json");
    parse_project(&Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap())
}

#[test]
fn the_schedule_on_a_blend_with_all_weight_on_one_provider_is_that_provider_s() {
    let p = example();
    let s = Sizing { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, wind_units: f64::from(p.wind.units), gen_units: None };
    let om = om_doc("2026-06-01T01:00", 72);
    let blend = blend_forecasts(&[(om.clone(), 1.0), (met_doc("2026-06-01T00:00", 60), 0.0)]).unwrap();
    let a = day_ahead_schedule(&p, &s, &om, 0.5, 1.0, "2026-06-01T05:00", 24).unwrap();
    let b = day_ahead_schedule(&p, &s, &blend, 0.5, 1.0, "2026-06-01T05:00", 24).unwrap();
    assert_eq!(a.gets("plan_start_utc", ""), b.gets("plan_start_utc", ""));
    let (ra, rb) = (a.at("rows").arr(), b.at("rows").arr());
    assert_eq!(ra.len(), 24);
    assert_eq!(ra.len(), rb.len());
    for (x, y) in ra.iter().zip(rb) {
        for k in ["load_kw", "pv_kw", "bess_kw", "soc", "units", "gen_kw", "fuel_l"] {
            assert!(close(y.get(k, 0.0), x.get(k, 0.0), 1e-9) || (x.get(k, 0.0) - y.get(k, 0.0)).abs() < 1e-9, "{k}: {} vs {}", x.get(k, 0.0), y.get(k, 0.0));
        }
    }
}

#[test]
fn the_blend_fetches_both_providers_and_no_other_host() {
    // the saved responses answer only these two URLs; any other request fails the fetch
    let (lat, lon) = (7.25, 80.5);
    let om_url = "https://api.open-meteo.com/v1/forecast?latitude=7.25000&longitude=80.50000&hourly=shortwave_radiation,diffuse_radiation,direct_normal_irradiance,temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=GMT&forecast_days=3";
    let met_url = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=7.25000&lon=80.50000";
    let n = 72;
    let col = |f: &dyn Fn(usize) -> f64| (0..n).map(|i| format!("{}", f(i))).collect::<Vec<_>>().join(",");
    let times = (0..n).map(|i| format!("\"2026-06-{:02}T{:02}:00\"", 1 + i / 24, i % 24)).collect::<Vec<_>>().join(",");
    let om_body = format!(r#"{{"hourly":{{"time":[{times}],"shortwave_radiation":[{}],"diffuse_radiation":[{}],"direct_normal_irradiance":[{}],"temperature_2m":[{}],"wind_speed_10m":[{}]}}}}"#,
                          col(&|i| if (6..18).contains(&(i % 24)) { 500.0 } else { 0.0 }), col(&|_| 50.0), col(&|_| 300.0), col(&|_| 27.0), col(&|_| 2.0));
    let inst = (0..60).map(|i| format!(r#"{{"time":"2026-06-{:02}T{:02}:00:00Z","data":{{"instant":{{"details":{{"air_temperature":25.0,"cloud_area_fraction":40.0,"wind_speed":3.0}}}}}}}}"#, 1 + (i + 5) / 24, (i + 5) % 24))
        .collect::<Vec<_>>().join(",");
    let met_body = format!(r#"{{"properties":{{"meta":{{"updated_at":"2026-06-01T03:00:00Z"}},"timeseries":[{inst}]}}}}"#);
    let m = MockHttp::default();
    m.ok(om_url, om_body);
    m.ok(met_url, met_body);
    let svc = WeatherService::new(Box::new(m)).with_clock(|| 1_780_290_000);
    let b = svc.fetch_forecast_blend(lat, lon, 2, "", 0.4).unwrap();
    assert_eq!(b.gets("provider", ""), "Open-Meteo + MET Norway");
    assert_eq!(b.at("times").len(), 48, "MET Norway's 48 hours from 05:00");
    let w: Vec<f64> = b.at("weights").arr().iter().map(|x| x.get("weight", 0.0)).collect();
    assert!(close(w[0], 0.6, 1e-15) && close(w[1], 0.4, 1e-15));
    assert!(svc.fetch_forecast_blend(lat, lon, 2, "", 1.5).is_err());
}
