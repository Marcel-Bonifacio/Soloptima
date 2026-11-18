//! The electrical design of the plant: PV string sizing, transformer selection, cable sizing (current rating, voltage drop,
//! I²R loss) and the annual losses integrated over the hourly profiles; the cable auto-sizing; and the feedback of the losses
//! into the model inputs. It keeps the semantics of the interface's earlier JavaScript (`||` defaults, Number
//! coercion, undefined members, NaN in Math.min and Math.max) and its operation order, so results match it to the last bits.
//! The design feeds the screen, the single-line diagram, the load flow, the protection study and the report.
//! Added after the port: the kVA check of inverters and PCS at the power factor asked at the point of connection, and the
//! weak-grid screening (short-circuit ratio, transformer energising dip), and the islanded N-1 and unbalanced-fault screens
//! of screens.rs.
use super::util::{cable_class, find_in, fmt_num, fmt_pct, jmax, jmin, jround, js_num, max_of, obj, r_hot, selected_in, sum, to_fixed, truthy, SQ3};
use super::{screens, Req};
use crate::json::Value;
use std::cmp::Ordering;

const HOURS: usize = 8760;

// --- JavaScript semantics on JSON values ---

/// A member as JavaScript reads it: None when undefined
fn field<'a>(o: &'a Value, k: &str) -> Option<&'a Value> { o.obj().and_then(|m| m.get(k)) }

/// Number(v): null is 0, a string is parsed whole (blank is 0, anything else unreadable is NaN)
fn to_num(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Num(x) => *x,
        Value::Str(s) => {
            let s = s.trim();
            match s {
                "" => 0.0,
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ if s.starts_with("0x") || s.starts_with("0X") => u64::from_str_radix(&s[2..], 16).map_or(f64::NAN, |x| x as f64),
                _ if s.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) => s.parse().unwrap_or(f64::NAN),
                _ => f64::NAN,
            }
        }
        Value::Arr(_) | Value::Obj(_) => f64::NAN,
    }
}
/// A member in arithmetic: undefined is NaN, null is 0
fn n(o: &Value, k: &str) -> f64 { field(o, k).map_or(f64::NAN, to_num) }
/// Whether a member is truthy
fn t(o: &Value, k: &str) -> bool { field(o, k).is_some_and(truthy) }
/// Whether a number is truthy
fn tn(x: f64) -> bool { x != 0.0 && !x.is_nan() }
/// `o.k || def` for a number
fn or(o: &Value, k: &str, def: f64) -> f64 { if t(o, k) { n(o, k) } else { def } }
/// A member copied into a result as it is (undefined becomes null)
fn raw(o: &Value, k: &str) -> Value { o.at(k).clone() }
/// A series as values, each read with Number()
fn vals(v: &Value) -> Vec<f64> { v.arr().iter().map(to_num).collect() }
/// a[t], NaN past the end (undefined in arithmetic)
fn ix(a: &[f64], t: usize) -> f64 { a.get(t).copied().unwrap_or(f64::NAN) }

fn sq(x: f64) -> f64 { x * x }

/// A value as a template literal writes it
fn text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Num(x)) => js_num(*x),
        Some(Value::Str(s)) => s.clone(),
        Some(Value::Arr(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { text(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Obj(_)) => "[object Object]".into(),
    }
}
/// fmtNum of a member: a dash for null or undefined
fn fmt_val(o: &Value, k: &str, d: usize) -> String {
    match field(o, k) { None | Some(Value::Null) => "\u{2013}".into(), Some(v) => fmt_num(to_num(v), d) }
}
/// +x.toFixed(d)
fn fixed(x: f64, d: usize) -> f64 { if !x.is_finite() || x.abs() >= 1e21 { x } else { to_fixed(x, d).parse().unwrap_or(f64::NAN) } }

/// A member of an object to write into, created when missing (the JavaScript would throw on a missing parent)
fn member<'a>(v: &'a mut Value, k: &str) -> &'a mut Value {
    if !v.is_object() { *v = Value::object(); }
    match v { Value::Obj(o) => o.entry(k.to_string()).or_insert(Value::Null), _ => unreachable!() }
}

// --- the design ---

/// Voltage drop of a circuit (per unit of its voltage) over length l on a cable with `runs` in parallel
fn vdrop(c: &Value, l: f64, cab: &Value, runs: f64) -> f64 {
    let (r, x, pf) = (r_hot(cab), or(cab, "x", 0.0) / 1000.0, or(c, "pf", 1.0));
    let (i, v) = (n(c, "I"), n(c, "V"));
    let dv = if c.at("kind").str() == "dc" { 2.0 * i * r * l / runs / v } else { SQ3 * i * (r * pf + x * (1.0 - pf * pf).sqrt()) * l / runs / v };
    dv * or(c, "dvF", 1.0)
}
/// The member holding the voltage-drop limit (%) of a cable class
fn dv_key(cls: &str) -> &'static str { match cls { "dc" => "dv_dc", "lv" => "dv_lv", _ => "dv_mv" } }

/// Hourly per-unit profiles of PV, battery, gensets and load; None where the results do not have them
struct Profiles {
    pv: Option<Vec<f64>>,
    bess: Option<Vec<f64>>,
    gen_u: Option<Vec<f64>>,
    gen_lf: Option<Vec<f64>>,
    load: Option<Vec<f64>>,
}
fn profiles(p: &Value, pvr: &Value, sim: &Value) -> Profiles {
    let res = sim.at("result");
    let h = (truthy(sim) && truthy(res) && t(res, "hourly")).then(|| res.at("hourly"));
    let (ppv, bess, diesel) = (p.at("pv"), p.at("bess"), p.at("diesel"));
    let pv = if truthy(pvr) {
        let r = n(ppv, "dc_ac_ratio");
        Some(vals(pvr.at("ac_per_kwp")).iter().map(|x| x * r).collect())
    } else {
        h.map(|h| { let k = jmax(1.0, n(ppv, "capacity_kwp") / n(ppv, "dc_ac_ratio")); vals(h.at("pv_avail")).iter().map(|x| x / k).collect() })
    };
    let pb = jmax(1.0, n(bess, "power_kw"));
    let bess = h.map(|h| {
        let (pvb, gb, wind) = (vals(h.at("pv_to_bess")), vals(h.at("gen_to_bess")), t(h, "wind_to_bess").then(|| vals(h.at("wind_to_bess"))));
        vals(h.at("bess_dis")).iter().enumerate().map(|(t, d)| (d + ix(&pvb, t) + wind.as_ref().map_or(0.0, |w| ix(w, t)) + ix(&gb, t)) / pb).collect()
    });
    let gen_u = h.map(|h| vals(h.at("gen_units")));
    let gen_lf = h.map(|h| {
        let (gl, gb, gd, unit) = (vals(h.at("gen_to_load")), vals(h.at("gen_to_bess")), vals(h.at("gen_dump")), n(diesel, "unit_kw"));
        vals(h.at("gen_units")).iter().enumerate().map(|(t, &u)| if tn(u) { (ix(&gl, t) + ix(&gb, t) + ix(&gd, t)) / (u * unit) } else { 0.0 }).collect()
    });
    let load = t(p.at("load"), "kw").then(|| {
        let kw = vals(p.at("load").at("kw"));
        let pk = max_of(&kw);
        kw.iter().map(|x| x / pk).collect()
    });
    Profiles { pv, bess, gen_u, gen_lf, load }
}
fn sum_sq(a: &[f64]) -> f64 { a.iter().fold(0.0, |s, x| s + x * x) }

