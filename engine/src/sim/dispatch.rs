//! Dispatch over the project years, hour by hour or in 30 or 15 minute steps, and the battery ageing (simulate in src/sim.cpp).
use super::{aux_kw, clamp, econ, grid_year, mn, mx, GensetCost, plan_input, Fleet, Forecast, FuelTable, GridHour, GroupYear, Hourly, Planner, SimInput, SimResult, Sizing, YearResult};
use crate::forecast::Forecaster;
use crate::pv::{local_shift, put_local};
use crate::{pv_degradation_factor, Error, Project, HOURS};
use std::borrow::Cow;

/// Year-1 forecast skill; always reported with the hourly series.
fn forecast_stats(p: &Project, fc: &dyn Forecast, pv: &[f64], kwp: f64, r: &mut SimResult) {
    let (mut e_pv1, mut e_pvd, mut b_pvd, mut s_pv, mut e_l1, mut e_ld, mut b_ld, mut s_l) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let h = r.hourly.as_mut().expect("hourly series");
    for t in 0..HOURS {
        let ti = t as i32;
        let (pa, la) = (pv[t] * kwp, p.load_kw[t]);
        let (p1, pd) = (fc.pv(ti, ti) * kwp, fc.pv(ti - 24, ti) * kwp);
        let (l1, ld) = (fc.load(ti, ti), fc.load(ti - 24, ti));
        e_pv1 += (p1 - pa).abs(); e_pvd += (pd - pa).abs(); b_pvd += pd - pa; s_pv += pa;
        e_l1 += (l1 - la).abs(); e_ld += (ld - la).abs(); b_ld += ld - la; s_l += la;
        h.pv_fc_h1[t] = p1; h.pv_fc_da[t] = pd; h.load_fc_h1[t] = l1; h.load_fc_da[t] = ld;
    }
    let f = &mut r.fc;
    if s_pv > 0.0 { f.pv_nmae_h1 = e_pv1 / s_pv; f.pv_nmae_da = e_pvd / s_pv; f.pv_bias_da = b_pvd / s_pv; }
    if s_l > 0.0 { f.load_nmae_h1 = e_l1 / s_l; f.load_nmae_da = e_ld / s_l; f.load_bias_da = b_ld / s_l; }
}

/// An hourly series at `k` steps per hour: held, or interpolated between the hour centres and scaled so each hour keeps its mean
fn fill_steps(v: &[f64], k: usize, interp: bool) -> Cow<'_, [f64]> {
    if k == 1 || v.is_empty() { return Cow::Borrowed(v); }
    let n = v.len();
    let mut out = Vec::with_capacity(n * k);
    for h in 0..n {
        let start = out.len();
        for s in 0..k {
            if !interp { out.push(v[h]); continue; }
            let x = (s as f64 + 0.5) / k as f64 - 0.5;   // from the hour's centre, in hours
            let (a, w) = if x < 0.0 { (v[(h + n - 1) % n], -x) } else { (v[(h + 1) % n], x) };
            out.push(v[h] + (a - v[h]) * w);
        }
        let mean = out[start..].iter().sum::<f64>() / k as f64;
        if interp && mean > 0.0 { for x in &mut out[start..] { *x *= v[h] / mean; } } else if interp { for x in &mut out[start..] { *x = v[h]; } }
    }
    Cow::Owned(out)
}

/// Values of one step for the series of `Hourly` (in the order of `put`)
struct StepVals {
    load: f64, aux: f64, pv_avail: f64, pv_to_load: f64, pv_to_bess: f64, pv_curtailed: f64, wind_avail: f64, wind_to_load: f64,
    wind_to_bess: f64, wind_curtailed: f64, bess_dis: f64, gen_to_bess: f64, gen_to_load: f64, gen_dump: f64, gen_units: f64, fuel_l: f64,
    unmet: f64, soc: f64, soc_target: f64, grid: Option<(f64, f64, f64)>,
}

