// Writes engine/tests/fixtures/weather.json from the C++ engine: each weather service run on saved (synthetic) responses, with
// the answer's hash and head. src/weather.cpp is compiled with its own http_get renamed (see the build line), so the calls here
// are answered by `http_get` below. The Rust tests (engine/tests/weather.rs) build the same responses and compare.
//   python3 - <<'PY'   # a copy of weather.cpp whose real http_get is called real_http_get
//   s = open('src/weather.cpp').read()
//   s = s.replace('std::string http_get(const std::string& url, const std::string& user_agent) {', 'std::string real_http_get(const std::string& url, const std::string& user_agent) {')
//   open('/tmp/weather_fake.cpp', 'w').write(s)
//   PY
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genw tests/gen_weather_fixtures.cpp /tmp/weather_fake.cpp \
//       src/model.cpp src/pv.cpp src/platform.cpp src/shading.cpp -lcurl -framework Security -framework CoreFoundation
//   /tmp/genw engine/tests/fixtures/weather.json
#include "json.hpp"
#include "weather.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <mutex>

static std::map<std::string, std::string> responses;
static std::vector<std::string> urls;
static std::mutex m;
std::string http_get(const std::string& url, const std::string& agent) {
    std::lock_guard<std::mutex> g(m);
    urls.push_back(agent == "Soloptima/1.0" ? url : url + " [" + agent + "]");
    auto it = responses.find(url);
    if (it == responses.end()) throw std::runtime_error("Download failed: no saved response for " + url);
    if (it->second.rfind("ERR ", 0) == 0) throw std::runtime_error(it->second.substr(4));
    return it->second;
}
void http_download(const std::string&, const std::filesystem::path&, const std::function<bool(long long)>&, const std::string&) {}

static std::string hash(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}
// month and day of day `d` (0..365) of a year; day 365 of a leap year is 31 December
static void ymd(int d, int& m, int& dd) {
    static const int cum[13] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 366};
    m = 1;
    while (m < 12 && d >= cum[m]) ++m;
    dd = d - cum[m - 1] + 1;
}
static std::string f(const char* fmt, double v) { char b[64]; std::snprintf(b, sizeof b, fmt, v); return b; }
static std::string fu(double v) { char b[32]; std::snprintf(b, sizeof b, "%.5f", v); return b; }
static double sun(int i) { return std::max(0.0, 800 * std::sin((i % 24 - 6) / 12.0 * 3.14159265)) * (0.6 + 0.3 * std::sin(i / 24 * 0.1)); }
static double temp(int i) { return 20 + 8 * std::sin((i % 24 - 9) / 24.0 * 6.2831853); }
static const double LAT = 7.0, LON = -1.0;

