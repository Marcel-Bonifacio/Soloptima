#include "optimizer.hpp"
#include "forecast.hpp"
#include "parallel.hpp"
#include "pv.hpp"
#include "sim.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <functional>
#include <map>
#include <memory>
#include <numeric>
#include <random>
#include <set>
#include <stdexcept>
#include <thread>

namespace {

struct Candidate {
    Sizing s;
    double npc = 0, lcoe = 0, re = 0, unmet = 0, curtail = 0, fuel = 0, capex = 0, sssi = 0;
    double lole_h = 0, res_short_h = 0;    // loss-of-load and reserve shortfall hours, worst project year
    double npv_savings = 0, irr = 0, payback = -1;
    double viol = 0;                       // normalised constraint violation (0 = feasible)
    bool irr_valid = false, feasible = false;
    int crate_idx = 0, i = -1, j = -1;     // grid coordinates (-1 for other points)
    std::string why;                       // reason when infeasible
};

double score(const Candidate& c, const std::string& obj) {
    if (!c.feasible) return std::numeric_limits<double>::infinity();
    if (obj == "lcoe") return c.lcoe;
    if (obj == "re") return -c.re + 1e-12 * c.npc;   // tie-break on cost
    return c.npc;
}

struct PVData { std::vector<double> ac, cs; };

using SizeKey = std::array<long, 4>;   // size rounded to 1 kWp / kWh / kW / turbine
SizeKey size_key(const Sizing& s) { return {std::lround(s.pv_kwp), std::lround(s.bess_kwh), std::lround(s.bess_kw), std::lround(s.wind_units)}; }

Candidate evaluate(const Project& p, const PVData& pvp, const SimResult& base, const OptSettings& o, const Sizing& s,
                   const Forecaster* fc) {
    SimResult r = simulate(p, pvp.ac, pvp.cs, s, false, fc);
    Comparison cmp = compare(r, base);
    Candidate c;
    c.s = s;
    c.npc = r.econ.npc; c.lcoe = r.econ.lcoe; c.re = r.re_fraction; c.sssi = r.metrics.sssi;
    c.unmet = std::max(r.unmet_fraction, r.unmet_fraction_max);   // every simulated year, so load growth counts
    for (const auto& Y : r.years) { c.lole_h = std::max(c.lole_h, Y.lol_h); c.res_short_h = std::max(c.res_short_h, Y.reserve_short_h); }
    c.curtail = r.curtail_fraction; c.fuel = r.fuel_l_y1; c.capex = r.econ.capex_total;
    c.npv_savings = cmp.npv_savings; c.irr = cmp.irr; c.irr_valid = cmp.irr_valid; c.payback = cmp.payback_years;
    auto chk = [&](double excess, double scale, const char* w) {
        if (excess > 1e-9) { c.viol += excess / scale; if (c.why.empty()) c.why = w; }
    };
    chk(c.unmet - o.max_unmet, std::max(o.max_unmet, 1e-4), "unmet load");
    chk(o.min_re - c.re, 0.1, "renewable fraction");
    chk(c.curtail - o.max_curtail, 0.1, "curtailment");
    if (o.max_lole_h >= 0) chk(c.lole_h - o.max_lole_h, std::max(1.0, o.max_lole_h), "loss-of-load hours");
    if (o.max_reserve_short_h >= 0) chk(c.res_short_h - o.max_reserve_short_h, std::max(1.0, o.max_reserve_short_h), "reserve shortfall hours");
    if (std::isfinite(o.max_pv_kwp)) chk(s.pv_kwp - o.max_pv_kwp, std::max(1.0, o.max_pv_kwp), "land / PV limit");
    if (std::isfinite(o.max_capex)) chk(c.capex - o.max_capex, std::max(1.0, o.max_capex), "capex budget");
    c.feasible = c.viol <= 0;
    return c;
}

json::Value cand_json(const Candidate& c) {
    return json::Value(json::Object{
        {"pv_kwp", c.s.pv_kwp}, {"bess_kwh", c.s.bess_kwh}, {"bess_kw", c.s.bess_kw}, {"wind_units", c.s.wind_units},
        {"npc", c.npc}, {"lcoe", c.lcoe}, {"re", c.re}, {"sssi", c.sssi}, {"unmet", c.unmet}, {"curtail", c.curtail}, {"fuel", c.fuel},
        {"lole_h", c.lole_h}, {"res_short_h", c.res_short_h},
        {"capex", c.capex}, {"npv_savings", c.npv_savings}, {"irr", c.irr_valid ? json::Value(c.irr) : json::Value()},
        {"payback", c.payback >= 0 ? json::Value(c.payback) : json::Value()}, {"feasible", c.feasible},
        {"why", c.why}, {"crate_idx", c.crate_idx}, {"i", c.i}, {"j", c.j}});
}

std::vector<double> linspace(double a, double b, int n) {
    std::vector<double> v;
    if (n <= 1 || b <= a) { v.push_back(a); return v; }
    for (int k = 0; k < n; ++k) v.push_back(a + (b - a) * k / (n - 1));
    return v;
}

// eol_soh is left out on purpose: it also sets the fade per cycle, so the cycle part always reaches it after cycle_life x cycle_life_dod EFC.
void apply_sensitivity(Project& p, const std::string& var, double val) {
    if (var == "fuel_price") p.econ.fuel_price = val;
    else if (var == "discount_rate") p.econ.discount_rate = val;
    else if (var == "pv_capex_kwp") p.econ.pv_capex_kwp = val;
    else if (var == "bess_capex_kwh") p.econ.bess_capex_kwh = val;
    else if (var == "fuel_escalation") p.econ.fuel_escalation = val;
    else if (var == "load_scale") for (double& x : p.load_kw) x *= val;
    else if (var == "bess_life_scale") { p.bess.cycle_life *= val; p.bess.calendar_fade /= val; }   // val x longer life
    else if (var == "bess_cycle_life") p.bess.cycle_life = val;
    else if (var == "bess_calendar_fade") p.bess.calendar_fade = val;
    else if (var == "bess_replace_kwh") p.econ.bess_replace_kwh = val;
    else if (var == "bess_prices_scale") { p.econ.bess_capex_kwh *= val; p.econ.bess_capex_kw *= val; p.econ.bess_replace_kwh *= val; }
    else if (var == "bess_replace_soh") p.bess.replace_soh = val;
    else if (var == "pv_degradation") p.pv.degradation = val;
    else if (var == "diesel_om_unit_hour") p.econ.diesel_om_unit_hour = val;
}

// Values the engine cannot use (a zero life scale, a replacement threshold of 100 %) stop the run with a readable message.
void check_sensitivity(const std::string& var, double val) {
    auto need = [&](bool ok, const char* msg) {
        if (!ok) { char v[32]; std::snprintf(v, sizeof v, "%g", val); throw std::runtime_error(std::string("Sensitivity value ") + v + ": " + msg); }
    };
    if (var == "bess_life_scale" || var == "bess_cycle_life") need(val > 0, "the battery life must be above 0.");
    else if (var == "bess_calendar_fade" || var == "bess_replace_kwh" || var == "bess_prices_scale" || var == "diesel_om_unit_hour")
        need(val >= 0, "the value must not be negative.");
    else if (var == "bess_replace_soh") need(val > 0 && val < 1, "the replacement state of health must be above 0 % and below 100 %.");
    else if (var == "pv_degradation") need(val >= 0 && val < 1, "the PV degradation must be at least 0 % and below 100 % per year.");
}

struct SearchOut {
    std::vector<Candidate> grid, refined, archive;   // archive: MOPSO Pareto set
    std::vector<double> history;                      // best fitness per iteration (metaheuristics)
    Candidate best;
    bool found = false;
    SimResult base;
};

int n_threads(const OptSettings& o) { return o.threads > 0 ? o.threads : int(std::max(1u, std::thread::hardware_concurrency())); }

void keep_best(const std::vector<Candidate>& v, const std::string& obj, SearchOut& out) {
    for (const auto& c : v)
        if (c.feasible && (!out.found || score(c, obj) < score(out.best, obj))) { out.best = c; out.found = true; }
}

void search_grid(const Project& p, const PVData& pvp, const OptSettings& o, Progress& prog, bool do_grid_detail, const Forecaster* fc, SearchOut& out) {
    const auto pvs = linspace(o.pv_min, o.pv_max, o.pv_steps);
    const auto bes = linspace(o.bess_min, o.bess_max, o.bess_steps);
    const int nc = int(o.c_rates.size());
    const long n = long(pvs.size()) * long(bes.size()) * nc;
    const double wind = std::max(0, p.wind.units);
    out.grid.resize(n);
    const int threads = n_threads(o);

    parallel_for(size_t(n), size_t(threads), [&](long k) {
        if (prog.cancel) return;
        int ci = int(k / (long(pvs.size()) * bes.size()));
        long rem = k % (long(pvs.size()) * bes.size());
        int i = int(rem / bes.size()), j = int(rem % bes.size());
        Sizing s{pvs[i], bes[j], bes[j] * o.c_rates[ci], wind};
        Candidate c = evaluate(p, pvp, out.base, o, s, fc);
        c.crate_idx = ci; c.i = i; c.j = j;
        out.grid[k] = c;
        prog.done++;
    });
    if (prog.cancel)   // cells skipped after a cancel have no grid coordinates
        out.grid.erase(std::remove_if(out.grid.begin(), out.grid.end(), [](const Candidate& c) { return c.i < 0; }), out.grid.end());

    auto better = [&](const Candidate& a, const Candidate& b) { return score(a, o.objective) < score(b, o.objective); };
    keep_best(out.grid, o.objective, out);

    // Stage 2: Hooke-Jeeves pattern search in continuous (PV, BESS) space at the best C-rate.
    if (o.refine && out.found && !prog.cancel) {
        const double cr = o.c_rates[out.best.crate_idx];
        double dpv = pvs.size() > 1 ? (pvs[1] - pvs[0]) / 2 : 0;
        double dbe = bes.size() > 1 ? (bes[1] - bes[0]) / 2 : 0;
        const double tol_pv = std::max(1.0, (o.pv_max - o.pv_min) * 0.002);
        const double tol_be = std::max(1.0, (o.bess_max - o.bess_min) * 0.002);
        Candidate cur = out.best;
        std::map<std::pair<double, double>, Candidate> memo;   // pattern points already simulated, by exact (PV, BESS)
        for (int iter = 0; iter < 60 && (dpv > tol_pv || dbe > tol_be) && !prog.cancel; ++iter) {
            std::vector<Sizing> trial, todo;
            for (int a = -1; a <= 1; ++a)
                for (int b = -1; b <= 1; ++b) {
                    if (a == 0 && b == 0) continue;
                    double pk = std::clamp(cur.s.pv_kwp + a * dpv, o.pv_min, o.pv_max);
                    double bk = std::clamp(cur.s.bess_kwh + b * dbe, o.bess_min, o.bess_max);
                    trial.push_back(Sizing{pk, bk, bk * cr, wind});
                }
            for (const auto& s : trial)
                if (memo.emplace(std::make_pair(s.pv_kwp, s.bess_kwh), Candidate{}).second) todo.push_back(s);
            std::vector<Candidate> res(todo.size());
            prog.total += long(trial.size());
            parallel_for(todo.size(), size_t(threads), [&](long k) {
                res[k] = evaluate(p, pvp, out.base, o, todo[k], fc);
                res[k].crate_idx = cur.crate_idx;
                prog.done++;
            });
            prog.done += long(trial.size() - todo.size());
            for (size_t k = 0; k < todo.size(); ++k) memo[{todo[k].pv_kwp, todo[k].bess_kwh}] = res[k];
            bool improved = false;
            for (const auto& s : trial) {
                const Candidate& c = memo[{s.pv_kwp, s.bess_kwh}];
                if (do_grid_detail) out.refined.push_back(c);
                if (better(c, cur)) { cur = c; improved = true; }
            }
            if (!improved) { dpv /= 2; dbe /= 2; }
        }
        out.best = cur;
    }
}

// Decision vector (continuous, decoded to a Sizing): [PV kWp, BESS kWh, C-rate?, wind turbines?].
struct Space {
    std::vector<double> lo, hi;
    bool crate = false, wind = false;
    double cr_fixed = 0.5;
    Sizing decode(const std::vector<double>& x) const {
        Sizing s;
        s.pv_kwp = x[0];
        s.bess_kwh = x[1];
        const double cr = crate ? x[2] : cr_fixed;
        s.bess_kw = s.bess_kwh * cr;
        s.wind_units = wind ? std::round(x[crate ? 3 : 2]) : 0;
        return s;
    }
};

struct Evaluator {   // parallel, cached fitness evaluation of a population
    Evaluator(const Project& p_, const PVData& d_, const OptSettings& o_, const SimResult& b_, const Forecaster* f_, Progress& g_, const Space& s_)
        : p(p_), pvd(d_), o(o_), base(b_), fc(f_), prog(g_), sp(s_) {}
    const Project& p; const PVData& pvd; const OptSettings& o; const SimResult& base; const Forecaster* fc; Progress& prog;
    const Space& sp;
    std::map<SizeKey, Candidate> cache;
    std::vector<Candidate> all;
    double ref = 1;                          // scale for the infeasibility penalty
    std::vector<Candidate> run(const std::vector<std::vector<double>>& X) {
        const long n = long(X.size());
        std::vector<Sizing> sz(n);
        std::vector<SizeKey> keys(n);
        std::vector<long> todo;              // first occurrence of each size not simulated yet
        for (long k = 0; k < n; ++k) {
            sz[k] = sp.decode(X[k]);
            keys[k] = size_key(sz[k]);
            if (cache.emplace(keys[k], Candidate{}).second) todo.push_back(k);
        }
        std::vector<Candidate> res(todo.size());
        prog.total += n;
        parallel_for(todo.size(), size_t(n_threads(o)), [&](long m) {
            const Sizing& s = sz[todo[m]];
            if (prog.cancel) { res[m].s = s; res[m].viol = 1e9; }
            else res[m] = evaluate(p, pvd, base, o, s, fc);
            prog.done++;
        });
        prog.done += n - long(todo.size());
        for (size_t m = 0; m < todo.size(); ++m) { cache[keys[todo[m]]] = res[m]; all.push_back(res[m]); }
        std::vector<Candidate> out(n);
        for (long k = 0; k < n; ++k) out[k] = cache[keys[k]];
        return out;
    }
    // Single-objective fitness with a static penalty (constraint handling missing from the papers): feasible points keep
    // their objective, infeasible points score ref * (1 + 10 * violation), ref = |diesel-only NPC or LCOE| + 1 (1 for objective re).
    double fit(const Candidate& c) const {
        if (c.viol <= 0) return score(c, o.objective);
        return ref * (1.0 + 10.0 * c.viol);
    }
};

Space make_space(const Project& p, const OptSettings& o) {
    Space sp;
    sp.lo = {o.pv_min, o.bess_min};
    sp.hi = {std::max(o.pv_min + 1, o.pv_max), std::max(o.bess_min + 1, o.bess_max)};
    const double crmin = *std::min_element(o.c_rates.begin(), o.c_rates.end()), crmax = *std::max_element(o.c_rates.begin(), o.c_rates.end());
    sp.cr_fixed = crmin;
    if (crmax > crmin) { sp.crate = true; sp.lo.push_back(crmin); sp.hi.push_back(crmax); }
    if (o.wind_max > o.wind_min) { sp.wind = true; sp.lo.push_back(o.wind_min); sp.hi.push_back(o.wind_max + 0.4999); }
    else if (p.wind.units > 0) { sp.wind = true; sp.lo.push_back(p.wind.units); sp.hi.push_back(p.wind.units); }
    return sp;
}

std::vector<double> rand_point(const Space& sp, std::mt19937& rng) {
    std::uniform_real_distribution<double> U(0, 1);
    std::vector<double> x(sp.lo.size());
    for (size_t d = 0; d < x.size(); ++d) x[d] = sp.lo[d] + U(rng) * (sp.hi[d] - sp.lo[d]);
    return x;
}
void clampv(std::vector<double>& x, const Space& sp) { for (size_t d = 0; d < x.size(); ++d) x[d] = std::clamp(x[d], sp.lo[d], sp.hi[d]); }

// Standard global-best PSO (El Boujdaini et al. 2022, Eqs. 21-22): inertia 0.9 -> 0.4, c1 = c2 = 2, velocity clamp 20 % of range.
void run_pso(Evaluator& ev, const Space& sp, const OptSettings& o, SearchOut& out, std::mt19937& rng) {
    std::uniform_real_distribution<double> U(0, 1);
    const int N = o.particles, T = o.iterations, D = int(sp.lo.size());
    std::vector<std::vector<double>> X(N), V(N, std::vector<double>(D, 0.0));
    for (int i = 0; i < N; ++i) {
        X[i] = rand_point(sp, rng);
        for (int d = 0; d < D; ++d) V[i][d] = (U(rng) - 0.5) * 0.2 * (sp.hi[d] - sp.lo[d]);
    }
    auto C = ev.run(X);
    std::vector<std::vector<double>> pb = X;
    std::vector<double> pbf(N);
    int g = 0;
    for (int i = 0; i < N; ++i) { pbf[i] = ev.fit(C[i]); if (pbf[i] < pbf[g]) g = i; }
    std::vector<double> gb = pb[g];
    double gbf = pbf[g];
    for (int t = 0; t < T && !ev.prog.cancel; ++t) {
        const double w = 0.9 - 0.5 * t / std::max(1, T - 1);
        for (int i = 0; i < N; ++i)
            for (int d = 0; d < D; ++d) {
                const double vmax = 0.2 * (sp.hi[d] - sp.lo[d]);
                V[i][d] = std::clamp(w * V[i][d] + 2.0 * U(rng) * (pb[i][d] - X[i][d]) + 2.0 * U(rng) * (gb[d] - X[i][d]), -vmax, vmax);
                X[i][d] += V[i][d];
                if (X[i][d] < sp.lo[d] || X[i][d] > sp.hi[d]) { X[i][d] = std::clamp(X[i][d], sp.lo[d], sp.hi[d]); V[i][d] *= -0.5; }
            }
        C = ev.run(X);
        for (int i = 0; i < N; ++i) {
            const double f = ev.fit(C[i]);
            if (f < pbf[i]) { pbf[i] = f; pb[i] = X[i]; }
            if (f < gbf) { gbf = f; gb = X[i]; }
        }
        out.history.push_back(gbf);
    }
}

// Hybrid SHO + QAO + GOA (Suresh Babu et al. 2025), with the corrections listed in docs/LITERATURE.md:
//  - SHO: canonical cluster update (Dhiman & Kumar 2017): new position = mean over the best-N cluster of
//    (P_k - E |B P_k - X|), E = 2 h r - h with h falling 5 -> 0, B = 2 r.
//  - QAO: correct three-point quadratic minimiser (differences of squares), replaces the worst if better.
//  - GOA: optimisation form (Saremi et al. 2017) with c falling 1 -> 1e-5, s(r) = f e^(-r/l) - e^(-r), f = 0.5, l = 1.5.
//  Greedy selection keeps a moved agent only if it improved; the paper does not specify selection.
void run_hshoa(Evaluator& ev, const Space& sp, const OptSettings& o, SearchOut& out, std::mt19937& rng) {
    std::uniform_real_distribution<double> U(0, 1);
    const int N = o.particles, T = o.iterations, D = int(sp.lo.size());
    std::vector<std::vector<double>> X(N);
    for (auto& x : X) x = rand_point(sp, rng);
    auto C = ev.run(X);
    std::vector<double> F(N);
    for (int i = 0; i < N; ++i) F[i] = ev.fit(C[i]);
    auto order = [&]() { std::vector<int> idx(N); std::iota(idx.begin(), idx.end(), 0); std::sort(idx.begin(), idx.end(), [&](int a, int b) { return F[a] < F[b]; }); return idx; };
    auto greedy = [&](std::vector<std::vector<double>>& Y) {
        auto CY = ev.run(Y);
        for (int i = 0; i < N; ++i) { const double f = ev.fit(CY[i]); if (f < F[i]) { F[i] = f; X[i] = Y[i]; } }
    };
    for (int t = 0; t < T && !ev.prog.cancel; ++t) {
        // --- SHO ---
        auto idx = order();
        const double h = 5.0 - t * (5.0 / T);
        const int nc = std::max(2, int(std::round(N * (0.1 + 0.2 * U(rng)))));
        std::vector<std::vector<double>> Y = X;
        for (int i = 0; i < N; ++i) {
            if (i == idx[0]) continue;   // elitism: keep the best hyena
            for (int d = 0; d < D; ++d) {
                double acc = 0;
                for (int k = 0; k < nc; ++k) {
                    const double Pk = X[idx[k]][d], B = 2 * U(rng), E = 2 * h * U(rng) - h;
                    acc += Pk - E * std::fabs(B * Pk - X[i][d]);
                }
                Y[i][d] = acc / nc;
            }
            clampv(Y[i], sp);
        }
        greedy(Y);
        // --- QAO on the best three ---
        idx = order();
        {
            const auto &q1 = X[idx[0]], &q2 = X[idx[1]], &q3 = X[idx[2]];
            const double f1 = F[idx[0]], f2 = F[idx[1]], f3 = F[idx[2]];
            std::vector<double> q(D);
            for (int d = 0; d < D; ++d) {
                const double num = (q2[d] * q2[d] - q3[d] * q3[d]) * f1 + (q3[d] * q3[d] - q1[d] * q1[d]) * f2 + (q1[d] * q1[d] - q2[d] * q2[d]) * f3;
                const double den = (q2[d] - q3[d]) * f1 + (q3[d] - q1[d]) * f2 + (q1[d] - q2[d]) * f3;
                q[d] = std::fabs(den) > 1e-12 && std::isfinite(num / den) ? 0.5 * num / den : q1[d];
            }
            clampv(q, sp);
            auto cq = ev.run({q});
            const double fq = ev.fit(cq[0]);
            const int worst = idx[N - 1];
            if (fq < F[worst]) { X[worst] = q; F[worst] = fq; }
        }
        // --- GOA ---
        idx = order();
        const double c = 1.0 - t * (1.0 - 1e-5) / T;
        std::vector<double> best = X[idx[0]];
        Y = X;
        for (int i = 0; i < N; ++i) {
            std::vector<double> S(D, 0.0);
            for (int j = 0; j < N; ++j) {
                if (j == i) continue;
                double dist = 0;
                for (int d = 0; d < D; ++d) { const double z = (X[j][d] - X[i][d]) / (sp.hi[d] - sp.lo[d] + 1e-12); dist += z * z; }
                dist = std::sqrt(dist) + 1e-12;
                const double r = 2.0 + std::fmod(dist, 2.0);
                const double sr = 0.5 * std::exp(-r / 1.5) - std::exp(-r);
                for (int d = 0; d < D; ++d) S[d] += c * (sp.hi[d] - sp.lo[d]) / 2.0 * sr * (X[j][d] - X[i][d]) / (sp.hi[d] - sp.lo[d] + 1e-12) / dist;
            }
            for (int d = 0; d < D; ++d) Y[i][d] = c * S[d] + best[d];
            clampv(Y[i], sp);
        }
        greedy(Y);
        out.history.push_back(*std::min_element(F.begin(), F.end()));
    }
}

// MOPSO objectives, both minimised: cost and the negated renewable fraction (or SSSI).
std::pair<double, double> mo_objs(const Candidate& c, const OptSettings& o) {
    return {o.objective == "lcoe" ? c.lcoe : c.npc, -(o.mo_second == "sssi" ? c.sssi : c.re)};
}

// MOPSO (Coello et al. 2004, as used by Abdoulaye et al. 2024): minimise cost, maximise renewable fraction (or SSSI).
// External archive of feasible non-dominated solutions with crowding-distance pruning and tournament leader selection.
void run_mopso(Evaluator& ev, const Space& sp, const OptSettings& o, SearchOut& out, std::mt19937& rng) {
    std::uniform_real_distribution<double> U(0, 1);
    const int N = o.particles, T = o.iterations, D = int(sp.lo.size());
    const size_t AMAX = 60;
    auto objs = [&](const Candidate& c) { return mo_objs(c, o); };
    auto dominates = [&](const Candidate& a, const Candidate& b) {
        if (a.viol < b.viol) return true;
        if (a.viol > b.viol) return false;
        auto [a1, a2] = objs(a); auto [b1, b2] = objs(b);
        return a1 <= b1 && a2 <= b2 && (a1 < b1 || a2 < b2);
    };
    struct Item { std::vector<double> x; Candidate c; double crowd = 0; };
    std::vector<Item> arch;
    auto crowding = [&]() {
        const size_t n = arch.size();
        for (auto& a : arch) a.crowd = 0;
        if (n < 3) { for (auto& a : arch) a.crowd = 1e9; return; }
        for (int m = 0; m < 2; ++m) {
            std::vector<size_t> id(n); std::iota(id.begin(), id.end(), 0);
            auto val = [&](size_t k) { auto ob = objs(arch[k].c); return m == 0 ? ob.first : ob.second; };
            std::sort(id.begin(), id.end(), [&](size_t a, size_t b) { return val(a) < val(b); });
            const double span = std::max(1e-12, val(id[n - 1]) - val(id[0]));
            arch[id[0]].crowd = arch[id[n - 1]].crowd = 1e9;
            for (size_t k = 1; k + 1 < n; ++k) arch[id[k]].crowd += (val(id[k + 1]) - val(id[k - 1])) / span;
        }
    };
    auto add = [&](const std::vector<double>& x, const Candidate& c) {
        if (!c.feasible) return;
        for (const auto& a : arch) if (dominates(a.c, c) || (objs(a.c) == objs(c))) return;
        arch.erase(std::remove_if(arch.begin(), arch.end(), [&](const Item& a) { return dominates(c, a.c); }), arch.end());
        arch.push_back({x, c});
        if (arch.size() > AMAX) { crowding(); auto it = std::min_element(arch.begin(), arch.end(), [](const Item& a, const Item& b) { return a.crowd < b.crowd; }); arch.erase(it); }
    };
    auto leader = [&]() -> const std::vector<double>& {
        const Item& a = arch[size_t(U(rng) * arch.size()) % arch.size()];
        const Item& b = arch[size_t(U(rng) * arch.size()) % arch.size()];
        return (a.crowd >= b.crowd ? a : b).x;
    };
    std::vector<std::vector<double>> X(N), V(N, std::vector<double>(D, 0.0));
    for (auto& x : X) x = rand_point(sp, rng);
    auto C = ev.run(X);
    std::vector<std::vector<double>> pb = X;
    std::vector<Candidate> pbc = C;
    for (int i = 0; i < N; ++i) add(X[i], C[i]);
    for (int t = 0; t < T && !ev.prog.cancel; ++t) {
        const double w = 0.9 - 0.5 * t / std::max(1, T - 1);
        const double pm = 0.5 * std::pow(1.0 - double(t) / T, 2.0);   // mutation probability, decays over the run
        crowding();
        for (int i = 0; i < N; ++i) {
            const std::vector<double>& L = arch.empty() ? pb[i] : leader();
            for (int d = 0; d < D; ++d) {
                const double vmax = 0.2 * (sp.hi[d] - sp.lo[d]);
                V[i][d] = std::clamp(w * V[i][d] + 1.5 * U(rng) * (pb[i][d] - X[i][d]) + 1.5 * U(rng) * (L[d] - X[i][d]), -vmax, vmax);
                X[i][d] += V[i][d];
            }
            if (U(rng) < pm) {
                const int d = int(U(rng) * D) % D;
                const double r = (sp.hi[d] - sp.lo[d]) * pm;
                X[i][d] += (U(rng) * 2 - 1) * r;
            }
            clampv(X[i], sp);
        }
        C = ev.run(X);
        for (int i = 0; i < N; ++i) {
            add(X[i], C[i]);
            if (dominates(C[i], pbc[i]) || (!dominates(pbc[i], C[i]) && U(rng) < 0.5)) { pb[i] = X[i]; pbc[i] = C[i]; }
        }
        double mn = std::numeric_limits<double>::infinity();
        for (const auto& a : arch) mn = std::min(mn, objs(a.c).first);
        out.history.push_back(mn);
    }
    for (const auto& a : arch) out.archive.push_back(a.c);
}

void search_meta(const Project& p, const PVData& pvp, const OptSettings& o, Progress& prog, const Forecaster* fc, SearchOut& out) {
    const Space sp = make_space(p, o);
    Evaluator ev(p, pvp, o, out.base, fc, prog, sp);
    ev.ref = o.objective == "re" ? 1.0 : std::fabs(o.objective == "lcoe" ? out.base.econ.lcoe : out.base.econ.npc) + 1.0;
    std::mt19937 rng(o.seed);
    if (o.algorithm == "mopso") run_mopso(ev, sp, o, out, rng);
    else if (o.algorithm == "hshoa") run_hshoa(ev, sp, o, out, rng);
    else run_pso(ev, sp, o, out, rng);
    out.refined = std::move(ev.all);
    if (o.algorithm == "mopso" && !out.archive.empty()) {
        // Compromise ("knee") solution: closest to the ideal point in normalised objective space.
        double c1 = 1e300, c2 = 1e300, C1 = -1e300, C2 = -1e300;
        for (const auto& a : out.archive) { const auto [f1, f2] = mo_objs(a, o); c1 = std::min(c1, f1); C1 = std::max(C1, f1); c2 = std::min(c2, f2); C2 = std::max(C2, f2); }
        double bd = 1e300;
        for (const auto& a : out.archive) {
            const auto [f1, f2] = mo_objs(a, o);
            const double x = (f1 - c1) / std::max(1e-12, C1 - c1), y = (f2 - c2) / std::max(1e-12, C2 - c2);
            if (x * x + y * y < bd) { bd = x * x + y * y; out.best = a; out.found = true; }
        }
    } else {
        keep_best(out.refined, o.objective, out);
    }
}

SearchOut search(const Project& p, const PVData& pvp, const OptSettings& o, Progress& prog, bool detail) {
    SearchOut out;
    // Forecasts do not depend on the system size, so one forecaster serves every candidate.
    const auto fc = p.dg.strategy == "predictive"
        ? std::make_unique<Forecaster>(p.ems, pvp.ac, pvp.cs, p.load_kw, wind_per_turbine(p)) : nullptr;
    out.base = simulate(p, pvp.ac, pvp.cs, Sizing{}, false, fc.get());
    if (o.algorithm == "grid") search_grid(p, pvp, o, prog, detail, fc.get(), out);
    else search_meta(p, pvp, o, prog, fc.get(), out);
    return out;
}

} // namespace

