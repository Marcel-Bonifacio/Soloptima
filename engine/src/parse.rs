//! A project document into the engine's model (src/model.cpp: parse_project, parse_weather). Missing, null and mistyped
//! members take the default, as in the C++ engine; the document is not checked here (see validate.rs).
use crate::json::Value;
use crate::layout::parse_layout;
use crate::model::*;

/// Hourly arrays: 8760 (hourly), 17520 (half-hourly: average pairs) and 35040 (quarter-hourly: average fours), and the same
/// in a leap year (8784, 17568, 35136: drop Feb 29 first), as to8760 in web/js/util.js. Other lengths are left as they are.
fn to_8760(mut v: Vec<f64>) -> Vec<f64> {
    for k in [1usize, 2, 4] {
        let day = 24 * k;
        if v.len() == 366 * day { v.drain(59 * day..60 * day); }
        if v.len() != HOURS * k || k == 1 { continue; }
        v = v.chunks(k).map(|c| c.iter().fold(0.0, |a, b| a + b) / k as f64).collect();
    }
    v
}

pub fn parse_weather(w: &Value) -> Weather {
    Weather {
        is_utc: w.getb("is_utc", true),
        time_offset: w.get("time_offset", 0.5),
        ghi: to_8760(w.getv("ghi")),
        dni: to_8760(w.getv("dni")),
        dhi: to_8760(w.getv("dhi")),
        tamb: to_8760(w.getv("tamb")),
        wind: to_8760(w.getv("wind")),
        snow: to_8760(w.getv("snow")),
        horizon_in_beam: w.getb("horizon_in_beam", w.gets("source", "").starts_with("PVGIS")),
    }
}

/// A fuel curve of (load fraction, kWh per litre) points; None unless it has 2 or more (points not above 0 are left out)
fn fuel_curve(curve: &Value) -> Option<Vec<(f64, f64)>> {
    if !(curve.is_array() && curve.len() >= 2) { return None; }
    let mut out = Vec::new();
    for pt in curve.arr() {
        if pt.len() >= 2 && pt.idx(0).num(0.0) > 0.0 && pt.idx(1).num(0.0) > 0.0 { out.push((pt.idx(0).num(0.0), pt.idx(1).num(0.0))); }
    }
    Some(out)
}

