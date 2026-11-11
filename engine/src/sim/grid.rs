//! The grid connection (`GridParams`) in each project year, hour by hour: whether the grid is up, its import price and limits.
//! The dispatch imports before the gensets when the grid is up and cheaper, and exports PV and wind surplus.
use super::{FuelTable, UnitGroup};
use crate::model::{month_of_day, EconParams, GridParams, HOURS};
use std::rc::Rc;

/// The grid in one hour as the dispatch and the EMS planner see it. Prices are of the year simulated (escalated) and include
/// the carbon price; `cheap`: importing costs less than genset energy, so the grid goes before the gensets.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GridHour {
    pub up: bool,
    pub cheap: bool,
    /// import and export limits, kW
    pub imp: f64,
    pub exp: f64,
    /// per kWh imported, per kWh exported
    pub price: f64,
    pub exp_price: f64,
}

/// The cost of genset energy in one project year: fuel and carbon per litre (escalated) and O&M per kWh
#[derive(Debug, Clone)]
pub struct GensetCost {
    pub fuel: FuelTable,
    pub per_l: f64,
    pub om_kwh: f64,
}

impl GensetCost {
    /// Of genset group `g` (the first of the merit order) in project year `year` (fuel and O&M escalated, the carbon price
    /// on the fuel's CO2)
    pub fn of_year(ec: &EconParams, g: &UnitGroup, year: i32) -> GensetCost {
        let y = f64::from(year - 1);
        GensetCost {
            fuel: g.fuel.clone(),
            per_l: ec.fuel_price * (1.0 + ec.fuel_escalation).powf(y) + ec.co2_kg_per_l * ec.carbon_price_t / 1000.0,
            om_kwh: g.om_kwh * (1.0 + ec.om_escalation).powf(y),
        }
    }
    /// per kWh at loading `lf` (share of the online rating)
    pub fn kwh(&self, lf: f64) -> f64 { self.fuel.at(lf) / lf * self.per_l + self.om_kwh }
}

/// Loading of the units a genset need of `kw` would commit (units of `unit_kw`, at least `min_load`); 75 % without a need
pub fn loading(kw: f64, unit_kw: f64, min_load: f64) -> f64 {
    if kw <= 1e-6 || unit_kw <= 0.0 { return 0.75; }
    let n = (kw / unit_kw - 1e-9).ceil().max(1.0);
    (kw / (n * unit_kw)).clamp(min_load.max(0.01), 1.0)
}

/// One project year of the grid
#[derive(Debug, Clone)]
pub struct GridYear {
    /// grid up in each hour (random outages included)
    pub up: Rc<Vec<bool>>,
    /// what the EMS knows ahead: the outage pattern, not the random outages
    pub planned_up: Rc<Vec<bool>>,
    /// import price of each hour at year-1 prices, without the carbon price
    pub price0: Rc<Vec<f64>>,
    /// escalation factor of the year, carbon cost per kWh imported, the cost of genset energy that year
    pub esc: f64,
    pub carbon_kwh: f64,
    pub genset: GensetCost,
    pub imp: f64,
    pub exp: f64,
    pub exp_price0: f64,
}

impl GridYear {
    /// Hour `t` (taken in this year, so a plan past the year end wraps); `planned`: as the EMS knows it ahead. The grid is
    /// cheap when its price is below genset energy at 75 % loading.
    pub fn hour(&self, t: usize, planned: bool) -> GridHour { self.hour_at(t, planned, 0.75) }

    /// `hour` with genset energy valued at loading `lf`, the loading the units would run at in that hour (`loading`)
    pub fn hour_at(&self, t: usize, planned: bool, lf: f64) -> GridHour {
        let t = t % HOURS;
        let up = if planned { self.planned_up[t] } else { self.up[t] };
        if !up { return GridHour::default(); }
        let price = self.price0[t] * self.esc + self.carbon_kwh;
        // no export at a negative price: the surplus is curtailed, which costs nothing
        let exp = if self.exp_price0 < 0.0 { 0.0 } else { self.exp };
        GridHour { up, cheap: price < self.genset.kwh(lf), imp: self.imp, exp, price, exp_price: self.exp_price0 * self.esc }
    }