static std::string tmy(int rows) {
    std::string s = R"({"inputs":{"location":{"latitude":7,"longitude":-1,"elevation":109.5,"irradiance_time_offset":0.1138},"meteo_data":{"radiation_db":"PVGIS-SARAH3","year_min":2005,"year_max":2023}},"outputs":{"tmy_hourly":[)";
    for (int i = 0; i < rows; ++i)
        s += std::string(i ? "," : "") + R"j({"time(UTC)":"20050101:0010","T2m":)j" + f("%.1f", temp(i)) + R"j(,"G(h)":)j" + f("%.2f", sun(i)) + R"j(,"Gb(n)":)j" + f("%.2f", sun(i) * 0.7) +
             R"j(,"Gd(h)":)j" + f("%.2f", sun(i) * 0.3) + R"(,"WS10m":)" + f("%.1f", 2 + (i % 7) * 0.5) + "}";
    return s + "]}}";
}
// hourly rows of the given years (leap years 8784 h); the last year can be cut to `last_rows`
static std::string series(const std::vector<int>& years, int last_rows = -1) {
    std::string s = R"({"inputs":{"location":{"latitude":7,"longitude":-1,"elevation":109.5},"meteo_data":{"radiation_db":"PVGIS-SARAH3"}},"outputs":{"hourly":[)";
    bool first = true;
    for (size_t yi = 0; yi < years.size(); ++yi) {
        const int y = years[yi], n = ((y % 4 == 0) ? 8784 : 8760);
        const int rows = yi + 1 == years.size() && last_rows >= 0 ? last_rows : n;
        for (int i = 0; i < rows; ++i) {
            const double hs = std::max(-10.0, 60 * std::sin((i % 24 - 6) / 12.0 * 3.14159265));
            char ts[32];
            int mo, dd;
            ymd(i / 24, mo, dd);
            std::snprintf(ts, sizeof ts, "%04d%02d%02d:%02d10", y, mo, dd, i % 24);
            s += std::string(first ? "" : ",") + R"({"time":")" + ts + R"j(","Gb(i)":)j" + f("%.2f", sun(i) * 0.7) + R"j(,"Gd(i)":)j" + f("%.2f", sun(i) * 0.3) +
                 R"j(,"H_sun":)j" + f("%.1f", hs) + R"(,"T2m":)" + f("%.1f", temp(i)) + R"(,"WS10m":)" + f("%.1f", 2 + (i % 7) * 0.5) + "}";
            first = false;
        }
    }
    return s + "]}}";
}
static std::string series_url(int y0, int y1) {
    return "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=" + fu(LAT) + "&lon=" + fu(LON) + "&startyear=" + std::to_string(y0) + "&endyear=" + std::to_string(y1) +
           "&angle=0&aspect=0&components=1&outputformat=json";
}
static std::string nasa_url(int y) {
    return "https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M&community=RE&longitude=" + fu(LON) +
           "&latitude=" + fu(LAT) + "&start=" + std::to_string(y) + "0101&end=" + std::to_string(y) + "1231&format=JSON&time-standard=UTC";
}
// NASA POWER: one object per parameter keyed YYYYMMDDHH; hours in [gap0, gap1) are -999
static std::string nasa(int y, int gap0, int gap1, int drop_t_rows = 0, bool no_param = false) {
    if (no_param) return R"({"properties":{"parameter":{}},"messages":["no data"]})";
    auto key = [&](int i) { int mo, dd; ymd(i / 24, mo, dd); char b[24]; std::snprintf(b, sizeof b, "%d%02d%02d%02d", y, mo, dd, i % 24); return std::string(b); };
    auto obj = [&](const char* name, auto val, int cut) {
        std::string s = std::string("\"") + name + "\":{";
        for (int i = 0; i < 8760 - cut; ++i) s += std::string(i ? "," : "") + "\"" + key(i) + "\":" + (i >= gap0 && i < gap1 ? std::string("-999") : f("%.2f", val(i)));
        return s + "}";
    };
    return std::string(R"({"geometry":{"coordinates":[-1,7,111.2]},"properties":{"parameter":{)") + obj("ALLSKY_SFC_SW_DWN", [](int i) { return sun(i); }, 0) + "," +
           obj("ALLSKY_SFC_SW_DNI", [](int i) { return sun(i) * 0.7; }, 0) + "," + obj("ALLSKY_SFC_SW_DIFF", [](int i) { return sun(i) * 0.3 + 5 * (i % 5 == 0); }, 0) + "," +
           obj("T2M", [](int i) { return temp(i); }, drop_t_rows) + "," + obj("WS10M", [](int i) { return 2 + (i % 7) * 0.5; }, 0) + "}}}";
}
static std::string om_url(int days, const std::string& key) {
    return std::string(key.empty() ? "https://api.open-meteo.com" : "https://customer-api.open-meteo.com") + "/v1/forecast?latitude=" + fu(LAT) + "&longitude=" + fu(LON) +
           "&hourly=shortwave_radiation,diffuse_radiation,direct_normal_irradiance,temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=GMT&forecast_days=" +
           std::to_string(std::min(16, std::clamp(days, 1, 16) + 1)) + (key.empty() ? "" : "&apikey=" + key);
}
static std::string om(int n, int null_at) {
    std::string t, g, d, b, tt, w;
    for (int i = 0; i < n; ++i) {
        char ts[32];
        std::snprintf(ts, sizeof ts, "2025-03-%02dT%02d:00", 1 + i / 24, i % 24);
        const char* c = i ? "," : "";
        t += std::string(c) + "\"" + ts + "\"";
        g += c + (i >= null_at ? std::string("null") : f("%.1f", sun(i)));
        d += c + f("%.1f", sun(i) * 0.3);
        b += c + f("%.1f", sun(i) * 0.7);
        tt += c + f("%.1f", temp(i));
        w += c + f("%.1f", 3.0 + (i % 4));
    }
    return R"({"hourly":{"time":[)" + t + R"(],"shortwave_radiation":[)" + g + R"(],"diffuse_radiation":[)" + d + R"(],"direct_normal_irradiance":[)" + b +
           R"(],"temperature_2m":[)" + tt + R"(],"wind_speed_10m":[)" + w + "]}}";
}
static std::string met_url() { return "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + fu(LAT) + "&lon=" + fu(LON); }
static std::string met(int hourly, int six_hourly, bool leap_gap = false) {
    std::string s = R"({"properties":{"meta":{"updated_at":"2025-03-01T06:00:00Z"},"timeseries":[)";
    long h = 0;
    for (int i = 0; i < hourly + six_hourly; ++i) {
        if (i == hourly - 3 && leap_gap) h += 2;   // a missing hour
        char ts[40];
        const long d = h / 24;
        std::snprintf(ts, sizeof ts, "2025-03-%02ld T%02ld:00:00Z", 1 + d, h % 24);
        std::string t = ts;
        t.erase(t.find(' '), 1);
        s += std::string(i ? "," : "") + R"({"time":")" + t + R"(","data":{"instant":{"details":{"air_temperature":)" + f("%.1f", temp(int(h))) + R"(,"cloud_area_fraction":)" +
             f("%.1f", 30 + (i * 7) % 60) + R"(,"wind_speed":)" + f("%.1f", 1.5 + (i % 5) * 0.4) + "}}}}";
        h += i + 1 < hourly ? 1 : 6;
    }
    return s + "]}}";
}
static std::string pvcalc_url(bool tracker, double angle, double aspect, double loss) {
    return "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=" + fu(LAT) + "&lon=" + fu(LON) + "&peakpower=1&loss=" + fu(loss) +
           (tracker ? "&fixed=0&inclined_axis=1&inclinedaxisangle=0" : "&angle=" + fu(angle) + "&aspect=" + fu(aspect)) + "&mountingplace=free&pvtechchoice=crystSi&outputformat=json";
}
static std::string pvcalc(const char* kind, int months) {
    std::string mo;
    for (int i = 1; i <= months; ++i) mo += std::string(i > 1 ? "," : "") + R"({"month":)" + std::to_string(i) + R"(,"E_m":)" + f("%.2f", 100 + 5.5 * i) + "}";
    return std::string(R"({"inputs":{"meteo_data":{"radiation_db":"PVGIS-SARAH3","year_min":2005,"year_max":2023}},"outputs":{"monthly":{")") + kind + R"(":[)" + mo +
           R"(]},"totals":{")" + kind + R"(":{"E_y":1450.25,"H(i)_y":1820.5}}}})";
}

static void strip(json::Value& v) {   // fields that carry the clock
    if (v.is_object()) for (const char* k : {"retrieved_utc", "issued_utc"}) if (v.has(k)) v[k] = "";
    if (v.has("years") && v["years"].is_array() && v["years"].size() && v["years"][size_t(0)].is_object()) {
        json::Array a;
        for (size_t i = 0; i < v["years"].size(); ++i) { json::Value y = v["years"][i]; strip(y); a.push_back(y); }
        v["years"] = json::Value(a);
    }
}
static json::Value head(const json::Value& v) {   // arrays cut to 3 values, for reading a failure
    if (v.is_array()) { json::Array a; for (size_t i = 0; i < v.size() && i < 3; ++i) a.push_back(head(v[i])); return json::Value(a); }
    if (v.is_object()) { json::Object o; for (const auto& kv : v.obj()) o[kv.first] = head(kv.second); return json::Value(o); }
    return v;
}

int main(int, char** argv) {
    json::Array out;
    auto run = [&](const std::string& name, std::map<std::string, std::string> resp, auto action) {
        responses = std::move(resp);
        urls.clear();
        clear_yield_cache();
        json::Object o{{"name", name}};
        std::map<std::string, std::string> hashes;
        for (const auto& kv : responses) hashes[kv.first] = hash(kv.second);
        json::Object rh;
        for (const auto& kv : hashes) rh[kv.first] = kv.second;
        o["responses"] = json::Value(rh);
        try {
            json::Value r = action();
            strip(r);
            o["status"] = "OK";
            o["hash"] = hash(r.dump());
            o["head"] = head(r).dump();
        } catch (const std::exception& e) { o["status"] = std::string("ERR ") + e.what(); }
        std::sort(urls.begin(), urls.end());
        json::Array u;
        for (const auto& s : urls) u.push_back(s);
        o["urls"] = json::Value(u);
        out.push_back(json::Value(o));
    };
    const std::string tmy_url = "https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=" + fu(LAT) + "&lon=" + fu(LON) + "&outputformat=json";
    run("pvgis tmy", {{tmy_url, tmy(8760)}}, [&] { return fetch_weather("pvgis_tmy", LAT, LON, 0); });
    run("pvgis tmy 8784", {{tmy_url, tmy(8784)}}, [&] { return fetch_weather("pvgis_tmy", LAT, LON, 0); });
    run("pvgis tmy short", {{tmy_url, tmy(100)}}, [&] { return fetch_weather("pvgis_tmy", LAT, LON, 0); });
    run("pvgis tmy http error", {{tmy_url, "ERR Data service returned HTTP 500: busy"}}, [&] { return fetch_weather("pvgis_tmy", LAT, LON, 0); });
    run("pvgis year", {{series_url(2019, 2019), series(std::vector<int>{2019})}}, [&] { return fetch_weather("pvgis_year", LAT, LON, 2019); });
    run("pvgis year leap", {{series_url(2020, 2020), series(std::vector<int>{2020})}}, [&] { return fetch_weather("pvgis_year", LAT, LON, 2020); });
    run("pvgis year incomplete", {{series_url(2021, 2021), series(std::vector<int>{2021}, 100)}}, [&] { return fetch_weather("pvgis_year", LAT, LON, 2021); });
    run("pvgis years", {{series_url(2005, 2008), series(std::vector<int>{2005, 2006, 2007, 2008})}, {series_url(2009, 2010), series(std::vector<int>{2009, 2010}, 5000)}},
        [&] { return fetch_weather_years("pvgis", LAT, LON, 2010, 2005); });
    run("pvgis years single", {}, [&] { return fetch_weather_years("pvgis", LAT, LON, 2010, 2010); });
    run("pvgis years clamp", {{series_url(2005, 2008), series(std::vector<int>{2005, 2006, 2007, 2008})}, {series_url(2009, 2010), series(std::vector<int>{2009, 2010})}},
        [&] { return fetch_weather_years("pvgis", LAT, LON, 1990, 2010); });
    run("nasa year", {{nasa_url(2019), nasa(2019, 0, 0)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa gaps", {{nasa_url(2019), nasa(2019, 100, 103)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa gap 5 and 0", {{nasa_url(2019), nasa(2019, 0, 5)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa gap 80", {{nasa_url(2019), nasa(2019, 3000, 3080)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa lengths", {{nasa_url(2019), nasa(2019, 0, 0, 24)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa no data", {{nasa_url(2019), nasa(2019, 0, 0, 0, true)}}, [&] { return fetch_weather("nasa_power", LAT, LON, 2019); });
    run("nasa years", {{nasa_url(2016), nasa(2016, 0, 0)}, {nasa_url(2017), nasa(2017, 50, 52)}, {nasa_url(2018), nasa(2018, 0, 0)}},
        [&] { return fetch_weather_years("nasa_power", LAT, LON, 2016, 2018); });
    run("nasa years one fails", {{nasa_url(2016), nasa(2016, 0, 0)}, {nasa_url(2017), "ERR boom"}}, [&] { return fetch_weather_years("nasa_power", LAT, LON, 2016, 2017); });
    run("unknown source", {}, [&] { return fetch_weather("magic", LAT, LON, 0); });
    run("unknown years source", {}, [&] { return fetch_weather_years("magic", LAT, LON, 2000, 2001); });
    run("open-meteo", {{om_url(3, ""), om(96, 1000)}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 3, ""); });
    run("open-meteo nulls", {{om_url(2, ""), om(72, 50)}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 2, ""); });
    run("open-meteo days clamp", {{om_url(40, ""), om(24, 1000)}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 40, ""); });
    run("open-meteo days zero", {{om_url(0, ""), om(24, 1000)}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 0, ""); });
    run("open-meteo key", {{om_url(2, "ab-C_9"), om(48, 1000)}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 2, "ab-C_9"); });
    run("open-meteo bad key", {}, [&] { return fetch_forecast("open_meteo", LAT, LON, 2, "a&b"); });
    run("open-meteo empty", {{om_url(2, ""), R"({"hourly":{"time":[]}})"}}, [&] { return fetch_forecast("open_meteo", LAT, LON, 2, ""); });
    run("met norway", {{met_url(), met(60, 20)}}, [&] { return fetch_forecast("met_norway", LAT, LON, 2, ""); });
    run("met norway gap", {{met_url(), met(40, 10, true)}}, [&] { return fetch_forecast("met_norway", LAT, LON, 3, ""); });
    run("met norway short", {{met_url(), met(10, 0)}}, [&] { return fetch_forecast("met_norway", LAT, LON, 1, ""); });
    run("pvcalc fixed", {{pvcalc_url(false, 10, 0, 14), pvcalc("fixed", 12)}}, [&] { return pvgis_pvcalc(LAT, LON, 14, 10, 0, false); });
    run("pvcalc tracker", {{pvcalc_url(true, 0, 0, 14), pvcalc("inclined_axis", 12)}}, [&] { return pvgis_pvcalc(LAT, LON, 14, 0, 0, true); });
    run("pvcalc 11 months", {{pvcalc_url(false, 10, 0, 14), pvcalc("fixed", 11)}}, [&] { return pvgis_pvcalc(LAT, LON, 14, 10, 0, false); });
    run("pvcalc cached", {{pvcalc_url(false, 10, 0, 14), pvcalc("fixed", 12)}}, [&] { clear_yield_cache(); pvgis_pvcalc(LAT, LON, 14, 10, 0, false); json::Value b = pvgis_pvcalc(LAT, LON, 14, 10, 0, false); b["dropped"] = clear_yield_cache(); return b; });
    // time conversions
    json::Array times;
    for (const char* t : {"1970-01-01T00:00Z", "2028-02-29T00:00:00Z", "2028-03-01T00:00", "2028-02-28T05:59", "2027-02-29T00:00", "2028-02-28T05:20+08:00", "2028-02-28T24:00", "",
                          "2024-01-01T0500", "2024-01-01T05:00", "2024-01-01T05Z", "2024-1-5T3", "2024-13-01T00:00", "0000-01-01T00:00", "2024-02-30T00:00", "1969-12-31T23:00",
                          " 2024-01-01T05:00", "2024-01-01T05:00:00.5Z", "2024-01-01T05:00x", "2100-02-29T00:00", "2000-02-29T12", "12345-01-01T00:00", "2024-01-01 05:00"}) {
        const long h = iso_to_epoch_h(t);
        times.push_back(json::Object{{"iso", t}, {"h", h == NO_TIME_H ? json::Value() : json::Value(double(h))}, {"back", h == NO_TIME_H ? std::string() : epoch_h_to_iso(h)}});
    }
    for (long h : {-1L, 0L, 1L, -25L, 484800L}) times.push_back(json::Object{{"epoch", double(h)}, {"back", epoch_h_to_iso(h)}});
    out.push_back(json::Object{{"name", "times"}, {"times", json::Value(times)}});
    std::ofstream(argv[1], std::ios::binary) << json::Value(out).dump();
    std::cout << out.size() << " cases\n";
}
