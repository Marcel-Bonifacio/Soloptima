//! Two grid screens added after the port, both steady-state estimates on the design:
//! - the islanded N-1 feeder screen after Shabar et al. (2027): for each single branch outage of the radial network, does the island that keeps
//!   the load still have a source that forms the grid, and enough firm capacity for its peak load and its critical share;
//! - the unbalanced-fault screen after Wang et al. (2026): the sequence voltages and the voltage unbalance factor at the point of connection
//!   when the converters support both sequences within one current limit.
//!
//! Neither runs a load flow: the islanded droop load flow of Shabar et al. (frequency as an unknown, voltage- and frequency-dependent
//! loads) is not modelled. Both papers are reviewed in docs/LITERATURE.md.
use super::util::{fmt_num, num, obj};
use crate::json::Value;

/// What the N-1 screen needs of the design: source ratings (kW), how many identical feeders carry them, and the peak load
pub struct Plant {
    /// AC rating of all PV and the number of PV feeders
    pub pv_kw: f64,
    pub pv_feeders: f64,
    /// battery PCS power (0 without a battery)
    pub bess_kw: f64,
    /// genset rating, units, and the units on one feeder
    pub gen_kw: f64,
    pub gens: f64,
    pub gens_per_feeder: f64,
    /// peak site load
    pub peak_kw: f64,
}

/// What is in service in the island that keeps the load
#[derive(Clone, Copy)]
struct Island {
    grid: bool,
    pv: f64,
    bess: f64,
    gens: f64,
    load: bool,
}

/// The islanded N-1 screen. Each outage takes one branch: the utility incomer, one PV feeder, the BESS feeder, one genset feeder
/// or the load feeder. The network is a star at the MV bus, so an outage leaves at most two islands: the bus with everything
/// else, and the branch cut off. Only the island with the load is checked. Grid-forming: the utility, the gensets, and the
/// battery PCS when `electrical.pcs_grid_forming` says so ('auto': yes for an off-grid plant, no with the grid connected).
/// Firm capacity: the utility's import limit, the gensets, a grid-forming PCS, and `n1_pv_share` of the PV in the island,
/// counted only with a grid-forming source there.
pub fn islands(p: &Value, pl: &Plant, warn: &mut Vec<String>) -> Value {
    let e = p.at("electrical");
    let grid = p.at("grid");
    let on_grid = grid.getb("enabled", false);
    let import = if on_grid { grid.get("import_kw", 0.0).max(0.0) } else { 0.0 };
    let gf = match e.at("pcs_grid_forming").str() { "yes" => true, "no" => false, _ => !on_grid };
    let pv_share = e.get("n1_pv_share", 0.0).clamp(0.0, 1.0);
    let crit_share = p.at("load").get("critical_share", 1.0).clamp(0.0, 1.0);
    let peak = pl.peak_kw.max(0.0);
    let crit = peak * crit_share;
    let all = Island { grid: on_grid, pv: pl.pv_kw, bess: pl.bess_kw, gens: pl.gens, load: true };
    let lost_gens = pl.gens_per_feeder.min(pl.gens);
    let one = |n: f64, what: &str| if n > 1.0 { format!("{what} (one of {})", fmt_num(n, 0)) } else { what.to_string() };
    // (outage, as a warning says it, the island with the load, how many islands, what the other island holds)
    let mut cases: Vec<(String, &str, Island, usize, &str)> = vec![("None".into(), "with everything in service", all, 1, "")];
    if on_grid {
        cases.push(("Utility supply".into(), "with the utility supply out", Island { grid: false, ..all }, 1, ""));
    }
    if pl.pv_kw > 0.0 && pl.pv_feeders >= 1.0 {
        cases.push((one(pl.pv_feeders, "PV feeder"), "with one PV feeder out", Island { pv: pl.pv_kw * (1.0 - 1.0 / pl.pv_feeders), ..all }, 2, "PV stations, no load"));
    }
    if pl.bess_kw > 0.0 {
        cases.push(("BESS feeder".into(), "with the BESS feeder out", Island { bess: 0.0, ..all }, 2, "BESS station, no load"));
    }
    if pl.gens > 0.0 {
        let feeders = (pl.gens / pl.gens_per_feeder.max(1.0)).ceil();
        cases.push((one(feeders, "Genset feeder"), "with one genset feeder out", Island { gens: pl.gens - lost_gens, ..all }, 2, "gensets, no load"));
    }
    if peak > 0.0 {
        cases.push(("Load feeder".into(), "with the load feeder out", Island { load: false, ..all }, 2, "the rest of the plant, no load"));
    }
    let mut rows: Vec<Value> = vec![];
    let (mut outages, mut no_shed, mut worst, mut worst_shed) = (0, 0, -1i64, -1.0);
    for (i, (label, phrase, is, islands, other)) in cases.iter().enumerate() {
        let own = !is.load;   // the load's own feeder: no source can reach it
        let mut sources: Vec<&str> = vec![];
        if !own {
            if is.grid { sources.push("utility"); }
            if is.gens > 0.0 { sources.push("gensets"); }
            if gf && is.bess > 0.0 { sources.push("battery PCS"); }
        }
        let formed = !sources.is_empty();
        let firm = if formed {
            (if is.grid { import } else { 0.0 }) + is.gens * pl.gen_kw.max(0.0) + (if gf { is.bess } else { 0.0 }) + pv_share * is.pv
        } else { 0.0 };
        let shed = (peak - firm).max(0.0);
        let crit_shed = (crit - firm).max(0.0);
        rows.push(obj(vec![("outage", label.as_str().into()), ("islands", (*islands).into()), ("other", (*other).into()),
            ("sources", sources.iter().map(|&s| Value::from(s)).collect::<Vec<Value>>().into()), ("formed", formed.into()),
            ("firm", firm.into()), ("load", peak.into()), ("shed", shed.into()), ("critLoad", crit.into()), ("critShed", crit_shed.into()),
            ("ok", (shed <= 1e-9).into()), ("own", own.into())]));
        if i > 0 && !own {
            outages += 1;
            if shed <= 1e-9 { no_shed += 1; }
            if shed > worst_shed { worst_shed = shed; worst = i as i64; }
        }
        if crit_shed > 1e-9 && !own {
            let why = if formed { format!("the island has {} kW of firm capacity", fmt_num(firm, 0)) } else { "no source left in the island forms the grid".into() };
            warn.push(format!("Islanded N-1 screen: {phrase}, {} kW of the {} kW critical load cannot be served: {why}.", fmt_num(crit_shed, 0), fmt_num(crit, 0)));
        }
    }
    obj(vec![("rows", rows.into()), ("outages", outages.into()), ("noShed", no_shed.into()), ("worst", worst.into()),
        ("onGrid", on_grid.into()), ("pcsGf", gf.into()), ("pvShare", pv_share.into()), ("critShare", crit_share.into()), ("import", import.into())])
}

