//! The genset fleet as the dispatch and the EMS planner commit it: one group of identical units, or a mixed fleet of several
//! groups whose units are committed in merit order (cheapest energy first) and share the load in proportion to their rating.
use super::{mn, mx, FuelTable};
use super::grid::Rng;
use crate::HOURS;
use crate::{DieselParams, EconParams, Error};

/// One group of identical units with its fuel model and costs (those of the Costs page for the main group)
#[derive(Debug, Clone)]
pub struct UnitGroup {
    pub name: String,
    pub units: i32,
    pub unit_kw: f64,
    pub min_load: f64,
    pub fuel: FuelTable,
    pub capex_kw: f64,
    pub om_kwh: f64,
    pub om_unit_hour: f64,
    /// index in the project's list (0 = the main group)
    pub index: usize,
}

impl UnitGroup {
    /// Cost per kWh at 75 % loading at year-1 prices: fuel, O&M per kWh and per run-hour; sets the merit order
    fn merit(&self, fuel_price: f64) -> f64 {
        self.fuel.at(0.75) / 0.75 * fuel_price + self.om_kwh + self.om_unit_hour / (0.75 * self.unit_kw)
    }
}

/// The fleet. Commitment is a number of units u: the first u units of the merit order. With one group the figures are
/// computed as the single-type fleet always did, so such projects give the same results to the byte.
#[derive(Debug, Clone)]
pub struct Fleet {
    /// in merit order
    pub groups: Vec<UnitGroup>,
    pub units: i32,
    /// units that always run (when the grid is down), as set
    pub min_on: i32,
    min_on_set: i32,
    mixed: bool,
    /// cumulative rating and minimum output of the first u units, and their units online by group (mixed fleets)
    cap: Vec<f64>,
    gmin: Vec<f64>,
    online: Vec<Vec<i32>>,
}

impl Fleet {
    /// The single-type fleet of `dg` with its fuel table (the further groups are left out)
    pub fn single(dg: &DieselParams, fuel: &FuelTable, ec: &EconParams) -> Fleet {
        let g = UnitGroup {
            name: String::new(), units: dg.units, unit_kw: dg.unit_kw, min_load: dg.min_load, fuel: fuel.clone(), capex_kw: ec.diesel_capex_kw,
            om_kwh: ec.diesel_om_kwh, om_unit_hour: ec.diesel_om_unit_hour, index: 0,
        };
        Fleet { units: dg.units, min_on: if dg.units > 0 { mn(dg.min_units_online, dg.units) } else { 0 }, min_on_set: dg.min_units_online,
                groups: vec![g], mixed: false, cap: vec![], gmin: vec![], online: vec![] }
    }

    /// The project's fleet: the main group and its further groups, in merit order at the year-1 fuel price
    pub fn new(dg: &DieselParams, ec: &EconParams) -> Result<Fleet, Error> {
        let fuel = FuelTable::new(dg)?;
        let mut f = Fleet::single(dg, &fuel, ec);
        if dg.more_groups.is_empty() { return Ok(f); }
        for (i, g) in dg.more_groups.iter().enumerate() {
            f.groups.push(UnitGroup {
                name: g.name.clone(), units: g.units, unit_kw: g.unit_kw, min_load: g.min_load, fuel: FuelTable::of_group(g)?,
                capex_kw: g.capex_kw.unwrap_or(ec.diesel_capex_kw), om_kwh: g.om_kwh.unwrap_or(ec.diesel_om_kwh),
                om_unit_hour: g.om_unit_hour.unwrap_or(ec.diesel_om_unit_hour), index: i + 1,
            });
        }
        f.groups.sort_by(|a, b| a.merit(ec.fuel_price).partial_cmp(&b.merit(ec.fuel_price)).unwrap_or(std::cmp::Ordering::Equal));
        f.mixed = true;
        let counts: Vec<i32> = f.groups.iter().map(|g| g.units.max(0)).collect();
        f.build(&counts);
        Ok(f)
    }

