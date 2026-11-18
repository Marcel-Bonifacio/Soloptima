//! Dispatch over the project years, hour by hour or in 30 or 15 minute steps, and the battery ageing (simulate in src/sim.cpp).
use super::ageing::CycleCount;
use super::deferrable::Flex;
use super::fleet::share_up;
use super::planner::{fr_fits, fr_headroom};
use super::{aux_kw, clamp, econ, grid_year, mn, mx, Extras, GensetCost, plan_input, Fleet, Forecast, FuelTable, GridHour, GroupYear, Hourly, Planner, SimInput, SimResult, Sizing, YearResult};
use crate::forecast::Forecaster;
use crate::pv::{local_shift, put_local};
use crate::{pv_degradation_factor, DieselParams, Error, Project, HOURS};
use std::borrow::Cow;
use std::collections::VecDeque;

/// What keeps the random draws of the inverter blocks and the PCS units apart from each other's and the gensets'
const INVERTERS: u64 = 0xA1 << 48;
const PCS_UNITS: u64 = 0xB2 << 48;

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

/// Values of one step for the series of `Hourly` (in the order of `put`); those of series a run does not keep are left out
struct StepVals {
    load: f64, aux: f64, pv_avail: f64, pv_to_load: f64, pv_to_bess: f64, pv_curtailed: f64, wind_avail: f64, wind_to_load: f64,
    wind_to_bess: f64, wind_curtailed: f64, bess_dis: f64, gen_to_bess: f64, gen_to_load: f64, gen_dump: f64, gen_units: f64, fuel_l: f64,
    unmet: f64, soc: f64, soc_target: f64, grid_import: f64, grid_export: f64, grid_up: f64, grid_to_bess: f64,
    /// the deferrable load's power and its store's level at the end of the step
    dl: f64, dl_tank: f64,
}

/// Puts a step into series `h` at `i`: the value itself (w = None), or adds w x value (hourly means of shorter steps); the
/// state of charge and its target, and the deferrable load's store, are those at the end of the hour. Series `new_hourly`
/// left empty are skipped.
fn put(h: &mut Hourly, i: usize, v: &StepVals, w: Option<f64>) {
    let f = |a: &mut Vec<f64>, x: f64| if !a.is_empty() { match w { None => a[i] = x, Some(w) => a[i] += x * w } };
    f(&mut h.load, v.load); f(&mut h.aux, v.aux); f(&mut h.pv_avail, v.pv_avail); f(&mut h.pv_to_load, v.pv_to_load);
    f(&mut h.pv_to_bess, v.pv_to_bess); f(&mut h.pv_curtailed, v.pv_curtailed); f(&mut h.wind_avail, v.wind_avail);
    f(&mut h.wind_to_load, v.wind_to_load); f(&mut h.wind_to_bess, v.wind_to_bess); f(&mut h.wind_curtailed, v.wind_curtailed);
    f(&mut h.bess_dis, v.bess_dis); f(&mut h.gen_to_bess, v.gen_to_bess); f(&mut h.gen_to_load, v.gen_to_load); f(&mut h.gen_dump, v.gen_dump);
    f(&mut h.gen_units, v.gen_units); f(&mut h.unmet, v.unmet);
    f(&mut h.grid_import, v.grid_import); f(&mut h.grid_export, v.grid_export); f(&mut h.grid_up, v.grid_up);
    f(&mut h.grid_to_bess, v.grid_to_bess); f(&mut h.dl, v.dl);
    if !h.dl_tank.is_empty() { h.dl_tank[i] = v.dl_tank; }
    // fuel: litres in the step (summed into the hour), state of charge: at the end
    match w { None => h.fuel_l[i] = v.fuel_l, Some(_) => h.fuel_l[i] += v.fuel_l }
    h.soc[i] = v.soc;
    h.soc_target[i] = v.soc_target;
}

/// The series a run keeps: the grid's with a grid connection, the others' with their options (the store's with a store)
fn new_hourly(x: &Extras, grid: bool, tank: bool, n: usize) -> Hourly {
    let zeros = || vec![0.0; n];
    let some = |on: bool| if on { zeros() } else { Vec::new() };
    Hourly {
        dl: some(x.deferrable), dl_tank: some(tank),
        grid_import: some(grid), grid_export: some(grid), grid_up: some(grid), grid_to_bess: some(x.grid_charge),
        load: zeros(), aux: zeros(), pv_avail: zeros(), pv_to_load: zeros(), pv_to_bess: zeros(), pv_curtailed: zeros(), bess_dis: zeros(),
        gen_to_bess: zeros(), gen_to_load: zeros(), gen_dump: zeros(), gen_units: zeros(), fuel_l: zeros(), unmet: zeros(), soc: zeros(),
        wind_avail: zeros(), wind_to_load: zeros(), wind_to_bess: zeros(), wind_curtailed: zeros(), pv_fc_h1: zeros(), load_fc_h1: zeros(),
        pv_fc_da: zeros(), load_fc_da: zeros(), soc_target: zeros(),
    }
}