OptSettings parse_opt_settings(const json::Value& v, const Project& p) {
    OptSettings o;
    const double annual = std::accumulate(p.load_kw.begin(), p.load_kw.end(), 0.0);
    o.pv_min = v.get("pv_min", 0);
    o.pv_max = v.get("pv_max", 0);
    if (o.pv_max <= o.pv_min) o.pv_max = std::max(o.pv_min + 1, 1.2 * annual / std::max(1.0, compute_pv_profile(p).specific_yield));
    o.bess_min = v.get("bess_min", 0);
    o.bess_max = v.get("bess_max", 0);
    if (o.bess_max <= o.bess_min) o.bess_max = std::max(o.bess_min + 1, annual / 365.0 * 0.5);
    o.pv_steps = std::clamp(int(v.get("pv_steps", o.pv_steps)), 1, 200);
    o.bess_steps = std::clamp(int(v.get("bess_steps", o.bess_steps)), 1, 200);
    if (v["c_rates"].is_array()) {
        o.c_rates.clear();
        for (const auto& x : v["c_rates"].arr()) if (x.num() > 0) o.c_rates.push_back(x.num());
        if (o.c_rates.empty()) o.c_rates = {0.5};
    }
    o.objective = v.gets("objective", o.objective);
    o.max_unmet = v.get("max_unmet", o.max_unmet);
    o.min_re = v.get("min_re", o.min_re);
    o.max_curtail = v.get("max_curtail", o.max_curtail);
    o.max_lole_h = v.get("max_lole_h", o.max_lole_h);
    o.max_reserve_short_h = v.get("max_reserve_short_h", o.max_reserve_short_h);
    if (v.get("max_pv_kwp", 0) > 0) o.max_pv_kwp = v.get("max_pv_kwp", 0);
    if (v.get("max_capex", 0) > 0) o.max_capex = v.get("max_capex", 0);
    o.refine = v.getb("refine", o.refine);
    o.threads = int(std::clamp(v.get("threads", 0), 0.0, 256.0));
    o.sens_var = v.gets("sens_var", "");
    o.sens_values = v.getv("sens_values");
    for (double x : o.sens_values) check_sensitivity(o.sens_var, x);
    o.algorithm = v.gets("algorithm", o.algorithm);
    if (o.algorithm != "grid" && o.algorithm != "pso" && o.algorithm != "mopso" && o.algorithm != "hshoa") o.algorithm = "grid";
    o.particles = std::clamp(int(v.get("particles", o.particles)), 4, 200);
    o.iterations = std::clamp(int(v.get("iterations", o.iterations)), 1, 500);
    o.seed = unsigned(static_cast<long long>(v.get("seed", o.seed)));
    o.wind_min = std::max(0, int(v.get("wind_min", 0)));
    o.wind_max = std::max(o.wind_min, int(v.get("wind_max", 0)));
    o.mo_second = v.gets("mo_second", o.mo_second);
    return o;
}

