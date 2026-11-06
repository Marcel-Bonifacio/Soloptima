// Writes engine/tests/fixtures/pv.json from the C++ engine: the hourly PV profile of the example project and of variants that
// exercise each PV model (transposition, decomposition, trackers, bifacial, IAM, spectrum, temperature, snow, horizon, objects
// of the layout, inverter curve, time shifts), and the results of the smaller PV functions. Each case is the example project
// with a JSON patch merged into it (stored in the fixture, so the Rust test builds the same project) and optional named
// operations on the parsed project. Series are stored as FNV-1a hashes of their bit patterns; loss steps and a few summary
// values as numbers.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genpv tests/gen_pv_fixtures.cpp src/model.cpp \
//       src/pv.cpp src/shading.cpp src/weather.cpp src/series.cpp src/platform.cpp -lcurl
//   /tmp/genpv web/examples/example_study.json engine/tests/fixtures/pv.json
#include "json.hpp"
#include "model.hpp"
#include "pv.hpp"
#include "shading.hpp"
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>

// FNV-1a, 64 bit, over the little-endian bytes of each value's bit pattern, as 16 hex digits (the Rust tests compute the same)
static std::string fnv(const std::vector<double>& v) {
    uint64_t h = 1469598103934665603ULL;
    for (double d : v) {
        uint64_t b;
        std::memcpy(&b, &d, sizeof b);
        for (int k = 0; k < 8; ++k) { h ^= (b >> (8 * k)) & 0xff; h *= 1099511628211ULL; }
    }
    char s[24];
    std::snprintf(s, sizeof s, "%016llx", (unsigned long long)h);
    return s;
}
static std::string fnv_text(const std::string& t) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : t) { h ^= c; h *= 1099511628211ULL; }
    char s[24];
    std::snprintf(s, sizeof s, "%016llx", (unsigned long long)h);
    return s;
}

// Objects of the patch merged into the document member by member; any other value replaces the one there
static void merge(json::Value& dst, const json::Value& src) {
    if (src.is_object() && dst.is_object()) {
        for (const auto& kv : src.obj()) merge(dst[kv.first], kv.second);
    } else dst = src;
}

// Named operations on the parsed project (the Rust test has the same)
static void apply_op(Project& p, const std::string& op) {
    if (op == "cold") for (double& t : p.wx.tamb) t -= 30;
    if (op == "snow_hourly") {
        p.wx.snow.assign(HOURS, 0.0);
        p.wx.snow[40 * 24 + 10] = 3; p.wx.snow[41 * 24 + 11] = 0.5; p.wx.snow[330 * 24 + 8] = 2.5; p.wx.snow[8750] = 4;
    }
}

static json::Value pv_json(const PVProfile& prof) {   // as src/main.cpp
    auto months = [](const std::array<double, 12>& a) { return json::Value(std::vector<double>(a.begin(), a.end())); };
    json::Value losses = json::Value::array();
    for (const auto& l : prof.losses) losses.push(json::Value(json::Object{{"name", l.name}, {"value", l.value}, {"irradiance", l.irradiance}}));
    json::Value monthly(json::Object{{"ghi", months(prof.m_ghi)}, {"dhi", months(prof.m_dhi)}, {"tamb", months(prof.m_tamb)},
                                     {"poa", months(prof.m_poa)}, {"eff", months(prof.m_eff)}, {"earray", months(prof.m_dc)}, {"eavail", months(prof.m_avail)}});
    return json::Value(json::Object{{"specific_yield", prof.specific_yield}, {"performance_ratio", prof.performance_ratio},
                                    {"ghi_annual", prof.ghi_annual}, {"poa_annual", prof.poa_annual}, {"rear_annual", prof.rear_annual},
                                    {"losses", losses}, {"monthly", monthly},
                                    {"ac_per_kwp", json::Value(prof.ac_per_kwp)}, {"ghi", json::Value(prof.ghi_local)},
                                    {"poa", json::Value(prof.poa)}, {"tcell", json::Value(prof.tcell)},
                                    {"shade", prof.near_max.empty() ? json::Value() :
                                     json::Value(json::Object{{"tables", json::Value(prof.table_shade)}, {"near_max", json::Value(prof.near_max)},
                                                              {"near_median", json::Value(prof.near_median)}})}});
}

