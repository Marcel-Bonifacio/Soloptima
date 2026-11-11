//! Many independent simulations (sweeps, Monte Carlo, tornado) in parallel: `run_batch` of src/main.cpp. Each case overrides dotted
//! paths of the base project ("pv.capacity_kwp") and gets the simulation, diesel-only comparison and finance metrics, or an error.
use crate::finance::{parse_finance, run_finance};
use crate::json::{Error, Value};
use crate::model::HOURS;
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine, PVProfile};
use crate::sim::{compare, comparison_to_json, result_to_json, simulate, SimInput, Sizing};
use crate::{parse_project, validate_project};
use rayon::prelude::*;

/// Copy of `root` with the value at the path keys[i..] replaced by v (objects are made where the path has none)
fn with_path(root: &Value, keys: &[&str], v: &Value) -> Value {
    let Some((k, rest)) = keys.split_first() else { return v.clone() };
    let mut o = root.obj().cloned().unwrap_or_default();
    let inner = with_path(root.at(k), rest, v);
    o.insert((*k).to_string(), inner);
    Value::Obj(o)
}

/// The parts of a dotted path as std::getline splits it: no part after a final dot, none at all for ""
fn path_parts(path: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = path.split('.').collect();
    if parts.last() == Some(&"") { parts.pop(); }
    parts
}

/// The first 60 bytes of s, cut back to a whole character
fn head60(s: &str) -> &str {
    let mut n = s.len().min(60);
    while !s.is_char_boundary(n) { n -= 1; }
    &s[..n]
}

fn run_case(base: &Value, case: &Value, base_prof: &PVProfile, base_cs: &[f64]) -> Result<Value, Error> {
    let mut pj = base.clone();
    let mut own_pv = false;
    if let Some(ov) = case.at("overrides").obj() {
        for (path, v) in ov {
            let keys = path_parts(path);
            if keys.len() > 8 { return Err(Error(format!("An override path has at most 8 parts: {}", head60(path)))); }
            pj = with_path(&pj, &keys, v);
            // the per-kWp PV profile depends only on location, weather and the PV design, not its capacity
            own_pv = own_pv || keys.is_empty()
                || (["location", "weather", "pv", "layout"].contains(&keys[0]) && path != "pv.capacity_kwp");
        }
    }
    let p = parse_project(&pj);
    validate_project(&p)?;
    let (own_prof, own_cs) = if own_pv { (compute_pv_profile(&p)?, clearsky_pv_per_kwp(&p)?) } else { (PVProfile::default(), Vec::new()) };
    let (prof, cs) = if own_pv { (&own_prof, &own_cs[..]) } else { (base_prof, base_cs) };
    let wind = if p.wind.units > 0 { wind_per_turbine(&p)? } else { Vec::new() };
    let si = SimInput { pv_per_kwp: &prof.ac_per_kwp, pv_clip_per_kwp: &prof.clip_per_kwp, pv_cs_per_kwp: cs, wind_per_turbine: &wind, forecast: None };
    let size = Sizing { pv_kwp: p.pv.capacity_kwp, bess_kwh: p.bess.energy_kwh, bess_kw: p.bess.power_kw, wind_units: f64::from(p.wind.units) };
    let hyb = simulate(&p, &si, &size, false)?;
    let base_r = simulate(&p, &si, &Sizing::default(), false)?;
    let fin = run_finance(&p, &parse_finance(pj.at("finance")), &hyb.fin_sim(), &base_r.fin_sim(), 0.0);
    let mut out = Value::object();
    out.set("result", result_to_json(&hyb, false));
    out.set("comparison", comparison_to_json(&compare(&hyb, &base_r)));
    out.set("finance", fin.at("metrics").clone());
    out.set("specific_yield", prof.specific_yield);
    Ok(out)
}

/// `cases`: objects with "overrides" {dotted path: value}; at most 20000. Results come in the order of the cases.
pub fn run_batch(base: &Value, cases: &[Value]) -> Result<Value, Error> {
    if cases.len() > 20000 { return Err(Error("Batch limited to 20000 cases.".into())); }
    let base_p = parse_project(base);
    let (base_prof, base_cs) = if base_p.wx.ghi.len() == HOURS {
        (compute_pv_profile(&base_p)?, clearsky_pv_per_kwp(&base_p)?)
    } else { (PVProfile::default(), Vec::new()) };
    let results: Vec<Value> = cases.par_iter().map(|c| {
        run_case(base, c, &base_prof, &base_cs).unwrap_or_else(|e| {
            let mut v = Value::object();
            v.set("error", e.0);
            v
        })
    }).collect();
    let mut out = Value::object();
    out.set("results", results);
    Ok(out)
}
