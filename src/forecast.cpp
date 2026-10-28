#include "forecast.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <random>

namespace {
inline int wrap(int t) { return ((t % HOURS) + HOURS) % HOURS; }
const double NaN = std::numeric_limits<double>::quiet_NaN();

// sum over hours [a, b) from a cyclic prefix sum cum[0..HOURS]
double rsum(const double* cum, int a, int b) {
    auto F = [&](int n) {
        int q = n >= 0 ? n / HOURS : -((-n + HOURS - 1) / HOURS);
        return q * cum[HOURS] + cum[n - q * HOURS];
    };
    return F(b) - F(a);
}

constexpr int NF = 6;                                                   // RLS features
constexpr int NB = 11;                                                  // RLS lead buckets
constexpr int REP_LEAD[NB] = {0, 1, 2, 3, 4, 7, 10, 15, 21, 30, 42};   // training lead per bucket
constexpr int ANALOG_DAYS = 60, ANALOG_K = 7, ENS_WINDOW = 14 * 24;

int bucket(int lead) {
    if (lead <= 3) return lead;
    if (lead <= 5) return 4;
    if (lead <= 8) return 5;
    if (lead <= 12) return 6;
    if (lead <= 18) return 7;
    if (lead <= 24) return 8;
    if (lead <= 36) return 9;
    return 10;
}

std::vector<double> ar1_series(unsigned seed, double rho) {
    std::mt19937 rng(seed);
    std::normal_distribution<double> nd(0.0, 1.0);
    std::vector<double> z(HOURS);
    double x = 0;
    const double s = std::sqrt(1 - rho * rho);
    for (int i = 0; i < HOURS; ++i) { x = rho * x + s * nd(rng); z[i] = x; }
    return z;
}
} // namespace

const std::vector<MethodInfo>& pv_forecast_methods() {
    static const std::vector<MethodInfo> m = {
        {"smart_persistence", "Smart persistence", "Clear-sky output x clear-sky index of the last 3 h (short lead) blended into the last 24 h."},
        {"persistence", "Persistence (same hour yesterday)", "Value at the same hour on the last observed day; reference for the skill score."},
        {"climatology", "30-day climatology", "Clear-sky output x mean clear-sky index of that hour over the last 30 days."},
        {"ets", "Exponential smoothing", "Exponentially smoothed clear-sky index per hour of day, plus a decaying correction from the latest hour."},
        {"rls", "Adaptive regression (RLS)", "Lead-specific linear model on recent, daily, persistence, climatology and smoothed indices; coefficients learnt online by recursive least squares."},
        {"analog", "Analog ensemble (k-NN)", "Finds the 7 past days whose last-24-h pattern best matches now and averages what followed."},
        {"ensemble", "Adaptive ensemble", "Blend of smart persistence, climatology, smoothing, regression and analog forecasts, weighted by each method's error over the last 14 days (separately intraday / day-ahead)."},
        {"mlp", "Neural network (MLP)", "Feed-forward network (10-16-16-1, ReLU, Adam) on lagged clear-sky indices, lead time and calendar; retrained every month on the preceding 330 days only."},
        {"perfect", "Perfect forecast (benchmark)", "Uses the actual future: the upper bound for any forecaster."},
        {"noisy", "Perfect + random error", "Actual values with correlated relative error: standard deviation sigma from 24 h lead, 0.3 sigma at lead 0. For robustness tests."}};
    return m;
}
const std::vector<MethodInfo>& load_forecast_methods() {
    static const std::vector<MethodInfo> m = {
        {"profile", "7-day profile + persistence", "Mean of the same hour over the last 7 days, corrected by the latest observed deviation."},
        {"persistence", "Persistence (same hour yesterday)", "Value at the same hour on the last observed day; reference for the skill score."},
        {"weekly", "Seasonal naive (same hour last week)", "Captures weekday / weekend patterns."},
        {"climatology", "30-day climatology", "Mean of that hour over the last 30 days."},
        {"ets", "Exponential smoothing", "Smoothed level per hour of day plus a decaying correction from the latest hour."},
        {"rls", "Adaptive regression (RLS)", "Lead-specific linear model learnt online by recursive least squares."},
        {"analog", "Analog ensemble (k-NN)", "Averages what followed the 7 most similar past days."},
        {"ensemble", "Adaptive ensemble", "Error-weighted blend of profile, weekly, smoothing, regression and analog forecasts."},
        {"mlp", "Neural network (MLP)", "Feed-forward network (10-16-16-1, ReLU, Adam) on lagged load, lead time and calendar; retrained monthly on past data only."},
        {"perfect", "Perfect forecast (benchmark)", "Uses the actual future."},
        {"noisy", "Perfect + random error", "Actual values with correlated relative error: standard deviation sigma from 24 h lead, 0.3 sigma at lead 0. For robustness tests."}};
    return m;
}

