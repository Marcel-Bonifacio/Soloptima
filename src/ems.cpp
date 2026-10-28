#include "ems.hpp"
#include "pv.hpp"
#include "weather.hpp"
#include <atomic>
#include <cstdio>
#include <thread>
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

PlanInput plan_input(const Project& p, const FuelTable& fuel) {
    PlanInput in;
    in.eta = std::sqrt(p.bess.rte);   // one-way efficiency (charge = discharge)
    in.fuel_price = p.econ.fuel_price;
    in.om_unit_hour = p.econ.diesel_om_unit_hour;
    in.om_kwh = p.econ.diesel_om_kwh;
    // Wear cost per kWh discharged: replacement cost spread over the cycle life at its rated depth of discharge.
    in.cycle_cost = p.econ.bess_replace_kwh / std::max(1.0, p.bess.cycle_life * p.bess.cycle_life_dod);
    in.voll = p.ems.voll;
    in.provides_reserve = p.bess.provides_reserve;
    in.reserve_h = p.bess.reserve_duration_h;
    in.levels = p.ems.soc_levels;
    // Stored energy is worth the fuel it displaces at a typical (75 %) genset loading.
    in.terminal_per_kwh = p.ems.terminal_value * in.eta * (fuel(0.75) / 0.75 * p.econ.fuel_price + p.econ.diesel_om_kwh);
    return in;
}

double Planner::hour_cost(const PlanInput& in, double L, double P, double b, int& u, double bres_cap) const {
    const double net = L - P;
    const double g = std::max(0.0, net - b);                // genset energy needed
    const double reserve = dg_.reserve_load * L + dg_.reserve_pv * std::min(P, L);
    const double bres = in.provides_reserve ? std::max(0.0, std::min(in.Pb - std::max(b, 0.0), bres_cap)) : 0.0;
    const double need = g + std::max(0.0, reserve - bres);
    u = need > 1e-6 ? int(std::ceil(need / dg_.unit_kw - 1e-9)) : 0;
    const int min_on = dg_.units > 0 ? std::min(dg_.min_units_online, dg_.units) : 0;
    u = std::min(std::max(u, min_on), dg_.units);
    const double cap = u * dg_.unit_kw;
    const double unmet = std::max(0.0, g - cap);
    double fuel = 0, geff = 0;
    if (u > 0) {
        geff = std::max(std::min(g, cap), cap * dg_.min_load);
        fuel = cap * fuel_(geff / cap);
    }
    return fuel * in.fuel_price + u * in.om_unit_hour + geff * in.om_kwh + unmet * in.voll +
           std::max(b, 0.0) * in.cycle_cost;
}

void Planner::plan(const PlanInput& in, double E0, const std::vector<double>& load_fc, const std::vector<double>& pv_fc,
                   std::vector<double>& E_traj, std::vector<int>& u_plan) {
    const int H = int(load_fc.size());
    E_traj.assign(H + 1, E0);
    u_plan.assign(H, 0);
    const double span = in.Emax - in.Emin;
    if (span <= 1e-9 || in.Pb <= 1e-9) {
        for (int j = 0; j < H; ++j) hour_cost(in, load_fc[j], pv_fc[j], 0.0, u_plan[j], reserve_cap(in, E0));
        return;
    }
    // Resolution: at least `levels`, and fine enough that one level step needs at most half the rated power.
    int n = std::max(in.levels, int(std::ceil(span / (0.5 * in.Pb * in.eta))) + 1);
    n = std::min(n, 101);
    const double dE = span / (n - 1);
    const int nd = 2 * n - 1;                 // distinct level changes d = m - k in [-(n-1), n-1]
    const double INF = std::numeric_limits<double>::infinity();

    V_.assign(size_t(H + 1) * n, 0.0);
    pol_.assign(size_t(H) * n, 0);
    cost_.assign(size_t(H) * nd, INF);

    // Hour cost depends only on the level change d = m - k, so tabulate it once per hour for the changes
    // the battery power allows, d in [dlo, dhi].
    auto b_of = [&](int d) { const double dEn = d * dE; return dEn < 0 ? -dEn * in.eta : -dEn / in.eta; };
    int dlo = 0, dhi = 0;
    while (dlo > 1 - n && std::fabs(b_of(dlo - 1)) <= in.Pb * (1 + 1e-9)) --dlo;
    while (dhi < n - 1 && std::fabs(b_of(dhi + 1)) <= in.Pb * (1 + 1e-9)) ++dhi;
    for (int j = 0; j < H; ++j)
        for (int d = dlo; d <= dhi; ++d) {
            int u;
            cost_[size_t(j) * nd + d + n - 1] = hour_cost(in, load_fc[j], pv_fc[j], b_of(d), u);
        }
    for (int k = 0; k < n; ++k) V_[size_t(H) * n + k] = -in.terminal_per_kwh * (in.Emin + k * dE);

    for (int j = H - 1; j >= 0; --j) {
        const double* c = &cost_[size_t(j) * nd];
        const double* Vn = &V_[size_t(j + 1) * n];
        for (int k = 0; k < n; ++k) {
            double best = INF;
            int arg = k;
            for (int m = std::max(0, k + dlo), m1 = std::min(n - 1, k + dhi); m <= m1; ++m) {
                double v = c[m - k + n - 1] + Vn[m];
                if (v < best) { best = v; arg = m; }
            }
            V_[size_t(j) * n + k] = best;
            pol_[size_t(j) * n + k] = arg;
        }
    }

    // Commit units for the planned path with the battery reserve limited as in real time: the energy above the minimum at
    // the start of the hour, over the reserve duration, less the hour's discharge. An almost empty battery is therefore not
    // counted as reserve. The DP costs above do not see this limit.
    int k = std::clamp(int(std::lround((E0 - in.Emin) / dE)), 0, n - 1);
    for (int j = 0; j < H; ++j) {
        int m = pol_[size_t(j) * n + k];
        E_traj[j + 1] = in.Emin + m * dE;
        hour_cost(in, load_fc[j], pv_fc[j], b_of(m - k), u_plan[j], reserve_cap(in, E_traj[j], E_traj[j + 1]));
        k = m;
    }
}

