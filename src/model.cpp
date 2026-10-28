#include "model.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace {

std::vector<double> to_8760(std::vector<double> v) {
    // Accept 8760 (hourly), 17520 (half-hourly: average pairs) and 35040 (quarter-hourly: average fours), and the same in a
    // leap year (8784, 17568, 35136: drop Feb 29 first), as to8760 in web/js/util.js.
    for (int k : {1, 2, 4}) {
        const size_t day = size_t(24 * k);
        if (v.size() == (365 + 1) * day) v.erase(v.begin() + 59 * day, v.begin() + 60 * day);
        if (v.size() != HOURS * size_t(k) || k == 1) continue;
        for (int i = 0; i < HOURS; ++i) {
            double s = 0;
            for (int j = 0; j < k; ++j) s += v[size_t(k * i + j)];
            v[i] = s / k;
        }
        v.resize(HOURS);
    }
    return v;
}

} // namespace

Weather parse_weather(const json::Value& W) {
    Weather wx;
    wx.is_utc = W.getb("is_utc", true);
    wx.time_offset = W.get("time_offset", 0.5);
    wx.ghi = to_8760(W.getv("ghi"));
    wx.dni = to_8760(W.getv("dni"));
    wx.dhi = to_8760(W.getv("dhi"));
    wx.tamb = to_8760(W.getv("tamb"));
    wx.wind = to_8760(W.getv("wind"));
    return wx;
}

