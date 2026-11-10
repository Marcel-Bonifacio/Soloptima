//! A simulation and a comparison as JSON, key for key as src/sim.cpp writes them
use super::{Comparison, Hourly, SimResult, YearResult};
use crate::json::obj;
use crate::Value;

fn opt(x: Option<f64>) -> Value { x.map_or(Value::Null, Value::Num) }

pub fn result_to_json(r: &SimResult, include_hourly: bool) -> Value {
    let mut o = Value::object();
    let s = &r.size;
    o.set("size", obj(vec![("pv_kwp", s.pv_kwp.into()), ("bess_kwh", s.bess_kwh.into()), ("bess_kw", s.bess_kw.into()), ("wind_units", s.wind_units.into())]));
    let mt = &r.metrics;
    o.set("metrics", obj(vec![
        ("lpsp", mt.lpsp.into()), ("ssci", mt.ssci.into()), ("sssi", mt.sssi.into()), ("rep", mt.rep.into()), ("excess_kwh", mt.excess_kwh.into()),
        ("excess_fraction", mt.excess_fraction.into()), ("co2_t", mt.co2_t.into()), ("nox_kg", mt.nox_kg.into()), ("sox_kg", mt.sox_kg.into()),
        ("jobs", mt.jobs.into()), ("hdi", opt(if mt.hdi >= 0.0 { Some(mt.hdi) } else { None })),
    ]));
    o.set("re_fraction", r.re_fraction);
    o.set("unmet_fraction", r.unmet_fraction);
    o.set("unmet_fraction_max", r.unmet_fraction_max);
    o.set("curtail_fraction", r.curtail_fraction);
    o.set("fuel_l_y1", r.fuel_l_y1);
    o.set("avg_gen_load", r.avg_gen_load);
    o.set("bess_replacements", r.bess_replacements);
    let e = &r.econ;
    o.set("econ", obj(vec![
        ("capex_pv", e.capex_pv.into()), ("capex_bess", e.capex_bess.into()), ("capex_wind", e.capex_wind.into()), ("capex_diesel", e.capex_diesel.into()),
        ("crf", e.crf.into()), ("tac", e.tac.into()), ("coe", e.coe.into()), ("capex_other", e.capex_other.into()),
        ("capex_total", e.capex_total.into()), ("npc", e.npc.into()), ("lcoe", e.lcoe.into()),
    ]));
    let years: Vec<Value> = r.years.iter().map(|y| obj_with(extra(r, y), vec![
        ("year", y.year.into()), ("load", y.load.into()), ("served", y.served.into()), ("unmet", y.unmet.into()), ("aux", y.aux.into()),
        ("served_site", y.served_site.into()), ("pv_avail", y.pv_avail.into()), ("pv_to_load", y.pv_to_load.into()),
        ("pv_to_bess", y.pv_to_bess.into()), ("pv_curtailed", y.pv_curtailed.into()), ("bess_dis", y.bess_dis.into()),
        ("bess_ch", y.bess_ch.into()), ("bess_soh", y.bess_soh.into()), ("bess_efc", y.bess_efc.into()), ("bess_efc_dc", y.bess_efc_dc.into()),
        ("soh_loss_cal", y.soh_loss_cal.into()), ("soh_loss_cyc", y.soh_loss_cyc.into()), ("max_c_rate", y.max_c_rate.into()),
        ("bess_replaced", y.bess_replaced.into()), ("gen_kwh", y.gen_kwh.into()), ("gen_to_load", y.gen_to_load.into()),
        ("gen_to_bess", y.gen_to_bess.into()), ("gen_dump", y.gen_dump.into()), ("e_start", y.e_start.into()), ("e_end", y.e_end.into()),
        ("fuel_l", y.fuel_l.into()), ("unit_hours", y.unit_hours.into()), ("starts", y.starts.into()), ("max_unmet_kw", y.max_unmet_kw.into()),
        ("lol_h", y.lol_h.into()), ("lol_events", y.lol_events.into()), ("lol_max_h", y.lol_max_h.into()),
        ("reserve_short_h", y.reserve_short_h.into()), ("reserve_short_max_kw", y.reserve_short_max_kw.into()), ("max_units", y.max_units.into()),
        ("fleet_full_h", y.fleet_full_h.into()), ("minload_h", y.minload_h.into()), ("minload_run_max_h", y.minload_run_max_h.into()),
        ("max_starts_h", y.max_starts_h.into()), ("re_fraction", y.re_fraction.into()), ("co2_t", y.co2_t.into()), ("nox_t", y.nox_t.into()),
        ("sox_t", y.sox_t.into()), ("wind_avail", y.wind_avail.into()), ("wind_used", y.wind_used.into()), ("wind_to_load", y.wind_to_load.into()),
        ("wind_to_bess", y.wind_to_bess.into()), ("wind_curtailed", y.wind_curtailed.into()), ("self_discharge", y.self_discharge.into()),
        ("c_fuel", y.c_fuel.into()), ("c_om", y.c_om.into()), ("c_om_new", y.c_om_new.into()), ("c_om_dg", y.c_om_dg.into()),
        ("c_replace", y.c_replace.into()), ("c_carbon", y.c_carbon.into()), ("c_salvage", y.c_salvage.into()), ("c_total", y.c_total.into()),
    ])).collect();
    if r.has_grid { o.set("has_grid", true); }
    if !r.fleet.is_empty() {
        o.set("fleet", Value::Arr(r.fleet.iter().map(|&(i, n, kw, ml)| obj(vec![
            ("index", (i as f64).into()), ("units", n.into()), ("unit_kw", kw.into()), ("min_load", ml.into()),
        ])).collect()));
    }
    o.set("years", years);
    if let (true, Some(h)) = (include_hourly, &r.hourly) { o.set("hourly", series(h, r.has_grid, true)); }
    if r.step_min < 60 && r.step_min > 0 {
        o.set("step_min", r.step_min);
        if let (true, Some(h)) = (include_hourly, &r.steps) { o.set("steps", series(h, r.has_grid, false)); }
    }
    let f = &r.fc;
    o.set("forecast", obj(vec![
        ("pv_nmae_h1", f.pv_nmae_h1.into()), ("pv_nmae_da", f.pv_nmae_da.into()), ("load_nmae_h1", f.load_nmae_h1.into()),
        ("load_nmae_da", f.load_nmae_da.into()), ("pv_bias_da", f.pv_bias_da.into()), ("load_bias_da", f.load_bias_da.into()),
        ("net_error_kwh", f.net_error_kwh.into()), ("bess_compensation_kwh", f.bess_compensation_kwh.into()), ("plans", f.plans.into()),
    ]));
    o
}

