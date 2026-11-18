//! Short-circuit currents of the plant network by the IEC 60909-0 method (equivalent voltage source at the fault), once the
//! interface's JavaScript. The radial network of the design is built per unit (S_base = 1 MVA) twice: for the maximum
//! currents (all sources, c_max, correction factors K_T and K_G, conductors at 20 °C) and for the minimum ones (the gensets
//! always online and the battery, no PV, c_min, conductors at 80 °C). Gensets and the grid are voltage sources behind their
//! impedance; PV inverters and battery PCS are current sources limited to a multiple of their rated current, added by magnitude
//! (IEC 60909-0:2016, full converters). For every fault bus the tree is re-rooted at the fault: each node's admittance towards
//! the sources gives the fault current, the current of every branch (for the protection) and each source's share. Earth faults
//! use the zero-sequence network from the transformer vector groups and the MV earthing.
use super::util::{circuit, find_in, jmax, jmin, jn, jround, js_num, max_of, num, obj, selected_in, truthy, C, SQ3};
use crate::json::Value;
use std::collections::BTreeMap;

pub const SB: f64 = 1.0; // MVA
const F_HZ: f64 = 50.0;
/// Voltage factor c (IEC 60909-0 table 1): maximum or minimum case, MV or LV
pub fn c_factor(max: bool, kv: f64) -> f64 {
    match (max, kv > 1.0) { (true, true) => 1.1, (true, false) => 1.05, (false, true) => 1.0, (false, false) => 0.95 }
}
/// Used when a datasheet leaves the value blank
pub const TYPICAL_XD2: f64 = 15.0;
pub const TYPICAL_IFAULT: f64 = 1.2;
pub const TYPICAL_XR: f64 = 8.0;

const ONE: C = C::new(1.0, 0.0);
const ZERO: C = C::new(0.0, 0.0);
const TINY: f64 = 1e-12;
const EPS_Z: C = C::new(0.0, 1e-9); // a branch without impedance (the grid supply point)
fn inv(a: C) -> C { ONE.div(a) }
fn is_zero(a: C) -> bool { a.abs() < TINY }

// ---------------------------------------------------------------- JavaScript semantics of the project JSON

/// `o[k] || def` for a number
pub(crate) fn or_num(o: &Value, k: &str, def: f64) -> f64 { if truthy(o.at(k)) { jn(o, k) } else { def } }
/// a > b, for the JavaScript guards `!(a > b)` that also catch NaN
pub(crate) fn above(a: f64, b: f64) -> bool { a > b }
/// `${o[k]}` in a template literal
pub(crate) fn js_str(o: &Value, k: &str) -> String {
    match o.at(k) {
        Value::Str(s) => s.clone(),
        Value::Num(x) => js_num(*x),
        Value::Bool(b) => b.to_string(),
        Value::Null => if o.has(k) { "null".into() } else { "undefined".into() },
        Value::Arr(_) => "[array]".into(),
        Value::Obj(_) => "[object Object]".into(),
    }
}

// ---------------------------------------------------------------- IEC 60909-0 factors

/// Peak factor κ from R/X (IEC 60909-0 eq. 55)
pub fn kappa(rx: f64) -> f64 { 1.02 + 0.98 * (-3.0 * rx).exp() }
/// κ by method B: 1.15 κ for a meshed or multi-source network, at most 1.8 (LV) or 2.0 (MV)
pub fn kappa_b(rx: f64, lv: bool) -> f64 { let k = kappa(rx); jmax(k, jmin(1.15 * k, if lv { 1.8 } else { 2.0 })) }
/// Decay μ of a near generator for the breaking current at a minimum time delay of 0.1 s; r: its current over its rated one
pub fn mu(r: f64) -> f64 { if r <= 2.0 { 1.0 } else { jmin(1.0, 0.62 + 0.72 * (-0.32 * r).exp()) } }
/// Thermal effect m of the DC component (IEC 60909-0 annex A) for peak factor k and duration Tk
pub fn m_factor(k: f64, tk: f64) -> f64 {
    if k <= 1.0 || !above(tk, 0.0) { return 0.0; }
    let l = (k - 1.0).ln();
    if l.abs() < 1e-9 { 2.0 } else { ((4.0 * F_HZ * tk * l).exp() - 1.0) / (2.0 * F_HZ * tk * l) }
}

/// The earthing of a transformer's windings
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Windings {
    pub hv: bool,
    pub lv: bool,
    pub guessed: bool,
}
/// From the vector group (Dyn11: HV delta, LV star earthed). Unknown text: an earthed LV star.
pub fn windings(vector: &str) -> Windings {
    // /^\s*(yn|y|d|zn|z)(yn|y|d|zn|z)/i: no backtracking needed, since no winding starts with n
    fn take(s: &str) -> Option<(bool, &str)> {
        let l = s.get(..2).map(|p| p.to_ascii_lowercase());
        if matches!(l.as_deref(), Some("yn" | "zn")) { return Some((true, &s[2..])); }
        let c = s.chars().next()?.to_ascii_lowercase();
        matches!(c, 'y' | 'd' | 'z').then(|| (false, &s[1..]))
    }
    let s = vector.trim_start();
    match take(s).and_then(|(hv, r)| take(r).map(|(lv, _)| (hv, lv))) {
        Some((hv, lv)) => Windings { hv, lv, guessed: false },
        None => Windings { hv: false, lv: true, guessed: true },
    }
}

