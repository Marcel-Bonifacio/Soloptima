//! Inter-annual variability and P50/P90 of yield and plant results (src/resource.cpp): the dispatch runs once per historical weather
//! year (year 1, sizes unchanged). Fuel saved and revenue do not scale with PV yield (genset minimum load, full battery, take-or-pay
//! floors), so each metric gets its own spread. Used only as ratios: P50 stays on the project's own weather.
use crate::finance::{parse_finance, run_finance, FinSim};
use crate::json::{Error, Value};
use crate::model::{Project, Weather};
use crate::optimizer::Progress;
use crate::parse::parse_weather;
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use crate::sim::{compare, simulate, SimInput, SimResult, Sizing};
use crate::weather::WeatherService;
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex};

const Z75: f64 = 0.6745;
const Z90: f64 = 1.2816;
const Z99: f64 = 2.3263;   // one-sided standard normal quantiles

#[derive(Debug, Clone, Default)]
pub struct WeatherYear {
    pub year: i32,
    pub wx: Weather,
}

#[derive(Debug, Clone, Copy)]
pub struct UncertaintyBudget {
    /// irradiance dataset (satellite or reanalysis bias)
    pub dataset: f64,
    /// transposition and PV model
    pub model: f64,
    /// soiling and availability
    pub soiling: f64,
}

impl Default for UncertaintyBudget {
    fn default() -> Self { UncertaintyBudget { dataset: 0.05, model: 0.02, soiling: 0.015 } }
}

pub fn sigma_sys(b: &UncertaintyBudget) -> f64 { (b.dataset * b.dataset + b.model * b.model + b.soiling * b.soiling).sqrt() }

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Exceedance {
    pub p50: f64, pub mean: f64, pub sigma_iav: f64, pub sigma_1: f64, pub sigma_10: f64,
    pub p75_1: f64, pub p90_1: f64, pub p99_1: f64, pub p90_10: f64,
}

/// m0: the metric with the project's weather (the P50); ys: its value in each historical year; elasticity: relative change of
/// the metric per relative change of irradiance; sigma_sys: the systematic uncertainty of irradiance. With r = y / mean(y) and
/// sigma_iav the sample standard deviation of r, sigma_N = sqrt(sigma_iav^2 / N + (elasticity x sigma_sys)^2), and
/// P_x = m0 (1 - z_x sigma_N) for a benefit (lower is worse), m0 (1 + z_x sigma_N) otherwise (fuel used).
pub fn exceedance(m0: f64, ys: &[f64], elasticity: f64, sigma_sys: f64, benefit: bool) -> Exceedance {
    let mut x = Exceedance { p50: m0, ..Default::default() };
    for &y in ys { x.mean += y; }
    if !ys.is_empty() { x.mean /= ys.len() as f64; }
    let mut var = 0.0;
    if ys.len() >= 2 && x.mean.abs() > 1e-12 {
        for &y in ys { var += (y / x.mean - 1.0) * (y / x.mean - 1.0); }
        var /= (ys.len() - 1) as f64;
    }
    let sys = elasticity * sigma_sys;
    x.sigma_iav = f64::sqrt(var);
    x.sigma_1 = f64::sqrt(var + sys * sys);
    x.sigma_10 = f64::sqrt(var / 10.0 + sys * sys);
    let sg = if benefit { -1.0 } else { 1.0 };
    x.p75_1 = m0 * (1.0 + sg * Z75 * x.sigma_1);
    x.p90_1 = m0 * (1.0 + sg * Z90 * x.sigma_1);
    x.p99_1 = m0 * (1.0 + sg * Z99 * x.sigma_1);
    x.p90_10 = m0 * (1.0 + sg * Z90 * x.sigma_10);
    x
}

#[derive(Debug, Clone, Copy, Default)]
struct YearRun {
    year: i32,
    sy: f64, ghi: f64, poa: f64,
    re: f64, curtail: f64, unmet: f64,
    fuel_hyb: f64, fuel_base: f64, fuel_saved: f64,
    avoided_cost: f64, re_kwh: f64, energy: f64, revenue: f64, npv_savings: f64,
}

