//! Metaheuristics from the literature over a continuous decision vector [PV kWp, BESS kWh, C-rate?, wind turbines?, gensets?,
//! genset rating?]: PSO, MOPSO (cost against renewable fraction, SSSI, LPSP or CO2) and hybrid SHO-QAO-GOA. Random numbers as
//! libc++ draws them (std::mt19937 and uniform_real_distribution), in the C++ order; `std::sort` as libc++ orders ties
//! (cxxsort.rs). Optionally several independent runs, each with its own seed, with statistics over the runs; and for MOPSO
//! the quality of the front (spacing, hypervolume) and the cheapest front design at fixed LPSP targets.
use super::cxxsort;
use super::eval::{cand_json, score, size_key, Candidate, Ctx, SizeKey};
use super::search::{keep_best, par_eval, Pick, SearchOut};
use super::OptSettings;
use crate::forecast::rng::Mt19937;
use crate::json::{Error, Value};
use crate::sim::{clamp, mn, mx, Sizing};
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;

type Pop = Vec<Vec<f64>>;

pub(crate) struct Space {
    lo: Vec<f64>,
    hi: Vec<f64>,
    /// dimensions of the C-rate and the wind turbines when they are searched (else the lowest C-rate, no turbines)
    cr_dim: Option<usize>,
    wind_dim: Option<usize>,
    cr_fixed: f64,
    /// dimension of the genset count when it is searched; else the count every candidate uses (None: the project's fleet)
    gen_dim: Option<usize>,
    gen_fixed: Option<i32>,
    /// dimension of the genset rating (an index into the sorted candidates) when there are several; else the one rating
    rat_dim: Option<usize>,
    rat_fixed: Option<usize>,
}

impl Space {
    fn new(cx: &Ctx) -> Space {
        let (o, units) = (cx.o, cx.p.wind.units);
        let mut sp = Space {
            lo: vec![o.pv_min, o.bess_min], hi: vec![mx(o.pv_min + 1.0, o.pv_max), mx(o.bess_min + 1.0, o.bess_max)],
            cr_dim: None, wind_dim: None, cr_fixed: 0.5, gen_dim: None, gen_fixed: None, rat_dim: None, rat_fixed: None,
        };
        let crmin = o.c_rates.iter().copied().fold(o.c_rates[0], |a, b| if b < a { b } else { a });
        let crmax = o.c_rates.iter().copied().fold(o.c_rates[0], |a, b| if a < b { b } else { a });
        sp.cr_fixed = crmin;
        if crmax > crmin { sp.cr_dim = Some(sp.push_dim(crmin, crmax)); }
        if o.wind_max > o.wind_min { sp.wind_dim = Some(sp.push_dim(f64::from(o.wind_min), f64::from(o.wind_max) + 0.4999)); }
        else if units > 0 { sp.wind_dim = Some(sp.push_dim(f64::from(units), f64::from(units))); }
        if o.size_gensets && o.gen_units_max > o.gen_units_min {
            sp.gen_dim = Some(sp.push_dim(f64::from(o.gen_units_min), f64::from(o.gen_units_max) + 0.4999));
        } else if o.size_gensets { sp.gen_fixed = Some(o.gen_units_min); }
        // the ratings are sorted by kW, so the index is an ordered integer dimension like the genset count
        if o.gen_ratings.len() > 1 { sp.rat_dim = Some(sp.push_dim(0.0, o.gen_ratings.len() as f64 - 0.5001)); }
        else if !o.gen_ratings.is_empty() { sp.rat_fixed = Some(0); }
        sp
    }

    /// Adds a dimension from lo to hi; returns its index
    fn push_dim(&mut self, lo: f64, hi: f64) -> usize {
        self.lo.push(lo);
        self.hi.push(hi);
        self.lo.len() - 1
    }

