//! The grid connection (`GridParams`) in each project year, hour by hour: whether the grid is up, its import price and limits.
//! The dispatch imports before the gensets when the grid is up and cheaper, and exports PV and wind surplus.
use crate::model::{month_of_day, GridParams, HOURS};
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

/// One project year of the grid
#[derive(Debug, Clone)]
pub struct GridYear {
    /// grid up in each hour (random outages included)
    pub up: Rc<Vec<bool>>,
    /// what the EMS knows ahead: the outage pattern, not the random outages
    pub planned_up: Rc<Vec<bool>>,
    /// import price of each hour at year-1 prices, without the carbon price
    pub price0: Rc<Vec<f64>>,
    /// escalation factor of the year, carbon cost per kWh imported, genset energy cost per kWh of the year
    pub esc: f64,
    pub carbon_kwh: f64,
    pub diesel_kwh: f64,
    pub imp: f64,
    pub exp: f64,
    pub exp_price0: f64,
}

impl GridYear {
    /// Hour `t` (taken in this year, so a plan past the year end wraps); `planned`: as the EMS knows it ahead
    pub fn hour(&self, t: usize, planned: bool) -> GridHour {
        let t = t % HOURS;
        let up = if planned { self.planned_up[t] } else { self.up[t] };
        if !up { return GridHour::default(); }
        let price = self.price0[t] * self.esc + self.carbon_kwh;
        GridHour { up, cheap: price < self.diesel_kwh, imp: self.imp, exp: self.exp, price, exp_price: self.exp_price0 * self.esc }
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
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
    /// exponential with the given mean
    fn exp(&mut self, mean: f64) -> f64 { -mean * (1.0 - self.next()).ln() }
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

/// The grid of project year `year`; `diesel_kwh`: the cost of genset energy that year, per kWh (escalated, carbon included).
/// `prev`: the grid of an earlier year of the same project, whose pattern and prices are reused.
pub fn grid_year(g: &GridParams, year: i32, carbon_price_t: f64, diesel_kwh: f64, prev: Option<&GridYear>) -> GridYear {
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
        diesel_kwh,
        imp: g.import_kw.max(0.0),
        exp: g.export_kw.max(0.0),
        exp_price0: g.export_price,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> GridParams { GridParams { enabled: true, import_kw: 100.0, export_kw: 50.0, ..Default::default() } }

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
        let y = grid_year(&g, 1, 0.0, 0.3, None);
        assert_eq!(y.up.iter().filter(|u| !**u).count(), 3 * 365);
        assert!(!y.hour(24 * 7 + 19, false).up && y.hour(24 * 7 + 19, false).imp == 0.0);
        assert_eq!(y.outages(), 365.0);
        assert!(y.hour(12, false).cheap);

        g.availability = "random".into();
        g.outages_per_year = 20.0;
        g.outage_hours = 6.0;
        let (a, b) = (grid_year(&g, 1, 0.0, 0.3, None), grid_year(&g, 1, 0.0, 0.3, None));
        assert_eq!(a.up, b.up, "the same seed and year give the same outages");
        assert!(a.planned_up.iter().all(|u| *u));
        let down = a.up.iter().filter(|u| !**u).count() as f64;
        assert!(down > 20.0 && down < 400.0, "down {down} h");
        assert_ne!(a.up, grid_year(&g, 2, 0.0, 0.3, None).up, "each year has its own draw");
        // many years: the mean count and length come close to the inputs
        let (mut n, mut h) = (0.0, 0.0);
        for yr in 1..=200 { let y = grid_year(&g, yr, 0.0, 0.3, None); n += y.outages(); h += y.up.iter().filter(|u| !**u).count() as f64; }
        assert!((n / 200.0 - 20.0).abs() < 1.5, "mean outages {}", n / 200.0);
        assert!((h / n - 6.0).abs() < 0.8, "mean length {}", h / n);
    }

    #[test]
    fn escalation_and_carbon_decide_the_merit_order() {
        let mut g = grid();
        g.escalation = 0.10;
        g.co2_kg_per_kwh = 0.8;
        let y5 = grid_year(&g, 5, 50.0, 0.18, None);
        let h = y5.hour(0, false);
        assert!((h.price - (0.10 * 1.1f64.powi(4) + 0.04)).abs() < 1e-12);
        assert!(!h.cheap, "0.186 per kWh is dearer than 0.18");
        assert!(grid_year(&g, 1, 50.0, 0.18, None).hour(0, false).cheap);
    }
}
