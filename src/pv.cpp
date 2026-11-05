#include "pv.hpp"
#include <algorithm>
#include <cmath>
#include <map>
#include <stdexcept>
#include <tuple>

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr double D2R = PI / 180.0, R2D = 180.0 / PI;
inline double sind(double d) { return std::sin(d * D2R); }
inline double cosd(double d) { return std::cos(d * D2R); }

// Erbs diffuse fraction from clearness index.
double erbs_diffuse_fraction(double kt) {
    if (kt <= 0.22) return 1.0 - 0.09 * kt;
    if (kt <= 0.80) return 0.9511 - 0.1604 * kt + 4.388 * kt * kt - 16.638 * kt * kt * kt + 12.336 * kt * kt * kt * kt;
    return 0.165;
}

// Perez et al. 1990 (Solar Energy 44(5), 271-289), all-sites composite coefficients f11 f12 f13 f21 f22 f23 for the eight sky
// clearness bins, whose upper limits are PEREZ_EPS.
constexpr double PEREZ[8][6] = {{-0.008, 0.588, -0.062, -0.060, 0.072, -0.022}, {0.130, 0.683, -0.151, -0.019, 0.066, -0.029},
                                {0.330, 0.487, -0.221, 0.055, -0.064, -0.026},  {0.568, 0.187, -0.295, 0.109, -0.152, -0.014},
                                {0.873, -0.392, -0.362, 0.226, -0.462, 0.001},  {1.132, -1.237, -0.412, 0.288, -0.823, 0.056},
                                {1.060, -1.600, -0.359, 0.264, -1.127, 0.131},  {0.678, -0.327, -0.250, 0.156, -1.377, 0.251}};
constexpr double PEREZ_EPS[7] = {1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2};

// Relative optical air mass of Kasten and Young (1989), zenith capped at 90 deg for hours whose representative instant falls
// just after sunset or before sunrise.
double air_mass(double zenith_deg) {
    const double zd = std::min(zenith_deg, 90.0);
    return 1.0 / (cosd(zd) + 0.50572 * std::pow(96.07995 - zd, -1.6364));
}
// Air pressure relative to sea level at an elevation in m (standard atmosphere), for the absolute air mass.
double pressure_ratio(double elevation) { return 100.0 * std::pow((44331.514 - elevation) / 11880.516, 1 / 0.1902632) / 101325.0; }

// Circumsolar (F1) and horizon (F2) brightening coefficients of the Perez model.
std::pair<double, double> perez_f(double dhi, double dni, double zenith_deg, double e0) {
    const double zd = std::min(zenith_deg, 90.0), z = zd * D2R;
    const double delta = dhi * air_mass(zenith_deg) / e0;   // sky brightness
    const double kz3 = 1.041 * z * z * z;
    const double eps = ((dhi + dni) / dhi + kz3) / (1 + kz3);   // sky clearness
    const double* f = PEREZ[std::upper_bound(PEREZ_EPS, PEREZ_EPS + 7, eps) - PEREZ_EPS];
    return {std::max(0.0, f[0] + f[1] * delta + f[2] * z), f[3] + f[4] * delta + f[5] * z};
}

// Diffuse fraction of the logistic model of Boland and Ridley (2008) from the clearness index.
double boland_diffuse_fraction(double kt) { return 1.0 / (1.0 + std::exp(8.645 * (kt - 0.613))); }

// Beam normal irradiance of the DISC model (Maxwell 1987, SERI/TR-215-3087) from the clearness index and the absolute air mass
// of Kasten (1966), capped at 12.
double disc_dni(double kt, double zenith_deg, double pr, double e0) {
    const double am = std::min(12.0, pr / (cosd(zenith_deg) + 0.15 * std::pow(93.885 - std::min(zenith_deg, 90.0), -1.253)));
    double a, b, c;
    if (kt <= 0.6) {
        a = 0.512 + kt * (-1.56 + kt * (2.286 - 2.222 * kt));
        b = 0.37 + 0.962 * kt;
        c = -0.28 + kt * (0.932 - 2.048 * kt);
    } else {
        a = -5.743 + kt * (21.77 + kt * (-27.49 + 11.56 * kt));
        b = 41.4 + kt * (-118.5 + kt * (66.05 + 31.9 * kt));
        c = -47.01 + kt * (184.2 + kt * (-222.0 + 73.81 * kt));
    }
    const double knc = 0.866 + am * (-0.122 + am * (0.0121 + am * (-0.000653 + 1.4e-05 * am)));
    return std::max(0.0, (knc - a - b * std::exp(c * am)) * e0);
}

// PVSPEC spectral mismatch factor M = a kc^b AMa^c (Pelland et al. 2020, 47th IEEE PVSC) from the clear-sky index kc and the
// absolute air mass; coefficients of the paper's module types (cdte: its CdTe module).
const double* pvspec_coeffs(const std::string& type) {
    static const double MONO[3] = {0.9845, -0.05169, 0.03034}, MULTI[3] = {0.9847, -0.05237, 0.03034}, CIGS[3] = {0.9791, -0.03904, 0.03096},
                        CDTE[3] = {1.002, -0.07108, 0.02465}, ASI[3] = {1.051, -0.1033, 0.009838};
    if (type == "monosi") return MONO;
    if (type == "multisi") return MULTI;
    if (type == "cigs") return CIGS;
    if (type == "cdte") return CDTE;
    if (type == "asi") return ASI;
    return nullptr;
}

// Terrain horizon elevation (deg) at an azimuth, linear between the equal azimuth steps of the profile (from north, clockwise).
double horizon_at(const std::vector<double>& h, double az) {
    const int n = int(h.size());
    const double x = std::fmod(std::fmod(az, 360.0) + 360.0, 360.0) * n / 360.0;
    const int i = int(x) % n;
    return h[i] + (x - std::floor(x)) * (h[(i + 1) % n] - h[i]);
}

} // namespace

