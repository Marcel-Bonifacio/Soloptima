//! The last checks of the C++ self-tests (tests/test_engine.cpp, deleted in session 2.12) that no other test held: section 9's
//! loss carry-forward, the billed energy of section 12, the monthly PV balances and the wind split of section 15, the whole of
//! section 16 (variability) and the linear degradation and weather closure of section 24. They run on the C++ test project.
#![allow(clippy::approx_constant)]   // 6.283 and 3.1416 are the test inputs of the C++ self-tests, kept as written
use soloptima_engine::finance::{parse_finance, run_finance};
use soloptima_engine::optimizer::Progress;
use soloptima_engine::pv::{clearsky_ghi, clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine, PVProfile};
use soloptima_engine::resource::{exceedance, resource_years, UncertaintyBudget, WeatherYear};
use soloptima_engine::sim::{simulate, SimInput, SimResult, Sizing};
use soloptima_engine::solar::sun_position;
use soloptima_engine::weather::{pvgis_split_years, MockHttp, WeatherService};
use soloptima_engine::{data_qc, parse_weather, Project, Value, HOURS};
use std::sync::atomic::Ordering::Relaxed;

/// make_project of tests/test_engine.cpp: a synthetic clear-ish year, GHI from the clear-sky model scaled by a daily cloud factor
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

fn size(pv_kwp: f64, bess_kwh: f64, bess_kw: f64) -> Sizing { Sizing { pv_kwp, bess_kwh, bess_kw, wind_units: 0.0 } }

/// simulate(p, profile, clear-sky profile, s, hourly) of the C++ engine
fn sim(p: &Project, prof: &PVProfile, cs: &[f64], s: Sizing, hourly: bool) -> SimResult {
    let wind = if s.wind_units > 0.5 { wind_per_turbine(p).unwrap() } else { Vec::new() };
    simulate(p, &SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_cs_per_kwp: cs, wind_per_turbine: &wind, forecast: None }, &s, hourly).unwrap()
}

fn setup() -> (Project, PVProfile, Vec<f64>) {
    let p = make_project(-2.5, 115.5);
    let prof = compute_pv_profile(&p).unwrap();
    let cs = clearsky_pv_per_kwp(&p).unwrap();
    (p, prof, cs)
}

fn j(s: &str) -> Value { Value::parse(s).unwrap() }