// ---------------------------------------------------------------- the network

/// Gensets held by a node: how many and their rating
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gen {
    pub n: f64,
    pub kva: f64,
}

/// A node of the radial network: its branch to the parent (z, zero sequence z0, None for an open path), its source admittance
/// (y, zero sequence y0), a current source J (pu), the gensets it holds, the bus id it is reported under (explicit items only)
/// and the device on its branch
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub parent: i64,
    pub kv: f64,
    pub z: C,
    pub z0: Option<C>,
    pub y: C,
    pub y0: C,
    pub j: f64,
    pub gen: Option<Gen>,
    pub id: Option<&'static str>,
    pub name: Option<&'static str>,
    pub dev: Option<&'static str>,
}
impl Node {
    pub fn new(parent: i64, kv: f64) -> Node {
        Node { parent, kv, z: ZERO, z0: None, y: ZERO, y0: ZERO, j: 0.0, gen: None, id: None, name: None, dev: None }
    }
    fn branch(mut self, (z, z0): (C, C)) -> Node { self.z = z; self.z0 = Some(z0); self }
    fn tag(mut self, id: Option<&'static str>, name: &'static str, dev: Option<&'static str>) -> Node {
        self.id = id; self.name = Some(name); self.dev = dev; self
    }
}

/// The network of a design for one case, with the notes on the values it assumed
pub struct Network {
    pub nodes: Vec<Node>,
    pub notes: Vec<String>,
}

struct Trafo {
    z: C,
    w: Windings,
}
struct GenSheet {
    name: String,
    xd2: f64,
    pf: f64,
    kva: f64,
}

struct Builder<'a> {
    d: &'a Value,
    max: bool,
    theta: f64,
    nodes: Vec<Node>,
    notes: Vec<String>,
}
impl Builder<'_> {
    fn note(&mut self, s: String) { if !self.notes.contains(&s) { self.notes.push(s); } }
    fn add(&mut self, n: Node) -> usize { self.nodes.push(n); self.nodes.len() - 1 }
    fn cmax_of(kv: f64) -> f64 { c_factor(true, kv) }
    // the cable of circuit `key`, k in parallel: positive and zero sequence (taken as 3 × positive)
    fn cable(&self, key: &str, kv: f64, k: f64) -> (C, C) {
        let c = circuit(self.d, key);
        if !truthy(c) || !truthy(c.at("cab")) || !above(jn(c, "L"), 0.0) { return (EPS_Z, EPS_Z); }
        let cab = c.at("cab");
        let zb = kv * kv / SB;
        let (l, runs) = (jn(c, "L"), jn(c, "runs"));
        let r20 = jn(cab, "r20") * (1.0 + super::util::alpha(cab.at("material").str()) * (self.theta - 20.0)) / 1000.0;
        let z = C::new(r20 * l / runs / zb / k, or_num(cab, "x", 0.0) / 1000.0 * l / runs / zb / k);
        (z.add(EPS_Z), z.scale(3.0).add(EPS_Z))
    }
    fn trafo(&mut self, t: &Value, kv_l: f64) -> Trafo {
        let zt = jn(t, "z") / 100.0;
        let (xr, pk, kva) = (jn(t, "xr"), jn(t, "pk"), jn(t, "kva"));
        let r = if xr > 0.0 { zt / (1.0 + xr * xr).sqrt() } else if pk > 0.0 { pk / kva } else { zt / (1.0 + TYPICAL_XR * TYPICAL_XR).sqrt() };
        let x = jmax(0.0, zt * zt - r * r).sqrt();
        let kt = if self.max { 0.95 * Self::cmax_of(kv_l) / (1.0 + 0.6 * x) } else { 1.0 };
        let vector = if t.at("vector").is_string() { t.at("vector").str() } else { "" };
        let w = windings(vector);
        if w.guessed { self.note(format!("Vector group of {} not recognised: an earthed LV star is assumed.", js_str(t, "name"))); }
        Trafo { z: C::new(r, x).scale(kt * SB * 1000.0 / kva), w }
    }
    // a transformer under `parent`, k in parallel: the zero sequence passes YNyn, an earthed star facing a delta earths its own side
    fn add_trafo(&mut self, parent: usize, t: &Trafo, k: f64, o: Node) -> usize {
        let z = t.z.scale(1.0 / k);
        let i = self.add(Node { parent: parent as i64, z, z0: if t.w.hv && t.w.lv { Some(z) } else { None }, ..o });
        if t.w.lv && !t.w.hv { self.nodes[i].y0 = self.nodes[i].y0.add(inv(z)); }
        if t.w.hv && !t.w.lv { self.nodes[parent].y0 = self.nodes[parent].y0.add(inv(z)); }
        i
    }
    fn gen_y(&mut self, g: &GenSheet, kv: f64, n: f64) -> C {
        if !above(g.xd2, 0.0) {
            let name = if g.name.is_empty() { "the genset" } else { &g.name };
            self.note(format!("Subtransient reactance X\u{2033}d of {name} not given: {} % assumed.", js_num(TYPICAL_XD2)));
        }
        let xd = (if g.xd2 > 0.0 { g.xd2 } else { TYPICAL_XD2 }) / 100.0;
        let rg = (if kv > 1.0 { 0.07 } else { 0.15 }) * xd;
        let pf = jmin(1.0, if g.pf > 0.0 { g.pf } else { 0.8 });
        let kg = if self.max { Self::cmax_of(kv) / (1.0 + xd * (1.0 - pf * pf).sqrt()) } else { 1.0 };
        inv(C::new(rg, xd).scale(kg * SB * 1000.0 / g.kva)).scale(n)
    }
    fn ifault(&mut self, e: &Value, what: &str) -> f64 {
        let ok = truthy(e) && jn(e, "ifault") > 0.0;
        if !ok { self.note(format!("Fault current of the {what} not given: {} \u{d7} rated assumed.", js_num(TYPICAL_IFAULT))); }
        if ok { jn(e, "ifault") } else { TYPICAL_IFAULT }
    }
    // n identical branches under `parent`: the first on its own (its buses are reported), the other n - 1 as one equivalent
    fn group(&mut self, parent: usize, n: f64, mut build: impl FnMut(&mut Self, usize, f64, bool)) {
        if n >= 1.0 { build(self, parent, 1.0, true); }
        if n > 1.0 { build(self, parent, n - 1.0, false); }
    }
}

