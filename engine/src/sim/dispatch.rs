//! The hourly dispatch over the project years and the battery ageing (simulate in src/sim.cpp)
use super::{aux_kw, clamp, econ, mn, mx, plan_input, Forecast, FuelTable, Hourly, Planner, SimInput, SimResult, Sizing, YearResult};
use crate::forecast::Forecaster;
use crate::pv::{local_shift, put_local};
use crate::{pv_degradation_factor, Error, Project, HOURS};

/// Year-1 forecast skill (independent of the dispatch strategy, so it is always reported with the hourly series)
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

fn zeros() -> Vec<f64> { vec![0.0; HOURS] }

fn new_hourly() -> Hourly {
    Hourly {
        load: zeros(), aux: zeros(), pv_avail: zeros(), pv_to_load: zeros(), pv_to_bess: zeros(), pv_curtailed: zeros(), bess_dis: zeros(),
        gen_to_bess: zeros(), gen_to_load: zeros(), gen_dump: zeros(), gen_units: zeros(), fuel_l: zeros(), unmet: zeros(), soc: zeros(),
        wind_avail: zeros(), wind_to_load: zeros(), wind_to_bess: zeros(), wind_curtailed: zeros(), pv_fc_h1: zeros(), load_fc_h1: zeros(),
        pv_fc_da: zeros(), load_fc_da: zeros(), soc_target: zeros(),
    }
}

