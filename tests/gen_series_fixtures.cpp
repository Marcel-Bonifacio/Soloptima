// Writes engine/tests/fixtures/import.json from the C++ engine: for each import scenario (the files of the "import" cases of
// test_engine.cpp), a hash of its text, and what import_series answers (an error message, or a hash of the result and
// its report). The Rust tests build the same files and compare.
//   c++ -std=c++17 -O1 -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/gens tests/gen_series_fixtures.cpp src/series.cpp src/model.cpp \
//       src/weather.cpp src/pv.cpp src/platform.cpp src/shading.cpp -lcurl
//   /tmp/gens engine/tests/fixtures/import.json
#include "json.hpp"
#include "series.hpp"
#include <cstdint>
#include "weather.hpp"
#include <cmath>
#include <fstream>
#include <iostream>

static std::string stamp(long long t, char style) {
    int y;
    unsigned m, d;
    civil_from_days(long(t / 1440), y, m, d);
    const int hh = int(t % 1440 / 60), mm = int(t % 60);
    char b[40];
    if (style == 'i') std::snprintf(b, sizeof b, "%04d-%02u-%02uT%02d:%02dZ", y, m, d, hh, mm);
    else if (style == 'w') std::snprintf(b, sizeof b, "%04d-%02u-%02u %02d:%02d", y, m, d, hh, mm);
    else std::snprintf(b, sizeof b, "%02u/%02u/%04d %02d:%02d", d, m, y, hh, mm);
    return b;
}
// FNV-1a, 64 bit, as 16 hex digits (the Rust tests compute the same)
static std::string sha(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}
struct Case { std::string name, text, opt; };
static double v15(int k) { return 500.0 + (k * 37 % 101) + 0.25 * (k % 4); }

