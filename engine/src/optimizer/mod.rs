//! PV / BESS sizing for a known load and a known diesel fleet (src/optimizer.{hpp,cpp}).
//! Grid: exhaustive (PV kWp x BESS kWh x C-rate) + Hooke-Jeeves pattern search, in parallel (rayon).
//! Metaheuristics from the literature: PSO, MOPSO (cost vs renewable fraction or SSSI) and hybrid SHO-QAO-GOA, also over
//! the C-rate range and the number of wind turbines. Optional sensitivity: repeat the search for each value of one input.
//! Batch runs of many independent simulations with overrides (batch.rs). Results equal the C++ engine's to the byte with
//! the same seed, whatever the number of threads.
mod batch;
mod cxxsort;
mod eval;
mod meta;
mod search;

pub use batch::run_batch;

use crate::json::{Error, Value};
use crate::model::Project;
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use crate::sim::{clamp, comparison_to_json, compare, mx, result_to_json, simulate, SimInput};
use eval::{cand_json, check_sensitivity, linspace, score, size_key, Candidate};
use search::{search, Inputs};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering::Relaxed};

#[derive(Debug, Clone)]
pub struct OptSettings {
    pub pv_min: f64, pub pv_max: f64, pub pv_steps: i32,
    pub bess_min: f64, pub bess_max: f64, pub bess_steps: i32,
    /// BESS kW per kWh
    pub c_rates: Vec<f64>,
    /// npc | lcoe | re
    pub objective: String,
    /// fraction of annual load, in every simulated year
    pub max_unmet: f64,
    /// loss-of-load hours per year, worst year (< 0 = no limit)
    pub max_lole_h: f64,
    /// spinning-reserve shortfall hours per year, worst year (< 0 = no limit)
    pub max_reserve_short_h: f64,
    /// year-1 renewable fraction
    pub min_re: f64,
    /// fraction of available PV
    pub max_curtail: f64,
    /// land limit from layout
    pub max_pv_kwp: f64,
    pub max_capex: f64,
    pub refine: bool,
    /// 0 = all cores
    pub threads: i32,
    /// "", fuel_price, fuel_escalation, discount_rate, pv_capex_kwp, bess_capex_kwh, load_scale (x load), bess_life_scale
    /// (x cycle life, / calendar fade), bess_cycle_life, bess_calendar_fade, bess_replace_kwh, bess_prices_scale (x battery
    /// capex per kWh and kW and replacement price), bess_replace_soh, pv_degradation, diesel_om_unit_hour
    pub sens_var: String,
    pub sens_values: Vec<f64>,
    /// grid (exhaustive + pattern search) | pso | mopso | hshoa (SHO + QAO + GOA)
    pub algorithm: String,
    pub particles: i32, pub iterations: i32,
    pub seed: u32,
    /// wind turbine count range (metaheuristics)
    pub wind_min: i32, pub wind_max: i32,
    /// MOPSO second objective: re | sssi
    pub mo_second: String,
}

impl Default for OptSettings {
    fn default() -> Self {
        OptSettings {
            pv_min: 0.0, pv_max: 0.0, pv_steps: 16, bess_min: 0.0, bess_max: 0.0, bess_steps: 12, c_rates: vec![0.5],
            objective: "npc".into(), max_unmet: 0.001, max_lole_h: -1.0, max_reserve_short_h: -1.0, min_re: 0.0, max_curtail: 1.0,
            max_pv_kwp: f64::INFINITY, max_capex: f64::INFINITY, refine: true, threads: 0, sens_var: String::new(),
            sens_values: Vec::new(), algorithm: "grid".into(), particles: 24, iterations: 40, seed: 42, wind_min: 0, wind_max: 0,
            mo_second: "re".into(),
        }
    }
}

/// Progress of a run, shared with whoever watches it; `cancel` stops it early (the result says "cancelled")
pub struct Progress {
    pub done: AtomicI64,
    pub total: AtomicI64,
    pub cancel: AtomicBool,
}

impl Default for Progress {
    fn default() -> Self { Progress { done: AtomicI64::new(0), total: AtomicI64::new(1), cancel: AtomicBool::new(false) } }
}

