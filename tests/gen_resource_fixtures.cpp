// Writes engine/tests/fixtures/resource.json from the C++ engine: resource_years (inter-annual variability, P50/P90) on the
// example project with synthetic weather years (the project's weather with the irradiance scaled and the temperature shifted),
// for host-owned, PPA and TPO finance, a tariff solved for a target IRR, a zero budget, the predictive EMS, wind turbines and
// the error cases; plus exceedance() on its own. Each case keeps its inputs and the answer as JSON.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genr tests/gen_resource_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl
//   /tmp/genr web/examples/example_study.json engine/tests/fixtures/resource.json
#include "json.hpp"
#include "model.hpp"
#include "optimizer.hpp"
#include "resource.hpp"
#include <fstream>
#include <iostream>
#include <sstream>

static void merge(json::Value& dst, const json::Value& src) {
    if (!src.is_object() || !dst.is_object()) { dst = src; return; }
    for (const auto& [k, v] : src.obj()) merge(dst[k], v);
}

// year spec: [year, irradiance factor, temperature shift, wind factor]
static std::vector<WeatherYear> years_of(const Project& p, const json::Value& spec) {
    std::vector<WeatherYear> ys;
    for (const auto& s : spec.arr()) {
        WeatherYear y;
        y.year = int(s[size_t(0)].num());
        y.wx = p.wx;
        const double f = s[size_t(1)].num(), dt = s[size_t(2)].num(), fw = s[size_t(3)].num();
        for (auto* v : {&y.wx.ghi, &y.wx.dni, &y.wx.dhi})
            for (double& x : *v) x *= f;
        for (double& x : y.wx.tamb) x += dt;
        for (double& x : y.wx.wind) x *= fw;
        ys.push_back(y);
    }
    return ys;
}

int main(int argc, char** argv) {
    std::ifstream in(argv[1]);
    std::stringstream ss;
    ss << in.rdbuf();
    const json::Value example = json::parse(ss.str());
    const json::Value four = json::parse("[[2011,0.96,-0.4,1.1],[2012,1.03,0.2,0.9],[2013,0.99,0.0,1.0],[2014,1.05,0.6,0.8]]");
    const json::Value cases = json::parse(R"([
      {"name": "host", "patch": {}, "years": "four", "budget": {}},
      {"name": "host one year", "patch": {"sim": {"all_years": false}}, "years": "four", "budget": {"dataset": 0.04, "model": 0.03, "soiling": 0.01}},
      {"name": "ppa take-or-pay", "patch": {"finance": {"model": "ppa", "tariff": 0.18, "take_or_pay": 0.9, "penalty_threshold": 0.8, "penalty_rate": 0.5}},
       "years": "four", "budget": {}},
      {"name": "ppa solved", "patch": {"finance": {"model": "ppa", "tariff": 0.15, "solve": true, "target_irr": 0.12, "take_or_pay": 0.7}},
       "years": "four", "budget": {}},
      {"name": "tpo deemed", "patch": {"finance": {"model": "tpo", "tariff": 0.2, "deemed_share": 0.5, "take_or_pay": 0.5}},
       "years": "four", "budget": {}},
      {"name": "zero budget", "patch": {}, "years": "four", "budget": {"dataset": 0, "model": 0, "soiling": 0}},
      {"name": "two years", "patch": {}, "years": [[2020,0.98,0,1],[2021,1.02,0,1]], "budget": {}},
      {"name": "equal years", "patch": {}, "years": [[2020,1,0,1],[2021,1,0,1],[2022,1,0,1]], "budget": {}},
      {"name": "predictive", "patch": {"diesel": {"strategy": "predictive"}}, "years": "four", "budget": {}},
      {"name": "wind", "patch": {"wind": {"units": 3, "rated_kw": 900}}, "years": "four", "budget": {}},
      {"name": "no battery", "patch": {"bess": {"energy_kwh": 0, "power_kw": 0}}, "years": "four", "budget": {}},
      {"name": "one year", "patch": {}, "years": [[2020,1,0,1]], "budget": {}}
    ])");
    json::Value out = json::Value::array();
    for (const auto& c : cases.arr()) {
        json::Value doc = json::parse(example.dump());   // copies share their objects: parse again
        merge(doc, json::parse(c["patch"].dump()));
        doc = json::parse(doc.dump());
        json::Value o = json::parse(c.dump());
        o["years"] = c["years"].is_string() ? four : c["years"];
        try {
            const Project p = parse_project(doc);
            validate_project(p);
            UncertaintyBudget b;
            b.dataset = c["budget"].get("dataset", b.dataset);
            b.model = c["budget"].get("model", b.model);
            b.soiling = c["budget"].get("soiling", b.soiling);
            Progress prog;
            o["result"] = resource_years(p, doc, years_of(p, o["years"]), b, prog);
            o["progress"] = double(prog.done);
        } catch (const std::exception& e) {
            o["error"] = std::string(e.what());
        }
        out.push(o);
        std::cerr << c.gets("name", "") << "\n";
    }
    json::Value ex = json::Value::array();
    const json::Value xs = json::parse(R"([
      {"m0": 1500, "ys": [1450, 1520, 1490, 1560], "el": 1.1, "ss": 0.055, "benefit": true},
      {"m0": 2.5e6, "ys": [2.6e6, 2.4e6], "el": -0.8, "ss": 0.03, "benefit": false},
      {"m0": 10, "ys": [], "el": 1, "ss": 0.05, "benefit": true},
      {"m0": 10, "ys": [7], "el": 1, "ss": 0.05, "benefit": true},
      {"m0": 0, "ys": [0, 0, 0], "el": 0, "ss": 0.05, "benefit": false}
    ])");
    for (const auto& x : xs.arr()) {
        std::vector<double> ys;
        for (const auto& y : x["ys"].arr()) ys.push_back(y.num());
        const Exceedance e = exceedance(x["m0"].num(), ys, x["el"].num(), x["ss"].num(), x.getb("benefit", true));
        json::Value o = x;
        o["out"] = json::Value(json::Array{e.p50, e.mean, e.sigma_iav, e.sigma_1, e.sigma_10, e.p75_1, e.p90_1, e.p99_1, e.p90_10});
        ex.push(o);
    }
    std::ofstream f(argv[2]);
    f << json::Value(json::Object{{"cases", out}, {"exceedance", ex}}).dump();
    return 0;
}