    fn decode(&self, x: &[f64]) -> Pick {
        let cr = self.cr_dim.map_or(self.cr_fixed, |d| x[d]);
        let wind_units = self.wind_dim.map_or(0.0, |d| x[d].round());
        let gen_units = self.gen_dim.map_or(self.gen_fixed, |d| Some(x[d].round() as i32));
        let rating = self.rat_dim.map_or(self.rat_fixed, |d| Some(x[d].round() as usize));
        (Sizing { pv_kwp: x[0], bess_kwh: x[1], bess_kw: x[1] * cr, wind_units, gen_units }, rating)
    }

    fn rand_point(&self, g: &mut Mt19937) -> Vec<f64> {
        (0..self.lo.len()).map(|d| self.lo[d] + g.uniform() * (self.hi[d] - self.lo[d])).collect()
    }

    fn clampv(&self, x: &mut [f64]) { for (d, v) in x.iter_mut().enumerate() { *v = clamp(*v, self.lo[d], self.hi[d]); } }

    fn span(&self, d: usize) -> f64 { self.hi[d] - self.lo[d] }
}

/// Parallel, cached fitness evaluation of a population
struct Evaluator<'a, 'b> {
    cx: &'a Ctx<'b>,
    sp: &'a Space,
    cache: HashMap<SizeKey, Candidate>,
    all: Vec<Candidate>,
    /// scale for the infeasibility penalty
    refv: f64,
    /// positions evaluated in the current run, and the best feasible design it has seen
    evals: usize,
    run_best: Option<Candidate>,
}

impl Evaluator<'_, '_> {
    fn run(&mut self, x: &[Vec<f64>]) -> Result<Vec<Candidate>, Error> {
        let sz: Vec<Pick> = x.iter().map(|v| self.sp.decode(v)).collect();
        let keys: Vec<SizeKey> = sz.iter().map(|s| size_key(&s.0, s.1)).collect();
        let mut todo = Vec::new();   // first occurrence of each size not simulated yet
        for (k, key) in keys.iter().enumerate() {
            if !self.cache.contains_key(key) { self.cache.insert(*key, Candidate::default()); todo.push(sz[k]); }
        }
        self.cx.prog.total.fetch_add(x.len() as i64, Relaxed);
        let res = par_eval(self.cx, &todo, Some(|s| Candidate { s: s.0, viol: 1e9, ..Default::default() }))?;
        self.cx.prog.done.fetch_add((x.len() - todo.len()) as i64, Relaxed);
        for (s, c) in todo.iter().zip(res) { self.cache.insert(size_key(&s.0, s.1), c.clone()); self.all.push(c); }
        let out: Vec<Candidate> = keys.iter().map(|k| self.cache[k].clone()).collect();
        self.evals += x.len();
        let obj = &self.cx.o.objective;
        for c in &out {
            if c.feasible && self.run_best.as_ref().is_none_or(|b| score(c, obj) < score(b, obj)) { self.run_best = Some(c.clone()); }
        }
        Ok(out)
    }

    /// Single-objective fitness with a static penalty (constraint handling missing from the papers): feasible points keep their
    /// objective, infeasible points score ref * (1 + 10 * violation), ref = |diesel-only NPC or LCOE| + 1 (1 for objective re).
    fn fit(&self, c: &Candidate) -> f64 {
        if c.viol <= 0.0 { score(c, &self.cx.o.objective) } else { self.refv * (1.0 + 10.0 * c.viol) }
    }

    fn cancelled(&self) -> bool { self.cx.prog.cancel.load(Relaxed) }
}