SeriesForecaster::SeriesForecaster(const std::string& method, const std::vector<double>& act, const std::vector<double>& ref,
                                   double noise_sigma, unsigned seed)
    : method_(method), pv_(!ref.empty()), sigma_(noise_sigma), act_(act) {
    act_.resize(HOURS, act_.empty() ? 0.0 : act_.back());
    const auto& list = pv_ ? pv_forecast_methods() : load_forecast_methods();
    if (std::none_of(list.begin(), list.end(), [&](const MethodInfo& m) { return m.id == method_; }))
        method_ = pv_ ? "smart_persistence" : "profile";

    if (pv_) {
        ref_ = ref;
        ref_.resize(HOURS, 0.0);
    } else {
        double mean = std::accumulate(act_.begin(), act_.end(), 0.0) / HOURS;
        ref_.assign(HOURS, mean > 0 ? mean : 1.0);
    }
    const double thr = pv_ ? 0.02 : -1.0;
    y_.assign(HOURS, NaN);
    for (int t = 0; t < HOURS; ++t)
        if (ref_[t] > thr) y_[t] = act_[t] / ref_[t];
    // forward-filled index (cyclic): night hours carry the last daylight value
    yff_ = y_;
    double last = 1.0;
    for (int pass = 0; pass < 2; ++pass)
        for (int t = 0; t < HOURS; ++t) {
            if (std::isfinite(y_[t])) last = y_[t];
            else yff_[t] = last;
        }
    cum_act_.assign(HOURS + 1, 0.0);
    cum_ref_.assign(HOURS + 1, 0.0);
    for (int t = 0; t < HOURS; ++t) {
        cum_act_[t + 1] = cum_act_[t] + act_[t];
        cum_ref_[t + 1] = cum_ref_[t] + (ref_[t] > thr ? ref_[t] : 0.0);
    }
    s30a_.assign(HOURS, 0.0);
    s30r_.assign(HOURS, 0.0);
    for (int t = 0; t < HOURS; ++t)
        for (int d = 1; d <= 30; ++d) {
            int k = wrap(t - 24 * d);
            if (ref_[k] > thr) { s30a_[t] += act_[k]; s30r_[t] += ref_[k]; }
        }
    if (method_ == "noisy") z_ = ar1_series(seed, 0.85);
    build_ets();
    if (method_ == "rls") build_rls();
    if (method_ == "analog") build_analog();
    if (method_ == "ensemble") build_ensemble(seed);
    if (method_ == "mlp") build_mlp(seed);
}

// ---------------------------------------------------------------- neural network forecaster
// A small multilayer perceptron in the spirit of Rajendran & Gebremedhin (2024, Front. Energy Res. 12:1363895),
// made causal: inputs are only quantities known at issue time (lagged indices, lead, calendar of the target hour),
// and the network is retrained at the start of every month on targets from the preceding 330 days.
namespace {
constexpr int NI = 10, NH = 16;
constexpr int NP = NH * NI + NH + NH * NH + NH + NH + 1;   // weights + biases
constexpr int MONTH_START[13] = {0, 744, 1416, 2160, 2880, 3624, 4344, 5088, 5832, 6552, 7296, 8016, 8760};

double mlp_forward(const double* w, const double* in, double* h1, double* h2) {
    const double *W1 = w, *b1 = W1 + NH * NI, *W2 = b1 + NH, *b2 = W2 + NH * NH, *W3 = b2 + NH, *b3 = W3 + NH;
    for (int j = 0; j < NH; ++j) { double a = b1[j]; for (int k = 0; k < NI; ++k) a += W1[j * NI + k] * in[k]; h1[j] = a > 0 ? a : 0; }
    for (int j = 0; j < NH; ++j) { double a = b2[j]; for (int k = 0; k < NH; ++k) a += W2[j * NH + k] * h1[k]; h2[j] = a > 0 ? a : 0; }
    double o = b3[0];
    for (int k = 0; k < NH; ++k) o += W3[k] * h2[k];
    return o;
}
} // namespace