impl Extras {
    /// The options of project p in use with sizing s, its genset fleet and k steps an hour
    fn of(p: &Project, s: &Sizing, dg: &DieselParams, fleet: &Fleet, k: usize) -> Extras {
        let (has_grid, has_bess, ec) = (p.grid.enabled, s.has_bess(), &p.econ);
        let tiers = p.sim.critical_share < 1.0;
        Extras {
            ramps: dg.ramp_pct_min > 0.0 || dg.start_min > 0.0,
            unit_outages: dg.outage_rate > 0.0 && fleet.units > 0,
            n1: dg.n1_check,
            inverter_outages: p.pv.inverter_outage_rate > 0.0 && s.pv_kwp > 0.0,
            pcs_outages: p.bess.pcs_outage_rate > 0.0 && has_bess && s.bess_kw > 0.0,
            grid_charge: has_grid && (p.grid.charge_bess || p.grid.reserve_kw > 0.0),
            freq_reserve: has_grid && p.grid.reserve_kw > 0.0,
            cycle_curve: has_bess && !p.bess.cycle_curve.is_empty(),
            min_updown: (dg.min_down_h * k as f64).ceil() as i64 > 0,
            start_cost: ec.diesel_start_cost > 0.0,
            gen_wear: fleet.groups.iter().any(|g| g.overhaul_h > 0.0 || g.life_h > 0.0),
            pollutants: [ec.pm25_g_per_l, ec.co_g_per_l, ec.nox_price_kg, ec.sox_price_kg, ec.pm25_price_kg, ec.co_price_kg].iter().any(|&x| x > 0.0),
            pv_embodied: ec.pv_co2_kg_per_kwh > 0.0,
            tiers,
            crit_only: tiers && has_grid && p.grid.outage_critical_only,
            deferrable: p.deferrable.on(),
            re_ramp: p.sim.re_ramp_pct_min > 0.0 && k > 1,
        }
    }
}

