//! Results that lie outside a plausible range ("checks" of a simulation's summary): each with its value, the range and a
//! one-line reason. The ranges are wide on purpose, so a sound project raises nothing; a check that fires points at an input
//! slip (a unit, a factor typed twice) or at a figure that does not add up. Nothing here changes a result.
use super::{Comparison, SimResult};
use crate::json::obj;
use crate::model::HOURS;
use crate::{Project, Value};

/// Energy in a litre of diesel (lower heating value, about 35.8 MJ/L), for the genset efficiency
pub const DIESEL_KWH_PER_L: f64 = 9.94;

/// One result outside its range. Values are in display units (a share as %), `lo` or `hi` None for an open end.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub id: &'static str,
    pub label: String,
    pub value: f64,
    pub lo: Option<f64>,
    pub hi: Option<f64>,
    pub unit: &'static str,
    pub why: String,
}

/// What the checks read besides the result: the diesel-only case and the comparison against it (payback), and the PV
/// model's plane-of-array and rear-side irradiation (kWh/m2 a year, after shading)
pub struct CheckBasis<'a> {
    pub base: &'a SimResult,
    pub cmp: &'a Comparison,
    pub poa_kwh_m2: f64,
    pub rear_kwh_m2: f64,
}

fn out(v: f64, lo: Option<f64>, hi: Option<f64>) -> bool {
    !v.is_finite() || lo.is_some_and(|l| v < l) || hi.is_some_and(|h| v > h)
}

