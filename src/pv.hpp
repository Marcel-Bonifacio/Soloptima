// Solar geometry, transposition and PV array/inverter model (hourly loss chain).
#pragma once
#include "model.hpp"
#include <array>
#include <cmath>
#include <string>
#include <vector>

struct SunPos {
    double zenith_deg, azimuth_deg;   // azimuth clockwise from north
    double cos_zenith;
    double extra_normal;              // extraterrestrial normal irradiance, W/m2
};

// doy: 1..365, utc_hour: fractional hour of day (0..24)
SunPos sun_position(double lat, double lon, int doy, double utc_hour);

// Weather in UTC onto local standard time, UTC offset = n + f with 0 <= f < 1 (no shift for weather already in local time).
// Local hour L spans the last f of UTC hour L - n - 1 and the first 1 - f of UTC hour L - n, so it takes
// f x UTC(L - n - 1) + (1 - f) x UTC(L - n), the exact mean over the local hour; whole-hour offsets move every hour unchanged.
struct LocalShift { int n; double f; };
LocalShift local_shift(const Project& p);
// Adds UTC hour i's value x to the local series v (8760, zeroed first) with the weights of s.
inline void put_local(std::vector<double>& v, int i, double x, LocalShift s) {
    v[((i + s.n) % HOURS + HOURS) % HOURS] += (1 - s.f) * x;
    if (s.f > 0) v[((i + s.n + 1) % HOURS + HOURS) % HOURS] += s.f * x;
}

// Energy at each step of the loss chain, kWh per kWp-DC over year 1 (or kWh/m2 for irradiance steps).
struct LossStep { std::string name; double value; bool irradiance; };

struct PVProfile {
    std::vector<double> ac_per_kwp;   // 8760, local standard time (put_local), kW AC per kWp DC
    std::vector<double> poa;          // W/m2 plane-of-array (after shading), local time
    std::vector<double> tcell;        // deg C, local time
    std::vector<double> ghi_local;    // W/m2, local time
    std::vector<LossStep> losses;
    double specific_yield = 0;        // kWh/kWp/yr AC
    double performance_ratio = 0;
    double ghi_annual = 0, poa_annual = 0;  // kWh/m2
    // Monthly balances by local month: global and diffuse horizontal, plane-of-array before shading (as
    // poa_annual) and effective irradiation in kWh/m2; mean ambient temperature in degC; array DC energy (after mismatch,
    // wiring, LID, quality) and energy available in kWh/kWp, summing to the loss-chain steps of the same names. UTC hour i
    // counts in the month of local hour i + n (LocalShift).
    std::array<double, 12> m_ghi{}, m_dhi{}, m_tamb{}, m_poa{}, m_eff{}, m_dc{}, m_avail{};
};

PVProfile compute_pv_profile(const Project& p);

// Haurwitz clear-sky GHI (W/m2) from cos(zenith).
inline double haurwitz_ghi(double cz) { return cz > 0.01 ? 1098.0 * cz * std::exp(-0.057 / cz) : 0.0; }
// Clear-sky GHI (Haurwitz) on the weather file's own time base.
std::vector<double> clearsky_ghi(const Project& p);
// PV output per kWp under clear sky (same system, same temperatures) - basis of the PV forecaster.
std::vector<double> clearsky_pv_per_kwp(const Project& p);

// Wind turbine AC output per turbine (kW), local time; zeros when the weather file has no wind speed.
std::vector<double> wind_per_turbine(const Project& p);

// Specific yield (kWh/kWp) of a fixed-tilt array over a range of tilts, all other parameters unchanged.
std::vector<std::pair<double, double>> tilt_scan(Project p, double from, double to, double step);
