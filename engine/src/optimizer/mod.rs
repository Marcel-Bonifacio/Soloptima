//! PV / BESS sizing for a known load and a known diesel fleet, or a range of genset counts and unit ratings (src/optimizer.{hpp,cpp}).
//! Grid: exhaustive (PV kWp x BESS kWh x C-rate x genset units x unit rating) + Hooke-Jeeves pattern search, in parallel (rayon).
//! Metaheuristics from the literature: PSO, MOPSO (cost vs renewable fraction, SSSI, LPSP or CO2) and hybrid SHO-QAO-GOA, also
//! over the C-rate range and the number of wind turbines, optionally repeated with several seeds. Optional sensitivity: repeat
//! the search for each value of one input, and a two-way map over the values of two inputs.
//! Batch runs of many independent simulations with overrides (batch.rs). Results equal the C++ engine's to the byte with
//! the same seed, whatever the number of threads.
mod batch;
mod cxxsort;
mod eval;
mod meta;
mod search;

pub use batch::run_batch;
pub use meta::{hypervolume, spacing};

use crate::json::{fmt_g, Error, Value};
use crate::model::Project;
use crate::pv::{clearsky_pv_per_kwp, compute_pv_profile, wind_per_turbine};
use crate::sim::{clamp, comparison_to_json, compare, mx, result_to_json, simulate};
use eval::{cand_json, check_sensitivity, linspace, score, size_key, type_key, type_label, Candidate, SENS_VARS};
use search::{search, Inputs, SearchOut};
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
    /// unserved deferrable energy / its demand, in every simulated year (None: max_unmet)
    pub max_dl_unmet: Option<f64>,
    /// steps a year in which PV and wind fall faster than their ramp limit allows, worst year (None: no limit; with the limit on)
    pub max_ramp_viol: Option<f64>,
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
    /// capex per kWh and kW and replacement price), bess_replace_soh, pv_degradation, diesel_om_unit_hour, irradiance_scale
    /// (x GHI and its diffuse part before the PV model), wind_speed_scale (x wind speed before the power curve)
    pub sens_var: String,
    pub sens_values: Vec<f64>,
    /// grid (exhaustive + pattern search) | pso | mopso | hshoa (SHO + QAO + GOA)
    pub algorithm: String,
    pub particles: i32, pub iterations: i32,
    pub seed: u32,
    /// wind turbine count range (metaheuristics)
    pub wind_min: i32, pub wind_max: i32,
    /// MOPSO second objective: re | sssi (maximised) | lpsp | co2 (minimised)
    pub mo_second: String,
    /// search the number of gensets in the main group (the first of a mixed fleet) from gen_units_min to gen_units_max;
    /// off, every candidate runs the project's fleet
    pub size_gensets: bool,
    pub gen_units_min: i32, pub gen_units_max: i32,
    /// days the battery alone must carry the load (0: no constraint), and that load in kW (0: the year-1 mean load)
    pub min_autonomy_days: f64, pub autonomy_load_kw: f64,
    /// two-way map: two sensitivity variables and their values (empty: no map); per cell the whole search again ("optimize") or
    /// the best design of each system type of the main search simulated again ("fixed")
    pub map_x: String, pub map_x_values: Vec<f64>,
    pub map_y: String, pub map_y_values: Vec<f64>,
    pub map_mode: String,
    /// unit ratings to search for the main genset group (empty: the project's rating), sorted by rating
    pub gen_ratings: Vec<GenRating>,
    /// independent runs of a metaheuristic, each with its own seed from `seed` (1: one run)
    pub repeat_runs: i32,
    /// MOPSO: the quality of the front (spacing, hypervolume) and the cheapest front design at each LPSP target
    pub pareto_stats: bool,
    /// MOPSO: the design reported as best, the knee point ("knee") or the fuzzy best compromise ("fuzzy")
    pub mo_pick: String,
}