// Beam incidence angle modifier from cos(angle of incidence): ASHRAE 1 - b0 (1/cos - 1); Martin and Ruiz (2001); or the physical
// model of De Soto et al. (2006): Fresnel transmission through the air-glass interface (and an antireflective coating with
// multiple reflections between its two interfaces, Duffie and Beckman) and absorption in the glass, relative to normal incidence.
double incidence_modifier(const PVParams& pv, double c) {
    if (c <= 0) return 0.0;
    if (pv.iam_model == "martin_ruiz") return (1 - std::exp(-c / pv.iam_ar)) / (1 - std::exp(-1 / pv.iam_ar));
    if (pv.iam_model != "physical") return std::clamp(1.0 - pv.iam_b0 * (1.0 / c - 1.0), 0.0, 1.0);
    const double n2 = pv.iam_n_ar > 0 ? pv.iam_n_ar : pv.iam_n, n3 = pv.iam_n;
    auto sq = [](double x) { return x * x; };
    const double s1 = std::sqrt(1 - c * c), s2 = s1 / n2, c2 = std::sqrt(1 - s2 * s2);
    const double r12s = sq((c - n2 * c2) / (c + n2 * c2)), r12p = sq((c2 - n2 * c) / (c2 + n2 * c)), r120 = sq((1 - n2) / (1 + n2));
    double ts = 1 - r12s, tp = 1 - r12p, t0 = 1 - r120, cg = c2;
    if (n3 != n2) {
        const double s3 = n2 / n3 * s2, c3 = std::sqrt(1 - s3 * s3);
        const double r23s = sq((n2 * c2 - n3 * c3) / (n2 * c2 + n3 * c3)), r23p = sq((n2 * c3 - n3 * c2) / (n2 * c3 + n3 * c2)), r230 = sq((n2 - n3) / (n2 + n3));
        ts *= (1 - r23s) / (1 - r23s * r12s);
        tp *= (1 - r23p) / (1 - r23p * r12p);
        t0 *= (1 - r230) / (1 - r230 * r120);
        cg = c3;
    }
    return (ts + tp) / 2 * std::exp(-pv.iam_kl / cg) / (t0 * std::exp(-pv.iam_kl));
}

// Diffuse IAM {sky, ground} of a plane at a tilt (deg, over 90 for the back of a module): the beam IAM averaged over the
// isotropic sky and ground in its view, weighted by the cosine of incidence (Marion 2017, Solar Energy 147, 344-348).
std::array<double, 2> diffuse_iam(const PVParams& pv, double tilt) {
    double sky = 0, sky_w = 0, gnd = 0, gnd_w = 0;
    constexpr int NT = 90, NP = 90;
    for (int i = 0; i < NT; ++i) {
        const double th = (i + 0.5) * 90.0 / NT, c = cosd(th), sn = sind(th), f = incidence_modifier(pv, c) * c * sn, wgt = c * sn;
        for (int j = 0; j < NP; ++j) {
            const double up = c * cosd(tilt) + sn * cosd((j + 0.5) * 360.0 / NP) * sind(tilt);   // vertical component of the direction
            if (up > 0) { sky += f; sky_w += wgt; } else { gnd += f; gnd_w += wgt; }
        }
    }
    return {sky_w > 0 ? sky / sky_w : 1.0, gnd_w > 0 ? gnd / gnd_w : 1.0};
}

// Share of the isotropic sky and of the horizon brightening band (Perez, about 6.5 deg high) that the terrain leaves in view of a
// plane (tilt, azimuth): sky elements weighted by their cosine of incidence, band azimuths by the horizontal cosine.
std::array<double, 2> horizon_view(const std::vector<double>& h, double tilt, double az_n) {
    double all = 0, vis = 0, band = 0, band_vis = 0;
    for (int j = 0; j < 180; ++j) {
        const double az = (j + 0.5) * 2.0, hz = horizon_at(h, az), ca = cosd(az - az_n);
        band += std::max(0.0, ca);
        band_vis += std::max(0.0, ca) * std::clamp(1.0 - hz / 6.5, 0.0, 1.0);
        for (int k = 0; k < 90; ++k) {
            const double e = k + 0.5, ci = sind(e) * cosd(tilt) + cosd(e) * sind(tilt) * ca;
            if (ci <= 0) continue;
            all += ci * cosd(e);
            vis += ci * cosd(e) * std::clamp(e + 0.5 - hz, 0.0, 1.0);
        }
    }
    return {all > 0 ? vis / all : 1.0, band > 0 ? band_vis / band : 1.0};
}

// Inverter part-load losses P_loss = k0 + k2 p^2 per unit of AC rating at AC output p (the self-consumption and ohmic terms of
// the loss model of Schmidt and Sauer 1996; Driesse et al. 2008). The peak efficiency 1 / (1 + 2 sqrt(k0 k2)) fixes k0 k2 and the
// European weighted efficiency the load of the peak, sqrt(k0 / k2); of two loads that fit, the one nearer 40 % is taken.
std::array<double, 2> inverter_curve(double eta_w, double eta_max) {
    constexpr double EURO[6][2] = {{0.05, 0.03}, {0.10, 0.06}, {0.20, 0.13}, {0.30, 0.10}, {0.50, 0.48}, {1.00, 0.20}};
    const double r = (1 / eta_max - 1) / 2;
    auto euro = [&](double pk) {
        double e = 0;
        for (const auto& x : EURO) e += x[1] * x[0] / (x[0] + r * pk + r / pk * x[0] * x[0]);
        return e;
    };
    double best = 0.4, err = 1e9;
    for (int i = 1; i <= 1000; ++i) {
        const double pk = 0.001 * i, d = std::fabs(euro(pk) - eta_w);
        if (d < err - 2e-6 || (d < err + 2e-6 && std::fabs(pk - 0.4) < std::fabs(best - 0.4))) { err = std::min(err, d); best = pk; }
    }
    return {r * best, r / best};
}