/// Standard global-best PSO (El Boujdaini et al. 2022, Eqs. 21-22): inertia 0.9 -> 0.4, c1 = c2 = 2, velocity clamp 20 % of range.
fn run_pso(ev: &mut Evaluator, sp: &Space, o: &OptSettings, out: &mut SearchOut, g: &mut Mt19937) -> Result<(), Error> {
    let (n, t_max, dim) = (o.particles as usize, o.iterations, sp.lo.len());
    let mut x: Pop = Vec::new();
    let mut v = vec![vec![0.0; dim]; n];
    for vi in v.iter_mut() {
        x.push(sp.rand_point(g));
        for (d, vd) in vi.iter_mut().enumerate() { *vd = (g.uniform() - 0.5) * 0.2 * sp.span(d); }
    }
    let c = ev.run(&x)?;
    let mut pb = x.clone();
    let mut pbf = vec![0.0; n];
    let mut gi = 0;
    for i in 0..n { pbf[i] = ev.fit(&c[i]); if pbf[i] < pbf[gi] { gi = i; } }
    let (mut gb, mut gbf) = (pb[gi].clone(), pbf[gi]);
    for t in 0..t_max {
        if ev.cancelled() { break; }
        let w = 0.9 - 0.5 * f64::from(t) / f64::from(t_max - 1).max(1.0);
        for i in 0..n {
            for d in 0..dim {
                let vmax = 0.2 * sp.span(d);
                let (r1, r2) = (g.uniform(), g.uniform());
                v[i][d] = clamp(w * v[i][d] + 2.0 * r1 * (pb[i][d] - x[i][d]) + 2.0 * r2 * (gb[d] - x[i][d]), -vmax, vmax);
                x[i][d] += v[i][d];
                if x[i][d] < sp.lo[d] || x[i][d] > sp.hi[d] { x[i][d] = clamp(x[i][d], sp.lo[d], sp.hi[d]); v[i][d] *= -0.5; }
            }
        }
        let c = ev.run(&x)?;
        for i in 0..n {
            let f = ev.fit(&c[i]);
            if f < pbf[i] { pbf[i] = f; pb[i] = x[i].clone(); }
            if f < gbf { gbf = f; gb = x[i].clone(); }
        }
        out.history.push(gbf);
    }
    Ok(())
}

