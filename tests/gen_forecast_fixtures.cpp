// Writes engine/tests/fixtures/forecast.json from the C++ engine: every PV and load forecasting method on the example project
// (the hash of its forecasts at several leads for every hour, and 48 sample values), the wind forecaster, and the predictive
// dispatch with the project's own forecasters (hash of result_to_json).
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genfc tests/gen_forecast_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl -framework Security -framework CoreFoundation
//   /tmp/genfc web/examples/example_study.json engine/tests/fixtures/forecast.json
#include "forecast.hpp"
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

static const int LEADS[] = {0, 1, 3, 6, 24, 36, 47};

// The forecasts of every hour at each lead (issue = tgt - lead), and 48 samples issued at hour 4000
static json::Value run(const SeriesForecaster& f) {
    json::Value all = json::Value::array(), s = json::Value::array();
    for (int lead : LEADS)
        for (int t = 0; t < HOURS; ++t) all.push(f(t - lead, t));
    for (int k = 0; k < 48; ++k) s.push(f(4000, 4000 + k));
    json::Value o = json::Value::object();
    o["hash"] = hash(all.dump());
    o["samples"] = s;
    return o;
}

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: genfc example.json out.json\n"; return 1; }
    std::ifstream in(argv[1]);
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string example = ss.str();
    const Project p = parse_project(json::parse(example));
    const PVProfile prof = compute_pv_profile(p);
    const std::vector<double> cs = clearsky_pv_per_kwp(p);
    json::Value out = json::Value::object(), pvm = json::Value::object(), lm = json::Value::object();
    for (const auto& m : pv_forecast_methods()) { pvm[m.id] = run(SeriesForecaster(m.id, prof.ac_per_kwp, cs, 0.15, 12345u)); std::cerr << "pv " << m.id << "\n"; }
    for (const auto& m : load_forecast_methods()) { lm[m.id] = run(SeriesForecaster(m.id, p.load_kw, {}, 0.2, 67890u)); std::cerr << "load " << m.id << "\n"; }
    out["pv"] = pvm;
    out["load"] = lm;
    out["unknown_pv"] = run(SeriesForecaster("nonsense", prof.ac_per_kwp, cs, 0.15, 1u));
    {
        json::Value doc = json::parse(example);
        merge(doc, json::parse(R"({"wind":{"units":3,"rated_kw":2000}})"));
        out["wind_ets"] = run(SeriesForecaster("ets", wind_per_turbine(parse_project(doc)), {}, 0.15, 24680u));
    }
    // Predictive dispatch on the project's own forecasters (year 1, hourly series and forecast skill)
    const char* cases[][2] = {
        {"default", R"({})"},
        {"rls ensemble", R"({"ems":{"pv_forecast":"rls","load_forecast":"ensemble"}})"},
        {"mlp mlp", R"({"ems":{"pv_forecast":"mlp","load_forecast":"mlp"}})"},
        {"analog weekly wind", R"({"ems":{"pv_forecast":"analog","load_forecast":"weekly","horizon":36,"replan":3},"wind":{"units":3,"rated_kw":2000}})"},
        {"noisy climatology", R"({"ems":{"pv_forecast":"noisy","load_forecast":"climatology","noise_sigma":0.3,"firm_commitment":true}})"},
        {"ensemble ets", R"({"ems":{"pv_forecast":"ensemble","load_forecast":"ets"}})"},
    };
    json::Value sims = json::Value::array();
    for (auto& c : cases) {
        json::Value doc = json::parse(example);
        merge(doc, json::parse(R"({"diesel":{"strategy":"predictive"},"sim":{"all_years":false}})"));
        merge(doc, json::parse(c[1]));
        const Project q = parse_project(doc);
        const Sizing s{30000, 6600, 2320, double(q.wind.units)};
        const SimResult r = simulate(q, compute_pv_profile(q).ac_per_kwp, clearsky_pv_per_kwp(q), s, true);
        json::Value o = json::Value::object();
        o["name"] = c[0];
        o["patch"] = json::parse(c[1]);
        o["hash"] = hash(result_to_json(r, true).dump());
        json::Value res = result_to_json(r, false);
        o["forecast"] = res["forecast"];
        o["fuel_l_y1"] = r.fuel_l_y1;
        sims.push(o);
        std::cerr << "sim " << c[0] << "\n";
    }
    out["sims"] = sims;
    std::ofstream(argv[2]) << out.dump();
    return 0;
}
