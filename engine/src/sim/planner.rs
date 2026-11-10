//! Rolling-horizon dynamic programme over the battery's stored energy for the predictive EMS (Planner in src/ems.cpp). It
//! minimises fuel, genset run-hours, battery wear and unserved energy across the forecast horizon. The real-time layer that
//! follows the plan and compensates forecast errors is in dispatch.rs.
use super::{clamp, mn, mx, FuelTable, GridHour};
use crate::{DieselParams, Project};

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
    pub terminal_per_kwh: f64,
    pub provides_reserve: bool,
    /// hours the battery must sustain its reserve power
    pub reserve_h: f64,
    pub levels: i32,
    /// the grid in each hour of the horizon (empty without a grid connection), as dispatch.rs sets it before each plan
    pub grid: Vec<GridHour>,
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
        // Wear cost per kWh discharged: replacement cost spread over the cycle life at its rated depth of discharge.
        cycle_cost: p.econ.bess_replace_kwh / mx(1.0, p.bess.cycle_life * p.bess.cycle_life_dod),
        voll: p.ems.voll,
        // Stored energy is worth the fuel it displaces at a typical (75 %) genset loading.
        terminal_per_kwh: p.ems.terminal_value * eta * (fuel.at(0.75) / 0.75 * p.econ.fuel_price + p.econ.diesel_om_kwh),
        provides_reserve: p.bess.provides_reserve,
        reserve_h: p.bess.reserve_duration_h,
        levels: p.ems.soc_levels,
        grid: Vec::new(),
    }
}

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
    fuel: &'a FuelTable,
    v: Vec<f64>,
    cost: Vec<f64>,
    pol: Vec<usize>,
}

impl<'a> Planner<'a> {
    pub fn new(dg: &'a DieselParams, fuel: &'a FuelTable) -> Planner<'a> { Planner { dg, fuel, v: vec![], cost: vec![], pol: vec![] } }

    /// Cost of one hour for battery AC power b (+ discharge / - charge) and the units online. bres_cap: most battery power
    /// that counts as spinning reserve (energy limit; infinite for none).
    pub fn hour_cost(&self, i: &PlanInput, l: f64, p: f64, b: f64, bres_cap: f64) -> (f64, i32) { self.hour_cost_grid(i, None, l, p, b, bres_cap) }

    /// `hour_cost` with the grid of the hour, as the dispatch uses it: while the grid is up it imports for the load before the
    /// gensets when cheaper (after them otherwise, for what they cannot cover), its spare import counts as reserve, no unit has
    /// to stay online, and PV and wind surplus is exported. The battery is not charged from the grid.
    pub fn hour_cost_grid(&self, i: &PlanInput, gh: Option<&GridHour>, l: f64, p: f64, b: f64, bres_cap: f64) -> (f64, i32) {
        let dg = self.dg;
        let net = l - p;
        let mut g = mx(0.0, net - b);   // genset energy needed
        let reserve = dg.reserve_load * l + dg.reserve_pv * mn(p, l);
        let bres = if i.provides_reserve { mx(0.0, mn(i.pb - mx(b, 0.0), bres_cap)) } else { 0.0 };
        let gh = gh.filter(|x| x.up);
        let (mut gi, mut head, mut grid_cost) = (0.0, 0.0, 0.0);
        if let Some(x) = gh {
            if x.cheap { gi = mn(x.imp, mx(0.0, net - mx(b, 0.0))); g -= gi; }   // the load, not battery charging
            head = x.imp - gi;
            grid_cost -= mn(mx(0.0, -net - mx(0.0, -b)), x.exp) * x.exp_price;   // PV and wind surplus left after charging
        }
        let need = g + mx(0.0, reserve - bres - head);
        let mut u = if need > 1e-6 { (need / dg.unit_kw - 1e-9).ceil() as i32 } else { 0 };
        let min_on = if dg.units > 0 && gh.is_none() { mn(dg.min_units_online, dg.units) } else { 0 };
        u = mn(mx(u, min_on), dg.units);
        let cap = f64::from(u) * dg.unit_kw;
        let mut unmet = mx(0.0, g - cap);
        if let Some(x) = gh {
            if !x.cheap { let more = mn(unmet, x.imp); gi += more; unmet -= more; }
            grid_cost += gi * x.price;
        }
        let (mut fuel, mut geff) = (0.0, 0.0);
        if u > 0 {
            geff = mx(mn(g, cap), cap * dg.min_load);
            fuel = cap * self.fuel.at(geff / cap);
        }
        let cost = fuel * i.fuel_price + f64::from(u) * i.om_unit_hour + geff * i.om_kwh + unmet * i.voll + mx(b, 0.0) * i.cycle_cost;
        (if gh.is_some() { cost + grid_cost } else { cost }, u)
    }

