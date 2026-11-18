//! One search over the sizes of one project: the baseline, then the grid with pattern search or a metaheuristic (meta.rs).
//! Candidates are simulated in parallel; each result goes to the slot of its index, so the order never depends on threads.
use super::eval::{evaluate, linspace, score, Candidate, Ctx};
use super::{gen_counts, meta, rated, rating_idx, OptSettings, Progress};
use crate::forecast::Forecaster;
use crate::json::{Error, Value};
use crate::model::Project;
use crate::sim::{clamp, mx, simulate, Forecast, SimInput, SimResult, Sizing};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;

/// The per-unit inputs of every simulation: AC output per kWp, its clear-sky reference, output per turbine (empty when no
/// candidate has turbines and the EMS needs no wind forecast)
#[derive(Clone)]
pub(crate) struct Inputs {
    pub pv: Vec<f64>,
    pub clip: Vec<f64>,
    pub cs: Vec<f64>,
    pub wind: Vec<f64>,
}

impl Inputs {
    /// The simulation inputs, with the forecasts of a predictive EMS when given
    pub fn sim<'a>(&'a self, forecast: Option<&'a dyn Forecast>) -> SimInput<'a> {
        SimInput { pv_per_kwp: &self.pv, pv_clip_per_kwp: &self.clip, pv_cs_per_kwp: &self.cs, wind_per_turbine: &self.wind, forecast }
    }
}

#[derive(Default)]
pub(crate) struct SearchOut {
    pub grid: Vec<Candidate>,
    pub refined: Vec<Candidate>,
    pub archive: Vec<Candidate>,
    pub history: Vec<f64>,
    pub best: Candidate,
    pub found: bool,
    pub base: SimResult,
    /// statistics of repeated metaheuristic runs (with more than one run only)
    pub runs: Option<Value>,
    /// MOPSO front quality (with the front statistics only)
    pub quality: Option<Value>,
}

/// A size and the index of its genset rating among the candidates (None: the project's rating)
pub(crate) type Pick = (Sizing, Option<usize>);

/// Simulates the sizes in parallel, in order; with `on_cancel`, sizes reached after a cancel get that candidate instead
pub(crate) fn par_eval(cx: &Ctx, sizes: &[Pick], on_cancel: Option<fn(&Pick) -> Candidate>) -> Result<Vec<Candidate>, Error> {
    sizes.par_iter().map(|s| {
        let c = match on_cancel {
            Some(f) if cx.prog.cancel.load(Relaxed) => f(s),
            _ => evaluate(cx, &s.0, s.1)?,
        };
        cx.prog.done.fetch_add(1, Relaxed);
        Ok(c)
    }).collect()
}

pub(crate) fn keep_best(v: &[Candidate], obj: &str, best: &mut Candidate, found: &mut bool) {
    for c in v {
        if c.feasible && (!*found || score(c, obj) < score(best, obj)) { *best = c.clone(); *found = true; }
    }
}

/// The given sizes of one project simulated against its own diesel-only baseline (the fixed designs of a two-way map)
pub(crate) fn evaluate_sizes(p: &Project, inp: &Inputs, o: &OptSettings, prog: &Progress, sizes: &[Pick]) -> Result<(SimResult, Vec<Candidate>), Error> {
    with_ctx(p, inp, o, prog, |cx| par_eval(cx, sizes, None))
}

/// What every search of a project shares: one forecaster, the diesel-only baseline and the project at each genset rating.
/// Runs `f` with them and returns the baseline with its answer.
fn with_ctx<T>(p: &Project, inp: &Inputs, o: &OptSettings, prog: &Progress, f: impl FnOnce(&Ctx) -> Result<T, Error>) -> Result<(SimResult, T), Error> {
    let fc = forecaster(p, inp);
    let base = simulate(p, &inp.sim(fc.as_ref().map(|f| f as _)), &Sizing::default(), false)?;
    let rated = rated_all(p, o);
    let cx = Ctx { p, o, prog, pv: &inp.pv, clip: &inp.clip, cs: &inp.cs, wind: &inp.wind, fc: fc.as_ref(), base: &base, rated: &rated };
    let t = f(&cx)?;
    Ok((base, t))
}

/// Forecasts do not depend on the system size, so one forecaster serves every candidate
fn forecaster(p: &Project, inp: &Inputs) -> Option<Forecaster> {
    if p.dg.strategy == "predictive" { Some(Forecaster::new(&p.ems, &inp.pv, &inp.cs, &p.load_kw, &inp.wind)) } else { None }
}

/// The project at each candidate genset rating, from the project of this search (so a sensitivity value carries over)
fn rated_all(p: &Project, o: &OptSettings) -> Vec<Project> { o.gen_ratings.iter().map(|r| rated(p, r)).collect() }

