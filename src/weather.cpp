#include "weather.hpp"
#include "parallel.hpp"
#include "model.hpp"
#include "pv.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#else
#include <curl/curl.h>
#endif
#include <map>
#include <mutex>
#include <stdexcept>

namespace {

constexpr size_t MAX_DOWNLOAD = 64u * 1024 * 1024;

#ifndef _WIN32
size_t write_cb(char* ptr, size_t size, size_t n, void* ud) {
    auto* s = static_cast<std::string*>(ud);
    s->append(ptr, size * n);
    return s->size() > MAX_DOWNLOAD ? 0 : size * n;
}
#endif

std::string fmt(double v) { char b[32]; std::snprintf(b, sizeof b, "%.5f", v); return b; }

std::vector<double> to8760(std::vector<double> v) {
    if (v.size() == 8784) v.erase(v.begin() + 59 * 24, v.begin() + 60 * 24);   // drop Feb 29
    if (v.size() > HOURS) v.resize(HOURS);
    while (v.size() < HOURS) v.push_back(v.size() >= 24 ? v[v.size() - 24] : 0.0);
    return v;
}

// Current time in UTC, ISO 8601 (gmtime is not reentrant everywhere; downloads run on several threads).
std::string utc_now() {
    static std::mutex m;
    std::lock_guard<std::mutex> g(m);
    const std::time_t t = std::time(nullptr);
    char b[32];
    std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return b;
}

// years: the period the data comes from ("2005-2023" for a typical year assembled from it). api: the service called.
// n_filled: hours with a missing value filled in, max_gap_h: the longest run of missing values.
json::Value pack(const std::string& source, double lat, double lon, double elev, double offset,
                 std::vector<double> ghi, std::vector<double> dni, std::vector<double> dhi, std::vector<double> t,
                 std::vector<double> ws, const std::string& note, const std::string& years, const std::string& api,
                 int n_filled = 0, int max_gap_h = 0) {
    json::Value o = json::Value::object();
    o["source"] = source;
    o["years"] = years;
    o["is_utc"] = true;
    o["time_offset"] = offset;
    o["lat"] = lat;
    o["lon"] = lon;
    o["elevation"] = elev;
    o["note"] = note;
    o["api"] = api;
    o["retrieved_utc"] = utc_now();
    o["n_filled"] = n_filled;
    o["max_gap_h"] = max_gap_h;
    o["ghi"] = json::Value(to8760(std::move(ghi)));
    o["dni"] = json::Value(to8760(std::move(dni)));
    o["dhi"] = json::Value(to8760(std::move(dhi)));
    o["tamb"] = json::Value(to8760(std::move(t)));
    o["wind"] = json::Value(to8760(std::move(ws)));
    return o;
}

// GET with one retry: a multi-year download makes many requests, and one may fail on a busy server.
std::string http_get_retry(const std::string& url) {
    try { return http_get(url); } catch (const std::exception&) { return http_get(url); }
}

// Last year with complete NASA POWER hourly data: its irradiance is published about three months late.
int nasa_last_year() {
    static std::mutex m;
    std::lock_guard<std::mutex> g(m);
    const std::time_t t = std::time(nullptr);
    const std::tm* u = std::gmtime(&t);
    return u->tm_year + 1900 - (u->tm_mon >= 4 ? 1 : 2);   // last year from May on
}

json::Value pvgis_tmy(double lat, double lon) {
    std::string url = "https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=" + fmt(lat) + "&lon=" + fmt(lon) + "&outputformat=json";
    json::Value d = json::parse(http_get(url));
    const auto& rows = d["outputs"]["tmy_hourly"].arr();
    if (rows.size() < HOURS) throw std::runtime_error("PVGIS returned no TMY data for this location (outside coverage?).");
    std::vector<double> g, b, f, t, w;
    for (const auto& r : rows) {
        g.push_back(r["G(h)"].num()); b.push_back(r["Gb(n)"].num()); f.push_back(r["Gd(h)"].num());
        t.push_back(r["T2m"].num()); w.push_back(r["WS10m"].num());
    }
    const auto& loc = d["inputs"]["location"];
    const auto& md = d["inputs"]["meteo_data"];
    std::string db = md.gets("radiation_db", "PVGIS");
    const int y0 = int(md.get("year_min", 0)), y1 = int(md.get("year_max", 0));
    return pack("PVGIS TMY (" + db + ")", lat, lon, loc.get("elevation", 0), loc.get("irradiance_time_offset", 0.5), g, b,
                f, t, w, "Typical meteorological year assembled from " + db + ", JRC European Commission.",
                y0 > 0 && y1 > 0 ? std::to_string(y0) + "-" + std::to_string(y1) : "", "PVGIS 5.3 tmy");
}

// A PVGIS seriescalc response (one or several years, horizontal plane) as one weather JSON per calendar year. Rows are
// grouped by the year in "time" (YYYYMMDD:HHMM); beam normal = Gb(i) / sin(sun height) when the sun is above 2 deg.
// pack() drops 29 Feb of leap years; incomplete years are left out.
json::Value pvgis_rows_by_year(const json::Value& d, double lat, double lon) {
    const auto& rows = d["outputs"]["hourly"].arr();
    const auto& loc = d["inputs"]["location"];
    const std::string db = d["inputs"]["meteo_data"].gets("radiation_db", "PVGIS");
    json::Value out = json::Value::array();
    for (size_t i = 0; i < rows.size();) {
        const std::string ts = rows[i].gets("time", ""), y = ts.substr(0, 4);
        const double offset = ts.size() >= 13 ? std::atoi(ts.substr(11, 2).c_str()) / 60.0 : 0.5;
        std::vector<double> g, b, f, t, w;
        size_t j = i;
        for (; j < rows.size() && rows[j].gets("time", "").compare(0, 4, y) == 0; ++j) {
            const auto& r = rows[j];
            double gb = r["Gb(i)"].num(), gd = r["Gd(i)"].num(), hs = r["H_sun"].num();
            g.push_back(gb + gd);
            f.push_back(gd);
            b.push_back(hs > 2 ? gb / std::sin(hs * 3.14159265358979 / 180.0) : 0.0);
            t.push_back(r["T2m"].num());
            w.push_back(r["WS10m"].num());
        }
        if (j == i) ++j;   // a row without a time: skip it
        if (y.size() == 4 && g.size() >= HOURS)
            out.push(pack("PVGIS " + y + " (" + db + ")", lat, lon, loc.get("elevation", 0), offset, g, b, f, t, w,
                          "Hourly series for " + y + " from " + db + ", JRC European Commission.", y, "PVGIS 5.3 seriescalc"));
        i = j;
    }
    return out;
}

std::string pvgis_series_url(double lat, double lon, int y0, int y1) {
    return "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat=" + fmt(lat) + "&lon=" + fmt(lon) + "&startyear=" + std::to_string(y0) +
           "&endyear=" + std::to_string(y1) + "&angle=0&aspect=0&components=1&outputformat=json";
}

json::Value pvgis_year(double lat, double lon, int year) {
    json::Value ys = pvgis_rows_by_year(json::parse(http_get(pvgis_series_url(lat, lon, year, year))), lat, lon);
    if (ys.size() == 0) throw std::runtime_error("PVGIS returned no hourly data for that year/location.");
    return ys.arr().front();
}

// Every year from y0 to y1 within the PVGIS 5.3 database (2005-2023). PVGIS takes about 5 s per year of hourly data, so
// the range is requested in blocks of 4 years, 3 at a time, which keeps each request well inside the download timeout.
json::Value pvgis_years(double lat, double lon, int y0, int y1) {
    y0 = std::clamp(y0, 2005, 2023);
    y1 = std::clamp(y1, y0, 2023);
    if (y1 == y0) throw std::runtime_error("PVGIS hourly data covers 2005-2023: choose at least two years in that range.");
    std::vector<std::pair<int, int>> blocks;
    for (int y = y0; y <= y1; y += 4) blocks.push_back({y, std::min(y + 3, y1)});
    std::vector<json::Value> parts(blocks.size());
    std::string db;
    std::mutex m;
    parallel_for(blocks.size(), 3, [&](size_t k) {
        json::Value d = json::parse(http_get_retry(pvgis_series_url(lat, lon, blocks[k].first, blocks[k].second)));
        parts[k] = pvgis_rows_by_year(d, lat, lon);
        std::lock_guard<std::mutex> g(m);
        if (db.empty()) db = d["inputs"]["meteo_data"].gets("radiation_db", "PVGIS");
    });
    json::Value years = json::Value::array();
    for (const auto& part : parts) for (const auto& y : part.arr()) years.push(y);
    if (years.size() == 0) throw std::runtime_error("PVGIS returned no hourly data for this location (outside coverage?).");
    return json::Value(json::Object{{"from", y0}, {"to", y1}, {"database", db}, {"years", years}});
}

} // namespace

