// Shading by the buildings, trees and other objects of the layout map (near shading), and the orientations of an array whose
// layout areas have their own tilt and azimuth.
#pragma once
#include "model.hpp"
#include "pv.hpp"
#include <array>
#include <cmath>
#include <memory>
#include <vector>

constexpr int NEAR_BINS = 180;   // near horizon azimuths 0, 2, ... 358 deg from north
// Near horizon azimuth of any azimuth (deg): the nearest of 0, 2, ... 358, so each one stands for [az - 1, az + 1).
inline int near_bin(double azimuth) {
    const double a = std::fmod(azimuth, 360.0);
    return int(std::floor((a < 0 ? a + 360.0 : a) / 2.0 + 0.5)) % NEAR_BINS;
}

// A point on the tables (or on a PV area without tables), m; table: index in SiteLayout::tables, -1 for a point of an area.
struct ShadePoint { double x, y, z; int table; };

// Elevation (deg) of the highest object edge above the horizontal of a point at height z, at each NEAR_BINS azimuth: the
// largest over rays every 0.5 deg within 1 deg of it and over the rays to the objects' corners, so no object is missed. A point
// inside a footprint (under a roof or a tree) sees 90 deg all round. Objects that stay below 2 deg are left out: the sun that
// low carries little energy, and the horizon band of the sky is about 6.5 deg high.
std::array<float, NEAR_BINS> near_horizon(double x, double y, double z, const std::vector<Obstacle>& obstacles);

// The near horizons of a non-empty set of points: the share of them that sees the sun behind an object, and the sky the
// objects and the terrain horizon `far` (equal azimuth steps from north, empty for none) leave in view, averaged over up to 48
// of the points.
class NearShading {
public:
    NearShading(std::vector<ShadePoint> pts, const std::vector<Obstacle>& obstacles, const std::vector<double>& far);
    const std::vector<ShadePoint>& points() const { return pts_; }
    const float* horizon(size_t k) const { return &h_[k * NEAR_BINS]; }
    // Share of the points with the sun (azimuth from north, elevation, deg) behind an object.
    double shaded(double azimuth, double elevation) const;
    const SkyCells& sky() const { return sky_; }
    // The elevations of all points at near horizon azimuth j, in ascending order.
    const std::vector<float>& sorted(int j) const { return sorted_[j]; }

private:
    std::vector<ShadePoint> pts_;
    std::vector<float> h_;                     // near horizon of point k at h_[k * NEAR_BINS + j]
    std::vector<std::vector<float>> sorted_;
    SkyCells sky_;
};

// One orientation of the array: its tilt and azimuth (east_west: half of the tables face azimuth + 180; own_tilt: the tilt of
// its areas, not the project's), its share of the modules, its tables and the near shading on them.
struct ArrayGroup {
    ArrayGroup(double tilt, double azimuth, bool east_west = false, bool own_tilt = false, double share = 1)
        : tilt(tilt), azimuth(azimuth), east_west(east_west), own_tilt(own_tilt), share(share) {}
    double tilt, azimuth;
    bool east_west, own_tilt;
    double share;
    bool canopy = false;                       // one plane of tables: the hourly model runs without row shading
    std::vector<int> tables;
    std::shared_ptr<const NearShading> near;   // null without objects
};
// The orientations of the array: one from the PV parameters, or one per orientation of the layout areas (fixed tables only),
// each with the share of the layout's tables (of the areas' plan area when the layout has no tables). Near shading samples points
// on the tables (about 20 000 in all, at least one per table), or over the areas without tables. The result for the last two
// layouts is kept, so runs over several weather years on one layout build it once.
std::vector<ArrayGroup> array_groups(const Project& p);
