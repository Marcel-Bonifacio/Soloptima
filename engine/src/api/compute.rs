//! The computing routes: weather, data import and checks, PV, simulation, EMS, optimiser and the variability run.
use super::{dump, Engine, R};
use crate::ems::{day_ahead_schedule, forecast_benchmark_with};
use crate::finance::{parse_finance, run_finance};
use crate::forecast::{load_forecast_methods, pv_forecast_methods, MethodInfo};
use crate::json::{Error, Value};
use crate::model::{Project, SimOptions, HOURS};
use crate::optimizer::{optimize, parse_opt_settings, run_batch};
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, compute_pv_profile_groups, libm_remainder, pv_json, pv_reconcile, pv_reference_basis,
                tilt_scan, wind_per_turbine};
use crate::resource::{resource_years, sigma_sys, UncertaintyBudget};
use crate::optimizer::Progress;
use crate::sim::{checks_json, compare, comparison_to_json, result_checks, CheckBasis, grid_extension, parse_resilience, reliability_json, resilience, result_to_json, simulate, summary_json,
                 SimInput, SimResult, Sizing};
use crate::weather::WeatherService;
use crate::{array_groups, data_qc, import_series, layout_used, parse_project, validate_layout, validate_project};
use std::sync::atomic::Ordering::Relaxed;

use crate::json::fail;

/// The design run once more as project q, without the hourly series: the curtailment and fuel of year 1, and what `more` adds
fn reference(q: &Project, si: &SimInput, s: &Sizing, more: impl FnOnce(&SimResult, &mut Value)) -> Result<Value, Error> {
    let r = simulate(q, si, s, false)?;
    let y = &r.years[0];
    let mut d = Value::object();
    d.set("curtailed", y.pv_curtailed + y.wind_curtailed);
    d.set("curtail_fraction", r.curtail_fraction);
    d.set("fuel_l_y1", r.fuel_l_y1);
    more(&r, &mut d);
    Ok(d)
}

pub fn forecast_days(v: &Value) -> i32 {
    let d = v.get("days", 2.0);
    if d >= 1.0 { d.min(16.0) as i32 } else { 1 }
}

