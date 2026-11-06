// Writes engine/tests/fixtures/opt.json from the C++ engine: parse_opt_settings on optimizer blocks (defaults, limits, the
// sensitivity errors), optimize on the example project for each search algorithm with constraints, C-rate and wind ranges,
// the predictive EMS and sensitivity runs, and run_batch with override paths. Each case keeps its inputs (a patch merged
// into the example project, the optimizer block) and the hash of the answer as JSON, plus a readable part of it.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/geno tests/gen_opt_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl -framework Security -framework CoreFoundation
//   /tmp/geno web/examples/example_study.json engine/tests/fixtures/opt.json
#include "finance.hpp"
#include "json.hpp"
#include "model.hpp"
#include "optimizer.hpp"
#include "parallel.hpp"
#include "pv.hpp"
#include "sim.hpp"
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

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

// run_batch and its helpers as in src/main.cpp (where they sit in an unnamed namespace)
static Sizing sizing_of(const Project& p) { return Sizing{p.pv.capacity_kwp, p.bess.energy_kwh, p.bess.power_kw, double(p.wind.units)}; }

static json::Value with_path(const json::Value& root, const std::vector<std::string>& keys, size_t i, const json::Value& v) {
    if (i == keys.size()) return v;
    json::Object o = root.obj();
    o[keys[i]] = with_path(root[keys[i]], keys, i + 1, v);
    return json::Value(std::move(o));
}

static json::Value run_batch(const json::Value& base, const json::Array& cases) {
    if (cases.size() > 20000) throw std::runtime_error("Batch limited to 20000 cases.");
    const Project base_p = parse_project(base);
    PVProfile base_prof;
    std::vector<double> base_cs;
    if (base_p.wx.ghi.size() == HOURS) { base_prof = compute_pv_profile(base_p); base_cs = clearsky_pv_per_kwp(base_p); }
    std::vector<json::Value> out(cases.size());
    parallel_for(cases.size(), std::max(1u, std::thread::hardware_concurrency()), [&](size_t i) {
        try {
            json::Value pj = base;
            bool own_pv = false;
            for (const auto& kv : cases[i]["overrides"].obj()) {
                std::vector<std::string> keys;
                std::stringstream ss(kv.first);
                for (std::string part; std::getline(ss, part, '.');) {
                    keys.push_back(part);
                    if (keys.size() > 8) throw std::runtime_error("An override path has at most 8 parts: " + kv.first.substr(0, 60));
                }
                pj = with_path(pj, keys, 0, kv.second);
                own_pv = own_pv || keys.empty() ||
                         ((keys[0] == "location" || keys[0] == "weather" || keys[0] == "pv" || keys[0] == "layout") && kv.first != "pv.capacity_kwp");
            }
            Project p = parse_project(pj);
            validate_project(p);
            PVProfile own_prof;
            std::vector<double> own_cs;
            if (own_pv) { own_prof = compute_pv_profile(p); own_cs = clearsky_pv_per_kwp(p); }
            const PVProfile& prof = own_pv ? own_prof : base_prof;
            const std::vector<double>& cs = own_pv ? own_cs : base_cs;
            SimResult hyb = simulate(p, prof.ac_per_kwp, cs, sizing_of(p), false);
            SimResult base_r = simulate(p, prof.ac_per_kwp, cs, Sizing{}, false);
            json::Value fin = run_finance(p, parse_finance(pj["finance"], p), hyb, base_r);
            out[i] = json::Value(json::Object{{"result", result_to_json(hyb, false)},
                                              {"comparison", comparison_to_json(compare(hyb, base_r))},
                                              {"finance", fin["metrics"]}, {"specific_yield", prof.specific_yield}});
        } catch (const std::exception& e) {
            out[i] = json::Value(json::Object{{"error", std::string(e.what())}});
        }
    });
    return json::Value(json::Object{{"results", json::Value(std::move(out))}});
}

static json::Value fin_or_null(double x) { return std::isfinite(x) ? json::Value(x) : json::Value(); }

static json::Value settings_json(const OptSettings& o) {
    return json::Value(json::Object{
        {"pv_min", o.pv_min}, {"pv_max", o.pv_max}, {"pv_steps", o.pv_steps}, {"bess_min", o.bess_min}, {"bess_max", o.bess_max},
        {"bess_steps", o.bess_steps}, {"c_rates", json::Value(o.c_rates)}, {"objective", o.objective}, {"max_unmet", o.max_unmet},
        {"max_lole_h", o.max_lole_h}, {"max_reserve_short_h", o.max_reserve_short_h}, {"min_re", o.min_re},
        {"max_curtail", o.max_curtail}, {"max_pv_kwp", fin_or_null(o.max_pv_kwp)}, {"max_capex", fin_or_null(o.max_capex)},
        {"refine", o.refine}, {"threads", o.threads}, {"sens_var", o.sens_var}, {"sens_values", json::Value(o.sens_values)},
        {"algorithm", o.algorithm}, {"particles", o.particles}, {"iterations", o.iterations}, {"seed", double(o.seed)},
        {"wind_min", o.wind_min}, {"wind_max", o.wind_max}, {"mo_second", o.mo_second}});
}

