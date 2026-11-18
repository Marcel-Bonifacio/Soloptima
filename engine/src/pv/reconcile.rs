//! Metered PV output against the model: hourly and monthly comparison, MBE, RMSE and R², hours the meter shows nothing in good
//! sun counted as outages, and the soiling and availability that bring the model closest to the meter. Nothing here changes the
//! project; the interface offers the fitted values to apply.
use super::compute_pv_profile;
use crate::json::{fail, Error, Value};
use crate::model::{month_of_day, Project, HOURS};
use crate::series::fmt_hour;

/// GHI (W/m², local hour) from which a meter at zero counts as an outage
pub const OUTAGE_GHI: f64 = 200.0;
/// a meter at or below this share of the model in such an hour reads as zero
pub const OUTAGE_SHARE: f64 = 0.01;
/// the fitted soiling stays within 0 and this
pub const SOILING_MAX: f64 = 0.30;
/// running daylight hours a month needs for a soiling of its own
pub const MONTH_MIN_H: usize = 30;
const MIN_H: usize = 24;

/// The model's hourly AC output and what the fit needs of the project
pub struct ModelBasis<'a> {
    /// kW AC, 8760 local standard hours
    pub kw: &'a [f64],
    /// GHI, W/m², the same hours
    pub ghi: &'a [f64],
    /// the project's soiling of each month and its availability
    pub soiling: [f64; 12],
    pub availability: f64,
    pub kwp: f64,
}

/// Hourly statistics of the model against the meter over a set of hours
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub hours: usize,
    pub meter_kwh: f64,
    pub model_kwh: f64,
    /// mean of model - meter (kW) and as a share of the mean metered output
    pub mbe_kw: f64,
    pub mbe: f64,
    pub rmse_kw: f64,
    pub nrmse: f64,
    /// 1 - sum (model - meter)² / sum (meter - mean)²
    pub r2: f64,
}

fn stats(hours: &[usize], model: impl Fn(usize) -> f64, meter: &[f64]) -> Stats {
    let n = hours.len();
    let mut s = Stats { hours: n, ..Default::default() };
    if n == 0 { return s; }
    let (mut se, mut sse) = (0.0, 0.0);
    for &i in hours {
        let (m, x) = (model(i), meter[i]);
        s.model_kwh += m;
        s.meter_kwh += x;
        se += m - x;
        sse += (m - x) * (m - x);
    }
    let mean = s.meter_kwh / n as f64;
    let sst: f64 = hours.iter().map(|&i| (meter[i] - mean) * (meter[i] - mean)).sum();
    s.mbe_kw = se / n as f64;
    s.rmse_kw = (sse / n as f64).sqrt();
    if mean > 0.0 { s.mbe = s.mbe_kw / mean; s.nrmse = s.rmse_kw / mean; }
    s.r2 = if sst > 0.0 { 1.0 - sse / sst } else if sse == 0.0 { 1.0 } else { 0.0 };
    s
}

fn stats_json(s: &Stats) -> Value {
    let mut o = Value::object();
    o.set("hours", s.hours);
    o.set("meter_kwh", s.meter_kwh);
    o.set("model_kwh", s.model_kwh);
    o.set("mbe_kw", s.mbe_kw);
    o.set("mbe", s.mbe);
    o.set("rmse_kw", s.rmse_kw);
    o.set("nrmse", s.nrmse);
    o.set("r2", s.r2);
    o
}

/// Least-squares factor k of meter ≈ k × x over the hours
fn ls_factor(hours: &[usize], x: &[f64], meter: &[f64]) -> Option<f64> {
    let (mut xy, mut xx) = (0.0, 0.0);
    for &i in hours { xy += x[i] * meter[i]; xx += x[i] * x[i]; }
    (xx > 0.0).then(|| xy / xx)
}

fn month_of(i: usize) -> usize { month_of_day((i / 24) as i32) as usize }

