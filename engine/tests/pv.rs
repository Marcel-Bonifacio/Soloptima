//! The PV cases of tests/test_engine.cpp with the same assertions: sun position, yield and loss chain, DC wiring basis, UTC
//! offsets, view factors, Perez and Hay-Davies, diffuse row shading, bifacial, monthly soiling, IAM models, inverter curve,
//! terrain horizon, Ineichen with turbidity from the data, decomposition, spectral correction, bypass-diode blocks,
//! slope-aware tracking, snow, monthly albedo and linear degradation. The parts of those cases that run the dispatch
//! simulation (auxiliary loads, degradation over the years) wait for the simulation's port. The comparison with the C++
//! numbers themselves is in pv_fixtures.rs.
use soloptima_engine::pv::*;
use soloptima_engine::solar::{haurwitz_ghi, sun_position};
use soloptima_engine::*;

const D2R: f64 = std::f64::consts::PI / 180.0;

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
fn prof(p: &Project) -> PVProfile { compute_pv_profile(p).unwrap() }
fn yield_of(p: &Project) -> f64 { prof(p).specific_yield }
fn step(r: &PVProfile, name: &str) -> f64 { r.step(name).unwrap_or(-1.0) }
fn valid(p: &Project) -> bool { validate_project(p).is_ok() }
fn parsed(text: &str) -> Project { project_from_text(text).unwrap() }
fn peak(v: &[f64]) -> f64 { v.iter().fold(f64::MIN, |a, &b| a.max(b)) }

#[test]
fn sun_position_at_noon() {
    let s = sun_position(-2.5, 115.5, 80, 12.0 - 115.5 / 15.0 + 0.12);
    assert!((s.zenith_deg - 2.5).abs() < 1.5, "equinox noon zenith {}", s.zenith_deg);
    let n = sun_position(50.0, 0.0, 172, 12.0);
    assert!((n.zenith_deg - (50.0 - 23.44)).abs() < 1.0, "summer solstice zenith {}", n.zenith_deg);
    assert!((n.azimuth_deg - 180.0).abs() < 5.0, "noon azimuth {}", n.azimuth_deg);
}

#[test]
fn yield_loss_chain_and_dc_wiring_basis() {
    let p = make_project(-2.5, 115.5);
    let pr = prof(&p);
    assert!(pr.specific_yield > 900.0 && pr.specific_yield < 2000.0, "specific yield {}", pr.specific_yield);
    assert!(pr.performance_ratio > 0.65 && pr.performance_ratio < 0.92, "PR {}", pr.performance_ratio);
    for i in 6..pr.losses.len() { assert!(pr.losses[i].value <= pr.losses[i - 1].value * 1.031, "loss step {i} increases"); }
    assert!(peak(&pr.ac_per_kwp) <= 1.0 / p.pv.dc_ac_ratio + 1e-9, "clipping limit exceeded");
    assert!(peak(&clearsky_pv_per_kwp(&p).unwrap()) > 0.0);

    assert_eq!(parsed("{}").pv.dc_wiring_basis, "annual");
    let mut q = p.clone();
    q.pv.dc_wiring = 0.0;
    let dc0 = prof(&q).losses[8].value;
    q.pv.dc_wiring = 0.015;
    let ann = prof(&q);
    assert_eq!(ann.specific_yield, pr.specific_yield, "annual basis changed the yield");
    assert!((ann.losses[8].value / dc0 - 0.985).abs() < 1e-12, "annual-basis wiring loss");
    q.pv.dc_wiring_basis = "stc".into();
    let stc = prof(&q);
    let loss = 1.0 - stc.losses[8].value / dc0;
    assert!(loss > 0.006 && loss < 0.014, "STC-basis wiring loss {loss}");
    assert!(stc.specific_yield > ann.specific_yield, "STC basis should lose less than the annual basis");
}