/// The "optimizer" block of a project or request; the default PV and battery ranges come from the load and the PV yield
pub fn parse_opt_settings(v: &Value, p: &Project) -> Result<OptSettings, Error> {
    let mut o = OptSettings::default();
    let annual = p.load_kw.iter().fold(0.0, |a, &x| a + x);
    o.pv_min = v.get("pv_min", 0.0);
    o.pv_max = v.get("pv_max", 0.0);
    if o.pv_max <= o.pv_min { o.pv_max = mx(o.pv_min + 1.0, 1.2 * annual / mx(1.0, compute_pv_profile(p)?.specific_yield)); }
    o.bess_min = v.get("bess_min", 0.0);
    o.bess_max = v.get("bess_max", 0.0);
    if o.bess_max <= o.bess_min { o.bess_max = mx(o.bess_min + 1.0, annual / 365.0 * 0.5); }
    o.pv_steps = clamp(v.get("pv_steps", f64::from(o.pv_steps)) as i32, 1, 200);
    o.bess_steps = clamp(v.get("bess_steps", f64::from(o.bess_steps)) as i32, 1, 200);
    if v.at("c_rates").is_array() {
        o.c_rates = v.at("c_rates").arr().iter().map(|x| x.num(0.0)).filter(|&x| x > 0.0).take(20).collect();
        if o.c_rates.is_empty() { o.c_rates = vec![0.5]; }
    }
    o.objective = v.gets("objective", &o.objective);
    o.max_unmet = v.get("max_unmet", o.max_unmet);
    o.min_re = v.get("min_re", o.min_re);
    o.max_curtail = v.get("max_curtail", o.max_curtail);
    o.max_lole_h = v.get("max_lole_h", o.max_lole_h);
    o.max_reserve_short_h = v.get("max_reserve_short_h", o.max_reserve_short_h);
    if v.get("max_pv_kwp", 0.0) > 0.0 { o.max_pv_kwp = v.get("max_pv_kwp", 0.0); }
    if v.get("max_capex", 0.0) > 0.0 { o.max_capex = v.get("max_capex", 0.0); }
    o.refine = v.getb("refine", o.refine);
    o.threads = clamp(v.get("threads", 0.0), 0.0, 256.0) as i32;
    o.sens_var = v.gets("sens_var", "");
    o.sens_values = v.getv("sens_values");
    if o.sens_values.len() > 20 { return Err(Error("At most 20 sensitivity values.".into())); }
    for &x in &o.sens_values { check_sensitivity(&o.sens_var, x)?; }
    o.algorithm = v.gets("algorithm", &o.algorithm);
    if !["grid", "pso", "mopso", "hshoa"].contains(&o.algorithm.as_str()) { o.algorithm = "grid".into(); }
    o.particles = clamp(v.get("particles", f64::from(o.particles)) as i32, 4, 200);
    o.iterations = clamp(v.get("iterations", f64::from(o.iterations)) as i32, 1, 500);
    o.seed = v.get("seed", f64::from(o.seed)) as i64 as u32;
    o.wind_min = (v.get("wind_min", 0.0) as i32).max(0);
    o.wind_max = o.wind_min.max(v.get("wind_max", 0.0) as i32);
    o.mo_second = v.gets("mo_second", &o.mo_second);
    Ok(o)
}

fn alg_name(alg: &str) -> &'static str {
    match alg {
        "pso" => "particle swarm optimisation (PSO)",
        "mopso" => "multi-objective PSO (MOPSO)",
        "hshoa" => "hybrid spotted-hyena / quadratic-approximation / grasshopper (SHO-QAO-GOA)",
        _ => "grid search + pattern search",
    }
}

fn settings_json(o: &OptSettings) -> Value {
    let mut s = Value::object();
    s.set("pv_min", o.pv_min); s.set("pv_max", o.pv_max); s.set("pv_steps", o.pv_steps); s.set("bess_min", o.bess_min);
    s.set("bess_max", o.bess_max); s.set("bess_steps", o.bess_steps); s.set("c_rates", o.c_rates.clone());
    s.set("objective", o.objective.as_str()); s.set("max_unmet", o.max_unmet); s.set("min_re", o.min_re);
    s.set("max_curtail", o.max_curtail); s.set("max_lole_h", o.max_lole_h); s.set("max_reserve_short_h", o.max_reserve_short_h);
    s.set("max_pv_kwp", if o.max_pv_kwp.is_finite() { Value::Num(o.max_pv_kwp) } else { Value::Null });
    s.set("algorithm_id", o.algorithm.as_str()); s.set("algorithm", alg_name(&o.algorithm)); s.set("particles", o.particles);
    s.set("iterations", o.iterations); s.set("mo_second", o.mo_second.as_str()); s.set("wind_min", o.wind_min);
    s.set("wind_max", o.wind_max);
    s
}

/// The full result: grid, ranked table, Pareto set, best system with hourly detail, sensitivity table (run `validate_project` first)
pub fn optimize(p0: &Project, o: &OptSettings, prog: &Progress) -> Result<Value, Error> {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(o.threads.max(0) as usize).build().map_err(|e| Error(e.to_string()))?;
    pool.install(|| run(p0, o, prog))
}