/// The network of design `d` for the maximum (`max`) or minimum case
pub fn fault_network(p: &Value, d: &Value, max: bool) -> Network {
    let e = p.at("electrical");
    let lib = p.at("equipment").at("lib");
    let mv_kv = jn(e, "mv_kv");
    let c_of = |kv: f64| c_factor(max, kv);
    let mut b = Builder { d, max, theta: if max { 20.0 } else { 80.0 }, nodes: vec![], notes: vec![] };

    let bus = b.add(Node::new(-1, mv_kv).tag(Some("mv"), "MV main bus", None));
    let grid_mva = jn(e, "grid_mva");
    if grid_mva > 0.0 {
        let xr = if jn(e, "grid_xr") > 0.0 { jn(e, "grid_xr") } else { 10.0 };
        let zq = c_of(mv_kv) * SB / grid_mva;
        let y = inv(C::new(zq / (1.0 + xr * xr).sqrt(), zq * xr / (1.0 + xr * xr).sqrt()));
        b.add(Node { z: EPS_Z, y, ..Node::new(bus as i64, mv_kv).tag(Some("grid"), "Utility supply point", Some("grid")) });
    }

    // PV: the feeders as chains of transformers; inverters are current sources (none at night, so none in the minimum case)
    let s = d.at("str");
    let tr_pv = find_in(lib, "transformer", e.at("trafo_pv").str());
    if truthy(s) && truthy(tr_pv) && truthy(d.at("nTrPV")) {
        let n_tr = jn(d, "nTrPV");
        let pv_f = circuit(d, "mv_pv");
        let n_feed = if truthy(pv_f) { jn(pv_f, "count") } else { 1.0 };
        let per = jmax(1.0, jround(n_tr / n_feed));
        let n_i = jmax(1.0, jn(s, "nInv") / n_tr);
        let inv_ = s.at("inv");
        let kv_l = jn(inv_, "vac") / 1000.0;
        let j = if max { b.ifault(inv_, "PV inverter") * jn(inv_, "pac_kw") / 1000.0 / SB } else { 0.0 };
        let t = b.trafo(tr_pv, kv_l);
        b.group(bus, n_feed, |b, parent, k, ex| {
            let mut prev = parent;
            let mut i = 0.0;
            while i < per {
                let fc = b.cable("mv_pv", mv_kv, per * k);
                let mv = b.add(Node::new(prev as i64, mv_kv).branch(fc).tag(
                    (ex && i == per - 1.0).then_some("pv_end"), "PV feeder end", (ex && i == 0.0).then_some("mv_pv")));
                let first = ex && i == 0.0;
                let lv = b.add_trafo(mv, &t, k, Node::new(0, kv_l).tag(first.then_some("pv_lv"), "PV transformer LV (first on the feeder)", first.then_some("lv_pv")));
                let one = b.cable("lv_pv", kv_l, 1.0);
                let rest = b.cable("lv_pv", kv_l, if first { n_i - 1.0 } else { n_i * k });
                if first { b.add(Node { j, ..Node::new(lv as i64, kv_l).branch(one).tag(Some("pv_inv"), "PV inverter terminals", None) }); }
                if !first || n_i > 1.0 { b.add(Node { j: j * (if first { n_i - 1.0 } else { n_i * k }), ..Node::new(lv as i64, kv_l).branch(rest) }); }
                prev = mv;
                i += 1.0;
            }
        });
    }

    // battery: one MV feeder to its station, nTrB transformers there, the PCS on their LV sides (online in both cases)
    let bat = selected_in(p, "battery");
    let tr_b = find_in(lib, "transformer", e.at("trafo_bess").str());
    let bess = p.at("bess");
    if jn(bess, "energy_kwh") > 0.0 && jn(bess, "power_kw") > 0.0 && truthy(tr_b) && truthy(d.at("nTrB")) {
        let n_trb = jn(d, "nTrB");
        let kv_l = (if truthy(bat) { jn(bat, "vac") } else { 690.0 }) / 1000.0;
        let n_b = jmax(1.0, jn(d, "nB"));
        let per = jmax(1.0, jround(n_b / n_trb));
        let j = b.ifault(bat, "battery PCS") * jn(bess, "power_kw") / n_b / 1000.0 / SB;
        let t = b.trafo(tr_b, kv_l);
        let mc = b.cable("mv_bess", mv_kv, 1.0);
        let mvb = b.add(Node::new(bus as i64, mv_kv).branch(mc).tag(Some("bess_mv"), "BESS MV node", Some("mv_bess")));
        b.group(mvb, n_trb, |b, parent, k, ex| {
            let lv = b.add_trafo(parent, &t, k, Node::new(0, kv_l).tag(ex.then_some("bess_lv"), "BESS transformer LV", None));
            if ex {
                let c = b.cable("lv_bess", kv_l, 1.0);
                b.add(Node { j, ..Node::new(lv as i64, kv_l).branch(c).tag(Some("bess_pcs"), "BESS PCS terminals", Some("lv_bess")) });
            }
            if !ex || per > 1.0 {
                let n = if ex { per - 1.0 } else { per * k };
                let c = b.cable("lv_bess", kv_l, n);
                b.add(Node { j: j * n, ..Node::new(lv as i64, kv_l).branch(c) });
            }
        });
    }

    // gensets: voltage sources behind X″d; all units in the maximum case, the units always online in the minimum one
    let n_g = or_num(d, "nG", 0.0);
    let dg = selected_in(p, "genset");
    let tr_g = find_in(lib, "transformer", e.at("trafo_gen").str());
    if n_g > 0.0 {
        let name = if !truthy(dg) { "the genset".to_string() } else if truthy(dg.at("name")) { js_str(dg, "name") } else { String::new() };
        let g = GenSheet { name, xd2: jn(dg, "xd2"), pf: jn(dg, "pf"), kva: jn(d, "gKva") };
        let at_mv = truthy(e.at("gen_mv")) || !truthy(tr_g);
        let kv_g = if at_mv { mv_kv } else { (if truthy(dg) { jn(dg, "voltage") } else { 400.0 }) / 1000.0 };
        let gpt = if at_mv { 1.0 } else { jmax(1.0, jn(d, "gpt")) };
        let online = if max { n_g } else { jmin(n_g, jmax(1.0, or_num(p.at("diesel"), "min_units_online", 1.0))) };
        let t = if at_mv { None } else { Some(b.trafo(tr_g, kv_g)) };
        // kT groups (transformers, or MV feeders) holding `units` gensets
        let gen_group = |b: &mut Builder, kt: f64, units: f64, ex: bool| {
            let mc = b.cable("mv_gen", mv_kv, kt);
            let (id, dev) = (ex.then_some("gen_mv"), ex.then_some("mv_gen"));
            let Some(t) = &t else {
                let y = b.gen_y(&g, kv_g, units);
                b.add(Node { y, gen: Some(Gen { n: units, kva: g.kva }), ..Node::new(bus as i64, mv_kv).branch(mc).tag(id, "Genset terminals (MV)", dev) });
                return;
            };
            let mv = b.add(Node::new(bus as i64, mv_kv).branch(mc).tag(id, "Genset MV node", dev));
            let lv = b.add_trafo(mv, t, kt, Node::new(0, kv_g).tag(ex.then_some("gen_lv"), "Genset transformer LV", None));
            if ex {
                let c = b.cable("lv_gen", kv_g, 1.0);
                let y = b.gen_y(&g, kv_g, 1.0);
                b.add(Node { y, gen: Some(Gen { n: 1.0, kva: g.kva }), ..Node::new(lv as i64, kv_g).branch(c).tag(Some("gen_term"), "Genset terminals", Some("lv_gen")) });
            }
            let n = if ex { units - 1.0 } else { units };
            if n > 0.0 {
                let c = b.cable("lv_gen", kv_g, n);
                let y = b.gen_y(&g, kv_g, n);
                b.add(Node { y, gen: Some(Gen { n, kva: g.kva }), ..Node::new(lv as i64, kv_g).branch(c) });
            }
        };
        let first = jmin(online, gpt);
        let rest = online - first;
        gen_group(&mut b, 1.0, first, true);
        if rest > 0.0 { gen_group(&mut b, (rest / gpt).ceil(), rest, false); }
        b.note("Genset neutrals are taken as not earthed; an earthed star on the genset side of its transformer earths that LV bus.".into());
    }

    // the plant load: a passive feeder (motor contribution not included)
    let peak = if truthy(p.at("load").at("kw")) { max_of(&p.at("load").getv("kw")) } else { 0.0 };
    let tr_l = find_in(lib, "transformer", e.at("trafo_load").str());
    if peak > 0.0 {
        let c = b.cable("load", mv_kv, 1.0);
        let le = b.add(Node::new(bus as i64, mv_kv).branch(c).tag(Some("load_end"), "Load feeder end", Some("load")));
        if truthy(tr_l) {
            let kv = jn(tr_l, "lv_kv");
            let t = b.trafo(tr_l, kv);
            b.add_trafo(le, &t, 1.0, Node::new(0, kv).tag(Some("load_lv"), "Load LV bus", None));
        }
    }

    // MV earthing: a neutral resistor (its current limit), solid (Z0 = Z1 at the bus, set by the study), or isolated
    if e.at("mv_earthing").str() == "resistance" && jn(e, "mv_earth_a") > 0.0 {
        let rn = mv_kv * 1000.0 / SQ3 / jn(e, "mv_earth_a") / (mv_kv * mv_kv / SB);
        b.nodes[bus].y0 = b.nodes[bus].y0.add(inv(C::new(3.0 * rn, 0.0)));
    }
    Network { nodes: b.nodes, notes: b.notes }
}

