//! Figures the interface shows from a simulation, computed here so each number has one home and one set of tests: the monthly
//! energy balance of year 1, the year-1 energy flow and the battery health over the project life ("summary" of a simulation).
use super::{Hourly, SimResult, YearResult};
use crate::json::obj;
use crate::model::{BessParams, HOURS, MONTH_START};
use crate::Value;

/// The state of health at which the battery is replaced: the replacement threshold, or the end of life when that is negative
pub fn replace_soh(bp: &BessParams) -> f64 { if bp.replace_soh >= 0.0 { bp.replace_soh } else { bp.eol_soh } }

fn num(x: Option<f64>) -> Value { x.map_or(Value::Null, Value::Num) }

/// {"monthly", "flow", "bess_health"} of a simulation; "monthly" only when the hourly series were kept
pub fn summary_json(bp: &BessParams, r: &SimResult) -> Value {
    let mut o = Value::object();
    if let Some(h) = &r.hourly { o.set("monthly", monthly(h)); }
    if let Some(y1) = r.years.first() { o.set("flow", flow(y1)); }
    if !r.years.is_empty() { o.set("bess_health", bess_health(bp, &r.years)); }
    o
}

/// Year 1 by month and for the year (13 rows): load = PV + wind + battery + diesel to the load + unmet, in kWh (fuel in L); the
/// RE fraction is the share of the served load not met by the gensets, as for the year (dispatch.rs).
fn monthly(h: &Hourly) -> Value {
    let month = |a: &[f64], m: usize| -> f64 {
        let (s, e) = (MONTH_START[m] as usize * 24, MONTH_START.get(m + 1).map_or(HOURS, |&d| d as usize * 24));
        a.get(s..e.min(a.len())).map_or(0.0, |x| x.iter().sum())
    };
    let both = |a: &[f64], b: &[f64]| -> Vec<f64> { (0..a.len().max(b.len())).map(|i| a.get(i).unwrap_or(&0.0) + b.get(i).unwrap_or(&0.0)).collect() };
    let curt = both(&h.pv_curtailed, &h.wind_curtailed);
    let cols: [(&str, &[f64]); 10] = [
        ("load", &h.load), ("pv", &h.pv_to_load), ("wind", &h.wind_to_load), ("bess", &h.bess_dis), ("gen", &h.gen_to_load),
        ("gch", &h.gen_to_bess), ("unmet", &h.unmet), ("curt", &curt), ("dump", &h.gen_dump), ("fuel", &h.fuel_l),
    ];
    let rows: Vec<[f64; 10]> = (0..12).map(|m| cols.map(|(_, a)| month(a, m))).collect();
    let year = (0..10).fold([0.0; 10], |mut t, k| { t[k] = rows.iter().map(|r| r[k]).sum(); t });
    let row = |x: &[f64; 10]| {
        let served = x[0] - x[6];
        let re = if served > 0.0 { (1.0 - (x[4] + x[5]) / served).clamp(0.0, 1.0) } else { 0.0 };
        let mut v = obj(cols.iter().zip(x).map(|((k, _), &n)| (*k, n.into())).collect());
        v.set("re", re);
        v
    };
    Value::Arr(rows.iter().chain(std::iter::once(&year)).map(row).collect())
}

/// Year-1 energy flow. Battery losses close the battery's own balance: charged - discharged - self-discharge - change in stored
/// energy. inp and out are the two sides of the plant's balance; gap is what is left (should be ~0).
fn flow(y: &YearResult) -> Value {
    let d_e = y.e_end - y.e_start;
    let loss = y.bess_ch - y.bess_dis - y.self_discharge - d_e;
    let thru = y.bess_ch + y.bess_dis;
    let re_used = y.pv_to_load + y.pv_to_bess + y.wind_to_load + y.wind_to_bess;
    let inp = y.pv_avail + y.wind_avail + y.gen_kwh + y.unmet - d_e.min(0.0);
    let out = y.load + y.pv_curtailed + y.wind_curtailed + y.gen_dump + loss + y.self_discharge + d_e.max(0.0);
    obj(vec![
        ("d_e", d_e.into()), ("loss", loss.into()), ("aux", y.aux.into()), ("thru", thru.into()), ("show_de", (d_e.abs() > 1e-3 * thru).into()),
        ("inp", inp.into()), ("out", out.into()), ("gap", (inp - out).into()),
        ("direct", num((re_used > 0.0).then(|| (y.pv_to_load + y.wind_to_load) / re_used))),
    ])
}

