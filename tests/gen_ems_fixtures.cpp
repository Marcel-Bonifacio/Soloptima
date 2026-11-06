// Writes engine/tests/fixtures/ems.json from the C++ engine: day-ahead schedules of the example project on synthetic forecast
// documents (with and without a current time, a maximum number of hours, across 29 February, with wind turbines, split
// irradiance, a half-hour UTC offset, and the errors), and the Forecast Lab benchmark with and without the value runs. Each
// case keeps its inputs (a patch merged into the example project, the forecast document as parsed back from its text) and the
// hash of the answer as JSON, or the error message, plus a readable part of the answer.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/gene tests/gen_ems_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl -framework Security -framework CoreFoundation
//   /tmp/gene web/examples/example_study.json engine/tests/fixtures/ems.json
#include "ems.hpp"
#include "json.hpp"
#include "model.hpp"
#include "weather.hpp"
#include <cmath>
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

static Sizing sizing_of(const Project& p) { return Sizing{p.pv.capacity_kwp, p.bess.energy_kwh, p.bess.power_kw, double(p.wind.units)}; }

// The checks of the /api/ems/schedule route (src/main.cpp) before it calls day_ahead_schedule
static json::Value schedule(const Project& p, const json::Value& f, double soc, double scale, const std::string& now, int max_h) {
    if (p.load_kw.size() != HOURS) throw std::runtime_error("Define the load profile first.");
    if (!(p.dg.unit_kw > 0 && std::isfinite(p.dg.unit_kw)) || p.dg.units < 0)
        throw std::runtime_error("Genset unit rating must be above 0 kW and the number of units non-negative.");
    if (!(p.bess.reserve_duration_h > 0)) throw std::runtime_error("Battery reserve duration must be above 0 h.");
    if (p.wind.units > 0 && !(p.wind.v_in < p.wind.v_rated && p.wind.v_rated < p.wind.v_out))
        throw std::runtime_error("Wind turbine speeds must satisfy cut-in < rated < cut-out.");
    return day_ahead_schedule(p, sizing_of(p), f, soc, scale, now, max_h);
}

// `hours` hourly rows from `start` (UTC); a clear-sky-like day with a cloudy 29 February, a sunrise near 06:00 UTC (the
// example is at 1 degree west), varying temperature and wind. null_at, wind_null_at: a row whose irradiance or wind is null;
// some temperatures are null.
struct Fc {
    const char* start; int hours; double toff; int null_at = -1; bool split = false; bool wind = true; bool tamb = true; int wind_null_at = -1;
};
static json::Value forecast(const Fc& c) {
    json::Value f = json::Value::object(), t = json::Value::array(), g = json::Value::array(), ta = json::Value::array(),
                w = json::Value::array(), dh = json::Value::array(), dn = json::Value::array();
    for (int h = 0; h < c.hours; ++h) {
        const long e = iso_to_epoch_h(c.start) + h;
        const int hh = int(e % 24);
        const double day = epoch_h_to_iso(e).compare(0, 10, "2028-02-29") == 0 ? 0.3 : 1.0;
        const double ghi = day * std::max(0.0, 980 * std::sin(3.14159 * (hh - 5.7) / 12.6)) - (hh == 3 ? 1.5 : 0);   // one slightly negative value
        t.push(epoch_h_to_iso(e));
        g.push(h == c.null_at ? json::Value() : json::Value(ghi));
        ta.push(h % 17 == 5 ? json::Value() : json::Value(24.5 + 0.37 * (hh % 9) + 0.01 * h));
        w.push(h == c.wind_null_at ? json::Value() : json::Value(3.0 + 7.0 * std::fabs(std::sin(0.23 * h))));
        dh.push(std::max(0.0, ghi) * (0.25 + 0.5 * (1 - day)));
        dn.push(std::max(0.0, ghi) * 0.8 * day);
    }
    f["time_offset"] = c.toff; f["times"] = t; f["ghi"] = g;
    if (c.tamb) f["tamb"] = ta;
    if (c.wind) f["wind"] = w;
    if (c.split) { f["dhi"] = dh; f["dni"] = dn; }
    f["provider"] = c.toff < 0 ? "open_meteo" : "met_norway";
    f["model_updated_utc"] = "2028-02-27T21:00:00Z";
    return f;
}

struct Case { const char* name; const char* patch; json::Value fc; double soc, scale; const char* now; int max_h; };