/// The network re-rooted at a fault node
pub struct Solved {
    /// admittance of each node towards the sources (positive or zero sequence)
    pub y: Vec<C>,
    /// source-side voltages (U = E - V)
    pub u: Vec<C>,
    /// current of every branch from the voltage sources, by the node that owns the branch
    pub iv: Vec<C>,
    /// current of every branch from the current sources (magnitudes)
    pub ij: Vec<f64>,
    /// the current-source total reaching the fault
    pub jsum: f64,
}

/// The network re-rooted at fault node `f` with source voltage `e`; `zero`: the zero sequence (only `y` is filled)
pub fn solve_at(nodes: &[Node], f: usize, e: f64, zero: bool) -> Solved {
    let n = nodes.len();
    let mut adj: Vec<Vec<(usize, usize)>> = vec![vec![]; n];
    for (i, nd) in nodes.iter().enumerate() {
        if nd.parent >= 0 { let p = nd.parent as usize; adj[i].push((p, i)); adj[p].push((i, i)); }
    }
    let z_of = |e: usize| if zero { nodes[e].z0 } else { Some(nodes[e].z) };
    let shunt = |i: usize| if zero { nodes[i].y0 } else { nodes[i].y };
    let (mut order, mut rpar, mut redge, mut seen, mut kids) = (vec![], vec![usize::MAX; n], vec![usize::MAX; n], vec![false; n], vec![vec![]; n]);
    let mut st = vec![f];
    seen[f] = true;
    while let Some(i) = st.pop() {
        order.push(i);
        for &(j, e) in &adj[i] {
            if !seen[j] { seen[j] = true; rpar[j] = i; redge[j] = e; kids[i].push(j); st.push(j); }
        }
    }
    let (mut y, mut ybr) = (vec![ZERO; n], vec![ZERO; n]);
    for &i in order.iter().rev() {
        let mut s = shunt(i);
        for &c in &kids[i] {
            ybr[c] = match z_of(redge[c]) { Some(z) => y[c].div(ONE.add(z.mul(y[c]))), None => ZERO };
            s = s.add(ybr[c]);
        }
        y[i] = s;
    }
    if zero { return Solved { y, u: vec![], iv: vec![], ij: vec![], jsum: 0.0 }; }
    let (mut u, mut iv, mut ij, mut yup) = (vec![ZERO; n], vec![ZERO; n], vec![0.0; n], vec![ZERO; n]);
    u[f] = C::new(e, 0.0);
    for &i in &order {
        for &c in &kids[i] {
            let z = z_of(redge[c]);
            u[c] = match z { Some(z) => u[i].div(ONE.add(z.mul(y[c]))), None => ZERO };
            iv[redge[c]] = u[c].mul(y[c]);
            yup[c] = match z {
                None => ZERO,
                Some(z) if i == f => inv(z),
                Some(z) => { let a = y[i].sub(ybr[c]).add(yup[i]); a.div(ONE.add(z.mul(a))) }
            };
        }
    }
    // each current source: the share that reaches the fault, branch by branch (current divider at every node on the way)
    let mut jsum = 0.0;
    for (j, nd) in nodes.iter().enumerate() {
        if !above(nd.j, 0.0) || !seen[j] { continue; }
        let (mut m, mut fr, mut loc) = (j, ONE, y[j]);
        while m != f {
            let tot = loc.add(yup[m]);
            fr = if is_zero(yup[m]) { ZERO } else if is_zero(tot) { fr } else { fr.mul(yup[m].div(tot)) };
            if is_zero(fr) { break; }
            ij[redge[m]] += nd.j * fr.abs();
            let p = rpar[m];
            loc = y[p].sub(ybr[m]);
            m = p;
        }
        if m == f { jsum += nd.j * fr.abs(); }
    }
    Solved { y, u, iv, ij, jsum }
}

