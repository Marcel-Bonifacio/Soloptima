//! Rolling-horizon dynamic programme over the battery's stored energy for the predictive EMS (Planner in src/ems.cpp). It
//! minimises fuel, genset run-hours, battery wear and unserved energy across the forecast horizon. The real-time layer that
//! follows the plan and compensates forecast errors is in dispatch.rs.
use super::{clamp, mn, mx, Fleet, FuelTable, GridHour};
use crate::{DieselParams, EconParams, Project};

/// Cost weights and battery limits of a plan
#[derive(Debug, Clone)]
pub struct PlanInput {
    pub e_min: f64,
    pub e_max: f64,
    pub pb: f64,
    /// one-way battery efficiency
    pub eta: f64,
    pub fuel_price: f64,
    pub om_unit_hour: f64,
    pub om_kwh: f64,
    pub cycle_cost: f64,
    pub voll: f64,
    /// value of lost non-critical load, and the non-critical load of each hour of the horizon (empty: all load is critical),
    /// as dispatch.rs sets it before each plan; unserved energy up to that load costs voll_nc, the rest voll
    pub voll_nc: f64,
    pub nc_kw: Vec<f64>,
    pub terminal_per_kwh: f64,
    pub provides_reserve: bool,
    /// hours the battery must sustain its reserve power
    pub reserve_h: f64,
    pub levels: i32,
    /// the grid in each hour of the horizon (empty without a grid connection), as dispatch.rs sets it before each plan
    pub grid: Vec<GridHour>,
    /// hour costs depend on the stored energy: battery reserve counts only as far as the energy above the minimum sustains it
    /// for `reserve_h`, so the plan can hold energy back as reserve rather than start a genset for it (`ems.reserve_energy`)
    pub reserve_energy: bool,
    /// the battery may charge from the grid: in hours the grid is cheaper than the gensets it covers the charging too
    pub grid_charge: bool,
    /// frequency reserve held while the grid is up (fr_kw = 0: none): battery power kept free in both directions, and the
    /// stored energy kept above e_min + fr_lo and below e_max - fr_hi
    pub fr_kw: f64,
    pub fr_lo: f64,
    pub fr_hi: f64,
    /// terminal value x one-way efficiency: with grid charging, stored energy at the end of the horizon is valued at no more
    /// than the cheapest import of the horizon times this, so the plan does not buy energy only to hold it
    pub terminal_factor: f64,
    /// cost of each genset start (0: starts are not costed) and the units online before the first hour of the plan
    pub start_cost: f64,
    pub u0: i32,
}

/// Cost weights and battery efficiency from the project; the caller sets e_min, e_max and pb.
pub fn plan_input(p: &Project, fuel: &FuelTable) -> PlanInput {
    let eta = p.bess.rte.sqrt();   // one-way efficiency (charge = discharge)
    PlanInput {
        e_min: 0.0,
        e_max: 0.0,
        pb: 0.0,
        eta,
        fuel_price: p.econ.fuel_price,
        om_unit_hour: p.econ.diesel_om_unit_hour,
        om_kwh: p.econ.diesel_om_kwh,
        // Wear cost per kWh discharged: replacement cost spread over the cycle life at its rated depth of discharge, or with a
        // cycle-life curve over the energy to end of life of cycles across the SOC window.
        cycle_cost: if p.bess.cycle_curve.is_empty() { p.econ.bess_replace_kwh / mx(1.0, p.bess.cycle_life * p.bess.cycle_life_dod) }
                    else { super::ageing::wear_cost(&p.bess.cycle_curve, p.econ.bess_replace_kwh, p.bess.soc_max - p.bess.soc_min) },
        voll: p.ems.voll,
        voll_nc: p.ems.voll_nc.unwrap_or(p.ems.voll),
        nc_kw: Vec::new(),
        // Stored energy is worth the fuel it displaces at a typical (75 %) genset loading.
        terminal_per_kwh: p.ems.terminal_value * eta * (fuel.at(0.75) / 0.75 * p.econ.fuel_price + p.econ.diesel_om_kwh),
        provides_reserve: p.bess.provides_reserve,
        reserve_h: p.bess.reserve_duration_h,
        levels: p.ems.soc_levels,
        grid: Vec::new(),
        reserve_energy: p.ems.reserve_energy,
        grid_charge: p.grid.enabled && p.grid.charge_bess,
        fr_kw: if p.grid.enabled { p.grid.reserve_kw } else { 0.0 },
        fr_lo: p.grid.reserve_kw * p.grid.reserve_min / 60.0 / eta,
        fr_hi: p.grid.reserve_kw * p.grid.reserve_min / 60.0 * eta,
        terminal_factor: p.ems.terminal_value * eta,
        start_cost: if p.ems.plan_starts { p.econ.diesel_start_cost } else { 0.0 },
        u0: 0,
    }
}

