//! Radial AC load flow (backward/forward sweep) of the electrical design over the hourly dispatch of year 1. The network is
//! built per unit (S_base = 1 MVA) from the design; identical parallel items are lumped (Z / n). It keeps
//! the operation order of the interface's earlier JavaScript, so the numbers agree with it to the last bits.
//! With a power factor asked at the point of connection (electrical.pf_poc below 1) the PV inverters, PCS and gensets also
//! supply reactive power to hold it (hold_pf); without one the sweep is the JavaScript's.
use super::design::kva_of;
use super::util::{alpha, circuit, find_in, jmax, jmin, jn, jround, max_of, num, obj, selected_in, sum, truthy, C};
use crate::json::Value;

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MDAYS: [usize; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ---- JavaScript semantics the port has to keep ----

/// Math.hypot of two as the browser engine computes it (scaled, compensated), so |V| matches to the bit
fn hyp(c: C) -> f64 {
    if c.re.is_infinite() || c.im.is_infinite() { return f64::INFINITY; }
    if c.re.is_nan() || c.im.is_nan() { return f64::NAN; }
    let (a, b) = (c.re.abs(), c.im.abs());
    let max = if b > a { b } else { a };
    if max == 0.0 { return 0.0; }
    let (mut s, mut comp) = (0.0, 0.0);
    for x in [a, b] {
        let n = x / max;
        let summand = n * n - comp;
        let pre = s + summand;
        comp = (pre - s) - summand;
        s = pre;
    }
    s.sqrt() * max
}
/// A value in a template literal: numbers as Number.prototype.toString, an absent key as "undefined"
fn jstr(o: &Value, k: &str) -> String {
    if !o.has(k) { return "undefined".into(); }
    match o.at(k) {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Str(s) => s.clone(),
        Value::Num(n) if n.is_nan() => "NaN".into(),
        Value::Num(n) if n.is_infinite() => if *n > 0.0 { "Infinity".into() } else { "-Infinity".into() },
        Value::Num(n) => format!("{n}"),
        v => v.dump(),
    }
}
/// An hourly value; past the end of the series it is undefined (NaN)
fn ix(a: &[f64], t: usize) -> f64 { a.get(t).copied().unwrap_or(f64::NAN) }

/// "12 Mar" for an hour of the year
fn date_of_hour(h: usize) -> String {
    let (mut d, mut m) = (h / 24, 0);
    while m < 11 && d >= MDAYS[m] { d -= MDAYS[m]; m += 1; }
    format!("{} {}", d + 1, MONTHS[m])
}

// ---- the network ----

/// What a node draws or feeds
#[derive(Clone, Copy)]
enum Inj { Load, Pv(f64), Bess, Gen }

struct Node {
    name: String,
    parent: isize,
    z: C,
    kind: &'static str,
    inj: Option<Inj>,
}

/// The per-unit network of a design: nodes in creation order, the number of identical PV feeders, S_base (kVA), the
/// depth-first order in which parents come before children, and the ratings for reactive power when a power factor is asked
/// at the point of connection
struct Net {
    nodes: Vec<Node>,
    n_feed: f64,
    sb: f64,
    order: Vec<usize>,
    q: Option<Ratings>,
}

/// What the units can give in reactive power: the power factor and tan φ at the point of connection (the MV main bus), the kVA of all PV inverters
/// and of the PCS, and one genset's kVA with the number of gensets
struct Ratings {
    pf: f64,
    tan: f64,
    pv_kva: f64,
    bess_kva: f64,
    gen_kva: f64,
    n_gen: f64,
}
fn ratings(p: &Value, d: &Value) -> Option<Ratings> {
    let pf = jn(p.at("electrical"), "pf_poc");
    if !(pf > 0.0 && pf < 1.0) { return None; }
    let (s, bat) = (d.at("str"), selected_in(p, "battery"));
    let inv = s.at("inv");
    let bess_kva = if bat.get("power_kw", 0.0) > 0.0 { d.get("nB", 0.0) * kva_of(bat, bat.get("power_kw", 0.0)) } else { p.at("bess").get("power_kw", 0.0) };
    Some(Ratings { pf, tan: pf.acos().tan(), pv_kva: s.get("nInv", 0.0) * kva_of(inv, inv.get("pac_kw", 0.0)), bess_kva, gen_kva: d.get("gKva", 0.0), n_gen: d.get("nG", 0.0) })
}

fn topo(nodes: &[Node]) -> Vec<usize> {
    let mut children: Vec<Vec<usize>> = vec![vec![]; nodes.len()];
    for (i, nd) in nodes.iter().enumerate() { if nd.parent >= 0 { children[nd.parent as usize].push(i); } }
    let (mut order, mut st) = (vec![], vec![0]);
    while let Some(i) = st.pop() { order.push(i); st.extend(children[i].iter().copied()); }
    order
}

fn network(p: &Value, d: &Value) -> Net {
    let e = p.at("electrical");
    let sb = 1000.0;
    let lib = p.at("equipment").at("lib");
    let mut nodes = vec![Node { name: "MV main bus".into(), parent: -1, z: C::new(0.0, 0.0), kind: "mv", inj: None }];
    let add = |nodes: &mut Vec<Node>, name: String, parent: usize, z: C, kind: &'static str, inj: Option<Inj>| {
        nodes.push(Node { name, parent: parent as isize, z, kind, inj });
        nodes.len() - 1
    };
    let cab_z = |key: &str, vll: f64| {
        let c = circuit(d, key);
        if !truthy(c.at("cab")) { return C::new(0.0, 0.0); }
        let cab = c.at("cab");
        let zb = (vll * vll) / (sb * 1000.0);
        let r20 = jn(cab, "r20");
        let al = alpha(cab.at("material").str());
        let rhot = r20 * (1.0 + al * (70.0 - 20.0)) / 1000.0;
        let x = if truthy(cab.at("x")) { jn(cab, "x") } else { 0.0 };
        let (l, runs) = (jn(c, "L"), jn(c, "runs"));
        let r = rhot * l / runs;
        let xx = x / 1000.0 * l / runs;
        C::new(r / zb, xx / zb)
    };
    let tr_z = |t: &Value, n: f64| {
        let kva = jn(t, "kva");
        let r = jn(t, "pk") / kva;
        let zt = jn(t, "z") / 100.0;
        let x = jmax(0.0, zt * zt - r * r).sqrt();
        C::new(r * sb / kva / n, x * sb / kva / n)
    };
    let vmv = jn(e, "mv_kv") * 1000.0;
    // PV: one representative feeder with its transformers along it; results scaled by the number of feeders
    let pv_f = circuit(d, "mv_pv");
    let n_feed = if pv_f.is_null() { 1.0 } else { jn(pv_f, "count") };
    let tr_pv = find_in(lib, "transformer", e.at("trafo_pv").str());
    if truthy(d.at("str")) && !tr_pv.is_null() && truthy(d.at("nTrPV")) {
        let per = jmax(1.0, jround(jn(d, "nTrPV") / n_feed));
        let z_feed = cab_z("mv_pv", vmv);
        let z_lv = cab_z("lv_pv", jn(d.at("str").at("inv"), "vac")).scale(1.0 / jn(d, "invPerTr"));
        let mut prev = 0;
        let mut k = 0.0;
        while k < per {
            let kk = k as usize + 1;
            let mv = add(&mut nodes, format!("PV feeder node {kk}"), prev, z_feed.scale(1.0 / per), "mv", None);
            let lv = add(&mut nodes, format!("PV transformer {kk} LV"), mv, tr_z(tr_pv, 1.0), "lv", None);
            add(&mut nodes, format!("PV inverters {kk} (\u{d7}{})", jstr(d, "invPerTr")), lv, z_lv, "lv", Some(Inj::Pv(1.0 / (per * n_feed))));
            prev = mv;
            k += 1.0;
        }
    }
    let tr_b = find_in(lib, "transformer", e.at("trafo_bess").str());
    if jn(p.at("bess"), "energy_kwh") > 0.0 && !tr_b.is_null() && truthy(d.at("nTrB")) {
        let mv = add(&mut nodes, "BESS MV node".into(), 0, cab_z("mv_bess", vmv), "mv", None);
        let lv = add(&mut nodes, "BESS transformer LV".into(), mv, tr_z(tr_b, jn(d, "nTrB")), "lv", None);
        let bat = selected_in(p, "battery");
        let vac = if bat.is_null() { 690.0 } else { jn(bat, "vac") };
        add(&mut nodes, format!("BESS PCS (\u{d7}{})", jstr(d, "nB")), lv, cab_z("lv_bess", vac).scale(1.0 / jn(d, "nB")), "lv", Some(Inj::Bess));
    }
    let tr_g = find_in(lib, "transformer", e.at("trafo_gen").str());
    let dg = selected_in(p, "genset");
    if jn(d, "nG") > 0.0 {
        let gen_mv = truthy(e.at("gen_mv"));
        let n_grp = if gen_mv { jn(d, "nG") } else { jn(d, "nTrG") };
        let mv = add(&mut nodes, "Genset MV node".into(), 0, cab_z("mv_gen", vmv).scale(1.0 / jmax(1.0, n_grp)), "mv", None);
        if !gen_mv && !tr_g.is_null() {
            let lv = add(&mut nodes, "Genset transformer LV".into(), mv, tr_z(tr_g, jn(d, "nTrG")), "lv", None);
            let v = if dg.is_null() { 400.0 } else { jn(dg, "voltage") };
            add(&mut nodes, format!("Genset terminals (\u{d7}{})", jstr(d, "nG")), lv, cab_z("lv_gen", v).scale(1.0 / jn(d, "nG")), "lv", Some(Inj::Gen));
        } else {
            nodes[mv].inj = Some(Inj::Gen);
        }
    }
    let tr_l = find_in(lib, "transformer", e.at("trafo_load").str());
    let lm = add(&mut nodes, "Load feeder end".into(), 0, cab_z("load", vmv), "mv", if tr_l.is_null() { Some(Inj::Load) } else { None });
    if !tr_l.is_null() {
        let n = (max_of(&p.at("load").getv("kw")) / jn(e, "pf_load") / jn(tr_l, "kva")).ceil();
        add(&mut nodes, "Load LV bus".into(), lm, tr_z(tr_l, n), "lv", Some(Inj::Load));
    }
    let order = topo(&nodes);
    Net { nodes, n_feed, sb, order, q: ratings(p, d) }
}