fn year_json(y: &YearRun) -> Value {
    let mut o = Value::object();
    o.set("year", y.year);
    for (k, v) in [("sy", y.sy), ("ghi", y.ghi), ("poa", y.poa), ("re", y.re), ("curtail", y.curtail), ("unmet", y.unmet),
                   ("fuel_hyb", y.fuel_hyb), ("fuel_base", y.fuel_base), ("fuel_saved", y.fuel_saved), ("avoided_cost", y.avoided_cost),
                   ("re_kwh", y.re_kwh), ("revenue", y.revenue), ("npv_savings", y.npv_savings)] {
        o.set(k, v);
    }
    o
}

struct Run { hyb: SimResult, base: SimResult, hf: FinSim, bf: FinSim, sy: f64, ghi: f64, poa: f64 }

fn one_run(p: &Project, years: &[WeatherYear], i: usize, s: f64, sz: &Sizing) -> Result<Run, Error> {
    let n = years.len();
    let mut q = p.clone();
    q.sim.all_years = false;
    if i < n {
        q.wx = years[i].wx.clone();
    } else if i > n {
        let f = if i == n + 1 { 1.0 + s } else { 1.0 - s };
        for v in [&mut q.wx.ghi, &mut q.wx.dni, &mut q.wx.dhi] {
            for x in v.iter_mut() { *x *= f; }
        }
    }
    let prof = compute_pv_profile(&q)?;
    let cs = clearsky_pv_per_kwp(&q)?;
    let wind = if sz.wind_units > 0.5 { wind_per_turbine(&q)? } else { Vec::new() };
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
    let hyb = simulate(&q, &si, sz, false)?;
    let base = simulate(&q, &si, &Sizing::default(), false)?;
    let (hf, bf) = (hyb.fin_sim(), base.fin_sim());
    Ok(Run { hyb, base, hf, bf, sy: prof.specific_yield, ghi: prof.ghi_annual, poa: prof.poa_annual })
}