impl PlanInput {
    /// Whether the frequency reserve is held in hour j of the horizon (while the grid is up)
    fn fr_up(&self, j: usize) -> bool { self.fr_kw > 0.0 && self.grid.get(j).is_some_and(|g| g.up) }
    /// The cost of ending an hour at stored energy e outside the frequency reserve's band: per kWh outside it, a soft limit so a
    /// battery below the band after an outage can still be planned back into it
    fn band_cost(&self, e: f64) -> f64 {
        (mx(0.0, self.e_min + self.fr_lo - e) + mx(0.0, e - (self.e_max - self.fr_hi))) * (10.0 * mx(self.voll, 1.0))
    }
    /// Whether the plan costs the battery's reserve by the energy that sustains it
    fn by_energy(&self) -> bool { self.reserve_energy && self.provides_reserve }
}

/// Whether a battery of power pb and stored-energy limits e_min..e_max can hold a frequency reserve of fr_kw with its energy
/// margins fr_lo above the minimum and fr_hi below the maximum
pub(crate) fn fr_fits(pb: f64, e_min: f64, e_max: f64, fr_kw: f64, fr_lo: f64, fr_hi: f64) -> bool { pb >= fr_kw && e_max - e_min >= fr_lo + fr_hi }
/// The battery power a frequency reserve of fr_kw leaves free
pub(crate) fn fr_headroom(pb: f64, fr_kw: f64) -> f64 { mx(0.0, pb - fr_kw) }

/// Battery reserve power the stored energy `e` sustains for `reserve_h` hours
pub fn reserve_cap(i: &PlanInput, e: f64) -> f64 { mx(0.0, e - i.e_min) * i.eta / i.reserve_h }

/// Reserve credit over an hour that goes from e0 to e1, for `hour_cost`'s bres_cap: when discharging b it is
/// (e0 - e_min) * eta / reserve_h - b, so hour_cost credits min(pb, energy limit) - b, the real-time rule.
pub fn reserve_cap_step(i: &PlanInput, e0: f64, e1: f64) -> f64 {
    let lo = mn(e0, e1);
    reserve_cap(i, lo) + (e0 - lo) * i.eta * (1.0 / i.reserve_h - 1.0)
}

pub struct Planner<'a> {
    dg: &'a DieselParams,
    fleet: Fleet,
    v: Vec<f64>,
    cost: Vec<f64>,
    pol: Vec<usize>,
    /// with a start cost: units of each tabulated hour cost, and the costs, units, values and choices of the DP over (level,
    /// units before the hour)
    units: Vec<i32>,
    tc: Vec<f64>,
    tu: Vec<i32>,
    sv: Vec<f64>,
    sp: Vec<u32>,
    /// `plan_starts`'s units range and value offset of each hour, `schedule_deferrable`'s hours in order of cost
    range: Vec<(i32, i32)>,
    off: Vec<usize>,
    order: Vec<(f64, f64, usize)>,
}

