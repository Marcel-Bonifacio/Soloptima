//! Forecast Lab (forecast_benchmark in src/ems.cpp): error statistics of every PV and load forecasting method for leads 1-48 h, display
//! series, and optionally the year-1 fuel and cost of each method driving the predictive EMS.
use super::par_map;
use crate::forecast::{load_forecast_methods, pv_forecast_methods, MethodInfo, SeriesForecaster};
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use crate::sim::{mx, simulate, SimInput, Sizing};
use crate::json::obj;
use crate::{Error, Project, Value, HOURS};

const MAXL: usize = 48;

/// Weather classes of the days: clear (daily clear-sky index above the upper threshold), cloudy, overcast (below the lower one)
pub const WEATHER_CLASSES: [(&str, &str); 3] = [("clear", "Clear"), ("cloudy", "Cloudy"), ("overcast", "Overcast")];
pub const CLASS_THRESHOLDS: [f64; 2] = [0.3, 0.7];

/// The weather class (index in WEATHER_CLASSES) of each day of the local year by its daily clear-sky index, the PV energy of
/// the day over its clear-sky PV energy; None for a day without clear-sky output (polar night)
pub fn day_classes(act: &[f64], cs: &[f64]) -> Vec<Option<usize>> {
    (0..HOURS / 24).map(|d| {
        let (a, c) = (act[d * 24..d * 24 + 24].iter().sum::<f64>(), cs[d * 24..d * 24 + 24].iter().sum::<f64>());
        if c.is_nan() || c <= 0.0 { return None; }
        let kc = a / c;
        Some(if kc > CLASS_THRESHOLDS[1] { 0 } else if kc < CLASS_THRESHOLDS[0] { 2 } else { 1 })
    }).collect()
}

/// One method's errors by weather class and lead: summed absolute and squared errors, turned into nMAE and nRMSE once the
/// year's mean is known; and the hours of each class
#[derive(Clone)]
struct ClassSums { n: [f64; 3], ae: Vec<[f64; MAXL]>, se: Vec<[f64; MAXL]> }

/// One method's statistics as JSON, and its normalised RMSE per lead (for the skill score); with day classes also its errors
/// by class, normalised by the same mean as the whole year
fn evaluate(mi: &MethodInfo, act: &[f64], cs: &[f64], sigma: f64, kwp: f64, days: &[Option<usize>]) -> (Value, Vec<f64>, Option<ClassSums>) {
    let is_pv = !cs.is_empty();
    let f = SeriesForecaster::new(mi.id, act, cs, sigma, if is_pv { 12345 } else { 67890 });
    let (mut ae, mut se, mut be) = (vec![0.0; MAXL], vec![0.0; MAXL], vec![0.0; MAXL]);
    let (mut n, mut mean) = (0.0, 0.0);
    let mut cl = (!days.is_empty()).then(|| ClassSums { n: [0.0; 3], ae: vec![[0.0; MAXL]; 3], se: vec![[0.0; MAXL]; 3] });
    for t in 0..HOURS {
        if is_pv && act[t] <= 0.0 && cs[t] <= 0.0 { continue; }   // PV skill is judged on daylight hours only
        n += 1.0;
        mean += act[t];
        let c = days.get(t / 24).copied().flatten();
        for l in 1..=MAXL {
            let e = f.at(t as i32 - l as i32 + 1, t as i32) - act[t];
            ae[l - 1] += e.abs();
            se[l - 1] += e * e;
            be[l - 1] += e;
            if let (Some(s), Some(c)) = (cl.as_mut(), c) { s.ae[c][l - 1] += e.abs(); s.se[c][l - 1] += e * e; }
        }
        if let (Some(s), Some(c)) = (cl.as_mut(), c) { s.n[c] += 1.0; }
    }
    mean = if n > 0.0 { mean / n } else { 1.0 };
    if let Some(s) = cl.as_mut() {   // normalised as the whole year: sums over n_c, divided by the year's mean
        for c in 0..3 {
            let k = if s.n[c] > 0.0 { s.n[c] } else { 1.0 };
            for l in 0..MAXL { s.ae[c][l] = s.ae[c][l] / k / mean; s.se[c][l] = (s.se[c][l] / k).sqrt() / mean; }
        }
    }
    let nrmse: Vec<f64> = se.iter().map(|&x| (x / n).sqrt() / mean).collect();
    // Display series: hour-ahead, and day-ahead issued at 12:00 the day before (market-style gate closure).
    let sc = if is_pv { kwp } else { 1.0 };
    let h1: Vec<f64> = (0..HOURS as i32).map(|t| f.at(t, t) * sc).collect();
    let da: Vec<f64> = (0..HOURS as i32).map(|t| f.at((t / 24) * 24 - 12, t) * sc).collect();
    let o = obj(vec![
        ("id", mi.id.into()), ("name", mi.name.into()), ("description", mi.description.into()),
        ("nmae", ae.iter().map(|&x| x / n / mean).collect::<Vec<f64>>().into()), ("nrmse", nrmse.clone().into()),
        ("bias", be.iter().map(|&x| x / n / mean).collect::<Vec<f64>>().into()), ("h1", h1.into()), ("da", da.into()),
    ]);
    (o, nrmse, cl)
}

/// Skill against persistence at each lead: 1 less the method's error over persistence's (0 where that is 0 or there is none)
fn skill(err: &[f64], per: Option<&[f64]>) -> Vec<f64> {
    (0..MAXL).map(|l| { let rp = per.map_or(0.0, |p| p[l]); if rp > 0.0 { 1.0 - err[l] / rp } else { 0.0 } }).collect()
}