/// Puts a step into series `h` at `i`: the value itself (w = None), or adds w x value (hourly means of shorter steps); the
/// state of charge and its target are those at the end of the hour.
fn put(h: &mut Hourly, i: usize, v: &StepVals, w: Option<f64>) {
    let f = |a: &mut Vec<f64>, x: f64| match w { None => a[i] = x, Some(w) => a[i] += x * w };
    f(&mut h.load, v.load); f(&mut h.aux, v.aux); f(&mut h.pv_avail, v.pv_avail); f(&mut h.pv_to_load, v.pv_to_load);
    f(&mut h.pv_to_bess, v.pv_to_bess); f(&mut h.pv_curtailed, v.pv_curtailed); f(&mut h.wind_avail, v.wind_avail);
    f(&mut h.wind_to_load, v.wind_to_load); f(&mut h.wind_to_bess, v.wind_to_bess); f(&mut h.wind_curtailed, v.wind_curtailed);
    f(&mut h.bess_dis, v.bess_dis); f(&mut h.gen_to_bess, v.gen_to_bess); f(&mut h.gen_to_load, v.gen_to_load); f(&mut h.gen_dump, v.gen_dump);
    f(&mut h.gen_units, v.gen_units); f(&mut h.unmet, v.unmet);
    if let Some((gi, gx, up)) = v.grid { f(&mut h.grid_import, gi); f(&mut h.grid_export, gx); f(&mut h.grid_up, up); }
    // fuel: litres in the step (summed into the hour), state of charge: at the end
    match w { None => h.fuel_l[i] = v.fuel_l, Some(_) => h.fuel_l[i] += v.fuel_l }
    h.soc[i] = v.soc;
    h.soc_target[i] = v.soc_target;
}

fn new_hourly(grid: bool, n: usize) -> Hourly {
    let zeros = || vec![0.0; n];
    let g = || if grid { zeros() } else { Vec::new() };
    Hourly {
        grid_import: g(), grid_export: g(), grid_up: g(),
        load: zeros(), aux: zeros(), pv_avail: zeros(), pv_to_load: zeros(), pv_to_bess: zeros(), pv_curtailed: zeros(), bess_dis: zeros(),
        gen_to_bess: zeros(), gen_to_load: zeros(), gen_dump: zeros(), gen_units: zeros(), fuel_l: zeros(), unmet: zeros(), soc: zeros(),
        wind_avail: zeros(), wind_to_load: zeros(), wind_to_bess: zeros(), wind_curtailed: zeros(), pv_fc_h1: zeros(), load_fc_h1: zeros(),
        pv_fc_da: zeros(), load_fc_da: zeros(), soc_target: zeros(),
    }
}