/// Adds a transformer group: `s_load_pu` is Σ (S/Sn)² over the year (a falsy one gives no load loss)
#[allow(clippy::too_many_arguments)]
fn add_trafo(trafos: &mut Vec<Value>, warn: &mut Vec<String>, role: &str, t: &Value, nn: f64, s_load_pu: Option<f64>, energized_hours: f64, peak_kva: f64) {
    if !truthy(t) || nn <= 0.0 { return; }
    let load_loss = s_load_pu.filter(|&s| tn(s)).map(|s| n(t, "pk") * s);
    let no_load = n(t, "p0") * energized_hours;
    let loading = peak_kva / (nn * n(t, "kva"));
    if loading > 1.0 { warn.push(format!("{role}: {} × {} kVA transformer(s) loaded to {} at peak.", js_num(nn), fmt_val(t, "kva", 0), fmt_pct(loading, 0))); }
    trafos.push(obj(vec![("role", role.into()), ("t", t.clone()), ("n", nn.into()), ("loading", loading.into()),
        ("annual_kwh", load_loss.map(|l| no_load + l).into()), ("noLoad", no_load.into()), ("loadLoss", load_loss.into())]));
}

/// The apparent power of a PV inverter or PCS datasheet (kVA); blank or 0 is its kW rating
pub(crate) fn kva_of(x: &Value, kw: f64) -> f64 { if n(x, "kva") > 0.0 { n(x, "kva") } else { kw } }

/// Whether `units` converters of `kva` each deliver rated active power `p` (kW) at power factor `pf`: S ≥ √(P² + Q²) with
/// Q = P tan φ, so S ≥ P / pf. Losses between the units and the point of connection are left out (the load flow has them).
fn capability(what: &str, p: f64, units: f64, kva: f64, pf: f64, warn: &mut Vec<String>) -> Value {
    let (s, s_req) = (units * kva, p / pf);
    let n_req = (s_req / kva).ceil();
    let q = (s * s - p * p).max(0.0).sqrt();
    if s < s_req * (1.0 - 1e-9) {
        warn.push(format!("{what}: {} \u{d7} {} kVA give {} kVA, short of the {} kVA needed for {} kW at power factor {} at the point of connection. Use {} units or a higher kVA rating.",
            js_num(units), fmt_num(kva, 0), fmt_num(s, 0), fmt_num(s_req, 0), fmt_num(p, 0), js_num(pf), js_num(n_req)));
    }
    obj(vec![("p", p.into()), ("units", units.into()), ("kva", kva.into()), ("s", s.into()), ("sReq", s_req.into()), ("nReq", n_req.into()),
        ("q", q.into()), ("qRatio", (q / p).into()), ("margin", (s / s_req - 1.0).into())])
}

/// First peak of the inrush current on energising a transformer, as a multiple of the rated peak current, when the datasheet
/// gives none
pub const TYPICAL_INRUSH: f64 = 8.0;

/// Weak-grid screening at the MV bus: the short-circuit ratio S_sc ÷ the rated power of the inverters and PCS (`p_ibr`, kW),
/// and the voltage dip on energising the largest transformer. The dip is a screening estimate: the inrush pulses are taken as
/// half sines, whose fundamental is half the first peak k, drawn through the network's impedance, so with m = k/2
/// ΔU = m·Sn ÷ (S_sc + m·Sn). It ignores the decay over the following cycles, so it errs high.
fn weak_grid(e: &Value, p_ibr: f64, trafos: &[Value], warn: &mut Vec<String>) -> Value {
    let ssc = n(e, "grid_mva");
    let scr = (p_ibr > 0.0).then(|| ssc * 1000.0 / p_ibr);
    let scr_min = n(e, "scr_min");
    if let Some(r) = scr.filter(|&r| scr_min > 0.0 && r < scr_min) {
        warn.push(format!("Short-circuit ratio {} at the point of connection ({} MVA against {} MW of inverters and PCS) is below {}: a weak grid. Ask the network operator for a stability study.",
            fmt_num(r, 1), fmt_num(ssc, 0), fmt_num(p_ibr / 1000.0, 1), js_num(scr_min)));
    }
    let mut out = obj(vec![("ssc", ssc.into()), ("pIbr", p_ibr.into()), ("scr", scr.into()), ("scrMin", raw(e, "scr_min")), ("dipMax", raw(e, "dip_max"))]);
    let big = trafos.iter().fold(None, |b: Option<&Value>, x| if b.is_some_and(|b| n(b.at("t"), "kva") >= n(x.at("t"), "kva")) { b } else { Some(x) });
    if let Some(x) = big {
        let tr = x.at("t");
        let (sn, given) = (n(tr, "kva"), n(tr, "inrush") > 0.0);
        let (k, typical) = if given { (n(tr, "inrush"), false) } else { (TYPICAL_INRUSH, true) };
        let m = k / 2.0;
        let dip = m * sn / (ssc * 1000.0 + m * sn);
        let dip_max = n(e, "dip_max");
        if dip_max > 0.0 && dip * 100.0 > dip_max {
            warn.push(format!("Energising the {} ({} kVA, inrush {} \u{d7} rated{}) dips the MV bus by about {} %, over the {} % limit. Ask the network operator, or energise it with pre-insertion resistors or controlled switching.",
                text(field(tr, "name")), fmt_num(sn, 0), js_num(k), if typical { ", typical value" } else { "" }, to_fixed(dip * 100.0, 1), js_num(dip_max)));
        }
        for (key, v) in [("trafo", raw(tr, "name")), ("role", raw(x, "role")), ("kva", sn.into()), ("inrush", k.into()), ("inrushTyp", typical.into()), ("dip", dip.into())] { out.set(key, v); }
    }
    out
}

