//! One search over the sizes of one project: the baseline, then the grid with pattern search or a metaheuristic (meta.rs).
//! Candidates are simulated in parallel; each result goes to the slot of its index, so the order never depends on threads.
use super::eval::{evaluate, linspace, score, Candidate, Ctx};
use super::{meta, OptSettings, Progress};
use crate::forecast::Forecaster;
use crate::json::Error;
use crate::model::Project;
use crate::sim::{clamp, mx, simulate, SimInput, SimResult, Sizing};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;

/// The per-unit inputs of every simulation: AC output per kWp, its clear-sky reference, output per turbine (empty when no
/// candidate has turbines and the EMS needs no wind forecast)
pub(crate) struct Inputs {
    pub pv: Vec<f64>,
    pub cs: Vec<f64>,
    pub wind: Vec<f64>,
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
}

/// Simulates the sizes in parallel, in order; with `on_cancel`, sizes reached after a cancel get that candidate instead
pub(crate) fn par_eval(cx: &Ctx, sizes: &[Sizing], on_cancel: Option<fn(&Sizing) -> Candidate>) -> Result<Vec<Candidate>, Error> {
    sizes.par_iter().map(|s| {
        let c = match on_cancel {
            Some(f) if cx.prog.cancel.load(Relaxed) => f(s),
            _ => evaluate(cx, s)?,
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

pub(crate) fn search(p: &Project, inp: &Inputs, o: &OptSettings, prog: &Progress, detail: bool) -> Result<SearchOut, Error> {
    // Forecasts do not depend on the system size, so one forecaster serves every candidate.
    let fc = if p.dg.strategy == "predictive" { Some(Forecaster::new(&p.ems, &inp.pv, &inp.cs, &p.load_kw, &inp.wind)) } else { None };
    let mut out = SearchOut::default();
    let si = SimInput { pv_per_kwp: &inp.pv, pv_cs_per_kwp: &inp.cs, wind_per_turbine: &inp.wind, forecast: fc.as_ref().map(|f| f as _) };
    out.base = simulate(p, &si, &Sizing::default(), false)?;
    let base = out.base.clone();
    let cx = Ctx { p, o, prog, pv: &inp.pv, cs: &inp.cs, wind: &inp.wind, fc: fc.as_ref(), base: &base };
    if o.algorithm == "grid" { search_grid(&cx, detail, &mut out)?; } else { meta::search_meta(&cx, &mut out)?; }
    Ok(out)
}

/// Exhaustive PV x BESS x C-rate grid, then Hooke-Jeeves pattern search in continuous (PV, BESS) space at the best C-rate
fn search_grid(cx: &Ctx, detail: bool, out: &mut SearchOut) -> Result<(), Error> {
    let (o, prog) = (cx.o, cx.prog);
    let pvs = linspace(o.pv_min, o.pv_max, o.pv_steps);
    let bes = linspace(o.bess_min, o.bess_max, o.bess_steps);
    let plane = pvs.len() * bes.len();
    let n = plane * o.c_rates.len();
    let wind = f64::from(cx.p.wind.units.max(0));
    let cells: Vec<Option<Candidate>> = (0..n).into_par_iter().map(|k| {
        if prog.cancel.load(Relaxed) { return Ok(None); }
        let (ci, rem) = (k / plane, k % plane);
        let (i, j) = (rem / bes.len(), rem % bes.len());
        let s = Sizing { pv_kwp: pvs[i], bess_kwh: bes[j], bess_kw: bes[j] * o.c_rates[ci], wind_units: wind };
        let mut c = evaluate(cx, &s)?;
        c.crate_idx = ci; c.i = i as i32; c.j = j as i32;
        prog.done.fetch_add(1, Relaxed);
        Ok(Some(c))
    }).collect::<Result<_, Error>>()?;
    out.grid = cells.into_iter().flatten().collect();   // cells skipped after a cancel are left out
    keep_best(&out.grid, &o.objective, &mut out.best, &mut out.found);

    if !(o.refine && out.found && !prog.cancel.load(Relaxed)) { return Ok(()); }
    let better = |a: &Candidate, b: &Candidate| score(a, &o.objective) < score(b, &o.objective);
    let cr = o.c_rates[out.best.crate_idx];
    let mut dpv = if pvs.len() > 1 { (pvs[1] - pvs[0]) / 2.0 } else { 0.0 };
    let mut dbe = if bes.len() > 1 { (bes[1] - bes[0]) / 2.0 } else { 0.0 };
    let tol_pv = mx(1.0, (o.pv_max - o.pv_min) * 0.002);
    let tol_be = mx(1.0, (o.bess_max - o.bess_min) * 0.002);
    let mut cur = out.best.clone();
    // pattern points already simulated, by exact (PV, BESS); + 0.0 makes -0 and 0 one key, as in the C++ std::map
    let key = |s: &Sizing| ((s.pv_kwp + 0.0).to_bits(), (s.bess_kwh + 0.0).to_bits());
    let mut memo: HashMap<(u64, u64), Candidate> = HashMap::new();
    let mut iter = 0;
    while iter < 60 && (dpv > tol_pv || dbe > tol_be) && !prog.cancel.load(Relaxed) {
        let mut trial = Vec::new();
        for a in -1..=1 {
            for b in -1..=1 {
                if a == 0 && b == 0 { continue; }
                let pk = clamp(cur.s.pv_kwp + f64::from(a) * dpv, o.pv_min, o.pv_max);
                let bk = clamp(cur.s.bess_kwh + f64::from(b) * dbe, o.bess_min, o.bess_max);
                trial.push(Sizing { pv_kwp: pk, bess_kwh: bk, bess_kw: bk * cr, wind_units: wind });
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