int main(int argc, char** argv) {
    if (argc < 3) { std::cerr << "usage: gene example.json out.json\n"; return 1; }
    std::ifstream in(argv[1]);
    std::stringstream ss;
    ss << in.rdbuf();
    const std::string example = ss.str();
    auto project = [&](const char* patch) {
        json::Value doc = json::parse(example);   // a fresh document: Value copies share their objects
        merge(doc, json::parse(patch));
        return parse_project(doc);
    };
    auto with = [](const json::Value& f0, const char* k, json::Value v) { json::Value f = json::parse(f0.dump()); f[k] = v; return f; };

    const json::Value om = forecast({"2028-02-28T00:00", 72, -0.5});           // Open-Meteo: stamps the end of the hour
    const json::Value mn = forecast({"2028-02-28T00:00", 72, 0.5});            // MET Norway: the start
    json::Value gap = forecast({"2027-02-27T00:00", 48, -0.5});
    gap["times"].arr_mut()[10] = "2027-02-27T11:00";
    json::Value badt = forecast({"2027-02-27T00:00", 48, -0.5});
    badt["times"].arr_mut()[3] = "2027-02-27T03:00+01:00 and a long tail to clip at forty";
    json::Value short_ghi = forecast({"2028-02-28T00:00", 30, -0.5});
    short_ghi["ghi"].arr_mut().resize(20);   // the irradiance ends before the times do
    const std::vector<Case> cases = {
        {"open-meteo from 05:20 across 29 February", "{}", om, 0.5, 1.0, "2028-02-28T05:20", 0},
        {"met norway from 05:20, 24 h", "{}", mn, 0.5, 1.0, "2028-02-28T05:20", 24},
        {"issued_utc stands in for now", "{}", with(with(om, "issued_utc", "2028-02-28T05:20:11Z"), "note", "Forecast note."), 0.5, 1.0, "", 0},
        {"no current time keeps every hour", "{}", forecast({"2027-02-27T00:00", 48, -0.5}), 0.5, 1.0, "", 0},
        {"null irradiance ends the plan", "{}", forecast({"2028-02-28T00:00", 72, -0.5, 58}), 0.5, 1.0, "2028-02-28T05:20", 0},
        {"irradiance shorter than the times", "{}", short_ghi, 0.5, 1.0, "", 0},
        {"wind turbines", R"({"wind":{"units":2,"rated_kw":2000,"ref_height":50}})", om, 0.5, 1.0, "2028-02-28T05:20", 48},
        {"wind turbines with a null wind", R"({"wind":{"units":2,"rated_kw":2000}})", forecast({"2028-02-28T00:00", 72, 0.5, -1, false, true, true, 9}), 0.5, 1.0, "2028-02-28T03:00", 0},
        {"split irradiance", "{}", forecast({"2028-02-28T00:00", 72, -0.5, -1, true}), 0.5, 1.0, "2028-02-28T05:20", 36},
        {"half-hour offset +5.5 h with auxiliaries", R"({"location":{"utc_offset":5.5},"aux":{"bess_kw_per_mwh":3,"bess_temp_coeff":0.03,"plant_kw":40,"trafo_noload_kw":12,"bess_trafo_noload_kw":5,"pcs_kw_per_mw":2}})", om, 0.5, 1.0, "2028-02-28T05:20", 48},
        {"half-hour offset -9.5 h, start stamps", R"({"location":{"utc_offset":-9.5}})", mn, 0.5, 1.0, "2028-02-28T05:20", 48},
        {"low SOC, load scaled, no temperature", "{}", forecast({"2028-02-28T00:00", 72, -0.5, -1, false, false, false}), 0.12, 1.3, "2028-02-28T16:59", 30},
        {"no battery", R"({"bess":{"energy_kwh":0,"power_kw":0}})", om, 0.5, 1.0, "2028-02-28T05:20", 24},
        {"fractional time offset", "{}", forecast({"2028-12-31T00:00", 30, 0.8}), 0.9, 1.0, "2028-12-31T00:30", 0},
        {"year end wraps to January", "{}", forecast({"2027-12-31T12:00", 30, -0.5}), 0.5, 1.0, "", 0},
        // errors
        {"no hours", "{}", json::parse(R"({"times":[],"ghi":[]})"), 0.5, 1.0, "", 0},
        {"bad timestamp", "{}", badt, 0.5, 1.0, "", 0},
        {"time offset 1.5 h", "{}", forecast({"2027-02-27T00:00", 48, 1.5}), 0.5, 1.0, "2027-02-27T05:20", 0},
        {"time offset NaN", "{}", with(forecast({"2027-02-27T00:00", 48, -0.5}), "time_offset", "nan"), 0.5, 1.0, "", 0},
        {"bad current time", "{}", om, 0.5, 1.0, "yesterday", 0},
        {"forecast ended", "{}", om, 0.5, 1.0, "2028-03-04T00:00", 0},
        {"no data for the current hour", "{}", forecast({"2028-02-28T00:00", 72, 0.5, 5}), 0.5, 1.0, "2028-02-28T05:20", 0},
        {"gap in the hours", "{}", gap, 0.5, 1.0, "", 0},
        {"UTC offset out of range", R"({"location":{"utc_offset":15}})", om, 0.5, 1.0, "2028-02-28T05:20", 0},
        {"no load profile", R"({"load":{"kw":[1,2,3]}})", om, 0.5, 1.0, "", 0},
        {"genset rating 0", R"({"diesel":{"unit_kw":0}})", om, 0.5, 1.0, "", 0},
        {"reserve duration 0", R"({"bess":{"reserve_duration_h":0}})", om, 0.5, 1.0, "", 0},
        {"wind speeds out of order", R"({"wind":{"units":1,"v_in":12,"v_rated":10}})", om, 0.5, 1.0, "", 0},
    };

    json::Value out = json::Value::object(), list = json::Value::array();
    for (const Case& c : cases) {
        const json::Value fc = json::parse(c.fc.dump());   // as the Rust side reads it
        json::Value o = json::Value::object();
        o["name"] = c.name; o["patch"] = json::parse(c.patch); o["forecast"] = fc;
        o["soc_now"] = c.soc; o["load_scale"] = c.scale; o["now_utc"] = c.now; o["max_hours"] = c.max_h;
        try {
            const json::Value r = schedule(project(c.patch), fc, c.soc, c.scale, c.now, c.max_h);
            o["hash"] = hash(r.dump());
            // the readable part: everything but the rows between the first and the last
            json::Value res = json::parse(r.dump()), rows = json::Value::array();
            const auto& ra = r["rows"].arr();
            rows.push(ra.front());
            rows.push(ra.back());
            res["rows"] = rows;
            res["n_rows"] = ra.size();
            o["result"] = res;
            std::cerr << c.name << " " << o["hash"].str() << " " << ra.size() << " rows\n";
        } catch (const std::exception& e) {
            o["error"] = e.what();
            std::cerr << c.name << ": " << e.what() << "\n";
        }
        list.push(o);
    }
    out["schedules"] = list;

    // Forecast Lab: the example as it is (no value runs), and with the value runs: the example, and with two turbines and
    // another noise level
    struct Bench { const char* name; const char* patch; bool with_value; };
    json::Value bl = json::Value::array();
    for (const Bench& b : {Bench{"example", "{}", false}, Bench{"example with value", "{}", true},
                           Bench{"wind and noise with value", R"({"wind":{"units":2,"rated_kw":2000},"ems":{"noise_sigma":0.35}})", true}}) {
        const Project p = project(b.patch);
        validate_project(p);
        const json::Value r = forecast_benchmark(p, b.with_value);
        json::Value o = json::Value::object();
        o["name"] = b.name; o["patch"] = json::parse(b.patch); o["with_value"] = b.with_value;
        o["hash"] = hash(r.dump());
        // readable: per method the errors at leads 1 and 24 h, and the value runs
        json::Value sum = json::Value::object();
        for (const char* k : {"pv", "load"})
            for (const auto& m : r[k]["methods"].arr())
                sum[std::string(k) + "." + m["id"].str()] = json::Value(json::Array{m["nmae"][size_t(0)], m["nmae"][size_t(23)], m["skill"][size_t(23)]});
        o["summary"] = sum;
        if (b.with_value) { o["value"] = r["value"]; o["value_note"] = r["value_note"]; }
        std::cerr << b.name << " " << o["hash"].str() << "\n";
        bl.push(o);
    }
    out["benchmarks"] = bl;
    std::ofstream(argv[2]) << out.dump();
    return 0;
}