// NASA POWER marks missing hours with -999. Runs of up to 3 h are interpolated linearly between the hours around them;
// longer runs take the same hour of the previous day (of the next valid day at the start of the series). filled marks the
// hours changed, max_gap the longest run.
std::vector<double> fill_gaps(std::vector<double> v, std::vector<char>& filled, int& max_gap) {
    const auto missing = [](double x) { return x <= -990; };
    const size_t n = v.size();
    filled.resize(std::max(filled.size(), n), 0);
    for (size_t a = 0; a < n;) {
        if (!missing(v[a])) { ++a; continue; }
        size_t b = a;
        while (b < n && missing(v[b])) ++b;
        max_gap = std::max(max_gap, int(b - a));
        for (size_t i = a; i < b; ++i) {
            filled[i] = 1;
            if (b - a <= 3 && a > 0 && b < n) v[i] = v[a - 1] + (v[b] - v[a - 1]) * double(i - a + 1) / double(b - a + 1);
            else if (i >= 24) v[i] = v[i - 24];
            else {
                size_t j = i + 24;
                while (j < n && missing(v[j])) j += 24;
                v[i] = j < n ? v[j] : 0.0;
            }
        }
        a = b;
    }
    return v;
}

namespace {

json::Value nasa_power(double lat, double lon, int year) {
    std::string url = "https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN,"
                      "ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M&community=RE&longitude=" + fmt(lon) +
                      "&latitude=" + fmt(lat) + "&start=" + std::to_string(year) + "0101&end=" + std::to_string(year) +
                      "1231&format=JSON&time-standard=UTC";
    json::Value d = json::parse(http_get(url));
    const auto& P = d["properties"]["parameter"];
    if (!P.has("ALLSKY_SFC_SW_DWN")) throw std::runtime_error("NASA POWER returned no data: " + d.dump().substr(0, 300));
    std::vector<char> filled;
    int max_gap = 0;
    auto series = [&](const char* k) {
        std::vector<double> v;
        for (const auto& kv : P[k].obj()) v.push_back(kv.second.num(-999));   // keys YYYYMMDDHH sort chronologically
        return fill_gaps(std::move(v), filled, max_gap);
    };
    auto g = series("ALLSKY_SFC_SW_DWN"), b = series("ALLSKY_SFC_SW_DNI"), f = series("ALLSKY_SFC_SW_DIFF"), t = series("T2M"), w = series("WS10M");
    for (size_t i = 0; i < g.size(); ++i) { g[i] = std::max(0.0, g[i]); f[i] = std::clamp(f[i], 0.0, g[i]); }
    const int n_filled = int(std::count(filled.begin(), filled.end(), 1));
    if (max_gap > 72)
        throw std::runtime_error("NASA POWER has no data for " + std::to_string(max_gap) + " h in a row in " + std::to_string(year) +
                                 " (its hourly irradiance is published about three months late): choose an earlier year.");
    double elev = d["geometry"]["coordinates"][2].num(0);
    return pack("NASA POWER " + std::to_string(year), lat, lon, elev, 0.5, g, b, f, t, w,
                "NASA Langley Research Center POWER project, hourly all-sky irradiance (CERES/MERRA-2)." +
                    (n_filled ? " " + std::to_string(n_filled) + " h filled." : std::string()),
                std::to_string(year), "NASA POWER temporal/hourly/point", n_filled, max_gap);
}

// Every year from y0 to y1 from 2001 to the last complete year, one request per year, 3 at a time.
json::Value nasa_power_years(double lat, double lon, int y0, int y1) {
    const int last = nasa_last_year();
    y0 = std::clamp(y0, 2001, last);
    y1 = std::clamp(y1, y0, last);
    if (y1 == y0) throw std::runtime_error("NASA POWER hourly data covers 2001-" + std::to_string(last) + ": choose at least two years in that range.");
    std::vector<json::Value> ys(size_t(y1 - y0 + 1));
    parallel_for(ys.size(), 3, [&](size_t k) {
        const int y = y0 + int(k);
        try { ys[k] = nasa_power(lat, lon, y); } catch (const std::exception&) {
            try { ys[k] = nasa_power(lat, lon, y); } catch (const std::exception& e) { throw std::runtime_error("NASA POWER " + std::to_string(y) + ": " + e.what()); }
        }
    });
    return json::Value(json::Object{{"from", y0}, {"to", y1}, {"database", "NASA POWER"}, {"years", json::Value(json::Array(ys.begin(), ys.end()))}});
}

// ISO "YYYY-MM-DDTHH:MM" (UTC) -> hour of a non-leap year (0..8759)
int hour_of_year(const std::string& iso) {
    static const int cum[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
    int y, mo, d, h;
    if (std::sscanf(iso.c_str(), "%d-%d-%dT%d", &y, &mo, &d, &h) != 4) return -1;
    if (mo == 2 && d == 29) d = 28;
    return (cum[std::clamp(mo, 1, 12) - 1] + d - 1) * 24 + h;
}

} // namespace

// Days since 1970-01-01 of a proleptic Gregorian date and back (Howard Hinnant, "chrono-Compatible Low-Level Date
// Algorithms"): years run from March so that 29 February is the last day of the year.
long days_from_civil(int y, unsigned m, unsigned d) {
    y -= m <= 2;
    const long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = unsigned(y - era * 400);                       // [0, 399]
    const unsigned doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;   // [0, 365]
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;           // [0, 146096]
    return era * 146097 + long(doe) - 719468;
}
void civil_from_days(long z, int& y, unsigned& m, unsigned& d) {
    z += 719468;
    const long era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = unsigned(z - era * 146097);                            // [0, 146096]
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;   // [0, 399]
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);                 // [0, 365]
    const unsigned mp = (5 * doy + 2) / 153;                                    // [0, 11]
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    y = int(yoe) + int(era * 400) + (m <= 2);
}

