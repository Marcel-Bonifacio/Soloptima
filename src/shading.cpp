#include "shading.hpp"
#include "parallel.hpp"
#include "pv.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <string>

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr double D2R = PI / 180.0, R2D = 180.0 / PI;

struct Box { double x0, y0, x1, y1; };
struct Footprint { const Obstacle* o; Box box; };

Box bounds(const std::vector<PlanPoint>& v) {
    Box b{v[0][0], v[0][1], v[0][0], v[0][1]};
    for (const PlanPoint& q : v) {
        b.x0 = std::min(b.x0, q[0]); b.x1 = std::max(b.x1, q[0]);
        b.y0 = std::min(b.y0, q[1]); b.y1 = std::max(b.y1, q[1]);
    }
    return b;
}

bool inside(double x, double y, const std::vector<PlanPoint>& poly) {
    bool in = false;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const PlanPoint &a = poly[i], &b = poly[j];
        if ((a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) in = !in;
    }
    return in;
}

double plan_area(const std::vector<PlanPoint>& poly) {
    double s = 0;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    return std::fabs(s / 2);
}

double wrap180(double a) {
    a = std::fmod(a + 180.0, 360.0);
    return (a < 0 ? a + 360.0 : a) - 180.0;
}

// Distance from (x, y) along the unit direction (dx, dy) to the nearest edge of the polygon, or -1 when the ray misses it.
double ray_hit(double x, double y, double dx, double dy, const std::vector<PlanPoint>& poly) {
    double best = -1;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const double ax = poly[j][0] - x, ay = poly[j][1] - y;
        const double ex = poly[i][0] - poly[j][0], ey = poly[i][1] - poly[j][1];
        const double den = dx * ey - dy * ex;
        if (std::fabs(den) < 1e-12) continue;
        const double t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
        if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && (best < 0 || t < best)) best = t;
    }
    return best;
}

std::vector<Footprint> footprints(const std::vector<Obstacle>& obstacles) {
    std::vector<Footprint> fp;
    for (const Obstacle& o : obstacles)
        if (o.pts.size() >= 3 && o.height > 0) fp.push_back({&o, bounds(o.pts)});
    return fp;
}

std::array<float, NEAR_BINS> horizon_of(double x, double y, double z, const std::vector<Footprint>& fp) {
    std::array<float, NEAR_BINS> h{};
    const double tan_min = std::tan(2.0 * D2R);
    for (const Footprint& f : fp) {
        const Obstacle& o = *f.o;
        const double dh = o.height - z;
        if (dh <= 0) continue;
        const double ox = std::max({f.box.x0 - x, 0.0, x - f.box.x1}), oy = std::max({f.box.y0 - y, 0.0, y - f.box.y1});
        const double dmin = std::hypot(ox, oy);
        if (dmin * tan_min >= dh) continue;
        if (dmin == 0 && inside(x, y, o.pts)) {
            h.fill(90.0f);
            return h;
        }
        auto cast = [&](double az) {
            const double t = ray_hit(x, y, std::sin(az * D2R), std::cos(az * D2R), o.pts);
            if (t <= 0) return;
            float& e = h[near_bin(az)];
            e = std::max(e, float(std::atan2(dh, t) * R2D));
        };
        // The footprint lies outside the point, so the bearings of its corners unwrap to a span of less than a full turn.
        const double b0 = std::atan2(o.pts[0][0] - x, o.pts[0][1] - y) * R2D;
        double prev = b0, rel = 0, lo = 0, hi = 0;
        for (const PlanPoint& q : o.pts) {
            const double b = std::atan2(q[0] - x, q[1] - y) * R2D;
            rel += wrap180(b - prev);
            prev = b;
            lo = std::min(lo, rel);
            hi = std::max(hi, rel);
            cast(b);
        }
        for (double a = std::floor((b0 + lo) * 2.0) / 2.0; a <= b0 + hi; a += 0.5) cast(a);
    }
    return h;
}
// Points along and down a table at spacing s, at least one each way.
std::array<int, 2> grid(const std::array<PlanPoint, 4>& c, double s) {
    return {std::max(1, int(std::lround(std::hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) / s))),
            std::max(1, int(std::lround(std::hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]) / s)))};
}

