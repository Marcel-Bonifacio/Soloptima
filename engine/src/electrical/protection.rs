//! Protection coordination of the plant network, once the interface's JavaScript: the overcurrent devices of the main
//! breakers with inverse-time curves (IEC 60255-151), settings suggested from the load and fault currents, the grading margin
//! between upstream and downstream devices, and the short-circuit duty of the breakers and the cables. The fault currents come
//! from fault.rs; the time-current chart stays in the interface.
use super::fault::{above, fault_study_of, js_str, m_factor, FaultStudy};
use super::util::{circuit, find_in, fmt_num, is_al, jmax, jmin, jn, js_num, num, obj, truthy, SQ3};
use crate::json::Value;

/// An inverse-time curve t = TMS k / (M^a - 1) (IEC 60255-151)
pub struct Curve {
    pub key: &'static str,
    pub label: &'static str,
    pub k: f64,
    pub a: f64,
}
pub const CURVES: [Curve; 4] = [
    Curve { key: "SI", label: "IEC standard inverse", k: 0.14, a: 0.02 },
    Curve { key: "VI", label: "IEC very inverse", k: 13.5, a: 1.0 },
    Curve { key: "EI", label: "IEC extremely inverse", k: 80.0, a: 2.0 },
    Curve { key: "LTI", label: "IEC long-time inverse", k: 120.0, a: 1.0 },
];
fn curve(key: &str) -> Option<&'static Curve> { CURVES.iter().find(|c| c.key == key) }
/// s: breaker opening, instantaneous element
pub const T_BREAKER: f64 = 0.05;
pub const T_INST: f64 = 0.05;
pub const TMS_MIN: f64 = 0.05;
pub const TMS_STEP: f64 = 0.025;
pub const TMS_MAX: f64 = 1.2;
const M_MAX: f64 = 20.0; // the curves are flat beyond 20 × pickup (IEC 60255-151)
const K_CU: f64 = 143.0; // A·√s/mm², XLPE 90 → 250 °C (IEC 60949)
const K_AL: f64 = 94.0;

/// An overcurrent device. `bus`: where the breaker sits (its duty), `zone`: the far end of what it protects (its sensitivity),
/// `circuit`: the cable it protects
pub struct DevDef {
    pub key: &'static str,
    pub name: &'static str,
    pub bus: &'static [&'static str],
    pub zone: &'static str,
    pub circuit: Option<&'static str>,
}
/// The feeder breakers of the MV switchboard and the LV breakers of the stations
pub const DEVICES: [DevDef; 8] = [
    DevDef { key: "load", name: "Load feeder", bus: &["mv"], zone: "load_end", circuit: Some("load") },
    DevDef { key: "grid", name: "Utility incomer", bus: &["mv"], zone: "mv", circuit: None },
    DevDef { key: "mv_pv", name: "PV feeder", bus: &["mv"], zone: "pv_end", circuit: Some("mv_pv") },
    DevDef { key: "lv_pv", name: "PV transformer LV incomer", bus: &["pv_lv"], zone: "pv_inv", circuit: None },
    DevDef { key: "mv_bess", name: "BESS feeder", bus: &["mv"], zone: "bess_mv", circuit: Some("mv_bess") },
    DevDef { key: "lv_bess", name: "BESS PCS breaker", bus: &["bess_lv", "bess_pcs"], zone: "bess_pcs", circuit: Some("lv_bess") },
    DevDef { key: "mv_gen", name: "Genset feeder", bus: &["mv"], zone: "gen_mv", circuit: Some("mv_gen") },
    DevDef { key: "lv_gen", name: "Genset breaker", bus: &["gen_lv", "gen_term"], zone: "gen_lv", circuit: Some("lv_gen") },
];
/// [downstream, upstream, fault bus, case]: the downstream device must clear the fault before the upstream one. Bus "head": a
/// fault on the downstream MV feeder just past its breaker (fed by every other branch of the MV bus)
pub const PAIRS: [(&str, &str, &str, &str); 7] = [
    ("load", "mv_gen", "head", "Fault on the load feeder"), ("load", "mv_bess", "head", "Fault on the load feeder"),
    ("load", "mv_pv", "head", "Fault on the load feeder"), ("load", "grid", "head", "Fault on the load feeder"),
    ("mv_gen", "lv_gen", "mv", "Fault on the MV bus"), ("lv_pv", "mv_pv", "pv_inv", "Fault on an inverter cable"),
    ("lv_bess", "mv_bess", "bess_pcs", "Fault on a PCS cable"),
];
// the cables checked for their short-time withstand: the buses at both ends and the device that clears them
const CABLES: [(&str, [&str; 3]); 7] = [
    ("lv_pv", ["pv_lv", "pv_inv", "lv_pv"]), ("mv_pv", ["mv", "pv_end", "mv_pv"]), ("lv_bess", ["bess_lv", "bess_pcs", "lv_bess"]),
    ("mv_bess", ["mv", "bess_mv", "mv_bess"]), ("lv_gen", ["gen_lv", "gen_term", "lv_gen"]), ("mv_gen", ["mv", "gen_mv", "mv_gen"]),
    ("load", ["mv", "load_end", "load"]),
];