namespace {

json::Value open_meteo(double lat, double lon, int days, const std::string& key) {
    std::string host = key.empty() ? "https://api.open-meteo.com" : "https://customer-api.open-meteo.com";
    // The forecast starts at 00:00 UTC today, so one day more still leaves `days` days after the current hour.
    std::string url = host + "/v1/forecast?latitude=" + fmt(lat) + "&longitude=" + fmt(lon) +
                      "&hourly=shortwave_radiation,diffuse_radiation,direct_normal_irradiance,temperature_2m,wind_speed_10m"
                      "&wind_speed_unit=ms&timezone=GMT&forecast_days=" + std::to_string(std::min(16, std::clamp(days, 1, 16) + 1));
    if (!key.empty()) {
        for (char ch : key)
            if (!std::isalnum(static_cast<unsigned char>(ch)) && ch != '-' && ch != '_') throw std::runtime_error("Invalid API key characters.");
        url += "&apikey=" + key;
    }
    json::Value d = json::parse(http_get(url));
    const std::string issued = utc_now();
    const auto& H = d["hourly"];
    // Every series ends at the first hour without irradiance or temperature (null at the end of the model's range), so a
    // missing value is never read as zero PV.
    size_t n = H["time"].size();
    for (const char* k : {"shortwave_radiation", "diffuse_radiation", "direct_normal_irradiance", "temperature_2m"})
        for (size_t i = 0; i < n; ++i)
            if (H[k][i].is_null()) { n = i; break; }
    auto head = [&](const char* k) {
        json::Value a = json::Value::array();
        for (size_t i = 0; i < n; ++i) a.push(H[k][i]);
        return a;
    };
    json::Value o = json::Value::object();
    o["provider"] = "Open-Meteo";
    o["time_offset"] = -0.5;   // radiation is the mean of the preceding hour
    o["issued_utc"] = issued;
    o["times"] = head("time");
    o["ghi"] = head("shortwave_radiation");
    o["dhi"] = head("diffuse_radiation");
    o["dni"] = head("direct_normal_irradiance");
    o["tamb"] = head("temperature_2m");
    o["wind"] = head("wind_speed_10m");
    o["note"] = std::string(key.empty() ? "Open-Meteo free tier (noncommercial use only)." : "Open-Meteo (API key).") +
                (n < H["time"].size() ? " No data from " + H["time"][n].str() + " UTC." : std::string());
    return o;
}

json::Value met_norway(double lat, double lon, int days) {
    std::string url = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + fmt(lat) + "&lon=" + fmt(lon);
    json::Value d = json::parse(http_get(url, "Soloptima/1.0 local-energy-model"));
    const std::string issued = utc_now();
    // Hourly instants, exactly 1 h apart (also across 29 February), up to where the series turns 6-hourly; one instant more
    // than the hours wanted, for the end of the last hour.
    struct Instant { std::string t; double cloud, temp, wind; };
    std::vector<Instant> in;
    const size_t want = size_t(std::clamp(days, 1, 16)) * 24;
    long prev = NO_TIME_H;
    for (const auto& ts : d["properties"]["timeseries"].arr()) {
        const std::string t = ts.gets("time", "");
        const long h = iso_to_epoch_h(t);
        if (h == NO_TIME_H || (prev != NO_TIME_H && h != prev + 1)) break;
        prev = h;
        const auto& det = ts["data"]["instant"]["details"];
        in.push_back({t.substr(0, 16), det.get("cloud_area_fraction", 50), det.get("air_temperature", 25), det.get("wind_speed", 1)});
        if (in.size() > want) break;
    }
    // Hour [h, h + 1) takes the mean of the instants at h and h + 1; the last hour its own instant.
    json::Value times = json::Value::array(), ghi = json::Value::array(), tamb = json::Value::array(), wind = json::Value::array();
    for (size_t i = 0; i < std::min(in.size(), want); ++i) {
        const Instant& a = in[i];
        const Instant& b = in[std::min(i + 1, in.size() - 1)];
        const double cloud = (a.cloud + b.cloud) / 2 / 100.0;
        const int h = hour_of_year(a.t);
        SunPos s = sun_position(lat, lon, h / 24 + 1, (h % 24) + 0.5);
        double cs = haurwitz_ghi(s.cos_zenith);
        times.push(a.t);
        ghi.push(cs * (1.0 - 0.75 * std::pow(cloud, 3.4)));   // Kasten-Czeplak cloud-cover model
        tamb.push((a.temp + b.temp) / 2);
        wind.push((a.wind + b.wind) / 2);
    }
    json::Value o = json::Value::object();
    o["provider"] = "MET Norway";
    o["time_offset"] = 0.5;
    o["issued_utc"] = issued;
    o["model_updated_utc"] = d["properties"]["meta"].gets("updated_at", "");
    o["times"] = times; o["ghi"] = ghi; o["tamb"] = tamb; o["wind"] = wind;
    o["note"] = "MET Norway Locationforecast (CC BY 4.0); irradiance derived from cloud cover (Kasten-Czeplak).";
    return o;
}

std::string http_error(long status, const std::string& body) {
    std::string msg = body.substr(0, 300);
    try { json::Value e = json::parse(body); if (e.has("message")) msg = e["message"].str(); } catch (...) {}
    return "Data service returned HTTP " + std::to_string(status) + ": " + msg;
}
} // namespace