#[test]
fn utc_offsets_shift_the_profile_and_not_the_yield() {
    let mut a = make_project(-7.5, 112.5);
    for i in 0..HOURS {
        let x = i as f64;
        a.wx.wind[i] = 6.0 + 3.0 * (x * 0.37).sin() + 2.0 * (((i / 24) as f64) * 0.9).sin();
        a.wx.tamb[i] = 28.0 + 5.0 * (((i % 24) as f64) / 24.0 * 6.283 - 2.0).sin();
    }
    a.wind.units = 2;
    a.wind.rated_kw = 1000.0;
    let at = |off: f64| { let mut q = a.clone(); q.loc.utc_offset = off; q };
    let (p7, p75, p8) = (at(7.0), at(7.5), at(8.0));
    let (f7, f75, f8) = (prof(&p7), prof(&p75), prof(&p8));
    assert!((f75.specific_yield - f7.specific_yield).abs() < 1e-9 && (f8.specific_yield - f7.specific_yield).abs() < 1e-9,
            "specific yield moves with the UTC offset");
    let (w7, w75, w8) = (wind_per_turbine(&p7).unwrap(), wind_per_turbine(&p75).unwrap(), wind_per_turbine(&p8).unwrap());
    let (mut e_pv, mut e_tc, mut e_w, mut d78) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for t in 0..HOURS {
        e_pv = e_pv.max((f75.ac_per_kwp[t] - 0.5 * (f7.ac_per_kwp[t] + f8.ac_per_kwp[t])).abs());
        e_tc = e_tc.max((f75.tcell[t] - 0.5 * (f7.tcell[t] + f8.tcell[t])).abs());
        e_w = e_w.max((w75[t] - 0.5 * (w7[t] + w8[t])).abs());
        d78 = d78.max((f7.ac_per_kwp[t] - f8.ac_per_kwp[t]).abs() + (w7[t] - w8[t]).abs());
    }
    assert!(e_pv < 1e-12 && e_tc < 1e-12 && e_w < 1e-12 && d78 > 0.1, "+7.5 h is not the mean of +7 h and +8 h: {e_pv} {e_tc} {e_w}");
    let (sq, sw) = (local_shift(&at(-3.5)).unwrap(), local_shift(&at(8.0)).unwrap());
    let mut lt = at(5.75);
    lt.wx.is_utc = false;
    let sl = local_shift(&lt).unwrap();
    assert!(sq.n == -4 && sq.f == 0.5 && sw.n == 8 && sw.f == 0.0 && sl.n == 0 && sl.f == 0.0, "local shift");
    assert!(valid(&at(12.75)) && valid(&at(-12.0)) && valid(&at(14.0)) && !valid(&at(14.5)) && !valid(&at(-15.0)), "UTC offset range check");
    assert!(compute_pv_profile(&at(15.0)).is_err(), "an offset beyond 14 h must not index the hours");
}