/// The meter (kW, NaN for hours without data) against the model. Hours present in both with output in either are compared; an hour
/// with GHI of at least 200 W/m² and the meter at or below 1 % of the model is a probable outage, left out of the soiling fit and of
/// the running-hours statistics.
///
/// Fit: the model is taken back to a clean, always available plant (÷ (1 - soiling) ÷ availability of the project, month by month).
/// The soiling is 1 - k, k the least-squares factor of the meter on that clean model over the running hours, within 0 and 30 %; the
/// availability is 1 - the share of the clean model's energy in the outage hours. Applied together, the model's energy over the
/// hours compared matches the meter's. A month with at least 30 running hours gets a soiling of its own, the others the constant.
pub fn reconcile(b: &ModelBasis, meter: &[f64]) -> Result<Value, Error> {
    if b.kw.len() != HOURS || b.ghi.len() != HOURS || meter.len() != HOURS { return fail("The model and the meter need 8760 hourly values."); }
    let keep = |m: usize| (1.0 - b.soiling[m]) * b.availability;
    if !(0..12).all(|m| keep(m) > 0.0) { return fail("The project's soiling and availability leave no PV output to compare."); }
    let present: Vec<usize> = (0..HOURS).filter(|&i| !meter[i].is_nan()).collect();
    let day: Vec<usize> = present.iter().copied().filter(|&i| b.kw[i] > 0.0 || meter[i] > 0.0).collect();
    let is_out = |i: usize| b.ghi[i] >= OUTAGE_GHI && b.kw[i] > 0.0 && meter[i] <= OUTAGE_SHARE * b.kw[i];
    let outages: Vec<usize> = day.iter().copied().filter(|&i| is_out(i)).collect();
    let run: Vec<usize> = day.iter().copied().filter(|&i| !is_out(i)).collect();
    if run.len() < MIN_H {
        return fail(format!("Only {} daylight hours with the plant running are in both the file and the model: at least {MIN_H} are needed.", run.len()));
    }
    let clean: Vec<f64> = (0..HOURS).map(|i| b.kw[i] / keep(month_of(i))).collect();
    let Some(k) = ls_factor(&run, &clean, meter) else { return fail("The model gives no PV output in the hours of the file."); };
    let raw = 1.0 - k;
    let soiling = raw.clamp(0.0, SOILING_MAX);
    let e_day: f64 = day.iter().map(|&i| clean[i]).sum();
    let e_out: f64 = outages.iter().map(|&i| clean[i]).sum();
    let availability = if e_day > 0.0 { 1.0 - e_out / e_day } else { 1.0 };
    // hours by month, in order
    let by_month = |hs: &[usize]| { let mut m: [Vec<usize>; 12] = Default::default(); for &i in hs { m[month_of(i)].push(i); } m };
    let mut s_month = [soiling; 12];
    let mut own = [false; 12];
    for (m, h) in by_month(&run).iter().enumerate() {
        if h.len() < MONTH_MIN_H { continue; }
        if let Some(km) = ls_factor(h, &clean, meter) { s_month[m] = (1.0 - km).clamp(0.0, SOILING_MAX); own[m] = true; }
    }
    let fit = |i: usize| clean[i] * (1.0 - soiling) * availability;
    let fit_m = |i: usize| clean[i] * (1.0 - s_month[month_of(i)]) * availability;
    let model = |i: usize| b.kw[i];
    let (before, after, after_m) = (stats(&day, model, meter), stats(&day, fit, meter), stats(&day, fit_m, meter));

    let mut o = Value::object();
    o.set("hours", present.len());
    o.set("daylight_h", day.len());
    o.set("running_h", run.len());
    o.set("outage_h", outages.len());
    o.set("outages", outages.iter().take(20).map(|&i| Value::from(fmt_hour(i))).collect::<Vec<_>>());
    let mut st = Value::object();
    st.set("running", stats_json(&stats(&run, model, meter)));
    st.set("all", stats_json(&before));
    o.set("stats", st);
    let mut months = Value::array();
    for (h, out_h) in by_month(&present).iter().zip(by_month(&outages)) {
        let sum = |f: &dyn Fn(usize) -> f64| h.iter().map(|&i| f(i)).sum::<f64>();
        let (x, y) = (sum(&|i| meter[i]), sum(&model));
        let mut r = Value::object();
        r.set("hours", h.len());
        r.set("outage_h", out_h.len());
        r.set("meter_kwh", x);
        r.set("model_kwh", y);
        r.set("fit_kwh", sum(&fit));
        r.set("fit_monthly_kwh", sum(&fit_m));
        r.set("dev", if x > 0.0 { Value::from(y / x - 1.0) } else { Value::Null });
        months.push(r);
    }
    o.set("monthly", months);
    let mut f = Value::object();
    f.set("soiling", soiling);
    f.set("soiling_raw", raw);
    f.set("at_bound", soiling != raw);
    f.set("soiling_monthly", s_month.to_vec());
    f.set("own_month", own.iter().map(|&x| Value::from(x)).collect::<Vec<_>>());
    f.set("availability", availability);
    f.set("after", stats_json(&after));
    f.set("after_monthly", stats_json(&after_m));
    let gain = |a: &Stats| if before.rmse_kw > 0.0 { 1.0 - a.rmse_kw / before.rmse_kw } else { 0.0 };
    f.set("rmse_gain", gain(&after));
    f.set("rmse_gain_monthly", gain(&after_m));
    o.set("fit", f);
    let mut notes = Value::array();
    let peak = present.iter().map(|&i| meter[i]).fold(0.0f64, f64::max);
    if peak > 1.3 * b.kwp { notes.push(format!("The metered peak, {peak:.0} kW, is above 1.3 times the PV capacity ({:.0} kWp): check the unit of the file.", b.kwp)); }
    if before.meter_kwh < 0.5 * before.model_kwh {
        notes.push("The meter shows less than half the modelled energy: check that it measures the whole array and that the unit is right.");
    }
    if soiling != raw {
        notes.push(if raw < 0.0 { "The plant gives more than the model even without soiling: the fit stops at 0 %. Check the weather and the capacity." }
                   else { "The fit stops at 30 % soiling: a gap this large is more likely a meter, capacity or weather problem than dirt." });
    }
    if own.iter().filter(|&&x| x).count() < 3 { notes.push("Less than three months of data: the fitted soiling holds for that season only."); }
    o.set("notes", notes);
    Ok(o)
}