// The bits of every number that sets the array's orientations and near shading, each list preceded by its length, so that
// two keys are equal only for the same inputs. A hash would not do: project files come from other people, and a forged
// match would hand one layout the table indices of another.
struct LayoutKey {
    std::vector<uint64_t> w;
    void add(double v) { uint64_t b; std::memcpy(&b, &v, sizeof b); w.push_back(b); }
    void add(size_t n) { w.push_back(uint64_t(n)); }
    void add(const std::string& s) { add(s.size()); for (char c : s) w.push_back(uint8_t(c)); }
    void add(const std::vector<PlanPoint>& v) { add(v.size()); for (const PlanPoint& q : v) { add(q[0]); add(q[1]); } }
};
std::vector<uint64_t> layout_key(const Project& p) {
    const PVParams& pv = p.pv;
    const SiteLayout& L = p.layout;
    LayoutKey k;
    k.add(pv.mount); k.add(pv.tilt); k.add(pv.azimuth); k.add(pv.mount_height); k.add(pv.row_width); k.add(pv.near_shading ? 1.0 : 0.0);
    k.add(pv.horizon_beam); k.add(pv.horizon.size()); for (double x : pv.horizon) k.add(x);
    k.add(L.areas.size());
    for (const LayoutArea& a : L.areas) { k.add(a.pts); k.add(a.base); k.add(a.tilt); k.add(a.azimuth); k.add(a.east_west ? 1.0 : 0.0); }
    k.add(L.obstacles.size());
    for (const Obstacle& o : L.obstacles) { k.add(o.pts); k.add(o.height); }
    k.add(L.tables.size());
    for (const auto& t : L.tables) for (const PlanPoint& q : t) { k.add(q[0]); k.add(q[1]); }
    k.add(L.table_area.size());
    for (int a : L.table_area) k.add(double(a));
    return std::move(k.w);
}