namespace {
struct Orientation { double tilt, azimuth, shade_frac, rot; };   // rot: rotation of the row's cross-section (tilt of fixed rows)

Orientation orientation(const PVParams& pv, const SunPos& s) {
    double sz = std::sin(s.zenith_deg * D2R);
    double sun_e = sz * sind(s.azimuth_deg), sun_n = sz * cosd(s.azimuth_deg), sun_u = s.cos_zenith;
    if (pv.mount == "tracker" && (pv.tracker_axis_tilt != 0 || pv.tracker_cross_slope != 0)) {
        // Tilted axis or rows on a slope across the axis: the sun projected on the plane across the axis, backtracking on the
        // slope (Anderson and Mikofski 2020, NREL/TP-5K00-76626), the module plane from the rotation (Marion and Dobos 2013,
        // NREL/TP-6A20-58891). Rotation > 0 turns the modules towards axis azimuth + 90.
        const double a = pv.tracker_axis_azimuth, bt = pv.tracker_axis_tilt, bc = pv.tracker_cross_slope;
        double theta = 0, shade = 0;
        if (sun_u > 0) {
            const double ideal = std::atan2(sun_e * cosd(a) - sun_n * sind(a),
                                            sun_e * sind(a) * sind(bt) + sun_n * sind(bt) * cosd(a) + sun_u * cosd(bt)) * R2D;
            const double gap = pv.gcr > 0 ? std::fabs(cosd(ideal - bc)) / (pv.gcr * cosd(bc)) : 2.0;   // projected axis spacing / width
            theta = ideal;
            if (pv.backtracking && gap < 1) theta = ideal - (ideal >= 0 ? 1.0 : -1.0) * std::acos(gap) * R2D;
            theta = std::clamp(theta, -pv.tracker_max_angle, pv.tracker_max_angle);
            if (!pv.backtracking && pv.row_shading) shade = std::clamp(1.0 - gap / cosd(ideal - theta), 0.0, 1.0);
        }
        const double ne = -sind(bt) * sind(a) * cosd(theta) + cosd(a) * sind(theta);
        const double nn = -sind(bt) * cosd(a) * cosd(theta) - sind(a) * sind(theta);
        const double tilt = std::acos(std::clamp(cosd(bt) * cosd(theta), -1.0, 1.0)) * R2D;
        const double az = tilt < 1e-9 ? a + 90.0 : std::atan2(ne, nn) * R2D;
        return {tilt, std::fmod(az + 720.0, 360.0), shade, std::fabs(theta)};
    }
    if (pv.mount == "tracker") {
        if (sun_u <= 0) return {0.0, pv.tracker_axis_azimuth + 90.0, 0.0, 0.0};
        double a = pv.tracker_axis_azimuth;
        double pe = cosd(a), pn = -sind(a);           // horizontal direction perpendicular to the axis
        double theta = std::atan2(sun_e * pe + sun_n * pn, sun_u) * R2D;
        double shade = 0.0;
        if (pv.backtracking && pv.gcr > 0) {
            double temp = std::min(1.0, cosd(theta) / pv.gcr);
            theta = theta - (theta >= 0 ? 1.0 : -1.0) * std::acos(temp) * R2D;
        } else if (pv.row_shading && pv.gcr > 0) {
            const double rot = std::min(std::fabs(theta), pv.tracker_max_angle);
            shade = std::clamp(1.0 - cosd(std::fabs(theta)) / (pv.gcr * cosd(std::fabs(theta) - rot)), 0.0, 1.0);
        }
        theta = std::clamp(theta, -pv.tracker_max_angle, pv.tracker_max_angle);
        double az = theta >= 0 ? a + 90.0 : a - 90.0;
        return {std::fabs(theta), std::fmod(az + 360.0, 360.0), shade, std::fabs(theta)};
    }
    // Fixed rows: beam shading from the row in front (infinite-row 2-D model).
    double shade = 0.0;
    if (pv.row_shading && pv.gcr > 0 && pv.tilt > 0 && sun_u > 0) {
        double elev = 90.0 - s.zenith_deg;
        double c = cosd(s.azimuth_deg - pv.azimuth);
        if (c > 1e-6) {
            double ap = std::atan(std::tan(elev * D2R) / c) * R2D;   // profile angle
            double denom = sind(ap + pv.tilt);
            if (denom > 1e-6) shade = std::clamp(1.0 - (1.0 / pv.gcr) * sind(ap) / denom, 0.0, 1.0);
        }
    }
    return {pv.tilt, pv.azimuth, shade, pv.tilt};
}
} // namespace

RowView row_view(double tilt, double gcr) {
    const double P = 1.0 / gcr, c = cosd(tilt);
    const double near = std::sqrt(P * P - 2 * P * c + 1), far = std::sqrt(P * P + 2 * P * c + 1);
    return {0.5 * (1 + P - near), 0.5 * (1 + P - far), 0.5 * (1 + P - far), 0.5 * (1 + P - near)};
}

GroundView ground_view(double tilt, double gcr, double h) {
    GroundView g;
    g.tilt = tilt;
    g.gcr = gcr;
    const double P = 1.0 / gcr, dx = 0.5 * cosd(tilt), dz = 0.5 * sind(tilt), b = tilt * D2R;
    g.h = h = std::max(h, dz + 0.02);   // lower edge above the ground
    const int M = GroundView::STRIPS;
    g.sky.assign(M, 0.0); g.front.assign(M, 0.0); g.back.assign(M, 0.0);
    // Sky seen from the ground: the gaps between neighbouring rows (row k centred at k P, top edge towards -x), from 10 points
    // per strip. Rows beyond K hide only sky within 5 deg of the horizon.
    const int K = int(std::ceil(h * gcr / std::tan(5 * D2R))) + 2;
    constexpr int NG = 10;
    for (int s = 0; s < M; ++s)
        for (int j = 0; j < NG; ++j) {
            const double x = (s + (j + 0.5) / NG) * P / M;
            double lo_prev = 0;   // smaller edge angle of the row to the left
            for (int k = -K; k <= K; ++k) {
                const double a1 = std::atan2(h + dz, k * P - dx - x), a2 = std::atan2(h - dz, k * P + dx - x);
                if (k > -K) g.sky[s] += std::max(0.0, std::cos(std::max(a1, a2)) - std::cos(lo_prev)) / 2 / NG;
                lo_prev = std::min(a1, a2);
            }
        }
    // Ground seen from the row (front facing +x), averaged over 12 points of the slant: the front looks down between the module
    // plane and the lower edge of the row in front, the back between the lower edge of the row behind and the module plane. A
    // strip at angle a below the horizon counts sin(a - a_normal) / 2 between its edges. Strips more than KG pitches away take
    // the remainder of the closed-form total, spread evenly.
    constexpr int NS = 12, KG = 20;
    const RowView rv = row_view(tilt, gcr);
    for (int i = 0; i < NS; ++i) {
        const double u = (i + 0.5) / NS;                                      // 0 lower edge, 1 top edge
        const double px = dx - u * cosd(tilt), pz = h - dz + u * sind(tilt);  // point on the slant, height above the ground
        const double dep_behind = std::atan2(u * sind(tilt), px + P - dx), dep_front = std::atan2(u * sind(tilt), P + dx - px);
        const double back_lo = -PI + dep_behind, back_hi = -b, front_lo = -b, front_hi = -dep_front;
        auto add = [&](std::vector<double>& w, double lo, double hi, double normal) {
            double prev = 0;
            for (int k = -KG; k <= KG; ++k)
                for (int s = 0; s <= M; ++s) {
                    const double a = std::clamp(std::atan2(-pz, k * P + s * P / M - px), lo, hi);
                    if (s > 0) w[s - 1] += (std::sin(a - normal) - std::sin(prev - normal)) / 2 / NS;
                    prev = a;
                }
        };
        add(g.back, back_lo, back_hi, -PI / 2 - b);
        add(g.front, front_lo, front_hi, PI / 2 - b);
    }
    double fb = 0, ff = 0;
    for (int s = 0; s < M; ++s) { fb += g.back[s]; ff += g.front[s]; }
    for (int s = 0; s < M; ++s) { g.back[s] += (rv.back_ground - fb) / M; g.front[s] += (rv.front_ground - ff) / M; }
    return g;
}

