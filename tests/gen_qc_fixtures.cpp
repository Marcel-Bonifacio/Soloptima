// Writes engine/tests/fixtures/qc.json from the C++ engine: data_qc of the scenarios below (the projects of the data-check cases
// of test_engine.cpp and some with defects), as the dump of what it answers. The Rust tests build the same projects.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genq tests/gen_qc_fixtures.cpp src/series.cpp \
//       src/model.cpp src/weather.cpp src/pv.cpp src/platform.cpp src/shading.cpp -lcurl
//   /tmp/genq engine/tests/fixtures/qc.json
#include "json.hpp"
#include "pv.hpp"
#include "series.hpp"
#include <cmath>
#include <fstream>
#include <iostream>

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
    return p;
}
static Project clear_project(double lat, double lon) { Project t = make_project(lat, lon); t.wx.ghi = clearsky_ghi(t); return t; }
static Project step_load() {
    Project l = make_project(-2.5, 115.5);
    for (int i = 0; i < HOURS; ++i) l.load_kw[i] *= (1 + 0.02 * std::sin(i * 0.7) * std::sin(i * 0.13)) * (i >= 200 * 24 ? 1.2 : 1.0);
    return l;
}
struct Case { std::string name, only; Project p; };

int main(int, char** argv) {
    std::vector<Case> cs;
    Project t = clear_project(-2.5, 115.5);
    cs.push_back({"on time", "weather", t});
    Project late = t, local = t;
    for (int i = 0; i < HOURS; ++i) late.wx.ghi[i] = t.wx.ghi[(i + HOURS - 1) % HOURS];
    local.wx.is_utc = false;
    cs.push_back({"one hour late", "weather", late});
    cs.push_back({"utc as local", "weather", local});
    Project n = t;
    const int mid = 100 * 24 - int(t.loc.utc_offset);
    n.wx.ghi[size_t(mid)] = 50;
    for (int h = 9; h < 15; ++h) n.wx.ghi[size_t(150 * 24 + h - int(t.loc.utc_offset))] = 500;
    cs.push_back({"night and flat", "weather", n});
    cs.push_back({"load step", "load", step_load()});
    Project w = step_load();
    for (auto& x : w.load_kw) x *= 1000;
    cs.push_back({"load in watts", "", w});
    Project k = step_load();
    for (auto& x : k.load_kw) x *= 0.1;
    cs.push_back({"load tiny", "load", k});
    Project d = clear_project(-2.5, 115.5);
    d.wx.dhi.resize(HOURS); d.wx.dni.resize(HOURS);
    for (int i = 0; i < HOURS; ++i) { d.wx.dhi[i] = 0.3 * d.wx.ghi[i]; d.wx.dni[i] = 0.7 * d.wx.ghi[i] * (i % 7 == 0 ? 1.6 : 1.0); }
    d.wx.dhi[1000] = d.wx.ghi[1000] * 2 + 80;
    d.wx.ghi[3000] = 5000;
    for (int i = 0; i < HOURS; ++i) d.wx.tamb[i] = 27 + 5 * std::sin((i % 24) / 24.0 * 6.283) + 0.01 * (i % 13);
    d.wx.tamb[500] = 80; d.wx.tamb[600] = d.wx.tamb[599] + 15;
    for (int i = 1000; i < 1007; ++i) d.wx.tamb[i] = 30;
    for (int dd = 50; dd < 53; ++dd) d.wx.tamb[dd * 24 + 10] = 31.5;
    for (int i = 0; i < HOURS; ++i) d.wx.wind[i] = 3 + 2 * std::sin(i * 0.3);
    d.wx.wind[700] = -1; d.wx.wind[800] = 50;
    for (int i = 2000; i < 2008; ++i) d.wx.wind[i] = 4.0;
    for (int i = 4000; i < 4010; ++i) d.wx.ghi[i] = d.wx.ghi[4000];
    cs.push_back({"weather defects", "weather", d});
    Project e = step_load();
    for (int i = 100; i < 104; ++i) e.load_kw[i] = 0;
    for (int i = 300; i < 310; ++i) e.load_kw[i] = 1234;
    for (int i = 500; i < 510; ++i) e.load_kw[i] = 900 + 7.5 * (i - 500);
    e.load_kw[2000] = 5000;
    cs.push_back({"load defects", "load", e});
    Project nd = t; nd.wx.ghi.clear(); nd.load_kw.clear();
    cs.push_back({"no data", "", nd});
    Project np = clear_project(27.7, 85.3);
    np.loc.utc_offset = 5.75;
    cs.push_back({"nepal utc+5:45", "weather", np});
    Project zh = clear_project(47.0, 8.0);
    cs.push_back({"switzerland", "weather", zh});
    Project loc = clear_project(-33.9, 151.2);
    loc.wx.is_utc = false; loc.loc.utc_offset = 10;
    cs.push_back({"sydney local", "weather", loc});
    Project bad = t; bad.loc.lat = 95;
    cs.push_back({"bad latitude", "", bad});
    Project bo = t; bo.loc.utc_offset = 15;
    cs.push_back({"bad offset", "", bo});
    Project bt = t; bt.wx.time_offset = 30;
    cs.push_back({"bad time offset", "", bt});

    json::Array out;
    for (const Case& c : cs) {
        json::Object o{{"name", c.name}};
        try { o["result"] = "OK " + data_qc(c.p, c.only).dump(); } catch (const std::exception& ex) { o["result"] = std::string("ERR ") + ex.what(); }
        out.push_back(std::move(o));
    }
    std::ofstream(argv[1], std::ios::binary) << json::Value(out).dump();
    std::cout << cs.size() << " cases\n";
}
