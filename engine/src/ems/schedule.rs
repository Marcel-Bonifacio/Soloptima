//! Day-ahead schedule (day_ahead_schedule in src/ems.cpp): battery set-points and genset commitment from a live weather
//! forecast (the fetch_forecast document) and the project's typical load profile.
use super::{clip, hour_of_year_iso, schedule_checks};
use crate::pv::{compute_pv_profile, local_shift, wind_per_turbine};
use crate::sim::{aux_kw, clamp, mn, mx, plan_input, reserve_cap_step, FuelTable, Planner, Sizing};
use crate::weather::{epoch_h_to_iso, iso_to_epoch_h};
use crate::{Error, Project, Value, HOURS};

fn obj(kv: Vec<(&str, Value)>) -> Value {
    let mut o = Value::object();
    for (k, v) in kv { o.set(k, v); }
    o
}

/// Plans the forecast hours with the predictive EMS planner. It starts at the hour of now_utc (ISO, UTC), or of the forecast's
/// issued_utc when now_utc is empty; earlier hours are dropped so soc_now applies at the start of the current hour. With neither,
/// all hours are kept; max_hours > 0 caps them. Hours must be 1 h apart; the plan ends at the first hour without irradiance (or
/// wind, with turbines). The checks of the C++ route (`schedule_checks`) come first.
pub fn day_ahead_schedule(p: &Project, s: &Sizing, f: &Value, soc_now: f64, load_scale: f64, now_utc: &str, max_hours: i32) -> Result<Value, Error> {
    schedule_checks(p)?;
    let fail = |m: String| Err(Error(m));
    let times = f.at("times").arr();
    let (ghi, tamb, wind, dhi, dni) = (f.at("ghi"), f.at("tamb"), f.at("wind"), f.at("dhi"), f.at("dni"));
    if times.is_empty() { return fail("Forecast contains no hours.".into()); }
    let mut eh = Vec::with_capacity(times.len());   // hours since the epoch
    for t in times {
        match iso_to_epoch_h(t.str()) { Some(h) => eh.push(h), None => return fail(format!("Bad forecast timestamp: {}", clip(t.str()))) }
    }

    // A row covers [T + time_offset - 0.5 h, T + time_offset + 0.5 h): Open-Meteo stamps the end of its hour (offset -0.5),
    // MET Norway the start (0.5). The plan starts at the current hour, so rows that began earlier are dropped.
    let toff = f.get("time_offset", 0.5);
    if !(toff.abs() <= 1.0) { return fail("The forecast time offset must be between -1 h and +1 h.".into()); }
    let now = if now_utc.is_empty() { f.gets("issued_utc", "") } else { now_utc.to_string() };
    let (mut i0, mut i1) = (0usize, times.len());
    if !now.is_empty() {
        let Some(t0) = iso_to_epoch_h(&now) else { return fail(format!("Bad current time: {}", clip(&now))) };
        while i0 < i1 && eh[i0] as f64 + toff - 0.5 < t0 as f64 - 1e-9 { i0 += 1; }
        if i0 == i1 { return fail("The forecast ends before the current hour: fetch it again.".into()); }
    }
    if max_hours > 0 { i1 = mn(i1, i0 + max_hours as usize); }
    // A missing value is never read as zero PV (or as calm wind): the plan ends at the first hour without it.
    let has_wind = s.wind_units > 0.5;
    let mut note = f.gets("note", "");
    if let Some(i) = (i0..i1).find(|&i| ghi.idx(i).is_null() || (has_wind && wind.idx(i).is_null())) {
        if !note.is_empty() { note.push(' '); }
        note += &format!("No data from {} UTC: the plan ends there.", clip(times[i].str()));
        i1 = i;
    }
    if i1 == i0 { return fail("The forecast has no data for the current hour.".into()); }
    for i in i0 + 1..i1 {
        if eh[i] != eh[i - 1] + 1 {
            return fail(format!("Forecast hours must be 1 h apart: {} is followed by {}.", clip(times[i - 1].str()), clip(times[i].str())));
        }
    }
    let n = i1 - i0;

    // Place the forecast hours into an otherwise empty year so the full PV model can be reused unchanged. The plan runs on the
    // forecast's UTC hours: PV stays on them (offset 0), and the load, in local standard time, is averaged over each. The
    // hours are indexed consecutively from the first, so 29 February does not land on the 28th.
    let mut q = p.clone();
    q.wx.is_utc = true;
    local_shift(&q)?;
    q.loc.utc_offset = 0.0;
    q.wx.time_offset = toff;
    for v in [&mut q.wx.ghi, &mut q.wx.tamb, &mut q.wx.wind] { *v = vec![0.0; HOURS]; }
    let split = dhi.len() == times.len() && dni.len() == times.len();
    if split { q.wx.dhi = vec![0.0; HOURS]; q.wx.dni = vec![0.0; HOURS]; } else { q.wx.dhi.clear(); q.wx.dni.clear(); }
    let h0 = hour_of_year_iso(times[i0].str());
    if h0 < 0 || h0 >= HOURS as i32 { return fail(format!("Bad forecast timestamp: {}", clip(times[i0].str()))); }
    let hoy: Vec<usize> = (0..n).map(|k| (h0 as usize + k) % HOURS).collect();
    for (k, &h) in hoy.iter().enumerate() {
        let i = i0 + k;
        q.wx.ghi[h] = mx(0.0, ghi.idx(i).num(0.0));
        q.wx.tamb[h] = tamb.idx(i).num(25.0);
        q.wx.wind[h] = wind.idx(i).num(1.0);
        if split { q.wx.dhi[h] = dhi.idx(i).num(0.0); q.wx.dni[h] = dni.idx(i).num(0.0); }
    }
    let prof = compute_pv_profile(&q)?;
    // Wind turbines on the forecast 10 m wind with the project's shear and power curve, on the same UTC hours as PV (q has
    // offset 0). Losses and the design availability apply as expected values.
    q.wind.ref_height = 10.0;   // both providers forecast the wind at 10 m above ground
    let wpt = if has_wind { wind_per_turbine(&q)? } else { Vec::new() };

    // The planner sees PV + wind as one renewable input, as the lifecycle simulation does. Row k covers UTC
    // [hoy + toff - 0.5, hoy + toff + 0.5), so in local standard time it starts at hoy + s, s = toff - 0.5 + offset: it spans
    // 1 - f of local hour hoy + n and f of the next (n = floor(s), f = s - n).
    let (mut lfc, mut pfc, mut wfc, mut re, mut aux) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    let s0 = toff - 0.5 + p.loc.utc_offset;
    let ln = s0.floor() as i32;
    let lf = s0 - f64::from(ln);
    for k in 0..n {
        let li = (hoy[k] as i32 + ln).rem_euclid(HOURS as i32) as usize;
        pfc[k] = prof.ac_per_kwp[hoy[k]] * s.pv_kwp;
        if has_wind { wfc[k] = wpt[hoy[k]] * s.wind_units; }
        re[k] = pfc[k] + wfc[k];
        aux[k] = aux_kw(p, s, tamb.idx(i0 + k).num(25.0));
        lfc[k] = ((1.0 - lf) * p.load_kw[li] + lf * p.load_kw[(li + 1) % HOURS]) * load_scale + aux[k];
    }

    let fuel = FuelTable::new(&p.dg)?;
    let mut planner = Planner::new(&p.dg, &fuel);
    let mut pin = plan_input(p, &fuel);
    let eta = pin.eta;
    let has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    pin.e_min = if has_bess { s.bess_kwh * p.bess.soc_min } else { 0.0 };
    pin.e_max = if has_bess { s.bess_kwh * p.bess.soc_max } else { 0.0 };
    pin.pb = if has_bess { s.bess_kw } else { 0.0 };
    pin.levels = mx(pin.levels, 41);
    let e0 = clamp(soc_now * s.bess_kwh, pin.e_min, pin.e_max);
    let (mut e_traj, mut u_plan) = (Vec::new(), Vec::new());
    planner.plan(&pin, e0, &lfc, &re, &mut e_traj, &mut u_plan);

    let mut rows = Vec::with_capacity(n);
    let (mut tot_fuel, mut tot_pv, mut tot_wind, mut tot_load, mut tot_curt, mut tot_gen) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for k in 0..n {
        let de = e_traj[k + 1] - e_traj[k];
        let mut b = if de < 0.0 { -de * eta } else { -de / eta };   // + discharge, - charge (AC side)
        if b.abs() > pin.pb {   // first hour starts off the planner's SOC grid
            b = pin.pb.copysign(b);
            e_traj[k + 1] = e_traj[k] - if b > 0.0 { b / eta } else { b * eta };
        }
        let (_, u) = planner.hour_cost(&pin, lfc[k], re[k], b, reserve_cap_step(&pin, e_traj[k], e_traj[k + 1]));
        let cap = f64::from(u) * p.dg.unit_kw;
        let need = mx(0.0, lfc[k] - re[k] - b);
        let gen = if u > 0 { mx(mn(need, cap), cap * p.dg.min_load) } else { 0.0 };
        let curtail = mx(0.0, re[k] + gen + b - lfc[k]);
        let fl = if u > 0 { cap * fuel.at(gen / cap) } else { 0.0 };
        let fpv = if re[k] > 0.0 { pfc[k] / re[k] } else { 1.0 };   // renewable use split pro rata, as in the simulation
        tot_fuel += fl;
        tot_pv += (re[k] - curtail) * fpv;
        tot_wind += (re[k] - curtail) * (1.0 - fpv);
        tot_load += lfc[k];
        tot_curt += curtail;
        tot_gen += gen;
        rows.push(obj(vec![
            ("time_utc", times[i0 + k].str().into()), ("load_kw", lfc[k].into()), ("aux_kw", aux[k].into()), ("pv_kw", pfc[k].into()),
            ("wind_kw", wfc[k].into()), ("bess_kw", b.into()),
            ("soc", (if s.bess_kwh > 0.0 { e_traj[k + 1] / s.bess_kwh } else { 0.0 }).into()), ("units", u.into()),
            ("gen_kw", gen.into()), ("curtail_kw", curtail.into()), ("fuel_l", fl.into()), ("unmet_kw", mx(0.0, need - cap).into()),
        ]));
    }
    // Start of the first planned hour, when soc_now applies.
    let start = epoch_h_to_iso(eh[i0] + (toff - 0.5 + 1e-9).floor() as i64);
    Ok(obj(vec![
        ("rows", Value::Arr(rows)), ("utc_offset", p.loc.utc_offset.into()), ("provider", f.gets("provider", "").into()),
        ("note", note.into()), ("plan_start_utc", start.into()), ("issued_utc", f.gets("issued_utc", "").into()),
        ("model_updated_utc", f.gets("model_updated_utc", "").into()),
        ("totals", obj(vec![
            ("fuel_l", tot_fuel.into()), ("pv_used_kwh", tot_pv.into()), ("wind_used_kwh", tot_wind.into()),
            ("load_kwh", tot_load.into()), ("curtail_kwh", tot_curt.into()), ("gen_kwh", tot_gen.into()),
        ])),
    ]))
}