void SeriesForecaster::mlp_inputs(int issue, int tgt, double* in) const {
    double x[NF];
    features(issue, tgt, x);
    const int lead = std::max(0, tgt - issue), t = wrap(tgt);
    const double hod = (t % 24 + 0.5) / 24.0 * 2 * 3.14159265358979, doy = (t / 24 + 0.5) / 365.0 * 2 * 3.14159265358979;
    in[0] = x[1]; in[1] = x[2]; in[2] = x[3]; in[3] = x[4]; in[4] = x[5];
    in[5] = std::min(lead, 48) / 48.0;
    in[6] = std::sin(hod); in[7] = std::cos(hod); in[8] = std::sin(doy); in[9] = std::cos(doy);
}

void SeriesForecaster::build_mlp(unsigned seed) {
    std::mt19937 rng(seed ^ 0x9e3779b9u);
    std::normal_distribution<double> nd(0.0, 1.0);
    std::vector<double> w(NP, 0.0), m(NP, 0.0), v(NP, 0.0), g(NP, 0.0);
    {   // He initialisation
        double* W1 = w.data(); double* W2 = W1 + NH * NI + NH; double* W3 = W2 + NH * NH + NH;
        for (int i = 0; i < NH * NI; ++i) W1[i] = nd(rng) * std::sqrt(2.0 / NI);
        for (int i = 0; i < NH * NH; ++i) W2[i] = nd(rng) * std::sqrt(2.0 / NH);
        for (int i = 0; i < NH; ++i) W3[i] = nd(rng) * std::sqrt(1.0 / NH);
        W3[NH] = 1.0;   // output bias starts at y = 1
    }
    const int LEADS[] = {0, 1, 2, 3, 6, 9, 12, 18, 24, 30, 36, 42};
    const double lr = 3e-3, b1 = 0.9, b2 = 0.999, eps = 1e-8;
    long step = 0;
    std::uniform_int_distribution<int> pick(0, 11);
    mlp_.assign(12, std::vector<double>());
    struct Sample { double in[NI], y; };
    std::vector<Sample> samples;
    samples.reserve(330 * 24 * 3);
    double h1[NH], h2[NH];
    double *gW1 = g.data(), *gb1 = gW1 + NH * NI, *gW2 = gb1 + NH, *gb2 = gW2 + NH * NH, *gW3 = gb2 + NH, *gb3 = gW3 + NH;
    const double *W2 = w.data() + NH * NI + NH, *W3 = W2 + NH * NH + NH;
    for (int mo = 0; mo < 12; ++mo) {
        // training window: targets in the 330 days before this month (cyclic year = the previous year's data)
        samples.clear();
        const int start = MONTH_START[mo];
        for (int t = start - 330 * 24; t < start; ++t) {
            const int tw = wrap(t);
            if (!std::isfinite(y_[tw])) continue;
            for (int r = 0; r < 3; ++r) {
                Sample& s = samples.emplace_back();
                mlp_inputs(t - LEADS[pick(rng)], t, s.in);
                s.y = y_[tw];
            }
        }
        const int epochs = mo == 0 ? 8 : 2;   // warm start after the first month
        for (int ep = 0; ep < epochs; ++ep) {
            std::shuffle(samples.begin(), samples.end(), rng);
            for (size_t b0 = 0; b0 < samples.size(); b0 += 32) {
                std::fill(g.begin(), g.end(), 0.0);
                const size_t b1e = std::min(samples.size(), b0 + 32);
                for (size_t s = b0; s < b1e; ++s) {
                    const double* in = samples[s].in;
                    const double out = mlp_forward(w.data(), in, h1, h2);
                    const double d = 2.0 * (out - samples[s].y) / double(b1e - b0);   // dMSE/dout
                    double d1[NH] = {};
                    for (int k = 0; k < NH; ++k) gW3[k] += d * h2[k];
                    gb3[0] += d;
                    for (int j = 0; j < NH; ++j) {
                        if (h2[j] <= 0) continue;
                        const double d2 = d * W3[j];
                        gb2[j] += d2;
                        for (int k = 0; k < NH; ++k) { gW2[j * NH + k] += d2 * h1[k]; d1[k] += d2 * W2[j * NH + k]; }
                    }
                    for (int j = 0; j < NH; ++j) {
                        if (h1[j] <= 0) continue;
                        gb1[j] += d1[j];
                        for (int k = 0; k < NI; ++k) gW1[j * NI + k] += d1[j] * in[k];
                    }
                }
                ++step;   // Adam update
                const double c1 = 1 - std::pow(b1, double(step)), c2 = 1 - std::pow(b2, double(step));
                for (int i = 0; i < NP; ++i) {
                    m[i] = b1 * m[i] + (1 - b1) * g[i];
                    v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
                    w[i] -= lr * (m[i] / c1) / (std::sqrt(v[i] / c2) + eps);
                }
            }
        }
        mlp_[mo] = w;
    }
}