/// Runs year 1 with every weather year, with the project's own weather (P50 anchor), and with its irradiance x (1 + s) and x (1 - s),
/// s = sigma_sys, for each metric's elasticity. raw: the project document (its "finance" block). Progress counts years + 3 runs.
/// Returns {years, anchor, plus, minus, stats: {metric: {p50, mean, sigma_iav, sigma_1, sigma_10, elasticity, p75_1, p90_1, p99_1,
/// p90_10, worst_year, worst}}, sigma_sys, step}.
pub fn resource_years(p: &Project, raw: &Value, years: &[WeatherYear], b: &UncertaintyBudget, prog: &Progress) -> Result<Value, Error> {
    let n = years.len();
    if n < 2 { return Err(Error("The variability run needs at least two weather years.".into())); }
    let ss = sigma_sys(b);
    let s = if ss > 0.0 { ss } else { 0.05 };   // irradiance step of the elasticity (5 % when the budget is zero)
    let sz = Sizing { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, wind_units: f64::from(p.wind.units) };

    // Runs 0..n-1: the historical years; n: the project's weather (P50 anchor); n+1, n+2: its irradiance x (1 + s), x (1 - s).
    prog.total.store((n + 3) as i64, Relaxed);
    prog.done.store(0, Relaxed);
    let runs: Vec<Option<Run>> = (0..n + 3).into_par_iter().map(|i| {
        if prog.cancel.load(Relaxed) { return Ok(None); }
        let r = one_run(p, years, i, s, &sz).map_err(|e| {
            if i < n { Error(format!("Weather year {}: {}", years[i].year, e.0)) } else { e }
        })?;
        prog.done.fetch_add(1, Relaxed);
        Ok(Some(r))
    }).collect::<Result<_, Error>>()?;
    if prog.cancel.load(Relaxed) { return Err(Error("Cancelled.".into())); }
    let runs: Vec<Run> = runs.into_iter().map(|r| r.expect("every run finished")).collect();

    // Project finance on the same contract in every weather year: a tariff solved for a target IRR is solved for the P50 case
    // and then kept, and the contracted energy (take-or-pay, shortfall threshold) stays at its P50 value.
    let f0 = parse_finance(raw.at("finance"));
    let a = &runs[n];
    let e1_anchor = a.hyb.years[0].served_site * a.hyb.years[0].re_fraction;
    let scale = run_finance(p, &f0, &a.hf, &a.bf, 0.0).at("metrics").get("tariff_scale", 1.0);
    let record = |r: &Run, year: i32| {
        let h = &r.hyb.years[0];
        let bb = &r.base.years[0];
        let mut f = f0.clone();
        let e1 = h.served_site * h.re_fraction;
        if e1 > 0.0 { f.ace_factor = f0.ace_factor * e1_anchor / e1; }
        let fin = run_finance(p, &f, &r.hf, &r.bf, scale);
        let fuel_hyb = r.hyb.fuel_l_y1;
        let fuel_base = r.base.fuel_l_y1;
        YearRun {
            year,
            sy: r.sy, ghi: r.ghi, poa: r.poa,
            re: r.hyb.re_fraction, curtail: r.hyb.curtail_fraction, unmet: r.hyb.unmet_fraction,
            fuel_hyb, fuel_base, fuel_saved: fuel_base - fuel_hyb,
            avoided_cost: (bb.c_fuel + bb.c_om_dg + bb.c_carbon) - (h.c_fuel + h.c_om_dg + h.c_carbon),
            re_kwh: h.served * h.re_fraction,
            energy: e1,
            revenue: fin.at("years").idx(1).at("revenue").num(0.0),   // years[0] is construction / COD
            npv_savings: compare(&r.hyb, &r.base).npv_savings,
        }
    };
    let ys: Vec<YearRun> = (0..n).map(|i| record(&runs[i], years[i].year)).collect();
    let (y0, yp, ym) = (record(&runs[n], 0), record(&runs[n + 1], 0), record(&runs[n + 2], 0));

    type Get = fn(&YearRun) -> f64;
    let metrics: [(&str, Get, bool); 6] = [("yield", |y| y.sy, true), ("fuel_saved", |y| y.fuel_saved, true), ("re", |y| y.re, true),
        ("avoided_cost", |y| y.avoided_cost, true), ("revenue", |y| y.revenue, true), ("fuel_used", |y| y.fuel_hyb, false)];
    let mut stats = Value::object();
    for (key, m, benefit) in metrics {
        let m0 = m(&y0);
        let el = if m0.abs() > 1e-12 { (m(&yp) - m(&ym)) / (2.0 * s * m0) } else { 0.0 };
        let v: Vec<f64> = ys.iter().map(m).collect();
        let x = exceedance(m0, &v, el, ss, benefit);
        let mut w = 0;
        for i in 1..n {
            if if benefit { v[i] < v[w] } else { v[i] > v[w] } { w = i; }
        }
        let mut o = Value::object();
        for (k, val) in [("p50", x.p50), ("mean", x.mean), ("sigma_iav", x.sigma_iav), ("sigma_1", x.sigma_1), ("sigma_10", x.sigma_10),
                         ("elasticity", el), ("p75_1", x.p75_1), ("p90_1", x.p90_1), ("p99_1", x.p99_1), ("p90_10", x.p90_10)] {
            o.set(k, val);
        }
        o.set("worst_year", ys[w].year);
        o.set("worst", v[w]);
        stats.set(key, o);
    }
    // Under a PPA or TPO the revenue is a non-decreasing function of the renewable energy delivered (take-or-pay floor,
    // shortfall penalty), so its P-values are that function of the energy's P-values. Deemed energy stays at its P50 value.
    if f0.model != "host" {
        let fin = run_finance(p, &f0, &a.hf, &a.bf, scale);
        let y1 = fin.at("years").idx(1);
        let (tar, ace, e0) = (y1.get("tariff", 0.0), y1.get("ace", 0.0), y0.energy);
        let mx = |a: f64, b: f64| if a < b { b } else { a };
        let deemed = y1.get("billed", 0.0) - mx(y1.get("energy", 0.0), f0.take_or_pay * ace);
        let rev = |e: f64| {
            tar * (mx(e, f0.take_or_pay * ace) + deemed) - f0.penalty_rate * tar * mx(0.0, f0.penalty_threshold * ace - e)
        };
        let ve: Vec<f64> = ys.iter().map(|y| y.energy).collect();
        let ee = if e0.abs() > 1e-12 { (yp.energy - ym.energy) / (2.0 * s * e0) } else { 0.0 };
        let xe = exceedance(e0, &ve, ee, ss, true);
        if let Value::Obj(st) = &mut stats {
            if let Some(Value::Obj(r)) = st.get_mut("revenue") {
                for (k, e) in [("p75_1", xe.p75_1), ("p90_1", xe.p90_1), ("p99_1", xe.p99_1), ("p90_10", xe.p90_10)] {
                    r.insert(k.into(), Value::Num(rev(e)));
                }
            }
        }
    }
    let mut out = Value::object();
    out.set("years", ys.iter().map(year_json).collect::<Vec<Value>>());
    out.set("anchor", year_json(&y0));
    out.set("plus", year_json(&yp));
    out.set("minus", year_json(&ym));
    out.set("stats", stats);
    out.set("sigma_sys", ss);
    out.set("step", s);
    Ok(out)
}