/// The configured system, diesel only, and the same PV and wind without the battery (its own value), with comparisons, PV summary
/// and project finance. raw: the project document (its "finance" block).
pub fn run_simulation(p: &Project, raw: &Value) -> Result<Value, Error> {
    validate_project(p)?;
    let prof = compute_pv_profile(p)?;
    let cs = clearsky_pv_per_kwp(p)?;
    let wind = if p.wind.units > 0 { wind_per_turbine(p)? } else { Vec::new() };
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
    let size = Sizing::of(p);
    let hyb = simulate(p, &si, &size, true)?;
    let base = simulate(p, &si, &Sizing::default(), true)?;
    let mut o = Value::object();
    let mut res = result_to_json(&hyb, true);
    let mut sum = summary_json(&p.bess, &hyb);
    sum.set("reliability", reliability_json(&prof.ac_per_kwp, hyb.hourly.as_ref().expect("hourly series were kept"), p.sim.low_pv_frac));
    let cmp = compare(&hyb, &base);
    let basis = CheckBasis { base: &base, cmp: &cmp, poa_kwh_m2: prof.poa_annual, rear_kwh_m2: prof.rear_annual };
    sum.set("checks", checks_json(&result_checks(p, &hyb, &basis)));
    res.set("summary", sum);
    o.set("result", res);
    // the break-even distance of a grid extension, for an off-grid design with a line cost per km
    if !p.grid.enabled { if let Some(g) = grid_extension(p, &hyb) { o.set("grid_extension", g); } }
    o.set("baseline", result_to_json(&base, false));
    let mut bh = Value::object();
    let h = base.hourly.as_ref().expect("hourly series were kept");
    bh.set("gen_units", h.gen_units.clone());
    bh.set("fuel_l", h.fuel_l.clone());
    o.set("baseline_hourly", bh);
    o.set("comparison", comparison_to_json(&cmp));
    // The battery's own value: the same PV and wind without it. Every strategy reduces to load following there.
    if size.has_bess() {
        let pvo = simulate(p, &si, &Sizing { bess_kwh: 0.0, bess_kw: 0.0, ..size }, false)?;
        o.set("pv_only", result_to_json(&pvo, false));
        o.set("comparison_bess", comparison_to_json(&compare(&hyb, &pvo)));
    } else {
        o.set("pv_only", Value::Null);
        o.set("comparison_bess", Value::Null);
    }
    // With a deferrable load: the same design without it, for the curtailment, fuel and export it changes
    if p.deferrable.on() {
        let q = Project { deferrable: Default::default(), ..p.clone() };
        o.set("deferrable_ref", reference(&q, &si, &size, |r, d| {
            d.set("re_fraction", r.re_fraction);
            if r.has_grid { d.set("grid_export", r.years[0].grid_export); }
        })?);
    }
    // With a PV and wind ramp limit: the same design without it, for the curtailment, battery throughput and fuel it adds. In
    // hourly steps the limit does nothing, and the answer says so.
    if p.sim.re_ramp_pct_min > 0.0 {
        if hyb.x.re_ramp {
            let q = Project { sim: SimOptions { re_ramp_pct_min: 0.0, ..p.sim.clone() }, ..p.clone() };
            o.set("re_ramp_ref", reference(&q, &si, &size, |r, d| {
                d.set("bess_ch", r.years[0].bess_ch);
                d.set("bess_dis", r.years[0].bess_dis);
                d.set("unmet_fraction", r.unmet_fraction);
            })?);
        } else {
            o.set("re_ramp_note", "The PV and wind ramp limit applies only in 15 or 30 minute steps; at 60 minutes it is ignored.");
        }
    }
    let mut pv = Value::object();
    pv.set("specific_yield", prof.specific_yield);
    pv.set("performance_ratio", prof.performance_ratio);
    o.set("pv", pv);
    o.set("finance", run_finance(p, &parse_finance(raw.at("finance")), &hyb.fin_sim(), &base.fin_sim(), 0.0));
    Ok(o)
}

/// The outage survival study of the configured system (sim/resilience.rs); raw: the request's "resilience" block
pub fn run_resilience(p: &Project, raw: &Value, prog: &Progress) -> Result<Value, Error> {
    validate_project(p)?;
    let rs = parse_resilience(raw)?;
    let prof = compute_pv_profile(p)?;
    let wind = if p.wind.units > 0 { wind_per_turbine(p)? } else { Vec::new() };
    // the normal year-1 run under the study plans with the project's forecasters; only the predictive strategy needs the clear sky
    let cs = if p.dg.strategy == "predictive" { clearsky_pv_per_kwp(p)? } else { Vec::new() };
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: &cs, wind_per_turbine: &wind, forecast: None };
    resilience(p, &si, &Sizing::of(p), &rs, prog)
}

/// Independent check of the yield against PVGIS PVcalc (see `pv_reference_basis`): PVGIS's loss-free yield of the site and
/// orientation, scaled by the losses PVGIS does not model itself.
pub fn pv_reference(svc: &WeatherService, p: &Project) -> Result<Value, Error> {
    let b = pv_reference_basis(p)?;
    let c = &b.profile;
    let g = svc.pvgis_pvcalc(p.loc.lat, p.loc.lon, 0.0, p.pv.tilt, libm_remainder(p.pv.azimuth - 180.0, 360.0), b.tracker)?;
    let em: Vec<f64> = (0..12).map(|m| g.at("em").idx(m).num(0.0) * b.kept).collect();
    let ey = g.get("ey", 0.0) * b.kept;
    let mut o = Value::object();
    o.set("pvgis_ey", ey);
    o.set("pvgis_em", em);
    o.set("soloptima_ey", c.specific_yield);
    o.set("soloptima_em", c.m_avail.to_vec());
    o.set("loss_pct", 100.0 * (1.0 - b.kept));
    o.set("diff", if ey > 0.0 { c.specific_yield / ey - 1.0 } else { 0.0 });
    o.set("pvgis_poa", g.get("hi_y", 0.0));
    o.set("soloptima_poa", c.poa_annual);
    for k in ["radiation_db", "year_min", "year_max"] { o.set(k, g.at(k).clone()); }
    o.set("tracker", b.tracker);
    Ok(o)
}

