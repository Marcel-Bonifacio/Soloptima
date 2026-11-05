// Engine self-tests. Run with `make test`.
#include "ems.hpp"
#include "fuel.hpp"
#include "finance.hpp"
#include "json.hpp"
#include "model.hpp"
#include "optimizer.hpp"
#include "platform.hpp"
#include "pv.hpp"
#include "resource.hpp"
#include "series.hpp"
#include "shading.hpp"
#include "sha256.hpp"
#include "signature.hpp"
#include "sim.hpp"
#include "storage.hpp"
#include "update.hpp"
#include "weather.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#ifndef _WIN32
#include <sys/stat.h>
#include <unistd.h>
#endif

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { ++failures; std::printf("FAIL %s:%d  ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

// Synthetic clear-ish year: GHI from the clear-sky model scaled by a daily cloud factor.
static Project make_project(double lat, double lon) {
    Project p;
    p.loc.lat = lat; p.loc.lon = lon; p.loc.utc_offset = std::round(lon / 15);
    p.wx.is_utc = true;
    p.wx.time_offset = 0.5;
    p.wx.ghi = clearsky_ghi(p);
    for (int i = 0; i < HOURS; ++i) p.wx.ghi[i] *= 0.6 + 0.35 * std::sin(i / 24 * 1.7);
    p.wx.tamb.assign(HOURS, 27.0);
    p.wx.wind.assign(HOURS, 1.5);
    p.load_kw.resize(HOURS);
    for (int i = 0; i < HOURS; ++i) p.load_kw[i] = 1000 + 200 * std::sin((i % 24) / 24.0 * 6.283);
    p.dg.unit_kw = 400; p.dg.units = 5;
    p.pv.capacity_kwp = 1500; p.pv.azimuth = lat >= 0 ? 180 : 0;
    p.bess.energy_kwh = 2000; p.bess.power_kw = 1000;
    p.econ.lifetime = 20;
    return p;
}

static double balance_error(const Hourly& h) {
    double e = 0;
    for (int t = 0; t < HOURS; ++t) {
        e = std::max(e, std::fabs(h.load[t] - (h.pv_to_load[t] + h.wind_to_load[t] + h.bess_dis[t] + h.gen_to_load[t] + h.unmet[t])));
        e = std::max(e, std::fabs(h.pv_avail[t] - (h.pv_to_load[t] + h.pv_to_bess[t] + h.pv_curtailed[t])));
    }
    return e;
}

int main() {
    // 1. Sun position: solar noon zenith at the equinox ~= |latitude|
    {
        SunPos s = sun_position(-2.5, 115.5, 80, 12.0 - 115.5 / 15.0 + 0.12);
        CHECK(std::fabs(s.zenith_deg - 2.5) < 1.5, "equinox noon zenith %.2f", s.zenith_deg);
        SunPos n = sun_position(50, 0, 172, 12.0);
        CHECK(std::fabs(n.zenith_deg - (50 - 23.44)) < 1.0, "summer solstice zenith %.2f", n.zenith_deg);
        CHECK(std::fabs(n.azimuth_deg - 180) < 5, "noon azimuth %.1f", n.azimuth_deg);
    }
    // 2. PV yield plausibility and loss chain monotonic in energy part
    Project p = make_project(-2.5, 115.5);
    PVProfile prof = compute_pv_profile(p);
    CHECK(prof.specific_yield > 900 && prof.specific_yield < 2000, "specific yield %.0f", prof.specific_yield);
    CHECK(prof.performance_ratio > 0.65 && prof.performance_ratio < 0.92, "PR %.3f", prof.performance_ratio);
    for (size_t i = 6; i < prof.losses.size(); ++i)
        CHECK(prof.losses[i].value <= prof.losses[i - 1].value * 1.031, "loss step %zu increases", i);
    double peak = *std::max_element(prof.ac_per_kwp.begin(), prof.ac_per_kwp.end());
    CHECK(peak <= 1.0 / p.pv.dc_ac_ratio + 1e-9, "clipping limit exceeded %.3f", peak);

    std::vector<double> cs = clearsky_pv_per_kwp(p);
    // 3. Energy balance and invariants for every strategy
    for (const char* strat : {"load_following", "cycle_charging", "predictive"}) {
        Project q = p;
        q.dg.strategy = strat;
        SimResult r = simulate(q, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000}, true);
        CHECK(balance_error(r.hourly) < 1e-6 * 1500 + 0.05, "%s balance error %.4f", strat, balance_error(r.hourly));
        for (int t = 0; t < HOURS; ++t) {
            CHECK(r.hourly.soc[t] >= q.bess.soc_min - 1e-6 && r.hourly.soc[t] <= q.bess.soc_max + 1e-6, "%s SOC out of window at %d", strat, t);
            CHECK(r.hourly.gen_units[t] >= q.dg.min_units_online, "%s min units violated", strat);
            if (r.hourly.gen_units[t] > 0) {
                double g = r.hourly.gen_to_load[t] + r.hourly.gen_to_bess[t] + r.hourly.gen_dump[t];
                CHECK(g >= r.hourly.gen_units[t] * q.dg.unit_kw * q.dg.min_load - 1e-6, "%s genset below min load", strat);
                CHECK(g <= r.hourly.gen_units[t] * q.dg.unit_kw + 1e-6, "%s genset above rating", strat);
            }
            if (failures > 20) break;
        }
        CHECK(r.unmet_fraction < 1e-9, "%s unmet %.5f", strat, r.unmet_fraction);
        CHECK(r.years.size() == size_t(q.econ.lifetime), "%s years %zu", strat, r.years.size());
        std::printf("  %-15s fuel %10.0f L  RE %.3f  NPC %.4g  EFC %.0f\n", strat, r.fuel_l_y1, r.re_fraction, r.econ.npc, r.years[0].bess_efc);
    }
    // 4. Baseline: no PV -> zero RE; adding PV never increases year-1 fuel (load following)
    {
        SimResult b = simulate(p, prof.ac_per_kwp, cs, Sizing{}, false);
        CHECK(b.re_fraction < 1e-9, "baseline RE %.4f", b.re_fraction);
        double prev = b.fuel_l_y1;
        for (double kwp : {300.0, 600.0, 1200.0, 2400.0}) {
            SimResult r = simulate(p, prof.ac_per_kwp, cs, Sizing{kwp, 0, 0}, false);
            CHECK(r.fuel_l_y1 <= prev + 1e-6, "fuel rose with PV %.0f kWp", kwp);
            prev = r.fuel_l_y1;
        }
    }
    // 5. Perfect-forecast EMS NPC should be at most 1 % above load following
    {
        Project a = p, b = p;
        a.dg.strategy = "load_following";
        b.dg.strategy = "predictive"; b.ems.pv_forecast = "perfect"; b.ems.load_forecast = "perfect";
        a.sim.all_years = b.sim.all_years = false;
        double fa = simulate(a, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000}, false).econ.npc;
        double fb = simulate(b, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000}, false).econ.npc;
        CHECK(fb <= fa * 1.01, "perfect EMS NPC %.0f vs LF %.0f", fb, fa);
    }
    // 6. Optimiser finds a feasible optimum inside the box
    {
        Project q = p;
        q.sim.all_years = false;
        json::Value o = json::parse(R"({"pv_max":4000,"pv_steps":6,"bess_max":6000,"bess_steps":5})");
        Progress prog;
        json::Value res = optimize(q, parse_opt_settings(o, q), prog);
        CHECK(!res["best"].is_null(), "optimiser found nothing");
        CHECK(res["best"]["npc"].num() <= res["baseline"]["econ"]["npc"].num() + 1, "optimum worse than diesel only");
        // re-optimising sensitivity: a battery that lasts twice as long cannot make the best design dearer
        json::Value so = json::parse(R"({"pv_max":4000,"pv_steps":3,"bess_max":6000,"bess_steps":3,"refine":false,"sens_var":"bess_life_scale","sens_values":[0.5,2]})");
        Progress sp;
        json::Value sr = optimize(q, parse_opt_settings(so, q), sp);
        const json::Value& rows = sr["sensitivity"]["rows"];
        CHECK(rows.size() == 2 && !rows[0]["best"].is_null() && !rows[1]["best"].is_null(), "battery life sensitivity: %zu rows", rows.size());
        if (rows.size() == 2 && !rows[0]["best"].is_null() && !rows[1]["best"].is_null())
            CHECK(rows[1]["best"]["npc"].num() <= rows[0]["best"]["npc"].num(), "best NPC %.0f at life x2 above %.0f at life x0.5",
                  rows[1]["best"]["npc"].num(), rows[0]["best"]["npc"].num());
        bool refused = false;
        try { parse_opt_settings(json::parse(R"({"sens_var":"bess_life_scale","sens_values":[0]})"), q); } catch (const std::exception&) { refused = true; }
        CHECK(refused, "a battery life scale of 0 was accepted");
        if (rows.size() == 2 && !rows[0]["best"].is_null() && !rows[1]["best"].is_null())
            std::printf("  battery life x0.5: best NPC %.4g (%.0f kWh); x2: %.4g (%.0f kWh)\n", rows[0]["best"]["npc"].num(), rows[0]["best"]["bess_kwh"].num(),
                        rows[1]["best"]["npc"].num(), rows[1]["best"]["bess_kwh"].num());
    }
    // 7. Wind turbines, literature indicators, self-discharge
    {
        Project q = p;
        q.sim.all_years = false;
        for (int i = 0; i < HOURS; ++i) q.wx.wind[i] = 5.0 + 3.0 * std::sin(i / 7.0);
        q.wind.units = 2; q.wind.rated_kw = 500;
        SimResult r = simulate(q, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000, 2}, true);
        CHECK(r.years[0].wind_avail > 0, "wind produced nothing");
        CHECK(balance_error(r.hourly) < 0.05, "energy balance with wind %.4f", balance_error(r.hourly));
        CHECK(r.metrics.sssi > 0 && r.metrics.sssi <= 1 && r.metrics.ssci > 0 && r.metrics.ssci <= 1, "SSSI/SSCI out of range");
        CHECK(std::fabs(r.metrics.rep - 100 * (1 - r.metrics.lpsp)) < 1e-9, "REP");
        CHECK(r.econ.crf > 0 && std::fabs(r.econ.tac - r.econ.npc * r.econ.crf) < 1e-6 * r.econ.tac, "TAC");
        Project sd = q; sd.bess.self_discharge = 0.001;
        SimResult r2 = simulate(sd, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000, 2}, false);
        CHECK(r2.years[0].self_discharge > 0, "self-discharge not applied");
        std::printf("  wind: %.0f MWh avail, SSSI %.3f, SSCI %.3f, LPSP %.5f\n", r.years[0].wind_avail / 1000, r.metrics.sssi, r.metrics.ssci, r.metrics.lpsp);
    }
    // 8. Metaheuristics reach (nearly) the grid optimum on the same problem
    {
        Project q = p;
        q.sim.all_years = false;
        auto run = [&](const char* alg) {
            json::Value o = json::parse(std::string(R"({"pv_max":4000,"pv_steps":9,"bess_max":6000,"bess_steps":7,"particles":16,"iterations":25,"algorithm":")") + alg + std::string("\"}"));
            Progress prog;
            return optimize(q, parse_opt_settings(o, q), prog);
        };
        const double g = run("grid")["best"]["npc"].num();
        for (const char* alg : {"pso", "hshoa", "mopso"}) {
            json::Value r = run(alg);
            CHECK(!r["best"].is_null(), "%s found nothing", alg);
            if (std::string(alg) != "mopso") CHECK(r["best"]["npc"].num() <= g * 1.01, "%s NPC %.0f vs grid %.0f", alg, r["best"]["npc"].num(), g);
            else CHECK(r["pareto"].size() >= 1 && r["best"]["npc"].num() <= g * 1.05, "MOPSO archive empty or far from the grid optimum");
            std::printf("  %-6s best NPC %.4g (grid %.4g), %ld evaluations\n", alg, r["best"]["npc"].num(), g, long(r["n_evaluated"].num()));
        }
    }
    // 9. Project finance: repayment, sculpting, IRR/NPV consistency, tariff solving, loss carry-forward
    {
        Project q = p;
        q.sim.all_years = true;
        SimResult h = simulate(q, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000}, false);
        SimResult b = simulate(q, prof.ac_per_kwp, cs, Sizing{}, false);
        auto fin = [&](const char* js) { return run_finance(q, parse_finance(json::parse(js), q), h, b); };
        json::Value r = fin(R"({"model":"ppa","components":[{"name":"E","v1":0.2}],"sizing":"dscr","repayment":"sculpted","dscr_target":1.35,"tenor":10,"interest":0.08,"construction_years":1})");
        const auto& Y = r["years"].arr();
        double minD = 1e9, maxD = 0;
        for (const auto& y : Y) if (!y["dscr"].is_null()) { minD = std::min(minD, y["dscr"].num()); maxD = std::max(maxD, y["dscr"].num()); }
        CHECK(std::fabs(minD - 1.35) < 0.01 && std::fabs(maxD - 1.35) < 0.01, "sculpted DSCR %.3f..%.3f, expected 1.35", minD, maxD);
        double paid = 0;
        for (const auto& y : Y) paid += y["principal"].num();
        CHECK(std::fabs(paid - r["metrics"]["debt"].num()) < 1e-3 * std::max(1.0, paid), "debt not fully repaid: %.0f of %.0f", paid, r["metrics"]["debt"].num());
        // equity NPV at the equity IRR is zero
        const double irr = r["metrics"]["equity_irr"].num();
        double v = 0;
        for (size_t t = 0; t < Y.size(); ++t) v += Y[t]["equity_cf"].num() / std::pow(1 + irr, double(t));
        CHECK(std::fabs(v) < 1e-3 * std::fabs(Y[0]["equity_cf"].num()), "NPV at IRR = %.2f", v);
        // tariff solver hits the target
        json::Value s = fin(R"({"model":"ppa","components":[{"name":"E","v1":0.1}],"solve":true,"target_irr":0.13,"gearing":0.6,"sizing":"gearing","repayment":"annuity"})");
        CHECK(s["solved"]["ok"].boolean() && std::fabs(s["metrics"]["equity_irr"].num() - 0.13) < 1e-4, "solved IRR %.5f", s["metrics"]["equity_irr"].num());
        // loss carry-forward lowers lifetime tax compared with no carry-forward
        auto tax_sum = [&](const char* js) { const json::Value res = fin(js); double t = 0; for (const auto& y : res["years"].arr()) t += y["tax"].num(); return t; };
        const double t_cf = tax_sum(R"({"model":"ppa","components":[{"name":"E","v1":0.2}],"loss_cf_years":0,"dep_method":"db","dep_life":4,"gearing":0.8})");
        const double t_no = tax_sum(R"({"model":"ppa","components":[{"name":"E","v1":0.2}],"loss_cf_years":-1,"dep_method":"db","dep_life":4,"gearing":0.8})");
        CHECK(t_cf < t_no, "loss carry-forward did not reduce tax (%.0f vs %.0f)", t_cf, t_no);
        // host model: revenue equals avoided diesel cost
        json::Value host = fin(R"({"model":"host","gearing":0})");
        const json::Value y1 = host["years"][1];
        CHECK(std::fabs(y1["revenue"].num() - (b.years[0].c_fuel + b.years[0].c_om_dg + b.years[0].c_carbon - h.years[0].c_fuel - h.years[0].c_om_dg - h.years[0].c_carbon)) < 1e-6 * y1["revenue"].num(), "host revenue");
        std::printf("  finance: sculpted DSCR %.3f, equity IRR %.4f, solved tariff x%.4f, tax with/without CF %.0f/%.0f\n", minD, irr, s["metrics"]["tariff_scale"].num(), t_cf, t_no);
    }
    // 10. DC wiring loss basis: "stc" scales the STC loss with the hourly string current over voltage, "annual" is a constant fraction
    {
        CHECK(parse_project(json::parse("{}")).pv.dc_wiring_basis == "annual", "default DC wiring basis");
        Project q = p;
        q.pv.dc_wiring = 0;
        const double dc0 = compute_pv_profile(q).losses[8].value;
        q.pv.dc_wiring = 0.015;
        PVProfile ann = compute_pv_profile(q);
        CHECK(ann.specific_yield == prof.specific_yield, "annual basis changed the yield %.9f vs %.9f", ann.specific_yield, prof.specific_yield);
        CHECK(std::fabs(ann.losses[8].value / dc0 - 0.985) < 1e-12, "annual-basis wiring loss %.6f", 1 - ann.losses[8].value / dc0);
        q.pv.dc_wiring_basis = "stc";
        PVProfile stc = compute_pv_profile(q);
        const double loss = 1 - stc.losses[8].value / dc0;
        CHECK(loss > 0.006 && loss < 0.014, "STC-basis wiring loss %.4f", loss);
        CHECK(stc.specific_yield > ann.specific_yield, "STC basis should lose less than the annual basis");
        std::printf("  DC wiring 1.5 %% at STC: %.2f %% of annual DC energy, yield %.1f vs %.1f kWh/kWp\n", loss * 100, stc.specific_yield, ann.specific_yield);
    }
    // 11. Battery ageing: DC cycles against the cycle life at its rated DoD, replacement threshold, initial SOH
    {
        const Project d = parse_project(json::parse(R"({"bess":{"replace_soh":null}})"));
        CHECK(d.bess.cycle_life_dod == 1.0 && d.bess.replace_soh == -1 && d.bess.soh_init == 1.0 && d.bess.warranty_efc_yr == 0, "battery ageing defaults");
        Project q = p;
        q.sim.all_years = false;
        q.econ.lifetime = 25;
        q.dg.strategy = "cycle_charging";   // cycles enough to need several replacements
        q.bess.rte = 1.0;
        const Sizing sz{1500, 2000, 1000};
        SimResult r = simulate(q, prof.ac_per_kwp, cs, sz, false);
        const YearResult& y1 = r.years[0];
        CHECK(!y1.bess_replaced && y1.bess_efc_dc == y1.bess_efc, "RTE 1: DC and AC cycles differ");
        const double soh2 = 1 - q.bess.calendar_fade - y1.bess_efc * (1 - q.bess.eol_soh) / q.bess.cycle_life;
        CHECK(std::fabs(r.years[1].bess_soh - soh2) < 1e-12, "SOH after year 1 %.15f vs %.15f", r.years[1].bess_soh, soh2);
        CHECK(std::fabs(y1.soh_loss_cal + y1.soh_loss_cyc - (1 - soh2)) < 1e-12, "SOH loss split");
        CHECK(y1.max_c_rate > 0 && y1.max_c_rate <= sz.bess_kw / sz.bess_kwh + 1e-12, "max C-rate %.4f", y1.max_c_rate);
        q.bess.rte = 0.88;
        const SimResult r88 = simulate(q, prof.ac_per_kwp, cs, sz, false);
        CHECK(std::fabs(r88.years[0].bess_efc_dc * std::sqrt(0.88) - r88.years[0].bess_efc) < 1e-9 * r88.years[0].bess_efc, "DC cycles = AC cycles / one-way efficiency");

        auto first_repl = [&](const Project& x) {
            const SimResult s = simulate(x, prof.ac_per_kwp, cs, sz, false);
            for (const auto& Y : s.years) if (Y.bess_replaced) return Y.year;
            return 1000;
        };
        auto n_repl = [&](const Project& x) { return simulate(x, prof.ac_per_kwp, cs, sz, false).bess_replacements; };
        const int f10 = first_repl(q);
        CHECK(f10 < q.econ.lifetime, "no battery replacement within %d years", q.econ.lifetime);
        Project a = q; a.bess.cycle_life_dod = 0.9;
        CHECK(first_repl(a) <= f10, "cycle life at 90 %% DoD replaced in year %d, at 100 %% in year %d", first_repl(a), f10);
        Project b6 = q, b7 = q; b6.bess.replace_soh = 0.6; b7.bess.replace_soh = 0.7;
        CHECK(n_repl(b6) <= n_repl(b7), "replacing at 60 %% gives %d replacements, at 70 %% %d", n_repl(b6), n_repl(b7));
        Project old = q; old.bess.soh_init = 0.8;
        CHECK(first_repl(old) < f10, "initial SOH 80 %% replaced in year %d, new battery in year %d", first_repl(old), f10);
        // a second-life battery that is not replaced: salvage measures the SOH left against the SOH it was installed at
        Project sl = q; sl.bess.soh_init = 0.9; sl.econ.lifetime = 3; sl.dg.strategy = "load_following";
        const SimResult rs = simulate(sl, prof.ac_per_kwp, cs, sz, false);
        const YearResult& yl = rs.years.back();
        const double soh_end = yl.bess_soh - yl.soh_loss_cal - yl.soh_loss_cyc;
        const double pv_salv = rs.econ.capex_pv * (sl.econ.pv_life - sl.econ.lifetime) / sl.econ.pv_life;
        const double b_salv = rs.econ.capex_bess * (soh_end - sl.bess.eol_soh) / (0.9 - sl.bess.eol_soh);
        CHECK(rs.bess_replacements == 0 && b_salv > 0 && std::fabs(-yl.c_salvage - pv_salv - b_salv) < 1e-6 * b_salv,
              "second-life battery salvage %.2f, expected %.2f", -yl.c_salvage - pv_salv, b_salv);
        // without a battery the reported SOH stays at 100 % whatever the initial SOH
        bool soh_one = true;
        for (const auto& Y : simulate(old, prof.ac_per_kwp, cs, Sizing{1500, 0, 0}, false).years) soh_one = soh_one && Y.bess_soh == 1.0;
        CHECK(soh_one, "no battery: SOH reported below 100 %%");
        // a replacement threshold of 0 % is rejected, blank (-1) and 60 % are accepted
        auto valid = [&](double r) { Project x = q; x.bess.replace_soh = r; try { validate_project(x); return true; } catch (const std::exception&) { return false; } };
        CHECK(!valid(0) && valid(-1) && valid(0.6), "replacement SOH 0 / blank / 60 %%: %d / %d / %d", valid(0), valid(-1), valid(0.6));
        std::printf("  battery: EFC %.0f AC / %.0f DC, first replacement year %d (DoD 90 %%: %d, initial SOH 80 %%: %d), replacements at 70/60 %%: %d/%d\n",
                    r88.years[0].bess_efc, r88.years[0].bess_efc_dc, f10, first_repl(a), first_repl(old), n_repl(b7), n_repl(b6));
    }
    // 12. Auxiliary loads: battery HVAC/BMS per MWh (with temperature rise), plant auxiliaries, transformer no-load
    {
        const AuxParams d = parse_project(json::parse("{}")).aux;
        CHECK(d.bess_kw_per_mwh == 0 && d.bess_temp_coeff == 0 && d.ref_c == 25 && d.plant_kw == 0 && d.trafo_noload_kw == 0 && d.bess_trafo_noload_kw == 0 &&
                  d.pcs_kw_per_mw == 0,
              "auxiliary load defaults");
        Project q = p;
        q.sim.all_years = false;
        const Sizing sz{1500, 2000, 1000};
        const SimResult r0 = simulate(q, prof.ac_per_kwp, cs, sz, true);
        const YearResult& z = r0.years[0];
        CHECK(z.aux == 0 && z.served_site == z.served, "zero auxiliary load changed the served energy");
        CHECK(std::equal(q.load_kw.begin(), q.load_kw.end(), r0.hourly.load.begin()), "zero auxiliary load changed the dispatched load");
        CHECK(std::fabs(r0.fuel_l_y1 / 1758494.67669 - 1) < 1e-9, "fuel without auxiliary load %.6f L, expected 1758494.67669 L as before auxiliary loads", r0.fuel_l_y1);

        // PCS no-load loss: kW per MW of PCS rating in every hour, only with a battery, and it follows the candidate's PCS size
        {
            Project c = q;
            c.aux.pcs_kw_per_mw = 2;
            auto aux_c = [&](const Sizing& s) { return simulate(c, prof.ac_per_kwp, cs, s, false).years[0].aux; };
            const SimResult rc = simulate(c, prof.ac_per_kwp, cs, sz, true);
            CHECK(std::fabs(rc.years[0].aux - z.aux - 2 * 1.0 * HOURS) < 1e-6, "PCS no-load %.6f kWh, expected 17520", rc.years[0].aux - z.aux);
            CHECK(std::fabs(aux_c(Sizing{1500, 2000, 2000}) - 2 * (2 * 1.0 * HOURS)) < 1e-6, "PCS no-load with twice the PCS %.6f kWh, expected 35040",
                  aux_c(Sizing{1500, 2000, 2000}));
            CHECK(aux_c(Sizing{1500, 0, 0}) == 0, "PCS no-load counted without a battery");
            CHECK(rc.fuel_l_y1 > r0.fuel_l_y1 && balance_error(rc.hourly) < 0.05, "PCS no-load: fuel %.0f vs %.0f L, balance %.4f", rc.fuel_l_y1, r0.fuel_l_y1,
                  balance_error(rc.hourly));
            CHECK(aux_kw(c, sz, 25) == 2 && aux_kw(c, Sizing{1500, 0, 0}, 25) == 0, "PCS no-load in the day-ahead auxiliary load");
            c.aux.pcs_kw_per_mw = -1;
            bool rejected = false;
            try { validate_project(c); } catch (const std::exception&) { rejected = true; }
            CHECK(rejected, "negative PCS no-load loss accepted");
        }

        q.aux.bess_kw_per_mwh = 1.0;
        const SimResult r1 = simulate(q, prof.ac_per_kwp, cs, sz, true);
        const YearResult& y1 = r1.years[0];
        CHECK(std::fabs(y1.aux - 17520) < 1e-6, "battery auxiliary %.6f kWh, expected 17520", y1.aux);
        CHECK(r1.fuel_l_y1 > r0.fuel_l_y1, "auxiliary load did not raise fuel (%.0f vs %.0f L)", r1.fuel_l_y1, r0.fuel_l_y1);
        CHECK(balance_error(r1.hourly) < 0.05, "energy balance with auxiliary load %.4f", balance_error(r1.hourly));
        CHECK(std::fabs(y1.served_site - (y1.served - y1.aux)) < 1e-9 && std::fabs(y1.load - y1.aux - z.load) < 1e-6, "site energy");
        double disc = 0;
        for (const auto& Y : r1.years) disc += Y.served_site / std::pow(1 + q.econ.discount_rate, Y.year);
        CHECK(std::fabs(r1.econ.lcoe - r1.econ.npc / disc) < 1e-12 * r1.econ.lcoe, "LCOE not on served site energy");
        CHECK(std::fabs(r1.econ.coe - r1.econ.tac / y1.served_site) < 1e-12 * r1.econ.coe, "COE not on served site energy");
        const SimResult b = simulate(q, prof.ac_per_kwp, cs, Sizing{}, false);
        CHECK(b.years[0].aux == 0, "diesel-only baseline has auxiliary load %.1f", b.years[0].aux);
        const json::Value fy = run_finance(q, parse_finance(json::parse(R"({"model":"host"})"), q), r1, b)["years"][1];
        CHECK(std::fabs(fy["energy"].num() - y1.served_site * y1.re_fraction) < 1e-6, "billed energy not on served site energy");

        q.aux.bess_temp_coeff = 0.02;   // 2 %/degC above 25 degC; the synthetic year is 27 degC throughout
        q.aux.plant_kw = 10; q.aux.trafo_noload_kw = 5;
        CHECK(std::fabs(simulate(q, prof.ac_per_kwp, cs, sz, false).years[0].aux - (2 * 1.04 + 15) * HOURS) < 1e-6, "temperature rise or plant auxiliaries");
        CHECK(std::fabs(simulate(q, prof.ac_per_kwp, cs, Sizing{1500, 0, 0}, false).years[0].aux - 15 * HOURS) < 1e-6, "PV-only plant auxiliaries");
        // each step-up transformer's no-load only with the asset it serves; plant auxiliaries also with wind alone
        q.aux.bess_trafo_noload_kw = 3;
        auto aux_of = [&](const Sizing& s) { return simulate(q, prof.ac_per_kwp, cs, s, false).years[0].aux; };
        CHECK(std::fabs(aux_of(sz) - (2 * 1.04 + 18) * HOURS) < 1e-6, "hybrid auxiliaries %.3f", aux_of(sz));
        CHECK(std::fabs(aux_of(Sizing{1500, 0, 0}) - 15 * HOURS) < 1e-6, "PV-only auxiliaries with BESS transformer no-load %.3f", aux_of(Sizing{1500, 0, 0}));
        CHECK(std::fabs(aux_of(Sizing{0, 2000, 1000}) - (2 * 1.04 + 10 + 3) * HOURS) < 1e-6, "battery-only auxiliaries %.3f", aux_of(Sizing{0, 2000, 1000}));
        Project w = q;
        w.aux = AuxParams{};
        w.aux.plant_kw = 20; w.aux.trafo_noload_kw = 12.4;
        w.wind.units = 3; w.wind.rated_kw = 2000;
        CHECK(std::fabs(simulate(w, prof.ac_per_kwp, cs, Sizing{0, 0, 0, 3}, false).years[0].aux - 20 * HOURS) < 1e-6, "wind + diesel plant auxiliaries");
        CHECK(simulate(w, prof.ac_per_kwp, cs, Sizing{}, false).years[0].aux == 0, "diesel-only baseline with auxiliaries");
        // no gensets: in dark hours the auxiliaries go unserved too, so the energy served to the site never turns negative
        Project dk = q;
        dk.dg.units = 0; dk.aux = AuxParams{}; dk.aux.plant_kw = 200;
        const SimResult rd = simulate(dk, prof.ac_per_kwp, cs, sz, true);
        double site = 0, worst_site = 1e300;
        for (int t = 0; t < HOURS; ++t) site += std::max(0.0, rd.hourly.load[t] - rd.hourly.aux[t] - rd.hourly.unmet[t]);
        for (const auto& Y : rd.years) worst_site = std::min(worst_site, Y.served_site);
        CHECK(site > 0 && worst_site > 0 && std::fabs(rd.years[0].served_site - site) < 1e-6 * site && rd.years[0].lol_h > 0,
              "served site %.1f vs hourly %.1f (lowest year %.1f)", rd.years[0].served_site, site, worst_site);
        std::printf("  auxiliaries: %.0f kWh/yr raise fuel by %.0f L (%.2f L/kWh), LCOE %.5f\n", y1.aux, r1.fuel_l_y1 - r0.fuel_l_y1,
                    (r1.fuel_l_y1 - r0.fuel_l_y1) / y1.aux, r1.econ.lcoe);
    }
    // 13. Operational adequacy: reserve shortfall, loss-of-load events, battery reserve duration, planner reserve credit
    {
        CHECK(parse_project(json::parse("{}")).bess.reserve_duration_h == 1.0, "default battery reserve duration");
        Project q = p;
        q.sim.all_years = false;
        const Sizing sz{1500, 2000, 1000};
        // the real-time battery reserve rule is unchanged at 1 h: fuel as recorded before the adequacy outputs
        // (cycle charging as recorded after its charging hold, section 17)
        Project lf = q, cc = q;
        lf.dg.strategy = "load_following"; cc.dg.strategy = "cycle_charging";
        const double f_lf = simulate(lf, prof.ac_per_kwp, cs, sz, false).fuel_l_y1, f_cc = simulate(cc, prof.ac_per_kwp, cs, sz, false).fuel_l_y1;
        CHECK(std::fabs(f_lf / 1758494.6766903412 - 1) < 1e-12, "load-following fuel %.10f L changed", f_lf);
        CHECK(std::fabs(f_cc / 1774377.1913676145 - 1) < 1e-12, "cycle-charging fuel %.10f L changed", f_cc);
        // with spare units the reserve left after allocation covers the requirement, also with gensets held at minimum loading
        for (const Sizing& s : {sz, Sizing{4000, 0, 0}, Sizing{}}) {
            const YearResult y = simulate(q, prof.ac_per_kwp, cs, s, false).years[0];
            CHECK(y.fleet_full_h == 0 && y.reserve_short_h == 0 && y.lol_h == 0, "%.0f kWp / %.0f kWh: %.0f h short of reserve with spare units", s.pv_kwp, s.bess_kwh, y.reserve_short_h);
        }
        // a longer reserve duration counts less battery reserve, so more gensets run
        auto unit_h = [&](double h) { Project x = q; x.bess.reserve_duration_h = h; return simulate(x, prof.ac_per_kwp, cs, sz, false).years[0].unit_hours; };
        const double uh25 = unit_h(0.25), uh1 = unit_h(1.0), uh4 = unit_h(4.0);
        CHECK(uh25 <= uh1 && uh1 < uh4, "unit-hours with reserve duration 0.25 / 1 / 4 h: %.0f / %.0f / %.0f", uh25, uh1, uh4);

        // 3 x 400 kW for a 800-1200 kW load: diesel only cannot hold 10 % reserve at the peak
        Project f3 = q; f3.dg.units = 3;
        const YearResult b3 = simulate(f3, prof.ac_per_kwp, cs, Sizing{}, false).years[0];
        CHECK(b3.reserve_short_h > 0 && b3.reserve_short_max_kw > 0 && b3.lol_h == 0, "3 units: %.0f h short of reserve, %.0f h loss of load", b3.reserve_short_h, b3.lol_h);
        CHECK(b3.max_units == 3 && b3.fleet_full_h == HOURS, "3 units: max online %.0f, fleet fully online %.0f h", b3.max_units, b3.fleet_full_h);

        // 2 x 400 kW: loss-of-load hours, events and the longest event match the hourly series
        Project f2 = q; f2.dg.units = 2;
        const SimResult r2 = simulate(f2, prof.ac_per_kwp, cs, sz, true);
        const YearResult& y2 = r2.years[0];
        int n = 0, ev = 0, run = 0, longest = 0;
        for (int t = 0; t < HOURS; ++t) {
            const bool lol = r2.hourly.unmet[t] > 1e-3 * r2.hourly.load[t];
            run = lol ? run + 1 : 0;
            n += lol; ev += run == 1; longest = std::max(longest, run);
        }
        CHECK(y2.lol_h == n && y2.lol_events == ev && y2.lol_max_h == longest, "loss of load %.0f h / %.0f events / %.0f h longest vs hourly %d / %d / %d",
              y2.lol_h, y2.lol_events, y2.lol_max_h, n, ev, longest);
        CHECK(y2.lol_events >= 1 && y2.lol_max_h >= 1 && y2.max_units == 2, "2 units: no loss-of-load event");
        Project grow = f2; grow.sim.all_years = true; grow.sim.load_growth = 0.02;
        const SimResult rg = simulate(grow, prof.ac_per_kwp, cs, sz, false);
        CHECK(rg.unmet_fraction_max > rg.unmet_fraction, "load growth: worst-year unmet %.5f vs year 1 %.5f", rg.unmet_fraction_max, rg.unmet_fraction);

        // Planner: with an almost empty battery, units are committed with at most (E - Emin) x eta / reserve_h of battery reserve
        const FuelTable fuel(q.dg);
        Planner pl(q.dg, fuel);
        PlanInput in = plan_input(q, fuel);
        in.Emin = 200; in.Emax = 2000; in.Pb = 1000;
        const std::vector<double> lf12(12, 1100.0), pf12(12, 0.0);
        std::vector<double> E_traj;
        std::vector<int> u_plan;
        pl.plan(in, in.Emin + 5, lf12, pf12, E_traj, u_plan);
        int more = 0;
        for (int j = 0; j < 12; ++j) {
            const double dE = E_traj[j + 1] - E_traj[j], b = dE < 0 ? -dE * in.eta : -dE / in.eta;
            const double credit = std::max(0.0, std::min(E_traj[j], E_traj[j + 1]) - in.Emin) * in.eta / in.reserve_h;
            const double need = std::max(0.0, lf12[j] - pf12[j] - b) + std::max(0.0, q.dg.reserve_load * lf12[j] - credit);
            const int u_min = std::min(q.dg.units, int(std::ceil(need / q.dg.unit_kw - 1e-9)));
            CHECK(u_plan[j] >= u_min, "hour %d: %d units planned, reserve credit of %.0f kW needs %d", j, u_plan[j], credit, u_min);
            int u_old;
            pl.hour_cost(in, lf12[j], pf12[j], b, u_old);   // battery power alone as reserve, as before
            more += u_plan[j] > u_old;
        }
        CHECK(more > 0, "the reserve energy limit never raised the planned units");
        // at a 4 h reserve duration the plan commits exactly the units the real-time rule needs for the plan's own discharge
        in.reserve_h = 4;
        std::vector<double> lf24(24), pf24(24, 0.0);
        for (int j = 0; j < 24; ++j) lf24[j] = 1000 + 200 * std::sin(2 * 3.14159265358979 * j / 24);
        pl.plan(in, in.Emax, lf24, pf24, E_traj, u_plan);
        int off = 0;
        for (int j = 0; j < 24; ++j) {
            const double dE = E_traj[j + 1] - E_traj[j], b = dE < 0 ? -dE * in.eta : -dE / in.eta;
            const double res = std::max(0.0, std::min(in.Pb, (E_traj[j] - in.Emin) * in.eta / in.reserve_h) - std::max(b, 0.0));
            const double need = std::max(0.0, lf24[j] - pf24[j] - b) + std::max(0.0, q.dg.reserve_load * lf24[j] - res);
            const int u_rt = std::min(std::max(need > 1e-6 ? int(std::ceil(need / q.dg.unit_kw - 1e-9)) : 0, q.dg.min_units_online), q.dg.units);
            if (u_plan[j] != u_rt) { ++off; CHECK(false, "reserve 4 h, hour %d: %d units planned, real time needs %d", j, u_plan[j], u_rt); }
        }
        std::printf("  adequacy: 3 units diesel-only %.0f h short of reserve (max %.0f kW); 2 units %.0f h loss of load in %.0f events (longest %.0f h); planner commits more units in %d of 12 h, %d of 24 h off real time at 4 h\n",
                    b3.reserve_short_h, b3.reserve_short_max_kw, y2.lol_h, y2.lol_events, y2.lol_max_h, more, off);
    }
    // 14. The battery's own value: PV only (same PV, no battery) as the reference of compare()
    {
        const Sizing hs{1500, 2000, 1000}, ps{1500, 0, 0};
        const SimResult pvo = simulate(p, prof.ac_per_kwp, cs, ps, true);
        double flow = 0;
        for (const auto& Y : pvo.years) flow = std::max({flow, Y.bess_dis, Y.bess_ch});
        CHECK(pvo.years.size() == size_t(p.econ.lifetime) && flow == 0 && pvo.bess_replacements == 0, "PV only: battery flow %.3f kWh, %d replacements", flow, pvo.bess_replacements);
        CHECK(balance_error(pvo.hourly) < 0.05, "PV-only energy balance %.4f", balance_error(pvo.hourly));
        const SimResult hyb = simulate(p, prof.ac_per_kwp, cs, hs, false);
        const Comparison cb = compare(hyb, pvo);
        CHECK(std::fabs(cb.npv_savings - (pvo.econ.npc - hyb.econ.npc)) < 1e-6, "battery NPV %.6f vs NPC difference %.6f", cb.npv_savings, pvo.econ.npc - hyb.econ.npc);
        CHECK(std::fabs(hyb.econ.capex_total - pvo.econ.capex_total - hyb.econ.capex_bess) < 1e-6, "incremental capex is not the battery capex");
        // the incremental cash flow carries the battery capex, O&M, replacements and salvage: its NPV is the NPV of savings, zero at the IRR
        const double d = p.econ.discount_rate, cf0 = pvo.econ.capex_total - hyb.econ.capex_total;
        double at_d = cf0, at_irr = cf0;
        for (size_t i = 0; i < hyb.years.size(); ++i) {
            const double cf = pvo.years[i].c_total - hyb.years[i].c_total;
            at_d += cf / std::pow(1 + d, double(i + 1));
            if (cb.irr_valid) at_irr += cf / std::pow(1 + cb.irr, double(i + 1));
        }
        CHECK(std::fabs(at_d - cb.npv_savings) < 1e-6 * std::max(1.0, std::fabs(cb.npv_savings)), "incremental cash flow NPV %.2f vs %.2f", at_d, cb.npv_savings);
        CHECK(!cb.irr_valid || std::fabs(at_irr) < 1e-6 * std::fabs(cf0), "incremental NPV at the battery IRR %.4f", at_irr);
        // without a battery every strategy reduces to load following
        for (const char* strat : {"cycle_charging", "predictive"}) {
            Project q = p;
            q.dg.strategy = strat;
            const double f = simulate(q, prof.ac_per_kwp, cs, ps, false).fuel_l_y1;
            CHECK(f == pvo.fuel_l_y1, "%s without a battery: fuel %.6f L vs load following %.6f L", strat, f, pvo.fuel_l_y1);
        }
        std::printf("  battery vs PV only: NPV %.4g, IRR %s, fuel saved %.0f L/yr\n", cb.npv_savings,
                    cb.irr_valid ? std::to_string(cb.irr).c_str() : "none", cb.fuel_saved_l_y1);
    }
    // 15. Monthly PV balances add up to the annual loss chain; the battery's stored-energy balance closes every year
    {
        double ya = 0, poa = 0, ghi = 0, dc = 0;
        for (int m = 0; m < 12; ++m) {
            ya += prof.m_avail[m]; poa += prof.m_poa[m]; ghi += prof.m_ghi[m]; dc += prof.m_dc[m];
            CHECK(prof.m_dhi[m] >= 0 && prof.m_dhi[m] <= prof.m_ghi[m] + 1e-9 && prof.m_eff[m] <= prof.m_poa[m], "month %d irradiation out of order", m + 1);
            CHECK(std::fabs(prof.m_tamb[m] - 27.0) < 1e-9, "month %d mean ambient %.6f", m + 1, prof.m_tamb[m]);
        }
        CHECK(std::fabs(ya - prof.specific_yield) < 1e-9, "monthly energy available %.12f vs specific yield %.12f", ya, prof.specific_yield);
        CHECK(std::fabs(poa - prof.poa_annual) < 1e-9, "monthly plane-of-array %.12f vs annual %.12f", poa, prof.poa_annual);
        CHECK(std::fabs(ghi - prof.ghi_annual) < 1e-9, "monthly GHI %.12f vs annual %.12f", ghi, prof.ghi_annual);
        CHECK(std::fabs(dc - prof.losses[8].value) < 1e-9, "monthly array energy %.12f vs loss chain %.12f", dc, prof.losses[8].value);
        const double eta = std::sqrt(p.bess.rte);
        for (const char* strat : {"load_following", "cycle_charging", "predictive"}) {
            Project q = p;
            q.dg.strategy = strat;
            q.bess.self_discharge = 2e-4;
            SimResult r = simulate(q, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000}, true);
            double worst = 0;
            for (const auto& Y : r.years) {
                const double loss = Y.bess_ch - Y.bess_dis - Y.self_discharge - (Y.e_end - Y.e_start);
                const double expect = (1 - eta) * Y.bess_ch + (1 / eta - 1) * Y.bess_dis;
                worst = std::max(worst, std::fabs(loss - expect) / (Y.bess_ch + Y.bess_dis));
            }
            CHECK(worst < 1e-6, "%s battery losses off by %.3g of throughput", strat, worst);
            const YearResult& y1 = r.years[0];
            double g_ch = 0;
            for (int t = 0; t < HOURS; ++t) g_ch += r.hourly.gen_to_bess[t];
            CHECK(std::fabs(y1.gen_to_bess - g_ch) < 1e-6 * std::max(1.0, g_ch), "%s genset charging %.3f vs hourly %.3f", strat, y1.gen_to_bess, g_ch);
            CHECK(std::fabs(y1.gen_kwh - y1.gen_to_load - y1.gen_to_bess - y1.gen_dump) < 1e-6 * y1.gen_kwh, "%s genset energy split", strat);
            std::printf("  %-15s battery: charged %.0f, discharged %.0f, losses %.0f, self-discharge %.0f, stored %+.0f kWh\n", strat, y1.bess_ch,
                        y1.bess_dis, y1.bess_ch - y1.bess_dis - y1.self_discharge - (y1.e_end - y1.e_start), y1.self_discharge, y1.e_end - y1.e_start);
        }
        Project w = p;
        w.sim.all_years = false;
        for (int i = 0; i < HOURS; ++i) w.wx.wind[i] = 5.0 + 3.0 * std::sin(i / 7.0);
        w.wind.units = 2; w.wind.rated_kw = 500;
        const YearResult y = simulate(w, prof.ac_per_kwp, cs, Sizing{1500, 2000, 1000, 2}, false).years[0];
        CHECK(y.wind_to_load > 0 && std::fabs(y.wind_to_load + y.wind_to_bess - y.wind_used) < 1e-6 * y.wind_used, "wind used %.3f vs to load + to battery %.3f",
              y.wind_used, y.wind_to_load + y.wind_to_bess);
    }
    // 16. Inter-annual variability: PVGIS years split by calendar year, exceedance values, elasticity of fuel saved
    {
        // two years of synthetic PVGIS seriescalc rows; T2m holds the month, 99 on 29 Feb
        json::Value rows = json::Value::array();
        const int mdays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        for (int y : {2019, 2020})
            for (int mo = 1; mo <= 12; ++mo)
                for (int d = 1; d <= mdays[mo - 1] + (mo == 2 && y == 2020); ++d)
                    for (int h = 0; h < 24; ++h) {
                        char ts[32];
                        std::snprintf(ts, sizeof ts, "%04d%02d%02d:%02d30", y, mo, d, h);
                        rows.push(json::Value(json::Object{{"time", std::string(ts)}, {"Gb(i)", h >= 7 && h <= 16 ? 400.0 : 0.0},
                                                           {"Gd(i)", h >= 7 && h <= 16 ? 100.0 : 0.0}, {"H_sun", h >= 7 && h <= 16 ? 45.0 : 0.0},
                                                           {"T2m", mo == 2 && d == 29 ? 99.0 : double(mo)}, {"WS10m", 2.0}}));
                    }
        json::Value d(json::Object{{"outputs", json::Value(json::Object{{"hourly", rows}})}});
        const json::Value ys = pvgis_split_years(d, -2.5, 115.5);
        CHECK(ys.size() == 2, "PVGIS rows split into %zu years, expected 2", ys.size());
        if (ys.size() == 2) {
            for (size_t k = 0; k < 2; ++k) {
                const Weather w = parse_weather(ys[k]);
                CHECK(w.ghi.size() == HOURS && w.tamb.size() == HOURS && w.dni.size() == HOURS, "year %zu: %zu hours", k, w.ghi.size());
                CHECK(std::none_of(w.tamb.begin(), w.tamb.end(), [](double t) { return t == 99; }), "year %zu keeps 29 Feb", k);
                CHECK(w.tamb[58 * 24 + 23] == 2 && w.tamb[59 * 24] == 3, "year %zu: 28 Feb / 1 Mar at %.0f / %.0f", k, w.tamb[58 * 24 + 23], w.tamb[59 * 24]);
                CHECK(std::fabs(w.ghi[12] - 500) < 1e-9 && std::fabs(w.dni[12] - 400 / std::sin(45 * 3.14159265358979 / 180)) < 1e-9 && w.time_offset == 0.5, "year %zu irradiance split", k);
            }
            CHECK(ys[size_t(0)].gets("years", "") == "2019" && ys[size_t(1)].gets("years", "") == "2020", "years %s / %s", ys[size_t(0)].gets("years", "").c_str(), ys[size_t(1)].gets("years", "").c_str());
        }

        // exceedance: P90 of one year = M0 (1 - 1.2816 sigma_1); the 10-year average is less uncertain
        const std::vector<double> m = {950, 1000, 1050, 980, 1020};
        const Exceedance x = exceedance(1000, m, 0.8, 0.055, true);
        double var = 0;
        for (double v : m) var += (v / 1000 - 1) * (v / 1000 - 1);   // mean of m is 1000
        const double s1 = std::sqrt(var / 4 + 0.8 * 0.055 * 0.8 * 0.055);
        CHECK(std::fabs(x.sigma_1 - s1) < 1e-12 && std::fabs(x.p90_1 - 1000 * (1 - 1.2816 * x.sigma_1)) < 1e-9 * 1000, "P90 %.9f, sigma %.9f vs %.9f", x.p90_1, x.sigma_1, s1);
        CHECK(x.sigma_10 < x.sigma_1 && x.p90_10 > x.p90_1 && x.p99_1 < x.p90_1 && x.p75_1 > x.p90_1, "exceedance order");
        const Exceedance xf = exceedance(1000, m, -0.5, 0.055, false);
        CHECK(std::fabs(xf.p90_1 - 1000 * (1 + 1.2816 * xf.sigma_1)) < 1e-9 * 1000, "fuel used P90 %.6f", xf.p90_1);

        // PV of about 3 x the average load: fuel saved responds less than the irradiance (curtailment, minimum loading)
        Project q = p;
        q.pv.capacity_kwp = 3000;
        std::vector<WeatherYear> wy;
        for (double f : {0.94, 1.0, 1.03, 0.97}) {
            WeatherYear w{2001 + int(wy.size()), q.wx};
            for (double& g : w.wx.ghi) g *= f;
            wy.push_back(w);
        }
        Progress prog;
        const json::Value r = resource_years(q, json::parse(R"({"finance":{"model":"host"}})"), wy, UncertaintyBudget{}, prog);
        const json::Value& S = r["stats"];
        const double ef = S["fuel_saved"]["elasticity"].num(), ey = S["yield"]["elasticity"].num();
        CHECK(ef > 0 && ef <= 1.05, "fuel-saved elasticity %.4f", ef);
        CHECK(ey > 0.9 && ey < 1.05 && S["fuel_used"]["elasticity"].num() < 0, "yield elasticity %.4f, fuel used %.4f", ey, S["fuel_used"]["elasticity"].num());
        CHECK(r["years"].size() == 4 && prog.done == 7 && S["yield"]["worst_year"].num() == 2001, "%zu years, %ld runs, worst year %.0f", r["years"].size(), long(prog.done), S["yield"]["worst_year"].num());
        const json::Value& a = r["anchor"];
        CHECK(std::fabs(a["revenue"].num() - a["avoided_cost"].num()) < 1e-6 * a["revenue"].num() && S["revenue"]["p90_1"].num() < S["revenue"]["p50"].num(), "host revenue %.2f vs avoided cost %.2f", a["revenue"].num(), a["avoided_cost"].num());
        // PPA with take-or-pay: revenue P-values follow the energy's through the contract, so they never fall below the floor
        Progress pp;
        const json::Value rt = resource_years(q, json::parse(R"({"finance":{"model":"ppa","take_or_pay":0.97,"components":[{"v1":0.15}]}})"), wy, UncertaintyBudget{}, pp);
        const json::Value& R = rt["stats"]["revenue"];
        const double r50 = R["p50"].num();
        CHECK(R["p90_1"].num() >= 0.97 * r50 - 1e-6 * r50 && R["p99_1"].num() >= 0.97 * r50 - 1e-6 * r50 && R["p90_1"].num() <= r50,
              "take-or-pay 0.97: revenue P90 / P50 %.6f, P99 / P50 %.6f", R["p90_1"].num() / r50, R["p99_1"].num() / r50);
        std::printf("  variability: elasticity yield %.3f, fuel saved %.3f, revenue %.3f; yield P90 1-yr / P50 %.4f, revenue %.4f\n", ey, ef, S["revenue"]["elasticity"].num(),
                    S["yield"]["p90_1"].num() / S["yield"]["p50"].num(), S["revenue"]["p90_1"].num() / S["revenue"]["p50"].num());
    }
    // 17. Cycle charging: once genset charging has begun the battery holds its energy until the setpoint, so it is not topped
    // up in one hour and emptied in the next. The hour in which a charge starts or ends is shared, so cycles and fuel change
    // smoothly with the battery's state of health and the setpoint.
    {
        Project q = p;
        q.dg.strategy = "cycle_charging";
        q.bess.self_discharge = 0;
        const Sizing sz{1500, 2000, 1000};
        const SimResult r = simulate(q, prof.ac_per_kwp, cs, sz, true);
        const Hourly& h = r.hourly;
        const double sp = std::min(q.bess.soc_max, std::max(q.bess.soc_min, q.dg.cc_setpoint)), eta = std::sqrt(q.bess.rte);
        bool hold = false;
        int held = 0, freed = 0, bad = 0, crumbs = 0, unfreed = 0;
        for (int t = 0; t < HOURS; ++t) {
            const double cap = h.gen_units[t] * q.dg.unit_kw;
            const double gen = h.gen_to_load[t] + h.gen_to_bess[t] + h.gen_dump[t];
            const double soc0 = t ? h.soc[t - 1] : q.bess.soc_init;
            const double top = soc0 + (h.pv_to_bess[t] + h.wind_to_bess[t] + h.gen_to_bess[t]) * eta / sz.bess_kwh;   // after charging
            if (hold) {
                held++;
                if (h.bess_dis[t] > 1e-6 && top < sp - 1e-6 && gen < cap - 1e-6) bad++;   // below the setpoint only when the gensets are at full output
            } else {
                if (h.bess_dis[t] > 1e-6) freed++;
                // outside a hold a battery with energy left covers the deficit before the gensets go above minimum loading
                if (soc0 > q.bess.soc_min + 1e-5 && h.bess_dis[t] <= 0 && h.gen_to_load[t] > std::min(cap * q.dg.min_load, h.load[t]) + 1e-6) unfreed++;
            }
            if (h.bess_dis[t] > 0 && h.bess_dis[t] < 1e-3 && gen < cap - 1e-6) crumbs++;   // rounding remainders count as empty
            const double excess = std::max(0.0, cap * q.dg.min_load - h.load[t]);       // unavoidable genset excess at minimum loading
            hold = (hold || h.gen_to_bess[t] > excess + 1e-6) && (hold ? top : h.soc[t]) < sp - 1e-6;
        }
        CHECK(held > 100 && freed > 100 && bad == 0 && unfreed == 0, "cycle charging: %d hours holding, %d discharging, %d discharges while holding, %d idle outside a hold",
              held, freed, bad, unfreed);
        CHECK(crumbs == 0, "cycle charging: %d hours discharging a rounding remainder below 1 W", crumbs);
        // the setpoint is capped at the maximum SOC
        {
            Project a = q, b = q;
            a.sim.all_years = b.sim.all_years = false;
            a.bess.soc_max = b.bess.soc_max = 0.9;
            a.dg.cc_setpoint = 1.0; b.dg.cc_setpoint = 0.9;
            const YearResult ya = simulate(a, prof.ac_per_kwp, cs, sz, false).years[0], yb = simulate(b, prof.ac_per_kwp, cs, sz, false).years[0];
            CHECK(ya.fuel_l == yb.fuel_l && ya.bess_efc == yb.bess_efc && ya.bess_efc > 50, "setpoint 1.0 above SOC max 0.9: fuel %.3f vs %.3f L, %.1f vs %.1f cycles",
                  ya.fuel_l, yb.fuel_l, ya.bess_efc, yb.bess_efc);
        }
        // a fleet too small for the peak: the battery still covers what the gensets cannot while it holds
        {
            Project f = q;
            f.dg.units = 2;
            f.sim.all_years = false;
            const SimResult rf = simulate(f, prof.ac_per_kwp, cs, sz, true);
            int left = 0;
            for (int t = 0; t < HOURS; ++t)
                left += rf.hourly.unmet[t] > 1e-6 && rf.hourly.bess_dis[t] < sz.bess_kw - 1e-6 && rf.hourly.soc[t] > f.bess.soc_min + 1e-6;
            CHECK(rf.years[0].unmet > 0 && left == 0, "2 units: %d hours with unmet load while the battery had power and energy left", left);
        }
        // year-1 cycles and fuel against the state of health and the setpoint, also on a small battery that charges in a few hours.
        // Whole genset units per hour still leave steps of about 2 % in cycles; without the shared hour they reach 20-45 %.
        double worst_c = 0, worst_f = 0;
        auto sweep = [&](const Sizing& z, bool by_soh) {
            double pc = 0, pf = 0;
            for (int i = 0; i <= 40; ++i) {
                Project x = q;
                x.sim.all_years = false;
                if (by_soh) x.bess.soh_init = 0.95 - 0.0025 * i; else x.dg.cc_setpoint = 0.70 + 0.0025 * i;
                const YearResult y = simulate(x, prof.ac_per_kwp, cs, z, false).years[0];
                if (i) { worst_c = std::max(worst_c, std::fabs(y.bess_efc / pc - 1)); worst_f = std::max(worst_f, std::fabs(y.fuel_l / pf - 1)); }
                pc = y.bess_efc; pf = y.fuel_l;
            }
        };
        for (const Sizing& z : {sz, Sizing{1300, 300, 100}}) { sweep(z, true); sweep(z, false); }
        CHECK(worst_c < 0.04 && worst_f < 1.5e-3, "cycle charging jumps between neighbouring states of health or setpoints: cycles %.3f %%, fuel %.4f %%", worst_c * 100, worst_f * 100);
        std::printf("  cycle charging: %d h holding, %d h discharging; largest step over SOH 0.85-0.95 and setpoint 0.70-0.80: cycles %.3f %%, fuel %.4f %%\n",
                    held, freed, worst_c * 100, worst_f * 100);
    }
    // 18. JSON round trip
    {
        json::Value v = json::parse(R"({"a":[1,2.5,-3e2],"b":{"c":"x\"yé"},"d":true,"e":null})");
        CHECK(v["a"][2].num() == -300, "json number");
        CHECK(json::parse(v.dump()).dump() == v.dump(), "json round trip");
    }
    // 19. UTC offset: a half-hour offset weights the two UTC hours that make up each local hour, so PV, wind and the
    // auxiliary load at +7.5 h are the mean of +7 h and +8 h and the yield is unchanged. The day-ahead schedule keeps PV on
    // the forecast's UTC hours and averages the local-time load over each, whichever end of the hour the forecast stamps.
    // Whole-hour offsets are unchanged (section 12).
    {
        Project a = make_project(-7.5, 112.5);
        for (int i = 0; i < HOURS; ++i) {
            a.wx.wind[i] = 6 + 3 * std::sin(i * 0.37) + 2 * std::sin(i / 24 * 0.9);
            a.wx.tamb[i] = 28 + 5 * std::sin((i % 24) / 24.0 * 6.283 - 2);
        }
        a.wind.units = 2; a.wind.rated_kw = 1000;
        a.aux.bess_kw_per_mwh = 1.0; a.aux.bess_temp_coeff = 0.03; a.aux.ref_c = 25;
        a.sim.all_years = false;
        auto at = [&](double off) { Project q = a; q.loc.utc_offset = off; return q; };
        const Project p7 = at(7), p75 = at(7.5), p8 = at(8);
        const PVProfile f7 = compute_pv_profile(p7), f75 = compute_pv_profile(p75), f8 = compute_pv_profile(p8);
        CHECK(std::fabs(f75.specific_yield - f7.specific_yield) < 1e-9 && std::fabs(f8.specific_yield - f7.specific_yield) < 1e-9,
              "specific yield moves with the UTC offset: %.12f, %.12f, %.12f", f7.specific_yield, f75.specific_yield, f8.specific_yield);
        const std::vector<double> w7 = wind_per_turbine(p7), w75 = wind_per_turbine(p75), w8 = wind_per_turbine(p8);
        const Sizing sz{1500, 2000, 1000, 2};
        auto aux_of = [&](const Project& q) { return simulate(q, compute_pv_profile(q).ac_per_kwp, clearsky_pv_per_kwp(q), sz, true).hourly.aux; };
        const std::vector<double> x7 = aux_of(p7), x75 = aux_of(p75), x8 = aux_of(p8);
        double e_pv = 0, e_tc = 0, e_w = 0, e_x = 0, d78 = 0, s7 = 0, s75 = 0;
        for (int t = 0; t < HOURS; ++t) {
            e_pv = std::max(e_pv, std::fabs(f75.ac_per_kwp[t] - 0.5 * (f7.ac_per_kwp[t] + f8.ac_per_kwp[t])));
            e_tc = std::max(e_tc, std::fabs(f75.tcell[t] - 0.5 * (f7.tcell[t] + f8.tcell[t])));
            e_w = std::max(e_w, std::fabs(w75[t] - 0.5 * (w7[t] + w8[t])));
            e_x = std::max(e_x, std::fabs(x75[t] - 0.5 * (x7[t] + x8[t])));
            d78 = std::max(d78, std::fabs(f7.ac_per_kwp[t] - f8.ac_per_kwp[t]) + std::fabs(w7[t] - w8[t]) + std::fabs(x7[t] - x8[t]));
            s7 += x7[t]; s75 += x75[t];
        }
        CHECK(e_pv < 1e-12 && e_tc < 1e-12 && e_w < 1e-12 && e_x < 1e-12 && d78 > 0.1,
              "+7.5 h is not the mean of +7 h and +8 h: PV %.3g, cell temperature %.3g, wind %.3g, auxiliaries %.3g", e_pv, e_tc, e_w, e_x);
        CHECK(std::fabs(s75 / s7 - 1) < 1e-12, "yearly auxiliary energy moves with the UTC offset: %.6f vs %.6f kWh", s75, s7);
        const LocalShift sq = local_shift(at(-3.5)), sw = local_shift(at(8));
        Project lt = at(5.75);
        lt.wx.is_utc = false;
        const LocalShift sl = local_shift(lt);
        CHECK(sq.n == -4 && sq.f == 0.5 && sw.n == 8 && sw.f == 0 && sl.n == 0 && sl.f == 0, "local shift");
        auto valid = [](const Project& q) { try { validate_project(q); return true; } catch (const std::exception&) { return false; } };
        CHECK(valid(at(12.75)) && valid(at(-12)) && valid(at(14)) && !valid(at(14.5)) && !valid(at(-15)), "UTC offset range check");

        // day-ahead schedule: 36 forecast hours from 2023-03-01 00:00 UTC
        std::string js = R"({"time_offset":0.5,"times":[)", ghi, tamb, wind;
        for (int h = 0; h < 36; ++h) {
            const char* sep = h ? "," : "";
            char ts[32];
            std::snprintf(ts, sizeof ts, "%s\"2023-03-%02dT%02d:00\"", sep, 1 + h / 24, h % 24);
            js += ts;
            ghi += sep + std::to_string(std::max(0.0, 900 * std::sin((h % 24 - 23.0) / 12.0 * 3.14159)));   // daylight 00:00-11:00 UTC
            tamb += sep + std::to_string(27 + h % 5);
            wind += sep + std::to_string(5);
        }
        js += "],\"ghi\":[" + ghi + "],\"tamb\":[" + tamb + "],\"wind\":[" + wind + "]}";
        const json::Value fc = json::parse(js);
        auto rows = [&](double off) { Project q = at(off); q.aux = AuxParams{}; return day_ahead_schedule(q, Sizing{1500, 2000, 1000}, fc, 0.5, 1.0)["rows"]; };
        const json::Value r55 = rows(5.5), r5 = rows(5);
        double e_load = 0, e_pvs = 0, pv_sum = 0;
        const int hoy0 = 59 * 24;   // 1 March 00:00 UTC
        for (int i = 0; i < 36; ++i) {
            const int L = hoy0 + i + 5;   // UTC hour i spans the second half of local hour L and the first half of L + 1
            e_load = std::max(e_load, std::fabs(r55[i]["load_kw"].num() - 0.5 * (a.load_kw[L] + a.load_kw[L + 1])));
            e_pvs = std::max(e_pvs, std::fabs(r55[i]["pv_kw"].num() - r5[i]["pv_kw"].num()));
            pv_sum += r55[i]["pv_kw"].num();
        }
        CHECK(r55.size() == 36 && e_load < 1e-9 && e_pvs == 0 && pv_sum > 1000,
              "schedule at +5.5 h: load off the mean of the two local hours by %.3g kW, PV off the UTC hours by %.3g kW", e_load, e_pvs);
        // the same forecast stamped at the end of each hour, as Open-Meteo does (time_offset -0.5), gives the same load and PV
        json::Value fe = json::parse(js);
        fe["time_offset"] = -0.5;
        for (int h = 0; h < 36; ++h) fe["times"].arr_mut()[size_t(h)] = epoch_h_to_iso(iso_to_epoch_h("2023-03-01T00:00") + h + 1);
        double e_end = 0;
        for (double off : {5.0, 5.5}) {
            Project q = at(off);
            q.aux = AuxParams{};
            const json::Value re = day_ahead_schedule(q, Sizing{1500, 2000, 1000}, fe, 0.5, 1.0)["rows"];
            const json::Value& rs = off == 5 ? r5 : r55;
            for (int i = 0; i < 36; ++i)
                e_end = std::max({e_end, std::fabs(re[i]["load_kw"].num() - rs[i]["load_kw"].num()), std::fabs(re[i]["pv_kw"].num() - rs[i]["pv_kw"].num())});
        }
        CHECK(e_end == 0, "schedule on stamps at the end of the hour: load or PV off the rows stamped at the start by %.3g kW", e_end);
        std::printf("  UTC offset +7.5 h: yield %.3f kWh/kWp as at +7 h and +8 h; hourly PV, wind and auxiliaries their mean to %.1e\n",
                    f75.specific_yield, std::max({e_pv, e_w, e_x}));
    }
    // 20. Day-ahead schedule: it starts at the current hour, runs on consecutive hours across 29 February, ends at the first
    // hour without irradiance and adds wind turbines. Without a current time every hour is kept, as before.
    {
        const long e0 = iso_to_epoch_h("2028-02-28T00:00");
        CHECK(iso_to_epoch_h("1970-01-01T00:00Z") == 0 && iso_to_epoch_h("2028-02-29T00:00:00Z") - e0 == 24 &&
              iso_to_epoch_h("2028-03-01T00:00") - e0 == 48 && iso_to_epoch_h("2028-02-28T05:59") - e0 == 5 &&
              iso_to_epoch_h("2027-02-29T00:00") == NO_TIME_H && iso_to_epoch_h("2028-02-28T05:20+08:00") == NO_TIME_H &&
              iso_to_epoch_h("2028-02-28T24:00") == NO_TIME_H && iso_to_epoch_h("") == NO_TIME_H, "ISO time to epoch hours");
        CHECK(epoch_h_to_iso(e0 + 29) == "2028-02-29T05:00" && epoch_h_to_iso(e0 + 48) == "2028-03-01T00:00" &&
              epoch_h_to_iso(-1) == "1969-12-31T23:00", "epoch hours to ISO time");

        // 72 h from 2028-02-28 00:00 UTC, stamped at the end of each hour as Open-Meteo does; 29 February is cloudy
        Project p = make_project(0.5, 10);
        p.wind.rated_kw = 1000;
        auto forecast = [&](const char* start, int hours, double toff, int null_at) {
            json::Value f = json::Value::object(), t = json::Value::array(), g = json::Value::array(), ta = json::Value::array(), w = json::Value::array();
            for (int h = 0; h < hours; ++h) {
                const long e = iso_to_epoch_h(start) + h;
                const int hh = int(e % 24);
                const double day = epoch_h_to_iso(e).compare(0, 10, "2028-02-29") == 0 ? 0.3 : 1.0;
                t.push(epoch_h_to_iso(e));
                g.push(h == null_at ? json::Value() : json::Value(day * std::max(0.0, 950 * std::sin(3.14159 * (hh - 5.5) / 12))));
                ta.push(27 + hh % 5);
                w.push(8.0);
            }
            f["time_offset"] = toff; f["times"] = t; f["ghi"] = g; f["tamb"] = ta; f["wind"] = w;
            return f;
        };
        const json::Value fc = forecast("2028-02-28T00:00", 72, -0.5, -1);
        const Sizing sz{1500, 2000, 1000, 0}, szw{1500, 2000, 1000, 2};
        const json::Value a = day_ahead_schedule(p, sz, fc, 0.5, 1.0, "2028-02-28T05:20", 0);
        const json::Value& ra = a["rows"];
        bool consecutive = ra.size() == 66;
        double pv28 = 0, pv29 = 0, pv01 = 0;
        for (size_t k = 0; k < ra.size(); ++k) {
            const std::string t = ra[k]["time_utc"].str();
            consecutive = consecutive && t == epoch_h_to_iso(e0 + 6 + long(k));
            (t < "2028-02-29" ? pv28 : t < "2028-03-01" ? pv29 : pv01) += ra[k]["pv_kw"].num();
        }
        CHECK(ra.size() > 0 && ra[0]["time_utc"].str() == "2028-02-28T06:00" && a["plan_start_utc"].str() == "2028-02-28T05:00",
              "schedule from 05:20 starts at %s (plan start %s)", ra[0]["time_utc"].str().c_str(), a["plan_start_utc"].str().c_str());
        CHECK(consecutive && pv29 < 0.5 * pv28 && pv01 > 0.9 * pv28 && pv01 < 1.1 * pv28,
              "rows across 29 February: %zu rows, consecutive %d, PV 28 Feb %.0f, 29 Feb %.0f, 1 Mar %.0f kWh", ra.size(), consecutive, pv28, pv29, pv01);
        // MET Norway stamps the start of the hour: the row at 05:00 covers 05-06
        const json::Value m = day_ahead_schedule(p, sz, forecast("2028-02-28T00:00", 72, 0.5, -1), 0.5, 1.0, "2028-02-28T05:20", 24);
        CHECK(m["rows"].size() == 24 && m["rows"][0]["time_utc"].str() == "2028-02-28T05:00" && m["plan_start_utc"].str() == "2028-02-28T05:00",
              "MET Norway rows from 05:20: %zu from %s", m["rows"].size(), m["rows"][0]["time_utc"].str().c_str());
        // the download time stands in for the current time
        json::Value fi = forecast("2028-02-28T00:00", 72, -0.5, -1);
        fi["issued_utc"] = "2028-02-28T05:20:11Z";
        const json::Value ai = day_ahead_schedule(p, sz, fi, 0.5, 1.0);
        CHECK(ai["rows"].dump() == ra.dump() && ai["plan_start_utc"].str() == "2028-02-28T05:00" && ai["issued_utc"].str() == "2028-02-28T05:20:11Z",
              "the forecast's issued_utc does not set the plan start");

        // a null irradiance at 2028-03-01 10:00 ends the plan with the hour before
        const json::Value b = day_ahead_schedule(p, sz, forecast("2028-02-28T00:00", 72, -0.5, 58), 0.5, 1.0, "2028-02-28T05:20", 0);
        CHECK(b["rows"].size() == 52 && b["rows"][51]["time_utc"].str() == "2028-03-01T09:00" &&
              b["note"].str().find("No data from 2028-03-01T10:00") != std::string::npos,
              "null irradiance: %zu rows, last %s", b["rows"].size(), b["rows"][b["rows"].size() - 1]["time_utc"].str().c_str());

        // two turbines in 8 m/s wind: wind output in every hour, less diesel, and every row balances
        const json::Value c = day_ahead_schedule(p, szw, fc, 0.5, 1.0, "2028-02-28T05:20", 48);
        double wmin = 1e9, w0 = 0, bal = 0;
        for (const auto& r : c["rows"].arr()) {
            wmin = std::min(wmin, r["wind_kw"].num());
            bal = std::max(bal, std::fabs(r["load_kw"].num() - (r["pv_kw"].num() + r["wind_kw"].num() + r["bess_kw"].num() + r["gen_kw"].num() +
                                                                 r["unmet_kw"].num() - r["curtail_kw"].num())));
        }
        const json::Value c0 = day_ahead_schedule(p, sz, fc, 0.5, 1.0, "2028-02-28T05:20", 48);
        for (const auto& r : c0["rows"].arr()) w0 = std::max(w0, r["wind_kw"].num());
        const double g1 = c["totals"]["gen_kwh"].num(), g0 = c0["totals"]["gen_kwh"].num();
        CHECK(c["rows"].size() == 48 && wmin > 0 && w0 == 0 && g1 < g0 && c["totals"]["wind_used_kwh"].num() > 0 && bal < 1e-6,
              "wind in the schedule: least %.1f kW, diesel %.0f vs %.0f kWh without, row balance %.2g kW", wmin, g1, g0, bal);
        // the forecast wind is at 10 m whatever height the project's weather measures it at
        Project p80 = p;
        p80.wind.ref_height = 80;
        CHECK(day_ahead_schedule(p80, szw, fc, 0.5, 1.0, "2028-02-28T05:20", 48)["rows"].dump() == c["rows"].dump(),
              "the schedule shears the forecast wind from the project's measurement height");

        // no current time: every hour is kept (2027 has no 29 February); dropping rows does not change the others
        const json::Value fn = forecast("2027-02-27T00:00", 48, -0.5, -1);
        const json::Value d = day_ahead_schedule(p, sz, fn, 0.5, 1.0), d2 = day_ahead_schedule(p, sz, fn, 0.5, 1.0, "", 0);
        const json::Value d3 = day_ahead_schedule(p, sz, fn, 0.5, 1.0, "2027-02-26T23:59", 48);
        CHECK(d["rows"].size() == 48 && d["rows"][0]["time_utc"].str() == "2027-02-27T00:00" && d["plan_start_utc"].str() == "2027-02-26T23:00" &&
              d.dump() == d2.dump() && d.dump() == d3.dump(), "schedule without a current time: %zu rows from %s", d["rows"].size(),
              d["rows"][0]["time_utc"].str().c_str());
        auto fails = [&](const json::Value& f, const char* now) {
            try { day_ahead_schedule(p, sz, f, 0.5, 1.0, now, 0); return false; } catch (const std::exception&) { return true; }
        };
        json::Value gap = forecast("2027-02-27T00:00", 48, -0.5, -1);   // a copy of fn would share its arrays
        gap["times"].arr_mut()[10] = "2027-02-27T11:00";
        CHECK(fails(gap, "") && fails(fn, "2027-03-02T00:00") && fails(fn, "yesterday") && !fails(fn, "2027-02-28T22:10"),
              "schedule accepts a gap in the hours, a forecast that has ended or a bad current time");
        CHECK(fails(forecast("2027-02-27T00:00", 48, 1e30, -1), "") && fails(forecast("2027-02-27T00:00", 48, std::nan(""), -1), "") &&
                  fails(forecast("2027-02-27T00:00", 48, 1.5, -1), "2027-02-27T05:20"),
              "schedule accepts a forecast time offset outside -1 h to +1 h");
        std::printf("  day-ahead schedule: %zu h from 05:20 across 29 Feb (PV %.0f / %.0f / %.0f kWh), wind cuts diesel %.0f -> %.0f kWh\n",
                    ra.size(), pv28, pv29, pv01, g0, g1);
    }
    // 21. Timestamped import: time-weighted hourly means, units, labels, duplicates, date order, Excel serial days, gaps, the
    // year and daylight saving; then the data checks: timing against the sun, night irradiance, stuck values, level shifts, units.
    {
        // minutes since 1970 as "2025-01-13T00:15Z" (iso), "2025-01-13 00:15" (wall) or "13/01/2025 00:15" (dmy)
        auto stamp = [](long long t, char style) {
            int y;
            unsigned m, d;
            civil_from_days(long(t / 1440), y, m, d);
            const int hh = int(t % 1440 / 60), mm = int(t % 60);
            char b[40];
            if (style == 'i') std::snprintf(b, sizeof b, "%04d-%02u-%02uT%02d:%02dZ", y, m, d, hh, mm);
            else if (style == 'w') std::snprintf(b, sizeof b, "%04d-%02u-%02u %02d:%02d", y, m, d, hh, mm);
            else std::snprintf(b, sizeof b, "%02u/%02u/%04d %02d:%02d", d, m, y, hh, mm);
            return std::string(b);
        };
        auto error_of = [](const std::string& text, const char* opt) {
            try { import_series(text, json::parse(opt)); return std::string(); } catch (const std::exception& e) { return std::string(e.what()); }
        };
        auto kw_at = [](const json::Value& r, int h) { return r["kw"][size_t(h)].num(); };
        const long long t25 = days_from_civil(2025, 1, 1) * 1440LL;

        // 15-min UTC load with the 4 rows of hour 1000 removed: exact hourly means, one hour missing and filled
        auto v15 = [](int k) { return 500.0 + (k * 37 % 101) + 0.25 * (k % 4); };
        const int gap = 1000;
        std::string q = "time,load_kw,flag\n";
        for (int k = 0; k < 35040; ++k)
            if (k / 4 != gap) q += stamp(t25 + 15LL * k, 'i') + "," + std::to_string(v15(k)) + ",1\n";
        const json::Value a = import_series(q, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kw","utc_offset":0})"));
        const json::Value& ra = a["report"];
        double e15 = 0;
        for (int h = 0; h < HOURS; ++h)
            if (h != gap) e15 = std::max(e15, std::fabs(kw_at(a, h) - (v15(4 * h) + v15(4 * h + 1) + v15(4 * h + 2) + v15(4 * h + 3)) / 4));
        CHECK(a["kw"].size() == HOURS && e15 == 0 && ra["interval_min"].num() == 15 && ra["missing_h"].num() == 1 && ra["filled_h"].num() == 1 &&
                  ra["max_gap_h"].num() == 1 && std::fabs(kw_at(a, gap) - (kw_at(a, gap - 1) + kw_at(a, gap + 1)) / 2) < 1e-9,
              "15-min import: error %.3g kW, interval %g min, missing %g h, filled %g h", e15, ra["interval_min"].num(), ra["missing_h"].num(), ra["filled_h"].num());
        // kWh per 15-min interval: four times the kW values; at UTC+8 every hour moves 8 hours on in local standard time
        const json::Value b = import_series(q, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kwh_interval","utc_offset":0})"));
        const json::Value c = import_series(q, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kw","utc_offset":8})"));
        double e4 = 0, e8 = 0;
        for (int h = 0; h < HOURS; ++h) {
            e4 = std::max(e4, std::fabs(kw_at(b, h) - 4 * kw_at(a, h)));
            if (h >= 8 && h - 8 != gap) e8 = std::max(e8, std::fabs(kw_at(c, h) - kw_at(a, h - 8)));
        }
        CHECK(e4 < 1e-9 && e8 == 0 && c["report"]["missing_h"].num() == 9 && c["report"]["year"].num() == 2025,
              "units and UTC offset: kWh per interval off x4 by %.3g, UTC+8 off by %.3g, %g h missing", e4, e8, c["report"]["missing_h"].num());

        // hourly, stamped at the end of each hour (detected), ';' with decimal commas: the sample stamped 01:00 is hour 0
        std::string e = "Timestamp;Load (kW)\n";
        for (int k = 0; k < HOURS; ++k) e += stamp(t25 + 60LL * (k + 1), 'w') + ";" + std::to_string(1000 + k) + ",5\n";
        const json::Value en = import_series(e, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"auto","units":"kw","utc_offset":8})"));
        CHECK(kw_at(en, 0) == 1000.5 && kw_at(en, HOURS - 1) == 1000.5 + HOURS - 1 && en["report"]["label"].str() == "end" && en["report"]["missing_h"].num() == 0,
              "interval-end stamps: hour 0 %.1f kW, label %s", kw_at(en, 0), en["report"]["label"].str().c_str());

        // a duplicate stamp (appended at the end, so also out of order) is counted and averaged
        std::string d = "time,kw\n", dm = "date,kw\n";
        for (int k = 0; k < HOURS; ++k) {
            d += stamp(t25 + 60LL * k, 'w') + "," + std::to_string(2000 + k) + "\n";
            dm += stamp(t25 + 60LL * k, 'd') + "," + std::to_string(2000 + k) + "\n";
        }
        d += stamp(t25 + 60LL * 500, 'w') + ",2510\n";
        const char* hourly = R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","units":"kw","utc_offset":8})";
        const json::Value du = import_series(d, json::parse(hourly));
        CHECK(kw_at(du, 500) == 2505 && kw_at(du, 501) == 2501 && du["report"]["duplicates"].num() == 1 && du["report"]["out_of_order"].num() == 1,
              "duplicate stamp: %.1f kW, %g duplicates, %g out of order", kw_at(du, 500), du["report"]["duplicates"].num(), du["report"]["out_of_order"].num());
        std::string ng = d;
        ng.replace(ng.find(",2000\n"), 6, ",-5\n");   // export in the first hour
        CHECK(error_of(ng, hourly).find("negative in 1 h") != std::string::npos, "a negative load is not refused: %s", error_of(ng, hourly).c_str());
        // "13/01/2025 00:00" reads as day/month/year; with no day above 12 the order is ambiguous
        const json::Value dd = import_series(dm, json::parse(hourly));
        double edm = 0;
        for (int h = 0; h < HOURS; ++h) edm = std::max(edm, std::fabs(kw_at(dd, h) - (2000 + h)));
        CHECK(dd["report"]["date_order"].str() == "dmy" && edm == 0, "day/month/year: order %s, error %.3g", dd["report"]["date_order"].str().c_str(), edm);
        CHECK(error_of(dm.substr(0, dm.find("13/01/2025")), hourly).find("ambiguous") != std::string::npos, "dates with no day above 12 are not ambiguous");
        // Excel serial day 45658 is 2025-01-01
        std::string xs = "serial,kw\n";
        for (int k = 0; k < HOURS; ++k) { char b2[64]; std::snprintf(b2, sizeof b2, "%.8f,%d\n", 45658 + k / 24.0, 2000 + k); xs += b2; }
        const json::Value xl = import_series(xs, json::parse(hourly));
        CHECK(xl["report"]["first"].str() == "2025-01-01 00:00" && xl["report"]["excel"].boolean() && kw_at(xl, 0) == 2000 && kw_at(xl, HOURS - 1) == 2000 + HOURS - 1,
              "Excel serial days: first %s", xl["report"]["first"].str().c_str());

        // two years: 2024 without 29 February, the year with most data (2024 has 8784 h), and the last 12 months
        std::string two = "time,kw\n";
        const long long t24 = days_from_civil(2024, 1, 1) * 1440LL;
        for (int k = 0; k < (366 + 365) * 24; ++k) two += stamp(t24 + 60LL * k, 'w') + "," + std::to_string(k / 24) + "\n";
        const json::Value y4 = import_series(two, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":2024,"utc_offset":0})"));
        const json::Value ya = import_series(two, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","utc_offset":0})"));
        const json::Value yl = import_series(two, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":"last12","utc_offset":0})"));
        CHECK(y4["kw"].size() == HOURS && kw_at(y4, 58 * 24) == 58 && kw_at(y4, 59 * 24) == 60 && kw_at(y4, HOURS - 1) == 365 && ya["report"]["year"].num() == 2024 &&
                  kw_at(yl, 0) == 366 && kw_at(yl, HOURS - 1) == 730 && y4["report"]["missing_h"].num() == 0,
              "year 2024: 28 Feb %g, 1 Mar %g, 31 Dec %g; auto year %g; last 12 months from %g", kw_at(y4, 58 * 24), kw_at(y4, 59 * 24), kw_at(y4, HOURS - 1),
              ya["report"]["year"].num(), kw_at(yl, 0));
        // the last 12 months skip 29 February: with one in the window the period starts 366 days before its end
        auto last12 = [&](int y, int m, int d, int y1, int m1, int d1) {
            const long long a = days_from_civil(y, unsigned(m), unsigned(d)), b = days_from_civil(y1, unsigned(m1), unsigned(d1));
            std::string f = "time,kw\n";
            for (long long k = 0; k < (b - a + 1) * 24; ++k) f += stamp(a * 1440 + 60 * k, 'w') + "," + std::to_string(k / 24) + "\n";
            return import_series(f, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":"last12","utc_offset":0})"))["report"]["period"].str();
        };
        const std::string pj = last12(2023, 7, 1, 2024, 6, 30), pm = last12(2023, 3, 1, 2024, 2, 29), pn = last12(2022, 7, 1, 2023, 6, 30);
        CHECK(pj == "2023-07-01 to 2024-06-30" && pm == "2023-03-01 to 2024-02-28" && pn == "2022-07-01 to 2023-06-30",
              "last 12 months: %s; %s; %s", pj.c_str(), pm.c_str(), pn.c_str());

        // weather: a gap of 5 h is filled, one above 72 h is an error
        auto wx_file = [&](int from, int to) {
            std::string w = "time,ghi,temp\n";
            for (int k = 0; k < HOURS; ++k)
                if (k < from || k >= to) w += stamp(t25 + 60LL * k, 'i') + "," + std::to_string(std::max(0.0, 900 * std::sin((k % 24 - 6) / 12.0 * 3.14159))) + ",27\n";
            return w;
        };
        const char* wopt = R"({"kind":"weather","time_col":0,"ghi":1,"tamb":2,"time_basis":"utc","label":"start","utc_offset":8})";
        const json::Value w5 = import_series(wx_file(4000, 4005), json::parse(wopt));
        CHECK(w5["ghi"].size() == HOURS && w5["report"]["missing"]["ghi"].num() == 5 && w5["report"]["filled_h"].num() == 5 && w5["is_utc"].boolean() &&
                  w5["time_offset"].num() == 0.5 && w5["wind"].size() == 0, "weather with a 5 h gap: %g missing", w5["report"]["missing"]["ghi"].num());
        CHECK(error_of(wx_file(2000, 2080), wopt).find("72 h") != std::string::npos, "a weather gap of 80 h is not refused");
        // the delimiter splits most of the first lines evenly: tab-separated metadata (as PVGIS writes) or a title with ';' above
        // comma-separated rows does not decide it
        const json::Value wm = import_series("Latitude (decimal degrees):\t45.000\nElevation (m):\t250\n\n\nSlope: 0 deg. \n" + wx_file(0, 0), json::parse(wopt));
        std::string lt = "Logger export; site A\n";
        for (int k = 0; k < HOURS; ++k) lt += stamp(t25 + 60LL * k, 'w') + "," + std::to_string(2000 + k) + "\n";
        const json::Value lg = import_series(lt, json::parse(hourly));
        CHECK(wm["report"]["delimiter"].str() == "," && wm["report"]["header_lines"].num() == 4 && wm["ghi"].size() == HOURS &&
                  lg["report"]["delimiter"].str() == "," && kw_at(lg, 0) == 2000,
              "metadata lines above the rows: delimiter '%s' with %g header lines; title line: delimiter '%s'", wm["report"]["delimiter"].str().c_str(),
              wm["report"]["header_lines"].num(), lg["report"]["delimiter"].str().c_str());

        // one row per quarter hour without a time column: means of four; a row without a number is an error naming its line
        std::string pos = "load\n";
        for (int k = 0; k < 35040; ++k) pos += std::to_string(v15(k)) + "\n";
        const char* popt = R"({"kind":"load","time_col":-1,"cols":[0],"time_basis":"local_standard","units":"kw","utc_offset":8})";
        const json::Value ps = import_series(pos, json::parse(popt));
        double eps = 0;
        for (int h = 0; h < HOURS; ++h) eps = std::max(eps, std::fabs(kw_at(ps, h) - (v15(4 * h) + v15(4 * h + 1) + v15(4 * h + 2) + v15(4 * h + 3)) / 4));
        std::string pbad = pos;
        pbad.replace(pbad.find('\n', pbad.find('\n', pbad.find('\n') + 1) + 1) + 1, 3, "n/a");   // the third value, line 4
        CHECK(eps == 0 && error_of(pbad, popt).find("Line 4") != std::string::npos, "positional quarter hours: error %.3g; bad row: %s", eps, error_of(pbad, popt).c_str());

        // clock time with daylight saving (CET/CEST): 02:00 is skipped on 30 March and repeated on 26 October. Read with the
        // zone's clock changes every UTC hour lands once; read as standard time the file looks like daylight saving.
        std::string cl = "time,kw\n";
        const long long dst_on = days_from_civil(2025, 3, 30) * 1440LL + 60, dst_off = days_from_civil(2025, 10, 26) * 1440LL + 60;
        for (int k = 0; k < HOURS; ++k) {
            const long long u = t25 - 60 + 60LL * k;   // UTC; local standard time (UTC+1) starts at 2025-01-01 00:00
            cl += stamp(u + (u >= dst_on && u < dst_off ? 120 : 60), 'w') + "," + std::to_string(k) + "\n";
        }
        const std::string copt = R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_clock","label":"start","utc_offset":1,"clock":{"start":1,"changes":[[)" +
                                 std::to_string(dst_on) + ",2],[" + std::to_string(dst_off) + ",1]]}}";
        const json::Value ck = import_series(cl, json::parse(copt));
        double eck = 0;
        for (int h = 0; h < HOURS; ++h) eck = std::max(eck, std::fabs(kw_at(ck, h) - h));
        const json::Value cs = import_series(cl, json::parse(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","utc_offset":1})"));
        CHECK(eck == 0 && ck["report"]["missing_h"].num() == 0 && ck["report"]["duplicates"].num() == 0 && !ck["report"]["dst_suspect"].boolean() &&
                  cs["report"]["dst_suspect"].boolean() && cs["report"]["duplicates"].num() == 1,
              "clock time: error %.3g, %g missing, %g duplicates; as standard time: suspect %d", eck, ck["report"]["missing_h"].num(),
              ck["report"]["duplicates"].num(), cs["report"]["dst_suspect"].boolean());

        // timing: clear sky on the file's own time base is on time; one hour late reads +60 min; UTC data flagged as local
        // time is off by the UTC offset
        Project t = make_project(-2.5, 115.5);
        t.wx.ghi = clearsky_ghi(t);
        auto timing = [](const Project& p) { return data_qc(p, "weather")["weather"]["timing"]; };
        Project late = t, local = t;
        for (int i = 0; i < HOURS; ++i) late.wx.ghi[i] = t.wx.ghi[(i + HOURS - 1) % HOURS];
        local.wx.is_utc = false;
        const json::Value t0 = timing(t), t1 = timing(late), tl = timing(local);
        CHECK(std::fabs(t0["median_min"].num()) < 5 && t0["verdict"].str() == "ok" && t0["n_days"].num() >= 30, "on time: %.1f min, %s, %g days",
              t0["median_min"].num(), t0["verdict"].str().c_str(), t0["n_days"].num());
        CHECK(std::fabs(t1["median_min"].num() - 60) <= 5 && t1["verdict"].str() == "hours" && t1["shift_h"].num() == 1, "one hour late: %.1f min, %s",
              t1["median_min"].num(), t1["verdict"].str().c_str());
        CHECK(std::fabs(tl["median_min"].num() + 60 * t.loc.utc_offset) <= 10 && tl["verdict"].str() == "utc", "UTC read as local time: %.1f min, %s",
              tl["median_min"].num(), tl["verdict"].str().c_str());

        // GHI 50 W/m2 at local midnight is one night flag; six daylight hours of 500 W/m2 are a flatline
        auto flag_hours = [](const json::Value& qc, const char* id) {
            for (const auto& f : qc["flags"].arr()) if (f["id"].str() == id) return f["hours"].num();
            return -1.0;
        };
        Project n = t;
        const int mid = 100 * 24 - int(t.loc.utc_offset);   // UTC hour of local midnight starting day 100
        n.wx.ghi[size_t(mid)] = 50;
        for (int h = 9; h < 15; ++h) n.wx.ghi[size_t(150 * 24 + h - int(t.loc.utc_offset))] = 500;
        const json::Value qn = data_qc(n, "weather")["weather"], q0 = data_qc(t, "weather")["weather"];
        CHECK(flag_hours(qn, "night") == 1 && flag_hours(qn, "flat_ghi") == 6 && flag_hours(q0, "night") == 0 && flag_hours(q0, "flat_ghi") == 0 &&
                  q0["n_flagged"].num() == 0 && qn["days"].size() == 2,
              "night %g h, flatline %g h, clear sky flagged %g h", flag_hours(qn, "night"), flag_hours(qn, "flat_ghi"), q0["n_flagged"].num());

        // a 20 % load step at day 200 is a level shift; a load in W read as kW is above the genset fleet
        Project l = make_project(-2.5, 115.5);
        for (int i = 0; i < HOURS; ++i) l.load_kw[i] *= (1 + 0.02 * std::sin(i * 0.7) * std::sin(i * 0.13)) * (i >= 200 * 24 ? 1.2 : 1.0);
        const json::Value ql = data_qc(l, "load")["load"];
        int step_day = -1;
        for (const auto& s : ql["set"].arr()) if (s["id"].str() == "level_shift" && s["shifts"].size() == 1) step_day = int(s["shifts"][0]["day"].num());
        Project w = l;
        for (auto& x : w.load_kw) x *= 1000;
        bool w_hint = false;
        const json::Value qw = data_qc(w, "load");
        for (const auto& s : qw["load"]["set"].arr())
            if (s["id"].str() == "units" && s["above"].boolean()) for (const auto& h : s["hints"].arr()) w_hint = w_hint || h.str() == "w";
        CHECK(std::abs(step_day - 200) <= 3 && flag_hours(ql, "spike") == 0 && w_hint, "load step found at day %d, %g spike hours; W hint %d", step_day,
              flag_hours(ql, "spike"), w_hint);
        std::printf("  import: 15-min, interval-end, duplicate, dmy, Excel, two-year, clock-time files exact; timing on time %.1f min, late %.1f min, "
                    "UTC as local %.0f min; load step at day %d\n", t0["median_min"].num(), t1["median_min"].num(), tl["median_min"].num(), step_day);
    }
    // 22. Irradiance models: Perez transposition, diffuse row shading and the rear side of bifacial modules on 2-D view factors,
    // monthly soiling. Saved projects without the new inputs keep Hay-Davies, beam-only row shading and monofacial modules.
    {
        const double d2r = 3.14159265358979323846 / 180;
        const Project d = parse_project(json::parse("{}"));
        CHECK(d.pv.transposition == "hay_davies" && !d.pv.diffuse_shading && d.pv.bifaciality == 0 && d.pv.soiling_monthly.empty() &&
                  std::fabs(d.pv.row_width - 2 * 2.278) < 1e-12, "irradiance model defaults");
        const Project l = parse_project(json::parse(R"({"pv":{"module_width":1.3},"layout":{"orientation":"landscape","modules_across":4}})"));
        CHECK(std::fabs(l.pv.row_width - 4 * 1.3) < 1e-12, "table width from the layout %.3f", l.pv.row_width);

        // closed-form view factors of a row against point view factors integrated along the slant
        for (double tilt : {0.0, 12.0, 30.0, 55.0})
            for (double gcr : {0.3, 0.5, 0.8}) {
                const double P = 1 / gcr, c = std::cos(tilt * d2r), s = std::sin(tilt * d2r), b = tilt * d2r;
                double fs = 0, fg = 0, bs = 0, bg = 0;
                const int N = 4000;
                for (int i = 0; i < N; ++i) {
                    const double x = (i + 0.5) / N, px = -x * c, pz = x * s;
                    fs += (1 + std::cos(std::atan2(s - pz, P - c - px) + b)) / 2 / N;
                    fg += (1 - std::cos(b - std::atan2(pz, P - px))) / 2 / N;
                    bs += (1 - std::cos(b - std::atan2(s - pz, px + P + c))) / 2 / N;
                    bg += (1 + std::cos(b + std::atan2(pz, px + P))) / 2 / N;
                }
                const RowView v = row_view(tilt, gcr);
                CHECK(std::fabs(v.front_sky - fs) < 1e-6 && std::fabs(v.front_ground - fg) < 1e-6 && std::fabs(v.back_sky - bs) < 1e-6 &&
                          std::fabs(v.back_ground - bg) < 1e-6, "row view factors at tilt %.0f, GCR %.1f", tilt, gcr);
                const GroundView g = ground_view(tilt, gcr, 0.5);
                double gs = 0, gf = 0, gb = 0;
                for (int k = 0; k < GroundView::STRIPS; ++k) { gs += g.sky[k] / GroundView::STRIPS; gf += g.front[k]; gb += g.back[k]; }
                CHECK(std::fabs(gf - v.front_ground) < 1e-9 && std::fabs(gb - v.back_ground) < 1e-9 && gs > 0 && gs < 1, "ground strips at tilt %.0f", tilt);
                if (tilt == 0) CHECK(std::fabs(gs - (1 - gcr)) < 2e-3, "flat rows: ground sky view %.4f vs 1 - GCR", gs);
            }
        const RowView open = row_view(20, 1e-4);
        CHECK(std::fabs(open.front_sky - (1 + std::cos(20 * d2r)) / 2) < 1e-4 && std::fabs(open.back_ground - (1 + std::cos(20 * d2r)) / 2) < 1e-4 &&
                  std::fabs(open.front_ground - (1 - std::cos(20 * d2r)) / 2) < 1e-4, "single row view factors");
        // low tables see mostly the ground below them; high ones see the strips between the rows as much
        const GroundView lo = ground_view(10, 0.45, 0.15), hi = ground_view(10, 0.45, 1.2);
        CHECK(lo.back[0] > 5 * lo.back[15] && hi.back[0] < 2 * hi.back[15], "rear view of the ground below the row: low %.4f/%.4f, high %.4f/%.4f",
              lo.back[0], lo.back[15], hi.back[0], hi.back[15]);

        // Perez sky diffuse in one hour against the formulas of Perez et al. 1990 (sky clearness bin 5: 2.8 <= eps < 4.5)
        Project h = make_project(-10, 30);
        h.loc.utc_offset = 2;
        for (auto* v : {&h.wx.ghi, &h.wx.dni, &h.wx.dhi}) v->assign(HOURS, 0.0);
        const int hr = 100 * 24 + 7;   // UTC, mid-hour 07:30 = 09:30 local
        const SunPos sp = sun_position(-10, 30, 101, 7.5);
        const double cz = sp.cos_zenith, dhi = 150, dni = 700, ghi = dhi + dni * cz;
        h.wx.ghi[hr] = ghi; h.wx.dhi[hr] = dhi; h.wx.dni[hr] = dni;
        h.pv.tilt = 20; h.pv.azimuth = 0; h.pv.row_shading = false; h.pv.transposition = "perez";
        const double z = sp.zenith_deg * d2r, am = 1 / (cz + 0.50572 * std::pow(96.07995 - sp.zenith_deg, -1.6364));
        const double delta = dhi * am / sp.extra_normal, eps = ((dhi + dni) / dhi + 1.041 * z * z * z) / (1 + 1.041 * z * z * z);
        const double F1 = std::max(0.0, 1.132 - 1.237 * delta - 0.412 * z), F2 = 0.288 - 0.823 * delta + 0.056 * z;
        const double sz = std::sin(z), t = 20 * d2r;
        const double ca = std::sin(t) * std::cos(0.0) * sz * std::cos(sp.azimuth_deg * d2r) + std::cos(t) * cz;
        const double poa = dni * ca + dhi * ((1 - F1) * (1 + std::cos(t)) / 2 + F1 * ca / cz + F2 * std::sin(t)) + ghi * 0.2 * (1 - std::cos(t)) / 2;
        const double poa_e = compute_pv_profile(h).poa_annual * 1000;
        CHECK(eps >= 2.8 && eps < 4.5 && std::fabs(poa_e - poa) < 1e-6 * poa, "Perez hour: eps %.3f, POA %.6f vs %.6f W/m2", eps, poa_e, poa);
        h.pv.transposition = "hay_davies";
        const double ai = dni / sp.extra_normal;
        const double poa_hd = dni * ca + dhi * ((1 - ai) * (1 + std::cos(t)) / 2 + ai * ca / cz) + ghi * 0.2 * (1 - std::cos(t)) / 2;
        CHECK(std::fabs(compute_pv_profile(h).poa_annual * 1000 - poa_hd) < 1e-6 * poa_hd, "Hay-Davies hour");

        // On the test year: Perez, diffuse row shading at 25 deg tilt, bifacial gain by mounting height, monthly soiling
        Project q = p;
        q.pv.tilt = 25;
        q.pv.gcr = 0.5;
        const PVProfile hd = compute_pv_profile(q);
        q.pv.transposition = "perez";
        const PVProfile pz = compute_pv_profile(q);
        q.pv.diffuse_shading = true;
        const PVProfile ds = compute_pv_profile(q);
        CHECK(pz.poa_annual > hd.poa_annual && ds.poa_annual == pz.poa_annual && ds.losses[2].value < pz.losses[2].value - 0.005 * pz.poa_annual &&
                  ds.specific_yield < pz.specific_yield, "Perez POA %.1f vs %.1f; diffuse row shading %.1f vs %.1f kWh/m2", pz.poa_annual,
              hd.poa_annual, ds.losses[2].value, pz.losses[2].value);
        Project wide = q;
        wide.pv.gcr = 0.02;
        const PVProfile w0 = compute_pv_profile(wide);
        wide.pv.diffuse_shading = false;
        CHECK(std::fabs(w0.specific_yield / compute_pv_profile(wide).specific_yield - 1) < 2e-3, "diffuse row shading at GCR 0.02 %.5f",
              w0.specific_yield / compute_pv_profile(wide).specific_yield);
        double gain[3];
        int n = 0;
        for (double mh : {0.8, 1.5, 3.0}) {
            q.pv.mount_height = mh;
            q.pv.bifaciality = 0;
            const PVProfile mono = compute_pv_profile(q);
            q.pv.bifaciality = 0.7;
            const PVProfile bf = compute_pv_profile(q);
            gain[n++] = bf.specific_yield / mono.specific_yield - 1;
            CHECK(bf.losses.size() == mono.losses.size() + 1 && bf.losses[5].irradiance && bf.losses[5].value > bf.losses[4].value &&
                      bf.rear_annual > 0 && mono.rear_annual == 0 && bf.losses[4].value == mono.losses[4].value, "bifacial loss chain at %.1f m", mh);
        }
        CHECK(gain[0] > 0.01 && gain[0] < gain[1] && gain[1] < gain[2] && gain[2] < 0.12, "bifacial gain %.4f / %.4f / %.4f", gain[0], gain[1], gain[2]);
        Project tr = q;
        tr.pv.mount = "tracker"; tr.pv.gcr = 0.35; tr.pv.row_width = 2.4; tr.pv.mount_height = 2;
        const PVProfile tb = compute_pv_profile(tr);
        tr.pv.bifaciality = 0;
        const double tgain = tb.specific_yield / compute_pv_profile(tr).specific_yield - 1;
        CHECK(tgain > 0.02 && tgain < 0.15 && std::isfinite(tb.specific_yield), "tracker bifacial gain %.4f", tgain);

        Project m = p;
        m.pv.soiling_monthly.assign(12, m.pv.soiling);
        CHECK(compute_pv_profile(m).specific_yield == prof.specific_yield, "monthly soiling equal to the annual value changed the yield");
        m.pv.soiling_monthly.assign(12, 0.0);
        const PVProfile m0 = compute_pv_profile(m);
        m.pv.soiling_monthly[0] = 0.1;
        const PVProfile m1 = compute_pv_profile(m);
        CHECK(std::fabs(m1.m_eff[0] / m0.m_eff[0] - 0.9) < 1e-12 && m1.m_eff[5] == m0.m_eff[5], "January soiling %.6f", 1 - m1.m_eff[0] / m0.m_eff[0]);
        auto invalid = [&](auto set) {
            Project x = p;
            set(x);
            try { validate_project(x); } catch (const std::exception&) { return true; }
            return false;
        };
        CHECK(invalid([](Project& x) { x.pv.soiling_monthly = {0.01, 0.02}; }) && invalid([](Project& x) { x.pv.transposition = "perezz"; }) &&
                  invalid([](Project& x) { x.pv.bifaciality = 0.7; x.pv.gcr = 1.2; }) && !invalid([](Project& x) { x.pv.gcr = 1.2; }),
              "irradiance inputs: invalid accepted or valid refused");
        std::printf("  irradiance models at 25 deg, GCR 0.5: Perez POA %+.2f %%, diffuse row shading %+.2f %% yield; bifacial 70 %% at 0.8/1.5/3 m "
                    "%+.1f/%+.1f/%+.1f %%, tracker %+.1f %%\n", 100 * (pz.poa_annual / hd.poa_annual - 1), 100 * (ds.specific_yield / pz.specific_yield - 1),
                    100 * gain[0], 100 * gain[1], 100 * gain[2], 100 * tgain);
    }
    // 23. Updates: release versions in order, and the SHA-256 that checks a download (FIPS 180-4 test vectors).
    {
        CHECK(compare_versions("v1.10.0", "1.9.2") > 0 && compare_versions("1.2", "1.2.0") == 0 && compare_versions("1.2.0-beta", "1.2.0") == 0 &&
                  compare_versions("1.1.9", "1.2") < 0 && compare_versions("V2.0.0", "1.99.99") > 0,
              "version comparison");
        Sha256 e, a, m;
        const std::string abc = "abc", two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        a.update(reinterpret_cast<const unsigned char*>(abc.data()), abc.size());
        for (char c : two) m.update(reinterpret_cast<const unsigned char*>(&c), 1);   // fed byte by byte across block edges
        CHECK(e.hex() == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
                  a.hex() == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" &&
                  m.hex() == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
              "SHA-256 test vectors");
    }
    // 24. Further PV models: decomposition, Ineichen clear sky with turbidity from the data, spectral correction, IAM models,
    // terrain horizon, bypass-diode blocks, slope-aware tracking, inverter part-load curve, snow, monthly albedo, linear
    // degradation, closure checks of the weather. Saved projects keep the models they were made with.
    {
        const double d2r = 3.14159265358979323846 / 180;
        const Project d = parse_project(json::parse("{}"));
        CHECK(d.pv.decomposition == "erbs" && d.pv.clearsky == "haurwitz" && d.pv.iam_model == "ashrae" && d.pv.shade_model == "linear" &&
                  d.pv.inverter_model == "constant" && d.pv.degradation_model == "compound" && d.pv.spectral == "none" && d.pv.horizon.empty() &&
                  d.pv.tracker_axis_tilt == 0 && d.pv.tracker_cross_slope == 0 && d.wx.snow.empty() && !d.wx.horizon_in_beam,
              "further model defaults");
        CHECK(parse_project(json::parse(R"j({"weather":{"source":"PVGIS TMY (PVGIS-SARAH3)","elevation":250}})j")).wx.horizon_in_beam &&
                  parse_project(json::parse(R"({"weather":{"elevation":250}})")).loc.elevation == 250, "PVGIS weather and elevation");

        // IAM: 1 at normal incidence, 0 at grazing; a coating lifts it at oblique angles; the integrated sky IAM of Martin-Ruiz
        // within 1 % of its published closed form, c1 = 4/(3 pi), c2 = 0.5 a_r - 0.154 (Martin and Ruiz 2001)
        PVParams im;
        for (const char* m : {"martin_ruiz", "physical"}) {
            im.iam_model = m;
            CHECK(std::fabs(incidence_modifier(im, 1.0) - 1) < 1e-12 && incidence_modifier(im, 1e-6) < 1e-3 &&
                      incidence_modifier(im, std::cos(70 * d2r)) < incidence_modifier(im, std::cos(50 * d2r)), "%s IAM shape", m);
        }
        const double bare = incidence_modifier(im, std::cos(70 * d2r));
        im.iam_n_ar = 1.29;
        CHECK(incidence_modifier(im, std::cos(70 * d2r)) > bare, "coated glass IAM %.4f vs %.4f", incidence_modifier(im, std::cos(70 * d2r)), bare);
        im.iam_model = "martin_ruiz";
        for (double tilt : {10.0, 30.0, 60.0}) {
            const double b = tilt * d2r, T = std::sin(b) + (3.14159265358979 - b - std::sin(b)) / (1 + std::cos(b));
            const double mr = 1 - std::exp(-(4 / (3 * 3.14159265358979) + (0.5 * im.iam_ar - 0.154) * T) * T / im.iam_ar);
            CHECK(std::fabs(diffuse_iam(im, tilt)[0] / mr - 1) < 0.01, "sky diffuse IAM at %.0f deg %.4f vs %.4f", tilt, diffuse_iam(im, tilt)[0], mr);
        }

        // Inverter curve: the fitted losses give the peak and the European weighted efficiency back
        const std::array<double, 2> k = inverter_curve(0.983, 0.99);
        auto eta = [&](double p) { return p / (p + k[0] + k[1] * p * p); };
        const double euro = 0.03 * eta(0.05) + 0.06 * eta(0.1) + 0.13 * eta(0.2) + 0.1 * eta(0.3) + 0.48 * eta(0.5) + 0.2 * eta(1.0);
        CHECK(std::fabs(eta(std::sqrt(k[0] / k[1])) - 0.99) < 1e-9 && std::fabs(euro - 0.983) < 2e-5, "inverter curve: peak %.5f, European %.5f",
              eta(std::sqrt(k[0] / k[1])), euro);

        // Horizon views: an open horizon hides nothing; 10 deg all round leaves cos^2(10 deg) of the sky to a horizontal plane
        CHECK(horizon_view(std::vector<double>(36, 0.0), 20, 180)[0] == 1 && std::fabs(horizon_view(std::vector<double>(36, 10.0), 0, 0)[0] -
                  std::cos(10 * d2r) * std::cos(10 * d2r)) < 2e-3, "horizon view of the sky");

        Project q = p;
        const PVProfile base = compute_pv_profile(q);
        auto yield = [](const Project& x) { return compute_pv_profile(x).specific_yield; };
        auto step = [](const PVProfile& r, const char* name) { for (const auto& l : r.losses) if (l.name == name) return l.value; return -1.0; };
        // terrain horizon: blocks beam and sky with its own loss step; measured data are left alone
        Project hz = q;
        hz.pv.horizon.assign(36, 0.0);
        for (int a = 3; a <= 15; ++a) hz.pv.horizon[size_t(a)] = 12;   // hills from 30 to 150 deg
        const PVProfile ph = compute_pv_profile(hz);
        CHECK(ph.specific_yield < base.specific_yield && step(ph, "After terrain horizon") < ph.poa_annual, "horizon loss");
        hz.pv.horizon_beam = "data";
        CHECK(yield(hz) == base.specific_yield, "horizon with measured data changed the yield");

        // Ineichen: weather made from the model at turbidity 4 gives turbidity 4 back, so the estimated clear sky equals it
        Project ci = q;
        ci.pv.clearsky = "ineichen";
        ci.pv.linke_turbidity = 4;
        ci.wx.ghi = clearsky_ghi(ci);
        const std::vector<double> c4 = ci.wx.ghi;
        ci.pv.linke_turbidity = 0;
        const std::vector<double> est = clearsky_ghi(ci);
        double dmax = 0, peak = 0;
        for (int i = 0; i < HOURS; ++i) { dmax = std::max(dmax, std::fabs(est[i] - c4[i])); peak = std::max(peak, c4[i]); }
        CHECK(dmax < 1e-6 * peak && peak > 900 && peak < 1150, "Ineichen turbidity estimate: max difference %.3g W/m2, peak %.0f", dmax, peak);
        const std::vector<double> cpv = clearsky_pv_per_kwp(ci);
        CHECK(*std::max_element(cpv.begin(), cpv.end()) > 0.5, "Ineichen clear-sky PV");

        // decomposition of GHI-only weather: each model splits consistently and stays within a few % of the others
        double yd[3];
        int nd = 0;
        for (const char* m : {"erbs", "disc", "boland"}) {
            Project x = q;
            x.pv.decomposition = m;
            const PVProfile r = compute_pv_profile(x);
            yd[nd++] = r.specific_yield;
            double dsum = 0;
            for (double v : r.m_dhi) dsum += v;
            CHECK(dsum > 0 && dsum < r.ghi_annual, "%s diffuse %.1f of GHI %.1f kWh/m2", m, dsum, r.ghi_annual);
        }
        CHECK(yd[0] == base.specific_yield && std::fabs(yd[1] / yd[0] - 1) < 0.03 && std::fabs(yd[2] / yd[0] - 1) < 0.03, "decomposition yields %.1f %.1f %.1f",
              yd[0], yd[1], yd[2]);

        // spectral correction in one hour: M = a kc^b AMa^c with the Haurwitz clear-sky index
        Project h1 = make_project(-10, 30);
        h1.loc.utc_offset = 2;
        for (auto* v : {&h1.wx.ghi, &h1.wx.dni, &h1.wx.dhi}) v->assign(HOURS, 0.0);
        const SunPos sp = sun_position(-10, 30, 101, 7.5);
        h1.wx.ghi[100 * 24 + 7] = 400;
        h1.pv.spectral = "monosi";
        const PVProfile s1 = compute_pv_profile(h1);
        const double am = 1 / (sp.cos_zenith + 0.50572 * std::pow(96.07995 - sp.zenith_deg, -1.6364)), kc = std::clamp(400 / haurwitz_ghi(sp.cos_zenith), 0.1, 1.2);
        const double m_exp = 0.9845 * std::pow(kc, -0.05169) * std::pow(std::max(1.0, am), 0.03034);
        CHECK(std::fabs(step(s1, "After spectral correction") / step(s1, "Effective irradiation (after soiling)") / m_exp - 1) < 1e-9, "PVSPEC factor %.6f",
              m_exp);

        // bypass-diode blocks: a shadow costs at least as much as the linear model, nothing changes without one
        Project sb = q;
        sb.pv.tilt = 30; sb.pv.gcr = 0.7;
        const double lin = step(compute_pv_profile(sb), "After near/row shading");
        sb.pv.shade_model = "blocks";
        const double blk = step(compute_pv_profile(sb), "After near/row shading");
        sb.pv.row_shading = false;
        const double none = yield(sb);
        sb.pv.shade_model = "linear";
        CHECK(blk < lin && none == yield(sb), "bypass blocks %.2f vs linear %.2f kWh/m2", blk, lin);

        // slope-aware tracking: a vanishing axis tilt reproduces the level tracker; backtracking on a slope avoids row shading
        Project tk = q;
        tk.pv.mount = "tracker"; tk.pv.gcr = 0.4;
        const double flat = yield(tk);
        tk.pv.tracker_axis_tilt = 1e-9;
        CHECK(std::fabs(yield(tk) / flat - 1) < 1e-9, "tracker with a vanishing axis tilt %.6f vs %.6f", yield(tk), flat);
        tk.pv.tracker_axis_tilt = 0; tk.pv.tracker_cross_slope = 6;
        const PVProfile slope = compute_pv_profile(tk);
        CHECK(slope.losses[2].value == slope.poa_annual && slope.specific_yield != flat, "slope-aware backtracking left row shading");
        tk.pv.backtracking = false;
        const PVProfile sl_nb = compute_pv_profile(tk);
        CHECK(sl_nb.losses[2].value < sl_nb.poa_annual, "row shading on a slope without backtracking");

        // inverter curve: constant above the self-consumption and below the rating, the same clipping limit
        Project iv = q;
        iv.pv.inverter_model = "curve";
        const PVProfile pc = compute_pv_profile(iv);
        CHECK(std::fabs(pc.specific_yield / base.specific_yield - 1) < 0.01 && *std::max_element(pc.ac_per_kwp.begin(), pc.ac_per_kwp.end()) <= 1 / iv.pv.dc_ac_ratio + 1e-9,
              "inverter curve yield %.2f vs %.2f", pc.specific_yield, base.specific_yield);

        // snow: the monthly model against its formula in one month; the hourly cover model sheds snow only in warm or bright hours
        Project sn = q;
        sn.pv.snow_monthly.assign(12, 0.0); sn.pv.snow_events.assign(12, 0.0);
        sn.pv.snow_monthly[1] = 40; sn.pv.snow_events[1] = 4;
        for (auto& t : sn.wx.tamb) t = -5;
        Project sn0 = sn;
        sn0.pv.snow_monthly.clear();
        const PVProfile f0 = compute_pv_profile(sn0), f1 = compute_pv_profile(sn);
        const double se = 2.0 / 3 * 0.5 * 40 / 2.54 * 1.25, lower = (sn.pv.mount_height - 0.5 * sn.pv.row_width * std::sin(sn.pv.tilt * d2r)) * 39.37;
        const double gam = sn.pv.row_width * 39.37 * se * std::cos(sn.pv.tilt * d2r) / std::max(0.1, lower * lower - se * se) * 2 * std::tan(40 * d2r);
        const double tw = 5.7e4 * se * std::pow(std::cos(sn.pv.tilt * d2r), 2) * (1 - 0.51 * std::exp(-gam)) * 0.8 / std::pow(268.15, 2) /
                          std::pow(f0.m_poa[1], 0.67) * 0.75;
        CHECK(std::fabs((f0.m_dc[1] - f1.m_dc[1]) / f0.m_dc[1] - tw) < 1e-9 && f1.m_dc[0] == f0.m_dc[0], "Townsend February loss %.4f vs %.4f",
              (f0.m_dc[1] - f1.m_dc[1]) / f0.m_dc[1], tw);
        Project hs = sn0;
        hs.wx.snow.assign(HOURS, 0.0);
        hs.wx.snow[size_t(40 * 24)] = 3;   // 3 cm in an hour on day 40
        const PVProfile fs = compute_pv_profile(hs);
        CHECK(step(fs, "After snow cover") < step(fs, "After temperature loss") && step(f0, "After snow cover") < 0, "hourly snow cover");

        // monthly albedo equal to the annual value, linear degradation over the years
        Project al = q;
        al.pv.albedo_monthly.assign(12, al.pv.albedo);
        CHECK(yield(al) == base.specific_yield, "monthly albedo equal to the annual value changed the yield");
        Project dg = q;
        dg.pv.degradation_model = "linear";
        dg.sim.all_years = true;
        const SimResult rd = simulate(dg, base.ac_per_kwp, cs, Sizing{1500, 0, 0}, false);
        CHECK(std::fabs(pv_degradation_factor(dg.pv, 11) - (1 - 10 * dg.pv.degradation)) < 1e-15 &&
                  std::fabs(rd.years[10].pv_avail / rd.years[0].pv_avail - (1 - 10 * dg.pv.degradation)) < 1e-9, "linear degradation in year 11 %.6f",
              rd.years[10].pv_avail / rd.years[0].pv_avail);

        // weather closure: consistent components pass, DHI scaled by 1.3 fails the comparison test
        Project cw = make_project(-2.5, 115.5);
        cw.pv.decomposition = "disc";
        cw.wx.dni.assign(HOURS, 0.0); cw.wx.dhi.assign(HOURS, 0.0);
        for (int i = 0; i < HOURS; ++i) {
            const SunPos s = sun_position(cw.loc.lat, cw.loc.lon, i / 24 + 1, (i % 24) + 0.5);
            if (s.cos_zenith <= 0.0872 || cw.wx.ghi[i] <= 0) { cw.wx.dhi[i] = cw.wx.ghi[i]; continue; }
            cw.wx.dhi[i] = 0.3 * cw.wx.ghi[i];
            cw.wx.dni[i] = 0.7 * cw.wx.ghi[i] / s.cos_zenith;
        }
        auto clos = [&](const Project& x) {
            const json::Value qc = data_qc(x, "weather");
            for (const auto& s : qc["weather"]["flags"].arr()) if (s["id"].str() == "closure") return s["hours"].num();
            return 0.0;
        };
        Project cb = cw;
        for (auto& x : cb.wx.dhi) x *= 1.3;
        CHECK(clos(cw) == 0 && clos(cb) > 100, "closure flags %g consistent, %g with DHI x 1.3", clos(cw), clos(cb));

        auto invalid = [&](auto set) {
            Project x = p;
            set(x);
            try { validate_project(x); } catch (const std::exception&) { return true; }
            return false;
        };
        CHECK(invalid([](Project& x) { x.pv.inverter_model = "curve"; x.pv.inverter_eff_max = 0.98; }) &&
                  invalid([](Project& x) { x.pv.horizon = {1, 2, 3}; }) && invalid([](Project& x) { x.pv.iam_model = "fresnel"; }) &&
                  invalid([](Project& x) { x.pv.snow_monthly.assign(12, 10.0); }) && !invalid([](Project& x) { x.pv.horizon.assign(48, 5.0); }),
              "further PV inputs: invalid accepted or valid refused");
        std::printf("  further PV models: horizon 12 deg east %+.2f %%, decomposition erbs/disc/boland %.0f/%.0f/%.0f, bypass blocks %.2f vs %.2f kWh/m2, "
                    "inverter curve %+.2f %%, Townsend Feb %.1f %%\n", 100 * (ph.specific_yield / base.specific_yield - 1), yd[0], yd[1], yd[2], blk, lin,
                    100 * (pc.specific_yield / base.specific_yield - 1), 100 * tw);
    }
    {
        // inputs and files that once got past the checks
        const Project v0 = make_project(-2.5, 115.5);
        auto refused = [&](auto set) {
            Project x = v0;
            set(x);
            try { validate_project(x); } catch (const std::exception&) { return true; }
            return false;
        };
        CHECK(!refused([](Project&) {}) && refused([](Project& x) { x.sim.load_growth = std::nan(""); }) &&
                  refused([](Project& x) { x.sim.load_growth = 1e308; }) && refused([](Project& x) { x.dg.unit_kw = INFINITY; }),
              "load growth or genset rating out of range accepted");
        const FuelTable ft(v0.dg);
        CHECK(ft(std::nan("")) == ft(0) && ft(-5) == ft(0) && ft(7) == ft(1), "fuel rate at NaN %g, below 0 %g, above 1 %g", ft(std::nan("")),
              ft(-5), ft(7));
        CHECK(iso_to_epoch_h("2024-01-01T0500") == NO_TIME_H && iso_to_epoch_h("2024-01-01T05:00") != NO_TIME_H &&
                  iso_to_epoch_h("2024-01-01T05:00") == iso_to_epoch_h("2024-01-01T05Z"), "forecast time without a colon accepted");
#ifndef _WIN32
        // the data folder: nothing is written or read through a link placed there
        namespace fs = std::filesystem;
        const fs::path root = fs::temp_directory_path() / ("soloptima-test-" + std::to_string(::getpid()));
        fs::remove_all(root);
        fs::create_directories(root / "outside");
        fs::create_directories(root / "data");
        std::ofstream(root / "outside" / "victim.txt") << "keep";
        fs::create_symlink(root / "outside" / "victim.txt", root / "data" / "p.json");
        fs::create_symlink(root / "outside" / "victim.txt", root / "data" / "p.json.tmp");
        write_atomic(root / "data" / "p.json", "new");
        std::string victim, written;
        std::getline(std::ifstream(root / "outside" / "victim.txt"), victim);
        std::getline(std::ifstream(root / "data" / "p.json"), written);
        CHECK(victim == "keep" && written == "new" && !fs::is_symlink(root / "data" / "p.json"), "write_atomic followed a link (target now '%s')",
              victim.c_str());

        Storage st(root / "data");
        fs::create_directories(root / "data" / "users" / "u1");
        fs::create_directory_symlink(root / "outside", root / "data" / "users" / "u1" / "projects");
        fs::create_directories(root / "data" / "users" / "u2");
        std::ofstream(root / "data" / "users" / "u2" / "profile.json") << R"({"id":"u3","name":"Other"})";
        auto throws = [](auto f) {
            try { f(); } catch (const std::exception&) { return true; }
            return false;
        };
        CHECK(throws([&] { st.list_projects("u1"); }) && throws([&] { st.list_projects("COM1"); }) && st.list_users().arr().empty(),
              "data folder: a linked projects folder, a device name or a profile under another folder's name passed");
        // folders Soloptima creates are the owner's alone, whatever the umask
        const mode_t mask = ::umask(022);
        make_private_dirs(root / "made" / "a" / "b");
        ::umask(mask);
        const auto mode = [](const fs::path& x) { return fs::status(x).permissions() & fs::perms::all; };
        CHECK(mode(root / "made") == fs::perms::owner_all && mode(root / "made" / "a" / "b") == fs::perms::owner_all &&
                  mode(root / "data" / "users") == fs::perms::owner_all, "new folder modes %o, %o", unsigned(mode(root / "made")),
              unsigned(mode(root / "data" / "users")));
        fs::remove_all(root);
#endif
    }
    {
        // update signatures: files made by minisign 0.12 with a throwaway key, prehashed (its default) and legacy
        const std::string sums = "0123abcd  Soloptima-mac.dmg\n4567ef01  Soloptima-linux-x86_64.AppImage\n";
        const std::string hashed = "untrusted comment: signature from minisign secret key\n"
                                   "RURP7nmR8aY5Z3LySt/3rxqFc95Xl4KPTtb4HppV+YzHZ2mGBTvhQ4Mzl5tjsrek0/7cYmtVGc5bc+2OSVBF2mw+tSBg2A6+7w8=\n"
                                   "trusted comment: soloptima 9.9.9 SHA256SUMS.txt\n"
                                   "QnSR7zLBORsLbgB3G0dUk0kCSkNPD7LEkwfgdEr56JuxQg22n+ut0k7DG43PaKRHxopaOEX+EcsDq0Be903+Ag==\n";
        const std::string legacy = "untrusted comment: signature from minisign secret key\n"
                                   "RWRP7nmR8aY5Z1ttp5jrGK8IBl0/00vm2qOCVco2tLsDAMQyv8GuQIMRRsNJBWhd0TyREfMJsL00U/IjKUgAZz0v9AviR/R4Hgw=\n"
                                   "trusted comment: soloptima 9.9.9 SHA256SUMS.txt\n"
                                   "34//mI5BjT6bQmByVyEgWEkU9i0IU46bp9KdYfFQqKywLFRwvWCnUQeHO3BPTHuJukAELA5Ri1gvpSafkKFSDQ==\n";
        const MinisignKey test_key = minisign_key("RWRP7nmR8aY5Z2oGoJJscnNW0TN2I+SMTCPb9P1xaKZHWMpoCNzQQaQ2");
        const std::vector<MinisignKey> test_keys{test_key};
        const std::string comment = "soloptima 9.9.9 SHA256SUMS.txt";
        auto fails = [](auto f) {
            try { f(); } catch (const std::exception&) { return true; }
            return false;
        };
        auto replaced = [](std::string t, const std::string& from, const std::string& to) {
            for (size_t at = t.find(from); at != std::string::npos; at = t.find(from, at + to.size())) t.replace(at, from.size(), to);
            return t;
        };
        auto key_id = [](const MinisignKey& k) {   // as minisign prints it
            char b[17];
            for (int i = 0; i < 8; ++i) std::snprintf(b + 2 * i, 3, "%02X", k.id[size_t(7 - i)]);
            return std::string(b);
        };
        CHECK(minisign_verify(sums, hashed, test_keys) == comment && minisign_verify(sums, legacy, test_keys) == comment &&
                  minisign_verify(sums, replaced(hashed, "\n", "\r\n"), test_keys) == comment && key_id(test_key) == "6739A6F19179EE4F",
              "signatures made by minisign refused");
        MinisignKey same_id = test_key;
        same_id.key = release_keys()[1].key;
        CHECK(fails([&] { minisign_verify(replaced(sums, "0123", "0124"), hashed, test_keys); }) &&
                  fails([&] { minisign_verify(sums, replaced(hashed, "9.9.9", "9.9.8"), test_keys); }) &&
                  fails([&] { minisign_verify(sums, hashed, release_keys()); }) && fails([&] { minisign_verify(sums, hashed, {same_id}); }) &&
                  fails([&] { minisign_verify(sums, hashed.substr(0, 120), test_keys); }) && fails([&] { minisign_verify(sums, "", test_keys); }) &&
                  fails([&] { minisign_verify(sums, replaced(hashed, "RURP", "R!RP"), test_keys); }),
              "a changed list, a changed comment, an unknown or wrong key, or a broken signature file passed");
        CHECK(!fails([&] { check_release_signature(sums, hashed, "9.9.9", test_keys); }) &&
                  fails([&] { check_release_signature(sums, hashed, "9.9.10", test_keys); }) &&
                  fails([&] { check_release_signature(sums, hashed, "9.9.9"); }),
              "release signature: another version, or a key that is not a release key, passed");
        const std::vector<MinisignKey> keys = release_keys();
        CHECK(keys.size() >= 2 && key_id(keys[0]) == "02FF7A7E03F8607A" && key_id(keys[1]) == "C7C0B8406739BFA6", "release key ids %s, %s",
              key_id(keys[0]).c_str(), keys.size() > 1 ? key_id(keys[1]).c_str() : "-");
        std::printf("  update signatures: minisign prehashed and legacy accepted, 7 tampered cases refused, release keys %s / %s\n",
                    key_id(keys[0]).c_str(), key_id(keys[1]).c_str());
    }
    // 25. Objects of the layout map (near shading) and PV areas with their own orientation: the near horizon of a point, the
    // share of a set of points behind a wall, the sky left over objects and terrain, the shade on each table, east-west and
    // per-area orientations under one inverter, the layout of a project file and its checks.
    {
        const double d2r = 3.14159265358979323846 / 180;
        // A 10 m high wall 20 m long, 10 m south of a point on the ground: 45 deg due south, lower off the axis (the 200 deg
        // azimuth takes the highest edge within 199-201 deg), nothing beyond its ends; a point inside the footprint sees 90 deg
        // all round, a point above the wall nothing.
        Obstacle wall;
        wall.height = 10;
        wall.pts = {{-10, -10}, {10, -10}, {10, -11}, {-10, -11}};
        const std::array<float, NEAR_BINS> hw = near_horizon(0, 0, 0, {wall});
        CHECK(std::fabs(hw[near_bin(180)] - 45) < 1e-4 && std::fabs(hw[near_bin(200)] - std::atan(std::cos(19 * d2r)) / d2r) < 1e-4 &&
                  hw[near_bin(240)] == 0 && hw[near_bin(0)] == 0, "near horizon of a wall: %.3f %.3f %.3f", hw[near_bin(180)], hw[near_bin(200)],
              hw[near_bin(240)]);
        CHECK(near_horizon(0, -10.5, 0, {wall})[near_bin(0)] == 90 && near_horizon(0, 0, 11, {wall})[near_bin(180)] == 0, "under and above the wall");
        // One point 10 m and one 110 m north of the wall (5.2 deg): the sun at 30 deg in the south is hidden from one of them
        const NearShading two({{0, 0, 0, -1}, {0, 100, 0, -1}}, {wall}, {});
        CHECK(two.shaded(180, 30) == 0.5 && two.shaded(180, 3) == 1 && two.shaded(180, 50) == 0 && two.shaded(0, 10) == 0, "share behind the wall");
        // Sky view: with no object in view it is the terrain's; the wall takes part of it
        const std::vector<double> ten(36, 10.0);
        const NearShading open({{0, 5000, 0, -1}}, {wall}, ten), walled({{0, 0, 0, -1}}, {wall}, ten);
        CHECK(sky_view(open.sky(), 20, 180) == horizon_view(ten, 20, 180) && sky_view(walled.sky(), 20, 180)[0] < horizon_view(ten, 20, 180)[0] - 0.02,
              "sky view over the wall %.4f vs %.4f", sky_view(walled.sky(), 20, 180)[0], horizon_view(ten, 20, 180)[0]);

        // Four tables 20 m x 4 m in two columns facing north (corners: upper edge first), a 20 m building 10 m east of the area
        Project a = make_project(-2.5, 115.5);
        a.pv.dc_ac_ratio = 1.0;
        a.layout.areas.push_back({});
        a.layout.areas[0].pts = {{-30, -30}, {30, -30}, {30, 30}, {-30, 30}};
        for (double y : {-20.0, 10.0})
            for (double x : {-30.0, 10.0}) a.layout.tables.push_back({PlanPoint{x, y}, PlanPoint{x + 20, y}, PlanPoint{x + 20, y + 4}, PlanPoint{x, y + 4}});
        const PVProfile open_pv = compute_pv_profile(a);
        Project plain = make_project(-2.5, 115.5);
        plain.pv.dc_ac_ratio = 1.0;
        CHECK(open_pv.specific_yield == compute_pv_profile(plain).specific_yield, "a layout without objects or own orientations changes nothing");
        Obstacle tower;
        tower.height = 20;
        tower.pts = {{40, -30}, {60, -30}, {60, 30}, {40, 30}};
        Project ob = a;
        ob.layout.obstacles = {tower};
        const PVProfile sh = compute_pv_profile(ob, array_groups(ob), true);
        double near_step = 0, hor_ref = 0;
        for (const auto& l : sh.losses) {
            if (l.name == "After shading by nearby objects") near_step = l.value;
            if (l.name == "Global incident in collector plane") hor_ref = l.value;
        }
        CHECK(sh.specific_yield < open_pv.specific_yield && near_step > 0 && near_step < hor_ref, "near shading loss %.2f %% of POA",
              100 * (1 - near_step / hor_ref));
        CHECK(sh.table_shade.size() == 4 && sh.table_shade[1] > sh.table_shade[0] && sh.table_shade[3] > sh.table_shade[2] && sh.table_shade[0] > 0,
              "shade per table %.4f %.4f %.4f %.4f", sh.table_shade[0], sh.table_shade[1], sh.table_shade[2], sh.table_shade[3]);
        CHECK(sh.near_max.size() == NEAR_BINS && sh.near_max[near_bin(90)] > 20 && sh.near_max[near_bin(270)] == 0, "near horizon envelope");
        Project off = ob;
        off.pv.near_shading = false;
        Project low = ob;
        low.layout.obstacles[0].height = 1.0;   // below the tables
        CHECK(compute_pv_profile(off).specific_yield == open_pv.specific_yield &&
                  std::fabs(compute_pv_profile(low).specific_yield / open_pv.specific_yield - 1) < 1e-9, "objects switched off or out of the way");

        // Areas with their own orientation: the project's own values change nothing; east-west tables without clipping give the
        // mean of the two orientations, with clipping at least that (the inverter clips their sum); without tables the areas'
        // plan areas set the shares.
        auto yield_az = [&](double az, double tilt, double ratio) {
            Project b = make_project(-2.5, 115.5);
            b.pv.azimuth = az; b.pv.tilt = tilt; b.pv.dc_ac_ratio = ratio;
            return compute_pv_profile(b).specific_yield;
        };
        Project same = a;
        same.layout.areas[0].tilt = a.pv.tilt;
        same.layout.areas[0].azimuth = a.pv.azimuth;
        CHECK(compute_pv_profile(same).specific_yield == open_pv.specific_yield, "own orientation equal to the project's");
        Project ew = a;
        ew.layout.areas[0].azimuth = 90;
        ew.layout.areas[0].east_west = true;
        const double y_ew = compute_pv_profile(ew).specific_yield, y_mean = (yield_az(90, 10, 1.0) + yield_az(270, 10, 1.0)) / 2;
        ew.pv.dc_ac_ratio = 1.6;
        const double y_ew_clip = compute_pv_profile(ew).specific_yield, y_mean_clip = (yield_az(90, 10, 1.6) + yield_az(270, 10, 1.6)) / 2;
        CHECK(std::fabs(y_ew / y_mean - 1) < 1e-9 && y_ew_clip >= y_mean_clip - 1e-9, "east-west %.2f vs %.2f, clipped %.2f vs %.2f", y_ew, y_mean,
              y_ew_clip, y_mean_clip);
        Project two_areas = make_project(-2.5, 115.5);
        two_areas.pv.dc_ac_ratio = 1.0;
        two_areas.layout.areas.resize(2);
        two_areas.layout.areas[0].pts = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
        two_areas.layout.areas[0].tilt = 30;
        two_areas.layout.areas[1].pts = {{20, 0}, {50, 0}, {50, 10}, {20, 10}};
        const double y_two = compute_pv_profile(two_areas).specific_yield, y_mix = 0.25 * yield_az(0, 30, 1.0) + 0.75 * yield_az(0, 10, 1.0);
        CHECK(std::fabs(y_two / y_mix - 1) < 1e-9, "areas weighted by plan area %.3f vs %.3f", y_two, y_mix);

        // Tables carry the area the layout map filled them into: a roof area inside a ground area keeps its own tilt
        Project nested = make_project(-2.5, 115.5);
        nested.pv.dc_ac_ratio = 1.0;
        nested.layout.areas.resize(2);
        nested.layout.areas[0].pts = {{-50, -50}, {50, -50}, {50, 50}, {-50, 50}};
        nested.layout.areas[1].pts = {{-10, -10}, {10, -10}, {10, 10}, {-10, 10}};
        nested.layout.areas[1].tilt = 30;
        nested.layout.tables = {{PlanPoint{-8, 0}, PlanPoint{8, 0}, PlanPoint{8, 4}, PlanPoint{-8, 4}}};
        nested.layout.table_area = {1};
        CHECK(std::fabs(compute_pv_profile(nested).specific_yield / yield_az(0, 30, 1.0) - 1) < 1e-9, "table in the roof area at its tilt");

        // Bounded work on layouts built to be expensive: tables without width get one point each, a sliver of an area a bounded
        // grid; too many object corners for the points is refused
        Project thin = ob;
        thin.layout.tables.assign(2000, {PlanPoint{-20000, 0}, PlanPoint{20000, 0}, PlanPoint{20000, 0}, PlanPoint{-20000, 0}});
        thin.layout.table_area.clear();
        const std::vector<ArrayGroup> tg = array_groups(thin);
        size_t thin_pts = 0;
        for (const ArrayGroup& g : tg) thin_pts += g.near ? g.near->points().size() : 0;
        Project sliver = ob;
        sliver.layout.tables.clear();
        sliver.layout.areas[0].pts = {{-40000, -40000}, {40000, 40000}, {40000, 40000.5}};
        const std::vector<ArrayGroup> sg = array_groups(sliver);
        Project heavy = ob;
        heavy.layout.obstacles.assign(4000, Obstacle{});
        for (size_t k = 0; k < heavy.layout.obstacles.size(); ++k) {
            Obstacle& o = heavy.layout.obstacles[k];
            o.height = 10;
            for (int c = 0; c < 24; ++c) o.pts.push_back({100 + double(k % 60) * 30 + std::cos(c * 0.2618), 100 + double(k / 60) * 30 + std::sin(c * 0.2618)});
        }
        heavy.layout.tables.assign(30000, ob.layout.tables[0]);
        bool refused = false;
        try { array_groups(heavy); } catch (const std::exception&) { refused = true; }
        CHECK(thin_pts <= 22000 && !sg.empty() && sg[0].near && sg[0].near->points().size() <= 21000 && refused,
              "bounded near shading: %zu points on thin tables, %zu on a sliver, heavy layout refused %d", thin_pts,
              sg.empty() || !sg[0].near ? size_t(0) : sg[0].near->points().size(), int(refused));

        // Project file: PV areas, buildings and trees as lat/lon on the layout's projection, tables from the layout result
        const Project f = parse_project(json::parse(R"({"location":{"lat":-8.5,"lon":115.2},"layout":{"polygons":[
            {"type":"site","latlngs":[[-8.5,115.2],[-8.5,115.201],[-8.499,115.201],[-8.499,115.2]],"base":6,"tilt":15,"azimuth":0,"east_west":false},
            {"type":"exclusion","latlngs":[[-8.5,115.2],[-8.5,115.2005],[-8.4995,115.2005]]},
            {"type":"obstacle","latlngs":[[-8.501,115.2],[-8.501,115.2002],[-8.5012,115.2002]],"height":12},
            {"type":"obstacle","kind":"tree","center":[-8.4985,115.2],"diameter":6,"height":9}],
            "result":{"tables":[[[-8.5,115.2],[-8.5,115.2001],[-8.49997,115.2001],[-8.49997,115.2]]]}}})"));
        const Obstacle& tree = f.layout.obstacles[1];
        CHECK(f.layout.areas.size() == 1 && f.layout.areas[0].base == 6 && f.layout.areas[0].tilt == 15 && std::fabs(f.layout.areas[0].pts[2][1] - 110.574) < 1e-6 &&
                  f.layout.obstacles.size() == 2 && f.layout.obstacles[0].height == 12 && tree.pts.size() == 16 &&
                  std::fabs(std::hypot(tree.pts[0][0] - tree.pts[8][0], tree.pts[0][1] - tree.pts[8][1]) - 6) < 1e-9 && f.layout.tables.size() == 1,
              "layout of a project file");
        auto bad = [&](auto set) {
            Project x = ob;
            set(x);
            try { validate_project(x); } catch (const std::exception&) { return true; }
            return false;
        };
        CHECK(bad([](Project& x) { x.layout.obstacles[0].height = 0; }) && bad([](Project& x) { x.layout.areas[0].tilt = 95; }) &&
                  bad([](Project& x) { x.layout.tables[0][2] = {6e4, 0}; }) && bad([](Project& x) { x.layout.obstacles[0].pts.resize(2); }) &&
                  bad([](Project& x) { x.layout.obstacles[0].pts.assign(6000, PlanPoint{50, 0}); }) &&
                  bad([](Project& x) { x.layout.table_area = {0, 0, 0, 7}; }) &&
                  !bad([](Project&) {}), "layout checks: invalid accepted or valid refused");
        std::printf("  layout objects: 20 m building east of the tables %+.2f %% yield, shade per table %.1f-%.1f %%; east-west %+.2f %% vs the "
                    "mean of east and west with DC/AC 1.6\n", 100 * (sh.specific_yield / open_pv.specific_yield - 1), 100 * sh.table_shade[0],
                    100 * sh.table_shade[3], 100 * (y_ew_clip / y_mean_clip - 1));
    }
    std::printf(failures ? "%d FAILURE(S)\n" : "All engine tests passed\n", failures);
    return failures ? 1 : 0;
}