/// Hybrid SHO + QAO + GOA (Suresh Babu et al. 2025), with the corrections listed in docs/LITERATURE.md:
///  - SHO: canonical cluster update (Dhiman & Kumar 2017): new position = mean over the best-N cluster of
///    (P_k - E |B P_k - X|), E = 2 h r - h with h falling 5 -> 0, B = 2 r.
///  - QAO: correct three-point quadratic minimiser (differences of squares), replaces the worst if better.
///  - GOA: optimisation form (Saremi et al. 2017) with c falling 1 -> 1e-5, s(r) = f e^(-r/l) - e^(-r), f = 0.5, l = 1.5.
///    Greedy selection keeps a moved agent only if it improved; the paper does not specify selection.
fn run_hshoa(ev: &mut Evaluator, sp: &Space, o: &OptSettings, out: &mut SearchOut, g: &mut Mt19937) -> Result<(), Error> {
    let (n, t_max, dim) = (o.particles as usize, o.iterations, sp.lo.len());
    let mut x: Pop = (0..n).map(|_| sp.rand_point(g)).collect();
    let c = ev.run(&x)?;
    let mut f: Vec<f64> = c.iter().map(|c| ev.fit(c)).collect();
    let order = |f: &[f64]| { let mut idx: Vec<usize> = (0..n).collect(); cxxsort::sort(&mut idx, |&a, &b| f[a] < f[b]); idx };
    let greedy = |ev: &mut Evaluator, y: &Pop, x: &mut Pop, f: &mut Vec<f64>| -> Result<(), Error> {
        let cy = ev.run(y)?;
        for i in 0..n { let fi = ev.fit(&cy[i]); if fi < f[i] { f[i] = fi; x[i] = y[i].clone(); } }
        Ok(())
    };
    for t in 0..t_max {
        if ev.cancelled() { break; }
        // SHO
        let idx = order(&f);
        let h = 5.0 - f64::from(t) * (5.0 / f64::from(t_max));
        let nc = ((n as f64 * (0.1 + 0.2 * g.uniform())).round() as i32).max(2) as usize;
        let mut y = x.clone();
        for i in 0..n {
            if i == idx[0] { continue; }   // elitism: keep the best hyena
            for d in 0..dim {
                let mut acc = 0.0;
                for &m in &idx[..nc] {
                    let pk = x[m][d];
                    let b = 2.0 * g.uniform();
                    let e = 2.0 * h * g.uniform() - h;
                    acc += pk - e * (b * pk - x[i][d]).abs();
                }
                y[i][d] = acc / nc as f64;
            }
            sp.clampv(&mut y[i]);
        }
        greedy(ev, &y, &mut x, &mut f)?;
        // QAO on the best three
        let idx = order(&f);
        let (q1, q2, q3) = (&x[idx[0]], &x[idx[1]], &x[idx[2]]);
        let (f1, f2, f3) = (f[idx[0]], f[idx[1]], f[idx[2]]);
        let mut q: Vec<f64> = (0..dim).map(|d| {
            let num = (q2[d] * q2[d] - q3[d] * q3[d]) * f1 + (q3[d] * q3[d] - q1[d] * q1[d]) * f2 + (q1[d] * q1[d] - q2[d] * q2[d]) * f3;
            let den = (q2[d] - q3[d]) * f1 + (q3[d] - q1[d]) * f2 + (q1[d] - q2[d]) * f3;
            if den.abs() > 1e-12 && (num / den).is_finite() { 0.5 * num / den } else { q1[d] }
        }).collect();
        sp.clampv(&mut q);
        let cq = ev.run(std::slice::from_ref(&q))?;
        let fq = ev.fit(&cq[0]);
        let worst = idx[n - 1];
        if fq < f[worst] { x[worst] = q; f[worst] = fq; }
        // GOA
        let idx = order(&f);
        let c = 1.0 - f64::from(t) * (1.0 - 1e-5) / f64::from(t_max);
        let best = x[idx[0]].clone();
        let mut y = x.clone();
        for i in 0..n {
            let mut s = vec![0.0; dim];
            for j in 0..n {
                if j == i { continue; }
                let mut dist = 0.0;
                for d in 0..dim { let z = (x[j][d] - x[i][d]) / (sp.span(d) + 1e-12); dist += z * z; }
                dist = dist.sqrt() + 1e-12;
                let r = 2.0 + dist % 2.0;
                let sr = 0.5 * (-r / 1.5).exp() - (-r).exp();
                for d in 0..dim { s[d] += c * sp.span(d) / 2.0 * sr * (x[j][d] - x[i][d]) / (sp.span(d) + 1e-12) / dist; }
            }
            for d in 0..dim { y[i][d] = c * s[d] + best[d]; }
            sp.clampv(&mut y[i]);
        }
        greedy(ev, &y, &mut x, &mut f)?;
        out.history.push(f[1..].iter().fold(f[0], |a, &b| if b < a { b } else { a }));
    }
    Ok(())
}

/// MOPSO objectives, both minimised: cost and the negated renewable fraction (or SSSI), the unmet load (LPSP) or the year-1 CO2
pub(crate) fn mo_objs(c: &Candidate, o: &OptSettings) -> (f64, f64) {
    let second = match o.mo_second.as_str() {
        "lpsp" => c.unmet,
        "co2" => c.co2.unwrap_or(0.0),
        "sssi" => -c.sssi,
        _ => -c.re,
    };
    (if o.objective == "lcoe" { c.lcoe } else { c.npc }, second)
}

/// True when the MOPSO second objective is maximised (renewable fraction, SSSI): the front is then listed by renewable fraction
pub(crate) fn mo_natural(o: &OptSettings) -> bool { !matches!(o.mo_second.as_str(), "lpsp" | "co2") }

struct Item { x: Vec<f64>, c: Candidate, crowd: f64 }