/// The benchmark (below) without the errors by weather class
pub fn forecast_benchmark(p: &Project, with_value: bool) -> Result<Value, Error> { forecast_benchmark_with(p, with_value, false) }

/// Errors of every method by weather class: per class its days, and for PV and load the hours counted and each method's nMAE,
/// nRMSE (normalised by the mean of the whole year, so the classes add up) and skill against persistence in that class
fn class_json(days: &[Option<usize>], blocks: &[(&str, &[MethodInfo], Vec<ClassSums>)]) -> Value {
    let mut classes = Vec::new();
    for (c, (id, name)) in WEATHER_CLASSES.iter().enumerate() {
        let mut o = obj(vec![("id", (*id).into()), ("name", (*name).into()), ("days", days.iter().filter(|&&d| d == Some(c)).count().into())]);
        for (var, list, sums) in blocks {
            let per = list.iter().rposition(|m| m.id == "persistence");
            let methods: Vec<Value> = list.iter().zip(sums).map(|(m, s)| {
                let sk = skill(&s.se[c], per.map(|k| &sums[k].se[c][..]));
                obj(vec![("id", m.id.into()), ("nmae", s.ae[c].to_vec().into()), ("nrmse", s.se[c].to_vec().into()), ("skill", sk.into())])
            }).collect();
            o.set(var, obj(vec![("hours", sums.first().map_or(0.0, |s| s.n[c]).into()), ("methods", Value::Arr(methods))]));
        }
        classes.push(o);
    }
    obj(vec![("thresholds", CLASS_THRESHOLDS.to_vec().into()), ("classes", Value::Arr(classes))])
}

/// by_class: also `weather_classes`, the errors on clear, cloudy and overcast days (`class_json`)
pub fn forecast_benchmark_with(p: &Project, with_value: bool, by_class: bool) -> Result<Value, Error> {
    let prof = compute_pv_profile(p)?;
    let cs = clearsky_pv_per_kwp(p)?;
    let kwp = mx(1.0, p.pv.capacity_kwp);
    let mut out = Value::object();
    let days = if by_class { day_classes(&prof.ac_per_kwp, &cs) } else { Vec::new() };
    let mut blocks = Vec::new();
    for is_pv in [true, false] {
        let list = if is_pv { pv_forecast_methods() } else { load_forecast_methods() };
        let act = if is_pv { &prof.ac_per_kwp } else { &p.load_kw };
        let refv: &[f64] = if is_pv { &cs } else { &[] };
        let res = par_map(list.len(), list.len(), |i| Ok(evaluate(&list[i], act, refv, p.ems.noise_sigma, kwp, &days)))?;
        if by_class { blocks.push((if is_pv { "pv" } else { "load" }, list, res.iter().filter_map(|r| r.2.clone()).collect::<Vec<_>>())); }
        // skill score vs persistence RMSE at each lead
        let per = res.iter().rposition(|r| r.0.at("id").str() == "persistence");
        let mut arr = Vec::with_capacity(res.len());
        for (mut o, nrmse, _) in res.iter().cloned() {
            o.set("skill", skill(&nrmse, per.map(|k| &res[k].1[..])));
            arr.push(o);
        }
        let actual: Vec<f64> = if is_pv { prof.ac_per_kwp.iter().map(|&v| v * kwp).collect() } else { p.load_kw.clone() };
        out.set(if is_pv { "pv" } else { "load" }, obj(vec![("methods", Value::Arr(arr)), ("actual", actual.into())]));
    }
    if by_class { out.set("weather_classes", class_json(&days, &blocks)); }

    if with_value {
        // Value of forecasting: year-1 predictive-EMS results with each PV method (load method fixed) and each load method
        // (PV method fixed), against load following.
        let mut base = p.clone();
        base.sim.all_years = false;
        let s = Sizing::of(p);
        let wind = if s.wind_units > 0.5 { wind_per_turbine(p)? } else { Vec::new() };
        let mut jobs: Vec<(&str, &str, &str, Project)> = Vec::new();
        let mut q = base.clone();
        q.dg.strategy = "load_following".into();
        jobs.push(("reference", "load_following", "Load following (no forecast)", q));
        for mi in pv_forecast_methods() {
            let mut q = base.clone();
            q.dg.strategy = "predictive".into();
            q.ems.pv_forecast = mi.id.into();
            jobs.push(("pv", mi.id, mi.name, q));
        }
        for mi in load_forecast_methods() {
            let mut q = base.clone();
            q.dg.strategy = "predictive".into();
            q.ems.load_forecast = mi.id.into();
            jobs.push(("load", mi.id, mi.name, q));
        }
        let threads = std::thread::available_parallelism().map_or(1, |x| x.get());
        let v = par_map(jobs.len(), threads, |i| {
            let (kind, id, name, q) = &jobs[i];
            let inp = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
            let r = simulate(q, &inp, &s, false)?;
            let y = &r.years[0];
            Ok(obj(vec![
                ("kind", (*kind).into()), ("id", (*id).into()), ("name", (*name).into()), ("fuel_l", y.fuel_l.into()),
                ("unit_hours", y.unit_hours.into()), ("starts", y.starts.into()), ("unmet", y.unmet.into()),
                ("curtailed", y.pv_curtailed.into()), ("re", y.re_fraction.into()), ("bess_efc", y.bess_efc.into()), ("npc", r.econ.npc.into()),
            ]))
        })?;
        out.set("value", v);
        out.set("value_note", if p.bess.energy_kwh > 0.0 { "" } else { "No battery in the project: the EMS has nothing to schedule, so all methods give the same result." });
    }
    Ok(out)
}
