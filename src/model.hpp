// Project data model: every input the engine needs, parsed from the project JSON.
#pragma once
#include "json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

constexpr int HOURS = 8760;
// First day of each month of a non-leap year (0-based day of year), and the month (0-11) of day of year d.
constexpr int MONTH_START[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
inline int month_of_day(int d) { return int(std::upper_bound(MONTH_START, MONTH_START + 12, d) - MONTH_START) - 1; }

struct Location {
    double lat = 0, lon = 0;
    double utc_offset = 0;   // hours, local standard time = UTC + offset
    double elevation = 0;    // m above sea level (air pressure for the air mass, clear sky and DISC)
};

// Hourly meteorological year. Arrays are 8760 long, index 0 = Jan 1 00:00-01:00.
struct Weather {
    bool is_utc = true;          // timestamps in UTC (true) or local standard time
    double time_offset = 0.5;    // hours from timestamp to the representative instant (mid-hour)
    std::vector<double> ghi, dni, dhi, tamb, wind;
    std::vector<double> snow;    // snowfall, cm per hour (optional; drives the hourly snow cover model)
    bool horizon_in_beam = false;   // the beam irradiance is already blocked by the terrain horizon (PVGIS fetches it so)
};

struct PVParams {
    double capacity_kwp = 1000;
    // module
    double module_eff = 0.22, gamma_pmax = -0.0034;
    double low_irr_loss_200 = 0.02;   // relative efficiency loss at 200 W/m2
    // mounting
    std::string mount = "fixed";      // fixed | tracker
    double tilt = 10, azimuth = 180;  // surface azimuth, degrees clockwise from north (180 = south-facing)
    bool azimuth_auto = true;         // true: face the equator and ignore `azimuth`
    double gcr = 0.4;
    double tracker_axis_azimuth = 0;  // 0 = N-S axis
    double tracker_axis_tilt = 0;     // axis rising towards its azimuth, deg
    double tracker_cross_slope = 0;   // ground slope across the rows, deg; > 0 falls towards axis azimuth + 90 (slope-aware backtracking)
    double tracker_max_angle = 55;
    bool backtracking = true;
    bool row_shading = true;
    std::string shade_model = "linear";   // linear: beam loss = shaded fraction | blocks: bypass-diode blocks (Martinez-Moreno et al. 2010)
    int bypass_blocks = 0;            // bypass-diode blocks up the table, 0 = from the layout (2 per portrait, 3 per landscape module)
    int modules_up = 2;               // modules up the slope of a table (layout)
    bool portrait = true;             // module orientation on the table (layout)
    bool diffuse_shading = false;     // with row_shading: rows also block sky diffuse and ground-reflected light (2-D view factors)
    double mount_height = 1.5;        // height of the table centre (tracker axis) above ground, m
    double row_width = 4.556;         // slant width of one table or tracker row, m (layout: modules across x module side)
    double albedo = 0.2;
    std::vector<double> albedo_monthly;   // 12 values by local month; replace `albedo` when given
    std::string transposition = "hay_davies";   // hay_davies | perez (Perez et al. 1990)
    std::string decomposition = "erbs";   // GHI-only weather: erbs | disc (Maxwell 1987) | boland (Boland and Ridley 2008)
    std::string clearsky = "haurwitz";    // haurwitz | ineichen (Ineichen and Perez 2002)
    double linke_turbidity = 0;       // Ineichen clear sky; 0 = each month from the clearest hours of the weather year
    std::vector<double> horizon;      // terrain horizon elevation, deg, at equal azimuth steps from north clockwise; empty = none
    std::string horizon_beam = "auto";   // auto: weather beam blocked already when it says so | apply | data (weather measured at the site)
    bool near_shading = true;         // shading by the buildings and trees of the layout (SiteLayout::obstacles)
    // bifacial modules: rear-side irradiance from the 2-D view factors of the rows
    double bifaciality = 0;           // rear / front efficiency at STC, 0 = monofacial
    double rear_loss = 0.05;          // rear-side structure shading and mismatch
    // optics & thermal
    std::string iam_model = "ashrae";   // ashrae (b0) | martin_ruiz (a_r) | physical (glass refraction and absorption)
    double iam_b0 = 0.05;
    double iam_ar = 0.16;             // Martin-Ruiz angular losses coefficient
    double iam_n = 1.526, iam_kl = 0.008, iam_n_ar = 0;   // physical: glass index, extinction x thickness, coating index (0 = none)
    std::string spectral = "none";    // none | monosi | multisi | cigs | cdte | asi (PVSPEC, Pelland et al. 2020)
    double soiling = 0.02;
    std::vector<double> soiling_monthly;   // 12 values by local month, January first; replace `soiling` when given
    // snow: monthly model (Townsend and Powers 2011) from snowfall and events; the weather's hourly snowfall, when given, drives
    // the hourly cover model instead (Marion et al. 2013)
    std::vector<double> snow_monthly;      // snowfall per month, cm
    std::vector<double> snow_events;       // days per month with more than 2.5 cm of snow
    double snow_rh = 0.8;                  // mean relative humidity of the snow months
    std::string thermal_model = "uc_uv";   // uc_uv (anything but "noct"): Tc = Ta + a*G*(1-eff)/(Uc+Uv*ws) | noct: Tc = Ta + (NOCT-20)/800*G
    double noct = 45.0;
    double uc = 29.0, uv = 0.0, absorptance = 0.9;
    // DC losses
    double mismatch = 0.02, dc_wiring = 0.015, lid = 0.015, module_quality = 0.0;
    std::string dc_wiring_basis = "annual";   // annual: constant fraction | stc: fraction at STC power, scaled each hour with string current over voltage (I^2R)
    // inverter / AC
    double dc_ac_ratio = 1.2, inverter_eff = 0.983, ac_losses = 0.015, availability = 0.99;
    std::string inverter_model = "constant";   // constant | curve: part-load losses fitted to the weighted and peak efficiency
    double inverter_eff_max = 0.99;   // peak efficiency of the curve
    double degradation = 0.005;       // per year after year 1
    std::string degradation_model = "compound";   // compound: (1 - d)^(y-1) | linear: 1 - d (y - 1), as module warranties
};

// PV output in project year y relative to year 1: (1 - d)^(y-1), or 1 - d (y - 1) for the linear model, not below 0.
inline double pv_degradation_factor(const PVParams& pv, int y) {
    return pv.degradation_model == "linear" ? std::max(0.0, 1 - pv.degradation * (y - 1)) : std::pow(1 - pv.degradation, y - 1);
}

struct BessParams {
    double energy_kwh = 0, power_kw = 0;
    double rte = 0.88;                // AC-AC round-trip
    double soc_min = 0.10, soc_max = 1.0, soc_init = 0.5;
    double calendar_fade = 0.01;      // SOH loss per year
    double cycle_life = 6000;         // datasheet cycles to EOL at cycle_life_dod
    double cycle_life_dod = 1.0;      // depth of discharge at which cycle_life is rated, fraction of nameplate
    double eol_soh = 0.70;            // SOH at the end of the rated cycle life (sets the fade per cycle)
    double replace_soh = -1;          // replace when SOH falls to this; < 0: at eol_soh
    double soh_init = 1.0;            // SOH at the start of year 1 (< 1: existing or second-life battery)
    double warranty_efc_yr = 0;       // warranty cap on equivalent full cycles per year (AC), 0 = none
    bool provides_reserve = true;     // BESS headroom counts as spinning reserve
    double reserve_duration_h = 1.0;  // hours the battery must sustain its reserve power from the energy above soc_min
    double self_discharge = 0.0;      // fraction of stored energy lost per hour
};

// Wind turbines (optional). Speed from the weather file (10 m) scaled to hub height by the power law.
struct WindParams {
    int units = 0;
    double rated_kw = 1500, v_in = 3.0, v_rated = 12.0, v_out = 25.0;
    double hub_height = 80, ref_height = 10, shear_alpha = 1.0 / 7.0;
    std::string curve = "cubic";      // cubic: P = Pr (v^3 - vin^3)/(vr^3 - vin^3) | linear
    double losses = 0.08;             // wake + electrical
    double availability = 0.97;
};

struct DieselParams {
    double unit_kw = 1000;
    int units = 1;
    double min_load = 0.30;           // per online unit
    int min_units_online = 1;         // grid-forming requirement (0 = BESS may run the grid alone)
    double reserve_load = 0.10;       // spinning reserve, fraction of load
    double reserve_pv = 0.50;         // spinning reserve, fraction of PV + wind output serving load
    std::string strategy = "load_following";  // load_following | cycle_charging | predictive
    double cc_setpoint = 0.80;        // SOC target for cycle charging
    // Fuel model. "table": (load fraction, kWh per litre) points, interpolated as L/h.
    // "linear": L/h = intercept * rated kW + slope * output kW.
    std::string fuel_model = "table";
    double fuel_intercept = 0.0165, fuel_slope = 0.2423;   // L/h/kW_rated, L/kWh
    std::vector<std::pair<double, double>> fuel_curve = {
        {0.25, 3.22}, {0.30, 3.37}, {0.40, 3.60}, {0.50, 3.76}, {0.60, 3.85},
        {0.70, 3.92}, {0.75, 3.94}, {0.80, 3.97}, {0.90, 3.98}, {1.00, 3.97}};
};

// Forecasters and DP planner for diesel strategy "predictive"; hourly runs also report forecast statistics.
struct EmsParams {
    std::string pv_forecast = "smart_persistence";   // method id from pv_forecast_methods()
    std::string load_forecast = "profile";           // method id from load_forecast_methods()
    double noise_sigma = 0.15;        // relative error for the "noisy" methods
    int horizon = 24;                 // look-ahead hours
    int replan = 1;                   // re-optimise every N hours
    int soc_levels = 21;              // DP state resolution
    double terminal_value = 0.9;      // value of stored energy at horizon end, fraction of marginal fuel cost
    bool firm_commitment = false;     // planned gensets cannot be de-committed in real time
    double voll = 5.0;                // value of lost load, currency/kWh (planning penalty)
};

struct EconParams {
    std::string currency = "USD";
    int lifetime = 25;
    double discount_rate = 0.08;
    double om_escalation = 0.02;
    double fuel_price = 1.0, fuel_escalation = 0.02;
    double pv_capex_kwp = 600, pv_om_kwp = 10, pv_life = 25;
    int inverter_replacement_year = 12;
    double inverter_replacement_kwac = 40;
    double bess_capex_kwh = 220, bess_capex_kw = 80, bess_om_kwh = 4;
    double bess_replace_kwh = 150, bess_cost_decline = 0.03;
    double diesel_capex_kw = 0;       // 0 when the gensets already exist
    double diesel_om_kwh = 0.01, diesel_om_unit_hour = 2.0;
    double co2_kg_per_l = 2.68, carbon_price_t = 0;
    double nox_g_per_l = 35.0, sox_g_per_l = 0.8;   // genset exhaust emission factors
    double wind_capex_kw = 1400, wind_om_kw = 40, wind_life = 20;
    // Social indicators (Abdoulaye et al. 2024): job creation factors and served population for HDI
    double jobs_pv_per_mw = 2.70, jobs_wind_per_mw = 1.10, jobs_bess_per_mwh = 0.01;
    double population = 0;            // 0 = do not compute HDI
    double other_capex_frac = 0.0;    // development/EPC/contingency as fraction of PV + BESS + wind capex
};

// Auxiliary and standby loads of the plant (kW), served like the site load every hour; they do not grow with it.
struct AuxParams {
    double bess_kw_per_mwh = 0;       // battery HVAC + BMS + fire system per MWh of nameplate energy
    double bess_temp_coeff = 0;       // rise of the battery part per degC of ambient above ref_c (fraction)
    double ref_c = 25;                // ambient temperature above which the battery part rises
    double plant_kw = 0;              // SCADA, lighting, tracker motors (with PV, wind or a battery)
    double trafo_noload_kw = 0;       // no-load loss of the PV step-up transformers (with PV)
    double bess_trafo_noload_kw = 0;  // no-load loss of the BESS step-up transformers (with a battery)
    double pcs_kw_per_mw = 0;         // PCS no-load loss while energised, kW per MW of PCS rating (with a battery)
};

struct SimOptions {
    bool all_years = true;            // simulate every project year (degradation, load growth)
    double load_growth = 0.0;
};

// The PV areas, the tables and the objects around them from the layout map, in metres east (x) and north (y) of the site
// location. Engine input for near shading and for areas with their own orientation; empty when the layout has neither.
using PlanPoint = std::array<double, 2>;
struct LayoutArea {
    std::vector<PlanPoint> pts;
    double base = 0;                  // height of the surface the tables stand on (a roof) above the ground, m
    double tilt = NAN, azimuth = NAN; // own orientation of fixed tables; NaN: the project's
    bool east_west = false;           // tables in back-to-back pairs facing azimuth and azimuth + 180
    bool canopy = false;              // tables side by side in one plane: no row shading, diffuse row shading or rear-side gain
};
struct Obstacle {
    std::vector<PlanPoint> pts;       // footprint (a tree: its crown, as a polygon)
    double height = 0;                // top above the ground, m
};
struct SiteLayout {
    std::vector<LayoutArea> areas;
    std::vector<Obstacle> obstacles;
    std::vector<std::array<PlanPoint, 4>> tables;   // corners: [0]-[1] the upper edge, [3]-[2] the lower edge below them
    std::vector<int> table_area;                     // the area each table was filled into (index in areas); empty: unknown
};

struct Project {
    std::string name;
    Location loc;
    Weather wx;
    std::vector<double> load_kw;      // 8760, local standard time
    PVParams pv;
    BessParams bess;
    WindParams wind;
    DieselParams dg;
    EmsParams ems;
    EconParams econ;
    AuxParams aux;
    SimOptions sim;
    SiteLayout layout;
};

Project parse_project(const json::Value& v);
Weather parse_weather(const json::Value& w);   // the "weather" block of a project, or one year as fetch_weather returns it
void validate_project(const Project& p);  // throws std::runtime_error with a readable message
// The engine uses the layout only for its objects (near shading on) and for areas with their own orientation (fixed tables);
// otherwise it is left alone, unchecked.
bool layout_used(const Project& p);
void validate_layout(const SiteLayout& layout);   // part of validate_project, also run before the engine uses the layout