/// MOPSO (Coello et al. 2004, as used by Abdoulaye et al. 2024): minimise cost, maximise renewable fraction (or SSSI).
/// External archive of feasible non-dominated solutions with crowding-distance pruning and tournament leader selection.
fn run_mopso(ev: &mut Evaluator, sp: &Space, o: &OptSettings, out: &mut SearchOut, g: &mut Mt19937) -> Result<(), Error> {
    const AMAX: usize = 60;
    let (n, t_max, dim) = (o.particles as usize, o.iterations, sp.lo.len());
    let objs = |c: &Candidate| mo_objs(c, o);
    let dominates = |a: &Candidate, b: &Candidate| {
        if a.viol < b.viol { return true; }
        if a.viol > b.viol { return false; }
        let ((a1, a2), (b1, b2)) = (objs(a), objs(b));
        a1 <= b1 && a2 <= b2 && (a1 < b1 || a2 < b2)
    };
    let crowding = |arch: &mut Vec<Item>| {
        let n = arch.len();
        for a in arch.iter_mut() { a.crowd = 0.0; }
        if n < 3 { for a in arch.iter_mut() { a.crowd = 1e9; } return; }
        for m in 0..2 {
            let val: Vec<f64> = arch.iter().map(|a| { let ob = objs(&a.c); if m == 0 { ob.0 } else { ob.1 } }).collect();
            let mut id: Vec<usize> = (0..n).collect();
            cxxsort::sort(&mut id, |&a, &b| val[a] < val[b]);
            let span = mx(1e-12, val[id[n - 1]] - val[id[0]]);
            arch[id[n - 1]].crowd = 1e9;
            arch[id[0]].crowd = 1e9;
            for k in 1..n - 1 { arch[id[k]].crowd += (val[id[k + 1]] - val[id[k - 1]]) / span; }
        }
    };
    let add = |arch: &mut Vec<Item>, x: &[f64], c: &Candidate| {
        if !c.feasible { return; }
        if arch.iter().any(|a| dominates(&a.c, c) || objs(&a.c) == objs(c)) { return; }
        arch.retain(|a| !dominates(c, &a.c));
        arch.push(Item { x: x.to_vec(), c: c.clone(), crowd: 0.0 });
        if arch.len() > AMAX {
            crowding(arch);
            let mut k = 0;
            for (i, a) in arch.iter().enumerate() { if a.crowd < arch[k].crowd { k = i; } }
            arch.remove(k);
        }
    };
    let mut arch: Vec<Item> = Vec::new();
    let mut x: Pop = (0..n).map(|_| sp.rand_point(g)).collect();
    let mut v = vec![vec![0.0; dim]; n];
    let c = ev.run(&x)?;
    let mut pb = x.clone();
    let mut pbc = c.clone();
    for i in 0..n { add(&mut arch, &x[i], &c[i]); }
    for t in 0..t_max {
        if ev.cancelled() { break; }
        let w = 0.9 - 0.5 * f64::from(t) / f64::from(t_max - 1).max(1.0);
        let pm = 0.5 * (1.0 - f64::from(t) / f64::from(t_max)).powf(2.0);   // mutation probability, decays over the run
        crowding(&mut arch);
        for i in 0..n {
            let lead = if arch.is_empty() { pb[i].clone() } else {
                let na = arch.len();
                let a = &arch[(g.uniform() * na as f64) as usize % na];
                let b = &arch[(g.uniform() * na as f64) as usize % na];
                (if a.crowd >= b.crowd { a } else { b }).x.clone()
            };
            for d in 0..dim {
                let vmax = 0.2 * sp.span(d);
                let (r1, r2) = (g.uniform(), g.uniform());
                v[i][d] = clamp(w * v[i][d] + 1.5 * r1 * (pb[i][d] - x[i][d]) + 1.5 * r2 * (lead[d] - x[i][d]), -vmax, vmax);
                x[i][d] += v[i][d];
            }
            if g.uniform() < pm {
                let d = (g.uniform() * dim as f64) as usize % dim;
                let r = sp.span(d) * pm;
                x[i][d] += (g.uniform() * 2.0 - 1.0) * r;
            }
            sp.clampv(&mut x[i]);
        }
        let c = ev.run(&x)?;
        for i in 0..n {
            add(&mut arch, &x[i], &c[i]);
            if dominates(&c[i], &pbc[i]) || (!dominates(&pbc[i], &c[i]) && g.uniform() < 0.5) { pb[i] = x[i].clone(); pbc[i] = c[i].clone(); }
        }
        out.history.push(arch.iter().fold(f64::INFINITY, |m, a| mn(m, objs(&a.c).0)));
    }
    out.archive.extend(arch.into_iter().map(|a| a.c));
    Ok(())
}

