// Forecast-based energy management system (EMS).
//
//  Forecaster  - PV and load forecasts (forecast.hpp: several methods, all causal).
//  Planner     - rolling-horizon dynamic programme over battery state of charge that minimises fuel,
//                genset run-hours, battery wear and unserved energy across the forecast horizon.
//  The real-time layer that follows the plan and compensates forecast errors lives in sim.cpp.
#pragma once
#include "forecast.hpp"
#include "fuel.hpp"
#include "json.hpp"
#include "model.hpp"
#include "sim.hpp"
#include <algorithm>
#include <limits>
#include <vector>

struct PlanInput {
    double Emin = 0, Emax = 0, Pb = 0, eta = 1;
    double fuel_price = 1, om_unit_hour = 0, om_kwh = 0, cycle_cost = 0, voll = 5, terminal_per_kwh = 0;
    bool provides_reserve = true;
    double reserve_h = 1;             // hours the battery must sustain its reserve power (BessParams::reserve_duration_h)
    int levels = 21;
};

// Cost weights and battery efficiency from the project; the caller sets Emin, Emax and Pb.
PlanInput plan_input(const Project& p, const FuelTable& fuel);

class Planner {
public:
    Planner(const DieselParams& dg, const FuelTable& fuel) : dg_(dg), fuel_(fuel) {}
    // Fills E_traj (H+1 stored-energy targets, E_traj[0] = start) and u_plan (H planned units online). The units are
    // committed with battery reserve limited as in real time (energy at the start of the hour, less the hour's discharge);
    // the SOC path ignores that limit.
    void plan(const PlanInput& in, double E0, const std::vector<double>& load_fc, const std::vector<double>& pv_fc,
              std::vector<double>& E_traj, std::vector<int>& u_plan);
    // Cost of one hour for a given battery AC power b (+ discharge / - charge); returns units online via u.
    // bres_cap: most battery power that counts as spinning reserve (energy limit).
    double hour_cost(const PlanInput& in, double L, double P, double b, int& u,
                     double bres_cap = std::numeric_limits<double>::infinity()) const;
    // Battery reserve power the stored energy E sustains for in.reserve_h hours.
    static double reserve_cap(const PlanInput& in, double E) { return std::max(0.0, E - in.Emin) * in.eta / in.reserve_h; }
    // Reserve credit over an hour that goes from E0 to E1, for hour_cost's bres_cap: when discharging b it is
    // (E0 - Emin) * eta / reserve_h - b, so hour_cost credits min(Pb, energy limit) - b, the real-time rule.
    static double reserve_cap(const PlanInput& in, double E0, double E1) {
        const double lo = std::min(E0, E1);
        return reserve_cap(in, lo) + (E0 - lo) * in.eta * (1 / in.reserve_h - 1);
    }

private:
    const DieselParams& dg_;
    const FuelTable& fuel_;
    std::vector<double> V_, cost_;
    std::vector<int> pol_;
};

// Operational day-ahead schedule: plan battery set-points and genset commitment for the next hours
// from a live weather forecast (fetch_forecast output) and the project's typical load profile.
// The plan starts at the hour of now_utc (ISO, UTC), or of the forecast's issued_utc when now_utc is empty: hours that
// began earlier are dropped, so soc_now applies at the start of the current hour. Without either, every hour is kept.
// max_hours > 0 keeps at most that many hours. The hours must be 1 h apart; the plan ends at the first hour without
// irradiance (or without wind, with turbines). Wind turbines (s.wind_units) add their output on the forecast wind.
json::Value day_ahead_schedule(const Project& p, const Sizing& s, const json::Value& forecast, double soc_now,
                               double load_scale, const std::string& now_utc = "", int max_hours = 0);

// Forecast Lab: error statistics of every PV and load forecasting method for leads 1-48 h, display series,
// and (optionally) the year-1 fuel / cost impact of each method when it drives the predictive EMS.
json::Value forecast_benchmark(const Project& p, bool with_value);