std::array<double, 2> GroundView::reflected(double tan_phi, double beam_h, double dhi) const {
    // Beam shadow of row 0 on the ground (the light travels towards -x when the sun is in front), one interval per pitch of
    // width |cos tilt + sin tilt tan phi| for a row of width 1, at most the pitch.
    const double P = 1.0 / gcr, dx = 0.5 * cosd(tilt), dz = 0.5 * sind(tilt);
    const double e1 = -dx - (h + dz) * tan_phi, e2 = dx - (h - dz) * tan_phi;
    const double len = std::min(P, std::fabs(e2 - e1));
    double s0 = std::min(e1, e2);
    s0 -= std::floor(s0 / P) * P;
    const double sw = P / STRIPS;
    std::array<double, 2> r{0.0, 0.0};
    for (int s = 0; s < STRIPS; ++s) {
        const double a = s * sw, b = a + sw;
        auto ov = [&](double lo, double hi) { return std::max(0.0, std::min(b, hi) - std::max(a, lo)); };
        const double lit = 1.0 - std::min(1.0, (ov(s0, s0 + len) + ov(s0 - P, s0 + len - P)) / sw);
        const double gs = lit * beam_h + sky[s] * dhi;
        r[0] += front[s] * gs;
        r[1] += back[s] * gs;
    }
    return r;
}

LocalShift local_shift(const Project& p) {
    if (!p.wx.is_utc) return {0, 0.0};
    const double off = p.loc.utc_offset;
    // validate_project checks the range; routes that skip it still must not index with an overflowed shift
    if (!(std::fabs(off) <= 14)) throw std::runtime_error("UTC offset must be between -14 h and +14 h.");
    const double n = std::floor(off);
    return {int(n), off - n};
}

SunPos sun_position(double lat, double lon, int doy, double utc_hour) {
    double B = 2.0 * PI * (doy - 1 + (utc_hour - 12.0) / 24.0) / 365.0;
    double decl = 0.006918 - 0.399912 * std::cos(B) + 0.070257 * std::sin(B) - 0.006758 * std::cos(2 * B) +
                  0.000907 * std::sin(2 * B) - 0.002697 * std::cos(3 * B) + 0.00148 * std::sin(3 * B);
    double eot = equation_of_time(B);
    double tst = utc_hour * 60.0 + eot + 4.0 * lon;        // true solar time, minutes
    double ha = (tst / 4.0 - 180.0) * D2R;                 // hour angle
    double phi = lat * D2R;
    double cz = std::sin(phi) * std::sin(decl) + std::cos(phi) * std::cos(decl) * std::cos(ha);
    cz = std::clamp(cz, -1.0, 1.0);
    double zen = std::acos(cz) * R2D;
    double az = std::atan2(std::sin(ha), std::cos(ha) * std::sin(phi) - std::tan(decl) * std::cos(phi)) * R2D + 180.0;
    double e0 = 1367.0 * (1.00011 + 0.034221 * std::cos(B) + 0.00128 * std::sin(B) + 0.000719 * std::cos(2 * B) +
                          0.000077 * std::sin(2 * B));
    return {zen, std::fmod(az + 360.0, 360.0), cz, e0};
}

namespace {
// Sun position at the representative instant of hour i of the weather file, and that instant in UTC hours of the year.
SunPos sun_at(const Project& p, int i, double* t_utc_out = nullptr) {
    const Weather& w = p.wx;
    double t_utc = i + w.time_offset - (w.is_utc ? 0.0 : p.loc.utc_offset);
    t_utc = std::fmod(t_utc + HOURS, double(HOURS));
    if (t_utc_out) *t_utc_out = t_utc;
    return sun_position(p.loc.lat, p.loc.lon, int(t_utc / 24.0) + 1, std::fmod(t_utc, 24.0));
}

// Ineichen and Perez (2002) clear sky {GHI, DNI, DHI} from cos(zenith), the absolute air mass, extraterrestrial irradiance,
// elevation (m) and Linke turbidity, without the optional high air-mass enhancement term.
std::array<double, 3> ineichen(double cz, double am, double e0, double elevation, double tl) {
    if (cz <= 0) return {0.0, 0.0, 0.0};
    const double fh1 = std::exp(-elevation / 8000), fh2 = std::exp(-elevation / 1250);
    const double cg1 = 5.09e-05 * elevation + 0.868, cg2 = 3.92e-05 * elevation + 0.0387;
    const double ghi = cg1 * e0 * cz * std::exp(-cg2 * am * (fh1 + fh2 * (tl - 1)));
    const double b = 0.664 + 0.163 / fh1;
    const double dni = std::min(b * e0 * std::exp(-0.09 * am * (tl - 1)),
                                ghi * std::max(0.0, (1 - (0.1 - 0.2 * std::exp(-tl)) / (0.1 + 0.882 / fh1)) / cz));
    return {ghi, dni, ghi - dni * cz};
}

// Local month of UTC hour i (as the loss chain counts it).
int local_month(int i, LocalShift sh) { return month_of_day(((i + sh.n) % HOURS + HOURS) % HOURS / 24); }

// Linke turbidity by local month for the Ineichen clear sky: the typed value, or from the weather year the 5th percentile of
// the turbidity that reproduces the GHI of each hour with the sun above 17.5 deg (the clearest hours), limited to 2-8; a month
// with fewer than 40 such hours takes the value of the whole year.
std::array<double, 12> linke_by_month(const Project& p) {
    std::array<double, 12> tl;
    tl.fill(p.pv.linke_turbidity > 0 ? p.pv.linke_turbidity : 3.0);
    if (p.pv.linke_turbidity > 0 || p.wx.ghi.size() != HOURS) return tl;
    const double el = p.loc.elevation, pr = pressure_ratio(el), fh1 = std::exp(-el / 8000), fh2 = std::exp(-el / 1250);
    const double cg1 = 5.09e-05 * el + 0.868, cg2 = 3.92e-05 * el + 0.0387;
    const LocalShift sh = local_shift(p);
    std::vector<double> by[12], all;
    for (int i = 0; i < HOURS; ++i) {
        const double ghi = p.wx.ghi[i];
        if (!(ghi > 0)) continue;
        const SunPos s = sun_at(p, i);
        if (s.cos_zenith < 0.3) continue;
        const double x = ghi / (cg1 * s.extra_normal * s.cos_zenith);
        if (!(x > 0)) continue;
        const double t = 1 + (-std::log(x) / (cg2 * air_mass(s.zenith_deg) * pr) - fh1) / fh2;
        by[local_month(i, sh)].push_back(t);
        all.push_back(t);
    }
    auto p5 = [](std::vector<double> v) {
        std::nth_element(v.begin(), v.begin() + v.size() / 20, v.end());
        return v[v.size() / 20];
    };
    if (all.empty()) return tl;
    const double year = p5(all);
    for (int m = 0; m < 12; ++m) tl[m] = std::clamp(by[m].size() >= 40 ? p5(by[m]) : year, 2.0, 8.0);
    return tl;
}

// Monthly snow loss of Townsend and Powers (2011, 37th IEEE PVSC) with the string factor of Townsend and Previtali (2023): from
// the snowfall S (cm) and snow days N of the month and the month before, the relative humidity, the mean air temperature (deg C)
// and the plane-of-array irradiation (kWh/m2), the tilt, the slant height and the height of the lower edge (the published
// constants take inches). Trackers count at their largest rotation with half the table width.
std::array<double, 12> townsend_loss(const PVParams& pv, const std::array<double, 12>& poa_kwh, const std::array<double, 12>& tamb) {
    const bool tracker = pv.mount == "tracker";
    const double tilt = tracker ? pv.tracker_max_angle : pv.tilt;
    const double slant = (tracker ? 0.5 : 1.0) * pv.row_width * 39.37;
    const double lower = std::max(0.0, pv.mount_height - 0.5 * pv.row_width * sind(tilt)) * 39.37;
    const double string_factor = pv.modules_up > 1 ? 0.75 : 1.0;
    auto eff = [&](int m) {   // effective snow, inches
        const double n = pv.snow_events[m], st = pv.snow_monthly[m] / 2.54;
        return n > 0 ? 0.5 * st * (1 + 1 / std::max(n, 1.0)) : 0.0;
    };
    std::array<double, 12> loss{};
    for (int m = 0; m < 12; ++m) {
        const double se = eff((m + 11) % 12) / 3 + 2 * eff(m) / 3;
        if (se <= 0 || poa_kwh[m] <= 0) continue;
        const double gamma = slant * se * cosd(tilt) / std::max(0.1, lower * lower - se * se) * 2 * std::tan(40 * D2R);
        loss[m] = std::clamp(5.7e4 * se * cosd(tilt) * cosd(tilt) * (1 - 0.51 * std::exp(-gamma)) * pv.snow_rh /
                                 ((tamb[m] + 273.15) * (tamb[m] + 273.15)) / std::pow(poa_kwh[m], 0.67) * string_factor,
                             0.0, 1.0);
    }
    return loss;
}
} // namespace