int main(int, char** argv) {
    const int HOURS = 8760;
    const long long t25 = days_from_civil(2025, 1, 1) * 1440LL;
    std::vector<Case> cases;
    std::string q = "time,load_kw,flag\n";
    for (int k = 0; k < 35040; ++k)
        if (k / 4 != 1000) q += stamp(t25 + 15LL * k, 'i') + "," + std::to_string(v15(k)) + ",1\n";
    cases.push_back({"15 min utc", q, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kw","utc_offset":0})"});
    cases.push_back({"15 min kwh", q, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kwh_interval","utc_offset":0})"});
    cases.push_back({"15 min utc+8", q, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"kw","utc_offset":8})"});
    cases.push_back({"15 min w", q, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"utc","label":"start","units":"w","utc_offset":0})"});
    cases.push_back({"15 min fill_long", q, R"({"kind":"load","time_col":0,"cols":[1,2],"time_basis":"utc","label":"instant","units":"kw","utc_offset":0,"fill_long":true})"});
    std::string e = "Timestamp;Load (kW)\n";
    for (int k = 0; k < HOURS; ++k) e += stamp(t25 + 60LL * (k + 1), 'w') + ";" + std::to_string(1000 + k) + ",5\n";
    cases.push_back({"end stamps", e, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"auto","units":"kw","utc_offset":8})"});
    std::string d = "time,kw\n", dm = "date,kw\n";
    for (int k = 0; k < HOURS; ++k) {
        d += stamp(t25 + 60LL * k, 'w') + "," + std::to_string(2000 + k) + "\n";
        dm += stamp(t25 + 60LL * k, 'd') + "," + std::to_string(2000 + k) + "\n";
    }
    d += stamp(t25 + 60LL * 500, 'w') + ",2510\n";
    const std::string hourly = R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","units":"kw","utc_offset":8})";
    cases.push_back({"duplicate", d, hourly});
    std::string ng = d;
    ng.replace(ng.find(",2000\n"), 6, ",-5\n");
    cases.push_back({"negative", ng, hourly});
    cases.push_back({"dmy", dm, hourly});
    cases.push_back({"dmy ambiguous", dm.substr(0, dm.find("13/01/2025")), hourly});
    std::string xs = "serial,kw\n";
    for (int k = 0; k < HOURS; ++k) { char b2[64]; std::snprintf(b2, sizeof b2, "%.8f,%d\n", 45658 + k / 24.0, 2000 + k); xs += b2; }
    cases.push_back({"excel", xs, hourly});
    std::string two = "time,kw\n";
    const long long t24 = days_from_civil(2024, 1, 1) * 1440LL;
    for (int k = 0; k < (366 + 365) * 24; ++k) two += stamp(t24 + 60LL * k, 'w') + "," + std::to_string(k / 24) + "\n";
    cases.push_back({"year 2024", two, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":2024,"utc_offset":0})"});
    cases.push_back({"year auto", two, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","utc_offset":0})"});
    cases.push_back({"year 2030", two, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":2030,"utc_offset":0})"});
    const std::string l12 = R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","year":"last12","utc_offset":0})";
    cases.push_back({"last12 two years", two, l12});
    auto last12 = [&](const char* name, int y, int m, int dd, int y1, int m1, int d1) {
        const long long a = days_from_civil(y, unsigned(m), unsigned(dd)), b = days_from_civil(y1, unsigned(m1), unsigned(d1));
        std::string f = "time,kw\n";
        for (long long k = 0; k < (b - a + 1) * 24; ++k) f += stamp(a * 1440 + 60 * k, 'w') + "," + std::to_string(k / 24) + "\n";
        cases.push_back({name, f, l12});
    };
    last12("last12 jul-jun", 2023, 7, 1, 2024, 6, 30);
    last12("last12 mar-feb leap", 2023, 3, 1, 2024, 2, 29);
    last12("last12 2022-23", 2022, 7, 1, 2023, 6, 30);
    auto wx_file = [&](int from, int to) {
        std::string w = "time,ghi,temp\n";
        for (int k = 0; k < HOURS; ++k)
            if (k < from || k >= to) w += stamp(t25 + 60LL * k, 'i') + "," + std::to_string(std::max(0.0, 900 * std::sin((k % 24 - 6) / 12.0 * 3.14159))) + ",27\n";
        return w;
    };
    const std::string wopt = R"({"kind":"weather","time_col":0,"ghi":1,"tamb":2,"time_basis":"utc","label":"start","utc_offset":8})";
    cases.push_back({"weather gap 5", wx_file(4000, 4005), wopt});
    cases.push_back({"weather gap 80", wx_file(2000, 2080), wopt});
    cases.push_back({"weather gap 2 at start", wx_file(0, 2), wopt});
    cases.push_back({"weather metadata", "Latitude (decimal degrees):\t45.000\nElevation (m):\t250\n\n\nSlope: 0 deg. \n" + wx_file(0, 0), wopt});
    cases.push_back({"weather kelvin km/h", wx_file(0, 0), R"({"kind":"weather","time_col":0,"ghi":1,"tamb":2,"wind":2,"temp_units":"k","wind_units":"km_h","irr_units":"wh_m2_interval","time_basis":"local_standard","label":"end","utc_offset":-5})"});
    cases.push_back({"weather no ghi", "time,x\n2025-01-01 00:00,1\n2025-01-01 01:00,2\n", wopt});
    std::string lt = "Logger export; site A\n";
    for (int k = 0; k < HOURS; ++k) lt += stamp(t25 + 60LL * k, 'w') + "," + std::to_string(2000 + k) + "\n";
    cases.push_back({"title line", lt, hourly});
    std::string pos = "load\n";
    for (int k = 0; k < 35040; ++k) pos += std::to_string(v15(k)) + "\n";
    const std::string popt = R"({"kind":"load","time_col":-1,"cols":[0],"time_basis":"local_standard","units":"kw","utc_offset":8})";
    cases.push_back({"positional", pos, popt});
    std::string pbad = pos;
    pbad.replace(pbad.find('\n', pbad.find('\n', pbad.find('\n') + 1) + 1) + 1, 3, "n/a");
    cases.push_back({"positional bad", pbad, popt});
    cases.push_back({"positional short", "load\n1\n2\n3\n", popt});
    std::string wpos = "ghi,temp\n";
    for (int k = 0; k < HOURS; ++k) wpos += (k == 100 ? std::string("") : std::to_string(k % 24 > 6 && k % 24 < 18 ? 600.0 : 0.0)) + ",20\n";
    cases.push_back({"positional weather", wpos, R"({"kind":"weather","time_col":-1,"ghi":0,"tamb":1,"time_basis":"utc","utc_offset":3})"});
    std::string cl = "time,kw\n";
    const long long dst_on = days_from_civil(2025, 3, 30) * 1440LL + 60, dst_off = days_from_civil(2025, 10, 26) * 1440LL + 60;
    for (int k = 0; k < HOURS; ++k) {
        const long long u = t25 - 60 + 60LL * k;
        cl += stamp(u + (u >= dst_on && u < dst_off ? 120 : 60), 'w') + "," + std::to_string(k) + "\n";
    }
    cases.push_back({"clock dst", cl, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_clock","label":"start","utc_offset":1,"clock":{"start":1,"changes":[[)" +
                     std::to_string(dst_on) + ",2],[" + std::to_string(dst_off) + ",1]]}}"});
    cases.push_back({"clock as standard", cl, R"({"kind":"load","time_col":0,"cols":[1],"time_basis":"local_standard","label":"start","utc_offset":1})"});
    // formats of single stamps
    auto fmt = [&](const char* name, const std::string& ts, const char* basis) {
        cases.push_back({name, ts, std::string(R"({"kind":"load","time_col":0,"cols":[1],"time_basis":")") + basis + R"(","label":"start","utc_offset":2})"});
    };
    auto stamps = [&](const char* style) {
        std::string f = "t,kw\n";
        for (int k = 0; k < 24 * 40; ++k) {
            const long long t = t25 + 60LL * k;
            int y; unsigned m, dd;
            civil_from_days(long(t / 1440), y, m, dd);
            const int hh = int(t % 1440 / 60);
            char b[64];
            const std::string s = style;
            if (s == "us12") std::snprintf(b, sizeof b, "%u/%u/%04d %d:00 %s", m, dd, y, hh % 12 == 0 ? 12 : hh % 12, hh < 12 ? "AM" : "PM");
            else if (s == "pvgis") std::snprintf(b, sizeof b, "%04d%02u%02u:%02d10", y, m, dd, hh);
            else if (s == "tz") std::snprintf(b, sizeof b, "%04d-%02u-%02uT%02d:00:00+08:00", y, m, dd, hh);
            else if (s == "dots") std::snprintf(b, sizeof b, "%02u.%02u.%04d %02d:00:00", dd, m, y, hh);
            else if (s == "short") std::snprintf(b, sizeof b, "%u/%u/%02d %d:00", m, dd, y % 100, hh);
            f += std::string(b) + "," + std::to_string(k % 50) + "\n";
        }
        return f;
    };
    for (const char* s : {"us12", "pvgis", "tz", "dots", "short"}) fmt((std::string("stamp ") + s).c_str(), stamps(s), "local_standard");
    // two columns for date and time
    std::string two_col = "date,time,kw\n";
    for (int k = 0; k < 24 * 40; ++k) { const std::string w = stamp(t25 + 60LL * k, 'w'); two_col += w.substr(0, 10) + "," + w.substr(11) + "," + std::to_string(k % 17) + "\n"; }
    cases.push_back({"date and time columns", two_col, R"({"kind":"load","time_col":0,"time2_col":1,"cols":[2],"time_basis":"utc","label":"start"})"});
    // bad options
    cases.push_back({"no options", "a\n1\n", "[]"});
    cases.push_back({"unknown unit", hourly, R"({"kind":"load","time_col":0,"cols":[1],"units":"gw"})"});
    cases.push_back({"no cols", hourly, R"({"kind":"load","time_col":0,"cols":[]})"});
    cases.push_back({"same col", hourly, R"({"kind":"load","time_col":1,"cols":[1]})"});
    cases.push_back({"empty file", "  \n\n", hourly});
    cases.push_back({"offset 20", hourly, R"({"kind":"load","time_col":0,"cols":[1],"utc_offset":20})"});
    cases.push_back({"load last12 weather", wx_file(0, 0), R"({"kind":"weather","time_col":0,"ghi":1,"year":"last12"})"});
    cases.push_back({"unreadable times", "t,kw\nfoo,1\nbar,2\n", hourly});

    json::Array out;
    for (const Case& c : cases) {
        json::Object o{{"name", c.name}, {"text", sha(c.text)}};
        try {
            json::Value r = import_series(c.text, json::parse(c.opt));
            o["status"] = "OK";
            o["hash"] = sha(r.dump());
            o["report"] = r["report"].dump();
        } catch (const std::exception& ex) { o["status"] = std::string("ERR ") + ex.what(); }
        out.push_back(std::move(o));
    }
    std::ofstream(argv[1], std::ios::binary) << json::Value(out).dump();
    std::cout << cases.size() << " cases\n";
}