/// The seed of run `r` (0-based): the project's seed for the first run, so one run gives what it always gave; an odd step keeps
/// the seeds of up to 2^32 runs distinct
pub(crate) fn run_seed(seed: u32, r: usize) -> u32 { seed.wrapping_add((r as u32).wrapping_mul(0x9E37_79B9)) }

/// What one run of a metaheuristic leaves
struct Run {
    seed: u32,
    evals: usize,
    sims: usize,
    best: Option<Candidate>,
    history: Vec<f64>,
    archive: Vec<Candidate>,
}

pub(crate) fn search_meta(cx: &Ctx, out: &mut SearchOut) -> Result<(), Error> {
    let o = cx.o;
    let sp = Space::new(cx);
    let base = if o.objective == "lcoe" { cx.base.econ.lcoe } else { cx.base.econ.npc };
    let refv = if o.objective == "re" { 1.0 } else { base.abs() + 1.0 };
    let mut ev = Evaluator { cx, sp: &sp, cache: HashMap::new(), all: Vec::new(), refv, evals: 0, run_best: None };
    // the runs share the cache of simulated sizes, so a size met again is not simulated again; results do not depend on it
    let mut runs: Vec<Run> = Vec::new();
    for r in 0..o.repeat_runs.max(1) as usize {
        if r > 0 && ev.cancelled() { break; }
        let seed = run_seed(o.seed, r);
        let mut g = Mt19937::new(seed);
        let sims = ev.all.len();
        (ev.evals, ev.run_best) = (0, None);
        let mut part = SearchOut::default();
        match o.algorithm.as_str() {
            "mopso" => run_mopso(&mut ev, &sp, o, &mut part, &mut g)?,
            "hshoa" => run_hshoa(&mut ev, &sp, o, &mut part, &mut g)?,
            _ => run_pso(&mut ev, &sp, o, &mut part, &mut g)?,
        }
        runs.push(Run { seed, evals: ev.evals, sims: ev.all.len() - sims, best: ev.run_best.take(), history: part.history, archive: part.archive });
    }
    out.refined = std::mem::take(&mut ev.all);
    let mopso = o.algorithm == "mopso";
    // MOPSO: the objectives scaled to 0..1 over the fronts of all runs, for the hypervolume and the spacing
    let norm = Norm::of(runs.iter().flat_map(|r| &r.archive).map(|c| mo_objs(c, o)));
    // each run's value: the objective of its best design, or for MOPSO the hypervolume of its front
    let values: Vec<Option<f64>> = runs.iter().map(|r| if mopso {
        (!r.archive.is_empty()).then(|| norm.hypervolume(&r.archive, o))
    } else {
        r.best.as_ref().map(|b| match o.objective.as_str() { "lcoe" => b.lcoe, "re" => b.re, _ => b.npc })
    }).collect();
    let value = |k: usize| values[k];
    // the run reported: the best value (the first of equals)
    let higher = mopso || o.objective == "re";
    let mut pick = 0;
    for k in 1..runs.len() {
        if let Some(v) = value(k) {
            if value(pick).is_none_or(|p| if higher { v > p } else { v < p }) { pick = k; }
        }
    }
    out.history = std::mem::take(&mut runs[pick].history);
    if mopso {
        out.archive = std::mem::take(&mut runs[pick].archive);
        if let Some(k) = if o.mo_pick == "fuzzy" { fuzzy_pick(&out.archive, o) } else { knee(&out.archive, o) } {
            (out.best, out.found) = (out.archive[k].clone(), true);
        }
        if o.pareto_stats && !out.archive.is_empty() { out.quality = Some(norm.quality(&out.archive, o)); }
    } else {
        keep_best(&out.refined, &o.objective, &mut out.best, &mut out.found);
    }
    if runs.len() > 1 {
        let rows: Vec<Value> = runs.iter().enumerate().map(|(k, r)| {
            let mut v = Value::object();
            v.set("run", k + 1); v.set("seed", r.seed); v.set("evaluations", r.evals); v.set("simulations", r.sims);
            v.set("value", value(k));
            if mopso {
                let a = if k == pick { &out.archive } else { &r.archive };   // the reported run's front has moved to out
                v.set("front", a.len());
                v.set("spacing", spacing(&norm.points(a, o)));
            }
            v
        }).collect();
        let vals: Vec<f64> = (0..runs.len()).filter_map(value).collect();
        let mut st = Value::object();
        st.set("n", runs.len());
        st.set("metric", if mopso { "hypervolume" } else { o.objective.as_str() });
        st.set("higher_is_better", higher);
        st.set("n_with_value", vals.len());
        st.set("best_run", if value(pick).is_some() { Value::Num((pick + 1) as f64) } else { Value::Null });
        if !vals.is_empty() {
            let (mean, sd) = mean_sd(&vals);
            let (lo, hi) = vals.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, &v| (mn(a.0, v), mx(a.1, v)));
            st.set("best", if higher { hi } else { lo }); st.set("worst", if higher { lo } else { hi });
            st.set("mean", mean); st.set("std", sd);
        }
        st.set("rows", rows);
        out.runs = Some(st);
    }
    Ok(())
}

