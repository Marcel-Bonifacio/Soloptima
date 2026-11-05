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

// The layout map's PV areas, tables and objects (polygons of lat/lon pairs) in metres east and north of the site, on the
// layout tool's projection. A tree is a centre and a crown diameter, kept as a 16-sided polygon.
SiteLayout parse_layout(const json::Value& Ly, const Location& loc) {
    SiteLayout s;
    const double ky = 110574.0, kx = 111320.0 * std::cos(loc.lat * 3.14159265358979323846 / 180.0);
    auto plan = [&](const json::Value& ll) { return PlanPoint{(ll[1].num(NAN) - loc.lon) * kx, (ll[0].num(NAN) - loc.lat) * ky}; };
    auto ring = [&](const json::Value& lls) {
        std::vector<PlanPoint> v;
        for (const json::Value& ll : lls.arr()) v.push_back(plan(ll));
        return v;
    };
    for (const json::Value& g : Ly["polygons"].arr()) {
        const std::string type = g.gets("type", "");
        if (type == "site") {
            LayoutArea a;
            a.pts = ring(g["latlngs"]);
            a.base = g.get("base", 0);
            a.tilt = g.get("tilt", NAN);
            a.azimuth = g.get("azimuth", NAN);
            a.east_west = g.getb("east_west", false);
            s.areas.push_back(std::move(a));
        } else if (type == "obstacle") {
            Obstacle o;
            o.height = g.get("height", NAN);
            if (g.has("center")) {
                const PlanPoint c = plan(g["center"]);
                const double r = g.get("diameter", NAN) / 2;
                if (r > 0)
                    for (int k = 0; k < 16; ++k) {
                        const double a = k * 3.14159265358979323846 / 8;
                        o.pts.push_back({c[0] + r * std::sin(a), c[1] + r * std::cos(a)});
                    }
            } else o.pts = ring(g["latlngs"]);
            s.obstacles.push_back(std::move(o));
        }
    }
    for (const json::Value& t : Ly["result"]["tables"].arr()) {
        std::array<PlanPoint, 4> c;
        for (size_t k = 0; k < 4; ++k) c[k] = plan(t[k]);
        s.tables.push_back(c);
    }
    for (const json::Value& a : Ly["result"]["table_area"].arr()) s.table_area.push_back(int(std::clamp(a.num(-2), -2.0, 1e6)));
    return s;
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
    wx.snow = to_8760(W.getv("snow"));
    wx.horizon_in_beam = W.getb("horizon_in_beam", W.gets("source", "").rfind("PVGIS", 0) == 0);
    return wx;
}