Project parse_project(const json::Value& v) {
    Project p;
    p.name = v.gets("name", "Untitled");

    const auto& L = v["location"];
    p.loc.lat = L.get("lat", 0);
    p.loc.lon = L.get("lon", 0);
    p.loc.utc_offset = L.has("utc_offset") ? L.get("utc_offset", 0) : std::round(p.loc.lon / 15.0);

    p.wx = parse_weather(v["weather"]);

    p.load_kw = to_8760(v["load"].getv("kw"));
    p.sim.load_growth = v["load"].get("growth", 0.0);

    const auto& P = v["pv"];
    PVParams& pv = p.pv;
    pv.capacity_kwp = P.get("capacity_kwp", pv.capacity_kwp);
    pv.module_eff = P.get("module_eff", pv.module_eff);
    pv.gamma_pmax = P.get("gamma_pmax", pv.gamma_pmax);
    pv.low_irr_loss_200 = P.get("low_irr_loss_200", pv.low_irr_loss_200);
    pv.mount = P.gets("mount", pv.mount);
    pv.tilt = P.get("tilt", pv.tilt);
    pv.azimuth_auto = P.getb("azimuth_auto", pv.azimuth_auto);
    pv.azimuth = P.get("azimuth", pv.azimuth);
    if (pv.azimuth_auto) pv.azimuth = p.loc.lat >= 0 ? 180.0 : 0.0;
    pv.gcr = P.get("gcr", pv.gcr);
    pv.tracker_axis_azimuth = P.get("tracker_axis_azimuth", pv.tracker_axis_azimuth);
    pv.tracker_max_angle = P.get("tracker_max_angle", pv.tracker_max_angle);
    pv.backtracking = P.getb("backtracking", pv.backtracking);
    pv.row_shading = P.getb("row_shading", pv.row_shading);
    pv.albedo = P.get("albedo", pv.albedo);
    pv.iam_b0 = P.get("iam_b0", pv.iam_b0);
    pv.soiling = P.get("soiling", pv.soiling);
    pv.thermal_model = P.gets("thermal_model", pv.thermal_model);
    pv.noct = P.get("noct", pv.noct);
    pv.uc = P.get("uc", pv.uc);
    pv.uv = P.get("uv", pv.uv);
    pv.absorptance = P.get("absorptance", pv.absorptance);
    pv.mismatch = P.get("mismatch", pv.mismatch);
    pv.dc_wiring = P.get("dc_wiring", pv.dc_wiring);
    pv.dc_wiring_basis = P.gets("dc_wiring_basis", pv.dc_wiring_basis);
    pv.lid = P.get("lid", pv.lid);
    pv.module_quality = P.get("module_quality", pv.module_quality);
    pv.dc_ac_ratio = P.get("dc_ac_ratio", pv.dc_ac_ratio);
    pv.inverter_eff = P.get("inverter_eff", pv.inverter_eff);
    pv.ac_losses = P.get("ac_losses", pv.ac_losses);
    pv.availability = P.get("availability", pv.availability);
    pv.degradation = P.get("degradation", pv.degradation);

    const auto& B = v["bess"];
    BessParams& b = p.bess;
    b.energy_kwh = B.get("energy_kwh", b.energy_kwh);
    b.power_kw = B.get("power_kw", b.power_kw);
    b.rte = B.get("rte", b.rte);
    b.soc_min = B.get("soc_min", b.soc_min);
    b.soc_max = B.get("soc_max", b.soc_max);
    b.soc_init = B.get("soc_init", b.soc_init);
    b.calendar_fade = B.get("calendar_fade", b.calendar_fade);
    b.cycle_life = B.get("cycle_life", b.cycle_life);
    b.cycle_life_dod = B.get("cycle_life_dod", b.cycle_life_dod);
    b.eol_soh = B.get("eol_soh", b.eol_soh);
    b.replace_soh = B.get("replace_soh", b.replace_soh);   // null (blank in the GUI) keeps the default
    b.soh_init = B.get("soh_init", b.soh_init);
    b.warranty_efc_yr = B.get("warranty_efc_yr", b.warranty_efc_yr);
    b.provides_reserve = B.getb("provides_reserve", b.provides_reserve);
    b.reserve_duration_h = B.get("reserve_duration_h", b.reserve_duration_h);
    b.self_discharge = B.get("self_discharge", b.self_discharge);

    const auto& Wd = v["wind"];
    WindParams& w = p.wind;
    w.units = int(Wd.get("units", w.units));
    w.rated_kw = Wd.get("rated_kw", w.rated_kw);
    w.v_in = Wd.get("v_in", w.v_in);
    w.v_rated = Wd.get("v_rated", w.v_rated);
    w.v_out = Wd.get("v_out", w.v_out);
    w.hub_height = Wd.get("hub_height", w.hub_height);
    w.ref_height = Wd.get("ref_height", w.ref_height);
    w.shear_alpha = Wd.get("shear_alpha", w.shear_alpha);
    w.curve = Wd.gets("curve", w.curve);
    w.losses = Wd.get("losses", w.losses);
    w.availability = Wd.get("availability", w.availability);

    const auto& D = v["diesel"];
    DieselParams& d = p.dg;
    d.unit_kw = D.get("unit_kw", d.unit_kw);
    d.units = int(D.get("units", d.units));
    d.min_load = D.get("min_load", d.min_load);
    d.min_units_online = int(D.get("min_units_online", d.min_units_online));
    d.reserve_load = D.get("reserve_load", d.reserve_load);
    d.reserve_pv = D.get("reserve_pv", d.reserve_pv);
    d.strategy = D.gets("strategy", d.strategy);
    d.cc_setpoint = D.get("cc_setpoint", d.cc_setpoint);
    d.fuel_model = D.gets("fuel_model", d.fuel_model);
    d.fuel_intercept = D.get("fuel_intercept", d.fuel_intercept);
    d.fuel_slope = D.get("fuel_slope", d.fuel_slope);
    if (D["fuel_curve"].is_array() && D["fuel_curve"].size() >= 2) {
        d.fuel_curve.clear();
        for (const auto& pt : D["fuel_curve"].arr())
            if (pt.size() >= 2 && pt[0].num() > 0 && pt[1].num() > 0) d.fuel_curve.emplace_back(pt[0].num(), pt[1].num());
    }

    const auto& M = v["ems"];
    EmsParams& m = p.ems;
    m.pv_forecast = M.gets("pv_forecast", m.pv_forecast);
    m.load_forecast = M.gets("load_forecast", m.load_forecast);
    m.noise_sigma = M.get("noise_sigma", m.noise_sigma);
    m.horizon = std::clamp(int(M.get("horizon", m.horizon)), 1, 168);
    m.replan = std::clamp(int(M.get("replan", m.replan)), 1, std::min(48, m.horizon));
    m.soc_levels = std::clamp(int(M.get("soc_levels", m.soc_levels)), 3, 101);
    m.terminal_value = M.get("terminal_value", m.terminal_value);
    m.firm_commitment = M.getb("firm_commitment", m.firm_commitment);
    m.voll = M.get("voll", m.voll);

    const auto& E = v["econ"];
    EconParams& e = p.econ;
    e.currency = E.gets("currency", e.currency);
    e.lifetime = int(E.get("lifetime", e.lifetime));
    e.discount_rate = E.get("discount_rate", e.discount_rate);
    e.om_escalation = E.get("om_escalation", e.om_escalation);
    e.fuel_price = E.get("fuel_price", e.fuel_price);
    e.fuel_escalation = E.get("fuel_escalation", e.fuel_escalation);
    e.pv_capex_kwp = E.get("pv_capex_kwp", e.pv_capex_kwp);
    e.pv_om_kwp = E.get("pv_om_kwp", e.pv_om_kwp);
    e.pv_life = E.get("pv_life", e.pv_life);
    e.inverter_replacement_year = int(E.get("inverter_replacement_year", e.inverter_replacement_year));
    e.inverter_replacement_kwac = E.get("inverter_replacement_kwac", e.inverter_replacement_kwac);
    e.bess_capex_kwh = E.get("bess_capex_kwh", e.bess_capex_kwh);
    e.bess_capex_kw = E.get("bess_capex_kw", e.bess_capex_kw);
    e.bess_om_kwh = E.get("bess_om_kwh", e.bess_om_kwh);
    e.bess_replace_kwh = E.get("bess_replace_kwh", e.bess_replace_kwh);
    e.bess_cost_decline = E.get("bess_cost_decline", e.bess_cost_decline);
    e.diesel_capex_kw = E.get("diesel_capex_kw", e.diesel_capex_kw);
    e.diesel_om_kwh = E.get("diesel_om_kwh", e.diesel_om_kwh);
    e.diesel_om_unit_hour = E.get("diesel_om_unit_hour", e.diesel_om_unit_hour);
    e.co2_kg_per_l = E.get("co2_kg_per_l", e.co2_kg_per_l);
    e.carbon_price_t = E.get("carbon_price_t", e.carbon_price_t);
    e.nox_g_per_l = E.get("nox_g_per_l", e.nox_g_per_l);
    e.sox_g_per_l = E.get("sox_g_per_l", e.sox_g_per_l);
    e.wind_capex_kw = E.get("wind_capex_kw", e.wind_capex_kw);
    e.wind_om_kw = E.get("wind_om_kw", e.wind_om_kw);
    e.wind_life = E.get("wind_life", e.wind_life);
    e.jobs_pv_per_mw = E.get("jobs_pv_per_mw", e.jobs_pv_per_mw);
    e.jobs_wind_per_mw = E.get("jobs_wind_per_mw", e.jobs_wind_per_mw);
    e.jobs_bess_per_mwh = E.get("jobs_bess_per_mwh", e.jobs_bess_per_mwh);
    e.population = E.get("population", e.population);
    e.other_capex_frac = E.get("other_capex_frac", e.other_capex_frac);

    const auto& A = v["aux"];
    AuxParams& a = p.aux;
    a.bess_kw_per_mwh = A.get("bess_kw_per_mwh", a.bess_kw_per_mwh);
    a.bess_temp_coeff = A.get("bess_temp_coeff", a.bess_temp_coeff);
    a.ref_c = A.get("ref_c", a.ref_c);
    a.plant_kw = A.get("plant_kw", a.plant_kw);
    a.trafo_noload_kw = A.get("trafo_noload_kw", a.trafo_noload_kw);
    a.bess_trafo_noload_kw = A.get("bess_trafo_noload_kw", a.bess_trafo_noload_kw);
    a.pcs_kw_per_mw = A.get("pcs_kw_per_mw", a.pcs_kw_per_mw);

    const auto& S = v["sim"];
    p.sim.all_years = S.getb("all_years", p.sim.all_years);
    return p;
}