// ---- the sweep ----

/// The buffers of one sweep, reused hour after hour
struct Work {
    v: Vec<C>,
    ib: Vec<C>,
    ii: Vec<C>,
    /// hold_pf's scratch: each node's reactive headroom and its power before the reactive share
    room: Vec<f64>,
    s0: Vec<C>,
}
impl Work {
    fn new(n: usize) -> Work {
        Work { v: vec![C::default(); n], ib: vec![C::default(); n], ii: vec![C::default(); n], room: vec![0.0; n], s0: vec![C::default(); n] }
    }
}

/// S: complex power drawn at each node (pu, load convention). Leaves the voltages in w.v and returns the branch losses (pu).
fn sweep(nodes: &[Node], order: &[usize], s: &[C], w: &mut Work) -> f64 {
    w.v.iter_mut().for_each(|v| *v = C::new(1.0, 0.0));
    for _ in 0..30 {
        for ((ii, si), vi) in w.ii.iter_mut().zip(s).zip(&w.v) { *ii = si.div(*vi).conj(); }
        w.ib.iter_mut().for_each(|b| *b = C::new(0.0, 0.0));
        for &i in order.iter().rev() {                 // backward: accumulate branch currents
            w.ib[i] = w.ib[i].add(w.ii[i]);
            let par = nodes[i].parent;
            if par > 0 { let par = par as usize; w.ib[par] = w.ib[par].add(w.ib[i]); }
        }
        let mut dmax = 0.0;
        for &i in order {                              // forward: voltage drops from the slack
            if i == 0 { continue; }
            let nv = w.v[nodes[i].parent as usize].sub(nodes[i].z.mul(w.ib[i]));
            dmax = jmax(dmax, hyp(nv.sub(w.v[i])));
            w.v[i] = nv;
        }
        if dmax < 1e-7 { break; }
    }
    let mut loss = 0.0;
    for (nd, b) in nodes.iter().zip(&w.ib).skip(1) { loss += nd.z.re * (b.re * b.re + b.im * b.im); }
    loss
}