json::Value optimize(const Project& p0, const OptSettings& o, Progress& prog) {
    using json::Value;
    const bool grid_alg = o.algorithm == "grid";
    const long per_run = grid_alg ? long(std::max(1, o.pv_steps)) * std::max(1, o.bess_steps) * long(o.c_rates.size()) : 0;
    const bool sens = !o.sens_var.empty() && !o.sens_values.empty();
    prog.total = per_run * (sens ? long(o.sens_values.size()) + 1 : 1);
    prog.done = 0;

    PVData pvd{compute_pv_profile(p0).ac_per_kwp, clearsky_pv_per_kwp(p0)};
    SearchOut main = search(p0, pvd, o, prog, true);

    Value out = Value::object();
    const char* alg_name = o.algorithm == "pso" ? "particle swarm optimisation (PSO)" : o.algorithm == "mopso" ? "multi-objective PSO (MOPSO)"
                         : o.algorithm == "hshoa" ? "hybrid spotted-hyena / quadratic-approximation / grasshopper (SHO-QAO-GOA)" : "grid search + pattern search";
    out["settings"] = Value(json::Object{
        {"pv_min", o.pv_min}, {"pv_max", o.pv_max}, {"pv_steps", o.pv_steps}, {"bess_min", o.bess_min},
        {"bess_max", o.bess_max}, {"bess_steps", o.bess_steps}, {"c_rates", Value(o.c_rates)},
        {"objective", o.objective}, {"max_unmet", o.max_unmet}, {"min_re", o.min_re}, {"max_curtail", o.max_curtail},
        {"max_lole_h", o.max_lole_h}, {"max_reserve_short_h", o.max_reserve_short_h},
        {"max_pv_kwp", std::isfinite(o.max_pv_kwp) ? Value(o.max_pv_kwp) : Value()}, {"algorithm_id", o.algorithm},
        {"algorithm", alg_name}, {"particles", o.particles}, {"iterations", o.iterations}, {"mo_second", o.mo_second},
        {"wind_min", o.wind_min}, {"wind_max", o.wind_max}});
    out["pv_axis"] = Value(linspace(o.pv_min, o.pv_max, o.pv_steps));
    out["bess_axis"] = Value(linspace(o.bess_min, o.bess_max, o.bess_steps));

    Value grid = Value::array();
    for (const auto& c : main.grid) grid.push(cand_json(c));
    out["grid"] = grid;
    out["history"] = Value(main.history);

    // Every evaluated configuration (metaheuristics) for scatter plots, capped for transfer size.
    Value evald = Value::array();
    if (!grid_alg) for (size_t k = 0; k < main.refined.size() && k < 4000; ++k) evald.push(cand_json(main.refined[k]));
    out["evaluated"] = evald;

    // Ranked feasible systems: the overall table.
    std::vector<Candidate> feas;
    std::set<SizeKey> seen;   // de-duplicate revisited points
    for (const auto* v : {&main.grid, &main.refined})
        for (const auto& c : *v)
            if (c.feasible && seen.insert(size_key(c.s)).second) feas.push_back(c);
    std::sort(feas.begin(), feas.end(), [&](const Candidate& a, const Candidate& b) { return score(a, o.objective) < score(b, o.objective); });
    Value ranked = Value::array();
    for (size_t k = 0; k < feas.size() && k < 100; ++k) ranked.push(cand_json(feas[k]));
    out["ranked"] = ranked;
    out["n_feasible"] = long(feas.size());
    out["n_evaluated"] = long(main.grid.size() + main.refined.size());

    // Pareto front: MOPSO archive, otherwise the lowest LCOE for each renewable fraction among feasible points.
    Value pareto = Value::array();
    if (!main.archive.empty()) {
        std::sort(main.archive.begin(), main.archive.end(), [](const Candidate& a, const Candidate& b) { return a.re < b.re; });
        for (const auto& c : main.archive) pareto.push(cand_json(c));
    } else {
        std::sort(feas.begin(), feas.end(), [](const Candidate& a, const Candidate& b) { return a.re > b.re || (a.re == b.re && a.lcoe < b.lcoe); });
        double best_lcoe = std::numeric_limits<double>::infinity();
        for (const auto& c : feas) if (c.lcoe < best_lcoe - 1e-12) { best_lcoe = c.lcoe; pareto.push(cand_json(c)); }
    }
    out["pareto"] = pareto;

    out["baseline"] = result_to_json(main.base, false);
    if (main.found) {
        out["best"] = cand_json(main.best);
        const double tp = (o.pv_max - o.pv_min) * 0.01, tb = (o.bess_max - o.bess_min) * 0.01;
        json::Value edge = json::Value::array();
        if (o.algorithm != "mopso") {
            if (o.pv_max > o.pv_min && main.best.s.pv_kwp >= o.pv_max - tp && main.best.s.pv_kwp < o.max_pv_kwp - tp) edge.push("pv_max");
            if (o.bess_max > o.bess_min && main.best.s.bess_kwh >= o.bess_max - tb) edge.push("bess_max");
            if (o.pv_min > 0 && main.best.s.pv_kwp <= o.pv_min + tp) edge.push("pv_min");
            if (o.bess_min > 0 && main.best.s.bess_kwh <= o.bess_min + tb) edge.push("bess_min");
        }
        out["at_boundary"] = edge;
        SimResult full = simulate(p0, pvd.ac, pvd.cs, main.best.s, true);
        out["best_detail"] = result_to_json(full, true);
        out["comparison"] = comparison_to_json(compare(full, main.base));
    } else {
        out["best"] = Value();
    }

    if (sens) {
        Value rows = Value::array();
        for (double val : o.sens_values) {
            if (prog.cancel) break;
            Project p = p0;
            apply_sensitivity(p, o.sens_var, val);
            SearchOut so = search(p, pvd, o, prog, false);
            Value row = Value::object();
            row["value"] = val;
            row["best"] = so.found ? cand_json(so.best) : Value();
            row["baseline_npc"] = so.base.econ.npc;
            row["baseline_lcoe"] = so.base.econ.lcoe;
            rows.push(row);
        }
        out["sensitivity"] = Value(json::Object{{"variable", o.sens_var}, {"rows", rows}});
    }
    out["cancelled"] = bool(prog.cancel);
    prog.done = prog.total.load();
    return out;
}