    pub fn outages(&self) -> f64 { (0..HOURS).filter(|&t| !self.up[t] && (t == 0 || self.up[t - 1])).count() as f64 }
}

/// Import price of hour `t` at year-1 prices: flat, or time of use by hour of the day (24) or by month and hour (288)
pub fn import_price(g: &GridParams, t: usize) -> f64 {
    if g.tariff != "tou" || g.tou.is_empty() { return g.import_price; }
    let h = t % 24;
    if g.tou.len() == 288 { g.tou[month_of_day((t / 24) as i32) as usize * 24 + h] } else { g.tou[h % g.tou.len()] }
}

/// SplitMix64: a small generator of its own, so the outage draw does not change with other random numbers of the engine
pub(super) struct Rng(pub(super) u64);
impl Rng {
    pub(super) fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
    /// exponential with the given mean
    pub(super) fn exp(&mut self, mean: f64) -> f64 { -mean * (1.0 - self.next()).ln() }
}

/// Random outages of one year: up-times between outages and outage lengths are exponential, with means that give
/// `outages_per_year` outages of `outage_hours` on average (each at least one hour). Each year has its own draw.
fn random_outages(g: &GridParams, year: i32, up: &mut [bool]) {
    let n = g.outages_per_year;
    if n <= 0.0 { return; }
    let dur = g.outage_hours.max(1.0);
    let gap = ((HOURS as f64 - n * dur) / n).max(1.0);
    let mut rng = Rng((g.seed as u64).wrapping_mul(0x2545_F491_4F6C_DD1D) ^ (year as u64).wrapping_mul(0x9E37_79B9));
    let mut t = rng.exp(gap);
    while t < HOURS as f64 {
        let s = t as usize;
        let d = rng.exp(dur).round().max(1.0) as usize;
        for x in up.iter_mut().skip(s).take(d) { *x = false; }
        t = (s + d) as f64 + rng.exp(gap);
    }
}