/// Compromise ("knee") solution: closest to the ideal point in normalised objective space (the first of equals)
fn knee(arch: &[Candidate], o: &OptSettings) -> Option<usize> {
    let pts = Norm::of(arch.iter().map(|a| mo_objs(a, o))).points(arch, o);
    let (mut bd, mut k) = (1e300, None);
    for (i, &(x, y)) in pts.iter().enumerate() {
        if x * x + y * y < bd { bd = x * x + y * y; k = Some(i); }
    }
    k
}

/// Fuzzy best compromise (Ojo et al. 2026): each objective's membership is 1 at its best value on the front and 0 at its worst,
/// linear between; the design with the largest sum of memberships wins (the first of equals)
fn fuzzy_pick(arch: &[Candidate], o: &OptSettings) -> Option<usize> {
    let f: Vec<(f64, f64)> = arch.iter().map(|a| mo_objs(a, o)).collect();
    let Norm { lo, hi, .. } = Norm::of(f.iter().copied());
    let mu = |v: f64, lo: f64, hi: f64| if hi - lo > 1e-12 { clamp((hi - v) / (hi - lo), 0.0, 1.0) } else { 1.0 };
    let (mut best, mut k) = (f64::NEG_INFINITY, None);
    for (i, p) in f.iter().enumerate() {
        let m = mu(p.0, lo.0, hi.0) + mu(p.1, lo.1, hi.1);
        if m > best { best = m; k = Some(i); }
    }
    k
}

/// Spacing of a front of two minimised objectives (Schott): the spread of each point's distance (sum of absolute differences)
/// to its nearest neighbour, as a sample standard deviation. 0 for an evenly spread front; lower is better. None below 2 points.
pub fn spacing(front: &[(f64, f64)]) -> Option<f64> {
    let n = front.len();
    if n < 2 { return None; }
    let d: Vec<f64> = (0..n).map(|i| {
        (0..n).filter(|&j| j != i).map(|j| (front[i].0 - front[j].0).abs() + (front[i].1 - front[j].1).abs()).fold(f64::INFINITY, mn)
    }).collect();
    Some(mean_sd(&d).1)
}