/// The unbalanced-fault screen at the point of connection (the MV bus) after Wang et al. (2026). Per unit on the rated apparent power of the
/// PV inverters and PCS (`s_conv`, kVA): the utility is a Thevenin source of impedance Z = s_conv ÷ S_sc with its X/R, and each
/// sequence sees it alone. The converters hold the grid-code droop on the positive sequence, Iq+ = K+(0.9 − V+) below 0.9 pu,
/// and use what is left of the current limit on the negative sequence, with |I+| + |I−| ≤ Imax so no phase exceeds Imax.
/// Each sequence current carries an active part Id = (R/X)·Iq, which puts Z·I in phase with the voltage, so |ΔV| = Z·|I| and
/// |I| = (Z/X)·Iq. That gives V+ = (X·Vg+ + 0.9·Z²·K+) ÷ (X + Z²·K+) and V− = Vg− − Z·|I−|. Full cancellation of V− needs
/// |I−| = Vg−/Z, so it is possible when Vg− ≤ Z·(Imax − |I+|) (mode A); otherwise all the current left goes to the negative
/// sequence (mode B), which gives the lowest unbalance with K+ at its floor.
pub fn unbalanced(e: &Value, s_conv: f64) -> Value {
    let ssc = e.get("grid_mva", 0.0) * 1000.0;
    let pos = |k: &str, def: f64| if e.get(k, 0.0) > 0.0 { e.get(k, 0.0) } else { def };
    let xr = pos("grid_xr", 10.0);
    let (vp, vn, imax, k) = (e.get("ubf_vpos", 0.0), e.get("ubf_vneg", 0.0).max(0.0), pos("ubf_imax", 1.1), pos("ubf_kpos", 2.0));
    let z = s_conv / ssc;
    let (r, x) = (z / (1.0 + xr * xr).sqrt(), z * xr / (1.0 + xr * xr).sqrt());
    // positive sequence: the droop, or the whole current limit when the droop asks for more
    let mut v_pos = if vp < 0.9 { (x * vp + 0.9 * z * z * k) / (x + z * z * k) } else { vp };
    let mut i_pos = z / x * (k * (0.9 - v_pos)).max(0.0);
    let short = i_pos > imax;
    if short { i_pos = imax; v_pos = vp + z * imax; }
    // negative sequence: what is left
    let left = imax - i_pos;
    let cancel = vn <= z * left;
    let i_neg = if cancel { vn / z } else { left };
    let v_neg = if cancel { 0.0 } else { vn - z * i_neg };
    let iq = |i: f64| i * x / z;
    let id = |i: f64| i * r / z;
    obj(vec![("vgPos", vp.into()), ("vgNeg", vn.into()), ("imax", imax.into()), ("kPos", k.into()), ("sBase", s_conv.into()), ("ssc", ssc.into()),
        ("z", z.into()), ("r", r.into()), ("x", x.into()), ("vPos", v_pos.into()), ("vNeg", v_neg.into()), ("vuf", num(v_neg / v_pos)),
        ("vuf0", num(vn / vp)), ("mode", (if cancel { "A" } else { "B" }).into()), ("cancel", cancel.into()), ("short", short.into()),
        ("iPos", i_pos.into()), ("iNeg", i_neg.into()), ("iqPos", iq(i_pos).into()), ("idPos", id(i_pos).into()),
        ("iqNeg", iq(i_neg).into()), ("idNeg", id(i_neg).into()), ("spare", (imax - i_pos - i_neg).into()),
        ("kNeg", if cancel || v_neg <= 0.0 { Value::Null } else { (iq(i_neg) / v_neg).into() })])
}
