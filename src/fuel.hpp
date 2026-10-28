// Genset fuel model shared by the dispatch engine and the EMS planner.
#pragma once
#include "model.hpp"
#include <algorithm>
#include <array>
#include <stdexcept>
#include <vector>

// Fuel use per unit as L/h per kW rated, tabulated over load fraction 0..1 for fast lookup.
struct FuelTable {
    std::array<double, 101> rate{};
    explicit FuelTable(const DieselParams& d) {
        if (d.fuel_model == "linear") {
            for (int k = 0; k <= 100; ++k) rate[k] = d.fuel_intercept + d.fuel_slope * (k / 100.0);
            return;
        }
        if (d.fuel_curve.size() < 2) throw std::runtime_error("Fuel curve needs at least 2 points.");
        // Interpolate L/h (not kWh/L): fuel rate is near-linear in load, efficiency is not.
        std::vector<std::pair<double, double>> pts;
        for (auto [lf, eff] : d.fuel_curve) pts.emplace_back(lf, lf / eff);
        std::sort(pts.begin(), pts.end());
        for (int k = 0; k <= 100; ++k) {
            double x = k / 100.0;
            size_t j = 1;
            while (j + 1 < pts.size() && x > pts[j].first) ++j;
            auto [x0, y0] = pts[j - 1];
            auto [x1, y1] = pts[j];
            double y = x1 > x0 ? y0 + (y1 - y0) * (x - x0) / (x1 - x0) : y0;
            rate[k] = std::max(0.0, y);
        }
    }
    double operator()(double lf) const {
        lf = std::clamp(lf, 0.0, 1.0) * 100.0;
        int k = std::min(99, int(lf));
        double f = lf - k;
        return rate[k] + (rate[k + 1] - rate[k]) * f;
    }
};