/// Relay settings: curve key, pickup (A), time multiplier, instantaneous element (A)
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub curve: &'static str,
    pub pickup: f64,
    pub tms: f64,
    pub inst: Option<f64>,
}
impl Settings {
    fn to_json(&self) -> Value {
        obj(vec![("curve", self.curve.into()), ("pickup", num(self.pickup)), ("tms", num(self.tms)), ("inst", self.inst.map_or(Value::Null, num))])
    }
}

/// The relay operating time (s) of settings d at current I (A), infinity when it does not operate
pub fn trip_time(d: &Settings, i: f64) -> f64 {
    if !above(i, d.pickup) { return f64::INFINITY; }
    if let Some(inst) = d.inst { if inst > 0.0 && i >= inst { return T_INST; } }
    let c = curve(d.curve).unwrap_or(&CURVES[0]);
    let m = jmin(i / d.pickup, M_MAX);
    d.tms * c.k / (m.powf(c.a) - 1.0)
}
/// The smallest time multiplier that gives time t at current I
pub fn tms_for(d: &Settings, i: f64, t: f64) -> f64 {
    let c = curve(d.curve).unwrap_or(&CURVES[0]);
    let m = jmin(i / d.pickup, M_MAX);
    t * (m.powf(c.a) - 1.0) / c.k
}
fn ceil_step(x: f64, s: f64) -> f64 { (x / s - 1e-9).ceil() * s }
/// A pickup rounded up to a step a relay or trip unit offers
pub fn round_pickup(i: f64) -> f64 {
    let s = if i < 50.0 { 1.0 } else if i < 200.0 { 5.0 } else if i < 1000.0 { 10.0 } else { 50.0 };
    ceil_step(i, s)
}

/// The fault duty at a breaker's bus (kA)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Duty {
    pub ik3: f64,
    pub ip: f64,
    pub ib: f64,
    pub kappa: f64,
}