pub fn parse_project(v: &Value) -> Project {
    let mut p = Project { name: v.gets("name", "Untitled"), ..Default::default() };

    let l = v.at("location");
    p.loc.lat = l.get("lat", 0.0);
    p.loc.lon = l.get("lon", 0.0);
    p.loc.utc_offset = if l.has("utc_offset") { l.get("utc_offset", 0.0) } else { (p.loc.lon / 15.0).round() };
    p.loc.elevation = l.get("elevation", v.at("weather").get("elevation", 0.0));

    p.wx = parse_weather(v.at("weather"));
    p.layout = parse_layout(v.at("layout"), &p.loc);
    p.load_kw = to_8760(v.at("load").getv("kw"));
    p.sim.load_growth = v.at("load").get("growth", 0.0);

    let (x, ly) = (v.at("pv"), v.at("layout"));
    let pv = &mut p.pv;
    macro_rules! num { ($src:expr, $dst:expr, $k:literal) => { $dst = $src.get($k, $dst); }; }
    macro_rules! int { ($src:expr, $dst:expr, $k:literal) => { $dst = $src.get($k, f64::from($dst)) as i32; }; }
    macro_rules! flag { ($src:expr, $dst:expr, $k:literal) => { $dst = $src.getb($k, $dst); }; }
    macro_rules! text { ($src:expr, $dst:expr, $k:literal) => { $dst = $src.gets($k, &$dst); }; }
    num!(x, pv.capacity_kwp, "capacity_kwp");
    num!(x, pv.module_eff, "module_eff");
    num!(x, pv.gamma_pmax, "gamma_pmax");
    num!(x, pv.low_irr_loss_200, "low_irr_loss_200");
    text!(x, pv.mount, "mount");
    num!(x, pv.tilt, "tilt");
    flag!(x, pv.azimuth_auto, "azimuth_auto");
    num!(x, pv.azimuth, "azimuth");
    if pv.azimuth_auto { pv.azimuth = if p.loc.lat >= 0.0 { 180.0 } else { 0.0 }; }
    num!(x, pv.gcr, "gcr");
    num!(x, pv.tracker_axis_azimuth, "tracker_axis_azimuth");
    num!(x, pv.tracker_axis_tilt, "tracker_axis_tilt");
    num!(x, pv.tracker_cross_slope, "tracker_cross_slope");
    num!(x, pv.tracker_max_angle, "tracker_max_angle");
    flag!(x, pv.backtracking, "backtracking");
    flag!(x, pv.row_shading, "row_shading");
    text!(x, pv.shade_model, "shade_model");
    int!(x, pv.bypass_blocks, "bypass_blocks");
    flag!(x, pv.diffuse_shading, "diffuse_shading");
    num!(x, pv.mount_height, "mount_height");
    // Slant width of a table from the layout (modules across the table times the module side up the slope), unless given
    pv.portrait = ly.gets("orientation", "portrait") != "landscape";
    pv.modules_up = ly.get("modules_across", 2.0).round().max(1.0) as i32;
    let side = x.get(if pv.portrait { "module_length" } else { "module_width" }, if pv.portrait { 2.278 } else { 1.134 });
    pv.row_width = x.get("row_width", f64::from(pv.modules_up) * side);
    num!(x, pv.albedo, "albedo");
    pv.albedo_monthly = x.getv("albedo_monthly");
    text!(x, pv.transposition, "transposition");
    text!(x, pv.decomposition, "decomposition");
    text!(x, pv.clearsky, "clearsky");
    num!(x, pv.linke_turbidity, "linke_turbidity");
    pv.horizon = x.getv("horizon");
    text!(x, pv.horizon_beam, "horizon_beam");
    flag!(x, pv.near_shading, "near_shading");
    num!(x, pv.bifaciality, "bifaciality");
    num!(x, pv.rear_loss, "rear_loss");
    text!(x, pv.iam_model, "iam_model");
    num!(x, pv.iam_b0, "iam_b0");
    num!(x, pv.iam_ar, "iam_ar");
    num!(x, pv.iam_n, "iam_n");
    num!(x, pv.iam_kl, "iam_kl");
    num!(x, pv.iam_n_ar, "iam_n_ar");
    text!(x, pv.spectral, "spectral");
    num!(x, pv.soiling, "soiling");
    pv.soiling_monthly = x.getv("soiling_monthly");
    pv.snow_monthly = x.getv("snow_monthly");
    pv.snow_events = x.getv("snow_events");
    num!(x, pv.snow_rh, "snow_rh");
    text!(x, pv.thermal_model, "thermal_model");
    num!(x, pv.noct, "noct");
    num!(x, pv.uc, "uc");
    num!(x, pv.uv, "uv");
    num!(x, pv.absorptance, "absorptance");
    num!(x, pv.mismatch, "mismatch");
    num!(x, pv.dc_wiring, "dc_wiring");
    text!(x, pv.dc_wiring_basis, "dc_wiring_basis");
    num!(x, pv.lid, "lid");
    num!(x, pv.module_quality, "module_quality");
    num!(x, pv.dc_ac_ratio, "dc_ac_ratio");
    num!(x, pv.inverter_eff, "inverter_eff");
    text!(x, pv.inverter_model, "inverter_model");
    num!(x, pv.inverter_eff_max, "inverter_eff_max");
    num!(x, pv.ac_losses, "ac_losses");
    num!(x, pv.availability, "availability");
    num!(x, pv.degradation, "degradation");
    text!(x, pv.degradation_model, "degradation_model");

    let (b, bs) = (&mut p.bess, v.at("bess"));
    num!(bs, b.energy_kwh, "energy_kwh");
    num!(bs, b.power_kw, "power_kw");
    num!(bs, b.rte, "rte");
    num!(bs, b.soc_min, "soc_min");
    num!(bs, b.soc_max, "soc_max");
    num!(bs, b.soc_init, "soc_init");
    num!(bs, b.calendar_fade, "calendar_fade");
    num!(bs, b.cycle_life, "cycle_life");
    num!(bs, b.cycle_life_dod, "cycle_life_dod");
    num!(bs, b.eol_soh, "eol_soh");
    num!(bs, b.replace_soh, "replace_soh");   // null (blank in the GUI) keeps the default
    num!(bs, b.soh_init, "soh_init");
    num!(bs, b.warranty_efc_yr, "warranty_efc_yr");
    flag!(bs, b.provides_reserve, "provides_reserve");
    num!(bs, b.reserve_duration_h, "reserve_duration_h");
    num!(bs, b.self_discharge, "self_discharge");

    let (w, ws) = (&mut p.wind, v.at("wind"));
    int!(ws, w.units, "units");
    num!(ws, w.rated_kw, "rated_kw");
    num!(ws, w.v_in, "v_in");
    num!(ws, w.v_rated, "v_rated");
    num!(ws, w.v_out, "v_out");
    num!(ws, w.hub_height, "hub_height");
    num!(ws, w.ref_height, "ref_height");
    num!(ws, w.shear_alpha, "shear_alpha");
    text!(ws, w.curve, "curve");
    num!(ws, w.losses, "losses");
    num!(ws, w.availability, "availability");

    let (d, ds) = (&mut p.dg, v.at("diesel"));
    num!(ds, d.unit_kw, "unit_kw");
    int!(ds, d.units, "units");
    num!(ds, d.min_load, "min_load");
    int!(ds, d.min_units_online, "min_units_online");
    num!(ds, d.reserve_load, "reserve_load");
    num!(ds, d.reserve_pv, "reserve_pv");
    text!(ds, d.strategy, "strategy");
    num!(ds, d.cc_setpoint, "cc_setpoint");
    text!(ds, d.fuel_model, "fuel_model");
    num!(ds, d.fuel_intercept, "fuel_intercept");
    num!(ds, d.fuel_slope, "fuel_slope");
    if let Some(c) = fuel_curve(ds.at("fuel_curve")) { d.fuel_curve = c; }
    // Further groups of a mixed fleet; what a group leaves out is taken from the main group (costs: when the fleet is built)
    for gs in ds.at("more_groups").arr() {
        if !gs.is_object() { continue; }
        let opt = |k: &str| if gs.at(k).is_null() || !gs.has(k) { None } else { Some(gs.get(k, 0.0)) };
        let model = gs.gets("fuel_model", &d.fuel_model);
        d.more_groups.push(GensetGroup {
            name: gs.gets("name", ""),
            units: gs.get("units", 1.0) as i32,
            unit_kw: gs.get("unit_kw", d.unit_kw),
            min_load: gs.get("min_load", d.min_load),
            fuel_intercept: gs.get("fuel_intercept", d.fuel_intercept),
            fuel_slope: gs.get("fuel_slope", d.fuel_slope),
            fuel_curve: fuel_curve(gs.at("fuel_curve")).unwrap_or_else(|| d.fuel_curve.clone()),
            fuel_model: model,
            capex_kw: opt("capex_kw"), om_kwh: opt("om_kwh"), om_unit_hour: opt("om_unit_hour"),
        });
    }

    let (g, gs) = (&mut p.grid, v.at("grid"));
    flag!(gs, g.enabled, "enabled");
    num!(gs, g.import_kw, "import_kw");
    num!(gs, g.export_kw, "export_kw");
    text!(gs, g.tariff, "tariff");
    num!(gs, g.import_price, "import_price");
    g.tou = gs.getv("tou");
    num!(gs, g.export_price, "export_price");
    num!(gs, g.demand_charge, "demand_charge");
    num!(gs, g.escalation, "escalation");
    num!(gs, g.co2_kg_per_kwh, "co2_kg_per_kwh");
    text!(gs, g.availability, "availability");
    g.pattern = gs.getv("pattern");
    num!(gs, g.outages_per_year, "outages_per_year");
    num!(gs, g.outage_hours, "outage_hours");
    g.seed = gs.get("seed", g.seed as f64) as i64;

    let (m, ms) = (&mut p.ems, v.at("ems"));
    text!(ms, m.pv_forecast, "pv_forecast");
    text!(ms, m.load_forecast, "load_forecast");
    num!(ms, m.noise_sigma, "noise_sigma");
    m.horizon = (ms.get("horizon", f64::from(m.horizon)) as i32).clamp(1, 168);
    m.replan = (ms.get("replan", f64::from(m.replan)) as i32).clamp(1, 48.min(m.horizon));
    m.soc_levels = (ms.get("soc_levels", f64::from(m.soc_levels)) as i32).clamp(3, 101);
    num!(ms, m.terminal_value, "terminal_value");
    flag!(ms, m.firm_commitment, "firm_commitment");
    num!(ms, m.voll, "voll");
    flag!(ms, m.reserve_energy, "reserve_energy");

    let (e, es) = (&mut p.econ, v.at("econ"));
    text!(es, e.currency, "currency");
    int!(es, e.lifetime, "lifetime");
    num!(es, e.discount_rate, "discount_rate");
    num!(es, e.om_escalation, "om_escalation");
    num!(es, e.fuel_price, "fuel_price");
    num!(es, e.fuel_escalation, "fuel_escalation");
    num!(es, e.pv_capex_kwp, "pv_capex_kwp");
    num!(es, e.pv_om_kwp, "pv_om_kwp");
    num!(es, e.pv_life, "pv_life");
    int!(es, e.inverter_replacement_year, "inverter_replacement_year");
    num!(es, e.inverter_replacement_kwac, "inverter_replacement_kwac");
    num!(es, e.bess_capex_kwh, "bess_capex_kwh");
    num!(es, e.bess_capex_kw, "bess_capex_kw");
    num!(es, e.bess_om_kwh, "bess_om_kwh");
    num!(es, e.bess_replace_kwh, "bess_replace_kwh");
    num!(es, e.bess_cost_decline, "bess_cost_decline");
    num!(es, e.diesel_capex_kw, "diesel_capex_kw");
    num!(es, e.diesel_om_kwh, "diesel_om_kwh");
    num!(es, e.diesel_om_unit_hour, "diesel_om_unit_hour");
    num!(es, e.co2_kg_per_l, "co2_kg_per_l");
    num!(es, e.carbon_price_t, "carbon_price_t");
    num!(es, e.nox_g_per_l, "nox_g_per_l");
    num!(es, e.sox_g_per_l, "sox_g_per_l");
    num!(es, e.wind_capex_kw, "wind_capex_kw");
    num!(es, e.wind_om_kw, "wind_om_kw");
    num!(es, e.wind_life, "wind_life");
    num!(es, e.jobs_pv_per_mw, "jobs_pv_per_mw");
    num!(es, e.jobs_wind_per_mw, "jobs_wind_per_mw");
    num!(es, e.jobs_bess_per_mwh, "jobs_bess_per_mwh");
    num!(es, e.population, "population");
    num!(es, e.other_capex_frac, "other_capex_frac");

    let (a, asv) = (&mut p.aux, v.at("aux"));
    num!(asv, a.bess_kw_per_mwh, "bess_kw_per_mwh");
    num!(asv, a.bess_temp_coeff, "bess_temp_coeff");
    num!(asv, a.ref_c, "ref_c");
    num!(asv, a.plant_kw, "plant_kw");
    num!(asv, a.trafo_noload_kw, "trafo_noload_kw");
    num!(asv, a.bess_trafo_noload_kw, "bess_trafo_noload_kw");
    num!(asv, a.pcs_kw_per_mw, "pcs_kw_per_mw");

    p.sim.all_years = v.at("sim").getb("all_years", p.sim.all_years);
    p
}