/// The grid figures of a year (written only for a project with a grid connection)
fn grid_year(y: &YearResult) -> Vec<(&'static str, Value)> {
    vec![
        ("grid_import", y.grid_import.into()), ("grid_export", y.grid_export.into()), ("pv_to_grid", y.pv_to_grid.into()),
        ("wind_to_grid", y.wind_to_grid.into()), ("grid_up_h", y.grid_up_h.into()), ("grid_outages", y.grid_outages.into()),
        ("grid_peak_kw", y.grid_peak_kw.into()), ("c_grid_import", y.c_grid_import.into()), ("c_grid_demand", y.c_grid_demand.into()),
        ("c_grid_export", y.c_grid_export.into()), ("c_grid", y.c_grid.into()),
    ]
}

/// The year-1 series of every hour (or every step, without the forecasts)
fn series(h: &Hourly, grid: bool, forecasts: bool) -> Value {
    let v = |x: &Vec<f64>| Value::from(x.clone());
    let mut kv = vec![
        ("load", v(&h.load)), ("aux", v(&h.aux)), ("pv_avail", v(&h.pv_avail)), ("pv_to_load", v(&h.pv_to_load)),
        ("pv_to_bess", v(&h.pv_to_bess)), ("pv_curtailed", v(&h.pv_curtailed)), ("bess_dis", v(&h.bess_dis)),
        ("gen_to_bess", v(&h.gen_to_bess)), ("gen_to_load", v(&h.gen_to_load)), ("gen_dump", v(&h.gen_dump)),
        ("gen_units", v(&h.gen_units)), ("fuel_l", v(&h.fuel_l)), ("unmet", v(&h.unmet)), ("soc", v(&h.soc)),
        ("soc_target", v(&h.soc_target)), ("wind_avail", v(&h.wind_avail)), ("wind_to_load", v(&h.wind_to_load)),
        ("wind_to_bess", v(&h.wind_to_bess)), ("wind_curtailed", v(&h.wind_curtailed)),
    ];
    if forecasts {
        kv.extend([("pv_fc_h1", v(&h.pv_fc_h1)), ("load_fc_h1", v(&h.load_fc_h1)), ("pv_fc_da", v(&h.pv_fc_da)), ("load_fc_da", v(&h.load_fc_da))]);
    }
    if grid { kv.extend([("grid_import", v(&h.grid_import)), ("grid_export", v(&h.grid_export)), ("grid_up", v(&h.grid_up))]); }
    obj(kv)
}

/// The keys a year has only with a grid connection, a mixed fleet, genset ramps, forced outages or the N-1 check
fn extra(r: &SimResult, y: &YearResult) -> Option<Vec<(&'static str, Value)>> {
    let mut kv = if r.has_grid { grid_year(y) } else { vec![] };
    if r.ramps { kv.push(("ramp_limited_h", y.ramp_limited_h.into())); }
    if r.unit_outages { kv.extend([("unit_outages", y.unit_outages.into()), ("unit_outage_h", y.unit_outage_h.into())]); }
    if r.n1 { kv.extend([("n1_short_h", y.n1_short_h.into()), ("n1_short_max_kw", y.n1_short_max_kw.into())]); }
    if !y.groups.is_empty() {
        kv.push(("groups", Value::Arr(y.groups.iter().map(|g| obj(vec![
            ("index", (g.index as f64).into()), ("unit_hours", g.unit_hours.into()), ("gen_kwh", g.gen_kwh.into()), ("fuel_l", g.fuel_l.into()),
            ("starts", g.starts.into()), ("c_om", g.c_om.into()),
        ])).collect())));
    }
    (!kv.is_empty()).then_some(kv)
}

fn obj_with(extra: Option<Vec<(&'static str, Value)>>, mut kv: Vec<(&'static str, Value)>) -> Value {
    if let Some(x) = extra { kv.extend(x); }
    obj(kv)
}

pub fn comparison_to_json(c: &Comparison) -> Value {
    obj(vec![
        ("npv_savings", c.npv_savings.into()),
        ("irr", opt(c.irr)),
        ("payback_years", opt(if c.payback_years >= 0.0 { Some(c.payback_years) } else { None })),
        ("fuel_saved_l_y1", c.fuel_saved_l_y1.into()),
        ("co2_saved_t_y1", c.co2_saved_t_y1.into()),
        ("lcoe_base", c.lcoe_base.into()),
    ])
}