double SeriesForecaster::ratio(int a, int b) const {
    double sr = rsum(cum_ref_.data(), a, b);
    return sr > (pv_ ? 0.05 : 1e-9) ? rsum(cum_act_.data(), a, b) / sr : NaN;
}

void SeriesForecaster::build_ets() {
    const double alpha = pv_ ? 0.25 : 0.3;
    lev_.assign(HOURS, 1.0);
    for (int h = 0; h < 24; ++h) {            // initial level = annual mean index of that hour
        double sa = 0, sr = 0;
        for (int t = h; t < HOURS; t += 24) if (std::isfinite(y_[t])) { sa += act_[t]; sr += ref_[t]; }
        double init = sr > 0 ? sa / sr : 1.0;
        for (int t = h; t < HOURS; t += 24) lev_[t] = init;
    }
    for (int pass = 0; pass < 2; ++pass)      // second pass: start of year sees the end of the (cyclic) year
        for (int t = 0; t < HOURS; ++t) {
            double prev = lev_[wrap(t - 24)];
            lev_[t] = std::isfinite(y_[t]) ? alpha * y_[t] + (1 - alpha) * prev : prev;
        }
}

void SeriesForecaster::features(int issue, int tgt, double* x) const {
    const int lead = std::max(0, tgt - issue), kmin = lead / 24 + 1;
    double r24 = ratio(issue - 24, issue);
    if (!std::isfinite(r24)) r24 = 1.0;
    double r3 = ratio(issue - 3, issue);
    if (!std::isfinite(r3)) r3 = yff_[wrap(issue - 1)];
    const int tp = wrap(tgt - 24 * kmin), t1 = wrap(tgt - 24 * (kmin - 1));
    x[0] = 1.0;
    x[1] = r3;
    x[2] = r24;
    x[3] = std::isfinite(y_[tp]) ? y_[tp] : yff_[tp];
    x[4] = s30r_[t1] > 1e-9 ? s30a_[t1] / s30r_[t1] : r24;
    x[5] = lev_[tp];
}