fn project_with_weather(body: &Value) -> Result<Project, Error> {
    let p = parse_project(body);
    if p.wx.ghi.len() != HOURS { return fail("Fetch or upload weather data first."); }
    if layout_used(&p) { validate_layout(&p.layout)?; }
    Ok(p)
}

fn methods(m: &[MethodInfo]) -> Value {
    let mut a = Value::array();
    for x in m {
        let mut o = Value::object();
        o.set("id", x.id);
        o.set("name", x.name);
        o.set("description", x.description);
        a.push(o);
    }
    a
}

impl Engine {
    pub fn weather(&self, v: &Value) -> R {
        dump(self.weather.fetch_weather_with(&v.gets("source", "pvgis_tmy"), v.get("lat", 0.0), v.get("lon", 0.0), v.get("year", 2023.0) as i32,
                                             v.getb("snow_rh", false)))
    }
    pub fn horizon(&self, v: &Value) -> R { dump(self.weather.fetch_horizon(v.get("lat", 0.0), v.get("lon", 0.0))) }
    pub fn forecast_weather(&self, v: &Value) -> R {
        let (provider, lat, lon, key) = (v.gets("provider", "open_meteo"), v.get("lat", 0.0), v.get("lon", 0.0), v.gets("api_key", ""));
        if provider == "blend" { return dump(self.weather.fetch_forecast_blend(lat, lon, forecast_days(v), &key, v.get("met_weight", 0.5))); }
        dump(self.weather.fetch_forecast(&provider, lat, lon, forecast_days(v), &key))
    }
    /// Timestamped load or weather file as one year of hourly means with an import report: {text, options}
    pub fn import_series(&self, v: &Value) -> R {
        let t = v.at("text");
        if !t.is_string() { return fail("The file text is missing."); }
        if t.str().len() > 64 << 20 { return fail("The file is too large (over 64 MB): split it by year."); }
        dump(import_series(t.str(), v.at("options")))
    }
    pub fn data_qc(&self, v: &Value) -> R {
        let only = v.gets("only", "");
        if !only.is_empty() && only != "weather" && only != "load" {
            let mut n = only.len().min(20);
            while !only.is_char_boundary(n) { n -= 1; }
            return fail(format!("Unknown data set: {}.", &only[..n]));
        }
        dump(data_qc(&parse_project(v.at("project")), &only))
    }
    pub fn pv(&self, v: &Value) -> R {
        let p = project_with_weather(v)?;
        Ok(pv_json(&compute_pv_profile_groups(&p, &array_groups(&p)?, true)?).dump())
    }
    pub fn pv_reference(&self, v: &Value) -> R { dump(pv_reference(&self.weather, &project_with_weather(v)?)) }
    /// Metered PV output against the yield model: {project, meter: {kw}} (pv/reconcile.rs)
    pub fn pv_reconcile(&self, v: &Value) -> R { dump(pv_reconcile(&project_with_weather(v.at("project"))?, v.at("meter"))) }
    /// The electrical design, load flow, short circuit and protection of the interface's project (engine/src/electrical)
    pub fn electrical(&self, v: &Value) -> R {
        match crate::electrical::command(v) { Ok(x) => Ok(x.dump()), Err(e) => fail(&e) }
    }
    pub fn tilt_scan(&self, v: &Value) -> R {
        let mut pts = Value::array();
        for (t, y) in tilt_scan(&project_with_weather(v)?, 0.0, 45.0, 2.5)? { pts.push(vec![t, y]); }
        let mut o = Value::object();
        o.set("points", pts);
        Ok(o.dump())
    }
    pub fn forecast_benchmark(&self, v: &Value) -> R {
        let p = parse_project(v.at("project"));
        validate_project(&p)?;
        dump(forecast_benchmark_with(&p, v.getb("with_value", true), v.getb("by_class", false)))
    }
    pub fn forecast_methods(&self) -> R {
        let mut o = Value::object();
        o.set("pv", methods(pv_forecast_methods()));
        o.set("load", methods(load_forecast_methods()));
        Ok(o.dump())
    }
    pub fn batch(&self, v: &Value) -> R { dump(run_batch(v.at("project"), v.at("cases").arr())) }
    pub fn simulate(&self, v: &Value) -> R { dump(run_simulation(&parse_project(v), v)) }
    /// Day-ahead plan from a weather forecast; now_utc is the page's clock, so the plan starts at the current hour
    pub fn ems_schedule(&self, v: &Value) -> R {
        let p = parse_project(v.at("project"));
        if let Err(e) = validate_project(&p) { return dump(Err(e)); }
        dump(day_ahead_schedule(&p, &Sizing::of(&p), v.at("forecast"), v.get("soc_now", 0.5), v.get("load_scale", 1.0), &v.gets("now_utc", ""),
                                forecast_days(v) * 24))
    }
    pub fn optimize(&self, v: &Value) -> R {
        let p = parse_project(v.at("project"));
        validate_project(&p)?;
        let o = parse_opt_settings(v.at("optimizer"), &p)?;
        Ok(self.jobs.start(move |prog| optimize(&p, &o, prog)))
    }
    /// The outage survival study as a job: body `project`, `resilience` {stride, max_h}
    pub fn resilience(&self, v: &Value) -> R {
        let p = parse_project(v.at("project"));
        validate_project(&p)?;
        parse_resilience(v.at("resilience"))?;
        let raw = v.at("resilience").clone();
        Ok(self.jobs.start(move |prog| run_resilience(&p, &raw, prog)))
    }
    pub fn resource_years(self: &std::sync::Arc<Self>, v: &Value) -> R {
        let raw = v.at("project").clone();
        let p = parse_project(&raw);
        validate_project(&p)?;
        let source = v.gets("source", "pvgis");
        if source != "pvgis" && source != "nasa_power" { return fail(format!("Unknown weather source: {source}")); }
        let (from, to) = (v.get("from", 2005.0) as i32, v.get("to", 2023.0) as i32);
        if from == to { return fail("Choose at least two weather years."); }
        let bj = v.at("budget");
        let d = UncertaintyBudget::default();
        let b = UncertaintyBudget { dataset: bj.get("dataset", d.dataset), model: bj.get("model", d.model), soiling: bj.get("soiling", d.soiling) };
        if !(b.dataset >= 0.0 && b.model >= 0.0 && b.soiling >= 0.0 && sigma_sys(&b) < 1.0) {
            return fail("Uncertainties must be at least 0 % and together below 100 %.");
        }
        let me = self.clone();
        Ok(self.jobs.start(move |prog| {
            prog.total.store(2.max((i64::from(to) - i64::from(from)).abs() + 1) + 3, Relaxed);
            let w = me.years.get(&me.weather, &source, p.loc.lat, p.loc.lon, from, to)?;
            if prog.cancel.load(Relaxed) { return fail("Cancelled."); }
            let mut res = resource_years(&p, &raw, &w.years, &b, prog)?;
            let mut range = Value::object();
            range.set("from", w.from);
            range.set("to", w.to);
            res.set("range", range);
            res.set("database", w.database.as_str());
            res.set("source", source.as_str());
            res.set("note", w.note.as_str());
            Ok(res)
        }))
    }
}