std::vector<ArrayGroup> build_groups(const Project& p) {
    const PVParams& pv = p.pv;
    const SiteLayout& L = p.layout;
    const bool fixed = pv.mount != "tracker";
    std::vector<ArrayGroup> groups;
    auto group_for = [&](int a) {
        ArrayGroup g{pv.tilt, pv.azimuth, false, false, 0.0};
        if (a >= 0 && fixed) {
            const LayoutArea& A = L.areas[a];
            if (std::isfinite(A.tilt)) { g.tilt = A.tilt; g.own_tilt = true; }
            if (std::isfinite(A.azimuth)) g.azimuth = A.azimuth;
            g.east_west = A.east_west;
        }
        for (size_t k = 0; k < groups.size(); ++k)
            if (groups[k].tilt == g.tilt && groups[k].azimuth == g.azimuth && groups[k].east_west == g.east_west) return int(k);
        groups.push_back(std::move(g));
        return int(groups.size() - 1);
    };
    std::vector<int> area_group(L.areas.size());
    for (size_t a = 0; a < L.areas.size(); ++a) area_group[a] = group_for(int(a));
    // The area of each table as the layout map filled it, or else the first area that holds its centre
    std::vector<int> table_area = L.table_area;
    if (table_area.size() != L.tables.size()) {
        std::vector<Box> box(L.areas.size());
        for (size_t a = 0; a < L.areas.size(); ++a) box[a] = bounds(L.areas[a].pts);
        table_area.assign(L.tables.size(), -1);
        for (size_t t = 0; t < L.tables.size(); ++t) {
            const auto& c = L.tables[t];
            const double cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
            for (size_t a = 0; a < L.areas.size() && table_area[t] < 0; ++a)
                if (cx >= box[a].x0 && cx <= box[a].x1 && cy >= box[a].y0 && cy <= box[a].y1 && inside(cx, cy, L.areas[a].pts)) table_area[t] = int(a);
        }
    }
    for (size_t t = 0; t < L.tables.size(); ++t) groups[table_area[t] >= 0 ? area_group[table_area[t]] : group_for(-1)].tables.push_back(int(t));
    if (groups.empty()) group_for(-1);
    if (!L.tables.empty()) {
        for (ArrayGroup& g : groups) g.share = double(g.tables.size()) / L.tables.size();
    } else {
        std::vector<double> area(groups.size(), 0.0);
        for (size_t a = 0; a < L.areas.size(); ++a) area[area_group[a]] += plan_area(L.areas[a].pts);
        double total = 0;
        for (double x : area) total += x;
        for (size_t g = 0; g < groups.size(); ++g) groups[g].share = total > 0 ? area[g] / total : 1.0 / groups.size();
    }

    if (pv.near_shading && !L.obstacles.empty()) {
        std::vector<std::vector<ShadePoint>> pts(groups.size());
        if (!L.tables.empty()) {
            // Points spread over each table, up the slant from its upper edge [0]-[1] towards the lower edge [3]-[2], at a
            // spacing for about 20 000 points; at least one per table, so many tables raise the spacing until the count fits
            double plan = 0;
            for (const auto& c : L.tables) plan += plan_area({c[0], c[1], c[2], c[3]});
            auto count = [&](double s) {
                size_t n = 0;
                for (const auto& c : L.tables) { const std::array<int, 2> g = grid(c, s); n += size_t(g[0]) * size_t(g[1]); }
                return n;
            };
            double s = std::max(1.0, std::sqrt(plan / 20000));
            while (count(s) > 22000 && s < 2e5) s *= 1.25;   // thin tables have little plan area; past 200 km each gets one point
            for (size_t g = 0; g < groups.size(); ++g)
                for (int t : groups[g].tables) {
                    const auto& c = L.tables[t];
                    const std::array<int, 2> n = grid(c, s);
                    const double ax = c[1][0] - c[0][0], ay = c[1][1] - c[0][1], dx = c[3][0] - c[0][0], dy = c[3][1] - c[0][1];
                    const double base = (table_area[t] >= 0 ? L.areas[table_area[t]].base : 0.0) + pv.mount_height;
                    const double rise = fixed ? pv.row_width * std::sin(groups[g].tilt * D2R) : 0.0;
                    for (int i = 0; i < n[0]; ++i)
                        for (int j = 0; j < n[1]; ++j) {
                            const double u = (i + 0.5) / n[0], v = (j + 0.5) / n[1];
                            pts[g].push_back({c[0][0] + u * ax + v * dx, c[0][1] + u * ay + v * dy, base + (0.5 - v) * rise, t});
                        }
                }
        } else {
            // No tables: a grid over the areas at the table centre height
            double total = 0;
            for (const LayoutArea& A : L.areas) total += plan_area(A.pts);
            const double s0 = std::max(1.0, std::sqrt(total / 5000));
            for (size_t a = 0; a < L.areas.size(); ++a) {
                const LayoutArea& A = L.areas[a];
                const Box b = bounds(A.pts);
                const double s = std::max(s0, std::sqrt((b.x1 - b.x0) * (b.y1 - b.y0) / 20000));   // at most about 20 000 tries per area
                const double z = A.base + pv.mount_height;
                const size_t before = pts[area_group[a]].size();
                for (double y = b.y0 + s / 2; y < b.y1; y += s)
                    for (double x = b.x0 + s / 2; x < b.x1; x += s)
                        if (inside(x, y, A.pts)) pts[area_group[a]].push_back({x, y, z, -1});
                if (pts[area_group[a]].size() == before)
                    pts[area_group[a]].push_back({(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z, -1});
            }
        }
        // The near horizons cost about (points x object corners); refuse a layout that would take minutes
        size_t n_pts = 0, corners = 0;
        for (const auto& v : pts) n_pts += v.size();
        for (const Obstacle& o : L.obstacles) corners += o.pts.size();
        if (double(n_pts) * double(corners) > 1e9)
            throw std::runtime_error("Too many building and tree corners for the size of the layout: simplify the outlines or remove distant objects.");
        const std::vector<double> none, &far = !pv.horizon.empty() && pv.horizon_beam != "data" ? pv.horizon : none;
        for (size_t g = 0; g < groups.size(); ++g)
            if (!pts[g].empty()) groups[g].near = std::make_shared<const NearShading>(std::move(pts[g]), L.obstacles, far);
    }
    groups.erase(std::remove_if(groups.begin(), groups.end(), [](const ArrayGroup& g) { return g.share <= 0; }), groups.end());
    return groups;
}
} // namespace

