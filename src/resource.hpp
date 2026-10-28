// Inter-annual variability and P50/P90 of the yield and of the plant's results: the dispatch is run once per historical
// weather year (year 1 of the project, sizes and settings unchanged). Fuel saved and revenue do not scale with the PV yield
// (genset minimum loading, a full battery, take-or-pay floors), so each metric gets its own spread. The spread is used
// only as ratios: P50 stays on the project's own weather.
#pragma once
#include "json.hpp"
#include "model.hpp"
#include "optimizer.hpp"
#include <vector>

struct WeatherYear { int year = 0; Weather wx; };

// Systematic uncertainty of the long-term irradiance at the plant, one standard deviation each.
struct UncertaintyBudget {
    double dataset = 0.05;    // irradiance dataset (satellite or reanalysis bias)
    double model = 0.02;      // transposition and PV model
    double soiling = 0.015;   // soiling and availability
};
double sigma_sys(const UncertaintyBudget& b);   // root-sum-square of the budget

// Year 1 of the project simulated with one weather year.
struct YearRun {
    int year = 0;                                    // 0: the project's own weather
    double sy = 0, ghi = 0, poa = 0;                 // specific yield kWh/kWp, GHI and plane-of-array kWh/m2
    double re = 0, curtail = 0, unmet = 0;           // renewable fraction, curtailed share of RE available, unmet share
    double fuel_hyb = 0, fuel_base = 0, fuel_saved = 0;   // litres: hybrid, diesel only, saved
    double avoided_cost = 0;                         // diesel-only fuel + genset O&M + carbon cost minus the hybrid's
    double re_kwh = 0;                               // renewable energy served (served x renewable fraction)
    double energy = 0;                               // renewable energy delivered to the site load (Project finance)
    double revenue = 0;                              // year-1 revenue of Project finance (host-owned: the avoided cost)
    double npv_savings = 0;                          // vs diesel only, with this year repeated over the project life
};

// Exceedance values of one metric. m0: its value with the project's weather (the P50); ys: its value in each historical
// year; elasticity: relative change of the metric per relative change of irradiance; sigma_sys: the systematic uncertainty
// of irradiance. With r = y / mean(y) and sigma_iav the sample standard deviation of r, the N-year uncertainty is
// sigma_N = sqrt(sigma_iav^2 / N + (elasticity x sigma_sys)^2) (independent years), and P_x = m0 (1 - z_x sigma_N) for a
// benefit (lower is worse), m0 (1 + z_x sigma_N) otherwise (fuel used).
struct Exceedance {
    double p50 = 0, mean = 0, sigma_iav = 0, sigma_1 = 0, sigma_10 = 0;
    double p75_1 = 0, p90_1 = 0, p99_1 = 0, p90_10 = 0;
};
Exceedance exceedance(double m0, const std::vector<double>& ys, double elasticity, double sigma_sys, bool benefit);

// Runs year 1 of the project with every weather year, with the project's own weather (P50 anchor), and with that weather's
// irradiance (GHI, DNI, DHI) x (1 + s) and x (1 - s), s = sigma_sys, for the elasticity of each metric (clipping and cell
// temperature included). raw: the project JSON (its "finance" block). Progress counts years + 3 runs; prog.cancel stops.
// Returns {years: [...], anchor, plus, minus, stats: {yield, fuel_saved, re, avoided_cost, revenue, fuel_used:
// {p50, mean, sigma_iav, sigma_1, sigma_10, elasticity, p75_1, p90_1, p99_1, p90_10, worst_year, worst}}, sigma_sys, step}.
json::Value resource_years(const Project& p, const json::Value& raw, const std::vector<WeatherYear>& years,
                           const UncertaintyBudget& b, Progress& prog);