/// The power the MV main bus delivers into the network after a sweep (pu, load convention)
fn slack_power(nodes: &[Node], w: &Work) -> C {
    let mut i = w.ii[0];
    for (nd, b) in nodes.iter().zip(&w.ib).skip(1) { if nd.parent == 0 { i = i.add(*b); } }
    w.v[0].mul(i.conj())
}

/// One hour: the network, then the PV feeder alone for the other identical feeders it stands for. Returns the losses (kW) and
/// the power the MV main bus delivers to all of it (pu). Leaves the voltages of the network in w.v.
fn solve(net: &Net, s: &[C], s_pv: &mut [C], w: &mut Work, w_pv: &mut Work) -> (f64, C) {
    let nodes = &net.nodes;
    let mut loss_kw = sweep(nodes, &net.order, s, w) * net.sb;
    let mut sl = slack_power(nodes, w);
    if net.n_feed > 1.0 {
        for ((x, si), nd) in s_pv.iter_mut().zip(s).zip(nodes) { *x = if matches!(nd.inj, Some(Inj::Pv(_))) { *si } else { C::new(0.0, 0.0) }; }
        loss_kw += sweep(nodes, &net.order, s_pv, w_pv) * net.sb * (net.n_feed - 1.0);
        sl = sl.add(slack_power(nodes, w_pv).scale(net.n_feed - 1.0));
    }
    (loss_kw, sl)
}

