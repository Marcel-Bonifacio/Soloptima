use super::{clamp, mn, mx, Comparison, SimResult, Sizing};
use crate::finance::{irr, payback};
use crate::Project;

/// `soh` is the battery's state of health at the end of life.
pub(super) fn economics(p: &Project, s: &Sizing, soh: f64, r: &mut SimResult) {
    let (ec, bp, dg) = (&p.econ, &p.bess, &p.dg);
    let has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    let has_wind = s.wind_units > 0.5;
    let n_life = ec.lifetime;
    let soh_repl = if bp.replace_soh >= 0.0 { bp.replace_soh } else { bp.eol_soh };
    let e = &mut r.econ;
    let inv_kwac = s.pv_kwp / p.pv.dc_ac_ratio;
    e.capex_pv = s.pv_kwp * ec.pv_capex_kwp;
    e.capex_bess = if has_bess { s.bess_kwh * ec.bess_capex_kwh + s.bess_kw * ec.bess_capex_kw } else { 0.0 };
    let wind_kw = if has_wind { s.wind_units * p.wind.rated_kw } else { 0.0 };
    e.capex_wind = wind_kw * ec.wind_capex_kw;
    e.capex_diesel = ec.diesel_capex_kw * dg.unit_kw * f64::from(dg.units);
    e.capex_other = (e.capex_pv + e.capex_bess + e.capex_wind) * ec.other_capex_frac;
    e.capex_total = e.capex_pv + e.capex_bess + e.capex_wind + e.capex_diesel + e.capex_other;

    let d = ec.discount_rate;
    let (mut npc, mut disc_energy) = (e.capex_total, 0.0);
    let mut last_bess_cost = e.capex_bess;
    let mut soh0 = bp.soh_init;   // SOH the battery in service was installed at
    for y in r.years.iter_mut() {
        let yr = y.year;
        let esc_f = (1.0 + ec.fuel_escalation).powf(f64::from(yr - 1));
        let esc_o = (1.0 + ec.om_escalation).powf(f64::from(yr - 1));
        y.c_fuel = y.fuel_l * ec.fuel_price * esc_f;
        y.c_om_new = (s.pv_kwp * ec.pv_om_kwp + wind_kw * ec.wind_om_kw + (if has_bess { s.bess_kwh * ec.bess_om_kwh } else { 0.0 })) * esc_o;
        y.c_om_dg = (y.gen_kwh * ec.diesel_om_kwh + y.unit_hours * ec.diesel_om_unit_hour) * esc_o;
        y.c_om = y.c_om_new + y.c_om_dg;
        y.c_carbon = y.co2_t * ec.carbon_price_t;
        if yr == ec.inverter_replacement_year && s.pv_kwp > 0.0 && yr < n_life { y.c_replace += inv_kwac * ec.inverter_replacement_kwac; }
        if has_wind && ec.wind_life >= 1.0 && yr % (ec.wind_life as i32) == 0 && yr < n_life { y.c_replace += e.capex_wind; }
        if y.bess_replaced {
            let cost = s.bess_kwh * ec.bess_replace_kwh * (1.0 - ec.bess_cost_decline).powf(f64::from(yr));
            y.c_replace += cost;
            last_bess_cost = cost;
            soh0 = 1.0;
            r.bess_replacements += 1;
        }
        if yr == n_life {
            // Linear salvage of remaining life: battery by state of health above the replacement threshold (against the SOH it
            // was installed at), PV and wind by calendar life.
            if has_bess && soh0 > soh_repl { y.c_salvage -= last_bess_cost * clamp((soh - soh_repl) / (soh0 - soh_repl), 0.0, 1.0); }
            if ec.pv_life > f64::from(n_life) { y.c_salvage -= e.capex_pv * (ec.pv_life - f64::from(n_life)) / ec.pv_life; }
            if has_wind && ec.wind_life >= 1.0 {
                let used = f64::from(n_life) % ec.wind_life;
                if used > 0.0 { y.c_salvage -= e.capex_wind * (ec.wind_life - used) / ec.wind_life; }
            }
        }
        y.c_total = y.c_fuel + y.c_om + y.c_carbon + y.c_replace + y.c_salvage;
        let df = (1.0 + d).powf(f64::from(yr));
        npc += y.c_total / df;
        disc_energy += y.served_site / df;
    }
    e.npc = npc;
    e.lcoe = if disc_energy > 0.0 { npc / disc_energy } else { 0.0 };
    // Annualised view used in the sizing literature: TAC = NPC x CRF(i, N), COE = TAC / annual energy served to the site.
    let nf = f64::from(n_life);
    e.crf = if d > 0.0 { d * (1.0 + d).powf(nf) / ((1.0 + d).powf(nf) - 1.0) } else { 1.0 / nf };
    e.tac = npc * e.crf;
    let y1 = &r.years[0];
    e.coe = if y1.served_site > 0.0 { e.tac / y1.served_site } else { 0.0 };

    r.re_fraction = y1.re_fraction;
    r.unmet_fraction = if y1.load > 0.0 { y1.unmet / y1.load } else { 0.0 };
    for y in &r.years { if y.load > 0.0 { r.unmet_fraction_max = mx(r.unmet_fraction_max, y.unmet / y.load); } }
    r.curtail_fraction = if y1.re_avail > 0.0 { (y1.pv_curtailed + y1.wind_curtailed) / y1.re_avail } else { 0.0 };
    let m = &mut r.metrics;
    m.lpsp = r.unmet_fraction;                                                 // loss of power supply probability (energy basis)
    m.ssci = if y1.re_avail > 0.0 { y1.re_direct / y1.re_avail } else { 0.0 };   // self-sufficiency (consumption) index
    m.sssi = if y1.load > 0.0 { y1.re_direct / y1.load } else { 0.0 };          // self-sufficiency (supply) index
    m.rep = 100.0 * (1.0 - m.lpsp);                                            // reliability (%)
    m.excess_kwh = y1.pv_curtailed + y1.wind_curtailed + y1.gen_dump;
    m.excess_fraction = if y1.load > 0.0 { m.excess_kwh / y1.load } else { 0.0 };
    m.co2_t = y1.co2_t;
    m.nox_kg = y1.nox_t * 1000.0;
    m.sox_kg = y1.sox_t * 1000.0;
    m.jobs = ec.jobs_pv_per_mw * s.pv_kwp / 1000.0 + ec.jobs_wind_per_mw * wind_kw / 1000.0 + ec.jobs_bess_per_mwh * s.bess_kwh / 1000.0;
    if ec.population > 0.0 {
        // HDI vs per-capita electricity (Dufo-Lopez 2016 form used by Abdoulaye et al.): energy in kWh per person per year
        let e_pc = (y1.served_site + mn(m.excess_kwh, 0.75 * y1.served_site)) / ec.population;
        m.hdi = if e_pc > 0.0 { 0.0978 * e_pc.ln() - 0.0319 } else { 0.0 };
    }
    r.fuel_l_y1 = y1.fuel_l;
    r.avg_gen_load = if y1.unit_hours > 0.0 { y1.gen_kwh / (y1.unit_hours * dg.unit_kw) } else { 0.0 };
}

/// The hybrid `h` against the reference `b` (diesel only, or PV only for the battery's own value)
pub fn compare(h: &SimResult, b: &SimResult) -> Comparison {
    // Incremental cash flow of investing in the hybrid instead of the reference system.
    let mut cf = vec![0.0; h.years.len() + 1];
    cf[0] = -(h.econ.capex_total - b.econ.capex_total);
    for i in 0..h.years.len() { cf[i + 1] = b.years[i].c_total - h.years[i].c_total; }
    Comparison {
        lcoe_base: b.econ.lcoe,
        npv_savings: b.econ.npc - h.econ.npc,
        fuel_saved_l_y1: b.fuel_l_y1 - h.fuel_l_y1,
        co2_saved_t_y1: b.years[0].co2_t - h.years[0].co2_t,
        payback_years: payback(&cf),
        irr: if cf[0] < 0.0 { irr(&cf) } else { None },
    }
}