/// One fault case at a bus: kA values
#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    pub ik3: f64,
    pub ip: f64,
    pub ib: f64,
    pub ik1: f64,
    pub rx: Option<f64>,
    pub kappa: f64,
    pub earth: &'static str,
    pub z1: Option<C>,
    pub src_gen: f64,
    pub src_grid: f64,
    pub src_conv: f64,
    pub ik2: f64,
}

// One fault at bus `f` of network `nodes` in case `max`: kA values at the bus and the current through every branch (pu)
fn fault_at(p: &Value, nodes: &[Node], f: usize, max: bool) -> (Case, Vec<f64>) {
    let kv = nodes[f].kv;
    let lv = kv <= 1.0;
    let c = c_factor(max, kv);
    let ka = SB / (SQ3 * kv);
    let r = solve_at(nodes, f, c, false);
    let ikv = C::new(c, 0.0).mul(r.y[f]).abs();
    let ik3 = ikv + r.jsum;
    let z1 = if is_zero(r.y[f]) { None } else { Some(inv(r.y[f])) };
    let rx = z1.filter(|z| z.im > 0.0).map(|z| z.re / z.im);
    let kb = rx.map_or(1.0, |rx| kappa_b(rx, lv));
    let ip = kb * std::f64::consts::SQRT_2 * ikv + std::f64::consts::SQRT_2 * r.jsum;
    // breaking current: each genset's share decays with μ (its share over its rated current)
    let (mut decay, mut gen, mut grid) = (0.0, 0.0, 0.0);
    for (i, x) in nodes.iter().enumerate() {
        if let Some(g) = x.gen {
            let ig = r.u[i].mul(x.y).abs();
            gen += ig;
            decay += (1.0 - mu((ig / g.n) / (g.kva / 1000.0 / SB))) * ig;
        } else if !is_zero(x.y) {
            grid += r.u[i].mul(x.y).abs();
        }
    }
    // earth fault: sequence networks in series, Z2 = Z1; the inverters drive the positive sequence only
    let y0 = solve_at(nodes, f, c, true).y[f];
    let mut ik1 = 0.0;
    if !is_zero(y0) {
        let z0 = inv(y0);
        ik1 = match z1 { Some(z1) => 3.0 * (c + z1.abs() * r.jsum) / z1.scale(2.0).add(z0).abs(), None => r.jsum };
    }
    let earth = if is_zero(y0) { if lv { "IT" } else { "isolated" } } else if lv { "earthed" }
        else if p.at("electrical").at("mv_earthing").str() == "resistance" { "resistance" } else { "solid" };
    let branch = (0..nodes.len()).map(|i| r.iv[i].abs() + r.ij[i]).collect();
    let case = Case { ik3: ik3 * ka, ip: ip * ka, ib: (ik3 - decay) * ka, ik1: ik1 * ka, rx, kappa: kb, earth, z1,
        src_gen: gen * ka, src_grid: grid * ka, src_conv: r.jsum * ka, ik2: ik3 * ka * SQ3 / 2.0 };
    (case, branch)
}