static std::string f9(double x) { char b[40]; std::snprintf(b, sizeof b, "%.9f", x); return b; }
// A ring of plan points (m east, north of the site at lat 7, lon -1) as lat/lon pairs on the layout tool's projection
static std::string ring(const std::vector<std::array<double, 2>>& pts) {
    const double lat = 7.0, lon = -1.0, ky = 110574.0, kx = 111320.0 * std::cos(lat * 3.14159265358979323846 / 180);
    std::string s = "[";
    for (size_t i = 0; i < pts.size(); ++i) s += (i ? ",[" : "[") + f9(lat + pts[i][1] / ky) + "," + f9(lon + pts[i][0] / kx) + "]";
    return s + "]";
}
static std::string rect(double x0, double y0, double x1, double y1) { return ring({{x0, y1}, {x1, y1}, {x1, y0}, {x0, y0}}); }
// Tables 20 m x 4.5 m in rows 9 m apart: corners from the upper (north) edge
static std::string tables(int rows, int cols, double x0, double y0) {
    std::string s = "[";
    for (int r = 0; r < rows; ++r)
        for (int c = 0; c < cols; ++c) {
            const double x = x0 + 24 * c, y = y0 + 9 * r;
            s += std::string(r || c ? "," : "") + ring({{x, y + 4.5}, {x + 20, y + 4.5}, {x + 20, y}, {x, y}});
        }
    return s + "]";
}