/// The checks of the simulation `r` of project `p` that fail (empty when every result is plausible)
pub fn result_checks(p: &Project, r: &SimResult, b: &CheckBasis) -> Vec<Check> {
    let mut v = Vec::new();
    let Some(y1) = r.years.first() else { return v };
    let mut add = |id, label: String, value: f64, lo: Option<f64>, hi: Option<f64>, unit, why: String| {
        if out(value, lo, hi) { v.push(Check { id, label, value, lo, hi, unit, why }); }
    };
    let s = &r.size;

    // PV: year-1 yield against the irradiation on the modules; the rear side of bifacial modules may add its share
    if s.pv_kwp > 0.0 && b.poa_kwh_m2 > 0.0 {
        let yld = y1.pv_avail / s.pv_kwp;
        let pr = yld / b.poa_kwh_m2;
        let hi = 0.95 * (1.0 + b.rear_kwh_m2.max(0.0) / b.poa_kwh_m2);
        add("pv_pr", "PV performance ratio (year 1)".into(), 100.0 * pr, Some(50.0), Some(100.0 * hi), "%",
            format!("{yld:.0} kWh/kWp from {:.0} kWh/m² on the modules; losses rarely take more than half or less than 5 %", b.poa_kwh_m2));
        add("pv_cf", "PV capacity factor (year 1)".into(), 100.0 * yld / HOURS as f64, Some(0.0), Some(35.0), "%",
            "even single-axis trackers at the sunniest sites stay below about 30 % of the DC rating".into());
    }
    // Wind: output against the rating of the turbines
    let wind_kw = s.wind_units * p.wind.rated_kw;
    if wind_kw > 0.0 {
        add("wind_cf", "Wind capacity factor (year 1)".into(), 100.0 * y1.wind_avail / (wind_kw * HOURS as f64), Some(0.0), Some(65.0), "%",
            "the best onshore and offshore sites reach about 50 to 60 %; check the wind speeds and the hub height".into());
    }
    // Gensets: fuel per kWh over the year, and the efficiency it implies
    if y1.gen_kwh > 0.0 && y1.fuel_l > 0.0 {
        let sfc = y1.fuel_l / y1.gen_kwh;
        add("gen_sfc", "Genset specific fuel consumption (year 1)".into(), sfc, Some(0.2), Some(0.6), "L/kWh",
            format!("an efficiency of {:.0} % at {DIESEL_KWH_PER_L} kWh/L; gensets run between about 0.21 L/kWh near full load and 0.5 at low loading",
                    100.0 / (sfc * DIESEL_KWH_PER_L)));
    }
    // Emissions per litre against the factors entered (grid and embodied PV CO2 taken off first)
    if y1.fuel_l > 0.0 {
        let ec = &p.econ;
        let co2 = y1.co2_t - (y1.grid_import + y1.grid_to_bess) * p.grid.co2_kg_per_kwh / 1000.0 - y1.co2_pv_t;
        for (id, name, t, f, unit, k) in [
            ("co2_per_l", "CO2", co2, ec.co2_kg_per_l, "kg/L", 1000.0), ("nox_per_l", "NOx", y1.nox_t, ec.nox_g_per_l, "g/L", 1e6),
            ("sox_per_l", "SOx", y1.sox_t, ec.sox_g_per_l, "g/L", 1e6), ("pm25_per_l", "PM2.5", y1.pm25_t, ec.pm25_g_per_l, "g/L", 1e6),
            ("co_per_l", "CO", y1.co_t, ec.co_g_per_l, "g/L", 1e6),
        ] {
            let tol = 1e-3 * f.abs() + 1e-9;
            add(id, format!("{name} per litre of diesel (year 1)"), t * k / y1.fuel_l, Some(f - tol), Some(f + tol), unit,
                format!("the year's {name} divided by its fuel should give the factor entered ({f})"));
        }
    }
    // Energy balance of every year: sources = load + losses + curtailment + dump + change in stored energy
    let worst = r.years.iter().map(|y| {
        let (d_e, loss) = (y.e_end - y.e_start, y.bess_loss());
        let inp = y.pv_avail + y.wind_avail + y.gen_kwh + y.unmet + y.grid_import + y.grid_to_bess;
        let used = y.load + y.pv_curtailed + y.wind_curtailed + y.gen_dump + y.grid_export + loss + y.self_discharge + d_e;
        (y.year, inp - used, inp)
    }).fold((0, 0.0f64, 0.0), |a, x| if x.1.abs() > a.1.abs() { x } else { a });
    let tol = 1e-6 * worst.2.max(1.0);
    add("balance", format!("Energy balance gap (year {})", worst.0), worst.1, Some(-tol), Some(tol), "kWh",
        "PV, wind, gensets, grid and unserved load should equal the load, curtailment, dump, export and battery losses".into());

    // LCOE: net present cost (capex and the discounted yearly costs) over the discounted energy served to the site, the same as
    // the annualised cost over the annualised energy
    let (ec, e) = (&p.econ, &r.econ);
    let (mut npc, mut disc) = (e.capex_total, 0.0);
    for y in &r.years {
        let df = (1.0 + ec.discount_rate).powf(f64::from(y.year));
        npc += y.c_total / df;
        disc += y.served_site / df;
    }
    if disc > 0.0 && e.lcoe.is_finite() {
        let tol = 1e-6 * e.lcoe.abs() + 1e-12;
        add("lcoe", "LCOE recomputed from the yearly costs".into(), npc / disc, Some(e.lcoe - tol), Some(e.lcoe + tol), "per kWh",
            format!("the capex plus the discounted yearly costs over the discounted energy served should give the LCOE reported ({:.4})", e.lcoe));
    }
    let base = b.base.econ.lcoe;
    if base > 0.0 && e.lcoe > 0.0 {
        add("lcoe_ratio", "LCOE against diesel only".into(), e.lcoe / base, Some(0.1), Some(10.0), "×",
            "a factor of ten either way usually means a cost entered per W instead of per kW, or per MWh instead of per kWh".into());
    }
    // Payback: where the cumulative incremental cash flow against diesel only first turns positive
    let n = r.years.len().min(b.base.years.len());
    let mut cf = vec![-(e.capex_total - b.base.econ.capex_total)];
    cf.extend((0..n).map(|i| b.base.years[i].c_total - r.years[i].c_total));
    let mut cum = cf[0];
    let turn = if cum >= 0.0 { Some(0) } else { (1..cf.len()).find(|&t| { cum += cf[t]; cum >= 0.0 }) };
    let pb = b.cmp.payback_years;
    match turn {
        Some(t) => {
            let lo = t.saturating_sub(1) as f64;
            add("payback", "Payback against diesel only".into(), pb, Some(lo), Some(t as f64), "years",
                format!("the cumulative cash flow against diesel only turns positive in year {t}"));
        }
        None if pb >= 0.0 => add("payback", "Payback against diesel only".into(), pb, None, Some(-1.0), "years",
            "the cumulative cash flow against diesel only never turns positive".into()),
        None => {}
    }

    // Battery: cycles a year against what the power rating allows (discharge at full power every hour), and the round trip
    // the year implies. The warranty cap is the Battery health card's.
    if s.has_bess() {
        let (yr, efc) = r.years.iter().map(|y| (y.year, y.bess_efc)).fold((1, 0.0), |a, x| if x.1 > a.1 { x } else { a });
        let c = s.bess_kw / s.bess_kwh;
        let hi = HOURS as f64 * c;
        add("bess_efc", format!("Battery full cycles (year {yr})"), efc, Some(0.0), Some(hi), "/yr",
            format!("at {c:.2} C the battery cannot discharge more than {hi:.0} times its energy in a year"));
        if y1.bess_ch > 0.0 && y1.bess_dis >= s.bess_kwh {
            // stored-energy change = charged x eta - discharged / eta - self-discharge, solved for the one-way efficiency eta
            let k = y1.e_end - y1.e_start + y1.self_discharge;
            let eta = (k + (k * k + 4.0 * y1.bess_ch * y1.bess_dis).sqrt()) / (2.0 * y1.bess_ch);
            let rte = 100.0 * p.bess.rte;
            add("bess_rte", "Battery round trip implied by year 1".into(), 100.0 * eta * eta, Some(rte - 1.0), Some(rte + 1.0), "%",
                format!("energy charged and discharged in year 1, with the change in stored energy, should give the round trip entered ({rte:.1} %)"));
        }
    }
    v
}