#ifdef _WIN32
// Windows: WinHTTP (built into Windows, uses the system certificate store and proxy settings).
std::string http_get(const std::string& url, const std::string& user_agent) {
    auto widen = [](const std::string& s) {
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), nullptr, 0);
        std::wstring w(size_t(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), w.data(), n);
        return w;
    };
    std::wstring wurl = widen(url);
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof uc;
    uc.dwHostNameLength = uc.dwUrlPathLength = uc.dwExtraInfoLength = DWORD(-1);   // components point into wurl
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) throw std::runtime_error("Bad URL: " + url);
    std::wstring object = std::wstring(uc.lpszUrlPath, uc.dwUrlPathLength) + std::wstring(uc.lpszExtraInfo, uc.dwExtraInfoLength);
    HINTERNET ses = WinHttpOpen(widen(user_agent).c_str(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!ses) ses = WinHttpOpen(widen(user_agent).c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!ses) throw std::runtime_error("Download failed: cannot open WinHTTP session.");
    WinHttpSetTimeouts(ses, 15000, 15000, 120000, 120000);
    HINTERNET con = WinHttpConnect(ses, std::wstring(uc.lpszHostName, uc.dwHostNameLength).c_str(), uc.nPort, 0);
    HINTERNET req = con ? WinHttpOpenRequest(con, L"GET", object.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                             uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
    std::string body;
    DWORD status = 0, len = sizeof status;
    bool ok = req && WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(req, nullptr);
    if (ok) {
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
        for (;;) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
            std::string chunk(avail, '\0');
            DWORD read = 0;
            if (!WinHttpReadData(req, chunk.data(), avail, &read) || read == 0) break;
            body.append(chunk.data(), read);
            if (body.size() > MAX_DOWNLOAD) break;
        }
    }
    const DWORD err = GetLastError();
    if (req) WinHttpCloseHandle(req);
    if (con) WinHttpCloseHandle(con);
    WinHttpCloseHandle(ses);
    if (!ok) throw std::runtime_error("Download failed (Windows error " + std::to_string(err) + "). Check the internet connection or proxy.");
    if (status < 200 || status >= 300) throw std::runtime_error(http_error(long(status), body));
    return body;
}
#else
std::string http_get(const std::string& url, const std::string& user_agent) {
    static bool init = (curl_global_init(CURL_GLOBAL_DEFAULT), true);
    (void)init;
    CURL* c = curl_easy_init();
    if (!c) throw std::runtime_error("curl init failed");
    std::string body;
    curl_easy_setopt(c, CURLOPT_URL, url.c_str());
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(c, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(c, CURLOPT_TIMEOUT, 120L);
    curl_easy_setopt(c, CURLOPT_USERAGENT, user_agent.c_str());
    curl_easy_setopt(c, CURLOPT_ACCEPT_ENCODING, "");
    CURLcode rc = curl_easy_perform(c);
    long status = 0;
    curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(c);
    if (rc != CURLE_OK) throw std::runtime_error(std::string("Download failed: ") + curl_easy_strerror(rc));
    if (status < 200 || status >= 300) throw std::runtime_error(http_error(status, body));
    return body;
}
#endif

json::Value fetch_weather(const std::string& source, double lat, double lon, int year) {
    if (source == "pvgis_tmy") return pvgis_tmy(lat, lon);
    if (source == "pvgis_year") return pvgis_year(lat, lon, year);
    if (source == "nasa_power") return nasa_power(lat, lon, year);
    throw std::runtime_error("Unknown weather source: " + source);
}

json::Value fetch_weather_years(const std::string& source, double lat, double lon, int y0, int y1) {
    if (y0 > y1) std::swap(y0, y1);
    if (source == "pvgis") return pvgis_years(lat, lon, y0, y1);
    if (source == "nasa_power") return nasa_power_years(lat, lon, y0, y1);
    throw std::runtime_error("Unknown weather source: " + source);
}

json::Value pvgis_split_years(const json::Value& d, double lat, double lon) { return pvgis_rows_by_year(d, lat, lon); }

json::Value fetch_forecast(const std::string& provider, double lat, double lon, int days, const std::string& api_key) {
    if (provider == "met_norway") return met_norway(lat, lon, days);
    return open_meteo(lat, lon, days, api_key);
}

long iso_to_epoch_h(const std::string& iso) {
    int y, mo, d, h, end = 0;
    if (std::sscanf(iso.c_str(), "%4d-%2d-%2dT%2d%n", &y, &mo, &d, &h, &end) != 4 || end == 0) return NO_TIME_H;
    // minutes, seconds and a final Z may follow; an offset from UTC (+hh:mm, -hh:mm) may not
    for (size_t i = size_t(end); i < iso.size(); ++i)
        if (!std::isdigit(static_cast<unsigned char>(iso[i])) && iso[i] != ':' && iso[i] != '.' && iso[i] != 'Z') return NO_TIME_H;
    static const int mdays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > mdays[mo - 1] + (mo == 2 && leap) || h < 0 || h > 23) return NO_TIME_H;
    return days_from_civil(y, unsigned(mo), unsigned(d)) * 24 + h;
}