pub const BUS_ORDER: [&str; 13] = ["mv", "grid", "pv_end", "pv_lv", "pv_inv", "bess_mv", "bess_lv", "bess_pcs", "gen_mv", "gen_lv", "gen_term", "load_end", "load_lv"];

/// The fault levels at a bus, in both cases
#[derive(Debug, Clone)]
pub struct Bus {
    pub id: &'static str,
    pub name: &'static str,
    pub kv: f64,
    pub max: Option<Case>,
    pub min: Option<Case>,
}
/// A device's voltage and its current (A) for a fault at each bus: [max, min]
#[derive(Debug, Clone, Default)]
pub struct DevCur {
    pub kv: f64,
    pub cur: BTreeMap<&'static str, [f64; 2]>,
}
/// The short-circuit study of a design
#[derive(Debug, Clone)]
pub struct FaultStudy {
    pub buses: Vec<Bus>,
    pub dev: BTreeMap<&'static str, DevCur>,
    pub notes: Vec<String>,
    pub online: f64,
}

/// The short-circuit study of design `d`: kA at the buses, A through the devices
pub fn fault_study_of(p: &Value, d: &Value) -> FaultStudy {
    let mut nets = [fault_network(p, d, true), fault_network(p, d, false)];
    // solid MV earthing: zero sequence at the bus equal to the positive sequence of each case
    if p.at("electrical").at("mv_earthing").str() == "solid" {
        for net in nets.iter_mut() {
            let y1 = solve_at(&net.nodes, 0, 1.0, false).y[0];
            net.nodes[0].y0 = net.nodes[0].y0.add(y1);
        }
    }
    let idx = |s: usize, id: &str| nets[s].nodes.iter().position(|n| n.id == Some(id));
    let mut dev: BTreeMap<&'static str, DevCur> = BTreeMap::new();
    for net in &nets {
        for n in &net.nodes { if let Some(k) = n.dev { dev.entry(k).or_insert(DevCur { kv: n.kv, cur: BTreeMap::new() }); } }
    }
    let mut buses = vec![];
    for id in BUS_ORDER {
        let Some(i_max) = idx(0, id) else { continue };
        if id == "grid" { continue; }
        let nd = &nets[0].nodes[i_max];
        let mut b = Bus { id, name: nd.name.unwrap_or(""), kv: nd.kv, max: None, min: None };
        for s in 0..2 {
            let Some(i) = idx(s, id) else { continue };
            let (case, branch) = fault_at(p, &nets[s].nodes, i, s == 0);
            for (j, n) in nets[s].nodes.iter().enumerate() {
                let Some(k) = n.dev else { continue };
                let cur = dev.get_mut(k).unwrap().cur.entry(id).or_insert([0.0, 0.0]);
                cur[s] = branch[j] * SB * 1000.0 / (SQ3 * n.kv); // A
            }
            if s == 0 { b.max = Some(case); } else { b.min = Some(case); }
        }
        buses.push(b);
    }
    let mut notes = nets[0].notes.clone();
    for n in &nets[1].notes { if !notes.contains(n) { notes.push(n.clone()); } }
    let online = nets[1].nodes.iter().filter_map(|n| n.gen).fold(0.0, |a, g| a + g.n);
    FaultStudy { buses, dev, notes, online }
}