// Array.prototype.sort: stable, a comparator result of NaN counts as equal
fn js_sort(v: &mut [&Value], cmp: impl Fn(&Value, &Value) -> f64) {
    for i in 1..v.len() {
        let mut j = i;
        while j > 0 && cmp(v[j - 1], v[j]) > 0.0 { v.swap(j - 1, j); j -= 1; }
    }
}
/// The breaker of a device: the smallest of library `lib` (the breaker datasheets) for the voltage that carries the current
/// and meets the fault duty, else the largest that carries it, else the largest for the voltage
pub fn pick_breaker<'a>(lib: &'a Value, kv: f64, in_: f64, duty: &Duty) -> Option<&'a Value> {
    let mv = kv > 1.0;
    let mut ok: Vec<&Value> = lib.arr().iter()
        .filter(|b| { let u = jn(b, "ur_kv"); u >= kv - 1e-9 && (if mv { u > 1.0 } else { u <= 1.000001 }) }).collect();
    let mut fits: Vec<&Value> = ok.iter().copied().filter(|b| jn(b, "ir") >= in_).collect();
    js_sort(&mut fits, |a, b| { let d = jn(a, "ir") - jn(b, "ir"); if d != 0.0 && !d.is_nan() { d } else { jn(a, "icu_ka") - jn(b, "icu_ka") } });
    let strong = fits.iter().copied().find(|b| {
        let icm = jn(b, "icm_ka");
        jn(b, "icu_ka") >= (if mv { duty.ib } else { duty.ik3 }) && (!above(icm, 0.0) || icm >= duty.ip)
    });
    strong.or_else(|| fits.last().copied()).or_else(|| { js_sort(&mut ok, |a, b| jn(b, "ir") - jn(a, "ir")); ok.first().copied() })
}

// A device of the study
struct Dev<'a> {
    x: &'static DevDef,
    kv: f64,
    in_: f64,
    iz: Option<f64>,
    duty: Duty,
    sug: Settings,
    o: Value,
    set: Settings,
    brk: Option<&'a Value>,
    auto: bool,
    min_fault: f64,
    max_fault: f64,
    chk: Vec<String>,
    t_clear: Option<f64>,
    ith: Option<f64>,
    t_i2t: Option<f64>,
}
impl Dev<'_> {
    // the settings in force: what the user typed where it is valid, else the suggestion
    fn eff(&self) -> Settings {
        let o = &self.o;
        let fin = |k: &str| match o.at(k) { Value::Num(x) if x.is_finite() => Some(*x), _ => None };
        Settings {
            curve: match o.at("curve") { Value::Str(s) => curve(s).map_or(self.sug.curve, |c| c.key), _ => self.sug.curve },
            pickup: fin("pickup").filter(|&p| p > 0.0).unwrap_or(self.sug.pickup),
            tms: fin("tms").filter(|&t| t > 0.0).unwrap_or(self.sug.tms),
            inst: match fin("inst") { Some(i) => (i > 0.0).then_some(i), None => self.sug.inst },
        }
    }
    fn to_json(&self) -> Value {
        let x = self.x;
        let opt = |v: Option<f64>| v.map_or(Value::Null, num);
        let mut o = obj(vec![("key", x.key.into()), ("name", x.name.into()), ("bus", Value::Arr(x.bus.iter().map(|&b| b.into()).collect())),
            ("zone", x.zone.into()), ("kv", num(self.kv)), ("In", num(self.in_)), ("Iz", opt(self.iz)),
            ("duty", obj(vec![("ik3", num(self.duty.ik3)), ("ip", num(self.duty.ip)), ("ib", num(self.duty.ib)), ("kappa", num(self.duty.kappa))])),
            ("sug", self.sug.to_json()), ("o", self.o.clone()), ("set", self.set.to_json()), ("brk", self.brk.cloned().unwrap_or(Value::Null)),
            ("auto", self.auto.into()), ("minFault", num(self.min_fault)), ("maxFault", num(self.max_fault)),
            ("chk", Value::Arr(self.chk.iter().map(|s| s.as_str().into()).collect()))]);
        if let Some(c) = x.circuit { o.set("circuit", c); }
        for (k, v) in [("tClear", self.t_clear), ("ith", self.ith), ("tI2t", self.t_i2t)] { if let Some(v) = v { o.set(k, num(v)); } }
        o
    }
}

// `${fmtNum(o[k], d)}`: a dash for null as for no number
fn fmt_v(o: &Value, k: &str, d: usize) -> String { if o.at(k).is_null() && o.has(k) { "\u{2013}".into() } else { fmt_num(jn(o, k), d) } }