std::array<float, NEAR_BINS> near_horizon(double x, double y, double z, const std::vector<Obstacle>& obstacles) {
    return horizon_of(x, y, z, footprints(obstacles));
}

NearShading::NearShading(std::vector<ShadePoint> pts, const std::vector<Obstacle>& obstacles, const std::vector<double>& far)
    : pts_(std::move(pts)) {
    const size_t n = pts_.size();
    h_.assign(n * NEAR_BINS, 0.0f);
    const std::vector<Footprint> fp = footprints(obstacles);
    constexpr size_t CHUNK = 256;
    parallel_for((n + CHUNK - 1) / CHUNK, std::max(1u, std::thread::hardware_concurrency()), [&](size_t c) {
        for (size_t k = c * CHUNK; k < std::min(n, (c + 1) * CHUNK); ++k) {
            const std::array<float, NEAR_BINS> hk = horizon_of(pts_[k].x, pts_[k].y, pts_[k].z, fp);
            std::copy(hk.begin(), hk.end(), h_.begin() + k * NEAR_BINS);
        }
    });
    sorted_.assign(NEAR_BINS, std::vector<float>(n));
    for (int j = 0; j < NEAR_BINS; ++j) {
        for (size_t k = 0; k < n; ++k) sorted_[j][k] = h_[k * NEAR_BINS + j];
        std::sort(sorted_[j].begin(), sorted_[j].end());
    }
    // Sky cells over the objects and the terrain, averaged over up to 48 points spread through the set
    const size_t m = std::min<size_t>(n, 48);
    std::vector<double> far_at(NEAR_BINS, 0.0), prof(NEAR_BINS);
    if (!far.empty())
        for (int j = 0; j < NEAR_BINS; ++j) far_at[j] = horizon_at(far, 2.0 * j);
    for (size_t i = 0; i < m; ++i) {
        const float* hk = horizon(i * n / m);
        for (int j = 0; j < NEAR_BINS; ++j) prof[j] = std::max(double(hk[j]), far_at[j]);
        const SkyCells c = sky_cells(prof);
        if (sky_.sky.empty()) { sky_.sky.assign(c.sky.size(), 0.0); sky_.band.assign(c.band.size(), 0.0); }
        for (size_t k = 0; k < c.sky.size(); ++k) sky_.sky[k] += c.sky[k] / m;
        for (size_t k = 0; k < c.band.size(); ++k) sky_.band[k] += c.band[k] / m;
    }
}

double NearShading::shaded(double azimuth, double elevation) const {
    const std::vector<float>& v = sorted_[near_bin(azimuth)];
    return double(v.end() - std::upper_bound(v.begin(), v.end(), float(elevation))) / double(v.size());
}

std::vector<ArrayGroup> array_groups(const Project& p) {
    if (!layout_used(p)) return {ArrayGroup{p.pv.tilt, p.pv.azimuth}};
    // The groups of the last two layouts. The lock is held while one is built, so parallel runs on the same layout (the weather
    // years of P50/P90) wait for it rather than each building it.
    static std::mutex m;
    static std::vector<std::pair<std::vector<uint64_t>, std::vector<ArrayGroup>>> kept;
    std::vector<uint64_t> key = layout_key(p);
    std::lock_guard<std::mutex> lock(m);
    for (size_t i = 0; i < kept.size(); ++i)
        if (kept[i].first == key) {
            if (i + 1 < kept.size()) std::rotate(kept.begin() + i, kept.begin() + i + 1, kept.end());   // most recent last
            return kept.back().second;
        }
    validate_layout(p.layout);   // a layout seen before was checked then
    std::vector<ArrayGroup> groups = build_groups(p);
    if (groups.empty()) groups = {ArrayGroup{p.pv.tilt, p.pv.azimuth}};   // areas without plan area: the PV parameters
    if (kept.size() >= 2) kept.erase(kept.begin());
    kept.emplace_back(std::move(key), groups);
    return groups;
}