fn run(p0: &Project, o: &OptSettings, prog: &Progress) -> Result<Value, Error> {
    let grid_alg = o.algorithm == "grid";
    let per_run = if grid_alg { i64::from(o.pv_steps.max(1)) * i64::from(o.bess_steps.max(1)) * o.c_rates.len() as i64 } else { 0 };
    let sens = !o.sens_var.is_empty() && !o.sens_values.is_empty();
    prog.total.store(per_run * if sens { o.sens_values.len() as i64 + 1 } else { 1 }, Relaxed);
    prog.done.store(0, Relaxed);

    // Turbines (and the EMS's wind forecast) need the output per turbine, which no sensitivity variable changes
    let needs_wind = p0.dg.strategy == "predictive" || p0.wind.units > 0 || o.wind_max > 0;
    let prof = compute_pv_profile(p0)?;
    let inp = Inputs {
        pv: prof.ac_per_kwp,
        clip: prof.clip_per_kwp,
        cs: clearsky_pv_per_kwp(p0)?,
        wind: if needs_wind { wind_per_turbine(p0)? } else { Vec::new() },
    };
    let mut main = search(p0, &inp, o, prog, true)?;

    let mut out = Value::object();
    out.set("settings", settings_json(o));
    out.set("pv_axis", linspace(o.pv_min, o.pv_max, o.pv_steps));
    out.set("bess_axis", linspace(o.bess_min, o.bess_max, o.bess_steps));
    out.set("grid", main.grid.iter().map(cand_json).collect::<Vec<_>>());
    out.set("history", main.history.clone());
    // Every evaluated configuration (metaheuristics) for scatter plots, capped for transfer size.
    let evald: Vec<Value> = if grid_alg { Vec::new() } else { main.refined.iter().take(4000).map(cand_json).collect() };
    out.set("evaluated", evald);

    // Ranked feasible systems: the overall table.
    let mut feas: Vec<Candidate> = Vec::new();
    let mut seen = BTreeSet::new();   // de-duplicate revisited points
    for c in main.grid.iter().chain(&main.refined) {
        if c.feasible && seen.insert(size_key(&c.s)) { feas.push(c.clone()); }
    }
    cxxsort::sort(&mut feas, |a, b| score(a, &o.objective) < score(b, &o.objective));
    out.set("ranked", feas.iter().take(100).map(cand_json).collect::<Vec<_>>());
    out.set("n_feasible", feas.len());
    out.set("n_evaluated", main.grid.len() + main.refined.len());

    // Pareto front: MOPSO archive, otherwise the lowest LCOE for each renewable fraction among feasible points.
    let mut pareto = Vec::new();
    if !main.archive.is_empty() {
        cxxsort::sort(&mut main.archive, |a, b| a.re < b.re);
        pareto.extend(main.archive.iter().map(cand_json));
    } else {
        cxxsort::sort(&mut feas, |a, b| a.re > b.re || (a.re == b.re && a.lcoe < b.lcoe));
        let mut best_lcoe = f64::INFINITY;
        for c in &feas { if c.lcoe < best_lcoe - 1e-12 { best_lcoe = c.lcoe; pareto.push(cand_json(c)); } }
    }
    out.set("pareto", pareto);

    out.set("baseline", result_to_json(&main.base, false));
    if main.found {
        let b = &main.best;
        out.set("best", cand_json(b));
        let (tp, tb) = ((o.pv_max - o.pv_min) * 0.01, (o.bess_max - o.bess_min) * 0.01);
        let mut edge: Vec<Value> = Vec::new();
        if o.algorithm != "mopso" {
            if o.pv_max > o.pv_min && b.s.pv_kwp >= o.pv_max - tp && b.s.pv_kwp < o.max_pv_kwp - tp { edge.push("pv_max".into()); }
            if o.bess_max > o.bess_min && b.s.bess_kwh >= o.bess_max - tb { edge.push("bess_max".into()); }
            if o.pv_min > 0.0 && b.s.pv_kwp <= o.pv_min + tp { edge.push("pv_min".into()); }
            if o.bess_min > 0.0 && b.s.bess_kwh <= o.bess_min + tb { edge.push("bess_min".into()); }
        }
        out.set("at_boundary", edge);
        let si = SimInput { pv_per_kwp: &inp.pv, pv_clip_per_kwp: &inp.clip, pv_cs_per_kwp: &inp.cs, wind_per_turbine: &inp.wind, forecast: None };
        let full = simulate(p0, &si, &b.s, true)?;
        out.set("best_detail", result_to_json(&full, true));
        out.set("comparison", comparison_to_json(&compare(&full, &main.base)));
    } else {
        out.set("best", Value::Null);
    }

    if sens {
        let mut rows = Vec::new();
        for &val in &o.sens_values {
            if prog.cancel.load(Relaxed) { break; }
            let mut p = p0.clone();
            eval::apply_sensitivity(&mut p, &o.sens_var, val);
            let so = search(&p, &inp, o, prog, false)?;
            let mut row = Value::object();
            row.set("value", val);
            row.set("best", if so.found { cand_json(&so.best) } else { Value::Null });
            row.set("baseline_npc", so.base.econ.npc);
            row.set("baseline_lcoe", so.base.econ.lcoe);
            rows.push(row);
        }
        let mut s = Value::object();
        s.set("variable", o.sens_var.as_str());
        s.set("rows", rows);
        out.set("sensitivity", s);
    }
    out.set("cancelled", prog.cancel.load(Relaxed));
    prog.done.store(prog.total.load(Relaxed), Relaxed);
    Ok(out)
}