/// The grid of project year `year`; `genset`: the cost of genset energy that year. `prev`: the grid of an earlier year of the
/// same project, whose pattern and prices are reused.
pub fn grid_year(g: &GridParams, year: i32, carbon_price_t: f64, genset: GensetCost, prev: Option<&GridYear>) -> GridYear {
    let (planned_up, price0) = match prev {
        Some(y) => (y.planned_up.clone(), y.price0.clone()),
        None => {
            let mut pu = vec![true; HOURS];
            if g.availability == "pattern" && !g.pattern.is_empty() {
                for (t, u) in pu.iter_mut().enumerate() { *u = g.pattern[t % g.pattern.len()] > 0.5; }
            }
            (Rc::new(pu), Rc::new((0..HOURS).map(|t| import_price(g, t)).collect()))
        }
    };
    let up = if g.availability == "random" {
        let mut up = planned_up.as_ref().clone();
        random_outages(g, year, &mut up);
        Rc::new(up)
    } else { planned_up.clone() };
    GridYear {
        up, planned_up, price0,
        esc: (1.0 + g.escalation).powf(f64::from(year - 1)),
        carbon_kwh: g.co2_kg_per_kwh * carbon_price_t / 1000.0,
        genset,
        imp: g.import_kw.max(0.0),
        exp: g.export_kw.max(0.0),
        exp_price0: g.export_price,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> GridParams { GridParams { enabled: true, import_kw: 100.0, export_kw: 50.0, ..Default::default() } }
    /// genset energy at `kwh` per kWh whatever the loading
    fn flat(kwh: f64) -> GensetCost {
        GensetCost { fuel: FuelTable::new(&crate::DieselParams::default()).unwrap(), per_l: 0.0, om_kwh: kwh }
    }

    #[test]
    fn genset_energy_costs_more_at_low_loading() {
        let c = GensetCost { fuel: FuelTable::new(&crate::DieselParams::default()).unwrap(), per_l: 1.0, om_kwh: 0.0 };
        assert!(c.kwh(0.3) > c.kwh(0.75));
        assert_eq!(loading(0.0, 1000.0, 0.3), 0.75);
        assert!((loading(1500.0, 1000.0, 0.3) - 0.75).abs() < 1e-12);
        assert_eq!(loading(100.0, 1000.0, 0.3), 0.3);
        let mut g = grid();
        g.import_price = 0.29;   // between the cost at 75 % (0.254 L/kWh) and at 30 % loading (0.297)
        let y = grid_year(&g, 1, 0.0, c, None);
        assert!(!y.hour(0, false).cheap && y.hour_at(0, false, 0.3).cheap);
    }

    #[test]
    fn time_of_use_by_hour_and_by_month() {
        let mut g = grid();
        g.tariff = "tou".into();
        g.tou = (0..24).map(f64::from).collect();
        assert_eq!(import_price(&g, 24 * 40 + 18), 18.0);
        g.tou = (0..288).map(f64::from).collect();
        assert_eq!(import_price(&g, 24 * 40 + 18), 24.0 + 18.0);   // 10 February, 18:00
        g.tariff = "flat".into();
        assert_eq!(import_price(&g, 5), 0.10);
    }

    #[test]
    fn a_daily_pattern_is_known_ahead_and_random_outages_are_not() {
        let mut g = grid();
        g.availability = "pattern".into();
        g.pattern = (0..24).map(|h| if (18..21).contains(&h) { 0.0 } else { 1.0 }).collect();
        let y = grid_year(&g, 1, 0.0, flat(0.3), None);
        assert_eq!(y.up.iter().filter(|u| !**u).count(), 3 * 365);
        assert!(!y.hour(24 * 7 + 19, false).up && y.hour(24 * 7 + 19, false).imp == 0.0);
        assert_eq!(y.outages(), 365.0);
        assert!(y.hour(12, false).cheap);

        g.availability = "random".into();
        g.outages_per_year = 20.0;
        g.outage_hours = 6.0;
        let (a, b) = (grid_year(&g, 1, 0.0, flat(0.3), None), grid_year(&g, 1, 0.0, flat(0.3), None));
        assert_eq!(a.up, b.up, "the same seed and year give the same outages");
        assert!(a.planned_up.iter().all(|u| *u));
        let down = a.up.iter().filter(|u| !**u).count() as f64;
        assert!(down > 20.0 && down < 400.0, "down {down} h");
        assert_ne!(a.up, grid_year(&g, 2, 0.0, flat(0.3), None).up, "each year has its own draw");
        // many years: the mean count and length come close to the inputs
        let (mut n, mut h) = (0.0, 0.0);
        for yr in 1..=200 { let y = grid_year(&g, yr, 0.0, flat(0.3), None); n += y.outages(); h += y.up.iter().filter(|u| !**u).count() as f64; }
        assert!((n / 200.0 - 20.0).abs() < 1.5, "mean outages {}", n / 200.0);
        assert!((h / n - 6.0).abs() < 0.8, "mean length {}", h / n);
    }

    #[test]
    fn escalation_and_carbon_decide_the_merit_order() {
        let mut g = grid();
        g.escalation = 0.10;
        g.co2_kg_per_kwh = 0.8;
        let y5 = grid_year(&g, 5, 50.0, flat(0.18), None);
        let h = y5.hour(0, false);
        assert!((h.price - (0.10 * 1.1f64.powi(4) + 0.04)).abs() < 1e-12);
        assert!(!h.cheap, "0.186 per kWh is dearer than 0.18");
        assert!(grid_year(&g, 1, 50.0, flat(0.18), None).hour(0, false).cheap);
    }
}