#[test]
fn row_and_ground_view_factors() {
    for tilt in [0.0, 12.0, 30.0, 55.0] {
        for gcr in [0.3, 0.5, 0.8] {
            let (pp, c, s, b) = (1.0 / gcr, (tilt * D2R).cos(), (tilt * D2R).sin(), tilt * D2R);
            let (mut fs, mut fg, mut bs, mut bg) = (0.0, 0.0, 0.0, 0.0);
            let n = 4000;
            for i in 0..n {
                let x = (f64::from(i) + 0.5) / f64::from(n);
                let (px, pz) = (-x * c, x * s);
                let nf = f64::from(n);
                fs += (1.0 + ((s - pz).atan2(pp - c - px) + b).cos()) / 2.0 / nf;
                fg += (1.0 - (b - pz.atan2(pp - px)).cos()) / 2.0 / nf;
                bs += (1.0 - (b - (s - pz).atan2(px + pp + c)).cos()) / 2.0 / nf;
                bg += (1.0 + (b + pz.atan2(px + pp)).cos()) / 2.0 / nf;
            }
            let v = row_view(tilt, gcr);
            assert!((v.front_sky - fs).abs() < 1e-6 && (v.front_ground - fg).abs() < 1e-6 && (v.back_sky - bs).abs() < 1e-6
                    && (v.back_ground - bg).abs() < 1e-6, "row view factors at tilt {tilt}, GCR {gcr}");
            let g = ground_view(tilt, gcr, 0.5);
            let m = GroundView::STRIPS;
            let gs: f64 = g.sky.iter().map(|x| x / m as f64).sum();
            let (gf, gb): (f64, f64) = (g.front.iter().sum(), g.back.iter().sum());
            assert!((gf - v.front_ground).abs() < 1e-9 && (gb - v.back_ground).abs() < 1e-9 && gs > 0.0 && gs < 1.0, "ground strips at tilt {tilt}");
            if tilt == 0.0 { assert!((gs - (1.0 - gcr)).abs() < 2e-3, "flat rows: ground sky view {gs} vs 1 - GCR"); }
        }
    }
    let open = row_view(20.0, 1e-4);
    let c20 = (20.0 * D2R).cos();
    assert!((open.front_sky - (1.0 + c20) / 2.0).abs() < 1e-4 && (open.back_ground - (1.0 + c20) / 2.0).abs() < 1e-4
            && (open.front_ground - (1.0 - c20) / 2.0).abs() < 1e-4, "single row view factors");
    // low tables see mostly the ground below them; high ones see the strips between the rows as much
    let (lo, hi) = (ground_view(10.0, 0.45, 0.15), ground_view(10.0, 0.45, 1.2));
    assert!(lo.back[0] > 5.0 * lo.back[15] && hi.back[0] < 2.0 * hi.back[15], "rear view of the ground below the row");
}

#[test]
fn perez_and_hay_davies_in_one_hour() {
    // Perez sky diffuse in one hour against the formulas of Perez et al. 1990 (sky clearness bin 5: 2.8 <= eps < 4.5)
    let mut h = make_project(-10.0, 30.0);
    h.loc.utc_offset = 2.0;
    for v in [&mut h.wx.ghi, &mut h.wx.dni, &mut h.wx.dhi] { *v = vec![0.0; HOURS]; }
    let hr = 100 * 24 + 7;   // UTC, mid-hour 07:30 = 09:30 local
    let sp = sun_position(-10.0, 30.0, 101, 7.5);
    let (cz, dhi, dni) = (sp.cos_zenith, 150.0, 700.0);
    let ghi = dhi + dni * cz;
    h.wx.ghi[hr] = ghi;
    h.wx.dhi[hr] = dhi;
    h.wx.dni[hr] = dni;
    h.pv.tilt = 20.0;
    h.pv.azimuth = 0.0;
    h.pv.row_shading = false;
    h.pv.transposition = "perez".into();
    let z = sp.zenith_deg * D2R;
    let am = 1.0 / (cz + 0.50572 * (96.07995 - sp.zenith_deg).powf(-1.6364));
    let delta = dhi * am / sp.extra_normal;
    let eps = ((dhi + dni) / dhi + 1.041 * z * z * z) / (1.0 + 1.041 * z * z * z);
    let f1 = (1.132 - 1.237 * delta - 0.412 * z).max(0.0);
    let f2 = 0.288 - 0.823 * delta + 0.056 * z;
    let (sz, t) = (z.sin(), 20.0 * D2R);
    let ca = t.sin() * sz * (sp.azimuth_deg * D2R).cos() + t.cos() * cz;
    let poa = dni * ca + dhi * ((1.0 - f1) * (1.0 + t.cos()) / 2.0 + f1 * ca / cz + f2 * t.sin()) + ghi * 0.2 * (1.0 - t.cos()) / 2.0;
    let poa_e = prof(&h).poa_annual * 1000.0;
    assert!(eps >= 2.8 && eps < 4.5 && (poa_e - poa).abs() < 1e-6 * poa, "Perez hour: eps {eps}, POA {poa_e} vs {poa}");
    h.pv.transposition = "hay_davies".into();
    let ai = dni / sp.extra_normal;
    let poa_hd = dni * ca + dhi * ((1.0 - ai) * (1.0 + t.cos()) / 2.0 + ai * ca / cz) + ghi * 0.2 * (1.0 - t.cos()) / 2.0;
    assert!((prof(&h).poa_annual * 1000.0 - poa_hd).abs() < 1e-6 * poa_hd, "Hay-Davies hour");
}