    /// The fleet with `avail[k]` units of each group (merit order) available, the others out for repair
    pub fn with_available(&self, avail: &[i32]) -> Fleet {
        let mut f = self.clone();
        if !self.mixed {
            f.units = avail[0].clamp(0, self.groups[0].units.max(0));
            f.min_on = if f.units > 0 { mn(self.min_on_set, f.units) } else { 0 };
        } else {
            let counts: Vec<i32> = avail.iter().zip(&self.groups).map(|(&a, g)| a.clamp(0, g.units.max(0))).collect();
            f.build(&counts);
        }
        f
    }

    /// The tables of a mixed fleet with `counts` units of each group
    fn build(&mut self, counts: &[i32]) {
        self.units = counts.iter().sum();
        self.min_on = if self.units > 0 { mn(self.min_on_set, self.units) } else { 0 };
        let n = self.groups.len();
        let (mut cap, mut gmin, mut on) = (vec![0.0], vec![0.0], vec![vec![0; n]]);
        for (k, g) in self.groups.iter().enumerate() {
            for _ in 0..counts[k] {
                cap.push(cap[cap.len() - 1] + g.unit_kw);
                gmin.push(gmin[gmin.len() - 1] + g.unit_kw * g.min_load);
                let mut o = on[on.len() - 1].clone();
                o[k] += 1;
                on.push(o);
            }
        }
        self.cap = cap;
        self.gmin = gmin;
        self.online = on;
    }

    pub fn is_mixed(&self) -> bool { self.mixed }

    /// Units needed for `need` kW of genset output and reserve (may exceed the fleet; callers cap it)
    pub fn units_for(&self, need: f64) -> i32 {
        if !self.mixed {
            return if need > 1e-6 { (need / self.groups[0].unit_kw - 1e-9).ceil() as i32 } else { 0 };
        }
        if need <= 1e-6 { return 0; }
        match self.cap.iter().position(|&c| c >= need - 1e-9 * need) { Some(u) => u as i32, None => self.units + 1 }
    }

    fn at(&self, u: i32) -> usize { (u.clamp(0, self.units)) as usize }

    /// Rating of u units online (kW)
    pub fn cap(&self, u: i32) -> f64 { if self.mixed { self.cap[self.at(u)] } else { f64::from(u) * self.groups[0].unit_kw } }

    /// Least output of u units online (each at its minimum loading)
    pub fn gmin(&self, u: i32) -> f64 { if self.mixed { self.gmin[self.at(u)] } else { f64::from(u) * self.groups[0].unit_kw * self.groups[0].min_load } }

    /// Units online of each group (merit order) with u units committed
    pub fn online(&self, u: i32) -> &[i32] { &self.online[self.at(u)] }

    /// Fuel (L/h) of u units online sharing `gen` kW in proportion to their rating
    pub fn fuel_lh(&self, u: i32, gen: f64) -> f64 {
        let cap = self.cap(u);
        if !self.mixed { return cap * self.groups[0].fuel.at(gen / cap); }
        let lf = gen / cap;
        self.online(u).iter().zip(&self.groups).map(|(&n, g)| f64::from(n) * g.unit_kw * g.fuel.at(lf)).sum()
    }

    /// Loading the units run at when they cover `kw` (at least their minimum loading); 75 % without a need
    pub fn loading(&self, kw: f64) -> f64 {
        if kw <= 1e-6 || self.units <= 0 { return 0.75; }
        let u = mx(1, mn(self.units_for(kw), self.units));
        let cap = self.cap(u);
        if cap <= 0.0 { return 0.75; }
        (kw / cap).clamp((self.gmin(u) / cap).max(0.01), 1.0)
    }

    /// Fleet rating (kW)
    pub fn rating(&self) -> f64 { self.cap(self.units) }