fn cplx(z: Option<C>) -> Value { z.map_or(Value::Null, |z| Value::Arr(vec![num(z.re), num(z.im)])) }
impl Case {
    pub fn to_json(&self) -> Value {
        obj(vec![("ik3", num(self.ik3)), ("ip", num(self.ip)), ("ib", num(self.ib)), ("ik1", num(self.ik1)),
            ("rx", self.rx.map_or(Value::Null, num)), ("kappa", num(self.kappa)), ("earth", self.earth.into()), ("z1", cplx(self.z1)),
            ("src", obj(vec![("gen", num(self.src_gen)), ("grid", num(self.src_grid)), ("conv", num(self.src_conv))])), ("ik2", num(self.ik2))])
    }
}
impl FaultStudy {
    /// As the JavaScript returned it: { buses: [{ id, name, kv, max, min }], dev: { key: { kv, cur: { busId: { max, min } } } }, notes, online }
    pub fn to_json(&self) -> Value {
        let case = |c: &Option<Case>| c.as_ref().map_or(Value::Null, Case::to_json);
        let buses = self.buses.iter().map(|b| obj(vec![("id", b.id.into()), ("name", b.name.into()), ("kv", num(b.kv)), ("max", case(&b.max)), ("min", case(&b.min))])).collect::<Vec<_>>();
        let mut dev = Value::object();
        for (k, d) in &self.dev {
            let mut cur = Value::object();
            for (id, [mx, mn]) in &d.cur { cur.set(id, obj(vec![("max", num(*mx)), ("min", num(*mn))])); }
            dev.set(k, obj(vec![("kv", num(d.kv)), ("cur", cur)]));
        }
        obj(vec![("buses", Value::Arr(buses)), ("dev", dev), ("notes", Value::Arr(self.notes.iter().map(|s| s.as_str().into()).collect())), ("online", num(self.online))])
    }
}

