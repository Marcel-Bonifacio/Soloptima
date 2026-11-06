//! Forecast Lab (forecast_benchmark in src/ems.cpp): error statistics of every PV and load forecasting method for leads 1-48 h, display
//! series, and optionally the year-1 fuel and cost of each method driving the predictive EMS.
use super::par_map;
use crate::forecast::{load_forecast_methods, pv_forecast_methods, MethodInfo, SeriesForecaster};
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use crate::sim::{mx, simulate, SimInput, Sizing};
use crate::json::obj;
use crate::{Error, Project, Value, HOURS};

const MAXL: usize = 48;

/// One method's statistics as JSON, and its normalised RMSE per lead (for the skill score)
fn evaluate(mi: &MethodInfo, act: &[f64], cs: &[f64], sigma: f64, kwp: f64) -> (Value, Vec<f64>) {
    let is_pv = !cs.is_empty();
    let f = SeriesForecaster::new(mi.id, act, cs, sigma, if is_pv { 12345 } else { 67890 });
    let (mut ae, mut se, mut be) = (vec![0.0; MAXL], vec![0.0; MAXL], vec![0.0; MAXL]);
    let (mut n, mut mean) = (0.0, 0.0);
    for t in 0..HOURS {
        if is_pv && act[t] <= 0.0 && cs[t] <= 0.0 { continue; }   // PV skill is judged on daylight hours only
        n += 1.0;
        mean += act[t];
        for l in 1..=MAXL {
            let e = f.at(t as i32 - l as i32 + 1, t as i32) - act[t];
            ae[l - 1] += e.abs();
            se[l - 1] += e * e;
            be[l - 1] += e;
        }
    }
    mean = if n > 0.0 { mean / n } else { 1.0 };
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
    (o, nrmse)
}

pub fn forecast_benchmark(p: &Project, with_value: bool) -> Result<Value, Error> {
    let prof = compute_pv_profile(p)?;
    let cs = clearsky_pv_per_kwp(p)?;
    let kwp = mx(1.0, p.pv.capacity_kwp);
    let mut out = Value::object();
    for is_pv in [true, false] {
        let list = if is_pv { pv_forecast_methods() } else { load_forecast_methods() };
        let act = if is_pv { &prof.ac_per_kwp } else { &p.load_kw };
        let refv: &[f64] = if is_pv { &cs } else { &[] };
        let res = par_map(list.len(), list.len(), |i| Ok(evaluate(&list[i], act, refv, p.ems.noise_sigma, kwp)))?;
        // skill score vs persistence RMSE at each lead
        let per = res.iter().rposition(|r| r.0.at("id").str() == "persistence");
        let mut arr = Vec::with_capacity(res.len());
        for (mut o, nrmse) in res.iter().cloned() {
            let sk: Vec<f64> = (0..MAXL).map(|l| {
                let rp = per.map_or(0.0, |k| res[k].1[l]);
                if rp > 0.0 { 1.0 - nrmse[l] / rp } else { 0.0 }
            }).collect();
            o.set("skill", sk);
            arr.push(o);
        }
        let actual: Vec<f64> = if is_pv { prof.ac_per_kwp.iter().map(|&v| v * kwp).collect() } else { p.load_kw.clone() };
        out.set(if is_pv { "pv" } else { "load" }, obj(vec![("methods", Value::Arr(arr)), ("actual", actual.into())]));
    }

    if with_value {
        // Value of forecasting: year-1 predictive-EMS results with each PV method (load method fixed) and each load method
        // (PV method fixed), against load following.
        let mut base = p.clone();
        base.sim.all_years = false;
        let s = Sizing { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, wind_units: f64::from(p.wind.units) };
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
            let inp = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
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