void validate_project(const Project& p) {
    auto need = [](bool ok, const std::string& msg) { if (!ok) throw std::runtime_error(msg); };
    need(std::fabs(p.loc.lat) <= 90 && std::fabs(p.loc.lon) <= 180, "Location latitude/longitude out of range.");
    need(std::fabs(p.loc.utc_offset) <= 14, "UTC offset must be between -14 h and +14 h.");
    need(p.wx.ghi.size() == HOURS, "Weather data missing: fetch irradiance (PVGIS / NASA POWER) or upload an 8760-hour CSV.");
    need(p.wx.tamb.size() == HOURS, "Weather data is missing ambient temperature.");
    need(p.load_kw.size() == HOURS, "Load profile must have 8760 hourly values (8784 for a leap year, 17520 half-hourly, 35040 quarter-hourly). Got " +
                                        std::to_string(p.load_kw.size()) + ".");
    need(std::all_of(p.load_kw.begin(), p.load_kw.end(), [](double x) { return std::isfinite(x) && x >= 0; }),
         "Load profile contains negative or invalid values.");
    need(p.pv.capacity_kwp >= 0 && p.pv.dc_ac_ratio > 0.3, "PV capacity must be non-negative and the DC/AC ratio above 0.3.");
    need(p.bess.energy_kwh >= 0 && p.bess.power_kw >= 0, "Battery size must be non-negative.");
    need(p.bess.rte > 0.3 && p.bess.rte <= 1.0, "Battery round-trip efficiency must be above 30 % and at most 100 %.");
    need(p.bess.soc_min >= 0 && p.bess.soc_max <= 1 && p.bess.soc_min < p.bess.soc_max,
         "Battery SOC limits must lie within 0-100 % with the minimum below the maximum.");
    need(p.bess.eol_soh < 1, "Battery end-of-life state of health must be below 100 %.");
    need(p.bess.cycle_life_dod > 0 && p.bess.cycle_life_dod <= 1, "Depth of discharge of the battery cycle life must be above 0 % and at most 100 %.");
    need(p.bess.replace_soh < 0 || (p.bess.replace_soh > 0 && p.bess.replace_soh < 1),
         "Battery replacement state of health must be above 0 % and below 100 % (leave it blank for the end-of-life value).");
    need(p.bess.soh_init > 0 && p.bess.soh_init <= 1, "Battery initial state of health must be above 0 % and at most 100 %.");
    need(p.bess.warranty_efc_yr >= 0, "Battery warranty cycles per year must be non-negative.");
    need(p.bess.reserve_duration_h > 0, "Battery reserve duration must be above 0 h.");
    need(p.dg.unit_kw > 0 && p.dg.units >= 0, "Genset unit rating must be above 0 kW and the number of units non-negative.");
    need(p.dg.min_load >= 0 && p.dg.min_load < 1, "Genset minimum loading must be at least 0 % and below 100 %.");
    need(p.dg.fuel_model == "linear" || p.dg.fuel_curve.size() >= 2, "Fuel curve needs at least 2 points.");
    need(p.wind.units >= 0, "Number of wind turbines must be non-negative.");
    need(p.wind.v_in < p.wind.v_rated && p.wind.v_rated < p.wind.v_out, "Wind turbine speeds must satisfy cut-in < rated < cut-out.");
    need(p.bess.self_discharge >= 0 && p.bess.self_discharge < 0.1, "Battery self-discharge must be 0-10 % per hour.");
    need(p.econ.lifetime >= 1 && p.econ.lifetime <= 60, "Project lifetime must be 1-60 years.");
    need(p.aux.bess_kw_per_mwh >= 0 && p.aux.bess_temp_coeff >= 0 && p.aux.plant_kw >= 0 && p.aux.trafo_noload_kw >= 0 &&
             p.aux.bess_trafo_noload_kw >= 0 && p.aux.pcs_kw_per_mw >= 0 && std::isfinite(p.aux.ref_c),
         "Auxiliary loads and the temperature coefficient must be non-negative.");
}
