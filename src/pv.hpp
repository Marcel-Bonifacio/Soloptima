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
// Equation of time in minutes for the day angle B (rad) of the year (Spencer 1971).
inline double equation_of_time(double B) {
    return 229.18 * (0.000075 + 0.001868 * std::cos(B) - 0.032077 * std::sin(B) - 0.014615 * std::cos(2 * B) - 0.040849 * std::sin(2 * B));
}

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
    double rear_annual = 0;           // irradiation on the back of bifacial modules, kWh/m2 (0 for monofacial)
    // Monthly balances by local month: global and diffuse horizontal, plane-of-array before shading (as
    // poa_annual) and effective irradiation in kWh/m2; mean ambient temperature in degC; array DC energy (after mismatch,
    // wiring, LID, quality) and energy available in kWh/kWp, summing to the loss-chain steps of the same names. UTC hour i
    // counts in the month of local hour i + n (LocalShift).
    std::array<double, 12> m_ghi{}, m_dhi{}, m_tamb{}, m_poa{}, m_eff{}, m_dc{}, m_avail{};
};

PVProfile compute_pv_profile(const Project& p);

// View factors of one row in an infinite array of identical rows, 2-D, averaged over the row's slant height (Marion et al.
// 2017, "A practical irradiance model for bifacial PV modules", NREL/CP-5J00-67847). Rows of width 1 at pitch 1/gcr: the front
// sees the sky above the top edge of the row in front and the ground below its lower edge, the back the sky above the top
// edge of the row behind and the ground below its lower edge. Integrating the crossed-string expressions over the slant
// gives closed forms; without neighbouring rows they reduce to (1 + cos tilt) / 2 and (1 - cos tilt) / 2.
struct RowView { double front_sky, front_ground, back_sky, back_ground; };
RowView row_view(double tilt, double gcr);
// The ground between the rows in STRIPS strips per pitch, 2-D: rows of width 1 at pitch 1/gcr with their centre at height h (row 0
// centred at x = 0, front facing +x, top edge towards -x). sky: view factor from each strip to the sky through the gaps between
// the rows. front, back: view factors from the front and the back of a row, averaged over its slant, to that strip in every
// pitch; they sum to front_ground and back_ground of row_view. Low rows see mostly the ground below them, which is in their own
// shadow for much of the day, so the back's share of lit ground rises with the height.
struct GroundView {
    static constexpr int STRIPS = 30;
    double tilt = 0, gcr = 0.4, h = 1;
    std::vector<double> sky, front, back;
    // Irradiance reflected by the ground towards the front and the back, before albedo: beam_h (beam on a horizontal plane) on
    // the part of each strip outside the rows' shadows plus dhi times the strip's sky view. tan_phi: tangent of the sun's zenith
    // projected on the plane across the rows, positive with the sun in front of the modules.
    std::array<double, 2> reflected(double tan_phi, double beam_h, double dhi) const;
};
GroundView ground_view(double tilt, double gcr, double h);

// Beam incidence angle modifier of the model chosen in pv (ashrae | martin_ruiz | physical) from cos(angle of incidence).
double incidence_modifier(const PVParams& pv, double cos_aoi);
// Diffuse IAM {sky, ground} of a plane at a tilt in deg (over 90 for the back of a module): the beam IAM averaged over the
// isotropic sky and ground in its view, weighted by the cosine of incidence (Marion 2017).
std::array<double, 2> diffuse_iam(const PVParams& pv, double tilt);
// Share {isotropic sky, horizon band} that a terrain horizon (elevations at equal azimuth steps from north) leaves in view of
// a plane (tilt, azimuth in deg).
std::array<double, 2> horizon_view(const std::vector<double>& horizon, double tilt, double azimuth);
// Inverter part-load loss coefficients {k0, k2} (P_loss = k0 + k2 p^2 per unit of AC rating) fitted to the European weighted
// and the peak efficiency.
std::array<double, 2> inverter_curve(double eta_weighted, double eta_max);

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