    /// Forced outages of one project year at `k` steps per hour: each unit fails at random (`rate` per year, exponential
    /// time to failure counted in calendar time) and is repaired after an exponential time of mean `repair_h`. Returns the
    /// units available of each group (merit order) in every step, as one table (step x group), the number of outages and the
    /// unit-hours out. Each unit and year has its own draw from `seed`.
    pub fn outages(&self, rate: f64, repair_h: f64, seed: i64, year: i32, k: usize) -> (Vec<i32>, f64, f64) {
        let (ng, n) = (self.groups.len(), HOURS * k);
        let mut avail: Vec<i32> = (0..n).flat_map(|_| self.groups.iter().map(|g| g.units.max(0))).collect();
        let (mut count, mut down_h) = (0.0, 0.0);
        if rate <= 0.0 { return (avail, count, down_h); }
        let up_mean = HOURS as f64 / rate;
        for (g, gr) in self.groups.iter().enumerate() {
            for unit in 0..gr.units.max(0) {
                let s = (seed as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ((year as u64) << 40) ^ ((gr.index as u64) << 20) ^ unit as u64;
                let mut rng = Rng(s.wrapping_mul(0xBF58_476D_1CE4_E5B9));
                let mut t = rng.exp(up_mean);
                while t < HOURS as f64 {
                    let d = rng.exp(repair_h);
                    let (a, b) = ((t * k as f64) as usize, (((t + d) * k as f64).ceil() as usize).min(n));
                    for st in a..b { avail[st * ng + g] -= 1; }
                    count += 1.0;
                    down_h += (b - a) as f64 / k as f64;
                    t += d + rng.exp(up_mean);
                }
            }
        }
        (avail, count, down_h)
    }

    /// Rating of the largest of u units online
    pub fn largest(&self, u: i32) -> f64 {
        if u <= 0 { return 0.0; }
        if !self.mixed { return self.groups[0].unit_kw; }
        self.online(u).iter().zip(&self.groups).filter(|(n, _)| **n > 0).map(|(_, g)| g.unit_kw).fold(0.0, f64::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GensetGroup;

    fn mixed() -> (DieselParams, EconParams) {
        let mut dg = DieselParams { unit_kw: 1000.0, units: 2, min_load: 0.3, min_units_online: 1, ..Default::default() };
        // a small, less efficient group: it comes after the big units in merit order
        dg.more_groups.push(GensetGroup {
            name: "small".into(), units: 3, unit_kw: 400.0, min_load: 0.4, fuel_model: "linear".into(), fuel_intercept: 0.03, fuel_slope: 0.26,
            fuel_curve: vec![], capex_kw: Some(300.0), om_kwh: None, om_unit_hour: Some(1.0),
        });
        (dg, EconParams::default())
    }

    #[test]
    fn units_are_committed_in_merit_order() {
        let (dg, ec) = mixed();
        let f = Fleet::new(&dg, &ec).unwrap();
        assert!(f.is_mixed() && f.units == 5 && f.groups[0].index == 0 && f.groups[1].name == "small");
        assert_eq!(f.units_for(900.0), 1);
        assert_eq!(f.units_for(2000.0), 2);
        assert_eq!(f.units_for(2001.0), 3);
        assert_eq!(f.units_for(9000.0), 6);
        assert_eq!(f.cap(3), 2400.0);
        assert!((f.gmin(3) - (600.0 + 160.0)).abs() < 1e-9);
        assert_eq!(f.online(4), &[2, 2]);
        assert_eq!(f.rating(), 3200.0);
        assert_eq!(f.groups[1].om_kwh, ec.diesel_om_kwh, "a missing cost is the main group's");
        // the load is shared at one loading: fuel is the sum of each unit's at that loading
        let lf = 1800.0 / 2400.0;
        let want = 2000.0 * f.groups[0].fuel.at(lf) + 400.0 * (0.03 + 0.26 * lf);
        assert!((f.fuel_lh(3, 1800.0) - want).abs() < 1e-9);
    }

    #[test]
    fn a_single_group_is_the_old_fleet() {
        let (mut dg, ec) = mixed();
        dg.more_groups.clear();
        let f = Fleet::new(&dg, &ec).unwrap();
        assert!(!f.is_mixed());
        assert_eq!(f.units_for(1500.0), 2);
        assert_eq!(f.cap(2), 2.0 * 1000.0);
        assert_eq!(f.gmin(2), 2.0 * 1000.0 * 0.3);
        assert_eq!(f.fuel_lh(2, 1500.0), 2.0 * 1000.0 * FuelTable::new(&dg).unwrap().at(0.75));
    }
}
