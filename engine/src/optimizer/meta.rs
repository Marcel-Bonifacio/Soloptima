//! Metaheuristics from the literature over a continuous decision vector [PV kWp, BESS kWh, C-rate?, wind turbines?]: PSO,
//! MOPSO (cost against renewable fraction or SSSI) and hybrid SHO-QAO-GOA. Random numbers as libc++ draws them (std::mt19937
//! and uniform_real_distribution), in the C++ order; `std::sort` as libc++ orders ties (cxxsort.rs).
use super::cxxsort;
use super::eval::{score, size_key, Candidate, Ctx, SizeKey};
use super::search::{keep_best, par_eval, SearchOut};
use super::OptSettings;
use crate::forecast::rng::Mt19937;
use crate::json::Error;
use crate::sim::{clamp, mn, mx, Sizing};
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;

type Pop = Vec<Vec<f64>>;

pub(crate) struct Space {
    lo: Vec<f64>,
    hi: Vec<f64>,
    crate_: bool,
    wind: bool,
    cr_fixed: f64,
}

impl Space {
    fn new(cx: &Ctx) -> Space {
        let (o, units) = (cx.o, cx.p.wind.units);
        let mut sp = Space {
            lo: vec![o.pv_min, o.bess_min], hi: vec![mx(o.pv_min + 1.0, o.pv_max), mx(o.bess_min + 1.0, o.bess_max)],
            crate_: false, wind: false, cr_fixed: 0.5,
        };
        let crmin = o.c_rates.iter().copied().fold(o.c_rates[0], |a, b| if b < a { b } else { a });
        let crmax = o.c_rates.iter().copied().fold(o.c_rates[0], |a, b| if a < b { b } else { a });
        sp.cr_fixed = crmin;
        if crmax > crmin { sp.crate_ = true; sp.lo.push(crmin); sp.hi.push(crmax); }
        if o.wind_max > o.wind_min { sp.wind = true; sp.lo.push(f64::from(o.wind_min)); sp.hi.push(f64::from(o.wind_max) + 0.4999); }
        else if units > 0 { sp.wind = true; sp.lo.push(f64::from(units)); sp.hi.push(f64::from(units)); }
        sp
    }

    fn decode(&self, x: &[f64]) -> Sizing {
        let cr = if self.crate_ { x[2] } else { self.cr_fixed };
        let wind_units = if self.wind { x[if self.crate_ { 3 } else { 2 }].round() } else { 0.0 };
        Sizing { pv_kwp: x[0], bess_kwh: x[1], bess_kw: x[1] * cr, wind_units }
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
}

impl Evaluator<'_, '_> {
    fn run(&mut self, x: &[Vec<f64>]) -> Result<Vec<Candidate>, Error> {
        let sz: Vec<Sizing> = x.iter().map(|v| self.sp.decode(v)).collect();
        let keys: Vec<SizeKey> = sz.iter().map(size_key).collect();
        let mut todo = Vec::new();   // first occurrence of each size not simulated yet
        for (k, key) in keys.iter().enumerate() {
            if !self.cache.contains_key(key) { self.cache.insert(*key, Candidate::default()); todo.push(sz[k]); }
        }
        self.cx.prog.total.fetch_add(x.len() as i64, Relaxed);
        let res = par_eval(self.cx, &todo, Some(|s| Candidate { s: *s, viol: 1e9, ..Default::default() }))?;
        self.cx.prog.done.fetch_add((x.len() - todo.len()) as i64, Relaxed);
        for (s, c) in todo.iter().zip(res) { self.cache.insert(size_key(s), c.clone()); self.all.push(c); }
        Ok(keys.iter().map(|k| self.cache[k].clone()).collect())
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

/// MOPSO objectives, both minimised: cost and the negated renewable fraction (or SSSI)
pub(crate) fn mo_objs(c: &Candidate, o: &OptSettings) -> (f64, f64) {
    (if o.objective == "lcoe" { c.lcoe } else { c.npc }, -(if o.mo_second == "sssi" { c.sssi } else { c.re }))
}

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

pub(crate) fn search_meta(cx: &Ctx, out: &mut SearchOut) -> Result<(), Error> {
    let o = cx.o;
    let sp = Space::new(cx);
    let base = if o.objective == "lcoe" { cx.base.econ.lcoe } else { cx.base.econ.npc };
    let refv = if o.objective == "re" { 1.0 } else { base.abs() + 1.0 };
    let mut ev = Evaluator { cx, sp: &sp, cache: HashMap::new(), all: Vec::new(), refv };
    let mut g = Mt19937::new(o.seed);
    match o.algorithm.as_str() {
        "mopso" => run_mopso(&mut ev, &sp, o, out, &mut g)?,
        "hshoa" => run_hshoa(&mut ev, &sp, o, out, &mut g)?,
        _ => run_pso(&mut ev, &sp, o, out, &mut g)?,
    }
    out.refined = std::mem::take(&mut ev.all);
    if o.algorithm == "mopso" && !out.archive.is_empty() {
        // Compromise ("knee") solution: closest to the ideal point in normalised objective space.
        let (mut c1, mut c2, mut cc1, mut cc2) = (1e300, 1e300, -1e300, -1e300);
        for a in &out.archive {
            let (f1, f2) = mo_objs(a, o);
            c1 = mn(c1, f1); cc1 = mx(cc1, f1); c2 = mn(c2, f2); cc2 = mx(cc2, f2);
        }
        let mut bd = 1e300;
        for a in &out.archive {
            let (f1, f2) = mo_objs(a, o);
            let (x, y) = ((f1 - c1) / mx(1e-12, cc1 - c1), (f2 - c2) / mx(1e-12, cc2 - c2));
            if x * x + y * y < bd { bd = x * x + y * y; out.best = a.clone(); out.found = true; }
        }
    } else {
        keep_best(&out.refined, &o.objective, &mut out.best, &mut out.found);
    }
    Ok(())
}
