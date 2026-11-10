//! The checks of src/model.cpp: `validate_project` refuses the same projects with the same messages as the C++ engine.
use crate::json::Error;
use crate::layout::{layout_used, validate_layout};
use crate::model::{Project, HOURS};

pub(crate) fn need(ok: bool, msg: &str) -> Result<(), Error> {
    if ok { Ok(()) } else { Err(Error(msg.to_string())) }
}


/// Twelve values (January first) each within [lo, hi], or none
fn months(v: &[f64], lo: f64, hi: f64) -> bool {
    v.is_empty() || (v.len() == 12 && v.iter().all(|&x| x >= lo && x <= hi))
}

pub fn validate_project(p: &Project) -> Result<(), Error> {
    need(p.loc.lat.abs() <= 90.0 && p.loc.lon.abs() <= 180.0, "Location latitude/longitude out of range.")?;
    need(p.loc.utc_offset.abs() <= 14.0, "UTC offset must be between -14 h and +14 h.")?;
    need(p.wx.ghi.len() == HOURS, "Weather data missing: fetch irradiance (PVGIS / NASA POWER) or upload an 8760-hour CSV.")?;
    need(p.wx.tamb.len() == HOURS, "Weather data is missing ambient temperature.")?;
    need(p.load_kw.len() == HOURS,
         &format!("Load profile must have 8760 hourly values (8784 for a leap year, 17520 half-hourly, 35040 quarter-hourly). Got {}.", p.load_kw.len()))?;
    need(p.load_kw.iter().all(|x| x.is_finite() && *x >= 0.0), "Load profile contains negative or invalid values.")?;
    let pv = &p.pv;
    need(pv.capacity_kwp >= 0.0 && pv.dc_ac_ratio > 0.3, "PV capacity must be non-negative and the DC/AC ratio above 0.3.")?;
    need(pv.transposition == "hay_davies" || pv.transposition == "perez", "Transposition model must be hay_davies or perez.")?;
    need(pv.bifaciality >= 0.0 && pv.bifaciality <= 1.0 && pv.rear_loss >= 0.0 && pv.rear_loss < 1.0,
         "Bifaciality must be 0-100 % and the rear-side loss at least 0 % and below 100 %.")?;
    need(!(pv.bifaciality > 0.0 || (pv.diffuse_shading && pv.row_shading))
             || (pv.gcr > 0.0 && pv.gcr < 1.0 && pv.row_width > 0.0 && pv.mount_height > 0.0 && pv.mount_height <= 50.0 && pv.row_width <= 100.0),
         "Diffuse row shading and bifacial modules need a ground coverage ratio between 0 and 1, a table width of up to 100 m and a mounting height above 0 and up to 50 m.")?;
    need(pv.soiling_monthly.is_empty() || (pv.soiling_monthly.len() == 12 && pv.soiling_monthly.iter().all(|&s| s >= 0.0 && s < 1.0)),
         "Monthly soiling needs 12 values (January to December), each at least 0 % and below 100 %.")?;
    need(months(&pv.albedo_monthly, 0.0, 1.0), "Monthly albedo needs 12 values (January to December), each from 0 to 1.")?;
    need(months(&pv.snow_monthly, 0.0, 1000.0) && months(&pv.snow_events, 0.0, 31.0) && pv.snow_events.len() == pv.snow_monthly.len()
             && pv.snow_rh > 0.0 && pv.snow_rh <= 1.0,
         "Monthly snow needs 12 snowfall values (cm) and 12 numbers of snow days (0-31), and a relative humidity above 0 % and at most 100 %.")?;
    need(["erbs", "disc", "boland"].contains(&pv.decomposition.as_str()), "Decomposition model must be erbs, disc or boland.")?;
    need(pv.clearsky == "haurwitz" || pv.clearsky == "ineichen", "Clear-sky model must be haurwitz or ineichen.")?;
    need(pv.linke_turbidity == 0.0 || (pv.linke_turbidity >= 1.0 && pv.linke_turbidity <= 10.0), "Linke turbidity must be 0 (estimated) or 1-10.")?;
    need(["ashrae", "martin_ruiz", "physical"].contains(&pv.iam_model.as_str()), "IAM model must be ashrae, martin_ruiz or physical.")?;
    need(pv.iam_ar > 0.0 && pv.iam_n > 1.0 && pv.iam_kl >= 0.0 && (pv.iam_n_ar == 0.0 || pv.iam_n_ar >= 1.0), "IAM parameters out of range.")?;
    need(["none", "monosi", "multisi", "cigs", "cdte", "asi"].contains(&pv.spectral.as_str()),
         "Spectral model must be none, monosi, multisi, cigs, cdte or asi.")?;
    need(pv.horizon.is_empty() || (pv.horizon.len() >= 4 && pv.horizon.len() <= 720 && pv.horizon.iter().all(|&h| h >= 0.0 && h < 90.0)),
         "Horizon needs 4 to 720 elevations from 0 to below 90 deg at equal azimuth steps from north, clockwise.")?;
    need(["auto", "apply", "data"].contains(&pv.horizon_beam.as_str()), "Horizon beam setting must be auto, apply or data.")?;
    if layout_used(p) { validate_layout(&p.layout)?; }
    need(pv.shade_model == "linear" || pv.shade_model == "blocks", "Row shading model must be linear or blocks.")?;
    need(pv.bypass_blocks >= 0 && pv.bypass_blocks <= 100, "Bypass-diode blocks must be 0 (from the layout) to 100.")?;
    need(pv.tracker_axis_tilt.abs() <= 45.0 && pv.tracker_cross_slope.abs() <= 30.0,
         "Tracker axis tilt must be within 45 deg and the ground slope across the rows within 30 deg.")?;
    need(pv.inverter_model == "constant"
             || (pv.inverter_model == "curve" && pv.inverter_eff > 0.5 && pv.inverter_eff < pv.inverter_eff_max && pv.inverter_eff_max <= 1.0),
         "Inverter curve needs a weighted efficiency above 50 % and below the peak efficiency, and a peak efficiency of at most 100 %.")?;
    need(pv.degradation_model == "compound" || pv.degradation_model == "linear", "Degradation model must be compound or linear.")?;
    need((0.0..1.0).contains(&pv.degradation), "Annual PV degradation must be at least 0 % and below 100 %.")?;
    need(pv.thermal_model == "noct" || (pv.uc > 0.0 && pv.uv >= 0.0), "Thermal loss factor Uc must be above 0 and Uv non-negative.")?;
    let b = &p.bess;
    need(b.energy_kwh >= 0.0 && b.power_kw >= 0.0, "Battery size must be non-negative.")?;
    need(b.rte > 0.3 && b.rte <= 1.0, "Battery round-trip efficiency must be above 30 % and at most 100 %.")?;
    need(b.soc_min >= 0.0 && b.soc_max <= 1.0 && b.soc_min < b.soc_max, "Battery SOC limits must lie within 0-100 % with the minimum below the maximum.")?;
    need(b.eol_soh < 1.0, "Battery end-of-life state of health must be below 100 %.")?;
    need(b.cycle_life_dod > 0.0 && b.cycle_life_dod <= 1.0, "Depth of discharge of the battery cycle life must be above 0 % and at most 100 %.")?;
    need(b.replace_soh < 0.0 || (b.replace_soh > 0.0 && b.replace_soh < 1.0),
         "Battery replacement state of health must be above 0 % and below 100 % (leave it blank for the end-of-life value).")?;
    need(b.soh_init > 0.0 && b.soh_init <= 1.0, "Battery initial state of health must be above 0 % and at most 100 %.")?;
    need(b.warranty_efc_yr >= 0.0, "Battery warranty cycles per year must be non-negative.")?;
    need(b.cycle_life > 0.0 && b.calendar_fade >= 0.0, "Battery cycle life must be above 0 and calendar fade non-negative.")?;
    need(b.reserve_duration_h > 0.0, "Battery reserve duration must be above 0 h.")?;
    let d = &p.dg;
    need(d.unit_kw > 0.0 && d.unit_kw.is_finite() && d.units >= 0, "Genset unit rating must be above 0 kW and the number of units non-negative.")?;
    need(p.sim.load_growth.is_finite() && p.sim.load_growth > -1.0 && p.sim.load_growth <= 1.0, "Annual load growth must be above -100 % and at most 100 %.")?;
    need(d.min_load >= 0.0 && d.min_load < 1.0, "Genset minimum loading must be at least 0 % and below 100 %.")?;
    need(d.fuel_model == "linear" || d.fuel_curve.len() >= 2, "Fuel curve needs at least 2 points.")?;
    need(d.fuel_model != "linear" || (d.fuel_intercept >= 0.0 && d.fuel_slope >= 0.0), "Linear fuel model intercept and slope must be non-negative.")?;
    need(d.more_groups.len() <= 8, "A mixed fleet has at most 9 genset groups (the main group and 8 more).")?;
    for (i, g) in d.more_groups.iter().enumerate() {
        let n = if g.name.is_empty() { format!("Genset group {}", i + 2) } else { format!("Genset group {}", g.name.chars().take(40).collect::<String>()) };
        need(g.units >= 0 && g.units <= 1000 && g.unit_kw > 0.0 && g.unit_kw.is_finite(), &format!("{n}: the unit rating must be above 0 kW and the number of units 0 to 1000."))?;
        need(g.min_load >= 0.0 && g.min_load < 1.0, &format!("{n}: the minimum loading must be at least 0 % and below 100 %."))?;
        need(if g.fuel_model == "linear" { g.fuel_intercept >= 0.0 && g.fuel_slope >= 0.0 } else { g.fuel_curve.len() >= 2 },
             &format!("{n}: the fuel curve needs at least 2 points (or a linear model with a non-negative intercept and slope)."))?;
        need([g.capex_kw, g.om_kwh, g.om_unit_hour].iter().all(|c| c.is_none_or(|x| x.is_finite() && x >= 0.0)), &format!("{n}: costs must be non-negative."))?;
    }
    let g = &p.grid;
    if g.enabled {
        let fin = |x: f64| x.is_finite() && x >= 0.0;
        need(fin(g.import_kw) && fin(g.export_kw), "Grid import and export limits must be non-negative.")?;
        need(g.tariff == "flat" || g.tariff == "tou", "Grid tariff must be flat or tou.")?;
        need(g.import_price.is_finite() && g.export_price.is_finite() && fin(g.demand_charge) && fin(g.co2_kg_per_kwh),
             "Grid prices must be numbers, and the demand charge and the emission factor non-negative.")?;
        need(g.tariff != "tou" || ((g.tou.len() == 24 || g.tou.len() == 288) && g.tou.iter().all(|x| x.is_finite())),
             "A time-of-use grid tariff needs 24 prices (one per hour of the day) or 288 (24 for each month, January first).")?;
        need(g.escalation.is_finite() && g.escalation > -1.0 && g.escalation <= 1.0, "Grid price escalation must be above -100 % and at most 100 %.")?;
        need(["always", "pattern", "random"].contains(&g.availability.as_str()), "Grid availability must be always, pattern or random.")?;
        need(g.availability != "pattern" || ((g.pattern.len() == 24 || g.pattern.len() == HOURS) && g.pattern.iter().all(|x| x.is_finite())),
             "A grid outage pattern needs 24 values (hour of the day) or 8760, 1 for grid up and 0 for down.")?;
        need(g.availability != "random"
                 || (fin(g.outages_per_year) && g.outages_per_year <= 1000.0 && g.outage_hours >= 1.0 && g.outages_per_year * g.outage_hours < 0.9 * HOURS as f64),
             "Random grid outages need a count of 0 to 1000 per year and a mean length of at least 1 h, together below 90 % of the year.")?;
    }
    let sm = &p.sim;
    need([15, 30, 60].contains(&sm.step_min), "The dispatch time step must be 60, 30 or 15 minutes.")?;
    need(sm.subhourly == "hold" || sm.subhourly == "interpolate", "Hourly series in a shorter step must be held or interpolated.")?;
    need(p.load_sub.iter().all(|x| x.is_finite() && *x >= 0.0), "Load profile contains negative or invalid values.")?;
    need(d.ramp_pct_min.is_finite() && d.ramp_pct_min >= 0.0 && d.ramp_pct_min <= 100.0 && d.start_min >= 0.0 && d.start_min <= 60.0,
         "Genset ramp rate must be 0 to 100 % per minute and the start time 0 to 60 min.")?;
    need(d.outage_rate.is_finite() && d.outage_rate >= 0.0 && d.outage_rate <= 100.0 && d.repair_h.is_finite() && d.repair_h >= 0.25 && d.repair_h <= 8760.0,
         "Genset forced outages need 0 to 100 per unit and year and a mean repair time of 0.25 h to a year.")?;
    let w = &p.wind;
    need(w.units >= 0, "Number of wind turbines must be non-negative.")?;
    need(w.v_in < w.v_rated && w.v_rated < w.v_out, "Wind turbine speeds must satisfy cut-in < rated < cut-out.")?;
    need(b.self_discharge >= 0.0 && b.self_discharge < 0.1, "Battery self-discharge must be 0-10 % per hour.")?;
    need(p.econ.lifetime >= 1 && p.econ.lifetime <= 60, "Project lifetime must be 1-60 years.")?;
    need([p.econ.discount_rate, p.econ.fuel_escalation, p.econ.om_escalation].iter().all(|r| r.is_finite() && *r > -1.0 && *r <= 1.0),
         "Discount rate and escalations must be above -100 % and at most 100 %.")?;
    let a = &p.aux;
    need(a.bess_kw_per_mwh >= 0.0 && a.bess_temp_coeff >= 0.0 && a.plant_kw >= 0.0 && a.trafo_noload_kw >= 0.0 && a.bess_trafo_noload_kw >= 0.0
             && a.pcs_kw_per_mw >= 0.0 && a.ref_c.is_finite(),
         "Auxiliary loads and the temperature coefficient must be non-negative.")
}