impl<'a> Planner<'a> {
    /// A fleet of identical units (`dg`'s main group with `fuel`)
    pub fn new(dg: &'a DieselParams, fuel: &FuelTable) -> Planner<'a> { Planner::with_fleet(dg, Fleet::single(dg, fuel, &EconParams::default())) }

    /// Any fleet (`Fleet::new`); `dg` gives the reserve rules
    pub fn with_fleet(dg: &'a DieselParams, fleet: Fleet) -> Planner<'a> {
        Planner { dg, fleet, v: vec![], cost: vec![], pol: vec![], units: vec![], tc: vec![], tu: vec![], sv: vec![], sp: vec![], range: vec![], off: vec![], order: vec![] }
    }

    /// Cost of one hour for battery AC power b (+ discharge / - charge) and the units online. bres_cap: most battery power
    /// that counts as spinning reserve (energy limit; infinite for none).
    pub fn hour_cost(&self, i: &PlanInput, l: f64, p: f64, b: f64, bres_cap: f64) -> (f64, i32) { self.hour_cost_grid(i, None, l, p, b, bres_cap) }

    /// `hour_cost` with the grid of the hour, as the dispatch uses it: while the grid is up it imports for the load before the
    /// gensets when cheaper (after them otherwise, for what they cannot cover), its spare import counts as reserve, no unit has
    /// to stay online, and PV and wind surplus is exported. The battery charges from the grid only with `grid_charge`.
    pub fn hour_cost_grid(&self, i: &PlanInput, gh: Option<&GridHour>, l: f64, p: f64, b: f64, bres_cap: f64) -> (f64, i32) {
        self.hour_cost_nc(i, gh, l, p, b, bres_cap, 0.0)
    }

    /// `hour_cost_grid` of hour j of the horizon: its grid and its non-critical load
    fn hour_cost_at(&self, i: &PlanInput, j: usize, l: f64, p: f64, b: f64, bres_cap: f64) -> (f64, i32) {
        self.hour_cost_nc(i, i.grid.get(j), l, p, b, bres_cap, i.nc_kw.get(j).copied().unwrap_or(0.0))
    }

    /// `hour_cost_grid` with `nc` kW of the load non-critical: unserved energy up to it costs voll_nc, the rest voll
    #[allow(clippy::too_many_arguments)]
    fn hour_cost_nc(&self, i: &PlanInput, gh: Option<&GridHour>, l: f64, p: f64, b: f64, bres_cap: f64, nc: f64) -> (f64, i32) {
        let dg = self.dg;
        let net = l - p;
        let mut g = mx(0.0, net - b);   // genset energy needed
        let reserve = dg.reserve_load * l + dg.reserve_pv * mn(p, l);
        let bres = if i.provides_reserve { mx(0.0, mn(i.pb - mx(b, 0.0), bres_cap)) } else { 0.0 };
        let gh = gh.filter(|x| x.up);
        let (mut gi, mut head, mut grid_cost) = (0.0, 0.0, 0.0);
        if let Some(x) = gh {
            // the load, and battery charging only with grid_charge
            if x.cheap { gi = mn(x.imp, mx(0.0, net - if i.grid_charge { b } else { mx(b, 0.0) })); g -= gi; }
            head = x.imp - gi;
            grid_cost -= mn(mx(0.0, -net - mx(0.0, -b)), x.exp) * x.exp_price;   // PV and wind surplus left after charging
        }
        let need = g + mx(0.0, reserve - bres - head);
        let fl = &self.fleet;
        let mut u = fl.units_for(need);
        let min_on = if gh.is_none() { fl.min_on } else { 0 };
        u = mn(mx(u, min_on), fl.units);
        let cap = fl.cap(u);
        let mut unmet = mx(0.0, g - cap);
        if let Some(x) = gh {
            if !x.cheap { let more = mn(unmet, x.imp); gi += more; unmet -= more; }
            grid_cost += gi * x.price;
        }
        let (mut fuel, mut geff) = (0.0, 0.0);
        if u > 0 {
            geff = mx(mn(g, cap), fl.gmin(u));
            fuel = fl.fuel_lh(u, geff);
        }
        // lost load: the non-critical part is shed first, at its own value
        let lost = if nc > 0.0 { let a = mn(unmet, nc); a * i.voll_nc + (unmet - a) * i.voll } else { unmet * i.voll };
        // O&M per run-hour and per kWh: one rate, or in a mixed fleet each group's rate for its units and its share of the output
        let cost = if fl.is_mixed() && u > 0 {
            let om: f64 = fl.online(u).iter().zip(&fl.groups).map(|(&n, g)| f64::from(n) * (g.om_unit_hour + g.unit_kw * geff / cap * g.om_kwh)).sum();
            fuel * i.fuel_price + om + lost + mx(b, 0.0) * i.cycle_cost
        } else { fuel * i.fuel_price + f64::from(u) * i.om_unit_hour + geff * i.om_kwh + lost + mx(b, 0.0) * i.cycle_cost };
        (if gh.is_some() { cost + grid_cost } else { cost }, u)
    }

    /// Schedules a deferrable load (kW in each hour of the horizon, into `out`): the energy each window needs (`wins`: first
    /// hour, end hour, kWh) goes to the hours of that window where `kw` more load costs least in this plan's hour cost with
    /// the battery idle, so hours of PV and wind surplus come first, then cheap import and genset hours. A heuristic: the
    /// dynamic programme then plans the battery around it, but does not trade the two off.
    pub fn schedule_deferrable(&mut self, i: &PlanInput, load_fc: &[f64], pv_fc: &[f64], wins: &[(usize, usize, f64)], kw: f64, out: &mut [f64]) {
        out.fill(0.0);
        let mut order = std::mem::take(&mut self.order);
        for &(j0, j1, need) in wins {
            if need <= 0.0 { continue; }
            let x = mn(kw, need);
            order.clear();
            order.extend((j0..j1).map(|j| {
                let c0 = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], 0.0, f64::INFINITY).0;
                let c1 = self.hour_cost_at(i, j, load_fc[j] + x, pv_fc[j], 0.0, f64::INFINITY).0;
                (c1 - c0, load_fc[j] - pv_fc[j], j)
            }));
            // cheapest first, and of equal cost the hour with the most surplus
            order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
            let mut left = need;
            for &(_, _, j) in &order {
                if left <= 0.0 { break; }
                out[j] = mn(kw, left);
                left -= out[j];
            }
        }
        self.order = order;
    }