/// Simulates the project with sizing `s`: every project year hour by hour (or year 1 repeated, `p.sim.all_years` false),
/// then the economics. keep_hourly keeps the year-1 series and the forecast skill.
pub fn simulate(p: &Project, inp: &SimInput, s: &Sizing, keep_hourly: bool) -> Result<SimResult, Error> {
    let mut r = SimResult { size: *s, ..Default::default() };
    let (dg, bp, em) = (&p.dg, &p.bess, &p.ems);
    let fuel = FuelTable::new(dg)?;

    let has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    let cc = dg.strategy == "cycle_charging";
    let pred = dg.strategy == "predictive" && has_bess;
    let min_on = if dg.units > 0 { mn(dg.min_units_online, dg.units) } else { 0 };
    let pr = dg.unit_kw;

    let n_life = p.econ.lifetime;
    let sim_years = if p.sim.all_years { n_life } else { 1 };
    let has_wind = s.wind_units > 0.5;
    if p.load_kw.len() != HOURS || inp.pv_per_kwp.len() != HOURS { return Err(Error("The load and PV series need 8760 hours.".into())); }
    if has_wind && inp.wind_per_turbine.len() != HOURS { return Err(Error("The wind series needs 8760 hours.".into())); }
    let wind_pt = inp.wind_per_turbine;
    let mut soh = if has_bess { bp.soh_init } else { 1.0 };
    let mut e = if has_bess { s.bess_kwh * bp.soc_init } else { 0.0 };   // stored energy (kWh)
    let mut prev_units = 0i32;
    let mut cc_hold = false;   // cycle charging: gensets are charging the battery toward the setpoint, so it holds its energy

    // Auxiliary load by local hour (ambient shifted to local time as in the PV model). It does not grow with the load.
    let mut aux = zeros();
    let sh = local_shift(p)?;
    for i in 0..HOURS { put_local(&mut aux, i, aux_kw(p, s, if p.wx.tamb.len() == HOURS { p.wx.tamb[i] } else { 25.0 }), sh); }

    // A forecaster shared by the caller (the optimiser's candidates), or one built from p.ems when needed
    let own_fc = if inp.forecast.is_none() && (pred || keep_hourly) {
        let cs = if inp.pv_cs_per_kwp.len() == HOURS { inp.pv_cs_per_kwp } else { inp.pv_per_kwp };
        Some(Forecaster::new(em, inp.pv_per_kwp, cs, &p.load_kw, if has_wind { wind_pt } else { &[] }))
    } else { None };
    let fcp: Option<&dyn Forecast> = inp.forecast.or(own_fc.as_ref().map(|f| f as &dyn Forecast));
    let mut planner = Planner::new(dg, &fuel);
    let mut pin = plan_input(p, &fuel);
    let eta = pin.eta;
    let horizon = mx(em.horizon, 0) as usize;
    let (mut e_traj, mut lfc, mut pfc, mut u_plan) = (Vec::new(), vec![0.0; horizon], vec![0.0; horizon], Vec::new());
    let replan = mn(em.replan, em.horizon);   // the plan covers only `horizon` hours

    if keep_hourly {
        r.hourly = Some(new_hourly());
        if let Some(fc) = fcp { forecast_stats(p, fc, inp.pv_per_kwp, s.pv_kwp, &mut r); }
    }

    // Battery ageing over a year: calendar fade plus cycle fade. Cycles are counted at the cells (DC) against the cycle life
    // at its rated depth of discharge. Replacement at the threshold (not in the last year).
    let soh_repl = if bp.replace_soh >= 0.0 { bp.replace_soh } else { bp.eol_soh };
    let age_bess = |y: &mut YearResult, soh: &mut f64| {
        y.soh_loss_cal = bp.calendar_fade;
        y.soh_loss_cyc = y.bess_efc_dc * (1.0 - bp.eol_soh) / mx(1.0, bp.cycle_life * bp.cycle_life_dod);
        *soh -= y.soh_loss_cal + y.soh_loss_cyc;
        if *soh <= soh_repl && y.year < n_life { y.bess_replaced = true; *soh = 1.0; }
    };

    r.years.reserve(mx(n_life, 1) as usize);
    for yr in 1..=sim_years {
        let mut y = YearResult { year: yr, bess_soh: soh, ..Default::default() };
        let load_scale = (1.0 + p.sim.load_growth).powf(f64::from(yr - 1));
        let pv_scale = s.pv_kwp * pv_degradation_factor(&p.pv, yr);
        let enom = if has_bess { s.bess_kwh * soh } else { 0.0 };
        let (emin, emax) = (enom * bp.soc_min, enom * bp.soc_max);
        let esp = mn(emax, enom * mx(bp.soc_min, dg.cc_setpoint));
        let pb = if has_bess { s.bess_kw } else { 0.0 };
        e = clamp(e, emin, emax);
        y.e_start = e;
        let rec = keep_hourly && yr == 1;
        pin.e_min = emin; pin.e_max = emax; pin.pb = pb;
        let mut plan_t0 = -1000000i32;   // battery capacity changed: re-plan
        let mut peak_b = 0.0f64;         // highest battery charge or discharge power this year
        let (mut lol_run, mut low_run) = (0i32, 0i32);   // current runs of loss-of-load and low-load hours
        let mut aux_unmet = 0.0;         // auxiliary energy left unserved once the whole site load is unmet

        for t in 0..HOURS {
            let ti = t as i32;
            let l = p.load_kw[t] * load_scale + aux[t];
            // Variable renewables are dispatched together (PV + wind); flows are split back pro rata for reporting.
            let psol = inp.pv_per_kwp[t] * pv_scale;
            let pwnd = if has_wind { wind_pt[t] * s.wind_units } else { 0.0 };
            let ppv = psol + pwnd;
            let fpv = if ppv > 0.0 { psol / ppv } else { 1.0 };
            if has_bess && bp.self_discharge > 0.0 { let lo = e * bp.self_discharge; e -= lo; y.self_discharge += lo; }

            let dis_cap = mn(pb, mx(0.0, e - emin) * eta);
            let ch_cap = mn(pb, mx(0.0, emax - e) / eta);
            // Battery power that counts as spinning reserve: what it can sustain for reserve_duration_h from the stored energy.
            let res_cap = mn(pb, mx(0.0, e - emin) * eta / bp.reserve_duration_h);

            // Control layer: how far the battery may discharge, how much the gensets should charge
            let (mut dis_limit, mut want_gch, mut soc_tgt, mut b_plan) = (dis_cap, 0.0, 0.0, 0.0);
            let (mut u_floor, mut u_tgt) = (0i32, 0i32);
            if pred {
                let fc = fcp.expect("forecaster");
                if ti - plan_t0 >= replan {
                    for j in 0..horizon {
                        let tj = ti + j as i32;
                        lfc[j] = fc.load(ti, tj) * load_scale + aux[(t + j) % HOURS];   // auxiliary load taken as known
                        pfc[j] = fc.pv(ti, tj) * pv_scale + if has_wind { fc.wind(ti, tj) * s.wind_units } else { 0.0 };
                    }
                    planner.plan(&pin, e, &lfc, &pfc, &mut e_traj, &mut u_plan);
                    plan_t0 = ti;
                    if yr == 1 { r.fc.plans += 1; }
                }
                let j = (ti - plan_t0) as usize;
                let e_tgt = e_traj[j + 1];
                soc_tgt = if enom > 0.0 { e_tgt / enom } else { 0.0 };
                b_plan = if e > e_tgt { (e - e_tgt) * eta } else { -(e_tgt - e) / eta };
                let err = (l - ppv) - (lfc[j] - pfc[j]);
                if yr == 1 { r.fc.net_error_kwh += err.abs(); }
                if b_plan >= 0.0 { dis_limit = mn(dis_cap, b_plan); } else { dis_limit = 0.0; want_gch = mx(0.0, mn(ch_cap, -b_plan) - mx(0.0, ppv - l)); }
                u_tgt = u_plan[j];
                if em.firm_commitment { u_floor = u_tgt; }
            } else if cc {
                // Once genset charging has begun, the battery does not discharge in place of genset output until it reaches
                // the setpoint (it still covers what the gensets cannot). Without this hold the battery would be topped up in
                // one hour and emptied in the next, losing 1 - RTE of the energy on every round trip. Units are committed as
                // if the battery were held; the hour in which the setpoint is reached is shared below.
                // A rounding remainder above the minimum SOC counts as empty.
                want_gch = mx(0.0, esp - e) / eta;
                if cc_hold || e - emin <= 1e-6 * enom { dis_limit = 0.0; }
            }

            // Unit commitment: residual deficit + planned charging + spinning reserve
            let pv_load0 = mn(ppv, l);
            let r0 = l - pv_load0;
            let reserve = dg.reserve_load * l + dg.reserve_pv * pv_load0;
            let units_for = |dlim: f64, wg: f64| -> i32 {
                let dis_use = mn(r0, dlim);
                let bess_res = if bp.provides_reserve { mx(0.0, res_cap - dis_use) } else { 0.0 };
                let need = (r0 - dis_use) + (if pred { wg } else { 0.0 }) + mx(0.0, reserve - bess_res);
                let n = if need > 1e-6 { (need / pr - 1e-9).ceil() as i32 } else { 0 };
                mn(mx(mx(n, min_on), u_floor), dg.units)
            };
            let mut u = units_for(dis_limit, want_gch);
            if pred && u > u_tgt {
                // Real-time compensation: the forecast error would force an unplanned genset start. Diesel marginal fuel is
                // almost flat, so the battery only steps in to avoid that start: first drop planned genset charging, then
                // discharge just enough to stay on the planned units.
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
            let (gmin, gmax) = (uf * pr * dg.min_load, uf * pr);

            // Cycle charging shares the hour at either end of a charge, so results do not jump by whole hours: a hold that
            // reaches the setpoint part way through the hour frees the battery for the rest of it (here), and a battery that
            // runs empty part way through is charged for the rest of it (charging step).
            let c_idle = if cc { mn(pb, mx(0.0, ppv + gmax - l)) } else { 0.0 };   // charging power while the battery is idle
            let mut dis_frac = 1.0;                                                   // share of the hour it may discharge in
            if cc && cc_hold && c_idle > want_gch {
                dis_frac = 1.0 - want_gch / c_idle;
                dis_limit = mn(dis_frac * pb, mx(0.0, esp - emin) * eta);
            }

            // Allocation: genset minimum (must run) -> PV -> BESS -> genset above minimum -> BESS reserve
            let mut g_load = mn(gmin, l);
            let g_excess = gmin - g_load;
            let mut rem = l - g_load;
            let pv_load = mn(ppv, rem);
            rem -= pv_load;
            let mut surplus = ppv - pv_load;
            let deficit = rem;   // what the battery is asked to cover before gensets go above minimum
            let mut dis = mn(rem * dis_frac, dis_limit);
            rem -= dis;
            let gx = mn(rem, gmax - gmin);
            g_load += gx;
            rem -= gx;
            if rem > 0.0 { let extra = mn(rem, mx(0.0, dis_cap - dis)); dis += extra; rem -= extra; }
            let unmet = mx(0.0, rem);

            // Charging: PV surplus first, then unavoidable genset excess, then deliberate genset charging
            let pv_ch = mn(surplus, ch_cap);
            surplus -= pv_ch;
            let mut g_ch = mn(g_excess, ch_cap - pv_ch);
            let dump = g_excess - g_ch;
            let mut g_delib = 0.0;   // deliberate genset charging from the headroom of the online units
            // Cycle charging: share of the hour the battery spent discharging when it ran empty within it (1 otherwise).
            let t_dis = if cc && !cc_hold && dis > 0.0 && e - dis / eta <= emin + 1e-6 * enom { dis / mn(pb, deficit) } else { 1.0 };
            if u > 0 && ((want_gch > 0.0 && (dis <= 0.0 || (cc && cc_hold))) || t_dis < 1.0) {
                let room = if t_dis < 1.0 { mn((1.0 - t_dis) * c_idle, (esp - (e - dis / eta)) / eta) - pv_ch - g_ch }
                           else { mn(ch_cap - pv_ch - g_ch, want_gch - (if cc { pv_ch } else { 0.0 }) - g_ch) };
                let head = gmax - (g_load + g_excess);
                g_delib = mx(0.0, mn(room, head));
                g_ch += g_delib;
            }
            let e_top = e + (pv_ch + g_ch) * eta;   // after charging, before any discharge in the same hour
            e += (pv_ch + g_ch) * eta - dis / eta;
            e = clamp(e, 0.0, mx(emax, 0.0));
            if cc { cc_hold = (cc_hold || g_delib > 0.0) && (if cc_hold { e_top } else { e }) < esp - 1e-6 * enom; }
            if pred && yr == 1 { r.fc.bess_compensation_kwh += ((dis - pv_ch - g_ch) - b_plan).abs(); }

            let gen = g_load + g_ch + dump;
            let fuel_l = if u > 0 { uf * pr * fuel.at(gen / gmax) } else { 0.0 };

            // Operational adequacy: spinning reserve left after allocation (genset charging can be interrupted) against the
            // load step plus the renewable power the load loses when PV + wind drop by reserve_pv. Curtailed and charging
            // power absorbs that drop first, so gensets held at minimum loading are not counted short.
            let head_g = gmax - (g_load + dump);
            let head_b = if bp.provides_reserve { mx(0.0, res_cap - dis) } else { 0.0 };
            let re_drop = mx(0.0, pv_load - (1.0 - dg.reserve_pv) * ppv);
            let short_kw = mx(0.0, dg.reserve_load * l + re_drop - head_g - head_b);
            if short_kw > 1e-3 * l { y.reserve_short_h += 1.0; y.reserve_short_max_kw = mx(y.reserve_short_max_kw, short_kw); }
            let lol = unmet > 1e-3 * l;
            let low = u > 0 && gen <= gmin + 1e-6;
            lol_run = if lol { lol_run + 1 } else { 0 };
            low_run = if low { low_run + 1 } else { 0 };
            if lol { y.lol_h += 1.0; if lol_run == 1 { y.lol_events += 1.0; } y.lol_max_h = mx(y.lol_max_h, f64::from(lol_run)); }
            if low { y.minload_h += 1.0; y.minload_run_max_h = mx(y.minload_run_max_h, f64::from(low_run)); }
            y.max_units = mx(y.max_units, uf);
            if u > 0 && u == dg.units { y.fleet_full_h += 1.0; }
            if yr > 1 || t > 0 { y.max_starts_h = mx(y.max_starts_h, f64::from(u - prev_units)); }   // not the initial start

            y.load += l;
            y.aux += aux[t];
            y.unmet += unmet;
            aux_unmet += mx(0.0, unmet - (l - aux[t]));
            y.max_unmet_kw = mx(y.max_unmet_kw, unmet);
            y.pv_avail += psol;
            y.pv_to_load += pv_load * fpv;
            y.pv_to_bess += pv_ch * fpv;
            y.pv_curtailed += surplus * fpv;
            y.wind_avail += pwnd;
            y.wind_used += (pv_load + pv_ch) * (1.0 - fpv);
            y.wind_curtailed += surplus * (1.0 - fpv);
            y.wind_to_load += pv_load * (1.0 - fpv);
            y.wind_to_bess += pv_ch * (1.0 - fpv);
            y.re_avail += ppv;
            y.re_direct += pv_load0;
            y.bess_dis += dis;
            y.bess_ch += pv_ch + g_ch;
            peak_b = mx(peak_b, mx(dis, pv_ch + g_ch));
            y.gen_kwh += gen;
            y.gen_to_load += g_load;
            y.gen_to_bess += g_ch;
            y.gen_dump += dump;
            y.fuel_l += fuel_l;
            y.unit_hours += uf;
            if u > prev_units { y.starts += f64::from(u - prev_units); }
            prev_units = u;

            if rec {
                let h = r.hourly.as_mut().expect("hourly series");
                h.load[t] = l; h.aux[t] = aux[t]; h.pv_avail[t] = psol; h.pv_to_load[t] = pv_load * fpv; h.pv_to_bess[t] = pv_ch * fpv;
                h.pv_curtailed[t] = surplus * fpv; h.wind_avail[t] = pwnd; h.wind_to_load[t] = pv_load * (1.0 - fpv);
                h.wind_to_bess[t] = pv_ch * (1.0 - fpv); h.wind_curtailed[t] = surplus * (1.0 - fpv); h.bess_dis[t] = dis;
                h.gen_to_bess[t] = g_ch; h.gen_to_load[t] = g_load; h.gen_dump[t] = dump; h.gen_units[t] = uf; h.fuel_l[t] = fuel_l;
                h.unmet[t] = unmet;
                h.soc[t] = if enom > 0.0 { e / enom } else { 0.0 };
                h.soc_target[t] = soc_tgt;
            }
        }

        y.e_end = e;
        y.served = y.load - y.unmet;
        y.served_site = y.served - (y.aux - aux_unmet);   // unmet energy is attributed to the site load first
        y.re_fraction = if y.served > 0.0 { clamp(1.0 - (y.gen_kwh - y.gen_dump) / y.served, 0.0, 1.0) } else { 0.0 };
        y.co2_t = y.fuel_l * p.econ.co2_kg_per_l / 1000.0;
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
