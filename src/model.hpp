// Project data model: every input the engine needs, parsed from the project JSON.
#pragma once
#include "json.hpp"
#include <string>
#include <utility>
#include <vector>

constexpr int HOURS = 8760;

struct Location {
    double lat = 0, lon = 0;
    double utc_offset = 0;   // hours, local standard time = UTC + offset
};

// Hourly meteorological year. Arrays are 8760 long, index 0 = Jan 1 00:00-01:00.
struct Weather {
    bool is_utc = true;          // timestamps in UTC (true) or local standard time
    double time_offset = 0.5;    // hours from timestamp to the representative instant (mid-hour)
    std::vector<double> ghi, dni, dhi, tamb, wind;
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
    double tracker_max_angle = 55;
    bool backtracking = true;
    bool row_shading = true;
    double albedo = 0.2;
    // optics & thermal
    double iam_b0 = 0.05;
    double soiling = 0.02;
    std::string thermal_model = "uc_uv";   // uc_uv (anything but "noct"): Tc = Ta + a*G*(1-eff)/(Uc+Uv*ws) | noct: Tc = Ta + (NOCT-20)/800*G
    double noct = 45.0;
    double uc = 29.0, uv = 0.0, absorptance = 0.9;
    // DC losses
    double mismatch = 0.02, dc_wiring = 0.015, lid = 0.015, module_quality = 0.0;
    std::string dc_wiring_basis = "annual";   // annual: constant fraction | stc: fraction at STC power, scaled each hour with string current over voltage (I^2R)
    // inverter / AC
    double dc_ac_ratio = 1.2, inverter_eff = 0.983, ac_losses = 0.015, availability = 0.99;
    double degradation = 0.005;       // per year after year 1
};

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
};

Project parse_project(const json::Value& v);
Weather parse_weather(const json::Value& w);   // the "weather" block of a project, or one year as fetch_weather returns it
void validate_project(const Project& p);  // throws std::runtime_error with a readable message