#[test]
fn irradiance_models_on_the_test_year() {
    let d = parsed("{}");
    assert!(d.pv.transposition == "hay_davies" && !d.pv.diffuse_shading && d.pv.bifaciality == 0.0 && d.pv.soiling_monthly.is_empty()
            && (d.pv.row_width - 2.0 * 2.278).abs() < 1e-12, "irradiance model defaults");
    let p = make_project(-2.5, 115.5);
    let base = prof(&p);
    let mut q = p.clone();
    q.pv.tilt = 25.0;
    q.pv.gcr = 0.5;
    let hd = prof(&q);
    q.pv.transposition = "perez".into();
    let pz = prof(&q);
    q.pv.diffuse_shading = true;
    let ds = prof(&q);
    assert!(pz.poa_annual > hd.poa_annual && ds.poa_annual == pz.poa_annual && ds.losses[2].value < pz.losses[2].value - 0.005 * pz.poa_annual
            && ds.specific_yield < pz.specific_yield, "Perez POA and diffuse row shading");
    let mut wide = q.clone();
    wide.pv.gcr = 0.02;
    let w0 = prof(&wide);
    wide.pv.diffuse_shading = false;
    assert!((w0.specific_yield / yield_of(&wide) - 1.0).abs() < 2e-3, "diffuse row shading at GCR 0.02");
    let mut gain = [0.0; 3];
    for (n, mh) in [0.8, 1.5, 3.0].into_iter().enumerate() {
        q.pv.mount_height = mh;
        q.pv.bifaciality = 0.0;
        let mono = prof(&q);
        q.pv.bifaciality = 0.7;
        let bf = prof(&q);
        gain[n] = bf.specific_yield / mono.specific_yield - 1.0;
        assert!(bf.losses.len() == mono.losses.len() + 1 && bf.losses[5].irradiance && bf.losses[5].value > bf.losses[4].value
                && bf.rear_annual > 0.0 && mono.rear_annual == 0.0 && bf.losses[4].value == mono.losses[4].value, "bifacial loss chain at {mh} m");
    }
    assert!(gain[0] > 0.01 && gain[0] < gain[1] && gain[1] < gain[2] && gain[2] < 0.12, "bifacial gain {gain:?}");
    let mut tr = q.clone();
    tr.pv.mount = "tracker".into();
    tr.pv.gcr = 0.35;
    tr.pv.row_width = 2.4;
    tr.pv.mount_height = 2.0;
    let tb = prof(&tr);
    tr.pv.bifaciality = 0.0;
    let tgain = tb.specific_yield / yield_of(&tr) - 1.0;
    assert!(tgain > 0.02 && tgain < 0.15 && tb.specific_yield.is_finite(), "tracker bifacial gain {tgain}");

    let mut m = p.clone();
    m.pv.soiling_monthly = vec![m.pv.soiling; 12];
    assert_eq!(yield_of(&m), base.specific_yield, "monthly soiling equal to the annual value changed the yield");
    m.pv.soiling_monthly = vec![0.0; 12];
    let m0 = prof(&m);
    m.pv.soiling_monthly[0] = 0.1;
    let m1 = prof(&m);
    assert!((m1.m_eff[0] / m0.m_eff[0] - 0.9).abs() < 1e-12 && m1.m_eff[5] == m0.m_eff[5], "January soiling");
    let invalid = |set: &dyn Fn(&mut Project)| { let mut x = p.clone(); set(&mut x); !valid(&x) };
    assert!(invalid(&|x| x.pv.soiling_monthly = vec![0.01, 0.02]) && invalid(&|x| x.pv.transposition = "perezz".into())
            && invalid(&|x| { x.pv.bifaciality = 0.7; x.pv.gcr = 1.2; }) && !invalid(&|x| x.pv.gcr = 1.2),
            "irradiance inputs: invalid accepted or valid refused");
}

