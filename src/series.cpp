// Timestamped load and weather import with hourly averaging and a gap report, and the data checks of the project's weather
// and load (see series.hpp).
#include "series.hpp"
#include "pv.hpp"
#include "weather.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <stdexcept>
#include <vector>

namespace {

constexpr double PI = 3.14159265358979323846;
constexpr size_t MAX_COL = 256;           // cells read per row
constexpr size_t MAX_ROWS = 1500000;      // rows with data, about three years of 1-minute values
constexpr long long DAY = 1440;           // minutes
constexpr long long YEAR = 365 * DAY;
constexpr int MONTH_START[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
constexpr int MDAYS[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
const char* const MONTHS[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
const char* const KEYS[5] = {"ghi", "dni", "dhi", "tamb", "wind"};
const char* const VARS[5] = {"GHI", "DNI", "DHI", "temperature", "wind speed"};
const double NONE = std::numeric_limits<double>::quiet_NaN();

[[noreturn]] void fail(const std::string& m) { throw std::runtime_error(m); }
bool is_leap(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }
int month_of_day(int d) { return int(std::upper_bound(MONTH_START, MONTH_START + 12, d) - MONTH_START) - 1; }
long long floor_div(long long a, long long b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
long long day_of(int y, int m, int d) { return days_from_civil(y, unsigned(m), unsigned(d)); }
int year_of_day(long long day) { int y; unsigned m, d; civil_from_days(long(day), y, m, d); return y; }

// "2025-01-13 00:15" for minutes since 1970-01-01 00:00
std::string fmt_min(long long t) {
    const long long day = floor_div(t, DAY), r = t - day * DAY;
    int y;
    unsigned m, d;
    civil_from_days(long(day), y, m, d);
    char b[48];
    std::snprintf(b, sizeof b, "%04d-%02u-%02u %02d:%02d", y, m, d, int(r / 60), int(r % 60));
    return b;
}
// "3 Mar 14:00" for hour h of a 365-day year
std::string fmt_hour(int h) {
    const int d = h / 24, m = month_of_day(d);
    char b[32];
    std::snprintf(b, sizeof b, "%d %s %02d:00", d - MONTH_START[m] + 1, MONTHS[m], h % 24);
    return b;
}
double quantile(std::vector<double> v, double q) {   // linear between order statistics; v not empty
    std::sort(v.begin(), v.end());
    const double x = q * double(v.size() - 1);
    const size_t i = size_t(x);
    return i + 1 < v.size() ? v[i] + (x - double(i)) * (v[i + 1] - v[i]) : v[i];
}

// ---------------------------------------------------------------- options
struct Opt {
    bool load = true;
    int time_col = -1, time2_col = -1;
    std::vector<int> cols;                    // load columns, summed
    int wcol[5] = {-1, -1, -1, -1, -1};       // weather columns: ghi, dni, dhi, tamb, wind
    char order = 'a';                         // date order: a(uto), y(md), d(my), m(dy)
    std::string basis = "local_standard", label = "auto";
    std::string u_load = "kw", u_irr = "w_m2", u_temp = "c", u_wind = "m_s";
    int year = 0;                             // 0: the year with most data
    bool last12 = false, fill_long = false;
    long long off = 0;                        // standard UTC offset of the site, minutes
    std::vector<long long> at, clk;           // local_clock: UTC minutes of each change, offsets in minutes (clk[k] before at[k])
};

int opt_int(const json::Value& o, const char* k, int def, int lo, int hi, const std::string& what) {
    const json::Value& v = o[k];
    if (v.is_null()) return def;
    const double x = v.num(NONE);
    if (!(x >= lo && x <= hi) || x != std::floor(x))
        fail(what + " must be a whole number from " + std::to_string(lo) + " to " + std::to_string(hi) + ".");
    return int(x);
}
std::string opt_enum(const json::Value& o, const char* k, const char* def, std::initializer_list<const char*> allowed, const std::string& what) {
    const std::string s = o.gets(k, def);
    for (const char* a : allowed) if (s == a) return s;
    fail("Unknown " + what + ": \"" + s.substr(0, 40) + "\".");
}

Opt parse_opt(const json::Value& j) {
    if (!j.is_object()) fail("The import options are missing.");
    Opt o;
    const int top = int(MAX_COL) - 1;
    o.load = opt_enum(j, "kind", "load", {"load", "weather"}, "kind of data") == "load";
    o.time_col = opt_int(j, "time_col", -1, -1, top, "The time column");
    o.time2_col = o.time_col < 0 ? -1 : opt_int(j, "time2_col", -1, -1, top, "The time-of-day column");
    if (o.load) {
        const auto& c = j["cols"].arr();
        if (c.empty() || c.size() > 32) fail("Choose from 1 to 32 load columns.");
        for (const auto& x : c) {
            const double v = x.num(NONE);
            if (!(v >= 0 && v <= top) || v != std::floor(v)) fail("Load columns must be column numbers from 1 to " + std::to_string(MAX_COL) + ".");
            if (std::find(o.cols.begin(), o.cols.end(), int(v)) != o.cols.end()) fail("Each load column can be chosen only once.");
            o.cols.push_back(int(v));
        }
    } else {
        for (int k = 0; k < 5; ++k) o.wcol[k] = opt_int(j, KEYS[k], -1, -1, top, std::string("The ") + VARS[k] + " column");
        if (o.wcol[0] < 0) fail("Choose the GHI column.");
    }
    for (int c : o.load ? o.cols : std::vector<int>(o.wcol, o.wcol + 5))
        if (c >= 0 && (c == o.time_col || c == o.time2_col)) fail("A value column cannot also be the time column.");
    const std::string ord = opt_enum(j, "date_order", "auto", {"auto", "ymd", "dmy", "mdy"}, "date order");
    o.order = ord == "auto" ? 'a' : ord[0];
    o.basis = opt_enum(j, "time_basis", "local_standard", {"utc", "local_standard", "local_clock"}, "time basis");
    o.label = opt_enum(j, "label", "auto", {"auto", "start", "end", "instant"}, "timestamp label");
    if (o.load) o.u_load = opt_enum(j, "units", "kw", {"kw", "w", "mw", "kwh_interval", "mwh_interval"}, "load unit");
    else {
        o.u_irr = opt_enum(j, "irr_units", "w_m2", {"w_m2", "wh_m2_interval", "kwh_m2_interval", "mj_m2_interval"}, "irradiance unit");
        o.u_temp = opt_enum(j, "temp_units", "c", {"c", "k"}, "temperature unit");
        o.u_wind = opt_enum(j, "wind_units", "m_s", {"m_s", "km_h"}, "wind speed unit");
    }
    const json::Value& y = j["year"];
    if (y.is_string() && y.str() == "last12") {
        if (!o.load) fail("The last 12 months can be taken only from a load file.");
        o.last12 = true;
    } else if (!y.is_null() && !(y.is_string() && (y.str() == "auto" || y.str().empty()))) o.year = opt_int(j, "year", 0, 1900, 2200, "The year");
    o.fill_long = j.getb("fill_long", false);
    const double off = j.get("utc_offset", 0);
    if (!(std::fabs(off) <= 14)) fail("UTC offset must be between -14 h and +14 h.");
    o.off = std::llround(off * 60);
    if (o.basis == "local_clock") {
        if (o.time_col < 0) fail("Clock time with daylight saving needs a time column.");
        const json::Value& c = j["clock"];
        const double s = c.get("start", NONE);
        const auto& ch = c["changes"].arr();
        if (!(std::fabs(s) <= 14) || ch.size() > 4000) fail("The daylight-saving calendar of the time zone is missing or invalid.");
        o.clk.push_back(std::llround(s * 60));
        for (const auto& x : ch) {
            const double t = x[0].num(NONE), h = x[1].num(NONE);
            if (!(std::fabs(t) < 1e11) || !(std::fabs(h) <= 14) || (!o.at.empty() && std::llround(t) <= o.at.back()))
                fail("The clock changes of the time zone must be in time order, with offsets within 14 h of UTC.");
            o.at.push_back(std::llround(t));
            o.clk.push_back(std::llround(h * 60));
        }
    }
    return o;
}

// ---------------------------------------------------------------- CSV
std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}
// Delimiter of a CSV file, as csvDelimOf in web/js/util.js chooses it (so column numbers match its preview): of ';', tab and
// ',', the one that splits most of the first 20 non-blank lines evenly (the same count on the most lines; ties in that order).
// A title or metadata line above the data (PVGIS puts tab-separated lines above its comma-separated rows) does not decide it.
char detect_delim(const std::vector<std::string>& lines) {
    char best = ',';
    size_t top = 0;
    for (char d : {';', '\t', ','}) {
        std::map<long, size_t> n;
        for (const auto& l : lines)
            if (const long c = long(std::count(l.begin(), l.end(), d))) ++n[c];
        for (const auto& kv : n)
            if (kv.second > top) { top = kv.second; best = d; }
    }
    return best;
}
// Calls fn(line number, cells) for every non-blank line, split as parseCSV splits it: quoted fields may hold the delimiter, ""
// is a literal quote, cells are trimmed. fn returns false to stop.
template <class F>
void for_rows(const std::string& text, char delim, F fn) {
    std::vector<std::string> cells;
    std::string cur;
    size_t p = text.compare(0, 3, "\xEF\xBB\xBF") == 0 ? 3 : 0;
    for (int no = 1; p < text.size(); ++no) {
        size_t q = text.find('\n', p);
        if (q == std::string::npos) q = text.size();
        const size_t e = q > p && text[q - 1] == '\r' ? q - 1 : q;
        bool blank = true;
        for (size_t i = p; i < e && blank; ++i) blank = std::isspace(static_cast<unsigned char>(text[i])) != 0;
        if (!blank) {
            cells.clear();
            cur.clear();
            bool quoted = false;
            for (size_t i = p; i < e; ++i) {
                const char ch = text[i];
                if (quoted) {
                    if (ch == '"' && i + 1 < e && text[i + 1] == '"') { cur += '"'; ++i; }
                    else if (ch == '"') quoted = false;
                    else cur += ch;
                } else if (ch == '"') quoted = true;
                else if (ch == delim) { cells.push_back(trim(cur)); cur.clear(); }
                else cur += ch;
                if (cells.size() >= MAX_COL) break;
            }
            if (cells.size() < MAX_COL) cells.push_back(trim(cur));
            if (!fn(no, cells)) return;
        }
        p = q + 1;
    }
}
// A number filling the whole cell; with ';' as delimiter a decimal comma is read too ("12,5").
bool to_num(const std::string& s, bool comma, double& v) {
    if (s.empty()) return false;
    std::string t = s;
    if (comma && t.find(',') != std::string::npos && t.find('.') == std::string::npos) std::replace(t.begin(), t.end(), ',', '.');
    char* e;
    v = std::strtod(t.c_str(), &e);
    return e != t.c_str() && *e == '\0' && std::isfinite(v);
}
bool cell_num(const std::vector<std::string>& c, int col, bool comma, double& v) {
    return col >= 0 && size_t(col) < c.size() && to_num(c[size_t(col)], comma, v);
}

// ---------------------------------------------------------------- timestamps
// A time cell split into its parts before the date order is known.
struct RawTime {
    bool serial = false;           // Excel serial day number (1900 date system)
    double days = 0;
    int f[3] = {0, 0, 0};          // date fields in file order
    int n[3] = {0, 0, 0};          // their digit counts
    int mod = 0;                   // minute of the day (1440 for 24:00)
    bool tz = false;               // explicit offset from UTC (Z, UTC, +hh:mm)
    int tz_min = 0;
};

bool read_int(const char*& p, const char* e, int maxd, int& v, int& n) {
    v = 0;
    n = 0;
    while (p < e && n < maxd && std::isdigit(static_cast<unsigned char>(*p))) { v = v * 10 + (*p - '0'); ++p; ++n; }
    return n > 0;
}
void skip_sp(const char*& p, const char* e) { while (p < e && *p == ' ') ++p; }
bool upper_is(const char* p, const char* e, const char* w) {
    for (; *w; ++w, ++p) if (p >= e || std::toupper(static_cast<unsigned char>(*p)) != *w) return false;
    return true;
}
// "H:MM", "HH:MM:SS(.fff)" or compact "HHMM", with an optional AM/PM, rounded to the minute.
bool parse_clock(const char*& p, const char* e, bool compact, int& mod) {
    int h, nh, m, nm;
    double s = 0;
    if (compact) {
        if (!read_int(p, e, 2, h, nh) || nh != 2 || !read_int(p, e, 2, m, nm) || nm != 2) return false;
    } else {
        if (!read_int(p, e, 2, h, nh) || p >= e || *p != ':') return false;
        ++p;
        if (!read_int(p, e, 2, m, nm) || nm != 2) return false;
        if (p < e && *p == ':') {
            ++p;
            int si, ns;
            if (!read_int(p, e, 2, si, ns) || ns != 2) return false;
            s = si;
            if (p < e && *p == '.') for (double f = 0.1; ++p < e && std::isdigit(static_cast<unsigned char>(*p)); f /= 10) s += (*p - '0') * f;
        }
    }
    const char* q = p;
    skip_sp(q, e);
    if ((upper_is(q, e, "AM") || upper_is(q, e, "PM")) && (q + 2 == e || !std::isalpha(static_cast<unsigned char>(q[2])))) {
        if (h < 1 || h > 12) return false;
        h = h % 12 + (std::toupper(static_cast<unsigned char>(*q)) == 'P' ? 12 : 0);
        p = q + 2;
    }
    if (m > 59 || s >= 61 || h > 24 || (h == 24 && (m > 0 || s > 0))) return false;
    mod = int(std::lround(h * 60 + m + s / 60.0));
    return true;
}
// Optional offset after the time: Z, UTC or GMT, and/or +hh[:mm] / -hhmm; nothing may follow.
bool parse_tz(const char*& p, const char* e, RawTime& r) {
    skip_sp(p, e);
    if (p < e && (*p == 'Z' || *p == 'z')) { r.tz = true; ++p; }
    else if (upper_is(p, e, "UTC") || upper_is(p, e, "GMT")) { r.tz = true; p += 3; }
    if (p < e && (*p == '+' || *p == '-')) {
        const int sign = *p == '-' ? -1 : 1;
        ++p;
        int h, nh, m = 0, nm = 0;
        if (!read_int(p, e, 2, h, nh) || nh != 2) return false;
        if (p < e && *p == ':') ++p;
        if (p < e && std::isdigit(static_cast<unsigned char>(*p)) && (!read_int(p, e, 2, m, nm) || nm != 2)) return false;
        if (h > 14 || m > 59) return false;
        r.tz = true;
        r.tz_min = sign * (h * 60 + m);
    }
    skip_sp(p, e);
    return p == e;
}
// Splits a time cell: Excel serial days, "2025-01-13T00:15:00+08:00", "2025/1/13 0:15", "13.01.2025 00:15", "1/13/2025 12:15 AM",
// PVGIS "20250113:0010" or a date alone.
bool split_time(const std::string& s, bool comma, RawTime& r) {
    r = RawTime{};
    const char* p = s.data();
    const char* e = p + s.size();
    bool compact = e - p >= 8;
    for (int i = 0; i < 8 && compact; ++i) compact = std::isdigit(static_cast<unsigned char>(p[i])) != 0;
    if (compact && (e - p == 8 || !std::isdigit(static_cast<unsigned char>(p[8])) || e - p == 12)) {
        r.f[0] = std::atoi(std::string(p, 4).c_str()); r.f[1] = std::atoi(std::string(p + 4, 2).c_str()); r.f[2] = std::atoi(std::string(p + 6, 2).c_str());
        r.n[0] = 4; r.n[1] = 2; r.n[2] = 2;
        p += 8;
        if (p < e && (*p == ':' || *p == 'T' || *p == ' ')) ++p;
        if (p < e && std::isdigit(static_cast<unsigned char>(*p))) {
            const bool colon = e - p >= 3 && p[2] == ':';
            if (!parse_clock(p, e, !colon, r.mod)) return false;
        }
        return parse_tz(p, e, r);
    }
    double x;
    if (to_num(s, comma, x)) {
        if (x < 20000 || x > 80000) return false;
        r.serial = true;
        r.days = x;
        return true;
    }
    char sep = 0;
    for (int k = 0; k < 3; ++k) {
        if (!read_int(p, e, 4, r.f[k], r.n[k])) return false;
        if (k == 2) break;
        if (p >= e || (*p != '-' && *p != '/' && *p != '.') || (sep && *p != sep)) return false;
        sep = *p++;
    }
    if (p < e && (*p == 'T' || *p == ' ' || *p == ',')) { ++p; skip_sp(p, e); }
    if (p < e && std::isdigit(static_cast<unsigned char>(*p)) && !parse_clock(p, e, false, r.mod)) return false;
    return parse_tz(p, e, r);
}
// Wall-clock minutes since 1970 of a split time with the date order resolved (y, d or m); false for an impossible date.
bool wall_minutes(const RawTime& r, char order, long long& wall) {
    if (r.serial) {   // days since 1899-12-30, which absorbs Excel's phantom 29 February 1900
        const double whole = std::floor(r.days);
        wall = (day_of(1899, 12, 30) + (long long)whole) * DAY + std::llround((r.days - whole) * DAY);
        return true;
    }
    int y, m, d, ny;
    if (r.n[0] >= 3 || order == 'y') { y = r.f[0]; m = r.f[1]; d = r.f[2]; ny = r.n[0]; }
    else if (order == 'd') { d = r.f[0]; m = r.f[1]; y = r.f[2]; ny = r.n[2]; }
    else { m = r.f[0]; d = r.f[1]; y = r.f[2]; ny = r.n[2]; }
    if (ny <= 2) y += y < 70 ? 2000 : 1900;
    if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > MDAYS[m - 1] + (m == 2 && is_leap(y))) return false;
    wall = day_of(y, m, d) * DAY + r.mod;
    return true;
}
// The time of a row: the time cell, plus the time-of-day cell when the time is in its own column ("HH:MM" or an Excel day fraction).
bool row_time(const std::vector<std::string>& c, const Opt& o, bool comma, RawTime& r) {
    if (size_t(o.time_col) >= c.size() || !split_time(c[size_t(o.time_col)], comma, r)) return false;
    if (o.time2_col < 0) return true;
    if (size_t(o.time2_col) >= c.size()) return false;
    const std::string& s = c[size_t(o.time2_col)];
    double x;
    int mod;
    const char* p = s.data();
    if (to_num(s, comma, x) && x >= 0 && x < 1) mod = int(std::lround(x * DAY));
    else if (!parse_clock(p, s.data() + s.size(), false, mod) || !parse_tz(p, s.data() + s.size(), r)) return false;
    if (r.serial) r.days += mod / double(DAY);
    else r.mod += mod;
    return true;
}
// Local clock time to UTC with the zone's offsets. In the hour repeated at the end of daylight saving a stamp takes the earlier
// period on its first occurrence and the later one on the next; a clock time skipped at the start of daylight saving takes the
// offset before the change (counted in skipped).
long long clock_utc(const Opt& o, long long wall, std::map<long long, int>& seen, int& skipped) {
    const size_t K = o.at.size(), g = size_t(std::upper_bound(o.at.begin(), o.at.end(), wall - o.off) - o.at.begin());
    long long cand[3];
    int nc = 0;
    for (size_t k = g > 0 ? g - 1 : 0; k <= std::min(K, g + 1); ++k) {
        const long long u = wall - o.clk[k];
        if ((k == 0 || u >= o.at[k - 1]) && (k == K || u < o.at[k])) cand[nc++] = u;
    }
    if (nc == 0) { ++skipped; return wall - o.clk[g > 0 ? g - 1 : 0]; }
    if (nc == 1) return cand[0];
    return seen[wall]++ == 0 ? cand[0] : cand[nc - 1];
}

// ---------------------------------------------------------------- samples
// One sample in the output time base: it covers [a, b) minutes with mean values in kW, or W/m2, degC and m/s (NaN = none).
struct Sample { double a, b; double v[5]; };

double energy_factor(const std::string& u, double len) {   // interval energy to mean power over len minutes
    return u == "kwh_interval" || u == "wh_m2_interval" ? 60.0 / len : u == "mwh_interval" || u == "kwh_m2_interval" ? 60000.0 / len
         : u == "mj_m2_interval" ? 1e6 / (60.0 * len) : u == "w" ? 1e-3 : u == "mw" ? 1e3 : 1.0;
}
void convert(const Opt& o, Sample& s) {
    const double len = s.b - s.a;
    if (o.load) { s.v[0] *= energy_factor(o.u_load, len); return; }
    for (int k = 0; k < 3; ++k) s.v[k] *= energy_factor(o.u_irr, len);
    if (o.u_temp == "k") s.v[3] -= 273.15;
    if (o.u_wind == "km_h") s.v[4] /= 3.6;
}
// Values of a row: load columns summed (false when one is not a number); weather columns or NaN (false when none is a number).
bool row_values(const std::vector<std::string>& c, const Opt& o, bool comma, double* v) {
    std::fill(v, v + 5, NONE);
    if (o.load) {
        double s = 0, x;
        for (int col : o.cols) { if (!cell_num(c, col, comma, x)) return false; s += x; }
        v[0] = s;
        return true;
    }
    bool any = false;
    for (int k = 0; k < 5; ++k) {
        double x;
        if (cell_num(c, o.wcol[k], comma, x)) { v[k] = x; any = true; }
    }
    return any;
}
std::string col_list(const Opt& o) {
    std::string s;
    for (size_t i = 0; i < o.cols.size(); ++i) s += (i ? ", " : "") + std::to_string(o.cols[i] + 1);
    return s;
}

// One row per interval in file order from 1 January 00:00 (no time column). A first row without a load or GHI value is a
// header; for load any later row without a number is an error naming its line, for weather a missing cell is a gap. The year
// is wrapped around, so a shift to the output time base keeps every hour.
std::vector<Sample> positional(const std::string& text, char delim, const Opt& o, long long shift, json::Value& rep) {
    const bool comma = delim == ';';
    std::vector<std::array<double, 5>> vals;
    bool first = true;
    int lines = 0;
    for_rows(text, delim, [&](int no, const std::vector<std::string>& c) {
        std::array<double, 5> v;
        const bool ok = row_values(c, o, comma, v.data());
        if (first) { first = false; if (o.load ? !ok : std::isnan(v[0])) return true; }
        ++lines;
        if (o.load && !ok)
            fail("Line " + std::to_string(no) + " has no number in column " + col_list(o) + ": without a time column every row must hold one interval.");
        if (vals.size() >= 35136) fail("More rows than one year of quarter-hourly values (35,136): choose the time column.");
        vals.push_back(v);
        return true;
    });
    const size_t n = vals.size();
    const int per_h = n == 8760 || n == 8784 ? 1 : n == 17520 || n == 17568 ? 2 : n == 35040 || n == 35136 ? 4 : 0;
    if (!per_h)
        fail("Without a time column the file must hold one year: 8760 hourly, 17520 half-hourly or 35040 quarter-hourly rows (one day more in a "
             "leap year). It has " + std::to_string(n) + ".");
    if (n == size_t(366 * 24 * per_h)) vals.erase(vals.begin() + 59 * 24 * per_h, vals.begin() + 60 * 24 * per_h);
    const long long dt = 60 / per_h, base = day_of(2001, 1, 1) * DAY;
    std::vector<Sample> S;
    S.reserve(vals.size() * 3);
    for (size_t i = 0; i < vals.size(); ++i) {
        const long long wall = base + (long long)i * dt, t = (o.basis == "utc" ? wall : wall - o.off) + shift;
        Sample s{double(t), double(t + dt), {}};
        std::copy(vals[i].begin(), vals[i].end(), s.v);
        convert(o, s);
        for (long long w : {-YEAR, 0LL, YEAR}) S.push_back({s.a + double(w), s.b + double(w), {s.v[0], s.v[1], s.v[2], s.v[3], s.v[4]}});
    }
    rep["positional"] = true;
    rep["rows"] = lines;
    rep["parsed"] = int(n);
    rep["interval_min"] = int(dt);
    rep["label"] = "start";
    return S;
}

// Rows with a time column: header lines skipped, stamps to UTC and the output time base, sorted, duplicates averaged, the
// interval found, then each sample's span from its label and its neighbours.
std::vector<Sample> timestamped(const std::string& text, char delim, const Opt& o, long long shift, json::Value& rep) {
    const bool comma = delim == ';';
    // pass 1: header lines (before the first readable time) and the date order
    int header = 0;
    bool started = false, any_short = false, first_big = false, second_big = false, excel = false;
    for_rows(text, delim, [&](int, const std::vector<std::string>& c) {
        RawTime r;
        if (!row_time(c, o, comma, r)) { if (!started) ++header; return true; }
        started = true;
        excel = excel || r.serial;
        if (!r.serial && r.n[0] <= 2) { any_short = true; first_big = first_big || r.f[0] > 12; second_big = second_big || r.f[1] > 12; }
        return true;
    });
    if (!started) fail("No line of the file has a time in column " + std::to_string(o.time_col + 1) + " that can be read.");
    char order = o.order;
    if (!any_short) order = 'y';
    else if (order == 'a') {
        if (first_big && second_big) fail("Some dates have a first field above 12 and others a second field above 12: check the time column.");
        if (!first_big && !second_big)
            fail("The dates are ambiguous: no day number above 12, so they read as day/month/year and as month/day/year. Choose the date order.");
        order = first_big ? 'd' : 'm';
    }
    // pass 2: rows
    struct Row { long long t, wall; double v[5]; };
    std::vector<Row> rows;
    json::Value bad = json::Value::array();
    int idx = 0, lines = 0, n_bad = 0, skipped = 0;
    long long out_of_order = 0;
    std::map<long long, int> seen;
    for_rows(text, delim, [&](int no, const std::vector<std::string>& c) {
        if (idx++ < header) return true;
        ++lines;
        RawTime r;
        long long wall;
        Row row;
        if (!row_time(c, o, comma, r) || !wall_minutes(r, order, wall) || !row_values(c, o, comma, row.v)) {
            if (n_bad++ < 5) bad.push(no);
            return true;
        }
        if (rows.size() >= MAX_ROWS) fail("The file has more than 1,500,000 rows with data: split it by year.");
        const long long utc = r.tz ? wall - r.tz_min : o.basis == "utc" ? wall : o.basis == "local_standard" ? wall - o.off : clock_utc(o, wall, seen, skipped);
        row.t = utc + shift;
        row.wall = wall;
        if (!rows.empty() && row.t < rows.back().t) ++out_of_order;
        rows.push_back(row);
        return true;
    });
    if (rows.size() < 2) fail("Fewer than two rows with a time and a value: check the columns.");
    std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.t < b.t; });
    // duplicate stamps: each variable averaged over the rows that have it
    std::vector<Row> u;
    std::vector<long long> dup_at;
    long long dups = 0;
    for (size_t i = 0; i < rows.size();) {
        size_t j = i;
        double s[5] = {0, 0, 0, 0, 0}, n[5] = {0, 0, 0, 0, 0};
        for (; j < rows.size() && rows[j].t == rows[i].t; ++j)
            for (int k = 0; k < 5; ++k) if (!std::isnan(rows[j].v[k])) { s[k] += rows[j].v[k]; ++n[k]; }
        Row m = rows[i];
        for (int k = 0; k < 5; ++k) m.v[k] = n[k] > 0 ? s[k] / n[k] : NONE;
        if (j - i > 1) { dups += (long long)(j - i - 1); dup_at.push_back(rows[i].t); }
        u.push_back(m);
        i = j;
    }
    if (u.size() < 2) fail("Every row has the same time: check the time column.");
    // interval: the most common step, rounded to the minute; other steps covering over 5 % of the rows are reported with the
    // runs (3 steps or more) in which they occur
    const size_t nd = u.size() - 1;
    std::vector<long long> d(nd);
    std::map<long long, long long> count;
    for (size_t j = 0; j < nd; ++j) ++count[d[j] = u[j + 1].t - u[j].t];
    long long dt = 0, best = 0;
    for (const auto& kv : count) if (kv.second > best) { best = kv.second; dt = kv.first; }
    if (dt > 60)
        fail("The most common step between timestamps is " + std::to_string(dt) + " min: the import needs hourly or shorter intervals.");
    std::vector<int> run(nd, 1);   // length of the run of equal steps each step belongs to
    for (size_t a = 0; a < nd;) {
        size_t b = a + 1;
        while (b < nd && d[b] == d[a]) ++b;
        for (size_t j = a; j < b; ++j) run[j] = int(b - a);
        a = b;
    }
    std::vector<char> rate(nd);
    for (size_t j = 0; j < nd; ++j) rate[j] = d[j] == dt || (d[j] <= 60 && run[j] >= 3);
    json::Value changes = json::Value::array();
    for (const auto& kv : count) {
        if (kv.first == dt || kv.second * 20 <= (long long)u.size()) continue;
        json::Value ranges = json::Value::array();
        for (size_t a = 0; a < nd && ranges.size() < 5;) {
            if (d[a] != kv.first || run[a] < 3) { ++a; continue; }
            ranges.push(json::Value(json::Array{fmt_min(u[a].t), fmt_min(u[a + size_t(run[a])].t)}));
            a += size_t(run[a]);
        }
        changes.push(json::Value(json::Object{{"interval_min", kv.first}, {"rows", kv.second}, {"ranges", ranges}}));
    }
    // daylight saving read as standard time: one hour missing in spring and one doubled in autumn (either hemisphere)
    bool dst = false;
    if (o.basis == "local_standard") {
        auto month = [](long long t) { int y; unsigned m, dd; civil_from_days(long(floor_div(t, DAY)), y, m, dd); return int(m); };
        bool gap_ma = false, gap_so = false, dup_ma = false, dup_so = false;
        for (size_t j = 0; j < nd; ++j)
            if (d[j] == dt + 60) { const int m = month(u[j].t); gap_ma = gap_ma || m == 3 || m == 4; gap_so = gap_so || (m >= 9 && m <= 11); }
        for (long long t : dup_at) { const int m = month(t); dup_ma = dup_ma || m == 3 || m == 4; dup_so = dup_so || (m >= 9 && m <= 11); }
        dst = (gap_ma && dup_so) || (gap_so && dup_ma);
    }
    std::string label = o.label;
    if (label == "auto") {
        const long long f = ((u.front().wall % DAY) + DAY) % DAY, l = ((u.back().wall % DAY) + DAY) % DAY;
        label = f == dt && l == 0 ? "end" : "start";
    }
    std::vector<Sample> S(u.size());
    for (size_t j = 0; j < u.size(); ++j) {
        const bool rp = j > 0 && rate[j - 1], rn = j < nd && rate[j];
        const double dp = j > 0 ? double(d[j - 1]) : 0, dn = j < nd ? double(d[j]) : 0, t = double(u[j].t);
        const double before = rp ? dp : rn ? dn : double(dt), after = rn ? dn : rp ? dp : double(dt);
        Sample& s = S[j];
        if (label == "start") { s.a = t; s.b = t + after; }
        else if (label == "end") { s.a = t - before; s.b = t; }
        else { s.a = t - before / 2; s.b = t + after / 2; }
        std::copy(u[j].v, u[j].v + 5, s.v);
        convert(o, s);
    }
    rep["rows"] = lines;
    rep["parsed"] = int(rows.size());
    rep["header_lines"] = header;
    rep["bad_rows"] = bad;
    rep["n_bad"] = n_bad;
    rep["duplicates"] = dups;
    rep["out_of_order"] = out_of_order;
    rep["interval_min"] = dt;
    rep["rate_changes"] = changes;
    rep["first"] = fmt_min(u.front().t);
    rep["last"] = fmt_min(u.back().t);
    rep["label"] = label;
    rep["date_order"] = any_short ? std::string(order == 'd' ? "dmy" : order == 'm' ? "mdy" : "ymd") : std::string("ymd");
    rep["excel"] = excel;
    rep["dst_suspect"] = dst;
    rep["clock_skipped"] = skipped;
    return S;
}

// Load gaps: runs of up to 3 h are interpolated linearly; longer runs take the same hour a week earlier (a week later at the
// start of the series). Zeros are data, never gaps.
void fill_load(std::vector<double>& v, std::vector<char>& filled) {
    const size_t n = v.size();
    for (size_t a = 0; a < n;) {
        if (!std::isnan(v[a])) { ++a; continue; }
        size_t b = a;
        while (b < n && std::isnan(v[b])) ++b;
        for (size_t i = a; i < b; ++i) {
            filled[i] = 1;
            if (b - a <= 3 && a > 0 && b < n) v[i] = v[a - 1] + (v[b] - v[a - 1]) * double(i - a + 1) / double(b - a + 1);
            else if (i >= 168) v[i] = v[i - 168];
            else {
                size_t j = i + 168;
                while (j < n && std::isnan(v[j])) j += 168;
                v[i] = j < n ? v[j] : NONE;
            }
        }
        a = b;
    }
}
// Runs of missing hours: [start, length] pairs.
std::vector<std::pair<int, int>> missing_runs(const std::vector<char>& miss) {
    std::vector<std::pair<int, int>> r;
    for (int a = 0; a < HOURS;) {
        if (!miss[size_t(a)]) { ++a; continue; }
        int b = a;
        while (b < HOURS && miss[size_t(b)]) ++b;
        r.push_back({a, b - a});
        a = b;
    }
    return r;
}

// Samples to one year of hourly means: the year (or the last 365 days), the time-weighted mean of the samples overlapping
// each hour, 29 February dropped, gaps filled.
json::Value to_hours(const Opt& o, const std::vector<Sample>& S, json::Value& rep, int fixed_year) {
    const int nv = o.load ? 1 : 5;
    // minutes covered per calendar year of the output time base (by the primary value)
    std::map<int, double> per_year;
    double last_b = -1e300;
    for (const auto& s : S) {
        if (std::isnan(s.v[0])) continue;
        per_year[year_of_day(floor_div((long long)std::floor(s.a), DAY))] += s.b - s.a;
        last_b = std::max(last_b, s.b);
    }
    if (per_year.empty()) fail(o.load ? "No load values in the chosen columns." : "No GHI values in the chosen column.");
    json::Value years = json::Value::array();
    int year = fixed_year;
    double most = -1;
    for (const auto& kv : per_year) {
        if (!fixed_year) years.push(json::Value(json::Array{kv.first, std::round(kv.second / 60)}));
        if (!fixed_year && !o.year && kv.second >= most) { most = kv.second; year = kv.first; }
    }
    if (o.year && !fixed_year) {
        if (!per_year.count(o.year)) fail("The file has no data in " + std::to_string(o.year) + ": choose another year.");
        year = o.year;
    }
    // window of days (output time base) and the date of each calendar position
    long long day_a, day_b;
    int y_last = year, m_last = 12, d_last = 31;
    if (o.last12 && !fixed_year) {
        const long long last_day = floor_div((long long)std::ceil(last_b) - 1, DAY);
        unsigned m, dd;
        civil_from_days(long(last_day), y_last, m, dd);
        m_last = int(m);
        d_last = int(dd);
        day_b = last_day + 1;
        day_a = day_b - 366;
    } else {
        day_a = day_of(year, 1, 1);
        day_b = day_of(year + 1, 1, 1);
    }
    const int nh = int(day_b - day_a) * 24;
    const double W0 = double(day_a * DAY), W1 = W0 + nh * 60.0;
    std::vector<std::vector<double>> sw(size_t(nv), std::vector<double>(size_t(nh), 0.0)), swv = sw;
    for (const auto& s : S) {
        const double a = std::max(s.a, W0), b = std::min(s.b, W1);
        if (b <= a) continue;
        const int k1 = std::min(nh, int(std::ceil((b - W0) / 60)));
        for (int k = int(std::floor((a - W0) / 60)); k < k1; ++k) {
            const double ov = std::min(b, W0 + (k + 1) * 60.0) - std::max(a, W0 + k * 60.0);
            if (ov <= 0) continue;
            for (int v = 0; v < nv; ++v)
                if (!std::isnan(s.v[v])) { sw[size_t(v)][size_t(k)] += ov; swv[size_t(v)][size_t(k)] += ov * s.v[v]; }
        }
    }
    std::vector<std::vector<double>> out(size_t(nv), std::vector<double>(HOURS, NONE));
    std::vector<std::vector<char>> miss(size_t(nv), std::vector<char>(HOURS, 0));
    double cover = 0;
    long long used_a = std::numeric_limits<long long>::max(), used_b = std::numeric_limits<long long>::min();   // first and last day used
    for (int p = 0; p < 365; ++p) {
        const int m = month_of_day(p) + 1, dd = p - MONTH_START[m - 1] + 1;
        const int y = o.last12 && !fixed_year && (m > m_last || (m == m_last && dd > d_last)) ? y_last - 1 : o.last12 && !fixed_year ? y_last : year;
        const long long day = day_of(y, m, dd), k0 = (day - day_a) * 24;
        used_a = std::min(used_a, day);
        used_b = std::max(used_b, day);
        for (int h = 0; h < 24; ++h) {
            const size_t i = size_t(p * 24 + h), k = size_t(k0 + h);
            cover += std::min(1.0, sw[0][k] / 60);
            for (int v = 0; v < nv; ++v) {
                if (sw[size_t(v)][k] >= 30) out[size_t(v)][i] = swv[size_t(v)][k] / sw[size_t(v)][k];
                else miss[size_t(v)][i] = 1;
            }
        }
    }
    // the last 12 months skip 29 February, so with one in the window they start 366 days before their end
    const std::string period = o.last12 && !fixed_year ? fmt_min(used_a * DAY).substr(0, 10) + " to " + fmt_min(used_b * DAY).substr(0, 10)
                                                         : std::to_string(year);
    // gaps
    json::Value missing = json::Value::object();
    int max_gap = 0;
    std::vector<char> filled(HOURS, 0);
    const auto runs0 = missing_runs(miss[0]);
    if (o.load) {
        for (const auto& r : runs0) max_gap = std::max(max_gap, r.second);
        if (max_gap > 72 && !o.fill_long) {
            for (const auto& r : runs0)
                if (r.second == max_gap) { rep["long_gap"] = json::Value(json::Object{{"hours", max_gap}, {"from", fmt_hour(r.first)}}); break; }
        } else {
            fill_load(out[0], filled);
            for (int i = 0; i < HOURS; ++i) if (std::isnan(out[0][size_t(i)])) fail("Too few load values to fill the gaps: the file covers too little of " + period + ".");
            // the model needs the site's consumption: export (negative load) is refused, as the positional upload did
            const auto neg = std::find_if(out[0].begin(), out[0].end(), [](double x) { return x < 0; });
            if (neg != out[0].end())
                fail("The load is negative in " + std::to_string(std::count_if(out[0].begin(), out[0].end(), [](double x) { return x < 0; })) + " h, the first at " +
                     fmt_hour(int(neg - out[0].begin())) + ": Soloptima needs the site's consumption, without export.");
        }
    } else {
        const bool split = o.wcol[1] >= 0 && o.wcol[2] >= 0;
        for (int v = 0; v < 5; ++v) {
            if (o.wcol[v] < 0 || ((v == 1 || v == 2) && !split)) continue;   // DNI and DHI are used only together
            const auto rv = v ? missing_runs(miss[size_t(v)]) : runs0;
            int n_miss = 0, gap = 0, at = 0;
            for (const auto& r : rv) { n_miss += r.second; if (r.second > gap) { gap = r.second; at = r.first; } }
            if (n_miss == HOURS) fail(std::string("The ") + VARS[v] + " column has no numbers in " + period + ": choose another column, or none.");
            if (gap > 72)
                fail(std::string("No ") + VARS[v] + " for " + std::to_string(gap) + " h in a row from " + fmt_hour(at) + " in " + period +
                     " (at most 72 h can be filled): choose another year or fill the gap in the file.");
            missing[KEYS[v]] = n_miss;
            for (auto& x : out[size_t(v)]) if (std::isnan(x)) x = -999;
            out[size_t(v)] = fill_gaps(std::move(out[size_t(v)]), filled, max_gap);
        }
    }
    json::Value runs = json::Value::array();
    int n_miss0 = 0;
    for (const auto& r : runs0) { n_miss0 += r.second; if (runs.size() < 50) runs.push(json::Value(json::Array{r.first, r.second})); }
    rep["year"] = o.last12 && !fixed_year ? json::Value("last12") : fixed_year ? json::Value() : json::Value(year);
    rep["period"] = fixed_year ? json::Value("one year, row by row") : json::Value(period);
    rep["years"] = years;
    rep["base"] = o.load || o.basis != "utc" ? "local standard time" : "UTC";
    rep["coverage"] = cover / HOURS;
    rep["missing_h"] = n_miss0;
    rep["filled_h"] = int(std::count(filled.begin(), filled.end(), 1));
    rep["max_gap_h"] = max_gap;
    rep["runs"] = runs;
    json::Value notes = json::Value::array();
    json::Value res = json::Value::object();
    if (o.load) {
        if (!rep.has("long_gap")) res["kw"] = json::Value(out[0]);
    } else {
        rep["missing"] = missing;
        const bool split = o.wcol[1] >= 0 && o.wcol[2] >= 0;
        if ((o.wcol[1] >= 0) != (o.wcol[2] >= 0)) notes.push("DNI and DHI are used only together, so the one given was left out.");
        if (o.wcol[3] < 0) notes.push("No temperature column: 25 °C is assumed in every hour.");
        if (o.wcol[4] < 0) notes.push("No wind speed column: the module temperature assumes 1 m/s and wind turbines produce nothing.");
        res["ghi"] = json::Value(out[0]);
        res["dni"] = split ? json::Value(out[1]) : json::Value::array();
        res["dhi"] = split ? json::Value(out[2]) : json::Value::array();
        res["tamb"] = o.wcol[3] >= 0 ? json::Value(out[3]) : json::Value(std::vector<double>(HOURS, 25.0));
        res["wind"] = o.wcol[4] >= 0 ? json::Value(out[4]) : json::Value::array();
        res["is_utc"] = o.basis == "utc";
        res["time_offset"] = 0.5;
    }
    rep["notes"] = notes;
    res["report"] = rep;
    if (rep.has("long_gap")) res["long_gap"] = rep["long_gap"];
    return res;
}

// ---------------------------------------------------------------- data checks
// Per-hour flags of one data set: the hours of each flag and the flagged hours in time order.
struct Flags {
    struct F { std::string id, label; std::vector<char> hit; int hours = 0; };
    struct E { int i, k; double v; };
    std::vector<F> f;
    std::vector<E> list;
    int add(const char* id, const char* label) { f.push_back({id, label, std::vector<char>(HOURS, 0), 0}); return int(f.size()) - 1; }
    void mark(int k, int i, double v) {
        if (f[size_t(k)].hit[size_t(i)]) return;
        f[size_t(k)].hit[size_t(i)] = 1;
        ++f[size_t(k)].hours;
        list.push_back({i, k, v});
    }
    // local: file hour to local standard hour; ghi: for the share of the year's irradiation in flagged hours (weather)
    json::Value to_json(int shift, const std::vector<double>* ghi) {
        auto local = [&](int i) { return ((i + shift) % HOURS + HOURS) % HOURS; };
        double total = 0;
        if (ghi) for (double g : *ghi) total += std::max(0.0, g);
        std::vector<char> any(HOURS, 0), any_day(365, 0);
        json::Value flags = json::Value::array();
        for (const auto& x : f) {
            std::vector<char> day(365, 0);
            double g = 0;
            for (int i = 0; i < HOURS; ++i) {
                if (!x.hit[size_t(i)]) continue;
                any[size_t(i)] = 1;
                day[size_t(local(i) / 24)] = 1;
                any_day[size_t(local(i) / 24)] = 1;
                if (ghi) g += std::max(0.0, (*ghi)[size_t(i)]);
            }
            json::Value e(json::Object{{"id", x.id}, {"label", x.label}, {"hours", x.hours}, {"days", int(std::count(day.begin(), day.end(), 1))}});
            if (ghi) e["ghi_share"] = total > 0 ? g / total : 0.0;
            flags.push(e);
        }
        std::sort(list.begin(), list.end(), [](const E& a, const E& b) { return a.i != b.i ? a.i < b.i : a.k < b.k; });
        json::Value hours = json::Value::array();
        for (size_t j = 0; j < list.size() && j < 200; ++j)
            hours.push(json::Value(json::Object{{"i", list[j].i}, {"h", local(list[j].i)}, {"flag", f[size_t(list[j].k)].id}, {"v", list[j].v}}));
        double g_any = 0;
        json::Value days = json::Value::array();
        for (int d = 0; d < 365; ++d) if (any_day[size_t(d)]) days.push(d);
        if (ghi) for (int i = 0; i < HOURS; ++i) if (any[size_t(i)]) g_any += std::max(0.0, (*ghi)[size_t(i)]);
        json::Value o(json::Object{{"flags", flags}, {"hours", hours}, {"n_flagged", int(std::count(any.begin(), any.end(), 1))},
                                   {"n_list", int(list.size())}, {"days", days}, {"score", 1.0 - double(days.size()) / 365.0}});
        if (ghi) o["ghi_share"] = total > 0 ? g_any / total : 0.0;
        return o;
    }
};
bool constant(const std::vector<double>& v) { return std::all_of(v.begin(), v.end(), [&](double x) { return x == v[0]; }); }
// Runs of ok hours holding one non-zero value, at least min_len long.
template <class Ok>
void stuck(Flags& F, int k, const std::vector<double>& v, Ok ok, int min_len) {
    for (int a = 0; a < HOURS;) {
        if (!ok(a) || v[size_t(a)] == 0) { ++a; continue; }
        int b = a + 1;
        while (b < HOURS && ok(b) && v[size_t(b)] == v[size_t(a)]) ++b;
        if (b - a >= min_len) for (int i = a; i < b; ++i) F.mark(k, i, v[size_t(i)]);
        a = b;
    }
}
// The same value at the same hour on 3 or more consecutive days.
template <class Ok>
void copied(Flags& F, int k, const std::vector<double>& v, Ok ok) {
    for (int h = 0; h < 24; ++h)
        for (int d = 0; d < 365;) {
            const size_t i = size_t(d * 24 + h);
            if (!ok(int(i))) { ++d; continue; }
            int e = d + 1;
            while (e < 365 && ok(e * 24 + h) && v[size_t(e * 24 + h)] == v[i]) ++e;
            if (e - d >= 3) for (int x = d; x < e; ++x) F.mark(k, x * 24 + h, v[size_t(x * 24 + h)]);
            d = e;
        }
}

// Timing against the sun: the centroid of each clear day's irradiance against that of the clear-sky model, over 24 h centred
// on solar noon in the file's time base (east of Greenwich, daylight in a UTC file crosses the date line). The data's window
// moves by the whole hours of the year's mean offset, so a large offset (a wrong UTC flag) does not cut the day at the edge.
json::Value timing(const Project& p, const std::vector<double>& ghi) {
    const Weather& w = p.wx;
    const double to = w.time_offset, off = p.loc.utc_offset;
    auto cz = [&](double t) {
        double u = w.is_utc ? t : t - off;
        u = std::fmod(u + 2 * HOURS, double(HOURS));
        return sun_position(p.loc.lat, p.loc.lon, int(u / 24.0) + 1, std::fmod(u, 24.0)).cos_zenith;
    };
    std::vector<double> G(HOURS), C(HOURS);
    double gx = 0, gy = 0, cx = 0, cy = 0;
    for (int i = 0; i < HOURS; ++i) {
        G[size_t(i)] = std::max(0.0, ghi[size_t(i)]);
        double s = 0;   // Haurwitz clear sky averaged over the hour's interval
        for (int j = 0; j < 6; ++j) s += haurwitz_ghi(cz(i + to - 0.5 + (j + 0.5) / 6.0));
        C[size_t(i)] = s / 6;
        const double th = 2 * PI * (i + to) / 24;
        gx += G[size_t(i)] * std::cos(th); gy += G[size_t(i)] * std::sin(th);
        cx += C[size_t(i)] * std::cos(th); cy += C[size_t(i)] * std::sin(th);
    }
    const double coarse = std::remainder((std::atan2(gy, gx) - std::atan2(cy, cx)) * 24 / (2 * PI), 24.0);
    const int k = int(std::lround(coarse));
    struct Day { int d; double kt, var, off; };
    std::vector<Day> days;
    std::vector<std::vector<double>> kt_m(12);
    for (int d = 0; d < 365; ++d) {
        const double B = 2 * PI * d / 365.0;
        const double eot = 229.18 * (0.000075 + 0.001868 * std::cos(B) - 0.032077 * std::sin(B) - 0.014615 * std::cos(2 * B) - 0.040849 * std::sin(2 * B));
        const double noon = 12 - p.loc.lon / 15 - eot / 60 + (w.is_utc ? 0 : off);
        const int i0 = int(std::ceil(d * 24 + noon - 12 - to - 1e-9));
        if (i0 < 0 || i0 + 24 > HOURS || i0 + k < 0 || i0 + k + 24 > HOURS) continue;
        double sg = 0, sc = 0, mg = 0, mc = 0, vg = 0, vc = 0;
        for (int j = 0; j < 24; ++j) {
            const size_t ig = size_t(i0 + k + j), ic = size_t(i0 + j);
            sg += G[ig]; sc += C[ic];
            mg += (double(ig) + to) * G[ig]; mc += (double(ic) + to) * C[ic];
            if (j) { vg += std::fabs(G[ig] - G[ig - 1]); vc += std::fabs(C[ic] - C[ic - 1]); }
        }
        if (sg <= 0 || sc <= 0 || vc <= 0) continue;
        days.push_back({d, sg / sc, vg / vc, (mg / sg - mc / sc) * 60});
        kt_m[size_t(month_of_day(d))].push_back(sg / sc);
    }
    std::vector<double> p90(12, 0), offs;
    for (int m = 0; m < 12; ++m) if (!kt_m[size_t(m)].empty()) p90[size_t(m)] = quantile(kt_m[size_t(m)], 0.9);
    std::vector<std::vector<double>> by_m(12);
    for (const auto& x : days)
        if (x.kt >= 0.9 * p90[size_t(month_of_day(x.d))] && x.var <= 1.5) { offs.push_back(x.off); by_m[size_t(month_of_day(x.d))].push_back(x.off); }
    json::Value monthly = json::Value::array();
    double lo = 1e300, hi = -1e300;
    for (const auto& v : by_m) {
        monthly.push(v.empty() ? json::Value() : json::Value(quantile(v, 0.5)));
        if (v.size() >= 3) { lo = std::min(lo, quantile(v, 0.5)); hi = std::max(hi, quantile(v, 0.5)); }
    }
    const int n = int(offs.size());
    json::Value o(json::Object{{"n_days", n}, {"monthly", monthly}, {"coarse_h", coarse}, {"verdict", "none"}, {"shift_h", 0}});
    if (n == 0) return o;
    const double med = quantile(offs, 0.5), iqr = quantile(offs, 0.75) - quantile(offs, 0.25);
    o["median_min"] = med;
    o["iqr_min"] = iqr;
    const bool clock = hi > lo && hi - lo >= 40 && hi - lo <= 80;
    o["clock_change"] = clock;
    o["month_spread_min"] = hi > lo ? hi - lo : 0.0;
    if (n < 10) return o;
    // positive: the data's day comes later than the sun's
    const double u = (w.is_utc ? 1 : -1) * off * 60;
    const long kk = std::lround(med / 60);
    std::string v = "unclear";
    if (std::fabs(off) >= 0.75 && std::fabs(med - u) <= 20) v = "utc";
    else if (std::fabs(med) < 10) v = "ok";
    else if (std::fabs(med) >= 20 && std::fabs(med) <= 40) v = "half";
    else if (kk != 0 && std::fabs(med - 60.0 * double(kk)) <= 10.0 * double(std::labs(kk))) { v = "hours"; o["shift_h"] = int(kk); }
    o["verdict"] = v;
    return o;
}

json::Value weather_qc(const Project& p) {
    const Weather& w = p.wx;
    const std::vector<double>& G = w.ghi;
    const bool has_t = w.tamb.size() == HOURS, has_w = w.wind.size() == HOURS, has_d = w.dhi.size() == HOURS && w.dni.size() == HOURS;
    const bool t_const = !has_t || constant(w.tamb), w_const = !has_w || constant(w.wind);
    const double off = p.loc.utc_offset, to = w.time_offset;
    auto sun = [&](double t) {   // timed as compute_pv_profile times the representative instant
        double u = w.is_utc ? t : t - off;
        u = std::fmod(u + 2 * HOURS, double(HOURS));
        return sun_position(p.loc.lat, p.loc.lon, int(u / 24.0) + 1, std::fmod(u, 24.0));
    };
    Flags F;
    const int k_night = F.add("night", "Irradiance at night (GHI above 5 W/m² with the sun below the horizon)");
    const int k_drop = F.add("dropout", "Zero GHI with the sun more than 15° high");
    const int k_glim = F.add("ghi_limit", "GHI above the physically possible limit");
    const int k_dlim = F.add("dhi_limit", "DHI above the physically possible limit");
    const int k_dgt = F.add("dhi_gt_ghi", "DHI above GHI");
    const int k_flat = F.add("flat_ghi", "GHI stuck at one value for 4 daylight hours or more");
    const int k_copy = F.add("copy_ghi", "GHI repeated at the same hour on 3 days or more");
    const int k_trng = F.add("t_range", "Temperature outside -40 to 60 °C");
    const int k_tstep = F.add("t_step", "Temperature step above 10 °C in an hour");
    const int k_tflat = F.add("flat_t", "Temperature stuck at one value for 6 h or more");
    const int k_tcopy = F.add("copy_t", "Temperature repeated at the same hour on 3 days or more");
    const int k_wrng = F.add("wind_range", "Wind speed below 0 or above 40 m/s");
    const int k_wflat = F.add("flat_wind", "Wind speed stuck at one value for 6 h or more");
    std::vector<char> day(HOURS, 0);
    for (int i = 0; i < HOURS; ++i) {
        const SunPos a = sun(i + to - 0.5), m = sun(i + to), b = sun(i + to + 0.5);
        const double g = G[size_t(i)], mu = std::pow(std::max(0.0, m.cos_zenith), 1.2);
        day[size_t(i)] = m.cos_zenith > 0;
        if (g > 5 && a.zenith_deg > 92 && m.zenith_deg > 92 && b.zenith_deg > 92) F.mark(k_night, i, g);
        if (g <= 0 && m.zenith_deg < 75) F.mark(k_drop, i, g);
        if (g > 1.5 * m.extra_normal * mu + 100) F.mark(k_glim, i, g);
        if (has_d) {
            const double dh = w.dhi[size_t(i)];
            if (dh > 0.95 * m.extra_normal * mu + 50) F.mark(k_dlim, i, dh);
            if (g > 50 && dh > 1.05 * g + 10) F.mark(k_dgt, i, dh);
        }
    }
    stuck(F, k_flat, G, [&](int i) { return day[size_t(i)] != 0; }, 4);
    copied(F, k_copy, G, [&](int i) { return day[size_t(i)] && G[size_t(i)] > 0; });
    if (!t_const) {
        const auto& T = w.tamb;
        for (int i = 0; i < HOURS; ++i) {
            if (T[size_t(i)] < -40 || T[size_t(i)] > 60) F.mark(k_trng, i, T[size_t(i)]);
            if (i && std::fabs(T[size_t(i)] - T[size_t(i - 1)]) > 10) F.mark(k_tstep, i, T[size_t(i)]);
        }
        stuck(F, k_tflat, T, [](int) { return true; }, 6);
        copied(F, k_tcopy, T, [](int) { return true; });
    }
    if (!w_const) {
        for (int i = 0; i < HOURS; ++i) if (w.wind[size_t(i)] < 0 || w.wind[size_t(i)] > 40) F.mark(k_wrng, i, w.wind[size_t(i)]);
        stuck(F, k_wflat, w.wind, [](int) { return true; }, 6);
    }
    const LocalShift sh = local_shift(p);
    json::Value o = F.to_json(sh.n + (sh.f >= 0.5 ? 1 : 0), &G);
    json::Value set = json::Value::array();
    if (t_const) set.push(json::Value(json::Object{{"id", "t_absent"}, {"value", has_t ? json::Value(w.tamb[0]) : json::Value()}}));
    if (w_const) set.push(json::Value(json::Object{{"id", "wind_absent"}, {"value", has_w ? json::Value(w.wind[0]) : json::Value()}}));
    double annual = 0;
    for (double g : G) annual += std::max(0.0, g) / 1000;
    if (annual < 700 || annual > 2700) set.push(json::Value(json::Object{{"id", "ghi_annual"}, {"kwh_m2", annual}}));
    o["set"] = set;
    o["timing"] = timing(p, G);
    return o;
}

// Level shifts of the daily mean load: binary segmentation on its logarithm, at most 5 change points, each a step of at
// least 10 % between segments of 30 days or more that lowers the squared error by more than the BIC penalty.
json::Value level_shifts(const std::vector<double>& L) {
    std::vector<double> mean(365, 0.0), x(365);
    for (int i = 0; i < HOURS; ++i) mean[size_t(i / 24)] += L[size_t(i)] / 24;
    const double floor_v = std::max(1e-9, 0.01 * quantile(mean, 0.5));
    for (int d = 0; d < 365; ++d) x[size_t(d)] = std::log(std::max(mean[size_t(d)], floor_v));
    std::vector<double> S(366, 0.0), Q(366, 0.0), dx, ad;
    for (int d = 0; d < 365; ++d) { S[size_t(d + 1)] = S[size_t(d)] + x[size_t(d)]; Q[size_t(d + 1)] = Q[size_t(d)] + x[size_t(d)] * x[size_t(d)]; }
    for (int d = 1; d < 365; ++d) dx.push_back(x[size_t(d)] - x[size_t(d - 1)]);
    // noise from the day-to-day changes (robust, so a step does not inflate it): sigma = 1.4826 MAD / sqrt(2), at least 0.5 %
    const double med_dx = quantile(dx, 0.5);
    for (double v : dx) ad.push_back(std::fabs(v - med_dx));
    const double sigma = std::max(0.005, 1.4826 * quantile(ad, 0.5) / std::sqrt(2.0));
    const double pen = 2 * sigma * sigma * std::log(365.0);
    auto sse = [&](int a, int b) { const double n = b - a, s = S[size_t(b)] - S[size_t(a)]; return Q[size_t(b)] - Q[size_t(a)] - s * s / n; };
    auto avg = [&](int a, int b) { return (S[size_t(b)] - S[size_t(a)]) / (b - a); };
    std::vector<int> cps;
    for (int iter = 0; iter < 5; ++iter) {
        std::vector<int> edges{0};
        edges.insert(edges.end(), cps.begin(), cps.end());
        edges.push_back(365);
        double best = pen;
        int at = -1;
        for (size_t s = 0; s + 1 < edges.size(); ++s) {
            const int a = edges[s], b = edges[s + 1];
            for (int k = a + 30; k <= b - 30; ++k) {
                if (std::fabs(std::exp(avg(k, b) - avg(a, k)) - 1) < 0.1) continue;
                const double gain = sse(a, b) - sse(a, k) - sse(k, b);
                if (gain > best) { best = gain; at = k; }
            }
        }
        if (at < 0) break;
        cps.insert(std::upper_bound(cps.begin(), cps.end(), at), at);
    }
    json::Value out = json::Value::array();
    for (size_t j = 0; j < cps.size(); ++j) {
        const int a = j ? cps[j - 1] : 0, k = cps[j], b = j + 1 < cps.size() ? cps[j + 1] : 365;
        double s0 = 0, s1 = 0;
        for (int d = a; d < k; ++d) s0 += mean[size_t(d)];
        for (int d = k; d < b; ++d) s1 += mean[size_t(d)];
        out.push(json::Value(json::Object{{"day", k}, {"before_kw", s0 / (k - a)}, {"after_kw", s1 / (b - k)}}));
    }
    return out;
}

json::Value load_qc(const Project& p) {
    const std::vector<double>& L = p.load_kw;
    const double p95 = quantile(L, 0.95), lo = 0.02 * p95, tol = 1e-9 * std::max(1.0, p95);
    Flags F;
    const int k_out = F.add("outage", "Near-zero load for 2 h or more (below 2 % of the 95th percentile)");
    const int k_flat = F.add("flat", "Load stuck at one value for 6 h or more while the rest of the day varies");
    const int k_lin = F.add("linear", "Linear infill (4 or more equal steps in a row)");
    const int k_spike = F.add("spike", "Spike above the usual load at that hour of the week");
    for (int a = 0; a < HOURS;) {   // near-zero runs
        if (L[size_t(a)] >= lo) { ++a; continue; }
        int b = a;
        while (b < HOURS && L[size_t(b)] < lo) ++b;
        if (b - a >= 2) for (int i = a; i < b; ++i) F.mark(k_out, i, L[size_t(i)]);
        a = b;
    }
    for (int a = 0; a < HOURS;) {   // the same value for 6 h or more while the rest of its days varies by over 1 % of its mean
        int b = a + 1;
        while (b < HOURS && L[size_t(b)] == L[size_t(a)]) ++b;
        if (b - a >= 6 && L[size_t(a)] >= lo) {
            std::vector<double> rest;
            for (int i = a / 24 * 24; i < std::min(HOURS, (b - 1) / 24 * 24 + 24); ++i) if (i < a || i >= b) rest.push_back(L[size_t(i)]);
            if (rest.size() < 3) {
                rest.clear();
                for (int i = std::max(0, a - 24); i < std::min(HOURS, b + 24); ++i) if (i < a || i >= b) rest.push_back(L[size_t(i)]);
            }
            if (!rest.empty()) {
                const auto mm = std::minmax_element(rest.begin(), rest.end());
                double m = 0;
                for (double v : rest) m += v / double(rest.size());
                if (*mm.second - *mm.first > 0.01 * m) for (int i = a; i < b; ++i) F.mark(k_flat, i, L[size_t(i)]);
            }
        }
        a = b;
    }
    for (int a = 1; a < HOURS;) {   // 4 or more equal non-zero steps: the hours between the first and the last are infilled
        const double d = L[size_t(a)] - L[size_t(a - 1)];
        if (std::fabs(d) <= tol) { ++a; continue; }
        int b = a + 1;
        while (b < HOURS && std::fabs(L[size_t(b)] - L[size_t(b - 1)] - d) <= tol) ++b;
        if (b - a >= 4) for (int i = a; i < b - 1; ++i) F.mark(k_lin, i, L[size_t(i)]);
        a = b;
    }
    // above the median + 6 x 1.4826 MAD of the same hour of the week in the 8 weeks before and after, so a level shift or a
    // season does not make a whole period look like spikes
    for (int i = 0; i < HOURS; ++i) {
        std::vector<double> v, dev;
        for (int j = i - 8 * 168; j <= i + 8 * 168; j += 168) if (j >= 0 && j < HOURS) v.push_back(L[size_t(j)]);
        const double med = quantile(v, 0.5);
        for (double x : v) dev.push_back(std::fabs(x - med));
        const double mad = quantile(dev, 0.5);
        if (mad > 0 && L[size_t(i)] > med + 6 * 1.4826 * mad) F.mark(k_spike, i, L[size_t(i)]);
    }
    json::Value o = F.to_json(0, nullptr);
    json::Value set = json::Value::array();
    // units: a peak above the genset fleet or below a fifth of one unit, with the unit errors that would fit
    const double fleet = p.dg.units * p.dg.unit_kw, unit = p.dg.unit_kw, peak = *std::max_element(L.begin(), L.end());
    if (fleet > 0 && (peak > fleet || peak < 0.2 * unit)) {
        auto fits = [&](double x) { return x >= 0.2 * unit && x <= fleet; };
        json::Value hints = json::Value::array();
        if (peak > fleet && fits(peak / 1000)) hints.push("w");
        if (peak < 0.2 * unit) {
            if (fits(peak * 4)) hints.push("kwh_15min");
            if (fits(peak * 2)) hints.push("kwh_30min");
            if (fits(peak * 1000)) hints.push("mw");
        }
        set.push(json::Value(json::Object{{"id", "units"}, {"peak_kw", peak}, {"fleet_kw", fleet}, {"unit_kw", unit}, {"above", peak > fleet}, {"hints", hints}}));
    }
    const json::Value shifts = level_shifts(L);
    if (shifts.size()) set.push(json::Value(json::Object{{"id", "level_shift"}, {"shifts", shifts}}));
    o["set"] = set;
    o["p95_kw"] = p95;
    return o;
}

} // namespace