// Hand calculations of IEC 60909-0 (once ui/tests/fault.test.js)
#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64, rel: f64, msg: &str) { assert!((a - b).abs() <= rel * b.abs(), "{msg} {a} != {b}"); }
    fn json(s: &str) -> Value { Value::parse(s).unwrap() }
    // a project with only what a case needs: no PV, no battery, gensets and load as asked; cables of zero length
    fn project(load: f64, units: f64, gen_mv: bool, mv_kv: f64, trafo_load: &str, grid_mva: f64, earthing: &str) -> Value {
        json(&format!(r#"{{
            "load": {{ "kw": [{load}] }}, "bess": {{ "energy_kwh": 0, "power_kw": 0 }}, "diesel": {{ "units": {units}, "unit_kw": 500, "min_units_online": 1 }},
            "equipment": {{ "sel": {{ "battery": "bat5", "genset": "dg500" }}, "lib": {{
                "transformer": [{{ "id": "tr1000", "name": "Test 1000 kVA 20/0.4 kV", "kva": 1000, "hv_kv": 20, "lv_kv": 0.4, "z": 6, "pk": 10.5, "vector": "Dyn11" }},
                    {{ "id": "tr2500", "name": "Generic 2500 kVA 0.4/20 kV", "kva": 2500, "hv_kv": 20, "lv_kv": 0.4, "z": 6, "pk": 22, "vector": "Dyn11" }}],
                "genset": [{{ "id": "dg500", "name": "Generic 500 kWe prime diesel", "kva": 625, "voltage": 400, "pf": 0.8, "xd2": 13 }}],
                "battery": [{{ "id": "bat5", "vac": 690, "ifault": 1.2 }}] }} }},
            "electrical": {{ "mv_kv": {mv_kv}, "trafo_pv": "tr3150", "trafo_bess": "tr5000", "trafo_gen": "tr2500", "gens_per_trafo": 1, "gen_mv": {gen_mv},
                "trafo_load": "{trafo_load}", "grid_mva": {grid_mva}, "grid_xr": 10, "mv_earthing": "{earthing}", "mv_earth_a": 300 }} }}"#))
    }
    fn bus<'a>(f: &'a FaultStudy, id: &str) -> &'a Bus { f.buses.iter().find(|b| b.id == id).unwrap() }

    #[test]
    fn a_1000_kva_dyn11_transformer_on_a_500_mva_network() {
        let p = project(500.0, 0.0, false, 20.0, "tr1000", 500.0, "resistance");
        let f = fault_study_of(&p, &json(r#"{ "circuits": [] }"#));
        let (lv, mv) = (bus(&f, "load_lv").max.clone().unwrap(), bus(&f, "mv").max.clone().unwrap());
        // network feeder: Z_Q = c_Q U_nQ² / S″kQ, referred to 0.4 kV, X/R 10
        let zq = 1.1 * 20.0 * 20.0 / 500.0 * (0.4f64 / 20.0).powi(2);
        let rq = zq / 101f64.sqrt();
        let xq = 10.0 * rq;
        // transformer: Z_T = u_k U² / S, R_T = P_k U² / S², K_T = 0.95 c_max / (1 + 0.6 x_T)
        let zt: f64 = 0.06 * 0.16;
        let rt = 10500.0 * 0.16e6 / 1e12;
        let xt = (zt * zt - rt * rt).sqrt();
        let kt = 0.95 * 1.05 / (1.0 + 0.6 * xt / 0.16);
        let (r, x) = (rq + kt * rt, xq + kt * xt);
        let ik = 1.05 * 400.0 / (SQ3 * r.hypot(x)) / 1000.0; // kA
        near(lv.ik3, ik, 1e-6, "Ik″");
        assert!(ik > 25.0 && ik < 27.0, "about c / (K_T u_k) × In = 1.05 × 24.1 kA / K_T");
        let k = 1.02 + 0.98 * (-3.0 * r / x).exp();
        near(lv.ip, (1.15 * k).min(1.8) * std::f64::consts::SQRT_2 * ik, 1e-6, "ip");
        assert_eq!(lv.ib, lv.ik3, "far from generators: Ib = Ik″");
        // line to earth: the network's zero sequence stops at the delta, Z0 = Z_T on the earthed star
        let zs = (2.0 * r + kt * rt).hypot(2.0 * x + kt * xt);
        near(lv.ik1, SQ3 * 1.05 * 400.0 / zs / 1000.0, 1e-6, "Ik1");
        // MV bus: the network alone, c = 1.1: S″k / (√3 Un)
        near(mv.ik3, 500.0 / (SQ3 * 20.0), 1e-6, "MV Ik″");
        // resistance earthed at 300 A: Ik1 ≈ c × 300 A (3 R_N dominates)
        assert!(mv.ik1 > 0.29 && mv.ik1 < 0.331, "MV Ik1 {}", mv.ik1);
        assert_eq!(mv.earth, "resistance");
    }

    #[test]
    fn two_625_kva_gensets_on_a_0_4_kv_bus() {
        let p = project(0.0, 2.0, true, 0.4, "", 0.0, "isolated");
        let f = fault_study_of(&p, &json(r#"{ "circuits": [], "nG": 2, "gKva": 625, "gpt": 1 }"#));
        let b = bus(&f, "mv");
        let (mx, mn) = (b.max.clone().unwrap(), b.min.clone().unwrap());
        // Z_G = (R_G + jX″d) U²/S with R_G = 0.15 X″d (LV), K_G = c_max / (1 + x″d sin φ); 13 % and PF 0.8 from the datasheet
        let (xd, zb): (f64, f64) = (0.13, 0.4 * 0.4 / 0.625);
        let kg = 1.05 / (1.0 + xd * 0.6);
        let zg = kg * zb * (0.15 * xd).hypot(xd);
        let ik = 2.0 * 1.05 * 400.0 / (SQ3 * zg) / 1000.0;
        near(mx.ik3, ik, 1e-6, "Ik″");
        near(mx.ip, (1.15 * kappa(0.15)).min(1.8) * std::f64::consts::SQRT_2 * ik, 1e-6, "ip");
        let ir = 625.0 / (SQ3 * 0.4) / 1000.0;
        near(mx.ib, mu(ik / 2.0 / ir) * ik, 1e-6, "Ib = μ Ik″");
        // minimum: one genset online, c_min = 0.95 and no K_G
        near(mn.ik3, 0.95 * 400.0 / (SQ3 * zb * (0.15 * xd).hypot(xd)) / 1000.0, 1e-6, "Ik″ min");
        assert_eq!(mx.earth, "IT", "genset neutrals not earthed, no transformer: an IT bus");
        assert_eq!(f.online, 1.0);
    }

    #[test]
    fn current_sources_reach_the_fault_by_the_current_divider() {
        let z = C::new(0.01, 0.05);
        let root = Node::new(-1, 1.0);
        let src = Node { z, j: 2.0, ..Node::new(0, 1.0) };
        // all of an inverter reaches a fault with no other path
        near(solve_at(&[root.clone(), src.clone()], 0, 1.0, false).jsum, 2.0, 1e-12, "lone");
        // a genset admittance ys at the inverter's node: the share to the fault is (1/z) / (ys + 1/z)
        let ys = C::new(0.5, -4.0);
        let yz = inv(z);
        let net = [root, Node { y: ys, ..src }];
        near(solve_at(&net, 0, 1.0, false).jsum, 2.0 * yz.abs() / ys.add(yz).abs(), 1e-12, "shunt");
    }

    #[test]
    fn iec_factors_and_vector_groups() {
        near(kappa(0.0), 2.0, 1e-12, "κ");
        near(kappa_b(0.15, true), 1.8, 1e-12, "κ LV");
        near(kappa_b(0.15, false), 1.15 * kappa(0.15), 1e-12, "κ MV");
        assert_eq!(mu(2.0), 1.0);
        near(mu(5.0), 0.62 + 0.72 * (-1.6f64).exp(), 1e-12, "μ");
        near(m_factor(1.8, 0.1), 0.443, 0.01, "IEC 60909-0 figure: m ≈ 0.44 at κ = 1.8, Tk = 0.1 s");
        assert_eq!(m_factor(1.0, 1.0), 0.0);
        assert_eq!(windings("Dyn11"), Windings { hv: false, lv: true, guessed: false });
        assert_eq!(windings("YNd11"), Windings { hv: true, lv: false, guessed: false });
        assert!(!windings("Dy11").lv);
        assert!(windings("").guessed);
        assert_eq!(windings(" YNyn0"), Windings { hv: true, lv: true, guessed: false });
        assert!(windings("ynx").guessed);
    }

    #[test]
    fn javascript_numbers_and_rounding() {
        assert_eq!(js_num(0.3), "0.3");
        assert_eq!(js_num(15.0), "15");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(1.5e-7), "1.5e-7");
        assert_eq!(jround(2.5), 3.0);
        assert_eq!(jround(-2.5), -2.0);
        assert_eq!(jround(0.49999999999999994), 0.0);
    }
}
