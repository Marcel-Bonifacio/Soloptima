// Writes engine/tests/fixtures/sim.json from the C++ engine: the example project's PV (and wind) profiles, and for each case
// (a patch merged into the example project, a sizing) the hash of result_to_json and its figures without
// the hourly series and the middle years. Every case uses
// perfect forecasts, the one forecasting method the Rust engine has before session 2.11.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/gens tests/gen_sim_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl -framework Security -framework CoreFoundation
//   /tmp/gens web/examples/example_study.json engine/tests/fixtures/sim.json
#include "finance.hpp"
#include "json.hpp"
#include "model.hpp"
#include "pv.hpp"
#include "sim.hpp"
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>

static std::string hash(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}

static void merge(json::Value& dst, const json::Value& src) {
    if (!src.is_object() || !dst.is_object()) { dst = src; return; }
    for (const auto& [k, v] : src.obj()) merge(dst[k], v);
}

// The profile's index in `list`, appended when no equal profile is there yet
static int profile_index(json::Value& list, const std::vector<double>& v) {
    json::Value x(v);
    for (size_t i = 0; i < list.arr().size(); ++i) if (list[i].dump() == x.dump()) return int(i);
    list.push(x);
    return int(list.arr().size()) - 1;
}

struct Case { const char* name; const char* patch; Sizing s; bool hourly; };

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: gens example.json out.json\n"; return 1; }
    std::ifstream in(argv[1]);
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string example = ss.str();
    const json::Value base_patch = json::parse(R"({"ems":{"pv_forecast":"perfect","load_forecast":"perfect"}})");
    const Sizing ex{30000, 6600, 2320, 0};
    const std::vector<Case> cases = {
        {"load following", "{}", ex, true},
        {"diesel only", "{}", Sizing{}, true},
        {"pv only", "{}", Sizing{30000, 0, 0, 0}, false},
        {"cycle charging", R"({"diesel":{"strategy":"cycle_charging","cc_setpoint":0.8}})", ex, true},
        {"cycle charging small battery", R"({"diesel":{"strategy":"cycle_charging","cc_setpoint":0.9}})", Sizing{30000, 2000, 500, 0}, false},
        {"predictive", R"({"diesel":{"strategy":"predictive"},"sim":{"all_years":false}})", ex, true},
        {"predictive firm replan 4", R"({"diesel":{"strategy":"predictive"},"ems":{"firm_commitment":true,"replan":4,"horizon":36,"soc_levels":31,"terminal_value":0.5},"sim":{"all_years":false}})", Sizing{20000, 9000, 3000, 0}, false},
        {"fast mode growth", R"({"sim":{"all_years":false},"load":{"growth":0.02}})", ex, false},
        {"ageing", R"({"load":{"growth":0.03},"bess":{"replace_soh":0.8,"soh_init":0.95,"self_discharge":0.0005,"cycle_life_dod":0.8,"calendar_fade":0.015},"econ":{"bess_cost_decline":0.04,"pv_life":30,"diesel_capex_kw":300,"other_capex_frac":0.05,"carbon_price_t":20,"population":50000}})", ex, false},
        {"aux half-hour offset", R"({"location":{"utc_offset":7.5},"aux":{"bess_kw_per_mwh":3,"bess_temp_coeff":0.03,"plant_kw":40,"trafo_noload_kw":12,"bess_trafo_noload_kw":5,"pcs_kw_per_mw":2}})", ex, true},
        {"linear fuel no battery reserve", R"({"diesel":{"fuel_model":"linear","min_units_online":2,"reserve_load":0.15},"bess":{"provides_reserve":false,"soc_min":0.1,"soc_init":0.5}})", ex, false},
        {"battery reserve 2 h", R"({"bess":{"reserve_duration_h":2}})", Sizing{30000, 4000, 2320, 0}, false},
        {"wind", R"({"wind":{"units":3,"rated_kw":2000}})", Sizing{30000, 6600, 2320, 3}, true},
        {"unmet load", R"({"diesel":{"units":4}})", ex, false},
    };

    json::Value out = json::Value::object();
    out["pv_profiles"] = json::Value::array();
    out["wind_profiles"] = json::Value::array();
    json::Value list = json::Value::array();
    std::vector<SimResult> results;
    for (const Case& c : cases) {
        json::Value doc = json::parse(example);   // a fresh document: Value copies share their objects
        merge(doc, base_patch);
        merge(doc, json::parse(c.patch));
        const Project p = parse_project(doc);
        validate_project(p);
        const PVProfile prof = compute_pv_profile(p);
        const std::vector<double> cs = clearsky_pv_per_kwp(p);
        const SimResult r = simulate(p, prof.ac_per_kwp, cs, c.s, c.hourly);
        json::Value o = json::Value::object();
        o["name"] = c.name;
        o["patch"] = json::parse(c.patch);
        o["sizing"] = json::Value(std::vector<double>{c.s.pv_kwp, c.s.bess_kwh, c.s.bess_kw, c.s.wind_units});
        o["hourly"] = c.hourly;
        o["pv"] = profile_index(out["pv_profiles"], prof.ac_per_kwp);
        o["wind"] = c.s.wind_units > 0.5 ? json::Value(profile_index(out["wind_profiles"], wind_per_turbine(p))) : json::Value();
        const json::Value full = result_to_json(r, true);
        o["hash"] = hash(full.dump());
        // the readable part: everything but the hourly series and the middle years
        json::Value res = result_to_json(r, false), ys = json::Value::array();
        ys.push(res["years"][size_t(0)]);
        ys.push(res["years"][r.years.size() - 1]);
        res["years"] = ys;
        o["result"] = res;
        list.push(o);
        results.push_back(r);
        std::cerr << c.name << " " << o["hash"].str() << "\n";
    }
    out["cases"] = list;
    // compare(): the hybrid against diesel only and against PV only
    out["compare_base"] = comparison_to_json(compare(results[0], results[1]));
    out["compare_pv_only"] = comparison_to_json(compare(results[0], results[2]));
    // The project finance on the simulated hybrid and baseline (a PPA with debt, so most year fields are read)
    {
        json::Value doc = json::parse(example);
        merge(doc, base_patch);
        const Project p = parse_project(doc);
        const json::Value fin = json::parse(R"({"model":"ppa","components":[{"v1":0.25}],"gearing":0.7})");
        out["finance"] = fin;
        out["finance_hash"] = hash(run_finance(p, parse_finance(fin, p), results[0], results[1]).dump());
    }
    std::ofstream(argv[2]) << out.dump();
    return 0;
}