PVProfile compute_pv_profile(const Project& p) {
    const PVParams& pv = p.pv;
    const Weather& w = p.wx;
    PVProfile out;
    out.ac_per_kwp.assign(HOURS, 0.0);
    out.poa.assign(HOURS, 0.0);
    out.tcell.assign(HOURS, 0.0);
    out.ghi_local.assign(HOURS, 0.0);

    const bool have_split = w.dni.size() == HOURS && w.dhi.size() == HOURS;
    const bool disc = pv.decomposition == "disc", boland = pv.decomposition == "boland";
    const bool noct = pv.thermal_model == "noct";
    const double k_low = pv.low_irr_loss_200 / -std::log(0.2);
    // DC wiring on the "stc" basis is the loss at STC power. I^2R loss as a fraction of power is R*I/V: the current follows
    // the effective irradiance and the voltage falls with cell temperature and low light, so each hour the STC fraction is
    // scaled by p_stc^2 / p_temp. The "annual" basis takes a constant fraction.
    const bool wiring_stc = pv.dc_wiring_basis == "stc";
    const double dc_factor = (1 - pv.mismatch) * (wiring_stc ? 1.0 : 1 - pv.dc_wiring) * (1 - pv.lid) * (1 - pv.module_quality);
    const double ac_max = 1.0 / pv.dc_ac_ratio;            // inverter AC limit per kWp DC
    const double iam_diffuse = std::clamp(1.0 - pv.iam_b0 * (1.0 / cosd(59.0) - 1.0), 0.0, 1.0);
    const LocalShift sh = local_shift(p);
    const bool perez = pv.transposition == "perez";
    const bool monthly_soiling = pv.soiling_monthly.size() == 12;
    const bool monthly_albedo = pv.albedo_monthly.size() == 12;
    const double pr = pressure_ratio(p.loc.elevation);
    // Rows in the view of the front (diffuse row shading) and of the back (bifacial modules): 2-D view factors on rows of
    // width 1, so the mounting height counts relative to the table width
    const bool rows_ok = pv.gcr > 0 && pv.gcr < 1 && pv.row_width > 0;
    const bool vf_front = rows_ok && pv.row_shading && pv.diffuse_shading;
    const bool bifacial = rows_ok && pv.bifaciality > 0;
    const bool tracker = pv.mount == "tracker";
    const double h_rel = pv.row_width > 0 ? pv.mount_height / pv.row_width : 0.0;
    // Ground views: one for fixed tilt, one per whole degree of rotation for trackers (made when first needed)
    std::vector<GroundView> gview(tracker ? 91 : 1);
    auto ground_of = [&](double rot) -> const GroundView& {
        GroundView& g = gview[tracker ? std::clamp(int(std::lround(rot)), 0, 90) : 0];
        if (g.sky.empty()) g = ground_view(tracker ? std::round(rot) : rot, pv.gcr, h_rel);
        return g;
    };
    // Incidence angle modifiers: ASHRAE takes its 59 deg value for all diffuse light; the other models their sky and ground
    // averages for the plane, by whole degree of tilt (0-180, the back of a row over 90)
    const bool iam_ashrae = pv.iam_model != "martin_ruiz" && pv.iam_model != "physical";
    auto iam_beam = [&](double c) { return incidence_modifier(pv, c); };
    std::vector<std::array<double, 2>> diam(181, {-1.0, -1.0});
    auto iam_diff = [&](double tilt) -> const std::array<double, 2>& {
        auto& d = diam[std::clamp(int(std::lround(tilt)), 0, 180)];
        if (d[0] < 0) d = diffuse_iam(pv, std::round(tilt));
        return d;
    };
    // Terrain horizon: hides the sun (beam and circumsolar light) unless the weather beam is blocked already, and part of the sky
    // diffuse light of each plane; "data" (weather measured at the site) leaves both to the weather
    const bool horizon = !pv.horizon.empty() && pv.horizon_beam != "data";
    const bool horizon_beam = horizon && (pv.horizon_beam == "apply" || !w.horizon_in_beam);
    std::map<long, std::array<double, 2>> hview;
    auto hview_of = [&](double tilt, double az) -> const std::array<double, 2>& {
        const long key = std::lround(tilt) * 1000 + (std::lround(az) % 360 + 360) % 360;
        auto it = hview.find(key);
        if (it == hview.end()) it = hview.emplace(key, horizon_view(pv.horizon, std::round(tilt), std::round(az))).first;
        return it->second;
    };
    // Spectral correction on the clear-sky index of the chosen clear-sky model
    const double* spec = pvspec_coeffs(pv.spectral);
    const bool ineichen_cs = pv.clearsky == "ineichen";
    std::array<double, 12> tl{};
    if (spec && ineichen_cs) tl = linke_by_month(p);
    // Bypass-diode blocks up the table for the electrical effect of row shading (Martinez-Moreno et al. 2010)
    const bool blocks = pv.shade_model == "blocks";
    const double n_blocks = pv.bypass_blocks > 0 ? pv.bypass_blocks : std::max(1, pv.modules_up) * (pv.portrait ? 2.0 : 3.0);
    // Snow: hourly cover when the weather has snowfall (Marion et al. 2013: a fall over 1 cm/h covers the modules, which then
    // shed 19.7 % of their slant height times sin(tilt) per hour while the air is warmer than -POA / 80 W/m2 per deg C; a string
    // stops when any of its modules is covered, strings running along the rows); otherwise the monthly model.
    const bool snow_hourly = w.snow.size() == HOURS;
    const bool snow_monthly = !snow_hourly && pv.snow_monthly.size() == 12 && pv.snow_events.size() == 12;
    std::array<double, 12> snow_loss{};
    if (snow_monthly) {
        Project q = p;
        q.pv.snow_monthly.clear();
        const PVProfile base = compute_pv_profile(q);
        snow_loss = townsend_loss(pv, base.m_poa, base.m_tamb);
    }
    const double strings_up = std::max(1, pv.modules_up), shed = 0.197 * sind(tracker ? pv.tracker_max_angle : pv.tilt);
    double cover = 0;
    auto snow_step = [&](int i, double ta, double poa) {
        if (w.snow[i] > 1.0) cover = 1.0;
        else if (ta > -poa / 80.0) cover = std::max(0.0, cover - shed);
    };
    if (snow_hourly)   // the cover on 1 January from the last 31 days of the year, GHI in place of the plane-of-array irradiance
        for (int i = HOURS - 31 * 24; i < HOURS; ++i) snow_step(i, w.tamb.size() == HOURS ? w.tamb[i] : 25.0, std::max(0.0, w.ghi[i]));
    // Inverter part-load curve
    const bool inv_curve = pv.inverter_model == "curve";
    const std::array<double, 2> kinv = inv_curve ? inverter_curve(pv.inverter_eff, pv.inverter_eff_max) : std::array<double, 2>{0.0, 0.0};

    // Loss-chain accumulators (Wh/m2 for irradiance, kWh/kWp for energy)
    double s_ghi = 0, s_poa = 0, s_hor = 0, s_shade = 0, s_iam = 0, s_eff = 0, s_bif = 0, s_rear = 0, s_spec = 0, s_stc = 0, s_low = 0,
           s_temp = 0, s_snow = 0, s_dc = 0, s_inv = 0, s_clip = 0, s_ac = 0, s_avail = 0;

    for (int i = 0; i < HOURS; ++i) {
        double ghi = std::max(0.0, w.ghi[i]);
        double ta = w.tamb.size() == HOURS ? w.tamb[i] : 25.0;
        double ws = w.wind.size() == HOURS ? std::max(0.0, w.wind[i]) : 1.0;
        const int mo = local_month(i, sh);
        put_local(out.ghi_local, i, ghi, sh);
        s_ghi += ghi;
        out.m_ghi[mo] += ghi;
        out.m_tamb[mo] += ta;
        if (ghi <= 0) {
            if (snow_hourly) snow_step(i, ta, 0.0);
            put_local(out.tcell, i, ta, sh);
            continue;
        }

        double t_utc;
        SunPos s = sun_at(p, i, &t_utc);

        // Split GHI into beam and diffuse, keeping the three components consistent.
        double cz = s.cos_zenith;
        double dni = 0, dhi = ghi;
        if (cz > 0.0872) {
            if (have_split) {
                dhi = std::clamp(w.dhi[i], 0.0, ghi);
                dni = (ghi - dhi) / cz;
            } else {
                const double kt = std::min(1.0, ghi / (s.extra_normal * cz));
                if (disc) dni = std::min(disc_dni(kt, s.zenith_deg, pr, s.extra_normal), ghi / cz);
                else {
                    dhi = ghi * (boland ? boland_diffuse_fraction(kt) : erbs_diffuse_fraction(kt));
                    dni = (ghi - dhi) / cz;
                }
            }
            dni = std::min(dni, s.extra_normal);
            dhi = ghi - dni * cz;
        }
        out.m_dhi[mo] += dhi;
        const double alb = monthly_albedo ? pv.albedo_monthly[mo] : pv.albedo;

        Orientation o = orientation(pv, s);
        double sz = std::sin(s.zenith_deg * D2R);
        const double cos_aoi_raw = sind(o.tilt) * sind(o.azimuth) * sz * sind(s.azimuth_deg) +
                                   sind(o.tilt) * cosd(o.azimuth) * sz * cosd(s.azimuth_deg) + cosd(o.tilt) * cz;
        double cos_aoi = std::max(0.0, cos_aoi_raw);

        // Transposition. Sky diffuse = isotropic + circumsolar (share F1, from the sun's direction) + horizon band (F2).
        // Hay-Davies: F1 = DNI / E0 (anisotropy index), no horizon band. Perez 1990: F1 and F2 from sky clearness and brightness.
        double f1 = std::clamp(dni / s.extra_normal, 0.0, 1.0), f2 = 0.0;
        if (perez) std::tie(f1, f2) = dhi > 0 ? perez_f(dhi, dni, s.zenith_deg, s.extra_normal) : std::make_pair(0.0, 0.0);
        double rb = cos_aoi / std::max(cz, 0.0872);
        double beam = dni * cos_aoi;
        double sky = perez ? std::max(0.0, dhi * ((1 - f1) * (1 + cosd(o.tilt)) / 2.0 + f1 * rb + f2 * sind(o.tilt)))
                           : dhi * ((1 - f1) * (1 + cosd(o.tilt)) / 2.0 + f1 * rb);
        double ground = ghi * alb * (1 - cosd(o.tilt)) / 2.0;
        double poa = beam + sky + ground;
        s_poa += poa;
        out.m_poa[mo] += poa;

        // Terrain horizon: the share of the hour (10 instants) with the sun above it lets through beam and circumsolar light;
        // the isotropic sky and the horizon band take the share of them the terrain leaves in view of the plane.
        double vis = 1.0;
        double circ = dhi * f1 * rb;   // circumsolar light on the plane
        if (horizon) {
            if (horizon_beam) {
                int up = 0, seen = 0;
                for (int k = 0; k < 10; ++k) {
                    const double tk = std::fmod(t_utc - 0.5 + (k + 0.5) / 10 + HOURS, double(HOURS));
                    const SunPos sk = sun_position(p.loc.lat, p.loc.lon, int(tk / 24.0) + 1, std::fmod(tk, 24.0));
                    if (sk.zenith_deg >= 90) continue;
                    ++up;
                    if (90 - sk.zenith_deg > horizon_at(pv.horizon, sk.azimuth_deg)) ++seen;
                }
                vis = up ? double(seen) / up : 1.0;
            }
            const std::array<double, 2>& hv = hview_of(o.tilt, o.azimuth);
            const double band = perez ? dhi * f2 * sind(o.tilt) : 0.0;
            beam *= vis;
            sky = std::max(0.0, (sky - circ - band) * hv[0] + circ * vis + band * hv[1]);
            circ *= vis;
            s_hor += beam + sky + ground;
        }

        // Light reflected by the ground between the rows towards the front and the back of a row (before albedo): beam outside
        // the rows' shadows and sky diffuse by each strip's view of the sky between the rows; phi is the sun's zenith projected
        // on the plane across the rows, beyond 85 deg the ground counts as shaded.
        std::array<double, 2> g_refl{0.0, 0.0};
        RowView rv{};
        if (vf_front || bifacial) {
            rv = row_view(o.rot, pv.gcr);
            const double tan_phi = cosd(s.azimuth_deg - o.azimuth) * std::tan(std::min(s.zenith_deg, 89.0) * D2R);
            g_refl = ground_of(o.rot).reflected(tan_phi, std::fabs(tan_phi) < std::tan(85 * D2R) ? dni * vis * cz : 0.0, dhi);
        }

        // Beam on the unshaded part; with bypass-diode blocks, every block the shadow touches also loses the beam on its unshaded
        // cells: (1 - F) (1 - N_shaded / (N_blocks + 1)) (Martinez-Moreno et al. 2010, Sol. Energy Mater. Sol. Cells 94, 2298).
        const double f_sh = o.shade_frac;
        const double sf = blocks && f_sh > 0 ? (1 - f_sh) * (1 - std::ceil(f_sh * n_blocks - 1e-9) / (n_blocks + 1)) : 1.0 - f_sh;
        double beam_sh = beam * sf;
        double sky_sh = sky, ground_sh = ground, circ_sh = circ;
        if (vf_front) {
            // Rows in front also block light other than the beam: the circumsolar part with the beam, the isotropic and horizon
            // parts by the front's view of the sky, and the ground-reflected light, which comes from the partly shaded ground.
            sky_sh = std::min(sky, circ * sf + std::max(0.0, sky - circ) * rv.front_sky / ((1 + cosd(o.rot)) / 2.0));
            ground_sh = alb * g_refl[0];
            circ_sh = std::min(circ * sf, sky_sh);
        }
        double poa_sh = beam_sh + sky_sh + ground_sh;
        s_shade += poa_sh;
        if (snow_hourly) snow_step(i, ta, poa_sh);

        // Reflection: with the ASHRAE model all diffuse light at its 59 deg value; with the others the circumsolar light as beam
        // and the rest of the sky and the ground at their averages for the plane
        double iam_b = iam_beam(cos_aoi);
        double poa_iam;
        if (iam_ashrae) poa_iam = beam_sh * iam_b + (sky_sh + ground_sh) * iam_diffuse;
        else {
            const std::array<double, 2>& d = iam_diff(o.tilt);
            poa_iam = (beam_sh + circ_sh) * iam_b + (sky_sh - circ_sh) * d[0] + ground_sh * d[1];
        }
        s_iam += poa_iam;
        double geff = poa_iam * (1 - (monthly_soiling ? pv.soiling_monthly[mo] : pv.soiling));
        s_eff += geff;
        out.m_eff[mo] += geff;

        double g_temp = poa_sh;   // irradiance that heats the cells
        if (bifacial) {
            // Back of the row: light reflected by the ground between the rows, the sky above the row behind (isotropic and
            // horizon parts) and, when the sun is behind the modules, beam and circumsolar light outside the shadow of the row
            // behind. No soiling; the rear-side loss covers structure shading and the mismatch of uneven rear irradiance.
            const double back_open = (1 - cosd(o.rot)) / 2.0;
            const double rear_ground = alb * g_refl[1];
            double rear_sky = 0;
            if (back_open > 1e-9)
                rear_sky = std::max(0.0, dhi * ((1 - f1) * back_open + f2 * sind(o.rot))) * rv.back_sky / back_open;
            if (horizon) rear_sky *= hview_of(180 - o.tilt, o.azimuth + 180)[0];
            double rear_diffuse = rear_ground + rear_sky;
            double rear_beam = 0;
            const double cos_back = -cos_aoi_raw;
            if (cos_back > 0 && cz > 0.0872) {
                const double tan_phi_b = -cosd(s.azimuth_deg - o.azimuth) * std::tan(s.zenith_deg * D2R);
                const double x = pv.gcr * (sind(o.rot) * tan_phi_b - cosd(o.rot));
                const double shade_b = x > 1 ? 1.0 - 1.0 / x : 0.0;
                rear_beam = (dni + dhi * f1 / cz) * vis * cos_back * (1 - shade_b);
            }
            const double rear = rear_diffuse + rear_beam;
            double rear_iam;
            if (iam_ashrae) rear_iam = rear_diffuse * iam_diffuse + rear_beam * iam_beam(cos_back);
            else {
                const std::array<double, 2>& d = iam_diff(180 - o.tilt);
                rear_iam = rear_ground * d[1] + rear_sky * d[0] + rear_beam * iam_beam(cos_back);
            }
            const double rear_eff = pv.bifaciality * (1 - pv.rear_loss) * rear_iam;
            g_temp += pv.bifaciality * rear;
            geff += rear_eff;
            s_rear += rear;
        }
        s_bif += geff;
        if (spec) {
            // PVSPEC on the hour's clear-sky index (within 0.1-1.2) and absolute air mass (within 1-10)
            const double am = air_mass(s.zenith_deg) * pr;
            const double cs = ineichen_cs ? ineichen(cz, am, s.extra_normal, p.loc.elevation, tl[mo])[0] : haurwitz_ghi(cz);
            const double kc = cs > 1 ? std::clamp(ghi / cs, 0.1, 1.2) : 1.0, ama = std::clamp(am, 1.0, 10.0);
            geff *= spec[0] * std::pow(kc, spec[1]) * std::pow(ama, spec[2]);
        }
        s_spec += geff;

        double p_stc = geff / 1000.0;                       // kW per kWp at STC efficiency
        s_stc += p_stc;
        double f_low = geff > 10 ? std::clamp(1.0 + k_low * std::log(geff / 1000.0), 0.0, 1.03) : 0.0;
        double p_low = p_stc * f_low;
        s_low += p_low;
        double tc = noct ? ta + (pv.noct - 20.0) / 800.0 * g_temp
                                               : ta + g_temp * pv.absorptance * (1 - pv.module_eff) / (pv.uc + pv.uv * ws);
        double p_temp = std::max(0.0, p_low * (1 + pv.gamma_pmax * (tc - 25.0)));
        s_temp += p_temp;
        double p_snow = p_temp;
        if (snow_hourly) p_snow *= 1 - std::ceil(cover * strings_up - 1e-9) / strings_up;
        else if (snow_monthly) p_snow *= 1 - snow_loss[mo];
        s_snow += p_snow;
        double p_dc = p_snow * dc_factor;
        if (wiring_stc && p_temp > 0) p_dc *= 1 - pv.dc_wiring * p_stc * p_stc / p_temp;   // I^2R: loss fraction ~ I/V, I ~ p_stc, V ~ p_temp/p_stc
        s_dc += p_dc;
        out.m_dc[mo] += p_dc;
        double p_inv;
        if (inv_curve) {   // AC output y of DC input x, both per unit of the AC rating: x = y + k0 + k2 y^2
            const double x = p_dc / ac_max;
            p_inv = x > kinv[0] ? (std::sqrt(1 + 4 * kinv[1] * (x - kinv[0])) - 1) / (2 * kinv[1]) * ac_max : 0.0;
        } else p_inv = p_dc * pv.inverter_eff;
        s_inv += p_inv;
        double p_clip = std::min(p_inv, ac_max);
        s_clip += p_clip;
        double p_ac = p_clip * (1 - pv.ac_losses);
        s_ac += p_ac;
        double p_out = p_ac * pv.availability;
        s_avail += p_out;
        out.m_avail[mo] += p_out;

        put_local(out.ac_per_kwp, i, p_out, sh);
        put_local(out.poa, i, poa_sh, sh);
        put_local(out.tcell, i, tc, sh);
    }

    auto irr = [](const char* n, double wh) { return LossStep{n, wh / 1000.0, true}; };
    auto en = [](const char* n, double kwh) { return LossStep{n, kwh, false}; };
    out.losses = {irr("Global horizontal irradiation", s_ghi), irr("Global incident in collector plane", s_poa)};
    if (horizon) out.losses.push_back(irr("After terrain horizon", s_hor));
    out.losses.insert(out.losses.end(), {irr("After near/row shading", s_shade), irr("After IAM (reflection)", s_iam),
                                         irr("Effective irradiation (after soiling)", s_eff)});
    if (bifacial) out.losses.push_back(irr("Effective incl. bifacial rear side", s_bif));
    if (spec) out.losses.push_back(irr("After spectral correction", s_spec));
    out.losses.insert(out.losses.end(), {en("Array nominal energy at STC", s_stc), en("After low-irradiance loss", s_low),
                                         en("After temperature loss", s_temp)});
    if (snow_hourly || snow_monthly) out.losses.push_back(en("After snow cover", s_snow));
    out.losses.insert(out.losses.end(), {en("After mismatch, wiring, LID, quality", s_dc), en("After inverter efficiency", s_inv),
                                         en("After inverter clipping", s_clip), en("After AC / transformer losses", s_ac),
                                         en("After availability (energy available)", s_avail)});
    out.rear_annual = s_rear / 1000.0;
    out.specific_yield = s_avail;
    out.ghi_annual = s_ghi / 1000.0;
    out.poa_annual = s_poa / 1000.0;
    out.performance_ratio = s_poa > 0 ? s_avail / (s_poa / 1000.0) : 0.0;
    for (int m = 0; m < 12; ++m) {
        const int days = (m < 11 ? MONTH_START[m + 1] : 365) - MONTH_START[m];
        out.m_ghi[m] /= 1000.0; out.m_dhi[m] /= 1000.0; out.m_poa[m] /= 1000.0; out.m_eff[m] /= 1000.0;
        out.m_tamb[m] /= days * 24.0;
    }
    return out;
}