/// The design of the project: strings, transformers, cable circuits, losses and warnings
pub fn compute_design(r: &Req) -> Value {
    let (p, pvr, sim, pl) = (r.project, r.pvr, r.sim, r.lengths);
    let e = p.at("electrical");
    let (pv, inv, bat, dg) = (selected_in(p, "pv"), selected_in(p, "inverter"), selected_in(p, "battery"), selected_in(p, "genset"));
    let lib = p.at("equipment").at("lib");
    let tr = |k: &str| find_in(lib, "transformer", e.at(k).str());
    let mut warn: Vec<String> = vec![];
    let mut out = Value::object();
    let weather = p.at("weather");
    let tmin_v = if !e.at("t_min").is_null() {
        e.at("t_min").clone()
    } else if truthy(weather) && t(weather, "tamb") {
        Value::Num(vals(weather.at("tamb")).iter().fold(f64::INFINITY, |m, &x| jmin(m, x)).floor() - 2.0)
    } else {
        Value::Num(10.0)
    };
    let tmin = to_num(&tmin_v);
    out.set("tmin", tmin_v.clone());

    // --- PV strings ---
    let ppv = p.at("pv");
    let mut st: Option<Value> = None;
    if truthy(pv) && truthy(inv) {
        let voc = |tc: f64| n(pv, "voc") * (1.0 + n(pv, "beta_voc") / 100.0 * (tc - 25.0));
        // Vmp falls faster than Voc. Without a datasheet value, γPmax minus αIsc is slightly steeper than the true coefficient,
        // so it is conservative at both ends of the MPPT window; a blank αIsc takes 0.05 %/°C, the high end of real values.
        let given = |k: &str| matches!(field(pv, k), Some(Value::Num(x)) if x.is_finite());
        let (b_vmp_given, g_given, a_given) = (given("beta_vmp"), given("gamma_p"), given("alpha_isc"));
        let (b_vmp, b_vmp_v) = if b_vmp_given {
            (n(pv, "beta_vmp"), raw(pv, "beta_vmp"))
        } else if g_given {
            let b = n(pv, "gamma_p") - if a_given { n(pv, "alpha_isc") } else { 0.05 };
            (b, Value::Num(b))
        } else {
            (n(pv, "beta_voc"), raw(pv, "beta_voc"))
        };
        if !b_vmp_given && !g_given {
            warn.push("Temp. coeff. Vmp and Temp. coeff. Pmax are blank in the module datasheet: Vmp uses Temp. coeff. Voc, which is flatter than the true coefficient and not conservative.".into());
        } else if !b_vmp_given && !a_given {
            warn.push("Temp. coeff. Isc is blank in the module datasheet: the Vmp coefficient is estimated as Temp. coeff. Pmax \u{2212} 0.05 %/°C.".into());
        }
        let vmp = |tc: f64| n(pv, "vmp") * (1.0 + b_vmp / 100.0 * (tc - 25.0));
        let t_hot_v = if !e.at("t_cell_max").is_null() { e.at("t_cell_max").clone() } else { Value::Num(70.0) };
        let t_hot = to_num(&t_hot_v);
        // hourly cell temperature of the yield model at useful irradiance, 99.9th percentile
        let mut t_model: Option<f64> = None;
        if truthy(pvr) && t(pvr, "tcell") && t(pvr, "poa") {
            let poa = pvr.at("poa").arr();
            let mut tc: Vec<f64> = pvr.at("tcell").arr().iter().enumerate()
                .filter(|(i, _)| poa.get(*i).is_some_and(|x| to_num(x) > 200.0)).map(|(_, x)| to_num(x)).collect();
            tc.sort_by(|a, b| (a - b).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
            if !tc.is_empty() {
                let k = (tc.len() - 1) as f64 * 0.999;
                let (lo, hi) = (k.floor(), k.ceil());
                t_model = Some(tc[lo as usize] + (tc[hi as usize] - tc[lo as usize]) * (k - lo));
            }
        }
        if let Some(tm) = t_model {
            if t_hot < tm + 5.0 {
                warn.push(format!("Max cell temperature {} °C is less than 5 °C above the thermal model's 99.9th percentile ({} °C). Hourly means miss short peaks: use at least {} °C.",
                    text(Some(&t_hot_v)), fmt_num(tm, 1), js_num((tm + 5.0).ceil())));
            }
        }
        let vmax = jmin(n(inv, "vdc_max"), or(pv, "vsys", n(inv, "vdc_max")));
        let n_max = (vmax / voc(tmin)).floor();
        let n_min = (n(inv, "vmppt_min") / vmp(t_hot)).ceil();
        let n_mppt = (n(inv, "vmppt_max") / vmp(tmin)).floor();
        let ns_v = if n(e, "modules_per_string") > 0.0 { raw(e, "modules_per_string") } else { Value::Num(jmin(n_max, n_mppt)) };
        let ns = to_num(&ns_v);
        if ns > n_max {
            warn.push(format!("String of {} modules exceeds the maximum {} (Voc at {} °C = {} V > {} V).",
                text(Some(&ns_v)), js_num(n_max), text(Some(&tmin_v)), fmt_num(ns * voc(tmin), 0), js_num(vmax)));
        }
        if ns < n_min {
            warn.push(format!("String of {} modules is below the MPPT minimum ({}) at {} °C cell temperature.", text(Some(&ns_v)), js_num(n_min), text(Some(&t_hot_v))));
        }
        let n_mod_target = n(ppv, "capacity_kwp") * 1000.0 / n(pv, "pmax");
        let n_strings = jmax(1.0, jround(n_mod_target / ns));
        let kwp = n_strings * ns * n(pv, "pmax") / 1000.0;
        let pac = n(inv, "pac_kw");
        let n_inv = jmax(1.0, (kwp / n(ppv, "dc_ac_ratio") / pac).ceil());
        let spi = n_strings / n_inv;
        let spm = (spi / jmax(1.0, n(inv, "n_mppt"))).ceil();
        let i_mppt = spm * n(pv, "isc") * 1.25;
        if i_mppt > n(inv, "imax_mppt") {
            warn.push(format!("{} strings per MPPT draw up to {} A (1.25 × Isc) > inverter limit {} A. Add inverters or use string combiners.",
                js_num(spm), fmt_num(i_mppt, 0), text(field(inv, "imax_mppt"))));
        }
        if kwp / n_inv > n(inv, "pdc_max_kw") {
            warn.push(format!("DC power per inverter {} kW exceeds the datasheet maximum {} kW.", fmt_num(kwp / n_inv, 0), text(field(inv, "pdc_max_kw"))));
        }
        let src = if b_vmp_given { "datasheet" } else if !g_given { "Temp. coeff. Voc (Temp. coeff. Pmax blank)" }
            else if a_given { "estimated: γPmax \u{2212} αIsc" } else { "estimated: γPmax \u{2212} 0.05 (Temp. coeff. Isc blank)" };
        st = Some(obj(vec![
            ("ns", ns_v), ("nMin", n_min.into()), ("nMax", n_max.into()), ("nMppt", n_mppt.into()), ("nStrings", n_strings.into()),
            ("nModules", (n_strings * ns).into()), ("kwp", kwp.into()), ("nInv", n_inv.into()), ("spi", spi.into()), ("spm", spm.into()),
            ("iMppt", i_mppt.into()), ("vocMax", (ns * voc(tmin)).into()), ("vmpHot", (ns * vmp(t_hot)).into()), ("vmpCold", (ns * vmp(tmin)).into()),
            ("dcac", (kwp / (n_inv * pac)).into()), ("pv", pv.clone()), ("inv", inv.clone()), ("tHot", t_hot_v), ("tModel", t_model.into()),
            ("bVmp", b_vmp_v), ("bVmpSrc", src.into()),
        ]));
    } else {
        warn.push("Select a PV module and an inverter in Equipment datasheets (tab 8).".into());
    }

    // --- transformers ---
    let prof = profiles(p, pvr, sim);
    let (tr_pv, tr_b, tr_g, tr_l) = (tr("trafo_pv"), tr("trafo_bess"), tr("trafo_gen"), tr("trafo_load"));
    let hours = HOURS as f64;
    let mut trafos: Vec<Value> = vec![];
    let (mut n_tr_pv, mut inv_per_tr) = (0.0, 1.0);
    if let Some(s) = st.as_ref().filter(|_| truthy(tr_pv)) {
        let (pac, n_inv, kva) = (n(s.at("inv"), "pac_kw"), n(s, "nInv"), n(tr_pv, "kva"));
        inv_per_tr = jmax(1.0, (kva / pac).floor());
        n_tr_pv = (n_inv / inv_per_tr).ceil();
        let sn = n_tr_pv * kva;
        let s2 = prof.pv.as_ref().map(|a| a.iter().fold(0.0, |acc, x| acc + sq(x * n_inv * pac / sn)) * n_tr_pv);
        add_trafo(&mut trafos, &mut warn, "PV step-up", tr_pv, n_tr_pv, s2, hours * n_tr_pv, n_inv * pac);
    }
    out.set("nTrPV", n_tr_pv);
    out.set("invPerTr", inv_per_tr);
    let pb = n(p.at("bess"), "power_kw");
    let has_b = n(p.at("bess"), "energy_kwh") > 0.0 && pb > 0.0;
    let (mut n_b, mut n_tr_b) = (0.0, 0.0);
    if has_b {
        n_b = if truthy(bat) && t(bat, "power_kw") { jmax(1.0, (pb / n(bat, "power_kw")).ceil()) } else { 1.0 };
        if truthy(tr_b) {
            let kva = n(tr_b, "kva");
            n_tr_b = (pb / kva).ceil();
            let s2 = prof.bess.as_ref().map(|a| a.iter().fold(0.0, |acc, x| acc + sq(x * pb / (n_tr_b * kva))) * n_tr_b);
            add_trafo(&mut trafos, &mut warn, "BESS step-up", tr_b, n_tr_b, s2, hours * n_tr_b, pb);
        }
    }
    out.set("nB", n_b);
    out.set("nTrB", n_tr_b);
    let diesel = p.at("diesel");
    let (n_g, unit_kw) = (n(diesel, "units"), n(diesel, "unit_kw"));
    let (g_kva, g_kva_v) = if truthy(dg) { (n(dg, "kva"), raw(dg, "kva")) } else { (unit_kw / 0.8, Value::Num(unit_kw / 0.8)) };
    let gpt = jmax(1.0, n(e, "gens_per_trafo"));
    let gen_mv = t(e, "gen_mv");
    let mut n_tr_g = 0.0;
    if !gen_mv && truthy(tr_g) && n_g > 0.0 {
        let kva = n(tr_g, "kva");
        n_tr_g = (n_g / gpt).ceil();
        let (mut s2, mut hrs) = (None, hours * n_tr_g);
        if let (Some(gu), Some(lf)) = (&prof.gen_u, &prof.gen_lf) {
            let (mut s, mut h) = (0.0, 0.0);
            for t in 0..HOURS {
                let u = ix(gu, t);
                if !tn(u) { continue; }
                let on = (u / gpt).ceil();
                h += on;
                s += on * sq((u / on) * ix(lf, t) * unit_kw / 0.8 / kva);
            }
            (s2, hrs) = (Some(s), h);
        }
        add_trafo(&mut trafos, &mut warn, "Genset step-up", tr_g, n_tr_g, s2, hrs, gpt * g_kva * n_tr_g);
    }
    out.set("nTrG", n_tr_g);
    out.set("nG", raw(diesel, "units"));
    out.set("gKva", g_kva_v.clone());
    out.set("gpt", gpt);
    let peak = if t(p.at("load"), "kw") { max_of(&vals(p.at("load").at("kw"))) } else { 0.0 };
    let pf_load = n(e, "pf_load");
    if truthy(tr_l) {
        let kva = n(tr_l, "kva");
        let n_l = (peak / pf_load / kva).ceil();
        let s2 = prof.load.as_ref().map(|a| a.iter().fold(0.0, |acc, x| acc + sq(x * peak / pf_load / (n_l * kva))) * n_l);
        add_trafo(&mut trafos, &mut warn, "Load step-down", tr_l, n_l, s2, hours * n_l, peak / pf_load);
    }

    // --- cables ---
    let v_mv = n(e, "mv_kv") * 1000.0;
    let n_feed = if tn(n_tr_pv) { (n_tr_pv / jmax(1.0, n(e, "pv_per_feeder"))).ceil() } else { 0.0 };
    let tr_per_feed = if tn(n_feed) { n_tr_pv / n_feed } else { 1.0 };
    // the average loss and drop of n transformers spread evenly along a feeder, against all at its end
    let dist = |k: f64| if k > 1.0 { ((k + 1.0) * (2.0 * k + 1.0) / (6.0 * k * k), (k + 1.0) / (2.0 * k)) } else { (1.0, 1.0) };
    let series = |a: &Option<Vec<f64>>| a.as_ref().map_or(Value::Null, |v| v.clone().into());
    let mut def: Vec<Value> = vec![];
    if let Some(s) = &st {
        let (spv, sinv) = (s.at("pv"), s.at("inv"));
        let (pac, vac) = (n(sinv, "pac_kw"), n(sinv, "vac"));
        let (dcac, eff) = (n(ppv, "dc_ac_ratio"), jmax(0.5, n(ppv, "inverter_eff")));
        def.push(obj(vec![("key", "dc".into()), ("name", "PV string cables (DC, per string, both poles)".into()), ("kind", "dc".into()),
            ("V", raw(s, "vmpHot")), ("I", (n(spv, "isc") * 1.25).into()), ("Iop", raw(spv, "imp")), ("count", raw(s, "nStrings")),
            ("pu", prof.pv.as_ref().map_or(Value::Null, |a| a.iter().map(|x| x / dcac / eff).collect::<Vec<f64>>().into())), ("cls", "dc".into())]));
        def.push(obj(vec![("key", "lv_pv".into()), ("name", "Inverter \u{2192} PV transformer (LV AC, per inverter)".into()), ("kind", "ac".into()),
            ("V", raw(sinv, "vac")), ("I", (pac * 1000.0 / (SQ3 * vac)).into()), ("count", raw(s, "nInv")), ("pu", series(&prof.pv)), ("cls", "lv".into())]));
        if tn(n_feed) {
            let (loss_f, dv_f) = dist(jround(tr_per_feed));
            def.push(obj(vec![("key", "mv_pv".into()), ("name", format!("PV MV collector feeder ({} transformers each)", fmt_num(tr_per_feed, 1)).into()),
                ("kind", "ac".into()), ("V", v_mv.into()), ("I", (tr_per_feed * inv_per_tr * pac * 1000.0 / (SQ3 * v_mv)).into()), ("count", n_feed.into()),
                ("pu", series(&prof.pv)), ("cls", "mv".into()), ("lossF", loss_f.into()), ("dvF", dv_f.into())]));
        }
    }
    if has_b {
        let (bv, bv_v) = if truthy(bat) { (n(bat, "vac"), raw(bat, "vac")) } else { (690.0, Value::Num(690.0)) };
        def.push(obj(vec![("key", "lv_bess".into()), ("name", "PCS \u{2192} BESS transformer (LV AC, per PCS)".into()), ("kind", "ac".into()),
            ("V", bv_v), ("I", ((pb / n_b) * 1000.0 / (SQ3 * bv)).into()), ("count", n_b.into()), ("pu", series(&prof.bess)), ("cls", "lv".into())]));
        def.push(obj(vec![("key", "mv_bess".into()), ("name", "BESS MV feeder".into()), ("kind", "ac".into()),
            ("V", v_mv.into()), ("I", (pb * 1000.0 / (SQ3 * v_mv)).into()), ("count", 1.0.into()), ("pu", series(&prof.bess)), ("cls", "mv".into())]));
    }
    if n_g > 0.0 {
        let (gv, gv_v) = if truthy(dg) { (n(dg, "voltage"), raw(dg, "voltage")) } else { (400.0, Value::Num(400.0)) };
        if !gen_mv {
            def.push(obj(vec![("key", "lv_gen".into()), ("name", "Genset \u{2192} transformer (LV, per genset)".into()), ("kind", "ac".into()),
                ("V", gv_v), ("I", (g_kva * 1000.0 / (SQ3 * gv)).into()), ("count", raw(diesel, "units")), ("gen", true.into()), ("cls", "lv".into())]));
        }
        def.push(obj(vec![("key", "mv_gen".into()),
            ("name", if gen_mv { "Genset MV feeder (per genset)" } else { "Genset transformer \u{2192} MV bus" }.into()), ("kind", "ac".into()),
            ("V", v_mv.into()), ("I", ((if gen_mv { g_kva } else { gpt * g_kva }) * 1000.0 / (SQ3 * v_mv)).into()),
            ("count", if gen_mv { raw(diesel, "units") } else { n_tr_g.into() }), ("gen", true.into()),
            ("genGroup", (if gen_mv { 1.0 } else { gpt }).into()), ("cls", "mv".into())]));
    }
    if peak > 0.0 {
        def.push(obj(vec![("key", "load".into()), ("name", "MV feeder to plant load".into()), ("kind", "ac".into()), ("V", v_mv.into()),
            ("I", (peak / pf_load * 1000.0 / (SQ3 * v_mv)).into()), ("count", 1.0.into()), ("pu", series(&prof.load)), ("cls", "mv".into()),
            ("pf", raw(e, "pf_load"))]));
    }

    // lengths measured on the layout map, for the circuits that can be (siteplan.js, computed by the interface)
    let mut circuits: Vec<Value> = vec![];
    for c in def {
        let key = c.at("key").str().to_string();
        let name = c.at("name").str().to_string();
        let cab = find_in(lib, "cable", e.at("cable").at(&key).str());
        let m = (truthy(pl) && t(pl, &key)).then(|| pl.at(&key));
        let (l, l_v) = match m {
            Some(m) => (n(m, "len"), raw(m, "len")),
            None if t(e.at("len"), &key) => (n(e.at("len"), &key), raw(e.at("len"), &key)),
            None => (0.0, Value::Num(0.0)),
        };
        let runs = jmax(1.0, or(e.at("runs"), &key, 1.0));
        let mut r = c.clone();
        r.set("cab", cab.clone());
        r.set("L", l_v);
        r.set("runs", runs);
        if let Some(m) = m {
            r.set("fromLayout", true);
            r.set("Lmax", raw(m, "max"));
            r.set("lenFrom", raw(m, "from"));
        }
        if truthy(cab) {
            let rr = r_hot(cab);
            let i = n(&c, "I");
            let amp = n(cab, "ampacity") * runs * n(e, "derate");
            r.set("amp", amp);
            r.set("util", i / amp);
            let dv = vdrop(&r, n(&r, "L"), cab, runs);
            r.set("dv", dv);
            let mut dv_max = None;
            if let Some(m) = m.filter(|m| n(m, "max") > l) {
                // the longest run: the string or feeder that drops most
                dv_max = Some(vdrop(&r, n(m, "max"), cab, runs));
                r.set("dvMax", dv_max);
            }
            let i_loss = or(&c, "Iop", i);
            let dc = c.at("kind").str() == "dc";
            let ploss = (if dc { 2.0 } else { 3.0 }) * i_loss * i_loss * rr * l / runs * or(&c, "lossF", 1.0) / 1000.0;   // kW per circuit at rated
            r.set("ploss", ploss);
            // annual energy: rated loss × Σ (per-unit current)² for each circuit
            if t(&c, "gen") {
                if let (Some(gu), Some(lf)) = (&prof.gen_u, &prof.gen_lf) {
                    let gg = n(&c, "genGroup");
                    let mut s2 = 0.0;
                    for t in 0..HOURS {
                        let u = ix(gu, t);
                        if !tn(u) { continue; }
                        let f = ix(lf, t);
                        if key == "lv_gen" || gg == 1.0 { s2 += u * f * f; } else { let on = (u / gg).ceil(); s2 += on * sq((u / on / gg) * f); }
                    }
                    r.set("annual", ploss * s2);
                } else {
                    r.set("annual", Value::Null);
                }
            } else {
                r.set("annual", if t(&c, "pu") { Value::Num(ploss * n(&c, "count") * sum_sq(&vals(c.at("pu")))) } else { Value::Null });
            }
            let cores = if dc { 2.0 } else if n(cab, "cores") >= 3.0 { 1.0 } else { 3.0 };
            r.set("cost", or(cab, "price", 0.0) * l * runs * cores * n(&c, "count"));
            let lim_k = dv_key(c.at("cls").str());
            let (lim, lim_t) = (n(e, lim_k), text(field(e, lim_k)));
            r.set("lim", raw(e, lim_k));
            if i / amp > 1.0 {
                warn.push(format!("{name}: {} A exceeds the derated rating {} A. Use a larger cable or more parallel runs.", fmt_num(i, 0), fmt_num(amp, 0)));
            }
            if dv * 100.0 > lim {
                warn.push(format!("{name}: voltage drop {} % exceeds the {lim_t} % limit.", to_fixed(dv * 100.0, 2)));
            } else if let Some(dm) = dv_max.filter(|&dm| dm * 100.0 > lim) {
                warn.push(format!("{name}: the longest run ({} m) drops {} %, over the {lim_t} % limit; the average run is within it.",
                    fmt_val(m.unwrap_or(&Value::Null), "max", 0), to_fixed(dm * 100.0, 2)));
            }
        } else {
            warn.push(format!("{name}: no cable selected."));
        }
        circuits.push(r);
    }

    // --- inverter blocks measured on the layout (blocks.js): the share of the string and inverter cable losses of each block ---
    let pv_ac_y = truthy(pvr).then(|| sum(&vals(pvr.at("ac_per_kwp"))) * n(ppv, "capacity_kwp"));
    let pv_dc_y = pv_ac_y.map(|a| a / jmax(0.5, n(ppv, "inverter_eff")));
    let laid = |k: &str| circuits.iter().find(|c| c.at("key").str() == k && t(c, "fromLayout"));
    if let (true, Some(r_dc)) = (truthy(pl) && t(pl, "blocks"), laid("dc")) {
        let blocks = block_losses(p, pl.at("blocks"), r_dc, laid("lv_pv"), st.as_ref(), n_tr_pv, &mut warn, pv_dc_y);
        out.set("blocks", blocks);
    }

    // --- loss summary (year 1) ---
    let annual = |keys: &[&str]| circuits.iter().filter(|c| keys.contains(&c.at("key").str())).fold(0.0, |a, c| a + or(c, "annual", 0.0));
    let tr_a = |role: &str, k: &str| trafos.iter().filter(|x| x.at("role").str() == role).fold(0.0, |a, x| a + or(x, k, 0.0));
    let noload = |role: &str| trafos.iter().filter(|x| x.at("role").str() == role).fold(0.0, |a, x| a + n(x.at("t"), "p0") * n(x, "n"));
    let (cab_pv, cab_bess) = (annual(&["lv_pv", "mv_pv"]), annual(&["lv_bess", "mv_bess"]));
    let (nl_pv, nl_bess) = (noload("PV step-up"), noload("BESS step-up"));
    let y0 = sim.at("result").at("years").idx(0);
    out.set("loss", obj(vec![
        ("pv_dc", annual(&["dc"]).into()), ("pv_ac", (cab_pv + tr_a("PV step-up", "annual_kwh")).into()),
        ("bess", (cab_bess + tr_a("BESS step-up", "annual_kwh")).into()),
        ("gen", (annual(&["lv_gen", "mv_gen"]) + tr_a("Genset step-up", "annual_kwh")).into()),
        ("load", (annual(&["load"]) + tr_a("Load step-down", "annual_kwh")).into()), ("pvAc", pv_ac_y.into()), ("pvDc", pv_dc_y.into()),
        // fed back to the model: PV and BESS paths with the transformer load loss only; their no-load loss is an auxiliary load
        ("pv_ac_ll", (cab_pv + tr_a("PV step-up", "loadLoss")).into()), ("bess_ll", (cab_bess + tr_a("BESS step-up", "loadLoss")).into()),
        // no-load by component: the PV transformers run with PV, the BESS ones only with a battery
        ("noload_pv_kw", nl_pv.into()), ("noload_bess_kw", nl_bess.into()), ("noload_kw", (nl_pv + nl_bess).into()),
        ("bessThroughput", if truthy(sim) { Value::Num(n(y0, "bess_dis") + n(y0, "bess_ch")) } else { Value::Null }),
        ("genEnergy", if truthy(sim) { raw(y0, "gen_kwh") } else { Value::Null }),
    ]));
    let cost = circuits.iter().fold(0.0, |a, c| a + or(c, "cost", 0.0)) + trafos.iter().fold(0.0, |a, x| a + or(x.at("t"), "price", 0.0) * n(x, "n"));
    out.set("cost", cost);

    // --- the grid connection: reactive capability at the power factor asked there, weak-grid screening ---
    // the PCS as built: units × the datasheet's power, or the battery power without a datasheet (one unit)
    let pcs = if has_b && truthy(bat) && t(bat, "power_kw") { Some((n_b, n(bat, "power_kw"), kva_of(bat, n(bat, "power_kw")))) } else if has_b { Some((1.0, pb, pb)) } else { None };
    // the plant's AC rating (kWp ÷ DC/AC of the model), at most what the inverters give
    let pv_ac_kw = st.as_ref().map(|s| {
        let (pac, n_inv, r) = (n(s.at("inv"), "pac_kw"), n(s, "nInv"), n(ppv, "dc_ac_ratio"));
        if r > 0.0 { (n(s, "kwp") / r).min(n_inv * pac) } else { n_inv * pac }
    });
    let pf = n(e, "pf_poc");
    if pf > 0.0 && pf < 1.0 {
        let pv_q = st.as_ref().zip(pv_ac_kw).map_or(Value::Null, |(s, p)| {
            let (pac, n_inv) = (n(s.at("inv"), "pac_kw"), n(s, "nInv"));
            capability("PV inverters", p, n_inv, kva_of(s.at("inv"), pac), pf, &mut warn)
        });
        let pcs_q = pcs.map_or(Value::Null, |(units, _, kva)| capability("Battery PCS", pb, units, kva, pf, &mut warn));
        out.set("reactive", obj(vec![("pf", pf.into()), ("tan", pf.acos().tan().into()), ("pv", pv_q), ("bess", pcs_q)]));
    }
    if n(e, "grid_mva") > 0.0 {
        let p_ibr = st.as_ref().map_or(0.0, |s| n(s, "nInv") * n(s.at("inv"), "pac_kw")) + pcs.map_or(0.0, |(units, kw, _)| units * kw);
        out.set("weakGrid", weak_grid(e, p_ibr, &trafos, &mut warn));
        // the unbalanced-fault screen, on the converters' kVA, with the grid voltages during the fault set
        let s_conv = st.as_ref().map_or(0.0, |s| n(s, "nInv") * kva_of(s.at("inv"), n(s.at("inv"), "pac_kw"))) + pcs.map_or(0.0, |(units, _, kva)| units * kva);
        if n(e, "ubf_vpos") > 0.0 && s_conv > 0.0 { out.set("unbalanced", screens::unbalanced(e, s_conv)); }
    }
    // the islanded N-1 feeder screen
    if t(e, "n1_check") {
        let plant = screens::Plant { pv_kw: pv_ac_kw.unwrap_or(0.0), pv_feeders: n_feed, bess_kw: if has_b { pb } else { 0.0 }, gen_kw: unit_kw, gens: n_g.max(0.0),
            gens_per_feeder: if gen_mv { 1.0 } else { gpt }, peak_kw: peak };
        out.set("islands", screens::islands(p, &plant, &mut warn));
    }
    out.set("hasProfiles", truthy(pvr) || truthy(sim));
    if let Some(s) = st { out.set("str", s); }
    out.set("circuits", circuits);
    out.set("trafos", trafos);
    out.set("warn", warn.into_iter().map(Value::from).collect::<Vec<Value>>());
    out
}

/// Each block's share of the string cable losses (by its total string length) and of the inverter AC cable losses (by its run),
/// its voltage drops on its longest runs, its loss as a share of its DC energy, and the block that loses most. The design costs
/// the average run, so the blocks add up to the circuits. `b` from blocks.js; `pv_dc` the DC energy of year 1.
#[allow(clippy::too_many_arguments)]
fn block_losses(p: &Value, b: &Value, r_dc: &Value, r_lv: Option<&Value>, st: Option<&Value>, n_tr_pv: f64, warn: &mut Vec<String>, pv_dc: Option<f64>) -> Value {
    let e = p.at("electrical");
    let blocks = b.at("blocks").arr();
    let n_t = blocks.iter().fold(0.0, |a, x| a + n(x, "n"));
    let dc_tot = blocks.iter().fold(0.0, |a, x| a + n(x, "dcSum"));
    let ac_tot = blocks.iter().fold(0.0, |a, x| a + or(x, "ac", 0.0));
    let kwp = st.map_or_else(|| n(p.at("pv"), "capacity_kwp"), |s| n(s, "kwp"));
    let part = |r: Option<&Value>, x: f64, tot: f64| r.filter(|r| !r.at("annual").is_null() && tot > 0.0).map(|r| n(r, "annual") * x / tot);
    let drop = |r: Option<&Value>, len: f64| r.filter(|r| !r.at("dv").is_null() && n(r, "L") > 0.0).map(|r| n(r, "dv") * len / n(r, "L"));
    let nodes = b.at("nodes");
    let mut list: Vec<Value> = vec![];
    let mut losses: Vec<Option<f64>> = vec![];
    for (j, bk) in blocks.iter().enumerate() {
        let share = n(bk, "n") / n_t;
        let has_ac = !bk.at("ac").is_null();
        let dc_kwh = part(Some(r_dc), n(bk, "dcSum"), dc_tot);
        let ac_kwh = if has_ac { part(r_lv, n(bk, "ac"), ac_tot) } else { None };
        let energy = pv_dc.map(|d| d * share);
        let lost = dc_kwh.map(|d| d + ac_kwh.filter(|&a| tn(a)).unwrap_or(0.0));
        let loss = match (energy, lost) { (Some(en), Some(lo)) if tn(en) => Some(lo / en), _ => None };
        let dv_dc = drop(Some(r_dc), n(bk, "dcMax"));
        let dv_ac = if has_ac { drop(r_lv, n(bk, "ac")) } else { None };
        let over = dv_dc.is_some_and(|d| d * 100.0 > n(e, "dv_dc")) || dv_ac.is_some_and(|d| d * 100.0 > n(e, "dv_lv"));
        let node = nodes.idx(j);
        list.push(obj(vec![
            ("node", j.into()), ("name", if t(node, "name") { raw(node, "name") } else { "".into() }), ("n", raw(bk, "n")), ("kwp", (kwp * share).into()),
            ("dcAvg", (if t(bk, "n") { n(bk, "dcSum") / n(bk, "n") } else { 0.0 }).into()), ("dcMax", raw(bk, "dcMax")), ("dvDc", dv_dc.into()),
            ("ac", raw(bk, "ac")), ("dvAc", dv_ac.into()), ("dcKwh", dc_kwh.into()), ("acKwh", ac_kwh.into()), ("loss", loss.into()),
            ("station", raw(bk, "station")), ("over", over.into()),
        ]));
        losses.push(loss);
    }
    let mut worst: i64 = -1;
    for (j, l) in losses.iter().enumerate() {
        if let Some(l) = *l {
            if worst < 0 || losses[worst as usize].is_some_and(|w| l > w) { worst = j as i64; }
        }
    }
    let string = b.at("mode").str() == "string";
    let units = if string { st.map(|s| n(s, "nInv")) } else { Some(n_tr_pv).filter(|&x| tn(x)) };
    let placed = nodes.arr().len();
    if let Some(u) = units.filter(|&u| tn(u) && u != placed as f64) {
        let (k, u) = (placed, js_num(u));
        warn.push(if string {
            format!("{k} inverters are placed on the map; the design has {u}. The blocks follow the map: place {u} (Auto-place on the Site & layout page).")
        } else {
            format!("{k} PV stations are placed on the map; the design has {u} PV transformers. The blocks follow the map: place {u} (Auto-place on the Site & layout page).")
        });
    }
    let bad = list.iter().filter(|x| t(x, "over")).count();
    if bad > 0 {
        warn.push(format!("{bad} inverter block{} drop more than the voltage-drop limit on the longest run (marked in the block table). Move the inverter or station closer, or use a larger cable.",
            if bad > 1 { "s" } else { "" }));
    }
    obj(vec![("mode", raw(b, "mode")), ("nodes", nodes.clone()), ("tableNode", raw(b, "tableNode")), ("list", list.into()), ("worst", worst.into())])
}

/// The smallest cable (and fewest parallel runs) of each circuit that meets its current rating and voltage-drop limit. Writes
/// the choices into the project's electrical settings; returns how many circuits changed.
pub fn auto_size(p: &mut Value, pvr: &Value, sim: &Value, lengths: &Value) -> usize {
    let d = compute_design(&Req { project: p, pvr, sim, lengths });
    let lib: Vec<Value> = p.at("equipment").at("lib").at("cable").arr().to_vec();
    let derate = n(p.at("electrical"), "derate");
    let mut changed = 0;
    for c in d.at("circuits").arr() {
        let cls = c.at("cls").str();
        let mut cands: Vec<&Value> = lib.iter().filter(|x| cable_class(x) == cls).collect();
        cands.sort_by(|a, b| (n(a, "csa") - n(b, "csa")).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
        let lim = n(p.at("electrical"), dv_key(cls)) / 100.0;
        // the longest run measured on the layout, else the length
        let len = if n(c, "Lmax") > n(c, "L") { n(c, "Lmax") } else { n(c, "L") };
        let mut pick = None;
        'runs: for runs in 1..=12 {
            for x in &cands {
                let dv = vdrop(c, len, x, runs as f64);
                if n(c, "I") <= n(x, "ampacity") * runs as f64 * derate && dv <= lim { pick = Some((*x, runs)); break 'runs; }
            }
        }
        if let Some((x, runs)) = pick {
            let key = c.at("key").str();
            let e = member(p, "electrical");
            member(e, "cable").set(key, raw(x, "id"));
            member(e, "runs").set(key, runs);
            changed += 1;
        }
    }
    changed
}

/// Feeds the losses of design `d` back into the model inputs. `rte_base` is the battery efficiency before the first application,
/// so repeated applications do not compound it; the caller passes it only while the project's efficiency is still the one the
/// last application set (the interface's `{rte, set}` check), else None. Returns that base as `{rte, set}` (null without a battery
/// path), or the message the interface shows when there is nothing to apply.
pub fn apply_losses(p: &mut Value, d: &Value, base: &Value) -> Result<Value, String> {
    let l = d.at("loss");
    if !truthy(d) || !t(d, "hasProfiles") || !t(l, "pvAc") { return Err("Calculate the PV yield first (tab 4).".into()); }
    {
        let pv = member(p, "pv");
        pv.set("dc_wiring", fixed(n(l, "pv_dc") / n(l, "pvDc"), 5));
        pv.set("dc_wiring_basis", "annual");   // an energy-weighted loss over the year, not the loss at STC power
        pv.set("ac_losses", fixed(n(l, "pv_ac_ll") / n(l, "pvAc"), 5));   // cables + transformer load loss
    }
    {
        // no-load loss is drawn day and night: an auxiliary load, each part counted only with the asset it serves
        let aux = member(p, "aux");
        aux.set("trafo_noload_kw", fixed(n(l, "noload_pv_kw"), 3));
        aux.set("bess_trafo_noload_kw", fixed(n(l, "noload_bess_kw"), 3));
    }
    if t(d, "str") {
        let s = d.at("str");
        let pv = member(p, "pv");
        pv.set("dc_ac_ratio", fixed(n(s, "dcac"), 3));
        pv.set("capacity_kwp", jround(n(s, "kwp")));
    }
    // values set here, so the report can tell them from typed ones
    let applied = obj(vec![("dc_wiring", raw(p.at("pv"), "dc_wiring")), ("ac_losses", raw(p.at("pv"), "ac_losses")),
        ("dc_ac_ratio", raw(p.at("pv"), "dc_ac_ratio")), ("trafo_noload_kw", raw(p.at("aux"), "trafo_noload_kw")),
        ("bess_trafo_noload_kw", raw(p.at("aux"), "bess_trafo_noload_kw"))]);
    member(p, "electrical").set("applied", applied);
    let current = |p: &Value| match p.at("bess").at("rte") { Value::Num(x) => Some(*x), _ => None };
    // `base`: what the last apply returned, {rte (before any apply), set (what it set)}, or null
    let mut next: Option<(Value, Option<f64>)> = base.is_object().then(|| (base.at("rte").clone(), match base.at("set") { Value::Num(x) => Some(*x), _ => None }));
    if t(l, "bessThroughput") {
        let rte = p.at("bess").at("rte");
        let still = next.as_ref().is_some_and(|(_, set)| set.is_some() && *set == current(p));
        let base = if still { next.take().map_or(Value::Null, |(r, _)| r) } else { rte.clone() };
        let f = n(l, "bess_ll") / n(l, "bessThroughput");   // fraction lost per pass through the BESS path (charge + discharge)
        let set = fixed(to_num(&base) * (1.0 - f) * (1.0 - f), 4);
        member(p, "bess").set("rte", set);
        next = Some((base, Some(set)));
    }
    Ok(next.map_or(Value::Null, |(rte, set)| {
        let mut o = obj(vec![("rte", rte)]);
        if let Some(s) = set { o.set("set", s); }
        o
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    // the base case of tests/fixtures/electrical with its shared series put back
    fn base_fixture() -> Value {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/electrical");
        let series = Value::parse(&std::fs::read_to_string(dir.join("_series.json")).unwrap()).unwrap();
        fn put(v: &mut Value, s: &Value) {
            match v {
                Value::Str(x) if x.starts_with('@') => *v = s.at(&x[1..]).clone(),
                Value::Arr(a) => a.iter_mut().for_each(|y| put(y, s)),
                Value::Obj(o) => o.values_mut().for_each(|y| put(y, s)),
                _ => {}
            }
        }
        let mut f = Value::parse(&std::fs::read_to_string(dir.join("base.json")).unwrap()).unwrap();
        put(&mut f, &series);
        f.at("request").clone()
    }

    #[test]
    fn javascript_semantics() {
        // a second apply works from the efficiency before the first, unless the user typed another since
        let req = base_fixture();
        let r = Req::of(&req);
        let d = compute_design(&r);
        let mut p = r.project.clone();
        let b1 = apply_losses(&mut p, &d, &Value::Null).unwrap();
        let rte1 = p.at("bess").get("rte", 0.0);
        let b2 = apply_losses(&mut p, &d, &b1).unwrap();
        assert_eq!(p.at("bess").get("rte", 0.0), rte1, "applying twice derates once");
        assert_eq!(b2.at("rte").num(0.0), 0.88);
        let mut b = p.at("bess").clone();
        b.set("rte", 0.9);
        p.set("bess", b);
        apply_losses(&mut p, &d, &b2).unwrap();
        assert!(p.at("bess").get("rte", 0.0) < 0.9 && p.at("bess").get("rte", 0.0) > rte1, "a typed efficiency is the new base");
        assert_eq!(jround(-2.5), -2.0);
        assert_eq!(jround(2.5), 3.0);
        assert_eq!(jround(0.49999999999999994), 0.0);
        assert_eq!(to_num(&Value::Str(" 27 ".into())), 27.0);
        assert!(to_num(&Value::Str("27 m".into())).is_nan());
        assert_eq!(to_num(&Value::Str("".into())), 0.0);
        assert!(jmin(1.0, f64::NAN).is_nan());
        assert_eq!(js_num(27.0), "27");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(1.5e-7), "1.5e-7");
        assert_eq!(js_num(-0.0), "0");
        assert_eq!(fixed(0.0031049, 5), 0.0031);
        assert_eq!(fixed(1.0005, 3), 1.0);   // the binary value of 1.0005 is below the tie
    }
}