struct Case { const char* name; const char* patch; const char* opt; };

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: geno example.json out.json\n"; return 1; }
    std::ifstream in(argv[1]);
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string example = ss.str();
    auto project_doc = [&](const char* patch) {
        json::Value doc = json::parse(example);   // a fresh document: Value copies share their objects
        merge(doc, json::parse(patch));
        return doc;
    };
    json::Value out = json::Value::object();

    // parse_opt_settings: defaults from the load and the PV yield, limits, and the sensitivity errors
    const std::vector<const char*> parse_cases = {
        "{}",
        R"({"pv_steps":0.7,"bess_steps":500,"c_rates":[0,-1,"x",0.75],"threads":999,"particles":1,"iterations":1000,"seed":-1,"wind_min":-3,"wind_max":-5,"algorithm":"bogus","max_pv_kwp":-1,"max_capex":5e6,"refine":false,"objective":"lcoe","mo_second":"sssi"})",
        R"({"c_rates":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22],"pv_min":100,"pv_max":50,"bess_min":10,"bess_max":5,"seed":4294967297,"wind_min":2,"wind_max":5,"max_lole_h":3,"max_reserve_short_h":0})",
        R"({"c_rates":[],"pv_max":1e5,"bess_max":2e4,"threads":-4,"particles":250,"iterations":0,"algorithm":"hshoa","sens_var":"fuel_price","sens_values":[0.5,1,-2]})",
        R"({"sens_var":"bess_life_scale","sens_values":[0]})",
        R"({"sens_var":"bess_cycle_life","sens_values":[3000,-1]})",
        R"({"sens_var":"bess_calendar_fade","sens_values":[-1.5e-7]})",
        R"({"sens_var":"bess_replace_soh","sens_values":[1]})",
        R"({"sens_var":"pv_degradation","sens_values":[0.005,1.25]})",
        R"({"sens_var":"diesel_om_unit_hour","sens_values":[-0.001]})",
        R"({"sens_var":"fuel_price","sens_values":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]})",
    };
    json::Value plist = json::Value::array();
    {
        const Project p = parse_project(project_doc("{}"));
        for (const char* js : parse_cases) {
            json::Value o = json::Value::object();
            o["block"] = json::parse(js);
            try { o["settings"] = settings_json(parse_opt_settings(json::parse(js), p)); }
            catch (const std::exception& e) { o["error"] = std::string(e.what()); }
            plist.push(o);
        }
    }
    out["parse"] = plist;

    const char* FA = R"({"sim":{"all_years":false}})";
    const std::vector<Case> cases = {
        {"grid c-rates refine", FA, R"({"pv_max":150000,"pv_steps":4,"bess_max":150000,"bess_steps":3,"c_rates":[0.25,0.5],"threads":3})"},
        {"grid lcoe constraints", FA, R"({"pv_min":5000,"pv_max":60000,"pv_steps":4,"bess_min":2000,"bess_max":40000,"bess_steps":3,"objective":"lcoe","min_re":0.3,"max_curtail":0.15,"max_pv_kwp":45000,"max_capex":6e7,"max_lole_h":0,"max_reserve_short_h":0,"max_unmet":0.0005})"},
        {"grid re objective", FA, R"({"pv_max":80000,"pv_steps":3,"bess_max":60000,"bess_steps":3,"objective":"re"})"},
        {"grid infeasible", FA, R"({"pv_max":20000,"pv_steps":2,"bess_max":10000,"bess_steps":2,"min_re":0.99})"},
        {"grid all years battery life sensitivity", "{}", R"({"pv_max":50000,"pv_steps":2,"bess_max":30000,"bess_steps":2,"refine":false,"sens_var":"bess_life_scale","sens_values":[0.5,2]})"},
        {"grid load sensitivity", FA, R"({"pv_max":50000,"pv_steps":3,"bess_max":30000,"bess_steps":2,"refine":false,"sens_var":"load_scale","sens_values":[0.8,1.2]})"},
        {"grid battery prices sensitivity refine", FA, R"({"pv_max":50000,"pv_steps":2,"bess_max":30000,"bess_steps":2,"sens_var":"bess_prices_scale","sens_values":[0.5]})"},
        {"grid predictive", R"({"sim":{"all_years":false},"diesel":{"strategy":"predictive"}})", R"({"pv_max":40000,"pv_steps":2,"bess_max":30000,"bess_steps":2,"refine":false})"},
        {"grid wind units", R"({"sim":{"all_years":false},"wind":{"units":2,"rated_kw":2000}})", R"({"pv_max":40000,"pv_steps":2,"bess_max":20000,"bess_steps":2})"},
        {"pso c-rate range", FA, R"({"algorithm":"pso","pv_max":150000,"bess_max":150000,"c_rates":[0.25,0.5,1],"particles":8,"iterations":5,"seed":7})"},
        {"pso wind range", R"({"sim":{"all_years":false},"wind":{"rated_kw":2000}})", R"({"algorithm":"pso","pv_max":60000,"bess_max":40000,"wind_min":0,"wind_max":3,"particles":6,"iterations":4})"},
        {"hshoa", FA, R"({"algorithm":"hshoa","pv_max":150000,"bess_max":150000,"particles":8,"iterations":6})"},
        {"hshoa converging", FA, R"({"algorithm":"hshoa","pv_max":150000,"bess_max":150000,"particles":12,"iterations":20,"seed":3})"},
        {"hshoa 30 agents", FA, R"({"algorithm":"hshoa","pv_max":150000,"bess_max":150000,"particles":30,"iterations":15,"seed":11})"},
        {"mopso 30 particles", FA, R"({"algorithm":"mopso","pv_max":150000,"bess_max":150000,"particles":30,"iterations":8,"seed":5})"},
        {"hshoa fixed wind re", R"({"sim":{"all_years":false},"wind":{"units":2,"rated_kw":2000}})", R"({"algorithm":"hshoa","pv_max":60000,"bess_max":40000,"particles":5,"iterations":4,"objective":"re"})"},
        {"mopso re", FA, R"({"algorithm":"mopso","pv_max":150000,"bess_max":150000,"particles":10,"iterations":6})"},
        {"mopso sssi lcoe", FA, R"({"algorithm":"mopso","pv_max":150000,"bess_max":150000,"particles":10,"iterations":6,"mo_second":"sssi","objective":"lcoe","seed":123})"},
    };
    json::Value list = json::Value::array();
    for (const Case& c : cases) {
        const Project p = parse_project(project_doc(c.patch));
        validate_project(p);
        Progress prog;
        const json::Value r = optimize(p, parse_opt_settings(json::parse(c.opt), p), prog);
        json::Value o = json::Value::object();
        o["name"] = c.name;
        o["patch"] = json::parse(c.patch);
        o["optimizer"] = json::parse(c.opt);
        o["hash"] = hash(r.dump());
        o["best"] = r["best"];
        o["n_evaluated"] = r["n_evaluated"];
        o["n_feasible"] = r["n_feasible"];
        o["history"] = r["history"];
        o["done"] = double(prog.done.load());
        list.push(o);
        std::cerr << c.name << " " << o["hash"].str() << "\n";
    }
    out["cases"] = list;

    // run_batch: no overrides, sizes, finance, own PV, wind, predictive, and errors (9 path parts, validation)
    {
        const json::Value base = project_doc(FA);
        const json::Value bc = json::parse(R"([
            {"overrides":{}},
            {"overrides":{"pv.capacity_kwp":20000,"bess.energy_kwh":8000,"bess.power_kw":3000}},
            {"overrides":{"econ.fuel_price":1.1,"finance.model":"ppa","finance.components":[{"v1":0.2}]}},
            {"overrides":{"location.lat":-7.5,"pv.tilt":12}},
            {"overrides":{"a.b.c.d.e.f.g.h.i":1}},
            {"overrides":{"diesel.units":-1}},
            {"overrides":{"pv.":5}},
            {"overrides":{"wind.units":2,"wind.rated_kw":1500}},
            {"overrides":{"diesel.strategy":"predictive","ems.pv_forecast":"perfect"}},
            {"no_overrides":1}
        ])");
        const json::Value r = run_batch(base, bc.arr());
        json::Value b = json::Value::object();
        b["patch"] = json::parse(FA);
        b["cases"] = bc;
        b["hash"] = hash(r.dump());
        json::Value brief = json::Value::array();
        for (const auto& x : r["results"].arr()) brief.push(x["error"].is_string() ? x["error"] : x["result"]["econ"]["npc"]);
        b["brief"] = brief;
        out["batch"] = b;
        std::cerr << "batch " << b["hash"].str() << "\n";
    }
    std::ofstream(argv[2]) << out.dump();
    return 0;
}
