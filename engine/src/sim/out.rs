//! A simulation and a comparison as JSON, key for key as src/sim.cpp writes them
use super::{Comparison, SimResult};
use crate::Value;

fn obj(kv: Vec<(&str, Value)>) -> Value {
    let mut o = Value::object();
    for (k, v) in kv { o.set(k, v); }
    o
}

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
    let years: Vec<Value> = r.years.iter().map(|y| obj(vec![
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
    o.set("years", years);
    if let (true, Some(h)) = (include_hourly, &r.hourly) {
        let v = |x: &Vec<f64>| Value::from(x.clone());
        o.set("hourly", obj(vec![
            ("load", v(&h.load)), ("aux", v(&h.aux)), ("pv_avail", v(&h.pv_avail)), ("pv_to_load", v(&h.pv_to_load)),
            ("pv_to_bess", v(&h.pv_to_bess)), ("pv_curtailed", v(&h.pv_curtailed)), ("bess_dis", v(&h.bess_dis)),
            ("gen_to_bess", v(&h.gen_to_bess)), ("gen_to_load", v(&h.gen_to_load)), ("gen_dump", v(&h.gen_dump)),
            ("gen_units", v(&h.gen_units)), ("fuel_l", v(&h.fuel_l)), ("unmet", v(&h.unmet)), ("soc", v(&h.soc)),
            ("soc_target", v(&h.soc_target)), ("wind_avail", v(&h.wind_avail)), ("wind_to_load", v(&h.wind_to_load)),
            ("wind_to_bess", v(&h.wind_to_bess)), ("wind_curtailed", v(&h.wind_curtailed)), ("pv_fc_h1", v(&h.pv_fc_h1)),
            ("load_fc_h1", v(&h.load_fc_h1)), ("pv_fc_da", v(&h.pv_fc_da)), ("load_fc_da", v(&h.load_fc_da)),
        ]));
    }
    let f = &r.fc;
    o.set("forecast", obj(vec![
        ("pv_nmae_h1", f.pv_nmae_h1.into()), ("pv_nmae_da", f.pv_nmae_da.into()), ("load_nmae_h1", f.load_nmae_h1.into()),
        ("load_nmae_da", f.load_nmae_da.into()), ("pv_bias_da", f.pv_bias_da.into()), ("load_bias_da", f.load_bias_da.into()),
        ("net_error_kwh", f.net_error_kwh.into()), ("bess_compensation_kwh", f.bess_compensation_kwh.into()), ("plans", f.plans.into()),
    ]));
    o
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