/// Simulates the project with sizing `s` hour by hour (year 1 repeated when `p.sim.all_years` is false), then the economics.
/// `keep_hourly` keeps the year-1 series and the forecast skill.
pub fn simulate(p: &Project, inp: &SimInput, s: &Sizing, keep_hourly: bool) -> Result<SimResult, Error> {
    let has_grid = p.grid.enabled;
    let mut r = SimResult { size: *s, has_grid, ..Default::default() };
    // the candidate's genset count (optimiser), else the project's fleet; the baseline always runs the project's
    let dgs = s.diesel(&p.dg);
    let (dg, bp, em) = (&*dgs, &p.bess, &p.ems);
    let fuel = FuelTable::new(dg)?;

    let has_bess = s.has_bess();
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
    let x = Extras::of(p, s, dg, &fleet, k);
    r.x = x;
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
    // Random outages of the PV inverter blocks and the battery's PCS units, each only when set: how many there are
    let n_inv = if x.inverter_outages { (s.pv_kwp / p.pv.dc_ac_ratio / p.pv.inverter_unit_kw).ceil().max(1.0) as i32 } else { 0 };
    let n_pcs = if x.pcs_outages { (s.bess_kw / bp.pcs_unit_kw).ceil().max(1.0) as i32 } else { 0 };
    // A ramp limit on PV and wind, in 15 and 30 minute steps only (hourly data in hourly steps hold no ramps to limit): the
    // most their output to the plant may change in one step, from the inverters' AC rating and the turbines' rating. `inj`:
    // that output in the last step, `dis_prev` the battery's discharge then.
    let rr_kw = if x.re_ramp {
        let wind_kw = if has_wind { s.wind_units * p.wind.rated_kw } else { 0.0 };
        p.sim.re_ramp_pct_min / 100.0 * step_min * (s.pv_kwp / p.pv.dc_ac_ratio + wind_kw)
    } else { 0.0 };
    let (mut inj, mut dis_prev): (Option<f64>, f64) = (None, 0.0);
    let ng = fleet.groups.len();
    // Minimum up and down times in steps, each only when set. The units are alike for these: the step each online unit started
    // and each offline unit stopped, oldest first; a stop takes the unit that has run longest, a start the one off longest.
    let (up_steps, down_steps) = ((dg.min_up_h * k as f64).ceil() as i64, (dg.min_down_h * k as f64).ceil() as i64);
    let updown = up_steps > 0 || down_steps > 0;
    let (mut on_since, mut off_since) = (VecDeque::new(), VecDeque::from(vec![i64::MIN / 2; if updown { fleet.units.max(0) as usize } else { 0 }]));
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
    // Grid charging and the frequency reserve (grid.rs): only with a grid connection, the reserve also needs a battery that can
    // hold it. Their figures are written whenever the project sets them.
    let gc = has_grid && has_bess && p.grid.charge_bess;
    let fr_on = has_grid && has_bess && p.grid.reserve_kw > 0.0;
    let (fr_kw, fr_lo, fr_hi) = (pin.fr_kw, pin.fr_lo, pin.fr_hi);
    // A critical share below 1: the non-critical rest of the site load is shed first when supply falls short, and with
    // critical-only supply it is shed whenever the grid is down. Unserved energy is split by tier only then.
    let crit = p.sim.critical_share;
    // A deferrable load: its state runs on across the project years, as its windows do
    let mut flex = x.deferrable.then(|| Flex::new(&p.deferrable, k));
    let tank = x.deferrable && p.deferrable.tank_kwh > 0.0;
    let mut dl_plan = vec![0.0; horizon];   // the predictive plan's deferrable load in each hour of its horizon
    let mut l_raw = vec![0.0; horizon];     // the plan's load forecast of each hour before growth and auxiliaries

    if keep_hourly {
        r.hourly = Some(new_hourly(&x, has_grid, tank, HOURS));
        if k > 1 { r.steps = Some(new_hourly(&x, has_grid, tank, n_steps)); }
        if let Some(fc) = fcp { forecast_stats(p, fc, inp.pv_per_kwp, s.pv_kwp, &mut r); }
    }

    // Battery ageing over a year: calendar fade plus cycle fade. Cycles are counted at the cells (DC) against the cycle life
    // at its rated depth of discharge. Replacement at the threshold (not in the last year).
    let soh_repl = super::replace_soh(bp);
    let age_bess = |y: &mut YearResult, soh: &mut f64| {
        y.soh_loss_cal = bp.calendar_fade;
        y.soh_loss_cyc = if x.cycle_curve { y.bess_damage * (1.0 - bp.eol_soh) } else { y.bess_efc_dc * (1.0 - bp.eol_soh) / mx(1.0, bp.cycle_life * bp.cycle_life_dod) };
        *soh -= y.soh_loss_cal + y.soh_loss_cyc;
        if *soh <= soh_repl && y.year < n_life { y.bess_replaced = true; *soh = 1.0; }
    };

    r.years.reserve(mx(n_life, 1) as usize);
    let mut gy: Option<super::GridYear> = None;   // the grid of the year (its pattern and prices are kept from year 1)
    for yr in 1..=sim_years {
        let mut y = YearResult { year: yr, bess_soh: soh, ..Default::default() };
        if let Some(f) = &flex { y.dl_demand = f.d.kwh_day * (HOURS / 24) as f64; }
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
        // The frequency reserve is held only by a battery with the power and the energy band for it (this year's capacity).
        let fr_year = fr_on && fr_fits(pb, emin, emax, fr_kw, fr_lo, fr_hi);
        pin.fr_kw = if fr_year { fr_kw } else { 0.0 };
        // Rule-based grid charging: the hours to charge from the grid and hold (before a scheduled outage, the time a full charge
        // takes at rated power; arbitrage of a time-of-use tariff against the battery's losses and wear)
        let gc_hours = match &gy {
            Some(g) if gc && !pred => Some(g.charge_hours(bp.rte, pin.cycle_cost, ((emax - emin) / eta / pb).ceil().max(1.0) as usize)),
            _ => None,
        };
        let mut plan_t0 = -1000000i32;   // battery capacity changed: re-plan
        let mut peak_b = 0.0f64;         // highest battery charge or discharge power this year
        let (mut lol_run, mut low_run) = (0i32, 0i32);
        let mut aux_unmet = 0.0;         // auxiliary energy left unserved once the whole site load is unmet
        // Forced outages of the year: the units of each group available in each step, and the fleet they leave
        let outs = x.unit_outages.then(|| fleet.outages(dg.outage_rate, dg.repair_h, dg.outage_seed, yr, k));
        if let Some((_, c, h)) = &outs { y.unit_outages = *c; y.unit_outage_h = *h; }
        // the share of the inverter blocks and of the PCS units in service in each step of the year
        let inv_up = (n_inv > 0).then(|| share_up(n_inv, p.pv.inverter_outage_rate, p.pv.inverter_repair_h, dg.outage_seed, yr, INVERTERS, k));
        if let Some((_, c, h)) = &inv_up { y.inverter_outages = *c; y.inverter_outage_h = *h; }
        let pcs_up = (n_pcs > 0).then(|| share_up(n_pcs, bp.pcs_outage_rate, bp.pcs_repair_h, dg.outage_seed, yr, PCS_UNITS, k));
        if let Some((_, c, h)) = &pcs_up { y.pcs_outages = *c; y.pcs_outage_h = *h; }
        let (mut avail_now, mut fl_now): (Vec<i32>, Option<Fleet>) = (Vec::new(), None);
        // A cycle-life curve: the stored energy of every step, as a share of nameplate, counted by rainflow
        let mut cycles = x.cycle_curve.then(|| CycleCount::new(&bp.cycle_curve));
        if let Some(c) = &mut cycles { c.push(e / s.bess_kwh); }

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
            // an inverter block out takes its share of the PV output with it; a PCS unit out, its share of the battery's power
            let inv_now = inv_up.as_ref().map_or(1.0, |(up, _, _)| f64::from(up[ts]));
            if inv_now < 1.0 { let lost = psol * (1.0 - inv_now); psol -= lost; y.inverter_outage_kwh += lost * dt; }
            let pb = pcs_up.as_ref().map_or(pb, |(up, _, _)| pb * f64::from(up[ts]));
            let pwnd = if has_wind { wind_st[ts] * s.wind_units } else { 0.0 };
            let ppv = psol + pwnd;
            let fpv = if ppv > 0.0 { psol / ppv } else { 1.0 };
            if has_bess && bp.self_discharge > 0.0 { let lo = e * sd; e -= lo; y.self_discharge += lo; }

            let gh = gy.as_ref().map_or(GridHour::default(), |g| g.hour(t, false));
            // the non-critical load; with critical-only supply while the grid is down the plant sees the critical load alone
            // and the rest is shed
            let nc = if x.tiers { (1.0 - crit) * load_st[ts] * load_scale } else { 0.0 };
            let shed = if x.crit_only && !gh.up { nc } else { 0.0 };
            let l = if shed > 0.0 { l - shed } else { l };
            // A frequency reserve, while the grid is up, keeps its power free and the stored energy within its band.
            let fr_now = fr_year && gh.up;
            let (lo_e, hi_e, pbr) = if fr_now { (emin + fr_lo, emax - fr_hi, fr_headroom(pb, fr_kw)) } else { (emin, emax, pb) };
            let esp = if fr_now { mn(esp, hi_e) } else { esp };   // cycle charging stops at the band's top
            // battery power limits of the step: rated power, and the energy above the minimum (below the maximum) over the step
            let dis_cap = mn(pbr, mx(0.0, e - lo_e) * eta / dt);
            let ch_cap = mn(pbr, mx(0.0, hi_e - e) / eta / dt);
            // Battery power that counts as spinning reserve: what it can sustain for reserve_duration_h from the stored energy.
            let res_cap = mn(pbr, mx(0.0, e - lo_e) * eta / bp.reserve_duration_h);
            // The ramp limit, first on a rise: PV and wind above the last step's output plus the limit charge the battery, and
            // what it cannot take is curtailed. The rest of the dispatch sees the limited output. A fall is met after the allocation.
            let (ppv_in, mut rr_ch, mut rr_cut) = (ppv, 0.0, 0.0);
            let rr_p0 = inj.unwrap_or(ppv);
            let (ppv, ch_cap) = if x.re_ramp && ppv > rr_p0 + rr_kw {
                let over = ppv - (rr_p0 + rr_kw);
                rr_ch = mn(over, ch_cap);
                rr_cut = over - rr_ch;
                (rr_p0 + rr_kw, ch_cap - rr_ch)
            } else { (ppv, ch_cap) };

            // The deferrable load: a window that ends now closes; in its window the load can take up to d_cap and must draw
            // at least what lets it finish at full power (the predictive plan may ask more below).
            let (mut l, mut d_f, mut d_cap) = (l, 0.0, 0.0);
            if let Some(f) = flex.as_mut() {
                y.dl_unmet += f.close_at(t % 24, sub, yr == 1 && ts == 0);
                if f.in_win(t % 24) {
                    d_cap = mn(f.d.kw, f.room() / dt);
                    // with critical-only supply during a grid outage it runs only on surplus
                    if shed <= 0.0 { d_f = mn(d_cap, f.least(t % 24, sub, dt)); l += d_f; }
                }
            }
            let (mut dis_limit, mut want_gch, mut soc_tgt, mut b_plan) = (dis_cap, 0.0, 0.0, 0.0);
            let (mut u_floor, mut u_tgt) = (0i32, 0i32);
            if pred {
                let fc = fcp.expect("forecaster");
                if sub == 0 && ti - plan_t0 >= replan {   // plans are hourly, made at the start of an hour
                    for j in 0..horizon {
                        let tj = ti + j as i32;
                        l_raw[j] = fc.load(ti, tj);
                        lfc[j] = l_raw[j] * load_scale + aux[(t + j) % HOURS];   // auxiliary load taken as known
                        pfc[j] = fc.pv(ti, tj) * pv_scale * inv_now + if has_wind { fc.wind(ti, tj) * s.wind_units } else { 0.0 };
                    }
                    if let Some(g) = &gy {
                        pin.grid.clear();
                        pin.grid.extend((0..horizon).map(|j| g.hour_at(t + j, j > 0, fl.loading(lfc[j] - pfc[j]))));
                    }
                    if x.tiers {
                        // the non-critical load of each hour, shed in the hours the plan knows the grid is down (critical only)
                        pin.nc_kw.clear();
                        for j in 0..horizon {
                            let nc = (1.0 - crit) * l_raw[j] * load_scale;
                            let down = x.crit_only && pin.grid.get(j).is_some_and(|g| !g.up);
                            if down { lfc[j] -= nc; }
                            pin.nc_kw.push(if down { 0.0 } else { nc });
                        }
                    }
                    if let Some(f) = &flex {
                        // the deferrable load goes into the hours of its windows where it costs least, then counts as load
                        planner.schedule_deferrable(&pin, &lfc, &pfc, &f.windows(t, horizon), f.d.kw, &mut dl_plan);
                        for j in 0..horizon { lfc[j] += dl_plan[j]; }
                        if let Some(g) = &gy { for j in 0..horizon { pin.grid[j] = g.hour_at(t + j, j > 0, fl.loading(lfc[j] - pfc[j])); } }
                    }
                    pin.pb = pb;   // the battery's power with the PCS units now in service; the EMS knows what is down when it plans
                    pin.u0 = prev_units;
                    planner.plan(&pin, e, &lfc, &pfc, &mut e_traj, &mut u_plan);
                    plan_t0 = ti;
                    if yr == 1 { r.fc.plans += 1; }
                }
                let j = (ti - plan_t0) as usize;
                if shed <= 0.0 && mn(dl_plan[j], d_cap) > d_f { l += mn(dl_plan[j], d_cap) - d_f; d_f = mn(dl_plan[j], d_cap); }
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
                if cc_hold || e - lo_e <= 1e-6 * enom { dis_limit = 0.0; }
            }

            let pv_load0 = mn(ppv, l);
            let r0 = l - pv_load0;
            let reserve = dg.reserve_load * l + dg.reserve_pv * pv_load0;
            // Merit order of the hour: grid price against genset energy at the loading the residual would give the units.
            let gh = match &gy { Some(g) if gh.up => g.hour_at(t, false, fl.loading(r0 - mn(r0, dis_limit))), _ => gh };
            // While the grid is up no unit has to stay online, its spare import counts as reserve, and when it is cheaper it
            // serves the load before the gensets.
            let min_on_t = if gh.up { 0 } else if x.unit_outages { fl.min_on } else { min_on };
            // Grid charging: the EMS plan's charging comes from the grid when it is cheaper than the gensets; the rules charge in
            // the hours picked for the year and keep the battery from discharging there. A frequency reserve below its band is
            // refilled from the grid. grid_want: the charging asked from all sources.
            let mut grid_want = 0.0;
            let mut hold = false;
            if gc && gh.up {
                if pred { if gh.cheap && want_gch > 0.0 { grid_want = mn(ch_cap, -b_plan); want_gch = 0.0; } }
                else if gc_hours.as_ref().is_some_and(|c| c[t]) { grid_want = ch_cap; hold = true; dis_limit = 0.0; }
            }
            if fr_now && e < lo_e { grid_want = mx(grid_want, mn(ch_cap, (lo_e - e) / eta / dt)); }
            // a ramp limit also keeps units online: the fleet cannot drop below the last output less one step's ramp
            if x.ramps && dg.ramp_pct_min > 0.0 {
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
            if updown {
                // A unit within its minimum up time stays online (a forced outage still takes it). A unit within its minimum
                // down time stays off unless the load would go unserved with the battery at its full discharge and the grid
                // at its import limit: then just the units the load needs start.
                let gs = i64::from(yr - 1) * n_steps as i64 + ts as i64;
                let locked_on = on_since.iter().filter(|&&s0| gs - s0 < up_steps).count() as i32;
                u = mx(u, mn(locked_on, fl.units));
                let free = on_since.len() as i32 + off_since.iter().filter(|&&s0| gs - s0 >= down_steps).count() as i32;
                if u > free {
                    let grid_kw = if gh.up { gh.imp } else { 0.0 };
                    let u_load = mn(fl.units_for(r0 - dis_cap - grid_kw), u);
                    if u_load > free { y.min_down_override += f64::from(u_load - free); }
                    u = mx(free, u_load);
                }
                while (on_since.len() as i32) < u { off_since.pop_front(); on_since.push_back(gs); }
                while (on_since.len() as i32) > u { on_since.pop_front(); off_since.push_back(gs); }
            }
            let uf = f64::from(u);
            let (gmin, gmax) = (fl.gmin(u), fl.cap(u));
            // Ramps and start time: units started in the step deliver only after the start time, and the fleet output moves by at
            // most the ramp rate times the online rating per minute (both from the previous step's output).
            let (mut glo, mut ghi) = (gmin, gmax);
            if x.ramps {
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
            let c_idle = if cc { mn(pbr, mx(0.0, ppv + ghi - l)) } else { 0.0 };
            let mut dis_frac = 1.0;
            if cc && cc_hold && c_idle > want_gch {
                dis_frac = 1.0 - want_gch / c_idle;
                dis_limit = mn(dis_frac * pbr, mx(0.0, esp - lo_e) * eta / dt);
            }
            if hold { dis_limit = 0.0; }

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
            let ramp_hit = x.ramps && ghi < gmax - 1e-9 && rem > ghi - glo + 1e-9;   // asked for more than the ramp or start allows
            let gx = mn(rem, ghi - glo);
            g_load += gx;
            rem -= gx;
            if gh.up && !gh.cheap { gi = mn(rem, gh.imp); rem -= gi; }
            if rem > 0.0 { let extra = mn(rem, mx(0.0, dis_cap - dis)); dis += extra; rem -= extra; }
            let unmet = mx(0.0, rem);

            // Charging: PV surplus first, then unavoidable genset excess, then deliberate genset charging. The deferrable load
            // takes surplus up to its room before the battery or after it, and before any export.
            let mut d_s = 0.0;
            if d_cap > d_f && !p.deferrable.battery_first { d_s = mn(surplus, d_cap - d_f); surplus -= d_s; }
            let pv_ch = mn(surplus, ch_cap);
            surplus -= pv_ch;
            if d_cap > d_f && p.deferrable.battery_first { d_s = mn(surplus, d_cap - d_f); surplus -= d_s; }
            let gx_out = if gh.up { mn(surplus, gh.exp) } else { 0.0 };   // export of what the battery cannot take
            if gh.up { surplus -= gx_out; }
            let mut g_ch = mn(g_excess, ch_cap - pv_ch);
            let dump = g_excess - g_ch;
            let mut g_delib = 0.0;   // deliberate genset charging from the headroom of the online units
            // Cycle charging: share of the hour the battery spent discharging when it ran empty within it (1 otherwise).
            let t_dis = if cc && !cc_hold && dis > 0.0 && e - dis * dt / eta <= lo_e + 1e-6 * enom { dis / mn(pbr, deficit) } else { 1.0 };
            if u > 0 && ((want_gch > 0.0 && (dis <= 0.0 || (cc && cc_hold))) || t_dis < 1.0) {
                let room = if t_dis < 1.0 { mn((1.0 - t_dis) * c_idle, (esp - (e - dis * dt / eta)) / eta / dt) - pv_ch - g_ch }
                           else { mn(ch_cap - pv_ch - g_ch, want_gch - (if cc { pv_ch } else { 0.0 }) - g_ch) };
                let head = ghi - (g_load + g_excess);
                g_delib = mx(0.0, mn(room, head));
                g_ch += g_delib;
            }
            // grid charging, from the import left after the load
            let g2b = if grid_want > 0.0 { mx(0.0, mn(grid_want - pv_ch - g_ch, gh.imp - gi)) } else { 0.0 };
            if fr_now {
                // what the reserve cost: surplus the battery could not take, and load it could not serve, because of the band
                let (dis_full, ch_full) = (mn(pb, mx(0.0, e - emin) * eta / dt), mn(pb, mx(0.0, emax - e) / eta / dt));
                y.fr_spill += mn(mx(0.0, ch_full - ch_cap), surplus + gx_out) * dt;
                if dis >= dis_cap - 1e-9 { y.fr_shift += mn(mx(0.0, dis_full - dis_cap), mx(0.0, deficit - dis)) * dt; }
                if pb >= fr_kw && e >= lo_e - 1e-6 * enom && e <= hi_e + 1e-6 * enom { y.fr_held_h += dt; }
            }
            // The ramp limit after the allocation. A rise the battery took while it also served the load goes to the load through
            // it (only the difference flows). A fall beyond the limit counts what the battery gives more than in the last step;
            // the rest it makes up in place of unserved load, genset output above minimum and grid import (the part of the fall
            // the bus took from them), and what it cannot is a violation. The battery's power and stored-energy limits (and a
            // frequency reserve's band) hold throughout.
            let (mut unmet, mut pv_load, mut pv_ch) = (unmet, pv_load, pv_ch);
            if x.re_ramp {
                if rr_ch > 0.0 && dis > 0.0 { let m = mn(rr_ch, dis); rr_ch -= m; dis -= m; pv_load += m; }
                let need = rr_p0 - rr_kw - ppv;
                let mut viol = 0.0;
                if need > 0.0 {
                    let want = mx(0.0, mn(need - mx(0.0, dis - dis_prev), unmet + gi + gx));
                    let d = mn(want, mx(0.0, dis_cap - dis));
                    let a = mn(d, unmet);
                    let b = mn(d - a, gx);
                    unmet -= a;
                    g_load -= b;
                    gi -= d - a - b;
                    dis += d;
                    y.re_ramp_bess_dis += d * dt;
                    viol = want - d;
                    if viol > 1e-3 * rr_kw { y.re_ramp_viol += 1.0; y.re_ramp_viol_kwh += viol * dt; }
                }
                y.re_ramp_bess_ch += rr_ch * dt;
                y.re_ramp_curtailed += rr_cut * dt;
                pv_ch += rr_ch;
                surplus += rr_cut;
                inj = Some(if ppv_in > rr_p0 + rr_kw { rr_p0 + rr_kw } else if need > 0.0 { rr_p0 - rr_kw - viol } else { ppv_in });
                dis_prev = dis;
            }
            let e_top = e + (pv_ch + g_ch + g2b) * eta * dt;   // after charging, before any discharge in the same step
            e += ((pv_ch + g_ch + g2b) * eta - dis / eta) * dt;
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
            if x.n1 && u > 0 {
                let (big, lf) = (fl.largest(u), gen / gmax);
                let cover = (head_g - big * (1.0 - lf)) + head_b + if gh.up { gh.imp - gi } else { 0.0 };
                let gap = mx(0.0, big * lf - cover);
                if gap > 1e-3 * l { y.n1_short_h += dt; y.n1_short_max_kw = mx(y.n1_short_max_kw, gap); }
            }
            if ramp_hit { y.ramp_limited_h += dt; }
            // The deferrable load is shed first (it draws the energy later in its window or counts it short when the window
            // closes); what it drew from surplus or otherwise counts as load, PV and wind from surplus as PV and wind to the load.
            let (mut d_drawn, mut dl_lv) = (0.0, 0.0);
            let (l, unmet, pv_load) = if let Some(f) = flex.as_mut() {
                let u_dl = mn(unmet, d_f);
                d_drawn = d_f - u_dl + d_s;
                f.done += d_drawn * dt;
                dl_lv = f.level();
                y.dl_kwh += d_drawn * dt;
                // PV and wind: its surplus draw, and of the rest the share they had in the hour's served load
                let served = l - unmet;
                y.dl_re += (d_s + if served > 0.0 { (d_f - u_dl) * pv_load / served } else { 0.0 }) * dt;
                (l - u_dl + d_s, unmet - u_dl, pv_load + d_s)
            } else { (l, unmet, pv_load) };
            // the load shed by critical-only supply counts as load and as unserved
            let (l, unmet) = if shed > 0.0 { (l + shed, unmet + shed) } else { (l, unmet) };
            if x.tiers {
                // unserved energy goes to the non-critical load first
                let (u_nc, lc) = (mn(unmet, nc), l - nc - d_drawn);
                let u_c = unmet - u_nc;
                y.load_crit += lc * dt;
                y.unmet_nc += u_nc * dt;
                y.unmet_crit += u_c * dt;
                y.nc_shed += shed * dt;
                if u_c > 1e-3 * lc { y.lol_crit_h += dt; }
                if u_nc > 1e-3 * nc { y.lol_nc_h += dt; }
            }
            let site = l - d_drawn;   // the site load, without the deferrable load
            let lol = unmet > 1e-3 * site;
            let low = u > 0 && gen <= gmin + 1e-6;
            lol_run = if lol { lol_run + 1 } else { 0 };
            low_run = if low { low_run + 1 } else { 0 };
            if lol { y.lol_h += dt; if lol_run == 1 { y.lol_events += 1.0; } y.lol_max_h = mx(y.lol_max_h, f64::from(lol_run) * dt); }
            if low { y.minload_h += dt; y.minload_run_max_h = mx(y.minload_run_max_h, f64::from(low_run) * dt); }
            y.max_units = mx(y.max_units, uf);
            if u > 0 && u == fleet.units { y.fleet_full_h += dt; }
            if let Some(g) = &gy {
                let gi_all = if g2b > 0.0 { gi + g2b } else { gi };   // import to the load and to the battery
                y.grid_import += gi * dt;
                y.grid_to_bess += g2b * dt;
                y.grid_import_val += gi_all * dt * g.price0[t];
                y.grid_export += gx_out * dt;
                y.pv_to_grid += gx_out * fpv * dt;
                y.wind_to_grid += gx_out * (1.0 - fpv) * dt;
                y.grid_peak_kw = mx(y.grid_peak_kw, gi_all);
                let m = crate::model::month_of_day((t / 24) as i32) as usize;
                y.grid_month_peak[m] = mx(y.grid_month_peak[m], gi_all);
            }
            // units started in the hour (the change over its steps), not counting the initial start
            if sub == 0 { units_hour0 = prev_units; }
            if sub == k - 1 && (yr > 1 || t > 0) { y.max_starts_h = mx(y.max_starts_h, f64::from(u - units_hour0)); }

            // energies: power x dt (exact for hourly steps)
            y.load += l * dt;
            y.aux += aux_t * dt;
            y.unmet += unmet * dt;
            aux_unmet += mx(0.0, unmet - (site - aux_t)) * dt;
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
            y.re_avail += ppv_in * dt;
            y.re_direct += (pv_load0 + d_s) * dt;
            y.bess_dis += dis * dt;
            y.bess_ch += (pv_ch + g_ch + g2b) * dt;
            peak_b = mx(peak_b, mx(dis, pv_ch + g_ch + g2b));
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
            if let Some(c) = &mut cycles { c.push(e / s.bess_kwh); }

            if rec {
                let v = StepVals {
                    load: l, aux: aux_t, pv_avail: psol, pv_to_load: pv_load * fpv, pv_to_bess: pv_ch * fpv, pv_curtailed: surplus * fpv,
                    wind_avail: pwnd, wind_to_load: pv_load * (1.0 - fpv), wind_to_bess: pv_ch * (1.0 - fpv), wind_curtailed: surplus * (1.0 - fpv),
                    bess_dis: dis, gen_to_bess: g_ch, gen_to_load: g_load, gen_dump: dump, gen_units: uf, fuel_l, unmet,
                    soc: if enom > 0.0 { e / enom } else { 0.0 }, soc_target: soc_tgt,
                    grid_import: gi, grid_export: gx_out, grid_up: if gh.up { 1.0 } else { 0.0 }, grid_to_bess: g2b, dl: d_drawn, dl_tank: dl_lv,
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
        if let Some(c) = cycles { (y.bess_damage, y.rf_cycles, y.rf_dod) = c.finish(); }
        y.served = y.load - y.unmet;
        y.served_site = y.served - (y.aux - aux_unmet);   // unmet energy is attributed to the site load first
        // Grid imports are not renewable; exports are not part of the served load.
        let non_re = if has_grid { y.gen_kwh - y.gen_dump + y.grid_import + y.grid_to_bess } else { y.gen_kwh - y.gen_dump };
        y.re_fraction = if y.served > 0.0 { clamp(1.0 - non_re / y.served, 0.0, 1.0) } else { 0.0 };
        y.co2_t = y.fuel_l * p.econ.co2_kg_per_l / 1000.0;
        if has_grid { y.co2_t += (y.grid_import + y.grid_to_bess) * p.grid.co2_kg_per_kwh / 1000.0; }
        y.nox_t = y.fuel_l * p.econ.nox_g_per_l / 1e6;
        y.sox_t = y.fuel_l * p.econ.sox_g_per_l / 1e6;
        y.pm25_t = y.fuel_l * p.econ.pm25_g_per_l / 1e6;
        y.co_t = y.fuel_l * p.econ.co_g_per_l / 1e6;
        if x.pv_embodied {
            y.co2_pv_t = y.pv_avail * p.econ.pv_co2_kg_per_kwh / 1000.0;
            y.co2_t += y.co2_pv_t;
        }
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

    econ::economics(p, dg, s, soh, &mut r);
    Ok(r)
}