/// Battery health over the project life: replacement threshold, year-1 fade and the expected life at that fade, the share of it
/// from cycling, replacement years, SOH at the end and the years over the warranty cycle cap.
fn bess_health(bp: &BessParams, ys: &[YearResult]) -> Value {
    let (y1, last) = (&ys[0], &ys[ys.len() - 1]);
    let thr = replace_soh(bp);
    let fade = y1.soh_loss_cal + y1.soh_loss_cyc;
    let cap = bp.warranty_efc_yr;
    let max = |f: fn(&YearResult) -> f64| ys.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
    let years = |keep: &dyn Fn(&YearResult) -> bool| Value::from(ys.iter().filter(|y| keep(y)).map(|y| f64::from(y.year)).collect::<Vec<_>>());
    obj(vec![
        ("thr", thr.into()), ("fade", fade.into()), ("cap", cap.into()),
        ("max_efc", max(|y| y.bess_efc).into()), ("max_efc_dc", max(|y| y.bess_efc_dc).into()), ("max_c", max(|y| y.max_c_rate).into()),
        ("life", num((fade > 0.0).then(|| (1.0 - thr) / fade))),
        ("cyc_share", (if fade > 0.0 { y1.soh_loss_cyc / fade } else { 0.0 }).into()),
        ("repl", years(&|y| y.bess_replaced)),
        ("soh_end", (last.bess_soh - last.soh_loss_cal - last.soh_loss_cyc).into()),
        ("over", if cap > 0.0 { years(&|y| y.bess_efc > cap) } else { Value::from(Vec::<f64>::new()) }),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn year(n: i32) -> YearResult {
        YearResult {
            year: n, soh_loss_cal: 0.02, soh_loss_cyc: 0.03, bess_soh: 1.0 - 0.05 * f64::from(n - 1), bess_efc: 200.0 + f64::from(n),
            bess_efc_dc: 210.0, max_c_rate: 0.4 + 0.1 * f64::from(n), bess_replaced: n == 2, ..Default::default()
        }
    }

    #[test]
    fn battery_health_over_the_life() {
        let bp = BessParams { replace_soh: -1.0, eol_soh: 0.7, warranty_efc_yr: 202.0, ..Default::default() };
        let h = bess_health(&bp, &[year(1), year(2), year(3)]);
        assert_eq!(h.get("thr", 0.0), 0.7);
        assert!((h.get("life", 0.0) - 6.0).abs() < 1e-9);
        assert!((h.get("cyc_share", 0.0) - 0.6).abs() < 1e-9);
        assert_eq!(h.at("repl").dump(), "[2]");
        assert_eq!(h.at("over").dump(), "[3]");
        assert_eq!(h.get("max_efc", 0.0), 203.0);
        assert_eq!(replace_soh(&BessParams { replace_soh: 0.6, eol_soh: 0.7, ..Default::default() }), 0.6);
    }

    #[test]
    fn monthly_balance_adds_up_to_the_year() {
        let mut h = Hourly::default();
        h.load = vec![10.0; HOURS];
        h.pv_to_load = vec![6.0; HOURS];
        h.gen_to_load = vec![4.0; HOURS];
        let m = monthly(&h);
        let Value::Arr(rows) = &m else { panic!("rows") };
        assert_eq!(rows.len(), 13);
        assert_eq!(rows[0].get("load", 0.0), 31.0 * 24.0 * 10.0);
        assert_eq!(rows[12].get("load", 0.0), 87_600.0);
        assert!((rows[12].get("re", 0.0) - 0.6).abs() < 1e-12);
        assert_eq!(rows[1].get("wind", -1.0), 0.0);
    }

    #[test]
    fn energy_flow_balances() {
        let y = YearResult { pv_avail: 100.0, pv_to_load: 60.0, pv_to_bess: 30.0, pv_curtailed: 10.0, bess_ch: 30.0, bess_dis: 25.0,
            self_discharge: 1.0, e_start: 5.0, e_end: 7.0, load: 85.0, ..Default::default() };
        let f = flow(&y);
        assert_eq!(f.get("loss", 0.0), 2.0);
        assert!((f.get("direct", 0.0) - 60.0 / 90.0).abs() < 1e-12);
        assert!(f.get("gap", 1.0).abs() < 1e-9);
    }
}
