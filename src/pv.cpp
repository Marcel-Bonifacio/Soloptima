#include "pv.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

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

// First day of each month in a non-leap year (0-based day of year).
constexpr int MONTH_START[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
int month_of_day(int d) { return int(std::upper_bound(MONTH_START, MONTH_START + 12, d) - MONTH_START) - 1; }

struct Orientation { double tilt, azimuth, shade_frac; };

Orientation orientation(const PVParams& pv, const SunPos& s) {
    double sz = std::sin(s.zenith_deg * D2R);
    double sun_e = sz * sind(s.azimuth_deg), sun_n = sz * cosd(s.azimuth_deg), sun_u = s.cos_zenith;
    if (pv.mount == "tracker") {
        if (sun_u <= 0) return {0.0, pv.tracker_axis_azimuth + 90.0, 0.0};
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
        return {std::fabs(theta), std::fmod(az + 360.0, 360.0), shade};
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
    return {pv.tilt, pv.azimuth, shade};
}
} // namespace

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
    double eot = 229.18 * (0.000075 + 0.001868 * std::cos(B) - 0.032077 * std::sin(B) - 0.014615 * std::cos(2 * B) -
                           0.040849 * std::sin(2 * B));
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

PVProfile compute_pv_profile(const Project& p) {
    const PVParams& pv = p.pv;
    const Weather& w = p.wx;
    PVProfile out;
    out.ac_per_kwp.assign(HOURS, 0.0);
    out.poa.assign(HOURS, 0.0);
    out.tcell.assign(HOURS, 0.0);
    out.ghi_local.assign(HOURS, 0.0);

    const bool have_split = w.dni.size() == HOURS && w.dhi.size() == HOURS;
    const double k_low = pv.low_irr_loss_200 / -std::log(0.2);
    // DC wiring on the "stc" basis is the loss at STC power. I^2R loss as a fraction of power is R*I/V: the current follows
    // the effective irradiance and the voltage falls with cell temperature and low light, so each hour the STC fraction is
    // scaled by p_stc^2 / p_temp. The "annual" basis takes a constant fraction.
    const bool wiring_stc = pv.dc_wiring_basis == "stc";
    const double dc_factor = (1 - pv.mismatch) * (wiring_stc ? 1.0 : 1 - pv.dc_wiring) * (1 - pv.lid) * (1 - pv.module_quality);
    const double ac_max = 1.0 / pv.dc_ac_ratio;            // inverter AC limit per kWp DC
    const double iam_diffuse = std::clamp(1.0 - pv.iam_b0 * (1.0 / cosd(59.0) - 1.0), 0.0, 1.0);
    const LocalShift sh = local_shift(p);

    // Loss-chain accumulators (Wh/m2 for irradiance, kWh/kWp for energy)
    double s_ghi = 0, s_poa = 0, s_shade = 0, s_iam = 0, s_eff = 0, s_stc = 0, s_low = 0, s_temp = 0, s_dc = 0,
           s_inv = 0, s_clip = 0, s_ac = 0, s_avail = 0;

    for (int i = 0; i < HOURS; ++i) {
        double ghi = std::max(0.0, w.ghi[i]);
        double ta = w.tamb.size() == HOURS ? w.tamb[i] : 25.0;
        double ws = w.wind.size() == HOURS ? std::max(0.0, w.wind[i]) : 1.0;
        const int mo = month_of_day(((i + sh.n) % HOURS + HOURS) % HOURS / 24);   // local month
        put_local(out.ghi_local, i, ghi, sh);
        s_ghi += ghi;
        out.m_ghi[mo] += ghi;
        out.m_tamb[mo] += ta;
        if (ghi <= 0) { put_local(out.tcell, i, ta, sh); continue; }

        double t = i + w.time_offset;
        double t_utc = w.is_utc ? t : t - p.loc.utc_offset;
        t_utc = std::fmod(t_utc + HOURS, double(HOURS));
        int doy = int(t_utc / 24.0) + 1;
        SunPos s = sun_position(p.loc.lat, p.loc.lon, doy, std::fmod(t_utc, 24.0));

        // Split GHI into beam and diffuse, keeping the three components consistent.
        double cz = s.cos_zenith;
        double dni = 0, dhi = ghi;
        if (cz > 0.0872) {
            if (have_split) {
                dhi = std::clamp(w.dhi[i], 0.0, ghi);
                dni = (ghi - dhi) / cz;
            } else {
                double kt = std::min(1.0, ghi / (s.extra_normal * cz));
                dhi = ghi * erbs_diffuse_fraction(kt);
                dni = (ghi - dhi) / cz;
            }
            dni = std::min(dni, s.extra_normal);
            dhi = ghi - dni * cz;
        }
        out.m_dhi[mo] += dhi;

        Orientation o = orientation(pv, s);
        double sz = std::sin(s.zenith_deg * D2R);
        double cos_aoi = sind(o.tilt) * sind(o.azimuth) * sz * sind(s.azimuth_deg) +
                         sind(o.tilt) * cosd(o.azimuth) * sz * cosd(s.azimuth_deg) + cosd(o.tilt) * cz;
        cos_aoi = std::max(0.0, cos_aoi);

        // Hay-Davies transposition
        double ai = std::clamp(dni / s.extra_normal, 0.0, 1.0);
        double rb = cos_aoi / std::max(cz, 0.0872);
        double beam = dni * cos_aoi;
        double sky = dhi * ((1 - ai) * (1 + cosd(o.tilt)) / 2.0 + ai * rb);
        double ground = ghi * pv.albedo * (1 - cosd(o.tilt)) / 2.0;
        double poa = beam + sky + ground;
        s_poa += poa;
        out.m_poa[mo] += poa;

        double beam_sh = beam * (1.0 - o.shade_frac);
        double poa_sh = beam_sh + sky + ground;
        s_shade += poa_sh;

        double iam_b = cos_aoi > 0 ? std::clamp(1.0 - pv.iam_b0 * (1.0 / cos_aoi - 1.0), 0.0, 1.0) : 0.0;
        double poa_iam = beam_sh * iam_b + (sky + ground) * iam_diffuse;
        s_iam += poa_iam;
        double geff = poa_iam * (1 - pv.soiling);
        s_eff += geff;
        out.m_eff[mo] += geff;

        double p_stc = geff / 1000.0;                       // kW per kWp at STC efficiency
        s_stc += p_stc;
        double f_low = geff > 10 ? std::clamp(1.0 + k_low * std::log(geff / 1000.0), 0.0, 1.03) : 0.0;
        double p_low = p_stc * f_low;
        s_low += p_low;
        double tc = pv.thermal_model == "noct" ? ta + (pv.noct - 20.0) / 800.0 * poa_sh
                                               : ta + poa_sh * pv.absorptance * (1 - pv.module_eff) / (pv.uc + pv.uv * ws);
        double p_temp = std::max(0.0, p_low * (1 + pv.gamma_pmax * (tc - 25.0)));
        s_temp += p_temp;
        double p_dc = p_temp * dc_factor;
        if (wiring_stc && p_temp > 0) p_dc *= 1 - pv.dc_wiring * p_stc * p_stc / p_temp;   // I^2R: loss fraction ~ I/V, I ~ p_stc, V ~ p_temp/p_stc
        s_dc += p_dc;
        out.m_dc[mo] += p_dc;
        double p_inv = p_dc * pv.inverter_eff;
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
    out.losses = {irr("Global horizontal irradiation", s_ghi),
                  irr("Global incident in collector plane", s_poa),
                  irr("After near/row shading", s_shade),
                  irr("After IAM (reflection)", s_iam),
                  irr("Effective irradiation (after soiling)", s_eff),
                  en("Array nominal energy at STC", s_stc),
                  en("After low-irradiance loss", s_low),
                  en("After temperature loss", s_temp),
                  en("After mismatch, wiring, LID, quality", s_dc),
                  en("After inverter efficiency", s_inv),
                  en("After inverter clipping", s_clip),
                  en("After AC / transformer losses", s_ac),
                  en("After availability (energy available)", s_avail)};
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
    const Weather& w = p.wx;
    for (int i = 0; i < HOURS; ++i) {
        double t = i + w.time_offset;
        double t_utc = w.is_utc ? t : t - p.loc.utc_offset;
        t_utc = std::fmod(t_utc + HOURS, double(HOURS));
        SunPos s = sun_position(p.loc.lat, p.loc.lon, int(t_utc / 24.0) + 1, std::fmod(t_utc, 24.0));
        g[i] = haurwitz_ghi(s.cos_zenith);
    }
    return g;
}

std::vector<double> clearsky_pv_per_kwp(const Project& p) {
    Project q = p;
    q.wx.ghi = clearsky_ghi(p);
    q.wx.dni.clear();
    q.wx.dhi.clear();
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