/// One unit rating the search may give the main genset group. Missing values keep the project's: its minimum load, its fuel
/// curve (per kW, so it scales with the rating), its genset capex and O&M per run hour.
#[derive(Debug, Clone, Default)]
pub struct GenRating {
    pub kw: f64,
    pub min_load: Option<f64>,
    /// (load fraction, kWh per litre); empty: the project's fuel model
    pub fuel_curve: Vec<(f64, f64)>,
    pub capex_kw: Option<f64>,
    pub om_unit_hour: Option<f64>,
    /// the datasheet's name and id in the equipment library, when it came from there
    pub name: String,
    pub id: String,
}

impl Default for OptSettings {
    fn default() -> Self {
        OptSettings {
            pv_min: 0.0, pv_max: 0.0, pv_steps: 16, bess_min: 0.0, bess_max: 0.0, bess_steps: 12, c_rates: vec![0.5],
            objective: "npc".into(), max_unmet: 0.001, max_dl_unmet: None, max_ramp_viol: None, max_lole_h: -1.0, max_reserve_short_h: -1.0, min_re: 0.0, max_curtail: 1.0,
            max_pv_kwp: f64::INFINITY, max_capex: f64::INFINITY, refine: true, threads: 0, sens_var: String::new(),
            sens_values: Vec::new(), algorithm: "grid".into(), particles: 24, iterations: 40, seed: 42, wind_min: 0, wind_max: 0,
            mo_second: "re".into(), size_gensets: false, gen_units_min: 0, gen_units_max: 0, min_autonomy_days: 0.0, autonomy_load_kw: 0.0,
            map_x: String::new(), map_x_values: Vec::new(), map_y: String::new(), map_y_values: Vec::new(), map_mode: "optimize".into(),
            gen_ratings: Vec::new(), repeat_runs: 1, pareto_stats: false, mo_pick: "knee".into(),
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
    if let Value::Num(x) = v.at("max_dl_unmet") { o.max_dl_unmet = Some(*x); }
    if let Value::Num(x) = v.at("max_ramp_viol") { o.max_ramp_viol = Some(*x); }
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
    // genset units: both bounds default to the project's count; checked only when the search uses them
    o.size_gensets = v.getb("size_gensets", false);
    let (lo, hi) = (v.get("gen_units_min", f64::from(p.dg.units)), v.get("gen_units_max", f64::from(p.dg.units)));
    if o.size_gensets {
        if !(lo >= 0.0 && hi >= 0.0) { return Err(Error("The genset unit counts must not be negative.".into())); }
        if lo > hi { return Err(Error("The least number of genset units must not exceed the most.".into())); }
        if hi > 1000.0 { return Err(Error("At most 1000 genset units.".into())); }
    }
    (o.gen_units_min, o.gen_units_max) = (lo.round() as i32, hi.round() as i32);
    o.min_autonomy_days = v.get("min_autonomy_days", 0.0);
    o.autonomy_load_kw = v.get("autonomy_load_kw", 0.0);
    if !(0.0..=30.0).contains(&o.min_autonomy_days) { return Err(Error("Days of autonomy must be 0 (none) to 30.".into())); }
    if !(o.autonomy_load_kw.is_finite() && o.autonomy_load_kw >= 0.0) { return Err(Error("The load for the days of autonomy must not be negative.".into())); }
    o.map_x = v.gets("map_x", "");
    o.map_y = v.gets("map_y", "");
    o.map_x_values = v.getv("map_x_values");
    o.map_y_values = v.getv("map_y_values");
    o.map_mode = v.gets("map_mode", &o.map_mode);
    if !o.map_x.is_empty() || !o.map_y.is_empty() {
        for (var, vals) in [(&o.map_x, &o.map_x_values), (&o.map_y, &o.map_y_values)] {
            if !SENS_VARS.contains(&var.as_str()) {
                return Err(Error(format!("Unknown map variable: {}", var.chars().take(40).collect::<String>())));
            }
            if vals.is_empty() || vals.len() > 10 || !vals.iter().all(|x| x.is_finite()) {
                return Err(Error("A map needs 1 to 10 numbers for each of its two variables.".into()));
            }
            for &x in vals.iter() { check_sensitivity(var, x)?; }
        }
        if o.map_x == o.map_y { return Err(Error("The two map variables must differ.".into())); }
        if o.map_mode != "optimize" && o.map_mode != "fixed" { return Err(Error("The map mode must be optimize or fixed.".into())); }
    }
    o.gen_ratings = parse_ratings(v.at("gen_ratings"))?;
    let runs = v.get("repeat_runs", 1.0);
    if !(runs.fract() == 0.0 && (1.0..=50.0).contains(&runs)) { return Err(Error("Repeat runs must be a whole number from 1 to 50.".into())); }
    o.repeat_runs = runs as i32;
    o.pareto_stats = v.getb("pareto_stats", false);
    o.mo_pick = v.gets("mo_pick", &o.mo_pick);
    if o.mo_pick != "knee" && o.mo_pick != "fuzzy" { return Err(Error("The best compromise must be knee or fuzzy.".into())); }
    Ok(o)
}

/// The unit ratings to search: at most 12, each above 0 kW, with an optional minimum load, fuel curve and costs; sorted by
/// rating so the metaheuristics can treat the list as an integer dimension
fn parse_ratings(v: &Value) -> Result<Vec<GenRating>, Error> {
    if v.is_null() { return Ok(Vec::new()); }
    if !v.is_array() || v.len() > 12 { return Err(Error("Genset unit ratings: a list of at most 12.".into())); }
    let mut out = Vec::new();
    for r in v.arr() {
        let num = |k: &str| if r.at(k).is_null() { None } else { Some(r.get(k, f64::NAN)) };
        let g = GenRating {
            kw: r.get("kw", f64::NAN), min_load: num("min_load"), capex_kw: num("capex_kw"), om_unit_hour: num("om_unit_hour"),
            fuel_curve: crate::parse::fuel_curve(r.at("fuel_curve")).unwrap_or_default(),
            name: r.gets("name", "").chars().take(80).collect(), id: r.gets("id", "").chars().take(80).collect(),
        };
        let name = if g.name.is_empty() { format!("{} kW", fmt_g(g.kw, 6)) } else { g.name.clone() };
        if !(g.kw > 0.0 && g.kw <= 1e5) { return Err(Error("Genset unit ratings must be above 0 and at most 100 000 kW.".into())); }
        if !g.min_load.is_none_or(|m| (0.0..1.0).contains(&m)) { return Err(Error(format!("Genset rating {name}: the minimum load must be at least 0 % and below 100 %."))); }
        if !r.at("fuel_curve").is_empty() && g.fuel_curve.len() < 2 { return Err(Error(format!("Genset rating {name}: the fuel curve needs at least 2 points."))); }
        if ![g.capex_kw, g.om_unit_hour].iter().all(|c| c.is_none_or(|x| x.is_finite() && x >= 0.0)) {
            return Err(Error(format!("Genset rating {name}: costs must be non-negative.")));
        }
        out.push(g);
    }
    out.sort_by(|a, b| a.kw.partial_cmp(&b.kw).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// The project with the main genset group at unit rating `r`: its rating, and its minimum load, fuel curve and costs where given
pub(crate) fn rated(p: &Project, r: &GenRating) -> Project {
    let mut q = p.clone();
    q.dg.unit_kw = r.kw;
    if let Some(m) = r.min_load { q.dg.min_load = m; }
    if !r.fuel_curve.is_empty() { q.dg.fuel_model = "table".into(); q.dg.fuel_curve = r.fuel_curve.clone(); }
    if let Some(c) = r.capex_kw { q.econ.diesel_capex_kw = c; }
    if let Some(c) = r.om_unit_hour { q.econ.diesel_om_unit_hour = c; }
    q
}

/// The rating indices the grid search runs: every candidate rating, else one entry for the project's rating
pub(crate) fn rating_idx(o: &OptSettings) -> Vec<Option<usize>> {
    if o.gen_ratings.is_empty() { vec![None] } else { (0..o.gen_ratings.len()).map(Some).collect() }
}

/// The genset counts the grid search runs: the range when sized, else one entry for the project's fleet
pub(crate) fn gen_counts(o: &OptSettings) -> Vec<Option<i32>> {
    if o.size_gensets { (o.gen_units_min..=o.gen_units_max).map(Some).collect() } else { vec![None] }
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
    if o.size_gensets { s.set("size_gensets", true); s.set("gen_units_min", o.gen_units_min); s.set("gen_units_max", o.gen_units_max); }
    if o.min_autonomy_days > 0.0 { s.set("min_autonomy_days", o.min_autonomy_days); s.set("autonomy_load_kw", o.autonomy_load_kw); }
    if let Some(x) = o.max_dl_unmet { s.set("max_dl_unmet", x); }
    if let Some(x) = o.max_ramp_viol { s.set("max_ramp_viol", x); }
    if !o.gen_ratings.is_empty() {
        s.set("gen_ratings", o.gen_ratings.iter().map(|r| {
            let mut v = Value::object();
            v.set("kw", r.kw); v.set("name", r.name.as_str()); v.set("id", r.id.as_str()); v.set("own_fuel_curve", !r.fuel_curve.is_empty());
            if let Some(m) = r.min_load { v.set("min_load", m); }
            if let Some(c) = r.capex_kw { v.set("capex_kw", c); }
            if let Some(c) = r.om_unit_hour { v.set("om_unit_hour", c); }
            v
        }).collect::<Vec<_>>());
    }
    if o.repeat_runs > 1 && o.algorithm != "grid" { s.set("repeat_runs", o.repeat_runs); }
    if o.algorithm == "mopso" && o.pareto_stats { s.set("pareto_stats", true); }
    if o.algorithm == "mopso" && o.mo_pick != "knee" { s.set("mo_pick", o.mo_pick.as_str()); }
    if map_on(o) {
        s.set("map_x", o.map_x.as_str()); s.set("map_x_values", o.map_x_values.clone());
        s.set("map_y", o.map_y.as_str()); s.set("map_y_values", o.map_y_values.clone()); s.set("map_mode", o.map_mode.as_str());
    }
    s
}

fn map_on(o: &OptSettings) -> bool { !o.map_x.is_empty() && !o.map_y.is_empty() }

/// The per-unit inputs of the project: PV per kWp and its clipping, the clear-sky reference, and wind per turbine when needed
fn inputs(p: &Project, o: &OptSettings) -> Result<Inputs, Error> {
    // Turbines (and the EMS's wind forecast) need the output per turbine
    let needs_wind = p.dg.strategy == "predictive" || p.wind.units > 0 || o.wind_max > 0;
    let prof = compute_pv_profile(p)?;
    Ok(Inputs {
        pv: prof.ac_per_kwp,
        clip: prof.clip_per_kwp,
        cs: clearsky_pv_per_kwp(p)?,
        wind: if needs_wind { wind_per_turbine(p)? } else { Vec::new() },
    })
}

/// The inputs again where a resource scale among `vars` changed them (the PV output for the irradiance, the turbine output for
/// the wind speed); None when the base inputs still hold. The clear-sky reference is never scaled.
fn rescaled(p: &Project, base: &Inputs, vars: &[&str]) -> Result<Option<Inputs>, Error> {
    let (irr, wind) = (vars.contains(&"irradiance_scale"), vars.contains(&"wind_speed_scale") && !base.wind.is_empty());
    if !irr && !wind { return Ok(None); }
    let mut i = base.clone();
    if irr { let prof = compute_pv_profile(p)?; (i.pv, i.clip) = (prof.ac_per_kwp, prof.clip_per_kwp); }
    if wind { i.wind = wind_per_turbine(p)?; }
    Ok(Some(i))
}

/// The full result: grid, ranked table, Pareto set, best system with hourly detail, sensitivity table (run `validate_project` first)
pub fn optimize(p0: &Project, o: &OptSettings, prog: &Progress) -> Result<Value, Error> {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(o.threads.max(0) as usize).build().map_err(|e| Error(e.to_string()))?;
    pool.install(|| run(p0, o, prog))
}

fn run(p0: &Project, o: &OptSettings, prog: &Progress) -> Result<Value, Error> {
    let grid_alg = o.algorithm == "grid";
    let per_run = if grid_alg {
        i64::from(o.pv_steps.max(1)) * i64::from(o.bess_steps.max(1)) * o.c_rates.len() as i64 * gen_counts(o).len() as i64 * rating_idx(o).len() as i64
    } else { 0 };
    let sens = !o.sens_var.is_empty() && !o.sens_values.is_empty();
    let cells = if map_on(o) && o.map_mode == "optimize" { (o.map_x_values.len() * o.map_y_values.len()) as i64 } else { 0 };
    prog.total.store(per_run * (if sens { o.sens_values.len() as i64 + 1 } else { 1 } + cells), Relaxed);
    prog.done.store(0, Relaxed);

    let inp = inputs(p0, o)?;
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
        if c.feasible && seen.insert(size_key(&c.s, c.rating())) { feas.push(c.clone()); }
    }
    cxxsort::sort(&mut feas, |a, b| score(a, &o.objective) < score(b, &o.objective));
    out.set("ranked", feas.iter().take(100).map(cand_json).collect::<Vec<_>>());
    out.set("n_feasible", feas.len());
    out.set("n_evaluated", main.grid.len() + main.refined.len());
    // the best design of each system type; only with genset sizing, so other runs answer as before to the byte
    if o.size_gensets || !o.gen_ratings.is_empty() { out.set("architectures", eval::architectures(p0, o, main.grid.iter().chain(&main.refined))); }
    if let Some(r) = main.runs.take() { out.set("runs", r); }

    // Pareto front: MOPSO archive, otherwise the lowest LCOE for each renewable fraction among feasible points.
    let mut pareto = Vec::new();
    if !main.archive.is_empty() {
        if meta::mo_natural(o) { cxxsort::sort(&mut main.archive, |a, b| a.re < b.re); }
        else { cxxsort::sort(&mut main.archive, |a, b| meta::mo_objs(a, o).1 < meta::mo_objs(b, o).1); }
        pareto.extend(main.archive.iter().map(cand_json));
        if o.pareto_stats {
            if let Some(q) = main.quality.take() { out.set("pareto_quality", q); }
            out.set("lpsp_table", meta::lpsp_table(&main.archive, o));
        }
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
            if o.size_gensets && o.gen_units_max > o.gen_units_min {
                if b.s.gen_units == Some(o.gen_units_max) { edge.push("gen_max".into()); }
                if o.gen_units_min > 0 && b.s.gen_units == Some(o.gen_units_min) { edge.push("gen_min".into()); }
            }
            // the rating search: the best at the largest or smallest rating listed
            if let (Some(k), true) = (b.rating(), o.gen_ratings.len() > 1) {
                let kw = o.gen_ratings[k].kw;
                if o.gen_ratings.iter().all(|r| r.kw <= kw) { edge.push("rating_max".into()); }
                if o.gen_ratings.iter().all(|r| r.kw >= kw) { edge.push("rating_min".into()); }
            }
        }
        out.set("at_boundary", edge);
        let pb = b.rating().map(|k| rated(p0, &o.gen_ratings[k]));
        let full = simulate(pb.as_ref().unwrap_or(p0), &inp.sim(None), &b.s, true)?;
        out.set("best_detail", result_to_json(&full, true));
        out.set("comparison", comparison_to_json(&compare(&full, &main.base)));
    } else {
        out.set("best", Value::Null);
    }

    if sens {
        let mut rows = Vec::new();
        for &val in &o.sens_values {
            if prog.cancel.load(Relaxed) { break; }
            let (p, own) = variant(p0, &inp, &[(&o.sens_var, val)])?;
            let so = search(&p, own.as_ref().unwrap_or(&inp), o, prog, false)?;
            let mut row = Value::object();
            row.set("value", val);
            row.set("best", best_json(&so));
            row.set("baseline_npc", so.base.econ.npc);
            row.set("baseline_lcoe", so.base.econ.lcoe);
            rows.push(row);
        }
        let mut s = Value::object();
        s.set("variable", o.sens_var.as_str());
        s.set("rows", rows);
        out.set("sensitivity", s);
    }
    if map_on(o) { out.set("map", two_way_map(p0, o, prog, &inp, &main)?); }
    out.set("cancelled", prog.cancel.load(Relaxed));
    prog.done.store(prog.total.load(Relaxed), Relaxed);
    Ok(out)
}

/// The project with sensitivity variables set to these values, and its own inputs when the values change them
fn variant(p0: &Project, inp: &Inputs, vars: &[(&str, f64)]) -> Result<(Project, Option<Inputs>), Error> {
    let mut p = p0.clone();
    for &(k, v) in vars { eval::apply_sensitivity(&mut p, k, v); }
    let names: Vec<&str> = vars.iter().map(|v| v.0).collect();
    let own = rescaled(&p, inp, &names)?;
    Ok((p, own))
}

/// The best design a search found, or null
fn best_json(so: &SearchOut) -> Value { if so.found { cand_json(&so.best) } else { Value::Null } }

/// The two-way map: for each pair of values of the two variables (rows by the second, columns by the first), the whole search
/// again, or, in "fixed" mode, the best design of each system type the main search found simulated again with the cell's
/// inputs. Each cell gives the winning design, its system type and the diesel-only NPC; cells not reached after a cancel are null.
fn two_way_map(p0: &Project, o: &OptSettings, prog: &Progress, inp: &Inputs, main: &SearchOut) -> Result<Value, Error> {
    let fixed = o.map_mode == "fixed";
    let designs: Vec<(String, &Candidate)> = if fixed {
        eval::best_by_type(p0, o, main.grid.iter().chain(&main.refined)).into_iter().filter_map(|(k, t)| t.2.map(|c| (type_label(k), c))).collect()
    } else { Vec::new() };
    let sizes: Vec<_> = designs.iter().map(|d| (d.1.s, d.1.rating())).collect();
    if fixed { prog.total.fetch_add((sizes.len() * o.map_x_values.len() * o.map_y_values.len()) as i64, Relaxed); }
    let mut rows = Vec::new();
    for &vy in &o.map_y_values {
        let mut row = Vec::new();
        for &vx in &o.map_x_values {
            if prog.cancel.load(Relaxed) { row.push(Value::Null); continue; }
            let (p, own) = variant(p0, inp, &[(&o.map_x, vx), (&o.map_y, vy)])?;
            let inp = own.as_ref().unwrap_or(inp);
            let mut cell = Value::object();
            if fixed {
                let (base, cands) = search::evaluate_sizes(&p, inp, o, prog, &sizes)?;
                let win = cands.iter().enumerate().filter(|c| c.1.feasible)
                    .min_by(|a, b| score(a.1, &o.objective).partial_cmp(&score(b.1, &o.objective)).unwrap_or(std::cmp::Ordering::Equal));
                cell.set("best", win.map_or(Value::Null, |w| cand_json(w.1)));
                cell.set("type", win.map_or(Value::Null, |w| designs[w.0].0.as_str().into()));
                cell.set("npc", cands.iter().map(|c| c.npc).collect::<Vec<_>>());
                cell.set("feasible", Value::Arr(cands.iter().map(|c| c.feasible.into()).collect()));
                cell.set("baseline_npc", base.econ.npc);
            } else {
                let so = search(&p, inp, o, prog, false)?;
                if prog.cancel.load(Relaxed) { row.push(Value::Null); continue; }   // a search cut short is no result
                cell.set("best", best_json(&so));
                cell.set("type", if so.found { type_label(type_key(&p, &so.best.s)).into() } else { Value::Null });
                cell.set("baseline_npc", so.base.econ.npc);
            }
            row.push(cell);
        }
        rows.push(Value::Arr(row));
    }
    let mut m = Value::object();
    m.set("x", o.map_x.as_str()); m.set("x_values", o.map_x_values.clone());
    m.set("y", o.map_y.as_str()); m.set("y_values", o.map_y_values.clone());
    m.set("mode", o.map_mode.as_str());
    if fixed {
        m.set("designs", Value::Arr(designs.iter().map(|(l, c)| { let mut v = cand_json(c); v.set("type", l.as_str()); v }).collect()));
    }
    m.set("cells", rows);
    Ok(m)
}
