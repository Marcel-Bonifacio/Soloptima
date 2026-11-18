//! The electrical design of a plant, from the project as the interface holds it (JSON): string sizing, transformers, cable
//! circuits and their losses over the hourly profiles (design.rs), the 8760 h radial load flow (loadflow.rs), short-circuit
//! currents by IEC 60909-0 (fault.rs) and protection coordination (protection.rs), with two grid screens added since
//! (screens.rs: islanded N-1 feeders, unbalanced faults). Ported from the interface's JavaScript
//! (ui/src/lib/equip/); engine/tests/electrical.rs checks every result against fixtures that JavaScript wrote.
//!
//! A request is {project, pvr, sim, lengths}: the project's electrical, equipment, pv, bess, diesel, aux, econ, load and
//! weather; the PV yield's hourly AC per kWp, cell temperature and plane irradiance; the simulation's hourly flows and year 1;
//! and the cable lengths measured on the layout map (computed by the interface, ui/src/lib/equip/siteplan.js).
pub mod design;
pub mod fault;
pub mod loadflow;
pub mod protection;
pub mod screens;
pub mod util;

use crate::json::Value;

/// The inputs of a study, borrowed from the request
pub struct Req<'a> {
    pub project: &'a Value,
    pub pvr: &'a Value,
    pub sim: &'a Value,
    pub lengths: &'a Value,
}
impl<'a> Req<'a> {
    pub fn of(r: &'a Value) -> Req<'a> { Req { project: r.at("project"), pvr: r.at("pvr"), sim: r.at("sim"), lengths: r.at("lengths") } }
}

/// The interface's electrical command: {action, request, rte_base, t}. study: the design and its short-circuit and protection
/// study; autosize: the electrical inputs with the cables sized and how many circuits changed; apply: the model inputs with
/// the design's losses fed back (rte_base: what the last apply returned, so a second apply does not compound the battery derating); loadflow: the 8760 h load flow
/// of the simulation; buses: the bus voltages at hour t.
pub fn command(v: &Value) -> Result<Value, String> {
    use util::obj;
    let req = v.at("request");
    let r = Req::of(req);
    if !r.project.at("electrical").is_object() || !r.project.at("equipment").at("lib").is_object() {
        return Err("The project has no electrical design basis or equipment library.".into());
    }
    let sim_needed = || if r.sim.at("result").at("hourly").is_object() { Ok(()) } else { Err("Run a simulation first: the load flow uses the hourly dispatch.".to_string()) };
    match v.gets("action", "study").as_str() {
        "study" => {
            let d = design::compute_design(&r);
            let pr = protection::protection_study(r.project, &d);
            Ok(obj(vec![("design", d), ("protection", pr)]))
        }
        "autosize" => {
            let mut p = r.project.clone();
            let n = design::auto_size(&mut p, r.pvr, r.sim, r.lengths);
            Ok(obj(vec![("count", Value::Num(n as f64)), ("electrical", p.at("electrical").clone())]))
        }
        "apply" => {
            let mut p = r.project.clone();
            let d = design::compute_design(&r);
            let rte = design::apply_losses(&mut p, &d, v.at("rte_base"))?;
            Ok(obj(vec![("rte_base", rte), ("pv", p.at("pv").clone()), ("bess", p.at("bess").clone()), ("aux", p.at("aux").clone()), ("electrical", p.at("electrical").clone())]))
        }
        "loadflow" => {
            sim_needed()?;
            Ok(loadflow::run_load_flow(r.project, &design::compute_design(&r), r.sim))
        }
        "buses" => {
            sim_needed()?;
            let t = v.get("t", -1.0);
            if !(0.0..8760.0).contains(&t) { return Err("The hour of the load flow must be 0 to 8759.".into()); }
            Ok(loadflow::bus_voltages(r.project, &design::compute_design(&r), r.sim, t as usize))
        }
        a => Err(format!("Unknown electrical action {a:?}.")),
    }
}