/// The failed checks as the summary's "checks" list
pub fn checks_json(list: &[Check]) -> Value {
    Value::Arr(list.iter().map(|c| obj(vec![
        ("id", c.id.into()), ("label", c.label.clone().into()), ("value", c.value.into()), ("lo", c.lo.into()), ("hi", c.hi.into()),
        ("unit", c.unit.into()), ("why", c.why.clone().into()),
    ])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{Sizing, YearResult};

    // A sound year: 1 MWp PV with 1700 kWh/m2, gensets at 0.28 L/kWh, a 1 MWh / 0.5 MW battery at 88 % round trip
    fn sound() -> (Project, SimResult, SimResult) {
        let p = Project::default();
        let eta = p.bess.rte.sqrt();
        let (ch, e0) = (300_000.0, 500.0);
        let dis = ch * eta * eta;   // no change in stored energy
        let y = YearResult {
            year: 1, load: 2_000_000.0, served: 2_000_000.0, served_site: 2_000_000.0, pv_avail: 1_400_000.0, pv_to_load: 1_000_000.0,
            pv_to_bess: ch, pv_curtailed: 100_000.0, bess_ch: ch, bess_dis: dis, e_start: e0, e_end: e0, gen_kwh: 1_000_000.0 - dis,
            gen_to_load: 1_000_000.0 - dis, fuel_l: 0.28 * (1_000_000.0 - dis), bess_efc: dis / 1000.0, c_total: 100_000.0, ..Default::default()
        };
        let mut y = y;
        y.co2_t = y.fuel_l * p.econ.co2_kg_per_l / 1000.0;
        y.nox_t = y.fuel_l * p.econ.nox_g_per_l / 1e6;
        y.sox_t = y.fuel_l * p.econ.sox_g_per_l / 1e6;
        let mut r = SimResult { size: Sizing { pv_kwp: 1000.0, bess_kwh: 1000.0, bess_kw: 500.0, ..Default::default() }, years: vec![y.clone()], ..Default::default() };
        r.econ.capex_total = 1_000_000.0;
        let df = 1.0 + p.econ.discount_rate;
        r.econ.lcoe = (r.econ.capex_total + y.c_total / df) / (y.served_site / df);
        let mut base = SimResult { years: vec![YearResult { year: 1, c_total: 2_000_000.0, ..Default::default() }], ..Default::default() };
        base.econ.lcoe = r.econ.lcoe * 1.2;
        (p, r, base)
    }

    fn run(p: &Project, r: &SimResult, base: &SimResult, pb: f64) -> Vec<&'static str> {
        let cmp = Comparison { payback_years: pb, ..Default::default() };
        result_checks(p, r, &CheckBasis { base, cmp: &cmp, poa_kwh_m2: 1700.0, rear_kwh_m2: 0.0 }).iter().map(|c| c.id).collect()
    }

    #[test]
    fn a_sound_result_raises_nothing() {
        let (p, r, b) = sound();
        assert_eq!(run(&p, &r, &b, 1.0), Vec::<&str>::new());
    }

    #[test]
    fn each_check_fires_on_a_bad_result() {
        let (p, r, b) = sound();
        let bad = |f: &dyn Fn(&mut Project, &mut SimResult)| { let (mut q, mut s) = (p.clone(), r.clone()); f(&mut q, &mut s); run(&q, &s, &b, 1.0) };
        // PV yield above the irradiation, and a capacity factor no site gives
        assert!(bad(&|_, s| s.years[0].pv_avail = 1_700_000.0 * 1.2).contains(&"pv_pr"));
        assert!(bad(&|_, s| s.years[0].pv_avail = 600_000.0).contains(&"pv_pr"));
        assert!(bad(&|_, s| s.years[0].pv_avail = 4_000_000.0).contains(&"pv_cf"));
        assert!(bad(&|q, s| { q.wind.rated_kw = 100.0; s.size.wind_units = 1.0; s.years[0].wind_avail = 700_000.0; }).contains(&"wind_cf"));
        assert!(bad(&|_, s| s.years[0].fuel_l *= 3.0).contains(&"gen_sfc"));
        assert!(bad(&|_, s| s.years[0].co2_t *= 10.0).contains(&"co2_per_l"));
        assert!(bad(&|_, s| s.years[0].nox_t *= 1.1).contains(&"nox_per_l"));
        assert!(bad(&|_, s| s.years[0].pm25_t = 1.0).contains(&"pm25_per_l"));
        assert!(bad(&|_, s| s.years[0].unmet = 1000.0).contains(&"balance"));
        assert!(bad(&|_, s| s.econ.lcoe *= 1.5).contains(&"lcoe"));
        assert!(bad(&|_, s| s.years[0].bess_efc = 5000.0).contains(&"bess_efc"));
        assert!(bad(&|_, s| { s.years[0].bess_dis *= 0.9; s.years[0].gen_kwh += 0.1 * s.years[0].bess_dis / 0.9; }).contains(&"bess_rte"));
        // payback: reported 5 years where the cash flow turns positive in year 1, or never
        assert_eq!(run(&p, &r, &b, 5.0), vec!["payback"]);
        let mut nb = b.clone();
        nb.years[0].c_total = 0.0;
        assert_eq!(run(&p, &r, &nb, 5.0), vec!["payback"]);
        assert!(run(&p, &r, &nb, -1.0).is_empty());
        // LCOE ten times diesel only
        let mut cheap = b.clone();
        cheap.econ.lcoe = r.econ.lcoe / 20.0;
        assert_eq!(run(&p, &r, &cheap, 1.0), vec!["lcoe_ratio"]);
    }

    #[test]
    fn bifacial_gain_widens_the_pv_range() {
        let (p, mut r, b) = sound();
        r.years[0].pv_avail = 1_700_000.0;   // PR 1.0, the extra curtailed
        r.years[0].pv_curtailed += 300_000.0;
        let cmp = Comparison { payback_years: 1.0, ..Default::default() };
        let ids = |rear| result_checks(&p, &r, &CheckBasis { base: &b, cmp: &cmp, poa_kwh_m2: 1700.0, rear_kwh_m2: rear }).iter().map(|c| c.id).collect::<Vec<_>>();
        assert_eq!(ids(0.0), vec!["pv_pr"]);
        assert!(ids(170.0).is_empty());
        let j = checks_json(&result_checks(&p, &r, &CheckBasis { base: &b, cmp: &cmp, poa_kwh_m2: 1700.0, rear_kwh_m2: 0.0 }));
        assert_eq!(j.idx(0).at("unit").str(), "%");
        assert!((j.idx(0).get("value", 0.0) - 100.0).abs() < 1e-9);
        assert_eq!(j.idx(0).get("hi", 0.0), 95.0);
    }
}