std::string epoch_h_to_iso(long h) {
    const long days = (h >= 0 ? h : h - 23) / 24;   // floor
    int y;
    unsigned m, d;
    civil_from_days(days, y, m, d);
    char b[40];
    std::snprintf(b, sizeof b, "%04d-%02u-%02uT%02ld:00", y, m, d, h - days * 24);
    return b;
}

namespace {
std::mutex yield_m;
std::map<std::string, json::Value> yield_cache;   // PVcalc answers by request URL
} // namespace

json::Value pvgis_pvcalc(double lat, double lon, double loss_pct, double angle, double aspect, bool tracker) {
    const std::string url = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=" + fmt(lat) + "&lon=" + fmt(lon) + "&peakpower=1&loss=" +
                            fmt(loss_pct) + (tracker ? "&fixed=0&inclined_axis=1&inclinedaxisangle=0" : "&angle=" + fmt(angle) + "&aspect=" + fmt(aspect)) +
                            "&mountingplace=free&pvtechchoice=crystSi&outputformat=json";
    // The yield is recalculated after every PV edit; PVGIS is asked again only when the request changes.
    {
        std::lock_guard<std::mutex> g(yield_m);
        auto it = yield_cache.find(url);
        if (it != yield_cache.end()) return it->second;
    }
    json::Value d = json::parse(http_get(url));
    const char* kind = tracker ? "inclined_axis" : "fixed";
    const auto& tot = d["outputs"]["totals"][kind];
    std::vector<double> em(12, 0.0);
    int months = 0;
    for (const auto& r : d["outputs"]["monthly"][kind].arr()) {
        const int mo = int(r.get("month", 0));
        if (mo >= 1 && mo <= 12) { em[mo - 1] = r.get("E_m", 0); ++months; }
    }
    if (!tot.has("E_y") || months != 12) throw std::runtime_error("PVGIS returned no PV yield for this location.");
    const auto& md = d["inputs"]["meteo_data"];
    json::Value o(json::Object{{"ey", tot.get("E_y", 0)}, {"em", json::Value(em)}, {"hi_y", tot.get("H(i)_y", 0)},
                               {"radiation_db", md.gets("radiation_db", "PVGIS")}, {"year_min", md.get("year_min", 0)},
                               {"year_max", md.get("year_max", 0)}});
    std::lock_guard<std::mutex> g(yield_m);
    if (yield_cache.size() >= 64) yield_cache.clear();
    yield_cache[url] = o;
    return o;
}

int clear_yield_cache() {
    std::lock_guard<std::mutex> g(yield_m);
    const int n = int(yield_cache.size());
    yield_cache.clear();
    return n;
}