/// One hour with the units holding the power factor at the point of connection (the MV main bus): the reactive power drawn
/// there may be at most P tan φ, so at export the plant supplies Q = P tan φ with its active power, and at import it covers what
/// the load and the network draw beyond that. The units share it by their headroom √(S² − P²): PV inverters while they produce,
/// the PCS, the gensets that run. Writes their reactive power into s; returns the losses (kW), the units' reactive power (kvar)
/// and whether their headroom fell short.
#[allow(clippy::too_many_arguments)]
fn hold_pf(net: &Net, r: &Ratings, h: &Hourly, t: usize, s: &mut [C], s_pv: &mut [C], w: &mut Work, w_pv: &mut Work) -> (f64, f64, bool) {
    let mut room = std::mem::take(&mut w.room);
    room.clear();
    room.extend(net.nodes.iter().zip(s.iter()).map(|(nd, x)| {
        let kva = match nd.inj {
            Some(Inj::Pv(share)) if x.re < 0.0 => r.pv_kva * share,
            Some(Inj::Bess) => r.bess_kva,
            Some(Inj::Gen) => r.gen_kva * h.gen_units.as_ref().map_or(if x.re < 0.0 { r.n_gen } else { 0.0 }, |g| { let u = ix(g, t); if u > 0.0 { u } else { 0.0 } }),
            _ => 0.0,
        } / net.sb;
        (kva * kva - x.re * x.re).max(0.0).sqrt()
    }));
    // the PV feeder modelled stands for n_feed of them
    let total: f64 = net.nodes.iter().zip(&room).map(|(nd, q)| if matches!(nd.inj, Some(Inj::Pv(_))) { q * net.n_feed } else { *q }).sum();
    let mut s0 = std::mem::take(&mut w.s0);
    s0.clear();
    s0.extend_from_slice(s);
    let (mut loss, mut sl) = solve(net, s, s_pv, w, w_pv);
    let mut qu = 0.0;
    for _ in 0..12 {
        let next = (qu + sl.im - sl.re * r.tan).clamp(0.0, total);
        if (next - qu).abs() < 1e-9 { break; }
        qu = next;
        let f = if total > 0.0 { qu / total } else { 0.0 };
        for ((x, x0), q) in s.iter_mut().zip(&s0).zip(&room) { *x = C::new(x0.re, x0.im - f * q); }
        (loss, sl) = solve(net, s, s_pv, w, w_pv);
    }
    (w.room, w.s0) = (room, s0);
    (loss, qu * net.sb, sl.im - sl.re * r.tan > 1e-3)
}