    /// Fills e_traj (H+1 stored-energy targets, e_traj[0] = start) and u_plan (H planned units online). The units are
    /// committed with battery reserve limited as in real time (energy at the start of the hour, less the hour's discharge);
    /// the SOC path takes that limit into account only with `reserve_energy`.
    pub fn plan(&mut self, i: &PlanInput, e0: f64, load_fc: &[f64], pv_fc: &[f64], e_traj: &mut Vec<f64>, u_plan: &mut Vec<i32>) {
        let h = load_fc.len();
        e_traj.clear();
        e_traj.resize(h + 1, e0);
        u_plan.clear();
        u_plan.resize(h, 0);
        let span = i.e_max - i.e_min;
        if span <= 1e-9 || i.pb <= 1e-9 {
            for j in 0..h { u_plan[j] = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], 0.0, reserve_cap(i, e0)).1; }
            return;
        }
        // Resolution: at least `levels`, and fine enough that one level step needs at most half the rated power.
        let n = mn(mx(i.levels, (span / (0.5 * i.pb * i.eta)).ceil() as i32 + 1), 101);
        let de = span / f64::from(n - 1);
        let nd = (2 * n - 1) as usize;   // distinct level changes d = m - k in [-(n-1), n-1]
        let nu = n as usize;
        let inf = f64::INFINITY;
        self.v.clear();
        self.v.resize((h + 1) * nu, 0.0);
        self.pol.clear();
        self.pol.resize(h * nu, 0);
        self.cost.clear();
        self.cost.resize(h * nd, inf);
        let starts = i.start_cost > 0.0;
        if starts { self.units.clear(); self.units.resize(h * nd, 0); }

        // Hour cost depends only on the level change d = m - k, so tabulate it once per hour for the changes the battery
        // power allows, d in [dlo, dhi].
        let b_of = |d: i32| { let den = f64::from(d) * de; if den < 0.0 { -den * i.eta } else { -den / i.eta } };
        let (mut dlo, mut dhi) = (0i32, 0i32);
        while dlo > 1 - n && b_of(dlo - 1).abs() <= i.pb * (1.0 + 1e-9) { dlo -= 1; }
        while dhi < n - 1 && b_of(dhi + 1).abs() <= i.pb * (1.0 + 1e-9) { dhi += 1; }
        // frequency reserve: in hours the grid is up the battery keeps fr_kw free (a hard limit: those changes stay out of the
        // table) and its stored energy within the band (a soft one, below)
        for j in 0..h {
            for d in dlo..=dhi {
                let b = b_of(d);
                if i.fr_up(j) && b.abs() > fr_headroom(i.pb, i.fr_kw) * (1.0 + 1e-9) { continue; }
                let (c, u) = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], b, inf);
                self.cost[j * nd + (d + n - 1) as usize] = c;
                if starts { self.units[j * nd + (d + n - 1) as usize] = u; }
            }
        }
        let mut term = i.terminal_per_kwh;
        if i.grid_charge {
            let cheapest = i.grid.iter().filter(|g| g.up).map(|g| g.price).fold(f64::INFINITY, f64::min);
            if cheapest.is_finite() { term = mn(term, i.terminal_factor * mx(cheapest, 0.0)); }
        }
        for k in 0..nu { self.v[h * nu + k] = -term * (i.e_min + k as f64 * de); }

        let by_energy = i.by_energy();
        if starts {
            self.plan_starts(i, e0, load_fc, pv_fc, e_traj, u_plan, (n, de, dlo, dhi, by_energy), b_of);
            return;
        }
        for j in (0..h).rev() {
            if i.fr_up(j) {
                // levels outside the reserve's band at the end of the hour cost extra (added to the next hour's values, which
                // only this hour reads); power changes it does not leave are not in the table and stay infinite
                for m in 0..nu {
                    let em = i.e_min + m as f64 * de;
                    self.v[(j + 1) * nu + m] += i.band_cost(em);
                }
            }
            for k in 0..n {
                let mut best = inf;
                let mut arg = k;
                for m in mx(0, k + dlo)..=mn(n - 1, k + dhi) {
                    let mut c = self.cost[j * nd + (m - k + n - 1) as usize];
                    if by_energy {
                        // The table above credits the battery's spare power as reserve whatever it holds. Where the energy at the
                        // start and end of the hour sustains less than that for reserve_h, cost the hour with that limit.
                        let b = b_of(m - k);
                        let (ek, em) = (i.e_min + f64::from(k) * de, i.e_min + f64::from(m) * de);
                        let cap = reserve_cap_step(i, ek, em);
                        if cap < mx(0.0, i.pb - mx(b, 0.0)) && c < inf { c = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], b, cap).0; }
                    }
                    let v = c + self.v[(j + 1) * nu + m as usize];
                    if v < best { best = v; arg = m; }
                }
                self.v[j * nu + k as usize] = best;
                self.pol[j * nu + k as usize] = arg as usize;
            }
        }

        // Commit units for the planned path with the battery reserve limited as in real time: the energy above the minimum at
        // the start of the hour, over the reserve duration, less the hour's discharge. An almost empty battery is therefore not
        // counted as reserve. Without reserve_energy the DP costs above do not see this limit.
        let mut k = clamp(((e0 - i.e_min) / de).round() as i32, 0, n - 1);
        for j in 0..h {
            let m = self.pol[j * nu + k as usize] as i32;
            e_traj[j + 1] = i.e_min + f64::from(m) * de;
            u_plan[j] = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], b_of(m - k), reserve_cap_step(i, e_traj[j], e_traj[j + 1])).1;
            k = m;
        }
    }

    /// The plan with a cost per genset start: the state is the stored energy and the units online in the hour before, so a
    /// path that starts units pays for each start. The units after hour j lie in the range of that hour's table, which is
    /// small, so this costs a few times the plan without starts. The costs are tabulated per level pair (k, m).
    #[allow(clippy::too_many_arguments)]
    fn plan_starts(&mut self, i: &PlanInput, e0: f64, load_fc: &[f64], pv_fc: &[f64], e_traj: &mut [f64], u_plan: &mut [i32],
                   (n, de, dlo, dhi, by_energy): (i32, f64, i32, i32, bool), b_of: impl Fn(i32) -> f64) {
        let (h, nu, nd, w) = (load_fc.len(), n as usize, (2 * n - 1) as usize, (dhi - dlo + 1) as usize);
        let inf = f64::INFINITY;
        // costs and units of every move k -> m (index (j * nu + k) * w + m - k - dlo), and the units range of each hour
        self.tc.clear();
        self.tc.resize(h * nu * w, inf);
        self.tu.clear();
        self.tu.resize(h * nu * w, 0);
        let (mut range, mut off) = (std::mem::take(&mut self.range), std::mem::take(&mut self.off));
        range.clear();
        range.resize(h + 1, (i.u0, i.u0));   // range[j]: units online before hour j
        for j in 0..h {
            let (mut lo, mut hi) = (i32::MAX, i32::MIN);
            for k in 0..n {
                for m in mx(0, k + dlo)..=mn(n - 1, k + dhi) {
                    let t = (j * nd) + (m - k + n - 1) as usize;
                    let (mut c, mut u) = (self.cost[t], self.units[t]);
                    if c == inf { continue; }
                    let (ek, em) = (i.e_min + f64::from(k) * de, i.e_min + f64::from(m) * de);
                    if by_energy {
                        let b = b_of(m - k);
                        let cap = reserve_cap_step(i, ek, em);
                        if cap < mx(0.0, i.pb - mx(b, 0.0)) { (c, u) = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], b, cap); }
                    }
                    if i.fr_up(j) { c += i.band_cost(em); }
                    let x = (j * nu + k as usize) * w + (m - k - dlo) as usize;
                    (self.tc[x], self.tu[x]) = (c, u);
                    (lo, hi) = (lo.min(u), hi.max(u));
                }
            }
            range[j + 1] = (lo, hi);
        }
        // values and choices of each state (k, units before the hour) for every hour, hour j at off[j]
        let width = |r: (i32, i32)| (r.1 - r.0 + 1) as usize;
        off.clear();
        off.resize(h + 1, 0);
        for j in 0..h { off[j + 1] = off[j] + nu * width(range[j]); }
        self.sv.clear();
        self.sv.resize(off[h], inf);
        self.sp.clear();
        self.sp.resize(off[h], 0);
        for j in (0..h).rev() {
            let (r, rn) = (range[j], range[j + 1]);
            for k in 0..n {
                for up in r.0..=r.1 {
                    let (mut best, mut arg) = (inf, k);
                    for m in mx(0, k + dlo)..=mn(n - 1, k + dhi) {
                        let x = (j * nu + k as usize) * w + (m - k - dlo) as usize;
                        let c = self.tc[x];
                        if c == inf { continue; }
                        let u = self.tu[x];
                        let next = if j + 1 == h { self.v[h * nu + m as usize] } else { self.sv[off[j + 1] + m as usize * width(rn) + (u - rn.0) as usize] };
                        let v = c + i.start_cost * f64::from(mx(0, u - up)) + next;
                        if v < best { best = v; arg = m; }
                    }
                    let s = off[j] + k as usize * width(r) + (up - r.0) as usize;
                    (self.sv[s], self.sp[s]) = (best, arg as u32);
                }
            }
        }
        // the path from (e0, u0), its units committed with the battery reserve limited as in real time (as `plan`)
        let (mut k, mut up) = (clamp(((e0 - i.e_min) / de).round() as i32, 0, n - 1), i.u0);
        for j in 0..h {
            let m = self.sp[off[j] + k as usize * width(range[j]) + (up - range[j].0) as usize] as i32;
            e_traj[j + 1] = i.e_min + f64::from(m) * de;
            u_plan[j] = self.hour_cost_at(i, j, load_fc[j], pv_fc[j], b_of(m - k), reserve_cap_step(i, e_traj[j], e_traj[j + 1])).1;
            up = self.tu[(j * nu + k as usize) * w + (m - k - dlo) as usize];
            k = m;
        }
        (self.range, self.off) = (range, off);
    }
}