#[test]
fn iam_inverter_curve_and_horizon_views() {
    let d = parsed("{}");
    assert!(d.pv.decomposition == "erbs" && d.pv.clearsky == "haurwitz" && d.pv.iam_model == "ashrae" && d.pv.shade_model == "linear"
            && d.pv.inverter_model == "constant" && d.pv.degradation_model == "compound" && d.pv.spectral == "none" && d.pv.horizon.is_empty()
            && d.pv.tracker_axis_tilt == 0.0 && d.pv.tracker_cross_slope == 0.0 && d.wx.snow.is_empty() && !d.wx.horizon_in_beam,
            "further model defaults");
    assert!(parsed(r#"{"weather":{"source":"PVGIS TMY (PVGIS-SARAH3)","elevation":250}}"#).wx.horizon_in_beam
            && parsed(r#"{"weather":{"elevation":250}}"#).loc.elevation == 250.0, "PVGIS weather and elevation");
    // IAM: 1 at normal incidence, 0 at grazing; a coating lifts it at oblique angles; the integrated sky IAM of Martin-Ruiz
    // within 1 % of its published closed form, c1 = 4/(3 pi), c2 = 0.5 a_r - 0.154 (Martin and Ruiz 2001)
    let mut im = PVParams::default();
    for m in ["martin_ruiz", "physical"] {
        im.iam_model = m.into();
        assert!((incidence_modifier(&im, 1.0) - 1.0).abs() < 1e-12 && incidence_modifier(&im, 1e-6) < 1e-3
                && incidence_modifier(&im, (70.0 * D2R).cos()) < incidence_modifier(&im, (50.0 * D2R).cos()), "{m} IAM shape");
    }
    let bare = incidence_modifier(&im, (70.0 * D2R).cos());
    im.iam_n_ar = 1.29;
    assert!(incidence_modifier(&im, (70.0 * D2R).cos()) > bare, "coated glass IAM");
    im.iam_model = "martin_ruiz".into();
    let pi = 3.14159265358979;
    for tilt in [10.0, 30.0, 60.0] {
        let b = tilt * D2R;
        let t = b.sin() + (pi - b - b.sin()) / (1.0 + b.cos());
        let mr = 1.0 - (-(4.0 / (3.0 * pi) + (0.5 * im.iam_ar - 0.154) * t) * t / im.iam_ar).exp();
        assert!((diffuse_iam(&im, tilt)[0] / mr - 1.0).abs() < 0.01, "sky diffuse IAM at {tilt} deg");
    }
    // Inverter curve: the fitted losses give the peak and the European weighted efficiency back
    let k = inverter_curve(0.983, 0.99);
    let eta = |p: f64| p / (p + k[0] + k[1] * p * p);
    let euro = 0.03 * eta(0.05) + 0.06 * eta(0.1) + 0.13 * eta(0.2) + 0.1 * eta(0.3) + 0.48 * eta(0.5) + 0.2 * eta(1.0);
    assert!((eta((k[0] / k[1]).sqrt()) - 0.99).abs() < 1e-9 && (euro - 0.983).abs() < 2e-5, "inverter curve");
    // Horizon views: an open horizon hides nothing; 10 deg all round leaves cos^2(10 deg) of the sky to a horizontal plane
    let c10 = (10.0 * D2R).cos();
    assert!(horizon_view(&[0.0; 36], 20.0, 180.0)[0] == 1.0 && (horizon_view(&[10.0; 36], 0.0, 0.0)[0] - c10 * c10).abs() < 2e-3, "horizon view of the sky");
}

#[test]
fn horizon_clear_sky_decomposition_and_spectrum() {
    let q = make_project(-2.5, 115.5);
    let base = prof(&q);
    // terrain horizon: blocks beam and sky with its own loss step; measured data are left alone
    let mut hz = q.clone();
    hz.pv.horizon = vec![0.0; 36];
    for a in 3..=15 { hz.pv.horizon[a] = 12.0; }   // hills from 30 to 150 deg
    let ph = prof(&hz);
    assert!(ph.specific_yield < base.specific_yield && step(&ph, "After terrain horizon") < ph.poa_annual, "horizon loss");
    hz.pv.horizon_beam = "data".into();
    assert_eq!(yield_of(&hz), base.specific_yield, "horizon with measured data changed the yield");

    // Ineichen: weather made from the model at turbidity 4 gives turbidity 4 back, so the estimated clear sky equals it
    let mut ci = q.clone();
    ci.pv.clearsky = "ineichen".into();
    ci.pv.linke_turbidity = 4.0;
    ci.wx.ghi = clearsky_ghi(&ci).unwrap();
    let c4 = ci.wx.ghi.clone();
    ci.pv.linke_turbidity = 0.0;
    let est = clearsky_ghi(&ci).unwrap();
    let dmax = (0..HOURS).fold(0.0f64, |m, i| m.max((est[i] - c4[i]).abs()));
    let pk = peak(&c4);
    assert!(dmax < 1e-6 * pk && pk > 900.0 && pk < 1150.0, "Ineichen turbidity estimate: max difference {dmax}, peak {pk}");
    assert!(peak(&clearsky_pv_per_kwp(&ci).unwrap()) > 0.5, "Ineichen clear-sky PV");

    // decomposition of GHI-only weather: each model splits consistently and stays within a few % of the others
    let mut yd = [0.0; 3];
    for (n, m) in ["erbs", "disc", "boland"].into_iter().enumerate() {
        let mut x = q.clone();
        x.pv.decomposition = m.into();
        let r = prof(&x);
        yd[n] = r.specific_yield;
        let dsum: f64 = r.m_dhi.iter().sum();
        assert!(dsum > 0.0 && dsum < r.ghi_annual, "{m} diffuse {dsum} of GHI {}", r.ghi_annual);
    }
    assert!(yd[0] == base.specific_yield && (yd[1] / yd[0] - 1.0).abs() < 0.03 && (yd[2] / yd[0] - 1.0).abs() < 0.03, "decomposition yields {yd:?}");

    // spectral correction in one hour: M = a kc^b AMa^c with the Haurwitz clear-sky index
    let mut h1 = make_project(-10.0, 30.0);
    h1.loc.utc_offset = 2.0;
    for v in [&mut h1.wx.ghi, &mut h1.wx.dni, &mut h1.wx.dhi] { *v = vec![0.0; HOURS]; }
    let sp = sun_position(-10.0, 30.0, 101, 7.5);
    h1.wx.ghi[100 * 24 + 7] = 400.0;
    h1.pv.spectral = "monosi".into();
    let s1 = prof(&h1);
    let am = 1.0 / (sp.cos_zenith + 0.50572 * (96.07995 - sp.zenith_deg).powf(-1.6364));
    let kc = (400.0 / haurwitz_ghi(sp.cos_zenith)).clamp(0.1, 1.2);
    let m_exp = 0.9845 * kc.powf(-0.05169) * am.max(1.0).powf(0.03034);
    assert!((step(&s1, "After spectral correction") / step(&s1, "Effective irradiation (after soiling)") / m_exp - 1.0).abs() < 1e-9, "PVSPEC factor");
}

#[test]
fn blocks_tracking_inverter_snow_albedo_degradation() {
    let q = make_project(-2.5, 115.5);
    let base = prof(&q);
    // bypass-diode blocks: a shadow costs at least as much as the linear model, nothing changes without one
    let mut sb = q.clone();
    sb.pv.tilt = 30.0;
    sb.pv.gcr = 0.7;
    let lin = step(&prof(&sb), "After near/row shading");
    sb.pv.shade_model = "blocks".into();
    let blk = step(&prof(&sb), "After near/row shading");
    sb.pv.row_shading = false;
    let none = yield_of(&sb);
    sb.pv.shade_model = "linear".into();
    assert!(blk < lin && none == yield_of(&sb), "bypass blocks {blk} vs linear {lin}");

    // slope-aware tracking: a vanishing axis tilt reproduces the level tracker; backtracking on a slope avoids row shading
    let mut tk = q.clone();
    tk.pv.mount = "tracker".into();
    tk.pv.gcr = 0.4;
    let flat = yield_of(&tk);
    tk.pv.tracker_axis_tilt = 1e-9;
    assert!((yield_of(&tk) / flat - 1.0).abs() < 1e-9, "tracker with a vanishing axis tilt");
    tk.pv.tracker_axis_tilt = 0.0;
    tk.pv.tracker_cross_slope = 6.0;
    let slope = prof(&tk);
    assert!(slope.losses[2].value == slope.poa_annual && slope.specific_yield != flat, "slope-aware backtracking left row shading");
    tk.pv.backtracking = false;
    let sl_nb = prof(&tk);
    assert!(sl_nb.losses[2].value < sl_nb.poa_annual, "row shading on a slope without backtracking");

    // inverter curve: constant above the self-consumption and below the rating, the same clipping limit
    let mut iv = q.clone();
    iv.pv.inverter_model = "curve".into();
    let pc = prof(&iv);
    assert!((pc.specific_yield / base.specific_yield - 1.0).abs() < 0.01 && peak(&pc.ac_per_kwp) <= 1.0 / iv.pv.dc_ac_ratio + 1e-9, "inverter curve yield");

    // snow: the monthly model against its formula in one month; the hourly cover model sheds snow only in warm or bright hours
    let mut sn = q.clone();
    sn.pv.snow_monthly = vec![0.0; 12];
    sn.pv.snow_events = vec![0.0; 12];
    sn.pv.snow_monthly[1] = 40.0;
    sn.pv.snow_events[1] = 4.0;
    for t in &mut sn.wx.tamb { *t = -5.0; }
    let mut sn0 = sn.clone();
    sn0.pv.snow_monthly.clear();
    let (f0, f1) = (prof(&sn0), prof(&sn));
    let tilt = sn.pv.tilt * D2R;
    let se = 2.0 / 3.0 * 0.5 * 40.0 / 2.54 * 1.25;
    let lower = (sn.pv.mount_height - 0.5 * sn.pv.row_width * tilt.sin()) * 39.37;
    let gam = sn.pv.row_width * 39.37 * se * tilt.cos() / (lower * lower - se * se).max(0.1) * 2.0 * (40.0 * D2R).tan();
    let tw = 5.7e4 * se * tilt.cos().powi(2) * (1.0 - 0.51 * (-gam).exp()) * 0.8 / 268.15f64.powi(2) / f0.m_poa[1].powf(0.67) * 0.75;
    assert!(((f0.m_dc[1] - f1.m_dc[1]) / f0.m_dc[1] - tw).abs() < 1e-9 && f1.m_dc[0] == f0.m_dc[0], "Townsend February loss");
    let mut hs = sn0.clone();
    hs.wx.snow = vec![0.0; HOURS];
    hs.wx.snow[40 * 24] = 3.0;   // 3 cm in an hour on day 40
    let fs = prof(&hs);
    assert!(step(&fs, "After snow cover") < step(&fs, "After temperature loss") && step(&f0, "After snow cover") < 0.0, "hourly snow cover");

    // monthly albedo equal to the annual value, linear degradation over the years
    let mut al = q.clone();
    al.pv.albedo_monthly = vec![al.pv.albedo; 12];
    assert_eq!(yield_of(&al), base.specific_yield, "monthly albedo equal to the annual value changed the yield");
    let mut dg = q.clone();
    dg.pv.degradation_model = "linear".into();
    assert!((pv_degradation_factor(&dg.pv, 11) - (1.0 - 10.0 * dg.pv.degradation)).abs() < 1e-15, "linear degradation in year 11");
}