/// The mean and the sample standard deviation (0 for a single value)
fn mean_sd(v: &[f64]) -> (f64, f64) {
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    (mean, if v.len() > 1 { (v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1.0)).sqrt() } else { 0.0 })
}

/// Area dominated by a front of two minimised objectives and bounded by the reference point; points not better than the
/// reference in both objectives add nothing
pub fn hypervolume(front: &[(f64, f64)], refp: (f64, f64)) -> f64 {
    let mut pts: Vec<(f64, f64)> = front.iter().copied().filter(|p| p.0 < refp.0 && p.1 < refp.1).collect();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (mut hv, mut top) = (0.0, refp.1);
    for (f1, f2) in pts {
        if f2 < top { hv += (refp.0 - f1) * (top - f2); top = f2; }
    }
    hv
}

/// The fixed LPSP targets of the front table
const LPSP_TARGETS: [f64; 5] = [0.0, 0.01, 0.02, 0.05, 0.10];

/// For each LPSP target, the cheapest design of the front (by the cost objective) whose unmet load meets it, or null
pub(crate) fn lpsp_table(arch: &[Candidate], o: &OptSettings) -> Value {
    LPSP_TARGETS.iter().map(|&t| {
        let mut best: Option<&Candidate> = None;
        for a in arch.iter().filter(|a| a.unmet <= t + 1e-9) {
            if best.is_none_or(|b| mo_objs(a, o).0 < mo_objs(b, o).0) { best = Some(a); }
        }
        let mut v = Value::object();
        v.set("target", t);
        v.set("best", best.map_or(Value::Null, cand_json));
        v
    }).collect::<Vec<_>>().into()
}

/// Scaling of the two MOPSO objectives to 0..1 between their best and worst values on the fronts of all runs
struct Norm { lo: (f64, f64), hi: (f64, f64), span: (f64, f64) }

/// The reference point of the hypervolume in scaled objectives: 10 % beyond the worst value of each
const HV_REF: f64 = 1.1;

impl Norm {
    fn of(pts: impl Iterator<Item = (f64, f64)>) -> Norm {
        let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
        for p in pts { lo = (mn(lo.0, p.0), mn(lo.1, p.1)); hi = (mx(hi.0, p.0), mx(hi.1, p.1)); }
        Norm { lo, hi, span: (mx(1e-12, hi.0 - lo.0), mx(1e-12, hi.1 - lo.1)) }
    }

    fn points(&self, arch: &[Candidate], o: &OptSettings) -> Vec<(f64, f64)> {
        arch.iter().map(|a| { let f = mo_objs(a, o); ((f.0 - self.lo.0) / self.span.0, (f.1 - self.lo.1) / self.span.1) }).collect()
    }

    /// Hypervolume of a front in scaled objectives, as a share of the box from the ideal point to the reference (0..1)
    fn hypervolume(&self, arch: &[Candidate], o: &OptSettings) -> f64 {
        hypervolume(&self.points(arch, o), (HV_REF, HV_REF)) / (HV_REF * HV_REF)
    }

    /// The quality of the reported front: its size, spacing and hypervolume, and the reference point in the objectives' own units
    fn quality(&self, arch: &[Candidate], o: &OptSettings) -> Value {
        let (r1, r2) = (self.lo.0 + HV_REF * self.span.0, self.lo.1 + HV_REF * self.span.1);
        let mut v = Value::object();
        v.set("points", arch.len());
        v.set("spacing", spacing(&self.points(arch, o)));
        v.set("hypervolume", self.hypervolume(arch, o));
        v.set("ref_cost", r1);
        v.set("ref_second", if mo_natural(o) { -r2 } else { r2 });
        v
    }
}