/// Section 9: loss carry-forward lowers the lifetime tax compared with no carry-forward
#[test]
fn loss_carry_forward_lowers_tax() {
    let (mut q, prof, cs) = setup();
    q.sim.all_years = true;
    let (h, b) = (sim(&q, &prof, &cs, size(1500.0, 2000.0, 1000.0), false), sim(&q, &prof, &cs, Sizing::default(), false));
    let tax = |cf: i32| -> f64 {
        let js = format!(r#"{{"model":"ppa","components":[{{"name":"E","v1":0.2}}],"loss_cf_years":{cf},"dep_method":"db","dep_life":4,"gearing":0.8}}"#);
        let r = run_finance(&q, &parse_finance(&j(&js)), &h.fin_sim(), &b.fin_sim(), 0.0);
        r.at("years").arr().iter().map(|y| y.get("tax", 0.0)).fold(0.0, |a, x| a + x)
    };
    assert!(tax(0) < tax(-1), "loss carry-forward did not reduce tax ({} vs {})", tax(0), tax(-1));
}

/// Section 12: the billed energy of a host-owned plant is the renewable share of the energy served to the site
#[test]
fn billed_energy_on_served_site_energy() {
    let (mut q, prof, cs) = setup();
    q.sim.all_years = false;
    q.aux.bess_kw_per_mwh = 1.0;
    let r1 = sim(&q, &prof, &cs, size(1500.0, 2000.0, 1000.0), true);
    let b = sim(&q, &prof, &cs, Sizing::default(), false);
    let y1 = &r1.years[0];
    assert!((y1.aux - 17520.0).abs() < 1e-6, "battery auxiliary {} kWh", y1.aux);
    let fy = run_finance(&q, &parse_finance(&j(r#"{"model":"host"}"#)), &r1.fin_sim(), &b.fin_sim(), 0.0);
    let e = fy.at("years").idx(1).get("energy", f64::NAN);
    assert!((e - y1.served_site * y1.re_fraction).abs() < 1e-6, "billed energy {e} not on served site energy");
}

/// Section 15: monthly PV balances add up to the annual loss chain; wind to the load and to the battery is the wind used
#[test]
fn monthly_pv_balances_and_wind_split() {
    let (p, prof, cs) = setup();
    let (mut ya, mut poa, mut ghi, mut dc) = (0.0, 0.0, 0.0, 0.0);
    for m in 0..12 {
        ya += prof.m_avail[m];
        poa += prof.m_poa[m];
        ghi += prof.m_ghi[m];
        dc += prof.m_dc[m];
        assert!(prof.m_dhi[m] >= 0.0 && prof.m_dhi[m] <= prof.m_ghi[m] + 1e-9 && prof.m_eff[m] <= prof.m_poa[m], "month {} irradiation out of order", m + 1);
        assert!((prof.m_tamb[m] - 27.0).abs() < 1e-9, "month {} mean ambient {}", m + 1, prof.m_tamb[m]);
    }
    assert!((ya - prof.specific_yield).abs() < 1e-9, "monthly energy available {ya} vs specific yield {}", prof.specific_yield);
    assert!((poa - prof.poa_annual).abs() < 1e-9, "monthly plane-of-array {poa} vs annual {}", prof.poa_annual);
    assert!((ghi - prof.ghi_annual).abs() < 1e-9, "monthly GHI {ghi} vs annual {}", prof.ghi_annual);
    assert!((dc - prof.losses[8].value).abs() < 1e-9, "monthly array energy {dc} vs loss chain {}", prof.losses[8].value);

    let mut w = p.clone();
    w.sim.all_years = false;
    for i in 0..HOURS { w.wx.wind[i] = 5.0 + 3.0 * (i as f64 / 7.0).sin(); }
    w.wind.units = 2;
    w.wind.rated_kw = 500.0;
    let y = sim(&w, &prof, &cs, Sizing { pv_kwp: 1500.0, bess_kwh: 2000.0, bess_kw: 1000.0, wind_units: 2.0 }, false).years[0].clone();
    assert!(y.wind_to_load > 0.0 && (y.wind_to_load + y.wind_to_bess - y.wind_used).abs() < 1e-6 * y.wind_used,
            "wind used {} vs to load + to battery {}", y.wind_used, y.wind_to_load + y.wind_to_bess);
}

/// Section 16: PVGIS years split by calendar year (29 February dropped)
#[test]
fn pvgis_years_split_by_calendar_year() {
    let mdays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut rows = Value::array();
    for y in [2019, 2020] {
        for mo in 1..=12 {
            for d in 1..=mdays[mo - 1] + i32::from(mo == 2 && y == 2020) {
                for h in 0..24 {
                    let day = (7..=16).contains(&h);
                    let mut r = Value::object();
                    r.set("time", format!("{y:04}{mo:02}{d:02}:{h:02}30"));
                    r.set("Gb(i)", if day { 400.0 } else { 0.0 });
                    r.set("Gd(i)", if day { 100.0 } else { 0.0 });
                    r.set("H_sun", if day { 45.0 } else { 0.0 });
                    r.set("T2m", if mo == 2 && d == 29 { 99.0 } else { mo as f64 });
                    r.set("WS10m", 2.0);
                    rows.push(r);
                }
            }
        }
    }
    let mut out = Value::object();
    out.set("hourly", rows);
    let mut d = Value::object();
    d.set("outputs", out);
    let svc = WeatherService::new(Box::new(MockHttp::default()));
    let ys = pvgis_split_years(&svc, &d, -2.5, 115.5);
    assert_eq!(ys.len(), 2, "PVGIS rows split into {} years", ys.len());
    for k in 0..2 {
        let w = parse_weather(ys.idx(k));
        assert!(w.ghi.len() == HOURS && w.tamb.len() == HOURS && w.dni.len() == HOURS, "year {k}: {} hours", w.ghi.len());
        assert!(!w.tamb.contains(&99.0), "year {k} keeps 29 Feb");
        assert!(w.tamb[58 * 24 + 23] == 2.0 && w.tamb[59 * 24] == 3.0, "year {k}: 28 Feb / 1 Mar");
        let dni = 400.0 / (45.0 * 3.14159265358979 / 180.0f64).sin();
        assert!((w.ghi[12] - 500.0).abs() < 1e-9 && (w.dni[12] - dni).abs() < 1e-9 && w.time_offset == 0.5, "year {k} irradiance split");
    }
    assert_eq!((ys.idx(0).gets("years", ""), ys.idx(1).gets("years", "")), ("2019".to_string(), "2020".to_string()));
}

/// Section 16: P90 of one year = M0 (1 - 1.2816 sigma_1); the 10-year average is less uncertain
#[test]
fn exceedance_values() {
    let m = [950.0, 1000.0, 1050.0, 980.0, 1020.0];
    let x = exceedance(1000.0, &m, 0.8, 0.055, true);
    let var: f64 = m.iter().map(|v| (v / 1000.0 - 1.0) * (v / 1000.0 - 1.0)).fold(0.0, |a, b| a + b);   // mean of m is 1000
    let s1 = (var / 4.0 + 0.8 * 0.055 * 0.8 * 0.055).sqrt();
    assert!((x.sigma_1 - s1).abs() < 1e-12 && (x.p90_1 - 1000.0 * (1.0 - 1.2816 * x.sigma_1)).abs() < 1e-9 * 1000.0, "P90 {}, sigma {} vs {s1}", x.p90_1, x.sigma_1);
    assert!(x.sigma_10 < x.sigma_1 && x.p90_10 > x.p90_1 && x.p99_1 < x.p90_1 && x.p75_1 > x.p90_1, "exceedance order");
    let xf = exceedance(1000.0, &m, -0.5, 0.055, false);
    assert!((xf.p90_1 - 1000.0 * (1.0 + 1.2816 * xf.sigma_1)).abs() < 1e-9 * 1000.0, "fuel used P90 {}", xf.p90_1);
}

/// Section 16: with PV of about 3 x the average load, fuel saved responds less than the irradiance (curtailment, minimum
/// loading); under a take-or-pay PPA the revenue P-values never fall below the floor
#[test]
fn variability_elasticities_and_take_or_pay() {
    let (mut q, _, _) = setup();
    q.pv.capacity_kwp = 3000.0;
    let wy: Vec<WeatherYear> = [0.94, 1.0, 1.03, 0.97].iter().enumerate().map(|(k, f)| {
        let mut w = WeatherYear { year: 2001 + k as i32, wx: q.wx.clone() };
        for g in w.wx.ghi.iter_mut() { *g *= f; }
        w
    }).collect();
    let prog = Progress::default();
    let r = resource_years(&q, &j(r#"{"finance":{"model":"host"}}"#), &wy, &UncertaintyBudget::default(), &prog).unwrap();
    let s = r.at("stats");
    let (ef, ey) = (s.at("fuel_saved").get("elasticity", f64::NAN), s.at("yield").get("elasticity", f64::NAN));
    assert!(ef > 0.0 && ef <= 1.05, "fuel-saved elasticity {ef}");
    assert!(ey > 0.9 && ey < 1.05 && s.at("fuel_used").get("elasticity", 0.0) < 0.0, "yield elasticity {ey}");
    assert!(r.at("years").len() == 4 && prog.done.load(Relaxed) == 7 && s.at("yield").get("worst_year", 0.0) == 2001.0, "years, runs, worst year");
    let a = r.at("anchor");
    assert!((a.get("revenue", 0.0) - a.get("avoided_cost", 0.0)).abs() < 1e-6 * a.get("revenue", 0.0)
            && s.at("revenue").get("p90_1", 0.0) < s.at("revenue").get("p50", 0.0), "host revenue vs avoided cost");

    let rt = resource_years(&q, &j(r#"{"finance":{"model":"ppa","take_or_pay":0.97,"components":[{"v1":0.15}]}}"#), &wy, &UncertaintyBudget::default(),
                            &Progress::default()).unwrap();
    let rv = rt.at("stats").at("revenue");
    let r50 = rv.get("p50", 0.0);
    assert!(rv.get("p90_1", 0.0) >= 0.97 * r50 - 1e-6 * r50 && rv.get("p99_1", 0.0) >= 0.97 * r50 - 1e-6 * r50 && rv.get("p90_1", 0.0) <= r50,
            "take-or-pay 0.97: revenue P90 / P50 {}, P99 / P50 {}", rv.get("p90_1", 0.0) / r50, rv.get("p99_1", 0.0) / r50);
}

/// Section 24: linear degradation over the simulated years
#[test]
fn linear_degradation_over_the_years() {
    let (mut q, prof, cs) = setup();
    q.pv.degradation_model = "linear".into();
    q.sim.all_years = true;
    let r = sim(&q, &prof, &cs, size(1500.0, 0.0, 0.0), false);
    let ratio = r.years[10].pv_avail / r.years[0].pv_avail;
    assert!((ratio - (1.0 - 10.0 * q.pv.degradation)).abs() < 1e-9, "linear degradation in year 11 {ratio}");
}

/// Section 24: consistent weather components pass the closure check, DHI scaled by 1.3 fails it
#[test]
fn weather_closure_check() {
    let mut cw = make_project(-2.5, 115.5);
    cw.pv.decomposition = "disc".into();
    cw.wx.dni = vec![0.0; HOURS];
    cw.wx.dhi = vec![0.0; HOURS];
    for i in 0..HOURS {
        let s = sun_position(cw.loc.lat, cw.loc.lon, (i / 24 + 1) as i32, (i % 24) as f64 + 0.5);
        if s.cos_zenith <= 0.0872 || cw.wx.ghi[i] <= 0.0 { cw.wx.dhi[i] = cw.wx.ghi[i]; continue; }
        cw.wx.dhi[i] = 0.3 * cw.wx.ghi[i];
        cw.wx.dni[i] = 0.7 * cw.wx.ghi[i] / s.cos_zenith;
    }
    let clos = |x: &Project| -> f64 {
        let qc = data_qc(x, "weather").unwrap();
        qc.at("weather").at("flags").arr().iter().find(|f| f.at("id").str() == "closure").map_or(0.0, |f| f.get("hours", 0.0))
    };
    let mut cb = cw.clone();
    for x in cb.wx.dhi.iter_mut() { *x *= 1.3; }
    assert!(clos(&cw) == 0.0 && clos(&cb) > 100.0, "closure flags {} consistent, {} with DHI x 1.3", clos(&cw), clos(&cb));
}