void SeriesForecaster::build_rls() {
    // One recursive-least-squares model per lead bucket, trained hour by hour on forecasts whose target has
    // just been observed. Coefficients are snapshotted at the start of each day and used for that day's forecasts.
    const double lambda = 0.999;
    std::vector<double> th(NB * NF, 0.0), P(NB * NF * NF, 0.0);
    for (int b = 0; b < NB; ++b) {
        th[b * NF + 3] = 0.5; th[b * NF + 5] = 0.5;            // start near "persistence / smoothing" blend
        for (int i = 0; i < NF; ++i) P[(b * NF + i) * NF + i] = 10.0;
    }
    theta_.assign(365 * NB * NF, 0.0);
    double x[NF], Px[NF];
    for (int pass = 0; pass < 2; ++pass)
        for (int d = 0; d < 365; ++d) {
            if (pass == 1) std::copy(th.begin(), th.end(), theta_.begin() + d * NB * NF);
            for (int h = 0; h < 24; ++h) {
                const int t = d * 24 + h;
                if (!std::isfinite(y_[t])) continue;
                for (int b = 0; b < NB; ++b) {
                    features(t - REP_LEAD[b], t, x);
                    double* T = &th[b * NF];
                    double* Pb = &P[b * NF * NF];
                    double den = lambda, pred = 0;
                    for (int i = 0; i < NF; ++i) {
                        Px[i] = 0;
                        for (int j = 0; j < NF; ++j) Px[i] += Pb[i * NF + j] * x[j];
                        den += x[i] * Px[i];
                        pred += T[i] * x[i];
                    }
                    const double err = y_[t] - pred;
                    for (int i = 0; i < NF; ++i) T[i] += Px[i] / den * err;
                    for (int i = 0; i < NF; ++i)
                        for (int j = 0; j < NF; ++j) Pb[i * NF + j] = (Pb[i * NF + j] - Px[i] * Px[j] / den) / lambda;
                }
            }
        }
}

void SeriesForecaster::build_analog() {
    analog_.assign(size_t(HOURS) * ANALOG_DAYS, 0);
    std::vector<std::pair<double, int>> dist(ANALOG_DAYS);
    double ya[24], wa[24];   // the last 24 h before i, and their weights
    for (int i = 0; i < HOURS; ++i) {
        for (int k = 1; k <= 24; ++k) { const int a = wrap(i - k); ya[k - 1] = yff_[a]; wa[k - 1] = pv_ ? ref_[a] : 1.0; }
        for (int m = 1; m <= ANALOG_DAYS; ++m) {
            double s = 0;
            for (int k = 1; k <= 24; ++k) {
                const double e = ya[k - 1] - yff_[wrap(i - 24 * m - k)];
                s += wa[k - 1] * e * e;
            }
            dist[m - 1] = {s, m};
        }
        std::sort(dist.begin(), dist.end());
        for (int m = 0; m < ANALOG_DAYS; ++m) analog_[size_t(i) * ANALOG_DAYS + m] = (unsigned char)dist[m].second;
    }
}

void SeriesForecaster::build_ensemble(unsigned seed) {
    const std::vector<std::string> ids = pv_ ? std::vector<std::string>{"smart_persistence", "climatology", "ets", "rls", "analog"}
                                             : std::vector<std::string>{"profile", "weekly", "ets", "rls", "analog"};
    const std::vector<double> no_ref;
    for (const auto& id : ids) members_.push_back(std::make_unique<SeriesForecaster>(id, act_, pv_ ? ref_ : no_ref, sigma_, seed));
    const size_t n = members_.size();
    cum_err_intra_.assign(n * (HOURS + 1), 0.0);
    cum_err_day_.assign(n * (HOURS + 1), 0.0);
    for (size_t m = 0; m < n; ++m) {
        double* ci = &cum_err_intra_[m * (HOURS + 1)];
        double* cd = &cum_err_day_[m * (HOURS + 1)];
        for (int t = 0; t < HOURS; ++t) {
            const double ei = (*members_[m])(t, t) - act_[t], ed = (*members_[m])(t - 24, t) - act_[t];
            ci[t + 1] = ci[t] + ei * ei;
            cd[t + 1] = cd[t] + ed * ed;
        }
    }
}