Project parse_project(const json::Value& v) {
    Project p;
    p.name = v.gets("name", "Untitled");

    const auto& L = v["location"];
    p.loc.lat = L.get("lat", 0);
    p.loc.lon = L.get("lon", 0);
    p.loc.utc_offset = L.has("utc_offset") ? L.get("utc_offset", 0) : std::round(p.loc.lon / 15.0);
    p.loc.elevation = L.get("elevation", v["weather"].get("elevation", 0));

    p.wx = parse_weather(v["weather"]);
    p.layout = parse_layout(v["layout"], p.loc);

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
    pv.tracker_axis_tilt = P.get("tracker_axis_tilt", pv.tracker_axis_tilt);
    pv.tracker_cross_slope = P.get("tracker_cross_slope", pv.tracker_cross_slope);
    pv.tracker_max_angle = P.get("tracker_max_angle", pv.tracker_max_angle);
    pv.backtracking = P.getb("backtracking", pv.backtracking);
    pv.row_shading = P.getb("row_shading", pv.row_shading);
    pv.shade_model = P.gets("shade_model", pv.shade_model);
    pv.bypass_blocks = int(P.get("bypass_blocks", pv.bypass_blocks));
    pv.diffuse_shading = P.getb("diffuse_shading", pv.diffuse_shading);
    pv.mount_height = P.get("mount_height", pv.mount_height);
    // Slant width of a table from the layout (modules across the table times the module side up the slope), unless given
    const auto& Ly = v["layout"];
    pv.portrait = Ly.gets("orientation", "portrait") != "landscape";
    pv.modules_up = int(std::max(1.0, std::round(Ly.get("modules_across", 2))));
    pv.row_width = P.get("row_width", pv.modules_up * P.get(pv.portrait ? "module_length" : "module_width", pv.portrait ? 2.278 : 1.134));
    pv.albedo = P.get("albedo", pv.albedo);
    pv.albedo_monthly = P.getv("albedo_monthly");
    pv.transposition = P.gets("transposition", pv.transposition);
    pv.decomposition = P.gets("decomposition", pv.decomposition);
    pv.clearsky = P.gets("clearsky", pv.clearsky);
    pv.linke_turbidity = P.get("linke_turbidity", pv.linke_turbidity);
    pv.horizon = P.getv("horizon");
    pv.horizon_beam = P.gets("horizon_beam", pv.horizon_beam);
    pv.near_shading = P.getb("near_shading", pv.near_shading);
    pv.bifaciality = P.get("bifaciality", pv.bifaciality);
    pv.rear_loss = P.get("rear_loss", pv.rear_loss);
    pv.iam_model = P.gets("iam_model", pv.iam_model);
    pv.iam_b0 = P.get("iam_b0", pv.iam_b0);
    pv.iam_ar = P.get("iam_ar", pv.iam_ar);
    pv.iam_n = P.get("iam_n", pv.iam_n);
    pv.iam_kl = P.get("iam_kl", pv.iam_kl);
    pv.iam_n_ar = P.get("iam_n_ar", pv.iam_n_ar);
    pv.spectral = P.gets("spectral", pv.spectral);
    pv.soiling = P.get("soiling", pv.soiling);
    pv.soiling_monthly = P.getv("soiling_monthly");
    pv.snow_monthly = P.getv("snow_monthly");
    pv.snow_events = P.getv("snow_events");
    pv.snow_rh = P.get("snow_rh", pv.snow_rh);
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
    pv.inverter_model = P.gets("inverter_model", pv.inverter_model);
    pv.inverter_eff_max = P.get("inverter_eff_max", pv.inverter_eff_max);
    pv.ac_losses = P.get("ac_losses", pv.ac_losses);
    pv.availability = P.get("availability", pv.availability);
    pv.degradation = P.get("degradation", pv.degradation);
    pv.degradation_model = P.gets("degradation_model", pv.degradation_model);

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

bool layout_used(const Project& p) {
    const bool objects = p.pv.near_shading && !p.layout.obstacles.empty();
    const bool own = p.pv.mount != "tracker" && std::any_of(p.layout.areas.begin(), p.layout.areas.end(), [](const LayoutArea& a) {
        return std::isfinite(a.tilt) || std::isfinite(a.azimuth) || a.east_west;
    });
    return objects || own;
}

// Layout map: no more items than the near-shading geometry handles in reasonable time, every point within 50 km of the site.
void validate_layout(const SiteLayout& Ly) {
    auto need = [](bool ok, const std::string& msg) { if (!ok) throw std::runtime_error(msg); };
    auto near_site = [](const std::vector<PlanPoint>& v) {
        return std::all_of(v.begin(), v.end(), [](const PlanPoint& q) { return std::fabs(q[0]) <= 5e4 && std::fabs(q[1]) <= 5e4; });
    };
    need(Ly.areas.size() <= 1000 && Ly.obstacles.size() <= 5000 && Ly.tables.size() <= 30000,
         "The layout has too many items: at most 1000 PV areas, 5000 objects and 30000 tables.");
    size_t area_corners = 0, object_corners = 0;
    for (const LayoutArea& a : Ly.areas) area_corners += a.pts.size();
    for (const Obstacle& o : Ly.obstacles) object_corners += o.pts.size();
    need(area_corners <= 100000 && object_corners <= 100000, "The layout has too many corners: at most 100000 for the PV areas and 100000 for the objects.");
    for (const LayoutArea& a : Ly.areas) {
        need(a.pts.size() >= 3 && a.pts.size() <= 10000 && near_site(a.pts), "Every PV area needs 3 to 10000 corners within 50 km of the site.");
        need(a.base >= 0 && a.base <= 500, "The surface height of a PV area must be 0 to 500 m.");
        need(std::isnan(a.tilt) || (a.tilt >= 0 && a.tilt <= 90), "The tilt of a PV area must be 0 to 90 deg.");
        need(std::isnan(a.azimuth) || (a.azimuth >= 0 && a.azimuth <= 360), "The azimuth of a PV area must be 0 to 360 deg.");
    }
    for (const Obstacle& o : Ly.obstacles)
        need(o.pts.size() >= 3 && o.pts.size() <= 5000 && near_site(o.pts) && o.height > 0 && o.height <= 1000,
             "Every building or tree needs a footprint within 50 km of the site (a tree a crown diameter above 0) and a height of up to 1000 m.");
    for (const auto& t : Ly.tables) need(near_site({t[0], t[1], t[2], t[3]}), "A table of the layout lies more than 50 km from the site.");
    need(Ly.table_area.empty() || (Ly.table_area.size() == Ly.tables.size() &&
                                   std::all_of(Ly.table_area.begin(), Ly.table_area.end(), [&](int a) { return a >= -1 && a < int(Ly.areas.size()); })),
         "The layout's list of table areas does not match its tables: fill the areas with tables again.");
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
    need(p.pv.transposition == "hay_davies" || p.pv.transposition == "perez", "Transposition model must be hay_davies or perez.");
    need(p.pv.bifaciality >= 0 && p.pv.bifaciality <= 1 && p.pv.rear_loss >= 0 && p.pv.rear_loss < 1,
         "Bifaciality must be 0-100 % and the rear-side loss at least 0 % and below 100 %.");
    need(!(p.pv.bifaciality > 0 || (p.pv.diffuse_shading && p.pv.row_shading)) ||
             (p.pv.gcr > 0 && p.pv.gcr < 1 && p.pv.row_width > 0 && p.pv.mount_height > 0 && p.pv.mount_height <= 50 && p.pv.row_width <= 100),
         "Diffuse row shading and bifacial modules need a ground coverage ratio between 0 and 1, a table width of up to 100 m and a mounting height above 0 and up to 50 m.");
    need(p.pv.soiling_monthly.empty() || (p.pv.soiling_monthly.size() == 12 &&
                                          std::all_of(p.pv.soiling_monthly.begin(), p.pv.soiling_monthly.end(), [](double s) { return s >= 0 && s < 1; })),
         "Monthly soiling needs 12 values (January to December), each at least 0 % and below 100 %.");
    auto months = [](const std::vector<double>& v, double lo, double hi) {
        return v.empty() || (v.size() == 12 && std::all_of(v.begin(), v.end(), [&](double x) { return x >= lo && x <= hi; }));
    };
    const PVParams& pv = p.pv;
    need(months(pv.albedo_monthly, 0, 1), "Monthly albedo needs 12 values (January to December), each from 0 to 1.");
    need(months(pv.snow_monthly, 0, 1000) && months(pv.snow_events, 0, 31) && pv.snow_events.size() == pv.snow_monthly.size() &&
             pv.snow_rh > 0 && pv.snow_rh <= 1,
         "Monthly snow needs 12 snowfall values (cm) and 12 numbers of snow days (0-31), and a relative humidity above 0 % and at most 100 %.");
    need(pv.decomposition == "erbs" || pv.decomposition == "disc" || pv.decomposition == "boland", "Decomposition model must be erbs, disc or boland.");
    need(pv.clearsky == "haurwitz" || pv.clearsky == "ineichen", "Clear-sky model must be haurwitz or ineichen.");
    need(pv.linke_turbidity == 0 || (pv.linke_turbidity >= 1 && pv.linke_turbidity <= 10), "Linke turbidity must be 0 (estimated) or 1-10.");
    need(pv.iam_model == "ashrae" || pv.iam_model == "martin_ruiz" || pv.iam_model == "physical", "IAM model must be ashrae, martin_ruiz or physical.");
    need(pv.iam_ar > 0 && pv.iam_n > 1 && pv.iam_kl >= 0 && (pv.iam_n_ar == 0 || pv.iam_n_ar >= 1), "IAM parameters out of range.");
    need(pv.spectral == "none" || pv.spectral == "monosi" || pv.spectral == "multisi" || pv.spectral == "cigs" || pv.spectral == "cdte" ||
             pv.spectral == "asi",
         "Spectral model must be none, monosi, multisi, cigs, cdte or asi.");
    need(pv.horizon.empty() || (pv.horizon.size() >= 4 && pv.horizon.size() <= 720 &&
                                std::all_of(pv.horizon.begin(), pv.horizon.end(), [](double h) { return h >= 0 && h < 90; })),
         "Horizon needs 4 to 720 elevations from 0 to below 90 deg at equal azimuth steps from north, clockwise.");
    need(pv.horizon_beam == "auto" || pv.horizon_beam == "apply" || pv.horizon_beam == "data", "Horizon beam setting must be auto, apply or data.");
    if (layout_used(p)) validate_layout(p.layout);
    need(pv.shade_model == "linear" || pv.shade_model == "blocks", "Row shading model must be linear or blocks.");
    need(pv.bypass_blocks >= 0 && pv.bypass_blocks <= 100, "Bypass-diode blocks must be 0 (from the layout) to 100.");
    need(std::fabs(pv.tracker_axis_tilt) <= 45 && std::fabs(pv.tracker_cross_slope) <= 30,
         "Tracker axis tilt must be within 45 deg and the ground slope across the rows within 30 deg.");
    need(pv.inverter_model == "constant" ||
             (pv.inverter_model == "curve" && pv.inverter_eff > 0.5 && pv.inverter_eff < pv.inverter_eff_max && pv.inverter_eff_max <= 1),
         "Inverter curve needs a weighted efficiency above 50 % and below the peak efficiency, and a peak efficiency of at most 100 %.");
    need(pv.degradation_model == "compound" || pv.degradation_model == "linear", "Degradation model must be compound or linear.");
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
    need(p.dg.unit_kw > 0 && std::isfinite(p.dg.unit_kw) && p.dg.units >= 0, "Genset unit rating must be above 0 kW and the number of units non-negative.");
    need(std::isfinite(p.sim.load_growth) && p.sim.load_growth > -1 && p.sim.load_growth <= 1, "Annual load growth must be above -100 % and at most 100 %.");
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
