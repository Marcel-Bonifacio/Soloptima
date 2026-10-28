#include "resource.hpp"
#include "finance.hpp"
#include "pv.hpp"
#include "sim.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

constexpr double Z75 = 0.6745, Z90 = 1.2816, Z99 = 2.3263;   // one-sided standard normal quantiles

struct Run { SimResult hyb, base; double sy = 0, ghi = 0, poa = 0; };

json::Value year_json(const YearRun& y) {
    return json::Value(json::Object{
        {"year", y.year}, {"sy", y.sy}, {"ghi", y.ghi}, {"poa", y.poa}, {"re", y.re}, {"curtail", y.curtail}, {"unmet", y.unmet},
        {"fuel_hyb", y.fuel_hyb}, {"fuel_base", y.fuel_base}, {"fuel_saved", y.fuel_saved}, {"avoided_cost", y.avoided_cost},
        {"re_kwh", y.re_kwh}, {"revenue", y.revenue}, {"npv_savings", y.npv_savings}});
}

} // namespace

double sigma_sys(const UncertaintyBudget& b) { return std::sqrt(b.dataset * b.dataset + b.model * b.model + b.soiling * b.soiling); }

Exceedance exceedance(double m0, const std::vector<double>& ys, double elasticity, double sigma_sys, bool benefit) {
    Exceedance x;
    x.p50 = m0;
    for (double y : ys) x.mean += y;
    if (!ys.empty()) x.mean /= double(ys.size());
    double var = 0;
    if (ys.size() >= 2 && std::fabs(x.mean) > 1e-12) {
        for (double y : ys) var += (y / x.mean - 1) * (y / x.mean - 1);
        var /= double(ys.size() - 1);
    }
    const double sys = elasticity * sigma_sys;
    x.sigma_iav = std::sqrt(var);
    x.sigma_1 = std::sqrt(var + sys * sys);
    x.sigma_10 = std::sqrt(var / 10 + sys * sys);
    const double sg = benefit ? -1.0 : 1.0;
    x.p75_1 = m0 * (1 + sg * Z75 * x.sigma_1);
    x.p90_1 = m0 * (1 + sg * Z90 * x.sigma_1);
    x.p99_1 = m0 * (1 + sg * Z99 * x.sigma_1);
    x.p90_10 = m0 * (1 + sg * Z90 * x.sigma_10);
    return x;
}