std::vector<double> clearsky_ghi(const Project& p) {
    std::vector<double> g(HOURS, 0.0);
    const bool ineichen_cs = p.pv.clearsky == "ineichen";
    const std::array<double, 12> tl = ineichen_cs ? linke_by_month(p) : std::array<double, 12>{};
    const LocalShift sh = ineichen_cs ? local_shift(p) : LocalShift{0, 0.0};
    const double pr = pressure_ratio(p.loc.elevation);
    for (int i = 0; i < HOURS; ++i) {
        const SunPos s = sun_at(p, i);
        g[i] = ineichen_cs ? ineichen(s.cos_zenith, air_mass(s.zenith_deg) * pr, s.extra_normal, p.loc.elevation, tl[local_month(i, sh)])[0]
                           : haurwitz_ghi(s.cos_zenith);
    }
    return g;
}

std::vector<double> clearsky_pv_per_kwp(const Project& p) {
    Project q = p;
    q.wx.snow.clear();   // a clear sky has no snowfall; the monthly snow loss stays
    if (p.pv.clearsky != "ineichen") {
        q.wx.ghi = clearsky_ghi(p);
        q.wx.dni.clear();
        q.wx.dhi.clear();
        return compute_pv_profile(q).ac_per_kwp;
    }
    // Ineichen gives its own beam and diffuse split
    const std::array<double, 12> tl = linke_by_month(p);
    const LocalShift sh = local_shift(p);
    const double pr = pressure_ratio(p.loc.elevation);
    q.wx.ghi.assign(HOURS, 0.0); q.wx.dni.assign(HOURS, 0.0); q.wx.dhi.assign(HOURS, 0.0);
    for (int i = 0; i < HOURS; ++i) {
        const SunPos s = sun_at(p, i);
        const std::array<double, 3> c = ineichen(s.cos_zenith, air_mass(s.zenith_deg) * pr, s.extra_normal, p.loc.elevation, tl[local_month(i, sh)]);
        q.wx.ghi[i] = c[0]; q.wx.dni[i] = c[1]; q.wx.dhi[i] = c[2];
    }
    return compute_pv_profile(q).ac_per_kwp;
}