/// The hourly flows the load flow reads, taken out of the JSON once
struct Hourly {
    pv_to_load: Vec<f64>,
    pv_to_bess: Vec<f64>,
    bess_dis: Vec<f64>,
    gen_to_load: Vec<f64>,
    gen_to_bess: Vec<f64>,
    load: Vec<f64>,
    pv_avail: Vec<f64>,
    wind_to_load: Option<Vec<f64>>,
    wind_to_bess: Option<Vec<f64>>,
    aux: Option<Vec<f64>>,
    gen_units: Option<Vec<f64>>,
    /// battery charging from the grid (with grid charging or a frequency reserve)
    grid_to_bess: Option<Vec<f64>>,
}
impl Hourly {
    fn of(h: &Value) -> Hourly {
        let opt = |k: &str| truthy(h.at(k)).then(|| h.getv(k));
        Hourly {
            pv_to_load: h.getv("pv_to_load"), pv_to_bess: h.getv("pv_to_bess"), bess_dis: h.getv("bess_dis"),
            gen_to_load: h.getv("gen_to_load"), gen_to_bess: h.getv("gen_to_bess"), load: h.getv("load"), pv_avail: h.getv("pv_avail"),
            wind_to_load: opt("wind_to_load"), wind_to_bess: opt("wind_to_bess"), aux: opt("aux"), gen_units: opt("gen_units"),
            grid_to_bess: opt("grid_to_bess"),
        }
    }
}

/// What each node draws (load) or feeds (negative) in hour t, written into s
fn inject(nodes: &[Node], h: &Hourly, t: usize, tan_l: f64, sb: f64, s: &mut [C]) {
    let wind = match (&h.wind_to_load, &h.wind_to_bess) {
        (Some(wl), wb) => ix(wl, t) + wb.as_ref().map_or(f64::NAN, |wb| ix(wb, t)),
        (None, _) => 0.0,
    };
    let pv_kw = ix(&h.pv_to_load, t) + ix(&h.pv_to_bess, t) + wind;
    let mut bess_kw = ix(&h.bess_dis, t) - ix(&h.pv_to_bess, t) - ix(&h.gen_to_bess, t) - h.wind_to_bess.as_ref().map_or(0.0, |w| ix(w, t));
    if let Some(g) = &h.grid_to_bess { bess_kw -= ix(g, t); }
    let gen_kw = ix(&h.gen_to_load, t) + ix(&h.gen_to_bess, t);
    // the load feeder carries the site load; plant auxiliaries are drawn at the plant
    let site_kw = ix(&h.load, t) - h.aux.as_ref().map_or(0.0, |a| ix(a, t));
    for (x, nd) in s.iter_mut().zip(nodes) {
        *x = match nd.inj {
            None => C::new(0.0, 0.0),
            Some(Inj::Load) => C::new(site_kw / sb, site_kw * tan_l / sb),
            Some(Inj::Pv(share)) => C::new(-pv_kw * share / sb, 0.0),
            Some(Inj::Bess) => C::new(-bess_kw / sb, 0.0),
            Some(Inj::Gen) => C::new(-gen_kw / sb, 0.0),
        };
    }
}

fn argmax(a: &[f64]) -> usize {
    let mut b = 0;
    for (i, &x) in a.iter().enumerate() { if x > ix(a, b) { b = i; } }
    b
}

fn tan_l(p: &Value) -> f64 { jmin(1.0, jn(p.at("electrical"), "pf_load")).acos().tan() }