/// The meter of the request ({kw: 8760 values, null where there is no data}) against the project's PV model
pub fn pv_reconcile(p: &Project, m: &Value) -> Result<Value, Error> {
    let a = m.at("kw").arr();
    if a.len() != HOURS { return fail("The metered PV output must have 8760 hourly values (null for hours without data)."); }
    let kwp = p.pv.capacity_kwp;
    if kwp.is_nan() || kwp <= 0.0 { return fail("Set the PV capacity first."); }
    let mut meter = vec![f64::NAN; HOURS];
    for (i, x) in a.iter().enumerate() {
        let v = match x {
            Value::Null => continue,
            Value::Num(v) => *v,
            _ => return fail(format!("The metered PV output at {} is not a number.", fmt_hour(i))),
        };
        if !v.is_finite() { return fail(format!("The metered PV output at {} is not a finite number.", fmt_hour(i))); }
        if v < 0.0 { return fail(format!("The metered PV output is negative at {}.", fmt_hour(i))); }
        if v > 10.0 * kwp { return fail(format!("The metered PV output at {} is over ten times the PV capacity: check the unit.", fmt_hour(i))); }
        meter[i] = v;
    }
    let pv = &p.pv;
    if !(pv.availability > 0.0 && pv.availability <= 1.0) { return fail("PV availability must be above 0 % and at most 100 %."); }
    let prof = compute_pv_profile(p)?;
    let kw: Vec<f64> = prof.ac_per_kwp.iter().map(|x| x * kwp).collect();
    let soiling: [f64; 12] = std::array::from_fn(|m| if pv.soiling_monthly.len() == 12 { pv.soiling_monthly[m] } else { pv.soiling });
    let mut o = reconcile(&ModelBasis { kw: &kw, ghi: &prof.ghi_local, soiling, availability: pv.availability, kwp }, &meter)?;
    let mut prj = Value::object();
    prj.set("soiling", pv.soiling);
    prj.set("soiling_monthly", if pv.soiling_monthly.len() == 12 { Value::from(pv.soiling_monthly.clone()) } else { Value::Null });
    prj.set("availability", pv.availability);
    o.set("project", prj);
    Ok(o)
}