/// Simulates the project with sizing `s` hour by hour (year 1 repeated when `p.sim.all_years` is false), then the economics.
/// `keep_hourly` keeps the year-1 series and the forecast skill.
pub fn simulate(p: &Project, inp: &SimInput, s: &Sizing, keep_hourly: bool) -> Result<SimResult, Error> {
    let has_grid = p.grid.enabled;
    let mut r = SimResult { size: *s, has_grid, ..Default::default() };
    let (dg, bp, em) = (&p.dg, &p.bess, &p.ems);
    let fuel = FuelTable::new(dg)?;

    let has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    let cc = dg.strategy == "cycle_charging";
    let pred = dg.strategy == "predictive" && has_bess;
    // The fleet: one group of identical units, or several committed in merit order
    let fleet = Fleet::new(dg, &p.econ)?;
    let min_on = fleet.min_on;
    let mixed = fleet.is_mixed();
    if mixed { r.fleet = fleet.groups.iter().map(|g| (g.index, g.units, g.unit_kw, g.min_load)).collect(); }

    let n_life = p.econ.lifetime;
    let sim_years = if p.sim.all_years { n_life } else { 1 };
    let has_wind = s.wind_units > 0.5;
    if p.load_kw.len() != HOURS || inp.pv_per_kwp.len() != HOURS { return Err(Error("The load and PV series need 8760 hours.".into())); }
    if has_wind && inp.wind_per_turbine.len() != HOURS { return Err(Error("The wind series needs 8760 hours.".into())); }
    let wind_pt = inp.wind_per_turbine;
    // Time step: k steps of dt hours. Hourly series are held or interpolated; a load given finer keeps its resolution. With
    // k = 1 every product with dt is exact, so hourly results are as before to the byte.
    let k = p.sim.steps_per_hour();
    let (n_steps, dt, step_min) = (HOURS * k, 1.0 / k as f64, 60.0 / k as f64);
    let interp = p.sim.subhourly == "interpolate";
    r.step_min = 60 / k as i32;
    let pv_st = fill_steps(inp.pv_per_kwp, k, interp);
    // Inverter clipping is in the PV profile of year 1. The inverter's AC rating does not degrade with the modules, so as the DC
    // power falls part of the clipped energy comes back: per kWp, min(f x, max(0, c - f p)) for output p, clipped energy x,
    // degradation factor f and AC limit c. Exact for hourly steps of whole-hour offsets; year 1 (f = 1) is unchanged.
    let clip_st = if inp.pv_clip_per_kwp.len() == HOURS { fill_steps(inp.pv_clip_per_kwp, k, interp) } else { Cow::Borrowed(&[][..]) };
    let pv_cap = (1.0 / p.pv.dc_ac_ratio) * (1.0 - p.pv.ac_losses) * p.pv.availability;
    let wind_st = if has_wind { fill_steps(wind_pt, k, interp) } else { Cow::Borrowed(&[][..]) };
    let sd = if k == 1 { bp.self_discharge } else { 1.0 - (1.0 - bp.self_discharge).powf(dt) };   // self-discharge per step
    // Genset ramps and start time, forced unit outages, the N-1 check: each only when set
    let ramps = dg.ramp_pct_min > 0.0 || dg.start_min > 0.0;
    let outages = dg.outage_rate > 0.0 && fleet.units > 0;
    let n1 = dg.n1_check;
    (r.ramps, r.unit_outages, r.n1) = (ramps, outages, n1);
    let ng = fleet.groups.len();
    let mut prev_gen = 0.0f64;
    let mut units_hour0 = 0i32;   // units online at the start of the hour
    let mut soh = if has_bess { bp.soh_init } else { 1.0 };
    let mut e = if has_bess { s.bess_kwh * bp.soc_init } else { 0.0 };
    let mut prev_units = 0i32;
    let mut cc_hold = false;   // cycle charging: gensets are charging the battery toward the setpoint, so it holds its energy

    // Auxiliary load by local hour (ambient shifted to local time as in the PV model). It does not grow with the load.
    let mut aux = vec![0.0; HOURS];
    let sh = local_shift(p)?;
    for i in 0..HOURS { put_local(&mut aux, i, aux_kw(p, s, if p.wx.tamb.len() == HOURS { p.wx.tamb[i] } else { 25.0 }), sh); }
    let aux_st = fill_steps(&aux, k, interp);
    let load_st = if p.load_sub.len() == n_steps { Cow::Borrowed(&p.load_sub[..]) } else { fill_steps(&p.load_kw, k, interp) };

    // Forecaster shared by the caller (optimiser candidates), or built from p.ems.
    let own_fc = if inp.forecast.is_none() && (pred || keep_hourly) {
        let cs = if inp.pv_cs_per_kwp.len() == HOURS { inp.pv_cs_per_kwp } else { inp.pv_per_kwp };
        Some(Forecaster::new(em, inp.pv_per_kwp, cs, &p.load_kw, if has_wind { wind_pt } else { &[] }))
    } else { None };
    let fcp: Option<&dyn Forecast> = inp.forecast.or(own_fc.as_ref().map(|f| f as &dyn Forecast));
    let mut planner = Planner::with_fleet(dg, fleet.clone());
    let mut pin = plan_input(p, &fuel);
    let eta = pin.eta;
    let horizon = mx(em.horizon, 0) as usize;
    let (mut e_traj, mut lfc, mut pfc, mut u_plan) = (Vec::new(), vec![0.0; horizon], vec![0.0; horizon], Vec::new());
    let replan = mn(em.replan, em.horizon);   // the plan covers only `horizon` hours

    if keep_hourly {
        r.hourly = Some(new_hourly(has_grid, HOURS));
        if k > 1 { r.steps = Some(new_hourly(has_grid, n_steps)); }
        if let Some(fc) = fcp { forecast_stats(p, fc, inp.pv_per_kwp, s.pv_kwp, &mut r); }
    }

    // Battery ageing over a year: calendar fade plus cycle fade. Cycles are counted at the cells (DC) against the cycle life
    // at its rated depth of discharge. Replacement at the threshold (not in the last year).
    let soh_repl = super::replace_soh(bp);
    let age_bess = |y: &mut YearResult, soh: &mut f64| {
        y.soh_loss_cal = bp.calendar_fade;
        y.soh_loss_cyc = y.bess_efc_dc * (1.0 - bp.eol_soh) / mx(1.0, bp.cycle_life * bp.cycle_life_dod);
        *soh -= y.soh_loss_cal + y.soh_loss_cyc;
        if *soh <= soh_repl && y.year < n_life { y.bess_replaced = true; *soh = 1.0; }
    };

    r.years.reserve(mx(n_life, 1) as usize);
    let mut gy: Option<super::GridYear> = None;   // the grid of the year (its pattern and prices are kept from year 1)
    for yr in 1..=sim_years {
        let mut y = YearResult { year: yr, bess_soh: soh, ..Default::default() };
        if mixed { y.groups = fleet.groups.iter().map(|g| GroupYear { index: g.index, ..Default::default() }).collect(); }
        let load_scale = (1.0 + p.sim.load_growth).powf(f64::from(yr - 1));
        let pv_f = pv_degradation_factor(&p.pv, yr);
        let pv_scale = s.pv_kwp * pv_f;
        let unclip = pv_f < 1.0 && !clip_st.is_empty();
        let enom = if has_bess { s.bess_kwh * soh } else { 0.0 };
        let (emin, emax) = (enom * bp.soc_min, enom * bp.soc_max);
        let esp = mn(emax, enom * mx(bp.soc_min, dg.cc_setpoint));
        let pb = if has_bess { s.bess_kw } else { 0.0 };
        e = clamp(e, emin, emax);
        y.e_start = e;
        let rec = keep_hourly && yr == 1;
        // The grid of the year, with the cost of genset energy that year (fuel, carbon, O&M per kWh) that decides each hour
        // whether the grid goes before the gensets.
        gy = has_grid.then(|| grid_year(&p.grid, yr, p.econ.carbon_price_t, GensetCost::of_year(&p.econ, &fleet.groups[0], yr), gy.as_ref()));
        if let Some(g) = &gy { y.grid_up_h = g.up.iter().filter(|u| **u).count() as f64; y.grid_outages = g.outages(); }
        pin.e_min = emin; pin.e_max = emax; pin.pb = pb;
        let mut plan_t0 = -1000000i32;   // battery capacity changed: re-plan
        let mut peak_b = 0.0f64;         // highest battery charge or discharge power this year
        let (mut lol_run, mut low_run) = (0i32, 0i32);
        let mut aux_unmet = 0.0;         // auxiliary energy left unserved once the whole site load is unmet
        // Forced outages of the year: the units of each group available in each step, and the fleet they leave
        let outs = outages.then(|| fleet.outages(dg.outage_rate, dg.repair_h, dg.outage_seed, yr, k));
        if let Some((_, c, h)) = &outs { y.unit_outages = *c; y.unit_outage_h = *h; }
        let (mut avail_now, mut fl_now): (Vec<i32>, Option<Fleet>) = (Vec::new(), None);

        for ts in 0..n_steps {
            let (t, sub) = (ts / k, ts % k);   // the hour and the step within it
            let ti = t as i32;
            if let Some((av, _, _)) = &outs {
                let row = &av[ts * ng..(ts + 1) * ng];
                if row != &avail_now[..] { avail_now = row.to_vec(); fl_now = Some(fleet.with_available(row)); }
            }
            let fl: &Fleet = fl_now.as_ref().unwrap_or(&fleet);
            let aux_t = aux_st[ts];
            let l = load_st[ts] * load_scale + aux_t;
            // Variable renewables are dispatched together (PV + wind); flows are split back pro rata for reporting.
            let mut psol = pv_st[ts] * pv_scale;
            if unclip && clip_st[ts] > 0.0 { psol += s.pv_kwp * mn(pv_f * clip_st[ts], mx(0.0, pv_cap - pv_f * pv_st[ts])); }
            let pwnd = if has_wind { wind_st[ts] * s.wind_units } else { 0.0 };
            let ppv = psol + pwnd;
            let fpv = if ppv > 0.0 { psol / ppv } else { 1.0 };
            if has_bess && bp.self_discharge > 0.0 { let lo = e * sd; e -= lo; y.self_discharge += lo; }

            // battery power limits of the step: rated power, and the energy above the minimum (below the maximum) over the step
            let dis_cap = mn(pb, mx(0.0, e - emin) * eta / dt);
            let ch_cap = mn(pb, mx(0.0, emax - e) / eta / dt);
            // Battery power that counts as spinning reserve: what it can sustain for reserve_duration_h from the stored energy.
            let res_cap = mn(pb, mx(0.0, e - emin) * eta / bp.reserve_duration_h);

            let (mut dis_limit, mut want_gch, mut soc_tgt, mut b_plan) = (dis_cap, 0.0, 0.0, 0.0);
            let (mut u_floor, mut u_tgt) = (0i32, 0i32);
            let gh = gy.as_ref().map_or(GridHour::default(), |g| g.hour(t, false));
            if pred {
                let fc = fcp.expect("forecaster");
                if sub == 0 && ti - plan_t0 >= replan {   // plans are hourly, made at the start of an hour
                    for j in 0..horizon {
                        let tj = ti + j as i32;
                        lfc[j] = fc.load(ti, tj) * load_scale + aux[(t + j) % HOURS];   // auxiliary load taken as known
                        pfc[j] = fc.pv(ti, tj) * pv_scale + if has_wind { fc.wind(ti, tj) * s.wind_units } else { 0.0 };
                    }
                    if let Some(g) = &gy {
                        pin.grid.clear();
                        pin.grid.extend((0..horizon).map(|j| g.hour_at(t + j, j > 0, fl.loading(lfc[j] - pfc[j]))));
                    }
                    planner.plan(&pin, e, &lfc, &pfc, &mut e_traj, &mut u_plan);
                    plan_t0 = ti;
                    if yr == 1 { r.fc.plans += 1; }
                }
                let j = (ti - plan_t0) as usize;
                // the planned energy at the end of the step (the hour's plan shared evenly over its steps)
                let e_tgt = if k == 1 { e_traj[j + 1] } else { e_traj[j] + (e_traj[j + 1] - e_traj[j]) * (sub + 1) as f64 / k as f64 };
                soc_tgt = if enom > 0.0 { e_tgt / enom } else { 0.0 };
                b_plan = if e > e_tgt { (e - e_tgt) * eta / dt } else { -(e_tgt - e) / eta / dt };
                let err = (l - ppv) - (lfc[j] - pfc[j]);
                if yr == 1 { r.fc.net_error_kwh += err.abs() * dt; }
                if b_plan >= 0.0 { dis_limit = mn(dis_cap, b_plan); } else { dis_limit = 0.0; want_gch = mx(0.0, mn(ch_cap, -b_plan) - mx(0.0, ppv - l)); }
                u_tgt = u_plan[j];
                if em.firm_commitment { u_floor = u_tgt; }
            } else if cc {
                // Once genset charging begins, the battery does not discharge in place of genset output until it reaches the setpoint (it
                // still covers what the gensets cannot). Without the hold it would be topped up in one hour and emptied in the next, losing
                // 1 - RTE per round trip. Units are committed as if held; the hour the setpoint is reached is shared below.
                // A rounding remainder above the minimum SOC counts as empty.
                want_gch = mx(0.0, esp - e) / eta / dt;
                if cc_hold || e - emin <= 1e-6 * enom { dis_limit = 0.0; }
            }

            let pv_load0 = mn(ppv, l);
            let r0 = l - pv_load0;
            let reserve = dg.reserve_load * l + dg.reserve_pv * pv_load0;
            // Merit order of the hour: grid price against genset energy at the loading the residual would give the units.
            let gh = match &gy { Some(g) if gh.up => g.hour_at(t, false, fl.loading(r0 - mn(r0, dis_limit))), _ => gh };
            // While the grid is up no unit has to stay online, its spare import counts as reserve, and when it is cheaper it
            // serves the load before the gensets.
            let min_on_t = if gh.up { 0 } else if outages { fl.min_on } else { min_on };
            // a ramp limit also keeps units online: the fleet cannot drop below the last output less one step's ramp
            if ramps && dg.ramp_pct_min > 0.0 {
                let floor_kw = prev_gen - dg.ramp_pct_min / 100.0 * step_min * fl.cap(prev_units);
                u_floor = mx(u_floor, mn(fl.units_for(floor_kw), fl.units));
            }
            let units_for = |dlim: f64, wg: f64| -> i32 {
                let dis_use = mn(r0, dlim);
                let bess_res = if bp.provides_reserve { mx(0.0, res_cap - dis_use) } else { 0.0 };
                let need = if gh.up {
                    let gi = if gh.cheap { mn(gh.imp, r0 - dis_use) } else { 0.0 };
                    (r0 - dis_use - gi) + (if pred { wg } else { 0.0 }) + mx(0.0, reserve - bess_res - (gh.imp - gi))
                } else { (r0 - dis_use) + (if pred { wg } else { 0.0 }) + mx(0.0, reserve - bess_res) };
                mn(mx(mx(fl.units_for(need), min_on_t), u_floor), fl.units)
            };
            let mut u = units_for(dis_limit, want_gch);
            if pred && u > u_tgt {
                // Real-time compensation: the forecast error would force an unplanned genset start. Diesel marginal fuel is almost flat, so
                // the battery only avoids that start: first drop planned genset charging, then discharge just enough to keep the planned units.
                if units_for(dis_limit, 0.0) <= u_tgt {
                    let (mut lo, mut hi) = (0.0, want_gch);
                    for _ in 0..30 { let mid = 0.5 * (lo + hi); if units_for(dis_limit, mid) <= u_tgt { lo = mid } else { hi = mid } }
                    want_gch = lo;
                } else if units_for(dis_cap, 0.0) <= u_tgt {
                    want_gch = 0.0;
                    let (mut lo, mut hi) = (dis_limit, dis_cap);
                    for _ in 0..30 { let mid = 0.5 * (lo + hi); if units_for(mid, 0.0) <= u_tgt { hi = mid } else { lo = mid } }
                    dis_limit = hi;
                }
                u = units_for(dis_limit, want_gch);
            }
            let uf = f64::from(u);
            let (gmin, gmax) = (fl.gmin(u), fl.cap(u));
            // Ramps and start time: units started in the step deliver only after the start time, and the fleet output moves by at
            // most the ramp rate times the online rating per minute (both from the previous step's output).
            let (mut glo, mut ghi) = (gmin, gmax);
            if ramps {
                let was = mn(prev_units, u);
                let started = if dg.start_min > 0.0 { mx(0.0, 1.0 - dg.start_min / step_min) } else { 1.0 };
                ghi = fl.cap(was) + (gmax - fl.cap(was)) * started;
                if dg.ramp_pct_min > 0.0 {
                    let rk = dg.ramp_pct_min / 100.0 * step_min * mx(gmax, fl.cap(prev_units));
                    ghi = mn(ghi, prev_gen + rk);
                    glo = mx(glo, prev_gen - rk);
                }
                ghi = mx(ghi, 0.0);
                glo = mn(glo, ghi);
            }

            // Cycle charging shares the hour at either end of a charge so results do not jump by whole hours: a hold that reaches the
            // setpoint part way frees the battery for the rest of the hour; a battery that runs empty part way is charged for the rest.
            let c_idle = if cc { mn(pb, mx(0.0, ppv + ghi - l)) } else { 0.0 };
            let mut dis_frac = 1.0;
            if cc && cc_hold && c_idle > want_gch {
                dis_frac = 1.0 - want_gch / c_idle;
                dis_limit = mn(dis_frac * pb, mx(0.0, esp - emin) * eta / dt);
            }

            // Allocation: genset minimum (must run) -> PV -> BESS -> genset above minimum -> BESS reserve
            let mut g_load = mn(glo, l);
            let g_excess = glo - g_load;
            let mut rem = l - g_load;
            let pv_load = mn(ppv, rem);
            rem -= pv_load;
            let mut surplus = ppv - pv_load;
            let deficit = rem;   // what the battery is asked to cover before gensets go above minimum
            let mut dis = mn(rem * dis_frac, dis_limit);
            rem -= dis;
            let mut gi = 0.0;   // grid import: before the gensets when cheaper, else for what they cannot cover
            if gh.cheap { gi = mn(rem, gh.imp); rem -= gi; }
            let ramp_hit = ramps && ghi < gmax - 1e-9 && rem > ghi - glo + 1e-9;   // asked for more than the ramp or start allows
            let gx = mn(rem, ghi - glo);
            g_load += gx;
            rem -= gx;
            if gh.up && !gh.cheap { gi = mn(rem, gh.imp); rem -= gi; }
            if rem > 0.0 { let extra = mn(rem, mx(0.0, dis_cap - dis)); dis += extra; rem -= extra; }
            let unmet = mx(0.0, rem);

            // Charging: PV surplus first, then unavoidable genset excess, then deliberate genset charging
            let pv_ch = mn(surplus, ch_cap);
            surplus -= pv_ch;
            let gx_out = if gh.up { mn(surplus, gh.exp) } else { 0.0 };   // export of what the battery cannot take
            if gh.up { surplus -= gx_out; }
            let mut g_ch = mn(g_excess, ch_cap - pv_ch);
            let dump = g_excess - g_ch;
            let mut g_delib = 0.0;   // deliberate genset charging from the headroom of the online units
            // Cycle charging: share of the hour the battery spent discharging when it ran empty within it (1 otherwise).
            let t_dis = if cc && !cc_hold && dis > 0.0 && e - dis * dt / eta <= emin + 1e-6 * enom { dis / mn(pb, deficit) } else { 1.0 };
            if u > 0 && ((want_gch > 0.0 && (dis <= 0.0 || (cc && cc_hold))) || t_dis < 1.0) {
                let room = if t_dis < 1.0 { mn((1.0 - t_dis) * c_idle, (esp - (e - dis * dt / eta)) / eta / dt) - pv_ch - g_ch }
                           else { mn(ch_cap - pv_ch - g_ch, want_gch - (if cc { pv_ch } else { 0.0 }) - g_ch) };
                let head = ghi - (g_load + g_excess);
                g_delib = mx(0.0, mn(room, head));
                g_ch += g_delib;
            }
            let e_top = e + (pv_ch + g_ch) * eta * dt;   // after charging, before any discharge in the same step
            e += ((pv_ch + g_ch) * eta - dis / eta) * dt;
            e = clamp(e, 0.0, mx(emax, 0.0));
            if cc { cc_hold = (cc_hold || g_delib > 0.0) && (if cc_hold { e_top } else { e }) < esp - 1e-6 * enom; }
            if pred && yr == 1 { r.fc.bess_compensation_kwh += ((dis - pv_ch - g_ch) - b_plan).abs() * dt; }

            let gen = g_load + g_ch + dump;
            let fuel_l = if u > 0 { fl.fuel_lh(u, gen) * dt } else { 0.0 };   // litres in the step
            prev_gen = gen;

            // Operational adequacy: spinning reserve left after allocation (genset charging can be interrupted) against the load step plus
            // the renewable loss when PV + wind drop by reserve_pv. Curtailed and charging power absorbs that drop first.
            let head_g = gmax - (g_load + dump);
            let head_b = if bp.provides_reserve { mx(0.0, res_cap - dis) } else { 0.0 };
            let re_drop = mx(0.0, pv_load - (1.0 - dg.reserve_pv) * ppv);
            let short_kw = if gh.up { mx(0.0, dg.reserve_load * l + re_drop - head_g - head_b - (gh.imp - gi)) }
                           else { mx(0.0, dg.reserve_load * l + re_drop - head_g - head_b) };
            if short_kw > 1e-3 * l { y.reserve_short_h += dt; y.reserve_short_max_kw = mx(y.reserve_short_max_kw, short_kw); }
            // N-1: the output of the largest online unit, lost at once, against the headroom of the rest, the battery and the grid
            if n1 && u > 0 {
                let (big, lf) = (fl.largest(u), gen / gmax);
                let cover = (head_g - big * (1.0 - lf)) + head_b + if gh.up { gh.imp - gi } else { 0.0 };
                let gap = mx(0.0, big * lf - cover);
                if gap > 1e-3 * l { y.n1_short_h += dt; y.n1_short_max_kw = mx(y.n1_short_max_kw, gap); }
            }
            if ramp_hit { y.ramp_limited_h += dt; }
            let lol = unmet > 1e-3 * l;
            let low = u > 0 && gen <= gmin + 1e-6;
            lol_run = if lol { lol_run + 1 } else { 0 };
            low_run = if low { low_run + 1 } else { 0 };
            if lol { y.lol_h += dt; if lol_run == 1 { y.lol_events += 1.0; } y.lol_max_h = mx(y.lol_max_h, f64::from(lol_run) * dt); }
            if low { y.minload_h += dt; y.minload_run_max_h = mx(y.minload_run_max_h, f64::from(low_run) * dt); }
            y.max_units = mx(y.max_units, uf);
            if u > 0 && u == fleet.units { y.fleet_full_h += dt; }
            if let Some(g) = &gy {
                y.grid_import += gi * dt;
                y.grid_import_val += gi * dt * g.price0[t];
                y.grid_export += gx_out * dt;
                y.pv_to_grid += gx_out * fpv * dt;
                y.wind_to_grid += gx_out * (1.0 - fpv) * dt;
                y.grid_peak_kw = mx(y.grid_peak_kw, gi);
                let m = crate::model::month_of_day((t / 24) as i32) as usize;
                y.grid_month_peak[m] = mx(y.grid_month_peak[m], gi);
            }
            // units started in the hour (the change over its steps), not counting the initial start
            if sub == 0 { units_hour0 = prev_units; }
            if sub == k - 1 && (yr > 1 || t > 0) { y.max_starts_h = mx(y.max_starts_h, f64::from(u - units_hour0)); }

            // energies: power x dt (exact for hourly steps)
            y.load += l * dt;
            y.aux += aux_t * dt;
            y.unmet += unmet * dt;
            aux_unmet += mx(0.0, unmet - (l - aux_t)) * dt;
            y.max_unmet_kw = mx(y.max_unmet_kw, unmet);
            y.pv_avail += psol * dt;
            y.pv_to_load += pv_load * fpv * dt;
            y.pv_to_bess += pv_ch * fpv * dt;
            y.pv_curtailed += surplus * fpv * dt;
            y.wind_avail += pwnd * dt;
            y.wind_used += (pv_load + pv_ch) * (1.0 - fpv) * dt;
            y.wind_curtailed += surplus * (1.0 - fpv) * dt;
            y.wind_to_load += pv_load * (1.0 - fpv) * dt;
            y.wind_to_bess += pv_ch * (1.0 - fpv) * dt;
            y.re_avail += ppv * dt;
            y.re_direct += pv_load0 * dt;
            y.bess_dis += dis * dt;
            y.bess_ch += (pv_ch + g_ch) * dt;
            peak_b = mx(peak_b, mx(dis, pv_ch + g_ch));
            y.gen_kwh += gen * dt;
            y.gen_to_load += g_load * dt;
            y.gen_to_bess += g_ch * dt;
            y.gen_dump += dump * dt;
            y.fuel_l += fuel_l;
            y.unit_hours += uf * dt;
            if u > prev_units { y.starts += f64::from(u - prev_units); }
            if mixed {
                // each group's units share the output at one loading
                let (on, was) = (fl.online(u), fl.online(prev_units));
                let lf = if u > 0 { gen / gmax } else { 0.0 };
                for (g, gr) in fl.groups.iter().enumerate() {
                    let (n, gy_) = (f64::from(on[g]), &mut y.groups[g]);
                    gy_.unit_hours += n * dt;
                    gy_.gen_kwh += n * gr.unit_kw * lf * dt;
                    if n > 0.0 { gy_.fuel_l += n * gr.unit_kw * gr.fuel.at(lf) * dt; }
                    if on[g] > was[g] { gy_.starts += f64::from(on[g] - was[g]); }
                }
            }
            prev_units = u;

            if rec {
                let v = StepVals {
                    load: l, aux: aux_t, pv_avail: psol, pv_to_load: pv_load * fpv, pv_to_bess: pv_ch * fpv, pv_curtailed: surplus * fpv,
                    wind_avail: pwnd, wind_to_load: pv_load * (1.0 - fpv), wind_to_bess: pv_ch * (1.0 - fpv), wind_curtailed: surplus * (1.0 - fpv),
                    bess_dis: dis, gen_to_bess: g_ch, gen_to_load: g_load, gen_dump: dump, gen_units: uf, fuel_l, unmet,
                    soc: if enom > 0.0 { e / enom } else { 0.0 }, soc_target: soc_tgt,
                    grid: has_grid.then_some((gi, gx_out, if gh.up { 1.0 } else { 0.0 })),
                };
                // hourly steps: the hour's values; shorter steps: hourly means (state of charge at the end of the hour) and each step
                if k == 1 { put(r.hourly.as_mut().expect("hourly series"), t, &v, None); }
                else {
                    put(r.hourly.as_mut().expect("hourly series"), t, &v, Some(dt));
                    put(r.steps.as_mut().expect("step series"), ts, &v, None);
                }
            }
        }

        y.e_end = e;
        y.served = y.load - y.unmet;
        y.served_site = y.served - (y.aux - aux_unmet);   // unmet energy is attributed to the site load first
        // Grid imports are not renewable; exports are not part of the served load.
        let non_re = if has_grid { y.gen_kwh - y.gen_dump + y.grid_import } else { y.gen_kwh - y.gen_dump };
        y.re_fraction = if y.served > 0.0 { clamp(1.0 - non_re / y.served, 0.0, 1.0) } else { 0.0 };
        y.co2_t = y.fuel_l * p.econ.co2_kg_per_l / 1000.0;
        if has_grid { y.co2_t += y.grid_import * p.grid.co2_kg_per_kwh / 1000.0; }
        y.nox_t = y.fuel_l * p.econ.nox_g_per_l / 1e6;
        y.sox_t = y.fuel_l * p.econ.sox_g_per_l / 1e6;
        if has_bess {
            y.bess_efc = y.bess_dis / s.bess_kwh;
            y.bess_efc_dc = y.bess_dis / (eta * s.bess_kwh);
            y.max_c_rate = peak_b / s.bess_kwh;
            age_bess(&mut y, &mut soh);
        }
        r.years.push(y);
    }

    // Fast mode: repeat year 1 energy flows (cycles, C-rate, stored energy and adequacy counts included), but still age the
    // battery year by year.
    for yr in sim_years + 1..=n_life {
        let mut y = r.years[0].clone();
        y.year = yr;
        y.bess_soh = soh;
        y.bess_replaced = false;
        if has_bess { age_bess(&mut y, &mut soh); }
        r.years.push(y);
    }

    econ::economics(p, s, soh, &mut r);
    Ok(r)
}