/// The protection study of design `d`: fault levels (F), device settings, grading, breaker and cable duty, warnings
pub fn protection_study(p: &Value, d: &Value) -> Value {
    let e = p.at("electrical");
    let lib = p.at("equipment").at("lib");
    let f = fault_study_of(p, d);
    let mut warn: Vec<String> = vec![];
    let margin = if jn(e, "grading_s") > 0.0 { jn(e, "grading_s") } else { 0.3 };
    let t_max = if jn(e, "sc_t_max") > 0.0 { jn(e, "sc_t_max") } else { 1.0 };
    let bus = |id: &str| f.buses.iter().find(|b| b.id == id);
    // the current through device k for a fault at bus id. "head": a fault on an MV feeder just past its breaker, which carries
    // what every other branch feeds into the MV bus (the bus current less the feeder's own share); for any other device the bus fault
    let own = |f: &FaultStudy, k: &str, id: &str, s: usize| f.dev.get(k).and_then(|d| d.cur.get(id)).map_or(0.0, |c| c[s]);
    let cur = |k: &str, id: &str, s: usize| -> f64 {
        if id != "head" { return own(&f, k, id, s); }
        let mv = bus("mv").and_then(|b| if s == 0 { b.max.as_ref() } else { b.min.as_ref() });
        let mv_all = mv.map_or(0.0, |c| c.ik3 * 1000.0);
        if f.dev.get(k).is_some_and(|d| d.kv > 1.0) { jmax(0.0, mv_all - own(&f, k, "mv", s)) } else { own(&f, k, "mv", s) }
    };
    let faults: Vec<&str> = std::iter::once("head").chain(f.buses.iter().map(|b| b.id)).collect();
    let up_at = |b: &'static str| if b == "head" { "mv" } else { b }; // the upstream device of a feeder fault carries its own branch's share
    let tr_pv = find_in(lib, "transformer", e.at("trafo_pv").str());
    let ov = e.at("prot");
    // the utility incomer carries the larger of the import to the load and the export of the plant's feeders
    let export_i = ["mv_pv", "mv_bess", "mv_gen"].iter().fold(0.0, |a, k| { let c = circuit(d, k); a + if truthy(c) { jn(c, "I") * jn(c, "count") } else { 0.0 } });
    let mut dev: Vec<Dev> = vec![];
    for x in &DEVICES {
        let Some(fd) = f.dev.get(x.key) else { continue };
        if x.key == "grid" && !above(jn(e, "grid_mva"), 0.0) { continue; }
        let c = x.circuit.map_or(&Value::Null, |k| circuit(d, k));
        let kv = fd.kv;
        let in_ = match x.key {
            "lv_pv" => if truthy(tr_pv) { jn(tr_pv, "kva") / (SQ3 * kv) } else { 0.0 },
            "grid" => { let l = circuit(d, "load"); jmax(if truthy(l) { jn(l, "I") } else { 0.0 }, export_i) }
            _ => if truthy(c) { jn(c, "I") } else { 0.0 },
        };
        if !above(in_, 0.0) { continue; } // nothing to carry, nothing to set
        let mut duty = Duty { ik3: 0.0, ip: 0.0, ib: 0.0, kappa: 1.0 };
        for b in x.bus {
            if let Some(m) = bus(b).and_then(|b| b.max.as_ref()) {
                duty = Duty { ik3: jmax(duty.ik3, m.ik3), ip: jmax(duty.ip, m.ip), ib: jmax(duty.ib, m.ib), kappa: jmax(duty.kappa, m.kappa) };
            }
        }
        let o = if truthy(ov.at(x.key)) { ov.at(x.key).clone() } else { Value::object() };
        let sug = Settings { curve: "SI", pickup: round_pickup(1.25 * in_), tms: TMS_MIN, inst: None };
        let iz = (truthy(c) && truthy(c.at("amp"))).then(|| jn(c, "amp"));
        dev.push(Dev { x, kv, in_, iz, duty, set: sug.clone(), sug, o, brk: None, auto: true, min_fault: 0.0, max_fault: 0.0, chk: vec![], t_clear: None, ith: None, t_i2t: None });
    }
    let at = |dev: &[Dev], k: &str| dev.iter().position(|d| d.x.key == k);
    // instantaneous elements of the transformer feeders: above the LV through-fault (× 1.3), and only if below the MV-end fault
    let inst_of = |dev: &mut Vec<Dev>, k: &str, lv_bus: &str, mv_bus: &str| {
        let Some(i) = at(dev, k) else { return };
        let through = cur(k, lv_bus, 0);
        let mv_min = cur(k, mv_bus, 1) * SQ3 / 2.0;
        let ip = round_pickup(1.3 * through);
        if through > 0.0 && ip < 0.8 * mv_min { dev[i].sug.inst = Some(ip); }
    };
    inst_of(&mut dev, "mv_pv", "pv_lv", "pv_end");
    inst_of(&mut dev, "mv_bess", "bess_lv", "bess_mv");
    if truthy(find_in(lib, "transformer", e.at("trafo_load").str())) { inst_of(&mut dev, "load", "load_lv", "load_end"); }

    // time multipliers: from the downstream devices up, the smallest step that keeps the grading margin
    let mut short: Vec<&str> = vec![];
    let mut changed = true;
    let mut pass = 0;
    while changed && pass < 20 {
        changed = false;
        for (dk, uk, b, _) in PAIRS {
            let (Some(di), Some(ui)) = (at(&dev, dk), at(&dev, uk)) else { continue };
            let td = trip_time(&dev[di].eff(), cur(dk, b, 0));
            let iu = cur(uk, up_at(b), 0);
            let su = dev[ui].eff();
            if !td.is_finite() || !above(iu, su.pickup) { continue; }
            let need = tms_for(&su, iu, td + margin);
            if need > TMS_MAX && !short.contains(&uk) { short.push(uk); }
            let t = jmin(TMS_MAX, jmax(TMS_MIN, ceil_step(need, TMS_STEP)));
            if t > dev[ui].sug.tms + 1e-9 { dev[ui].sug.tms = format!("{t:.3}").parse().unwrap(); changed = true; }
        }
        pass += 1;
    }
    let brk_lib = lib.at("breaker");
    for d in dev.iter_mut() {
        d.set = d.eff();
        // a trip unit is set at most to its breaker's rating: the breaker carries the pickup as well as the load
        let chosen = find_in(lib, "breaker", e.at("breaker").at(d.x.key).str());
        d.auto = !truthy(chosen);
        d.brk = if truthy(chosen) { Some(chosen) } else { pick_breaker(brk_lib, d.kv, jmax(d.in_, d.set.pickup), &d.duty) };
    }
    let name = |dev: &[Dev], k: &str| dev[at(dev, k).unwrap()].x.name.to_lowercase();

    // grading
    let mut grading: Vec<Value> = vec![];
    for (dk, uk, b, label) in PAIRS {
        let (Some(di), Some(ui)) = (at(&dev, dk), at(&dev, uk)) else { continue };
        if bus(up_at(b)).is_none() { continue; }
        let (id, iu) = (cur(dk, b, 0), cur(uk, up_at(b), 0));
        let (td, tu) = (trip_time(&dev[di].set, id), trip_time(&dev[ui].set, iu));
        let ok = td.is_finite() && (!tu.is_finite() || tu - td >= margin - 1e-6);
        grading.push(obj(vec![("down", dk.into()), ("up", uk.into()), ("bus", b.into()), ("label", label.into()), ("Id", num(id)), ("Iu", num(iu)),
            ("td", num(td)), ("tu", num(tu)), ("margin", if tu.is_finite() && td.is_finite() { num(tu - td) } else { Value::Null }), ("ok", ok.into())]));
        let (nd, nu) = (name(&dev, dk), name(&dev, uk));
        if !td.is_finite() && !tu.is_finite() {
            warn.push(format!("{label}: neither the {nd} nor the {nu} sees the fault; no overcurrent device clears it."));
        } else if !td.is_finite() {
            warn.push(format!("{label}: the {nd} does not see {} A, so the {nu} trips first.", fmt_num(id, 0)));
        } else if !ok {
            warn.push(format!("{label}: grading margin {} s between the {nd} and the {nu} is below {} s.", fmt_num(tu - td, 2), js_num(margin)));
        }
    }
    for k in &short {
        if let Some(i) = at(&dev, k) {
            warn.push(format!("{}: the time multiplier needed for grading exceeds {}. Use a lower pickup, another curve or a definite-time stage.", dev[i].x.name, js_num(TMS_MAX)));
        }
    }

    // device checks: setting against load and cable, sensitivity, breaker duty
    for d in dev.iter_mut() {
        let s = d.set.clone();
        let nm = d.x.name;
        d.min_fault = cur(d.x.key, d.x.zone, 1) * SQ3 / 2.0; // two-phase fault at the end of the zone, fewest sources
        d.max_fault = faults.iter().fold(0.0, |m, b| jmax(m, cur(d.x.key, b, 0))); // the largest current it carries for any fault
        if s.pickup < 1.05 * d.in_ {
            warn.push(format!("{nm}: pickup {} A is below 1.05 \u{d7} the full-load current {} A; it would trip on load.", fmt_num(s.pickup, 0), fmt_num(d.in_, 0)));
        }
        if let Some(b) = d.brk {
            if s.pickup > jn(b, "ir") {
                warn.push(format!("{nm}: pickup {} A is above the rated current {} A of {}.", fmt_num(s.pickup, 0), fmt_v(b, "ir", 0), js_str(b, "name")));
            }
        }
        if let Some(iz) = d.iz {
            if s.pickup > iz {
                warn.push(format!("{nm}: pickup {} A is above the cable rating {} A, so the cable has no overload protection.", fmt_num(s.pickup, 0), fmt_num(iz, 0)));
            }
        }
        if d.min_fault > 0.0 && d.min_fault < 1.5 * s.pickup {
            let online = if f.online != 0.0 && !f.online.is_nan() { f.online } else { 0.0 };
            let advice = if d.x.key.contains("gen") { "Use voltage-restrained overcurrent (51V) for the gensets." } else { "Lower the pickup or add undervoltage protection." };
            warn.push(format!("{nm}: the smallest fault at the end of its zone ({} A, two-phase, {} genset(s) online) is below 1.5 \u{d7} pickup. {advice}", fmt_num(d.min_fault, 0), js_num(online)));
        }
        let du = d.duty;
        let mv = d.kv > 1.0;
        d.chk = vec![];
        let Some(b) = d.brk else {
            warn.push(format!("{nm}: no circuit breaker in the library for {} V.", fmt_num(d.kv * 1000.0, 0)));
            continue;
        };
        let clear = |i: f64| { let tr = trip_time(&s, i); (if tr.is_finite() { tr } else { t_max }) + T_BREAKER };
        d.t_clear = Some(clear(d.max_fault));
        // the heaviest I²t the breaker carries: every fault, its current through the device for the time the device takes to clear it
        let mut i2t = 0.0;
        for fb in &faults {
            let i = cur(d.x.key, fb, 0);
            let t = clear(i);
            let ith = i / 1000.0 * (m_factor(du.kappa, t) + 1.0).sqrt();
            if i > 0.0 && ith * ith * t > i2t { i2t = ith * ith * t; d.ith = Some(ith); d.t_i2t = Some(t); }
        }
        let bname = js_str(b, "name");
        let mut fail = |d: &mut Dev, what: String| { warn.push(format!("{nm}: {bname} {what}.")); d.chk.push(what); };
        if jn(b, "ir") < d.in_ { let w = format!("is rated {} A, below the full-load current {} A", fmt_v(b, "ir", 0), fmt_num(d.in_, 0)); fail(d, w); }
        if jn(b, "ur_kv") < d.kv { fail(d, format!("is rated {} kV, below the system voltage", js_str(b, "ur_kv"))); }
        let need = if mv { du.ib } else { du.ik3 };
        if jn(b, "icu_ka") < need {
            fail(d, format!("breaks {} kA, below the {} {} kA", js_str(b, "icu_ka"), if mv { "breaking current Ib" } else { "prospective current Ik\u{2033}" }, fmt_num(need, 1)));
        }
        if jn(b, "icm_ka") > 0.0 && jn(b, "icm_ka") < du.ip {
            fail(d, format!("makes {} kA peak, below the peak current ip {} kA", js_str(b, "icm_ka"), fmt_num(du.ip, 1)));
        }
        let (icw, tk) = (jn(b, "icw_ka"), jn(b, "tk"));
        if icw > 0.0 && tk > 0.0 && icw * icw * tk < i2t {
            let (ith, t) = (d.ith.unwrap_or(f64::NAN), d.t_i2t.unwrap_or(f64::NAN));
            let w = format!("withstands {} kA for {} s, less than {} kA for {} s", js_str(b, "icw_ka"), js_str(b, "tk"), fmt_num(ith, 1), fmt_num(t, 2));
            fail(d, w);
        }
    }

    // cable short-time withstand (adiabatic, XLPE): the fault level at either end for the clearing time of its device
    let mut cables: Vec<Value> = vec![];
    for (key, [a, z, dk]) in CABLES {
        let c = circuit(d, key);
        if !truthy(c) || !truthy(c.at("cab")) { continue; }
        let (Some(ba), Some(bz)) = (bus(a), bus(z)) else { continue };
        let ends: Vec<_> = [ba.max.as_ref(), bz.max.as_ref()].into_iter().flatten().collect();
        let Some(&first) = ends.first() else { continue };
        let worst = ends[1..].iter().fold(first, |m, &x| if x.ik3 > m.ik3 { x } else { m });
        let tr = at(&dev, dk).map_or(f64::INFINITY, |i| trip_time(&dev[i].set, cur(dk, z, 0)));
        let t = (if tr.is_finite() { tr } else { t_max }) + T_BREAKER;
        let ith = worst.ik3 * (m_factor(worst.kappa, t) + 1.0).sqrt();
        let cab = c.at("cab");
        let k = if is_al(cab.at("material").str()) { K_AL } else { K_CU };
        let (csa, runs) = (jn(cab, "csa"), jn(c, "runs"));
        let adm = k * csa * runs / t.sqrt() / 1000.0; // kA
        let s_min = ith * 1000.0 * t.sqrt() / k / runs;
        let ok = ith <= adm;
        cables.push(obj(vec![("key", key.into()), ("name", c.at("name").clone()), ("cab", cab.clone()), ("runs", c.at("runs").clone()), ("ik", num(worst.ik3)),
            ("ith", num(ith)), ("t", num(t)), ("adm", num(adm)), ("sMin", num(s_min)), ("ok", ok.into()), ("cleared", tr.is_finite().into())]));
        if !ok {
            let n = if runs > 1.0 { format!("{} \u{d7} ", js_str(c, "runs")) } else { String::new() };
            warn.push(format!("{}: {} kA for {} s exceeds the short-time withstand of {n}{} mm\u{b2} ({} kA); at least {} mm\u{b2} per run is needed.",
                js_str(c, "name"), fmt_num(ith, 1), fmt_num(t, 2), js_str(cab, "csa"), fmt_num(adm, 1), fmt_num(s_min, 0)));
        }
    }
    let mut devs = Value::object();
    for x in &dev { devs.set(x.x.key, x.to_json()); }
    let fj = f.to_json();
    obj(vec![("notes", fj.at("notes").clone()), ("F", fj), ("dev", devs), ("grading", Value::Arr(grading)), ("cables", Value::Arr(cables)),
        ("warn", Value::Arr(warn.into_iter().map(Value::Str).collect())), ("margin", num(margin)), ("tMax", num(t_max))])
}