/// The load flow of the whole year: network losses, bus voltage range, violations, the hours worth looking at, and what the
/// charts need. The JavaScript result without its network (`net`), which stays inside the engine.
pub fn run_load_flow(p: &Value, d: &Value, sim: &Value) -> Value {
    let h = Hourly::of(sim.at("result").at("hourly"));
    let net = network(p, d);
    let (nodes, sb) = (&net.nodes, net.sb);
    let tan_l = tan_l(p);
    let (nh, n) = (h.load.len(), nodes.len());
    let (mut vmin, mut vmax) = (vec![9.0; n], vec![0.0; n]);
    let (mut loss_h, mut vd_h, mut v_end) = (vec![0.0; nh], vec![0.0; nh], vec![0.0; nh]);
    let (mut viol, mut loss_tot) = (0usize, 0.0);
    let end_pv = nodes.iter().rposition(|nd| matches!(nd.inj, Some(Inj::Pv(_))));
    let lims: Vec<(f64, f64)> = nodes.iter().map(|nd| if nd.kind == "mv" { (0.95, 1.05) } else { (0.9, 1.1) }).collect();
    let (mut s, mut s_pv, mut w, mut w_pv) = (vec![C::default(); n], vec![C::default(); n], Work::new(n), Work::new(n));
    let (mut kvarh, mut short_h) = (0.0, 0usize);
    for t in 0..nh {
        inject(nodes, &h, t, tan_l, sb, &mut s);
        // the PV feeder is modelled once: its losses count for every identical feeder
        let loss_kw = match &net.q {
            None => solve(&net, &s, &mut s_pv, &mut w, &mut w_pv).0,
            Some(r) => {
                let (loss, q, short) = hold_pf(&net, r, &h, t, &mut s, &mut s_pv, &mut w, &mut w_pv);
                kvarh += q;
                if short { short_h += 1; }
                loss
            }
        };
        loss_h[t] = loss_kw;
        loss_tot += loss_kw;
        let mut vd = 0.0;
        for (i, v) in w.v.iter().enumerate() {
            let m = hyp(*v);
            vmin[i] = jmin(vmin[i], m);
            vmax[i] = jmax(vmax[i], m);
            vd += (m - 1.0).abs();
            if m < lims[i].0 || m > lims[i].1 { viol += 1; }
        }
        vd_h[t] = vd;
        v_end[t] = end_pv.map_or(1.0, |e| hyp(w.v[e]));
    }
    // the hour selector: the worst-case hours
    let hours: Vec<Value> = [("Peak PV hour", argmax(&h.pv_avail)), ("Peak load hour", argmax(&h.load)),
        ("Highest voltage deviation", argmax(&vd_h)), ("Highest network loss", argmax(&loss_h))]
        .iter()
        .map(|&(k, hr)| obj(vec![("h", Value::Num(hr as f64)), ("label", Value::Str(format!("{k}: {} {:02}:00", date_of_hour(hr), hr % 24)))]))
        .collect();
    let simple = if truthy(d.at("loss")) {
        let l = d.at("loss");
        num(jn(l, "pv_ac") + jn(l, "bess") + jn(l, "gen") + jn(l, "load"))
    } else {
        Value::Null
    };
    let nums = |a: &[f64]| Value::Arr(a.iter().map(|&x| num(x)).collect());
    let mut out = obj(vec![
        ("tanL", num(tan_l)),
        ("vEnd", nums(&v_end)),
        ("vmin", nums(&vmin)),
        ("vmax", nums(&vmax)),
        ("lims", Value::Arr(lims.iter().map(|&(a, b)| Value::Arr(vec![Value::Num(a), Value::Num(b)])).collect())),
        ("viol", Value::Num(viol as f64)),
        ("lossTot", num(loss_tot)),
        ("hours", Value::Arr(hours)),
        ("simple", simple),
        ("loadTotal", num(sum(&h.load))),
        ("vdMean", num(sum(&vd_h) / nh as f64)),
        ("nh", Value::Num(nh as f64)),
    ]);
    // with a power factor asked at the point of connection: the units' reactive energy and the hours they could not hold it
    if let Some(r) = &net.q {
        out.set("reactive", obj(vec![("pf", num(r.pf)), ("kvarh", num(kvarh)), ("shortH", Value::Num(short_h as f64))]));
    }
    out
}

/// The voltages of every bus in hour t: { names, kinds, vm }. The network is rebuilt from the project and the design.
pub fn bus_voltages(p: &Value, d: &Value, sim: &Value, t: usize) -> Value {
    let h = Hourly::of(sim.at("result").at("hourly"));
    let net = network(p, d);
    let n = net.nodes.len();
    let (mut s, mut w) = (vec![C::default(); n], Work::new(n));
    inject(&net.nodes, &h, t, tan_l(p), net.sb, &mut s);
    match &net.q {
        None => { sweep(&net.nodes, &net.order, &s, &mut w); }
        Some(r) => { hold_pf(&net, r, &h, t, &mut s, &mut vec![C::default(); n], &mut w, &mut Work::new(n)); }
    }
    obj(vec![
        ("names", Value::Arr(net.nodes.iter().map(|nd| Value::Str(nd.name.clone())).collect())),
        ("kinds", Value::Arr(net.nodes.iter().map(|nd| Value::Str(nd.kind.into())).collect())),
        ("vm", Value::Arr(w.v.iter().map(|&v| num(hyp(v))).collect())),
    ])
}