#[derive(Debug, Default)]
pub struct WeatherSet {
    pub from: i32,
    pub to: i32,
    pub database: String,
    pub note: String,
    pub years: Vec<WeatherYear>,
}

/// Downloaded weather years kept in memory (never in the project file), by source, site rounded to 0.001 deg and range. At most 4 sets.
#[derive(Default)]
pub struct WeatherYearsCache {
    sets: Mutex<BTreeMap<String, Arc<WeatherSet>>>,
}

impl WeatherYearsCache {
    pub fn clear(&self) -> usize {
        let mut s = self.sets.lock().unwrap();
        let n = s.len();
        s.clear();
        n
    }

    pub fn get(&self, svc: &WeatherService, source: &str, lat: f64, lon: f64, y0: i32, y1: i32) -> Result<Arc<WeatherSet>, Error> {
        let lat = (lat * 1000.0).round() / 1000.0;
        let lon = (lon * 1000.0).round() / 1000.0;
        let key = format!("{source} {lat:.3} {lon:.3} {y0} {y1}");
        if let Some(w) = self.sets.lock().unwrap().get(&key) { return Ok(w.clone()); }
        let d = svc.fetch_weather_years(source, lat, lon, y0, y1)?;
        let mut w = WeatherSet { from: d.get("from", f64::from(y0)) as i32, to: d.get("to", f64::from(y1)) as i32,
                                 database: d.gets("database", source), ..Default::default() };
        let (mut filled, mut gap) = (0i32, 0i32);
        for y in d.at("years").arr() {
            w.years.push(WeatherYear { year: crate::storage::atoi(&y.gets("years", "0")), wx: parse_weather(y) });
            filled += y.get("n_filled", 0.0) as i32;
            gap = gap.max(y.get("max_gap_h", 0.0) as i32);
        }
        if filled > 0 { w.note = format!("{filled} h with missing values filled in, longest gap {gap} h."); }
        let w = Arc::new(w);
        let mut sets = self.sets.lock().unwrap();
        if sets.len() >= 4 {
            let first = sets.keys().next().cloned().unwrap();
            sets.remove(&first);
        }
        sets.insert(key, w.clone());
        Ok(w)
    }
}