struct Case { std::string name, patch; std::vector<std::string> ops; bool detail = false; };

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: genpv example.json out.json\n"; return 2; }
    std::stringstream ss;
    ss << std::ifstream(argv[1], std::ios::binary).rdbuf();
    const std::string example = ss.str();
    auto project = [&](const Case& c) {
        json::Value doc = json::parse(example);   // parsed again for each case: values share their objects
        merge(doc, json::parse(c.patch));
        Project p = parse_project(doc);
        for (const auto& op : c.ops) apply_op(p, op);
        return p;
    };

    const std::string horizon36 = "[2,3,4,6,8,9,8,6,5,4,3,3,2,2,3,5,7,9,10,9,7,5,4,3,2,2,2,3,4,5,4,3,2,2,2,2]";
    const std::string area = "{\"type\":\"site\",\"latlngs\":" + rect(-60, -40, 60, 40) + "}";
    const std::string building = "{\"type\":\"obstacle\",\"latlngs\":" + rect(62, -30, 80, 10) + ",\"height\":15}";
    const std::string tree = "{\"type\":\"obstacle\",\"kind\":\"tree\",\"center\":[" + f9(7.0 - 48 / 110574.0) + "," +
                             f9(-1.0 + 5 / (111320.0 * std::cos(7.0 * 3.14159265358979323846 / 180))) + "],\"diameter\":8,\"height\":12}";
    const std::string tbl = tables(4, 4, -50, -35);
    std::vector<Case> cs = {
        {"example", "{}"},
        {"perez", R"({"pv":{"transposition":"perez"}})"},
        {"erbs ghi only", R"({"weather":{"dni":[],"dhi":[]}})"},
        {"disc ghi only", R"({"weather":{"dni":[],"dhi":[]},"pv":{"decomposition":"disc"}})"},
        {"boland ghi only perez", R"({"weather":{"dni":[],"dhi":[]},"pv":{"decomposition":"boland","transposition":"perez"}})"},
        {"rows blocks diffuse bifacial", R"({"pv":{"tilt":25,"gcr":0.6,"shade_model":"blocks","diffuse_shading":true,"transposition":"perez","bifaciality":0.7,"mount_height":1.2}})"},
        {"tracker backtracking", R"({"pv":{"mount":"tracker","gcr":0.35,"row_width":2.4}})"},
        {"tracker row shading blocks", R"({"pv":{"mount":"tracker","gcr":0.45,"row_width":2.4,"backtracking":false,"shade_model":"blocks","bypass_blocks":3}})"},
        {"tracker slope", R"({"pv":{"mount":"tracker","gcr":0.4,"tracker_axis_tilt":4,"tracker_cross_slope":6}})"},
        {"tracker slope no backtracking", R"({"pv":{"mount":"tracker","gcr":0.4,"tracker_cross_slope":6,"backtracking":false}})"},
        {"tracker tilted axis", R"({"pv":{"mount":"tracker","tracker_axis_azimuth":30,"tracker_axis_tilt":10,"tracker_max_angle":50}})"},
        {"tracker bifacial physical iam", R"({"pv":{"mount":"tracker","gcr":0.35,"row_width":2.4,"mount_height":2,"bifaciality":0.7,"transposition":"perez","iam_model":"physical","iam_n_ar":1.29,"diffuse_shading":true}})"},
        {"martin ruiz iam", R"({"pv":{"iam_model":"martin_ruiz","bifaciality":0.6}})"},
        {"spectral haurwitz", R"({"pv":{"spectral":"monosi"}})"},
        {"spectral ineichen from data", R"({"pv":{"spectral":"cdte","clearsky":"ineichen"}})"},
        {"spectral ineichen typed", R"({"pv":{"spectral":"asi","clearsky":"ineichen","linke_turbidity":3.5}})"},
        {"noct", R"({"pv":{"thermal_model":"noct","noct":46}})"},
        {"uc uv wind", R"({"pv":{"uv":6,"uc":25}})"},
        {"snow monthly", R"({"pv":{"modules_up":1,"snow_monthly":[30,25,10,0,0,0,0,0,0,0,5,20],"snow_events":[5,4,2,0,0,0,0,0,0,0,1,3]}})", {"cold"}},
        {"snow hourly", R"({"pv":{"modules_up":3}})", {"cold", "snow_hourly"}},
        {"snow monthly tracker", R"({"pv":{"mount":"tracker","snow_monthly":[30,25,10,0,0,0,0,0,0,0,5,20],"snow_events":[5,4,2,0,0,0,0,0,0,0,1,3]}})", {"cold"}},
        {"horizon auto", "{\"pv\":{\"horizon\":" + horizon36 + "}}"},
        {"horizon apply bifacial", "{\"pv\":{\"horizon\":" + horizon36 + ",\"horizon_beam\":\"apply\",\"bifaciality\":0.5,\"transposition\":\"perez\"}}"},
        {"horizon data", "{\"pv\":{\"horizon\":" + horizon36 + ",\"horizon_beam\":\"data\"}}"},
        {"inverter curve", R"({"pv":{"inverter_model":"curve","inverter_eff_max":0.99,"dc_ac_ratio":1.3}})"},
        {"dc wiring stc", R"({"pv":{"dc_wiring_basis":"stc","low_irr_loss_200":0.04,"lid":0.02,"module_quality":-0.005}})"},
        {"monthly albedo soiling", R"({"pv":{"albedo_monthly":[0.2,0.21,0.22,0.25,0.3,0.3,0.28,0.26,0.24,0.22,0.2,0.2],"soiling_monthly":[0.03,0.03,0.02,0.01,0.01,0.01,0.01,0.01,0.02,0.02,0.03,0.04],"bifaciality":0.65}})"},
        {"utc offset 5.75", R"({"location":{"utc_offset":5.75}})"},
        {"local time weather", R"({"location":{"utc_offset":1},"weather":{"is_utc":false}})"},
        {"near objects tables horizon", "{\"pv\":{\"horizon\":" + horizon36 + ",\"horizon_beam\":\"apply\"},\"layout\":{\"polygons\":[" + area + "," +
                                            building + "," + tree + "],\"result\":{\"tables\":" + tbl + "}}}", {}, true},
        {"near objects no tables", "{\"layout\":{\"polygons\":[" + area + "," + building + "," + tree + "]}}", {}, true},
        {"east west tables", "{\"pv\":{\"dc_ac_ratio\":1.3},\"layout\":{\"polygons\":[{\"type\":\"site\",\"latlngs\":" + rect(-60, -40, 60, 40) +
                                 ",\"azimuth\":90,\"east_west\":true}],\"result\":{\"tables\":" + tbl + "}}}"},
        {"own tilt and canopy areas with objects", "{\"pv\":{\"bifaciality\":0.7,\"diffuse_shading\":true,\"transposition\":\"perez\",\"gcr\":0.5},"
                                                   "\"layout\":{\"polygons\":[{\"type\":\"site\",\"latlngs\":" + rect(-60, -40, 0, 40) + ",\"tilt\":25,\"azimuth\":180,\"base\":4},"
                                                   "{\"type\":\"site\",\"latlngs\":" + rect(0, -40, 60, 40) + ",\"canopy\":true}," + building + "," + tree + "]}}", {}, true},
        {"tracker with objects", "{\"pv\":{\"mount\":\"tracker\",\"gcr\":0.35,\"row_width\":2.4},\"layout\":{\"polygons\":[" + area + "," + building +
                                     "],\"result\":{\"tables\":" + tbl + "}}}", {}, true},
    };

    json::Array out;
    for (const Case& c : cs) {
        const Project p = project(c);
        json::Object o{{"name", c.name}, {"patch", c.patch}, {"detail", c.detail}};
        json::Array ops;
        for (const auto& op : c.ops) ops.push_back(op);
        o["ops"] = json::Value(ops);
        try {
            const PVProfile prof = c.detail ? compute_pv_profile(p, array_groups(p), true) : compute_pv_profile(p);
            json::Array losses;
            for (const auto& l : prof.losses) losses.push_back(json::Value(json::Array{l.name, l.value}));
            std::vector<double> months;
            for (const auto* m : {&prof.m_ghi, &prof.m_dhi, &prof.m_tamb, &prof.m_poa, &prof.m_eff, &prof.m_dc, &prof.m_avail}) months.insert(months.end(), m->begin(), m->end());
            o["losses"] = json::Value(losses);
            o["specific_yield"] = prof.specific_yield;
            o["ac"] = fnv(prof.ac_per_kwp);
            o["poa"] = fnv(prof.poa);
            o["tcell"] = fnv(prof.tcell);
            o["ghi"] = fnv(prof.ghi_local);
            o["monthly"] = fnv(months);
            o["shade"] = fnv(prof.table_shade) + fnv(prof.near_max) + fnv(prof.near_median);
            o["json"] = fnv_text(pv_json(prof).dump());
        } catch (const std::exception& e) { o["error"] = std::string(e.what()); }
        out.push_back(json::Value(o));
    }

    // The smaller functions
    json::Object fn;
    const Project ex = project({"", "{}"});
    {
        std::vector<double> v;
        for (double eta : {0.97, 0.983}) for (double mx : {0.985, 0.99}) { const auto k = inverter_curve(eta, mx); v.insert(v.end(), k.begin(), k.end()); }
        fn["inverter_curve"] = fnv(v);
    }
    {
        std::vector<double> v;
        PVParams pv;
        for (const char* m : {"ashrae", "martin_ruiz", "physical"})
            for (double nar : {0.0, 1.29}) {
                pv.iam_model = m; pv.iam_n_ar = nar;
                for (double t : {0.0, 10.0, 35.0, 90.0, 145.0, 180.0}) { const auto d = diffuse_iam(pv, t); v.insert(v.end(), d.begin(), d.end()); }
                for (double c : {1.0, 0.8, 0.3, 0.05, 1e-6}) v.push_back(incidence_modifier(pv, c));
            }
        fn["iam"] = fnv(v);
    }
    {
        std::vector<double> v;
        for (double tilt : {0.0, 12.0, 30.0, 55.0})
            for (double gcr : {0.3, 0.5, 0.8}) {
                const RowView r = row_view(tilt, gcr);
                v.insert(v.end(), {r.front_sky, r.front_ground, r.back_sky, r.back_ground});
                const GroundView g = ground_view(tilt, gcr, 0.5);
                v.insert(v.end(), g.sky.begin(), g.sky.end());
                v.insert(v.end(), g.front.begin(), g.front.end());
                v.insert(v.end(), g.back.begin(), g.back.end());
                for (double tp : {-2.0, -0.3, 0.0, 0.7, 3.0}) { const auto rr = g.reflected(tp, 600, 120); v.insert(v.end(), rr.begin(), rr.end()); }
            }
        fn["rows"] = fnv(v);
    }
    {
        std::vector<double> v, h(36);
        for (int k = 0; k < 36; ++k) h[k] = 5 + 4 * std::sin(k * 0.7);
        for (double t : {0.0, 20.0, 90.0, 160.0}) for (double a : {0.0, 90.0, 180.0, 333.0}) { const auto x = horizon_view(h, t, a); v.insert(v.end(), x.begin(), x.end()); }
        for (double a : {-725.0, 0.0, 3.3, 359.9, 1000.0}) v.push_back(horizon_at(h, a));
        fn["horizon"] = fnv(v);
    }
    {
        Obstacle wall;
        wall.height = 10;
        wall.pts = {{-10, -10}, {10, -10}, {10, -11}, {-10, -11}};
        Obstacle tower;
        tower.height = 20;
        for (int k = 0; k < 16; ++k) tower.pts.push_back({30 + 6 * std::sin(k * 0.3927), 25 + 6 * std::cos(k * 0.3927)});
        std::vector<double> v;
        for (auto xyz : {std::array<double, 3>{0, 0, 0}, {0, -10.5, 0}, {0, 0, 11}, {5, 3, 1.5}, {-40, 60, 0.5}}) {
            const auto h = near_horizon(xyz[0], xyz[1], xyz[2], {wall, tower});
            for (float x : h) v.push_back(x);
        }
        const NearShading ns({{0, 0, 0, -1}, {0, 100, 0, -1}, {20, 20, 2, -1}}, {wall, tower}, std::vector<double>(36, 4.0));
        for (double az : {0.0, 45.0, 180.0, 200.0}) for (double el : {3.0, 10.0, 30.0, 50.0}) v.push_back(ns.shaded(az, el));
        v.insert(v.end(), ns.sky().sky.begin(), ns.sky().sky.end());
        v.insert(v.end(), ns.sky().band.begin(), ns.sky().band.end());
        fn["near"] = fnv(v);
    }
    {
        Project q = ex;
        q.pv.clearsky = "ineichen";
        fn["clearsky_ghi_ineichen"] = fnv(clearsky_ghi(q));
        fn["clearsky_ghi_haurwitz"] = fnv(clearsky_ghi(ex));
        fn["clearsky_pv_ineichen"] = fnv(clearsky_pv_per_kwp(q));
        fn["clearsky_pv_haurwitz"] = fnv(clearsky_pv_per_kwp(ex));
        std::vector<double> v;
        for (auto [t, y] : tilt_scan(ex, 0, 45, 7.5)) v.insert(v.end(), {t, y});
        fn["tilt_scan"] = fnv(v);
        Project w = ex;
        w.wind.units = 2;
        std::vector<double> wv = wind_per_turbine(w);
        w.wind.curve = "linear"; w.loc.utc_offset = 2.5;
        const std::vector<double> wl = wind_per_turbine(w);
        wv.insert(wv.end(), wl.begin(), wl.end());
        fn["wind"] = fnv(wv);
    }
    {
        // The comparable profile and the kept share of pv_reference (src/main.cpp) before its fetch
        std::vector<double> v;
        for (const char* mount : {"fixed", "tracker"}) {
            Project q = ex;
            q.pv.mount = mount;
            q.pv.soiling_monthly.assign(12, 0.015);
            Project r = q;
            r.layout = SiteLayout{};
            r.pv.row_shading = false; r.pv.backtracking = false; r.pv.tracker_max_angle = 90; r.pv.dc_ac_ratio = 0.1; r.pv.bifaciality = 0;
            r.pv.inverter_model = "constant";
            const PVProfile c = compute_pv_profile(r);
            auto step = [&](const std::string& name) { for (const auto& l : c.losses) if (l.name == name) return l.value; return 0.0; };
            const double t = step("After temperature loss"), iam = step("After IAM (reflection)");
            const double dc = t > 0 ? step("After mismatch, wiring, LID, quality") / t : 1.0;
            const double soil = q.pv.soiling_monthly.size() == 12 && iam > 0 ? step("Effective irradiation (after soiling)") / iam : 1 - q.pv.soiling;
            v.push_back(soil * dc * q.pv.inverter_eff * (1 - q.pv.ac_losses) * q.pv.availability);
            v.push_back(c.specific_yield);
        }
        fn["reference"] = fnv(v);
    }
    std::ofstream(argv[2], std::ios::binary) << json::Value(json::Object{{"cases", json::Value(out)}, {"functions", json::Value(fn)}}).dump();
    std::cout << cs.size() << " cases\n";
}