pub(crate) fn search(p: &Project, inp: &Inputs, o: &OptSettings, prog: &Progress, detail: bool) -> Result<SearchOut, Error> {
    let mut out = SearchOut::default();
    (out.base, ()) = with_ctx(p, inp, o, prog, |cx| if o.algorithm == "grid" { search_grid(cx, detail, &mut out) } else { meta::search_meta(cx, &mut out) })?;
    Ok(out)
}

/// Exhaustive PV x BESS x C-rate (x genset units x genset rating) grid, then Hooke-Jeeves pattern search in continuous
/// (PV, BESS) space at the best C-rate, genset count and rating
fn search_grid(cx: &Ctx, detail: bool, out: &mut SearchOut) -> Result<(), Error> {
    let (o, prog) = (cx.o, cx.prog);
    let pvs = linspace(o.pv_min, o.pv_max, o.pv_steps);
    let bes = linspace(o.bess_min, o.bess_max, o.bess_steps);
    let (gens, rats) = (gen_counts(o), rating_idx(o));
    let plane = pvs.len() * bes.len();
    let per_gen = plane * o.c_rates.len();   // the genset count and then the rating vary slowest, so one of each keeps the old order
    let per_rat = per_gen * gens.len();
    let n = per_rat * rats.len();
    let wind = f64::from(cx.p.wind.units.max(0));
    let cells: Vec<Option<Candidate>> = (0..n).into_par_iter().map(|k| {
        if prog.cancel.load(Relaxed) { return Ok(None); }
        let (ri, k) = (k / per_rat, k % per_rat);
        let (gi, k) = (k / per_gen, k % per_gen);
        let (ci, rem) = (k / plane, k % plane);
        let (i, j) = (rem / bes.len(), rem % bes.len());
        let s = Sizing { pv_kwp: pvs[i], bess_kwh: bes[j], bess_kw: bes[j] * o.c_rates[ci], wind_units: wind, gen_units: gens[gi] };
        let mut c = evaluate(cx, &s, rats[ri])?;
        c.crate_idx = ci; c.i = i as i32; c.j = j as i32;
        prog.done.fetch_add(1, Relaxed);
        Ok(Some(c))
    }).collect::<Result<_, Error>>()?;
    out.grid = cells.into_iter().flatten().collect();   // cells skipped after a cancel are left out
    keep_best(&out.grid, &o.objective, &mut out.best, &mut out.found);

    if !(o.refine && out.found && !prog.cancel.load(Relaxed)) { return Ok(()); }
    let better = |a: &Candidate, b: &Candidate| score(a, &o.objective) < score(b, &o.objective);
    let (cr, gu, rt) = (o.c_rates[out.best.crate_idx], out.best.s.gen_units, out.best.rating());
    let mut dpv = if pvs.len() > 1 { (pvs[1] - pvs[0]) / 2.0 } else { 0.0 };
    let mut dbe = if bes.len() > 1 { (bes[1] - bes[0]) / 2.0 } else { 0.0 };
    let tol_pv = mx(1.0, (o.pv_max - o.pv_min) * 0.002);
    let tol_be = mx(1.0, (o.bess_max - o.bess_min) * 0.002);
    let mut cur = out.best.clone();
    // pattern points already simulated, by exact (PV, BESS); + 0.0 makes -0 and 0 one key, as in the C++ std::map
    let key = |s: &Pick| ((s.0.pv_kwp + 0.0).to_bits(), (s.0.bess_kwh + 0.0).to_bits());
    let mut memo: HashMap<(u64, u64), Candidate> = HashMap::new();
    let mut iter = 0;
    while iter < 60 && (dpv > tol_pv || dbe > tol_be) && !prog.cancel.load(Relaxed) {
        let mut trial = Vec::new();
        for a in -1..=1 {
            for b in -1..=1 {
                if a == 0 && b == 0 { continue; }
                let pk = clamp(cur.s.pv_kwp + f64::from(a) * dpv, o.pv_min, o.pv_max);
                let bk = clamp(cur.s.bess_kwh + f64::from(b) * dbe, o.bess_min, o.bess_max);
                trial.push((Sizing { pv_kwp: pk, bess_kwh: bk, bess_kw: bk * cr, wind_units: wind, gen_units: gu }, rt));
            }
        }
        let mut todo = Vec::new();
        for s in &trial {
            if let std::collections::hash_map::Entry::Vacant(e) = memo.entry(key(s)) { e.insert(Candidate::default()); todo.push(*s); }
        }
        prog.total.fetch_add(trial.len() as i64, Relaxed);
        let res = par_eval(cx, &todo, None)?;
        prog.done.fetch_add((trial.len() - todo.len()) as i64, Relaxed);
        for (s, mut c) in todo.iter().zip(res) { c.crate_idx = cur.crate_idx; memo.insert(key(s), c); }
        let mut improved = false;
        for s in &trial {
            let c = &memo[&key(s)];
            if detail { out.refined.push(c.clone()); }
            if better(c, &cur) { cur = c.clone(); improved = true; }
        }
        if !improved { dpv /= 2.0; dbe /= 2.0; }
        iter += 1;
    }
    out.best = cur;
    Ok(())
}