json::Value resource_years(const Project& p, const json::Value& raw, const std::vector<WeatherYear>& years,
                           const UncertaintyBudget& b, Progress& prog) {
    const size_t n = years.size();
    if (n < 2) throw std::runtime_error("The variability run needs at least two weather years.");
    const double ss = sigma_sys(b);
    const double s = ss > 0 ? ss : 0.05;   // irradiance step of the elasticity (5 % when the budget is zero)
    const Sizing sz{p.pv.capacity_kwp, p.bess.energy_kwh, p.bess.power_kw, double(p.wind.units)};

    // Runs 0..n-1: the historical years; n: the project's weather (P50 anchor); n+1, n+2: its irradiance x (1 + s), x (1 - s).
    std::vector<Run> runs(n + 3);
    prog.total = long(runs.size());
    prog.done = 0;
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    std::string err;
    std::mutex m;
    const size_t nt = std::min<size_t>(runs.size(), std::max(1u, std::thread::hardware_concurrency()));
    for (size_t k = 0; k < nt; ++k)
        pool.emplace_back([&] {
            for (size_t i; (i = next.fetch_add(1)) < runs.size() && !prog.cancel;) {
                try {
                    Project q = p;
                    q.sim.all_years = false;
                    if (i < n) q.wx = years[i].wx;
                    else if (i > n)
                        for (auto* v : {&q.wx.ghi, &q.wx.dni, &q.wx.dhi})
                            for (double& x : *v) x *= i == n + 1 ? 1 + s : 1 - s;
                    const PVProfile prof = compute_pv_profile(q);
                    const std::vector<double> cs = clearsky_pv_per_kwp(q);
                    Run& r = runs[i];
                    r.hyb = simulate(q, prof.ac_per_kwp, cs, sz, false);
                    r.base = simulate(q, prof.ac_per_kwp, cs, Sizing{}, false);
                    r.sy = prof.specific_yield;
                    r.ghi = prof.ghi_annual;
                    r.poa = prof.poa_annual;
                    ++prog.done;
                } catch (const std::exception& e) {
                    std::lock_guard<std::mutex> g(m);
                    if (err.empty()) err = (i < n ? "Weather year " + std::to_string(years[i].year) + ": " : std::string()) + e.what();
                    prog.cancel = true;
                }
            }
        });
    for (auto& t : pool) t.join();
    if (!err.empty()) throw std::runtime_error(err);
    if (prog.cancel) throw std::runtime_error("Cancelled.");

    // Project finance on the same contract in every weather year: a tariff solved for a target IRR is solved for the P50
    // case and then kept, and the contracted energy (take-or-pay, shortfall threshold) stays at its P50 value.
    const FinanceParams f0 = parse_finance(raw["finance"], p);
    const Run& A = runs[n];
    const double e1_anchor = A.hyb.years[0].served_site * A.hyb.years[0].re_fraction;
    const double scale = run_finance(p, f0, A.hyb, A.base)["metrics"].get("tariff_scale", 1.0);
    auto record = [&](const Run& r, int year) {
        const YearResult& H = r.hyb.years[0];
        const YearResult& B = r.base.years[0];
        FinanceParams f = f0;
        const double e1 = H.served_site * H.re_fraction;
        if (e1 > 0) f.ace_factor = f0.ace_factor * e1_anchor / e1;
        const json::Value fin = run_finance(p, f, r.hyb, r.base, scale);
        YearRun y;
        y.year = year;
        y.sy = r.sy; y.ghi = r.ghi; y.poa = r.poa;
        y.re = r.hyb.re_fraction; y.curtail = r.hyb.curtail_fraction; y.unmet = r.hyb.unmet_fraction;
        y.fuel_hyb = r.hyb.fuel_l_y1; y.fuel_base = r.base.fuel_l_y1; y.fuel_saved = y.fuel_base - y.fuel_hyb;
        y.avoided_cost = (B.c_fuel + B.c_om_dg + B.c_carbon) - (H.c_fuel + H.c_om_dg + H.c_carbon);
        y.re_kwh = H.served * H.re_fraction;
        y.energy = e1;
        y.revenue = fin["years"][size_t(1)]["revenue"].num();   // years[0] is construction / COD
        y.npv_savings = compare(r.hyb, r.base).npv_savings;
        return y;
    };
    std::vector<YearRun> ys;
    for (size_t i = 0; i < n; ++i) ys.push_back(record(runs[i], years[i].year));
    const YearRun y0 = record(A, 0), yp = record(runs[n + 1], 0), ym = record(runs[n + 2], 0);

    struct Metric { const char* key; double YearRun::*m; bool benefit; };
    const Metric metrics[] = {{"yield", &YearRun::sy, true}, {"fuel_saved", &YearRun::fuel_saved, true}, {"re", &YearRun::re, true},
                              {"avoided_cost", &YearRun::avoided_cost, true}, {"revenue", &YearRun::revenue, true},
                              {"fuel_used", &YearRun::fuel_hyb, false}};
    json::Value stats = json::Value::object();
    for (const Metric& mt : metrics) {
        const double m0 = y0.*mt.m;
        const double el = std::fabs(m0) > 1e-12 ? (yp.*mt.m - ym.*mt.m) / (2 * s * m0) : 0.0;
        std::vector<double> v;
        for (const auto& y : ys) v.push_back(y.*mt.m);
        const Exceedance x = exceedance(m0, v, el, ss, mt.benefit);
        size_t w = 0;
        for (size_t i = 1; i < n; ++i) if (mt.benefit ? v[i] < v[w] : v[i] > v[w]) w = i;
        stats[mt.key] = json::Value(json::Object{
            {"p50", x.p50}, {"mean", x.mean}, {"sigma_iav", x.sigma_iav}, {"sigma_1", x.sigma_1}, {"sigma_10", x.sigma_10},
            {"elasticity", el}, {"p75_1", x.p75_1}, {"p90_1", x.p90_1}, {"p99_1", x.p99_1}, {"p90_10", x.p90_10},
            {"worst_year", ys[w].year}, {"worst", v[w]}});
    }
    // Under a PPA or TPO the revenue is a non-decreasing function of the renewable energy delivered (take-or-pay floor,
    // shortfall penalty), so its P-values are that function of the energy's P-values. Deemed energy stays at its P50 value.
    if (f0.model != "host") {
        const json::Value Y1 = run_finance(p, f0, A.hyb, A.base, scale)["years"][size_t(1)];
        const double tar = Y1["tariff"].num(), ace = Y1["ace"].num(), e0 = y0.energy;
        const double deemed = Y1["billed"].num() - std::max(Y1["energy"].num(), f0.take_or_pay * ace);
        auto rev = [&](double e) {
            return tar * (std::max(e, f0.take_or_pay * ace) + deemed) - f0.penalty_rate * tar * std::max(0.0, f0.penalty_threshold * ace - e);
        };
        std::vector<double> ve;
        for (const auto& y : ys) ve.push_back(y.energy);
        const double ee = std::fabs(e0) > 1e-12 ? (yp.energy - ym.energy) / (2 * s * e0) : 0.0;
        const Exceedance xe = exceedance(e0, ve, ee, ss, true);
        json::Value& R = stats["revenue"];
        R["p75_1"] = rev(xe.p75_1); R["p90_1"] = rev(xe.p90_1); R["p99_1"] = rev(xe.p99_1); R["p90_10"] = rev(xe.p90_10);
    }
    json::Value yj = json::Value::array();
    for (const auto& y : ys) yj.push(year_json(y));
    return json::Value(json::Object{{"years", yj}, {"anchor", year_json(y0)}, {"plus", year_json(yp)}, {"minus", year_json(ym)},
                                    {"stats", stats}, {"sigma_sys", ss}, {"step", s}});
}