// Curves and breaker choice against IEC 60255-151 and the built-in datasheets (once ui/tests/fault.test.js)
#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64, rel: f64, msg: &str) { assert!((a - b).abs() <= rel * b.abs(), "{msg} {a} != {b}"); }
    fn d(curve: &'static str) -> Settings { Settings { curve, pickup: 100.0, tms: 1.0, inst: None } }

    #[test]
    fn inverse_time_curves_at_ten_times_pickup() {
        near(trip_time(&d("SI"), 1000.0), 0.14 / (10f64.powf(0.02) - 1.0), 1e-12, "SI");
        near(trip_time(&d("SI"), 1000.0), 2.97, 0.005, "SI");
        near(trip_time(&d("VI"), 1000.0), 1.5, 1e-12, "VI");
        near(trip_time(&d("EI"), 1000.0), 80.0 / 99.0, 1e-12, "EI");
        near(trip_time(&d("LTI"), 1000.0), 120.0 / 9.0, 1e-12, "LTI");
        assert_eq!(trip_time(&d("SI"), 90.0), f64::INFINITY);
        assert_eq!(trip_time(&Settings { inst: Some(800.0), ..d("SI") }, 900.0), 0.05);
        near(trip_time(&d("SI"), 5000.0), trip_time(&d("SI"), 2000.0), 1e-12, "flat beyond 20 × pickup");
        near(tms_for(&d("SI"), 1000.0, 0.594), 0.2, 0.002, "TMS");
        assert_eq!(round_pickup(22.4), 23.0);
        assert_eq!(round_pickup(1127.0), 1150.0);
    }

    #[test]
    fn breakers_are_picked_by_voltage_current_and_duty() {
        let lib = Value::parse(r#"[
            { "id": "vcb630", "ur_kv": 24, "ir": 630, "icu_ka": 16, "icm_ka": 40 }, { "id": "vcb1250", "ur_kv": 24, "ir": 1250, "icu_ka": 25, "icm_ka": 63 },
            { "id": "vcb2500", "ur_kv": 24, "ir": 2500, "icu_ka": 31.5, "icm_ka": 80 }, { "id": "mccb630", "ur_kv": 0.69, "ir": 630, "icu_ka": 36, "icm_ka": 76 },
            { "id": "acb1600", "ur_kv": 1, "ir": 1600, "icu_ka": 50, "icm_ka": 105 }, { "id": "acb2500", "ur_kv": 1, "ir": 2500, "icu_ka": 66, "icm_ka": 145 },
            { "id": "acb4000", "ur_kv": 1, "ir": 4000, "icu_ka": 85, "icm_ka": 187 }, { "id": "acb6300", "ur_kv": 1, "ir": 6300, "icu_ka": 100, "icm_ka": 220 }]"#).unwrap();
        let id = |kv: f64, i: f64, ik3: f64, ip: f64, ib: f64| pick_breaker(&lib, kv, i, &Duty { ik3, ip, ib, kappa: 1.0 }).unwrap().at("id").str().to_string();
        assert_eq!(id(0.8, 2273.0, 10.0, 20.0, 10.0), "acb2500");
        assert_eq!(id(0.4, 902.0, 70.0, 150.0, 60.0), "acb4000", "the 1600 A breaker breaks only 50 kA");
        assert_eq!(id(20.0, 40.0, 20.0, 50.0, 18.0), "vcb1250");
        // nothing carries the current: the largest for the voltage
        assert_eq!(id(20.0, 5000.0, 1.0, 1.0, 1.0), "vcb2500");
        assert!(pick_breaker(&lib, 150.0, 10.0, &Duty { ik3: 0.0, ip: 0.0, ib: 0.0, kappa: 1.0 }).is_none());
    }
}