json::Value import_series(const std::string& text, const json::Value& opt) {
    const Opt o = parse_opt(opt);
    std::vector<std::string> head;   // the first 20 non-blank lines, as the import dialog previews them
    for (size_t p = text.compare(0, 3, "\xEF\xBB\xBF") == 0 ? 3 : 0; p < text.size() && head.size() < 20;) {
        size_t q = text.find('\n', p);
        if (q == std::string::npos) q = text.size();
        std::string l = text.substr(p, q - p);
        if (std::any_of(l.begin(), l.end(), [](char c) { return !std::isspace(static_cast<unsigned char>(c)); })) head.push_back(std::move(l));
        p = q + 1;
    }
    if (head.empty()) fail("The file is empty.");
    const char delim = detect_delim(head);
    json::Value rep = json::Value::object();
    // output time base: load in local standard time, weather as imported (UTC for the utc basis, else local standard time)
    const long long shift = o.load || o.basis != "utc" ? o.off : 0;
    const bool pos = o.time_col < 0;
    const std::vector<Sample> S = pos ? positional(text, delim, o, shift, rep) : timestamped(text, delim, o, shift, rep);
    rep["delimiter"] = std::string(1, delim);
    return to_hours(o, S, rep, pos ? 2001 : 0);
}

json::Value data_qc(const Project& p, const std::string& only) {
    if (!(std::fabs(p.loc.lat) <= 90 && std::fabs(p.loc.lon) <= 180)) fail("Location latitude/longitude out of range.");
    if (!(std::fabs(p.loc.utc_offset) <= 14)) fail("UTC offset must be between -14 h and +14 h.");
    if (!(std::fabs(p.wx.time_offset) <= 24)) fail("The weather time offset must be within 24 h.");
    json::Value o = json::Value::object();
    o["weather"] = only != "load" && p.wx.ghi.size() == HOURS ? weather_qc(p) : json::Value();
    o["load"] = only != "weather" && p.load_kw.size() == HOURS ? load_qc(p) : json::Value();
    return o;
}
