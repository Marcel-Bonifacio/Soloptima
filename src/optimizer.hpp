// PV / BESS sizing for a known load and a known diesel fleet.
// Grid: exhaustive (PV kWp x BESS kWh x C-rate) + Hooke-Jeeves pattern search, multi-threaded.
// Metaheuristics from the literature: PSO, MOPSO (cost vs renewable fraction or SSSI) and hybrid SHO-QAO-GOA,
// also over the C-rate range and the number of wind turbines.
// Optional sensitivity: repeat the search for each value of one input.
#pragma once
#include "json.hpp"
#include "model.hpp"
#include <atomic>
#include <limits>
#include <string>
#include <vector>

struct OptSettings {
    double pv_min = 0, pv_max = 0;  int pv_steps = 16;
    double bess_min = 0, bess_max = 0; int bess_steps = 12;
    std::vector<double> c_rates = {0.5};          // BESS kW per kWh
    std::string objective = "npc";                // npc | lcoe | re
    double max_unmet = 0.001;                     // fraction of annual load, in every simulated year
    double max_lole_h = -1;                       // loss-of-load hours per year, worst year (< 0 = no limit)
    double max_reserve_short_h = -1;              // spinning-reserve shortfall hours per year, worst year (< 0 = no limit)
    double min_re = 0.0;                          // year-1 renewable fraction
    double max_curtail = 1.0;                     // fraction of available PV
    double max_pv_kwp = std::numeric_limits<double>::infinity();   // land limit from layout
    double max_capex = std::numeric_limits<double>::infinity();
    bool refine = true;
    int threads = 0;                              // 0 = hardware concurrency
    // "", fuel_price, fuel_escalation, discount_rate, pv_capex_kwp, bess_capex_kwh, load_scale (x load),
    // bess_life_scale (x cycle life, / calendar fade), bess_cycle_life, bess_calendar_fade, bess_replace_kwh,
    // bess_prices_scale (x battery capex per kWh and kW and replacement price), bess_replace_soh, pv_degradation, diesel_om_unit_hour
    std::string sens_var;
    std::vector<double> sens_values;
    // Search algorithm: grid (exhaustive + pattern search) | pso | mopso | hshoa (SHO + QAO + GOA)
    std::string algorithm = "grid";
    int particles = 24, iterations = 40;
    unsigned seed = 42;
    int wind_min = 0, wind_max = 0;               // wind turbine count range (metaheuristics)
    std::string mo_second = "re";                 // MOPSO second objective: re | sssi
};

OptSettings parse_opt_settings(const json::Value& v, const Project& p);

struct Progress {
    std::atomic<long> done{0};
    std::atomic<long> total{1};
    std::atomic<bool> cancel{false};
};

// Returns the full result JSON (grid, ranked table, Pareto set, best system with hourly detail, sensitivity table).
json::Value optimize(const Project& p, const OptSettings& o, Progress& prog);