namespace {
int hour_of_year_iso(const std::string& iso) {
    static const int cum[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
    int y, mo, d, h;
    if (std::sscanf(iso.c_str(), "%d-%d-%dT%d", &y, &mo, &d, &h) != 4 || d < 1 || d > 31 || h < 0 || h > 23) return -1;
    if (mo == 2 && d == 29) d = 28;
    return (cum[std::clamp(mo, 1, 12) - 1] + d - 1) * 24 + h;
}
} // namespace

json::Value day_ahead_schedule(const Project& p, const Sizing& s, const json::Value& f, double soc_now, double load_scale,
                               const std::string& now_utc, int max_hours) {
    const auto& times = f["times"].arr();
    if (times.empty()) throw std::runtime_error("Forecast contains no hours.");
    auto clip = [](const std::string& t) { return t.substr(0, 40); };   // for messages
    std::vector<long> eh(times.size());   // hours since the epoch
    for (size_t i = 0; i < times.size(); ++i)
        if ((eh[i] = iso_to_epoch_h(times[i].str())) == NO_TIME_H) throw std::runtime_error("Bad forecast timestamp: " + clip(times[i].str()));

    // A row covers [T + time_offset - 0.5 h, T + time_offset + 0.5 h): Open-Meteo stamps the end of its hour (offset -0.5),
    // MET Norway the start (0.5). The plan starts at the current hour, so rows that began earlier are dropped.
    const double toff = f.get("time_offset", 0.5);
    if (!(std::fabs(toff) <= 1)) throw std::runtime_error("The forecast time offset must be between -1 h and +1 h.");
    const std::string now = now_utc.empty() ? f.gets("issued_utc", "") : now_utc;
    size_t i0 = 0, i1 = times.size();
    if (!now.empty()) {
        const long t0 = iso_to_epoch_h(now);
        if (t0 == NO_TIME_H) throw std::runtime_error("Bad current time: " + clip(now));
        while (i0 < i1 && eh[i0] + toff - 0.5 < t0 - 1e-9) ++i0;
        if (i0 == i1) throw std::runtime_error("The forecast ends before the current hour: fetch it again.");
    }
    if (max_hours > 0) i1 = std::min(i1, i0 + size_t(max_hours));
    // A missing value is never read as zero PV (or as calm wind): the plan ends at the first hour without it.
    const bool has_wind = s.wind_units > 0.5;
    std::string note = f.gets("note", "");
    for (size_t i = i0; i < i1; ++i)
        if (f["ghi"][i].is_null() || (has_wind && f["wind"][i].is_null())) {
            note += (note.empty() ? "" : " ") + ("No data from " + clip(times[i].str()) + " UTC: the plan ends there.");
            i1 = i;
        }
    if (i1 == i0) throw std::runtime_error("The forecast has no data for the current hour.");
    for (size_t i = i0 + 1; i < i1; ++i)
        if (eh[i] != eh[i - 1] + 1)
            throw std::runtime_error("Forecast hours must be 1 h apart: " + clip(times[i - 1].str()) + " is followed by " + clip(times[i].str()) + ".");
    const int n = int(i1 - i0);

    // Place the forecast hours into an otherwise empty year so the full PV model can be reused unchanged. The plan runs
    // on the forecast's UTC hours: PV stays on them (offset 0), and the load, in local standard time, is averaged over each.
    // The hours are indexed consecutively from the first, so 29 February does not land on the 28th.
    Project q = p;
    q.wx.is_utc = true;
    local_shift(q);   // checks the UTC offset range
    q.loc.utc_offset = 0;
    q.wx.time_offset = toff;
    for (auto* v : {&q.wx.ghi, &q.wx.tamb, &q.wx.wind}) v->assign(HOURS, 0.0);
    const bool split = f["dhi"].size() == times.size() && f["dni"].size() == times.size();
    if (split) { q.wx.dhi.assign(HOURS, 0.0); q.wx.dni.assign(HOURS, 0.0); } else { q.wx.dhi.clear(); q.wx.dni.clear(); }
    std::vector<int> hoy(n);
    const int h0 = hour_of_year_iso(times[i0].str());
    for (int k = 0; k < n; ++k) {
        const size_t i = i0 + k;
        hoy[k] = (h0 + k) % HOURS;
        q.wx.ghi[hoy[k]] = std::max(0.0, f["ghi"][i].num());
        q.wx.tamb[hoy[k]] = f["tamb"][i].num(25);
        q.wx.wind[hoy[k]] = f["wind"][i].num(1);
        if (split) { q.wx.dhi[hoy[k]] = f["dhi"][i].num(); q.wx.dni[hoy[k]] = f["dni"][i].num(); }
    }
    PVProfile prof = compute_pv_profile(q);
    // Wind turbines on the forecast 10 m wind with the project's shear and power curve, on the same UTC hours as PV
    // (q has offset 0). Losses and the design availability apply as expected values.
    q.wind.ref_height = 10;   // both providers forecast the wind at 10 m above ground
    const std::vector<double> wpt = has_wind ? wind_per_turbine(q) : std::vector<double>();

    // The planner sees PV + wind as one renewable input, as the lifecycle simulation does.
    std::vector<double> lfc(n), pfc(n), wfc(n, 0.0), re(n), aux(n);
    // Row k covers UTC [hoy + toff - 0.5, hoy + toff + 0.5) (Open-Meteo stamps the end of its hour), so in local standard time it
    // starts at hoy + s, s = toff - 0.5 + offset: it spans 1 - f of local hour hoy + n and f of the next (n = floor(s), f = s - n).
    const double s0 = toff - 0.5 + p.loc.utc_offset;
    const int ln = int(std::floor(s0));
    const double lf = s0 - ln;
    for (int k = 0; k < n; ++k) {
        const int li = ((hoy[k] + ln) % HOURS + HOURS) % HOURS;
        pfc[k] = prof.ac_per_kwp[hoy[k]] * s.pv_kwp;
        if (has_wind) wfc[k] = wpt[hoy[k]] * s.wind_units;
        re[k] = pfc[k] + wfc[k];
        aux[k] = aux_kw(p, s, f["tamb"][i0 + k].num(25));   // auxiliary load at the forecast temperature
        lfc[k] = ((1 - lf) * p.load_kw[li] + lf * p.load_kw[(li + 1) % HOURS]) * load_scale + aux[k];
    }

    const FuelTable fuel(p.dg);
    Planner planner(p.dg, fuel);
    PlanInput in = plan_input(p, fuel);
    const double eta = in.eta;
    const bool has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    in.Emin = has_bess ? s.bess_kwh * p.bess.soc_min : 0;
    in.Emax = has_bess ? s.bess_kwh * p.bess.soc_max : 0;
    in.Pb = has_bess ? s.bess_kw : 0;
    in.levels = std::max(in.levels, 41);
    const double E0 = std::clamp(soc_now * s.bess_kwh, in.Emin, in.Emax);
    std::vector<double> E_traj;
    std::vector<int> u_plan;
    planner.plan(in, E0, lfc, re, E_traj, u_plan);

    json::Value rows = json::Value::array();
    double tot_fuel = 0, tot_pv = 0, tot_wind = 0, tot_load = 0, tot_curt = 0, tot_gen = 0;
    for (int k = 0; k < n; ++k) {
        const double dE = E_traj[k + 1] - E_traj[k];
        double b = dE < 0 ? -dE * eta : -dE / eta;            // + discharge, - charge (AC side)
        if (std::fabs(b) > in.Pb) {   // first hour starts off the planner's SOC grid
            b = std::copysign(in.Pb, b);
            E_traj[k + 1] = E_traj[k] - (b > 0 ? b / eta : b * eta);
        }
        int u = 0;
        planner.hour_cost(in, lfc[k], re[k], b, u, Planner::reserve_cap(in, E_traj[k], E_traj[k + 1]));
        const double cap = u * p.dg.unit_kw;
        const double need = std::max(0.0, lfc[k] - re[k] - b);
        const double gen = u > 0 ? std::max(std::min(need, cap), cap * p.dg.min_load) : 0.0;
        const double curtail = std::max(0.0, re[k] + gen + b - lfc[k]);   // PV and wind
        const double fl = u > 0 ? cap * fuel(gen / cap) : 0.0;
        const double fpv = re[k] > 0 ? pfc[k] / re[k] : 1.0;   // renewable use split pro rata, as in the simulation
        tot_fuel += fl; tot_pv += (re[k] - curtail) * fpv; tot_wind += (re[k] - curtail) * (1 - fpv);
        tot_load += lfc[k]; tot_curt += curtail; tot_gen += gen;
        rows.push(json::Value(json::Object{
            {"time_utc", times[i0 + k].str()}, {"load_kw", lfc[k]}, {"aux_kw", aux[k]}, {"pv_kw", pfc[k]}, {"wind_kw", wfc[k]},
            {"bess_kw", b}, {"soc", s.bess_kwh > 0 ? E_traj[k + 1] / s.bess_kwh : 0.0}, {"units", u}, {"gen_kw", gen},
            {"curtail_kw", curtail}, {"fuel_l", fl}, {"unmet_kw", std::max(0.0, need - cap)}}));
    }
    // Start of the first planned hour, when soc_now applies.
    const std::string start = epoch_h_to_iso(eh[i0] + long(std::floor(toff - 0.5 + 1e-9)));
    return json::Value(json::Object{{"rows", rows}, {"utc_offset", p.loc.utc_offset}, {"provider", f.gets("provider", "")},
                                    {"note", note}, {"plan_start_utc", start}, {"issued_utc", f.gets("issued_utc", "")},
                                    {"model_updated_utc", f.gets("model_updated_utc", "")},
                                    {"totals", json::Value(json::Object{{"fuel_l", tot_fuel}, {"pv_used_kwh", tot_pv},
                                                                        {"wind_used_kwh", tot_wind}, {"load_kwh", tot_load},
                                                                        {"curtail_kwh", tot_curt}, {"gen_kwh", tot_gen}})}});
}

json::Value forecast_benchmark(const Project& p, bool with_value) {
    constexpr int MAXL = 48;
    const PVProfile prof = compute_pv_profile(p);
    const std::vector<double> cs = clearsky_pv_per_kwp(p);
    const double kwp = std::max(1.0, p.pv.capacity_kwp);
    const std::vector<double> no_ref;

    auto evaluate = [&](bool is_pv, const MethodInfo& mi) {
        const std::vector<double>& act = is_pv ? prof.ac_per_kwp : p.load_kw;
        SeriesForecaster f(mi.id, act, is_pv ? cs : no_ref, p.ems.noise_sigma, is_pv ? 12345u : 67890u);
        std::vector<double> ae(MAXL, 0), se(MAXL, 0), be(MAXL, 0);
        double n = 0, mean = 0;
        for (int t = 0; t < HOURS; ++t) {
            if (is_pv && act[t] <= 0 && cs[t] <= 0) continue;   // PV skill is judged on daylight hours only
            n += 1; mean += act[t];
            for (int L = 1; L <= MAXL; ++L) {
                const double e = f(t - L + 1, t) - act[t];
                ae[L - 1] += std::fabs(e); se[L - 1] += e * e; be[L - 1] += e;
            }
        }
        mean = n > 0 ? mean / n : 1.0;
        json::Value o = json::Value::object();
        o["id"] = mi.id; o["name"] = mi.name; o["description"] = mi.description;
        json::Value nmae = json::Value::array(), nrmse = json::Value::array(), bias = json::Value::array();
        for (int L = 0; L < MAXL; ++L) {
            nmae.push(ae[L] / n / mean);
            nrmse.push(std::sqrt(se[L] / n) / mean);
            bias.push(be[L] / n / mean);
        }
        o["nmae"] = nmae; o["nrmse"] = nrmse; o["bias"] = bias;
        // Display series: hour-ahead, and day-ahead issued at 12:00 the day before (market-style gate closure).
        std::vector<double> h1(HOURS), da(HOURS);
        const double sc = is_pv ? kwp : 1.0;
        for (int t = 0; t < HOURS; ++t) {
            h1[t] = f(t, t) * sc;
            da[t] = f((t / 24) * 24 - 12, t) * sc;
        }
        o["h1"] = json::Value(h1); o["da"] = json::Value(da);
        return o;
    };

    json::Value out = json::Value::object();
    for (bool is_pv : {true, false}) {
        const auto& list = is_pv ? pv_forecast_methods() : load_forecast_methods();
        std::vector<json::Value> res(list.size());
        std::vector<std::thread> th;
        for (size_t i = 0; i < list.size(); ++i) th.emplace_back([&, i] { res[i] = evaluate(is_pv, list[i]); });
        for (auto& x : th) x.join();
        // skill score vs persistence RMSE at each lead
        const json::Value* per = nullptr;
        for (auto& r : res) if (r["id"].str() == "persistence") per = &r;
        json::Value arr = json::Value::array();
        for (auto& r : res) {
            json::Value sk = json::Value::array();
            for (int L = 0; L < MAXL; ++L) {
                const double rp = per ? (*per)["nrmse"][L].num() : 0;
                sk.push(rp > 0 ? 1.0 - r["nrmse"][L].num() / rp : 0.0);
            }
            r["skill"] = sk;
            arr.push(r);
        }
        json::Value block = json::Value::object();
        block["methods"] = arr;
        std::vector<double> actual = is_pv ? prof.ac_per_kwp : p.load_kw;
        if (is_pv) for (double& v : actual) v *= kwp;
        block["actual"] = json::Value(actual);
        out[is_pv ? "pv" : "load"] = block;
    }

    if (with_value) {
        // Value of forecasting: year-1 predictive-EMS results with each PV method (load method fixed) and each
        // load method (PV method fixed), against load following.
        Project base = p;
        base.sim.all_years = false;
        const Sizing s{p.pv.capacity_kwp, p.bess.energy_kwh, p.bess.power_kw, double(p.wind.units)};
        struct Job { std::string kind, id, name; Project q; };
        std::vector<Job> jobs;
        { Project q = base; q.dg.strategy = "load_following"; jobs.push_back({"reference", "load_following", "Load following (no forecast)", std::move(q)}); }
        for (const auto& mi : pv_forecast_methods()) { Project q = base; q.dg.strategy = "predictive"; q.ems.pv_forecast = mi.id; jobs.push_back({"pv", mi.id, mi.name, std::move(q)}); }
        for (const auto& mi : load_forecast_methods()) { Project q = base; q.dg.strategy = "predictive"; q.ems.load_forecast = mi.id; jobs.push_back({"load", mi.id, mi.name, std::move(q)}); }
        std::vector<json::Value> res(jobs.size());
        std::atomic<size_t> next{0};
        std::vector<std::thread> pool;
        const unsigned nt = std::max(1u, std::thread::hardware_concurrency());
        for (unsigned k = 0; k < nt; ++k)
            pool.emplace_back([&] {
                for (size_t i; (i = next.fetch_add(1)) < jobs.size();) {
                    SimResult r = simulate(jobs[i].q, prof.ac_per_kwp, cs, s, false);
                    const YearResult& y = r.years[0];
                    res[i] = json::Value(json::Object{{"kind", jobs[i].kind}, {"id", jobs[i].id}, {"name", jobs[i].name},
                                                      {"fuel_l", y.fuel_l}, {"unit_hours", y.unit_hours}, {"starts", y.starts},
                                                      {"unmet", y.unmet}, {"curtailed", y.pv_curtailed}, {"re", y.re_fraction},
                                                      {"bess_efc", y.bess_efc}, {"npc", r.econ.npc}});
                }
            });
        for (auto& x : pool) x.join();
        json::Value v = json::Value::array();
        for (auto& r : res) v.push(r);
        out["value"] = v;
        out["value_note"] = std::string(p.bess.energy_kwh > 0 ? "" : "No battery in the project: the EMS has nothing to schedule, so all methods give the same result.");
    }
    return out;
}