    /// Fills e_traj (H+1 stored-energy targets, e_traj[0] = start) and u_plan (H planned units online). The units are
    /// committed with battery reserve limited as in real time (energy at the start of the hour, less the hour's discharge);
    /// the SOC path ignores that limit.
    pub fn plan(&mut self, i: &PlanInput, e0: f64, load_fc: &[f64], pv_fc: &[f64], e_traj: &mut Vec<f64>, u_plan: &mut Vec<i32>) {
        let h = load_fc.len();
        e_traj.clear();
        e_traj.resize(h + 1, e0);
        u_plan.clear();
        u_plan.resize(h, 0);
        let span = i.e_max - i.e_min;
        if span <= 1e-9 || i.pb <= 1e-9 {
            for j in 0..h { u_plan[j] = self.hour_cost_grid(i, i.grid.get(j), load_fc[j], pv_fc[j], 0.0, reserve_cap(i, e0)).1; }
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

        // Hour cost depends only on the level change d = m - k, so tabulate it once per hour for the changes the battery
        // power allows, d in [dlo, dhi].
        let b_of = |d: i32| { let den = f64::from(d) * de; if den < 0.0 { -den * i.eta } else { -den / i.eta } };
        let (mut dlo, mut dhi) = (0i32, 0i32);
        while dlo > 1 - n && b_of(dlo - 1).abs() <= i.pb * (1.0 + 1e-9) { dlo -= 1; }
        while dhi < n - 1 && b_of(dhi + 1).abs() <= i.pb * (1.0 + 1e-9) { dhi += 1; }
        for j in 0..h {
            for d in dlo..=dhi {
                self.cost[j * nd + (d + n - 1) as usize] = self.hour_cost_grid(i, i.grid.get(j), load_fc[j], pv_fc[j], b_of(d), inf).0;
            }
        }
        for k in 0..nu { self.v[h * nu + k] = -i.terminal_per_kwh * (i.e_min + k as f64 * de); }

        for j in (0..h).rev() {
            for k in 0..n {
                let mut best = inf;
                let mut arg = k;
                for m in mx(0, k + dlo)..=mn(n - 1, k + dhi) {
                    let v = self.cost[j * nd + (m - k + n - 1) as usize] + self.v[(j + 1) * nu + m as usize];
                    if v < best { best = v; arg = m; }
                }
                self.v[j * nu + k as usize] = best;
                self.pol[j * nu + k as usize] = arg as usize;
            }
        }

        // Commit units for the planned path with the battery reserve limited as in real time: the energy above the minimum at
        // the start of the hour, over the reserve duration, less the hour's discharge. An almost empty battery is therefore not
        // counted as reserve. The DP costs above do not see this limit.
        let mut k = clamp(((e0 - i.e_min) / de).round() as i32, 0, n - 1);
        for j in 0..h {
            let m = self.pol[j * nu + k as usize] as i32;
            e_traj[j + 1] = i.e_min + f64::from(m) * de;
            u_plan[j] = self.hour_cost_grid(i, i.grid.get(j), load_fc[j], pv_fc[j], b_of(m - k), reserve_cap_step(i, e_traj[j], e_traj[j + 1])).1;
            k = m;
        }
    }
}