std::vector<std::pair<double, double>> tilt_scan(Project p, double from, double to, double step) {
    std::vector<std::pair<double, double>> r;
    p.pv.mount = "fixed";
    for (double t = from; t <= to + 1e-9; t += step) {
        p.pv.tilt = t;
        r.emplace_back(t, compute_pv_profile(p).specific_yield);
    }
    return r;
}

std::vector<double> wind_per_turbine(const Project& p) {
    // Power-law shear to hub height, then the turbine power curve (cubic or linear between cut-in and rated).
    const WindParams& w = p.wind;
    std::vector<double> out(HOURS, 0.0);
    if (p.wx.wind.size() != HOURS) return out;
    const double shear = std::pow(std::max(1.0, w.hub_height) / std::max(1.0, w.ref_height), w.shear_alpha);
    const LocalShift sh = local_shift(p);
    for (int i = 0; i < HOURS; ++i) {
        const double v = std::max(0.0, p.wx.wind[i]) * shear;
        double pw = 0.0;
        if (v >= w.v_in && v < w.v_out) {
            if (v >= w.v_rated) pw = w.rated_kw;
            else if (w.curve == "linear") pw = w.rated_kw * (v - w.v_in) / (w.v_rated - w.v_in);
            else pw = w.rated_kw * (v * v * v - w.v_in * w.v_in * w.v_in) / (w.v_rated * w.v_rated * w.v_rated - w.v_in * w.v_in * w.v_in);
        }
        put_local(out, i, pw * (1 - w.losses) * w.availability, sh);
    }
    return out;
}