double SeriesForecaster::base(const std::string& m, int issue, int tgt) const {
    const int lead = std::max(0, tgt - issue), kmin = lead / 24 + 1, t = wrap(tgt);
    if (m == "smart_persistence") {
        double k24 = ratio(issue - 24, issue);
        if (!std::isfinite(k24)) k24 = 1.0;
        double k3 = ratio(issue - 3, issue);
        if (!std::isfinite(k3)) k3 = k24;
        const double w = std::exp(-lead / 3.0);
        return w * k3 + (1 - w) * k24;
    }
    if (m == "profile") {
        auto prof = [&](int tt, int k0) { double s = 0; for (int k = k0; k < k0 + 7; ++k) s += yff_[wrap(tt - 24 * k)]; return s / 7.0; };
        const double dev = yff_[wrap(issue - 1)] - prof(issue - 1, 1);
        return prof(tgt, kmin) + dev * std::exp(-lead / 4.0);
    }
    if (m == "climatology") {
        const int t1 = wrap(tgt - 24 * (kmin - 1));
        return s30r_[t1] > 1e-9 ? s30a_[t1] / s30r_[t1] : base("smart_persistence", issue, tgt);
    }
    if (m == "ets") {
        const int last = wrap(issue - 1);
        const double resid = std::isfinite(y_[last]) ? y_[last] - lev_[wrap(issue - 1 - 24)] : 0.0;
        return lev_[wrap(tgt - 24 * kmin)] + resid * std::exp(-lead / (pv_ ? 3.0 : 4.0));
    }
    if (m == "rls") {
        double x[NF];
        features(issue, tgt, x);
        const double* T = &theta_[(size_t(wrap(issue) / 24) * NB + bucket(lead)) * NF];
        double v = 0;
        for (int i = 0; i < NF; ++i) v += T[i] * x[i];
        return std::isfinite(v) ? v : base("ets", issue, tgt);
    }
    if (m == "analog") {
        const int need = (lead + 24) / 24;   // analog day must lie far enough back that its outcome is observed
        const unsigned char* ms = &analog_[size_t(wrap(issue)) * ANALOG_DAYS];
        double s = 0;
        int n = 0;
        for (int k = 0; k < ANALOG_DAYS && n < ANALOG_K; ++k)
            if (ms[k] >= need) { s += yff_[wrap(issue - 24 * ms[k] + lead)]; ++n; }
        return n ? s / n : base("ets", issue, tgt);
    }
    if (m == "mlp") {
        int mo = 0;
        const int ti = wrap(issue);
        while (mo < 11 && ti >= MONTH_START[mo + 1]) ++mo;
        double in[NI], h1[NH], h2[NH];
        mlp_inputs(issue, tgt, in);
        const double v = mlp_forward(mlp_[mo].data(), in, h1, h2);
        return std::isfinite(v) ? v : base("ets", issue, tgt);
    }
    if (m == "noisy") {
        const double f = std::min(1.0, 0.3 + 0.7 * lead / 24.0);
        return yff_[t] * (1.0 + sigma_ * f * z_[t]);
    }
    return yff_[t];
}

double SeriesForecaster::operator()(int issue, int tgt) const {
    const int t = wrap(tgt), lead = std::max(0, tgt - issue);
    if (method_ == "perfect") return act_[t];
    if (pv_ && ref_[t] <= 0) return 0.0;
    if (method_ == "persistence") return act_[wrap(tgt - 24 * (lead / 24 + 1))];
    if (method_ == "weekly") return act_[wrap(tgt - 168 * (lead / 168 + 1))];
    if (method_ == "ensemble") {
        const std::vector<double>& cum = lead < 6 ? cum_err_intra_ : cum_err_day_;
        double num = 0, den = 0;
        for (size_t m = 0; m < members_.size(); ++m) {
            const double mse = rsum(&cum[m * (HOURS + 1)], issue - ENS_WINDOW, issue) / ENS_WINDOW;
            const double w = 1.0 / (mse + 1e-9 * ref_[t] * ref_[t] + 1e-12);
            num += w * (*members_[m])(issue, tgt);
            den += w;
        }
        return std::max(0.0, num / den);
    }
    const double y = std::clamp(base(method_, issue, tgt), 0.0, pv_ ? 1.35 : 5.0);
    return y * ref_[t];
}

Forecaster::Forecaster(const EmsParams& m, const std::vector<double>& pv_act, const std::vector<double>& pv_cs,
                       const std::vector<double>& load, const std::vector<double>& wind)
    : pv_(m.pv_forecast, pv_act, pv_cs, m.noise_sigma, 12345u), load_(m.load_forecast, load, {}, m.noise_sigma, 67890u) {
    // Wind has no deterministic daily shape: exponential smoothing with short-lead persistence (or perfect).
    if (std::any_of(wind.begin(), wind.end(), [](double x) { return x > 0; }))
        wind_ = std::make_unique<SeriesForecaster>(m.pv_forecast == "perfect" ? "perfect" : "ets", wind, std::vector<double>{}, m.noise_sigma, 24680u);
}
