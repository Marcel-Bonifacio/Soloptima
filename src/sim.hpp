// Chronological hourly dispatch (PV + BESS + diesel fleet) and lifecycle economics.
#pragma once
#include "json.hpp"
#include "model.hpp"
#include <vector>

struct Sizing { double pv_kwp = 0, bess_kwh = 0, bess_kw = 0, wind_units = 0; };

struct Hourly {   // year-1 time series, kW (= kWh per hour); load includes the auxiliary load aux
    std::vector<double> load, aux, pv_avail, pv_to_load, pv_to_bess, pv_curtailed, bess_dis, gen_to_bess, gen_to_load,
        gen_dump, gen_units, fuel_l, unmet, soc, wind_avail, wind_to_load, wind_to_bess, wind_curtailed;
    // forecasts (hour-ahead and day-ahead) and the EMS state-of-charge target
    std::vector<double> pv_fc_h1, load_fc_h1, pv_fc_da, load_fc_da, soc_target;
};

struct ForecastStats {
    double pv_nmae_h1 = 0, pv_nmae_da = 0, load_nmae_h1 = 0, load_nmae_da = 0;  // MAE / mean actual
    double pv_bias_da = 0, load_bias_da = 0;                                    // mean error / mean actual
    double net_error_kwh = 0;          // sum |actual net load - forecast net load| (predictive EMS)
    double bess_compensation_kwh = 0;  // part of that absorbed by deviating the battery from plan
    long plans = 0;
};

struct YearResult {
    int year = 0;
    double load = 0, served = 0, unmet = 0;   // load includes the auxiliary load aux
    double aux = 0, served_site = 0;          // auxiliary consumption; energy served to the site load (served - aux)
    double pv_avail = 0, pv_to_load = 0, pv_to_bess = 0, pv_curtailed = 0;
    double bess_dis = 0, bess_ch = 0, bess_soh = 1, bess_efc = 0;   // bess_soh at the start of the year, bess_efc = AC discharge / nameplate
    double bess_efc_dc = 0;                // discharge at the cells (AC / one-way efficiency) / nameplate
    double soh_loss_cal = 0, soh_loss_cyc = 0, max_c_rate = 0;   // SOH lost to calendar and cycle fade; peak power / nameplate kWh
    bool bess_replaced = false;
    double gen_kwh = 0, gen_to_load = 0, gen_dump = 0, fuel_l = 0, unit_hours = 0, starts = 0, max_unmet_kw = 0;
    double gen_to_bess = 0, wind_to_load = 0, wind_to_bess = 0;
    // Stored energy (kWh) at the start of the year (after the SOC window of the year is applied) and at its end. Battery
    // conversion losses = bess_ch - bess_dis - self_discharge - (e_end - e_start).
    double e_start = 0, e_end = 0;
    double re_fraction = 0, co2_t = 0, nox_t = 0, sox_t = 0;
    // Operational adequacy. Loss of load: unmet > 0.1 % of the hour's load; events are runs of such hours.
    double lol_h = 0, lol_events = 0, lol_max_h = 0;
    double reserve_short_h = 0, reserve_short_max_kw = 0;   // spinning reserve left after allocation below the requirement
    double max_units = 0, fleet_full_h = 0;                 // most gensets online; hours with the whole fleet online
    double minload_h = 0, minload_run_max_h = 0;            // hours with every online genset at minimum loading; longest run
    double max_starts_h = 0;                                // most gensets started in one hour
    double wind_avail = 0, wind_used = 0, wind_curtailed = 0, self_discharge = 0;
    double re_avail = 0, re_direct = 0;   // sum of PV+wind available, sum of min(load, PV+wind)
    // nominal cash flows (positive = cost)
    double c_fuel = 0, c_om = 0, c_replace = 0, c_carbon = 0, c_salvage = 0, c_total = 0;
    double c_om_new = 0, c_om_dg = 0;    // O&M split: new assets (PV, BESS, wind) vs diesel fleet
};

struct Economics {
    double capex_pv = 0, capex_bess = 0, capex_wind = 0, capex_diesel = 0, capex_other = 0, capex_total = 0;
    double crf = 0, tac = 0, coe = 0;     // capital recovery factor, total annualised cost, TAC / served energy
    double npc = 0, lcoe = 0;
};

struct SimResult {
    Sizing size;
    std::vector<YearResult> years;
    Economics econ;
    Hourly hourly;
    bool has_hourly = false;
    // headline (year 1 unless stated)
    double re_fraction = 0, unmet_fraction = 0, curtail_fraction = 0, fuel_l_y1 = 0, avg_gen_load = 0;
    double unmet_fraction_max = 0;   // highest unmet / load of any project year (load growth)
    int bess_replacements = 0;
    ForecastStats fc;
    // Indicators from the studied literature (year 1): reliability, self-sufficiency, environment, social
    struct Metrics {
        double lpsp = 0, ssci = 0, sssi = 0, rep = 0, excess_kwh = 0, excess_fraction = 0;
        double co2_t = 0, nox_kg = 0, sox_kg = 0, jobs = 0, hdi = -1;
    } metrics;
};

// Auxiliary load (kW) at ambient temperature tamb: battery HVAC and BMS (with a battery), plus plant auxiliaries (with PV,
// wind or a battery) and the no-load loss of the PV step-up transformers (with PV) and the BESS ones (with a battery).
double aux_kw(const Project& p, const Sizing& s, double tamb);

// pv_per_kwp: actual AC output per kWp; pv_cs_per_kwp: clear-sky output per kWp (forecaster input).
// fc: optional pre-built forecaster (shared across optimiser candidates); built on demand when null.
class Forecaster;
SimResult simulate(const Project& p, const std::vector<double>& pv_per_kwp, const std::vector<double>& pv_cs_per_kwp,
                   const Sizing& s, bool keep_hourly, const Forecaster* fc = nullptr);

// Comparison of a hybrid system against a reference: the diesel-only baseline, or PV only (same PV and wind, no battery)
// for the battery's own value. Capex, fuel, O&M, replacements and salvage all enter the incremental cash flow.
struct Comparison { double npv_savings = 0, irr = 0, payback_years = 0, fuel_saved_l_y1 = 0, co2_saved_t_y1 = 0, lcoe_base = 0; bool irr_valid = false; };
Comparison compare(const SimResult& hybrid, const SimResult& base);

json::Value result_to_json(const SimResult& r, bool include_hourly);
json::Value comparison_to_json(const Comparison& c);
