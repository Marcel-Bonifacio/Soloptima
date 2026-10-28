// Soloptima - PV + BESS + diesel hybrid energy model.
//   soloptima [serve] [--port 8080] [--web DIR] [--data DIR] [--no-browser]   local GUI at http://127.0.0.1:PORT
//                                    saved projects live in DIR/users/<user>/projects (default: see find_data_dir)
//   soloptima simulate project.json [out.json]                   headless single simulation
//   soloptima optimize project.json [out.json]                   headless sizing (uses project "optimizer" block)
#include "ems.hpp"
#include "finance.hpp"
#include "json.hpp"
#include "model.hpp"
#include "optimizer.hpp"
#include "platform.hpp"
#include "pv.hpp"
#include "resource.hpp"
#include "series.hpp"
#include "server.hpp"
#include "sim.hpp"
#include "storage.hpp"
#include "weather.hpp"
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

#ifndef SOLOPTIMA_VERSION
#define SOLOPTIMA_VERSION "1.0.0"
#endif

namespace {

std::string read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Cannot open " + path);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

Response ok(const json::Value& v) { return {200, "application/json", v.dump()}; }
Response ok() { return {200, "application/json", "{\"ok\":true}"}; }

Sizing sizing_of(const Project& p) { return Sizing{p.pv.capacity_kwp, p.bess.energy_kwh, p.bess.power_kw, double(p.wind.units)}; }

// Forecast days of a request, 1-16 (Open-Meteo's longest forecast); also keeps the int conversion defined.
int forecast_days(const json::Value& v) { const double d = v.get("days", 2); return d >= 1 ? int(std::min(d, 16.0)) : 1; }

json::Value run_simulation(const Project& p, const json::Value& raw) {
    validate_project(p);
    PVProfile prof = compute_pv_profile(p);
    std::vector<double> cs = clearsky_pv_per_kwp(p);
    SimResult hyb = simulate(p, prof.ac_per_kwp, cs, sizing_of(p), true);
    SimResult base = simulate(p, prof.ac_per_kwp, cs, Sizing{}, true);
    json::Value o = json::Value::object();
    o["result"] = result_to_json(hyb, true);
    o["baseline"] = result_to_json(base, false);
    o["baseline_hourly"] = json::Value(json::Object{{"gen_units", json::Value(base.hourly.gen_units)},
                                                    {"fuel_l", json::Value(base.hourly.fuel_l)}});
    o["comparison"] = comparison_to_json(compare(hyb, base));
    // The battery's own value: the same PV and wind without it. Every strategy reduces to load following there.
    if (p.bess.energy_kwh > 1e-6 && p.bess.power_kw > 1e-6) {
        SimResult pvo = simulate(p, prof.ac_per_kwp, cs, Sizing{p.pv.capacity_kwp, 0, 0, double(p.wind.units)}, false);
        o["pv_only"] = result_to_json(pvo, false);
        o["comparison_bess"] = comparison_to_json(compare(hyb, pvo));
    } else {
        o["pv_only"] = json::Value();
        o["comparison_bess"] = json::Value();
    }
    o["pv"] = json::Value(json::Object{{"specific_yield", prof.specific_yield}, {"performance_ratio", prof.performance_ratio}});
    o["finance"] = run_finance(p, parse_finance(raw["finance"], p), hyb, base);
    return o;
}

Project project_with_weather(const std::string& body) {
    Project p = parse_project(json::parse(body));
    if (p.wx.ghi.size() != HOURS) throw std::runtime_error("Fetch or upload weather data first.");
    return p;
}

json::Value months_json(const std::array<double, 12>& a) { return json::Value(std::vector<double>(a.begin(), a.end())); }

json::Value pv_json(const PVProfile& prof) {
    json::Value losses = json::Value::array();
    for (const auto& l : prof.losses)
        losses.push(json::Value(json::Object{{"name", l.name}, {"value", l.value}, {"irradiance", l.irradiance}}));
    json::Value monthly(json::Object{{"ghi", months_json(prof.m_ghi)}, {"dhi", months_json(prof.m_dhi)}, {"tamb", months_json(prof.m_tamb)},
                                     {"poa", months_json(prof.m_poa)}, {"eff", months_json(prof.m_eff)}, {"earray", months_json(prof.m_dc)},
                                     {"eavail", months_json(prof.m_avail)}});
    return json::Value(json::Object{{"specific_yield", prof.specific_yield}, {"performance_ratio", prof.performance_ratio},
                                    {"ghi_annual", prof.ghi_annual}, {"poa_annual", prof.poa_annual}, {"losses", losses},
                                    {"monthly", monthly},
                                    {"ac_per_kwp", json::Value(prof.ac_per_kwp)}, {"ghi", json::Value(prof.ghi_local)},
                                    {"poa", json::Value(prof.poa)}, {"tcell", json::Value(prof.tcell)}});
}

// Independent check of the yield against PVGIS PVcalc. PVGIS models neither row shading nor inverter clipping, so the
// comparable yield leaves both out (trackers track without backtracking, which only avoids row shading, and without a
// rotation limit). The losses
// PVGIS does not model itself (soiling; mismatch, wiring, LID and quality as the loss chain applies them; inverter, AC,
// availability) form its system loss. PVGIS applies that loss as a plain factor, so it is downloaded once without loss
// for each site and orientation and scaled here.
json::Value pv_reference(const Project& p) {
    const bool tracker = p.pv.mount == "tracker";
    if (tracker && std::fabs(std::remainder(p.pv.tracker_axis_azimuth, 180.0)) > 1.0)
        throw std::runtime_error("PVGIS models single-axis trackers only on a north-south axis.");
    Project q = p;
    q.pv.row_shading = false;
    q.pv.backtracking = false;
    q.pv.tracker_max_angle = 90;   // PVGIS rotates without limit
    q.pv.dc_ac_ratio = 0.1;   // inverters ten times the DC power: never clip
    const PVProfile c = compute_pv_profile(q);
    auto step = [&](const std::string& name) { for (const auto& l : c.losses) if (l.name == name) return l.value; return 0.0; };
    const double t = step("After temperature loss");
    const double dc = t > 0 ? step("After mismatch, wiring, LID, quality") / t : 1.0;
    const double kept = (1 - p.pv.soiling) * dc * p.pv.inverter_eff * (1 - p.pv.ac_losses) * p.pv.availability;
    const json::Value g = pvgis_pvcalc(p.loc.lat, p.loc.lon, 0.0, p.pv.tilt, std::remainder(p.pv.azimuth - 180.0, 360.0), tracker);
    std::vector<double> em(12);
    for (int m = 0; m < 12; ++m) em[m] = g["em"][size_t(m)].num() * kept;
    const double ey = g.get("ey", 0) * kept;
    return json::Value(json::Object{{"pvgis_ey", ey}, {"pvgis_em", json::Value(em)}, {"soloptima_ey", c.specific_yield},
                                    {"soloptima_em", months_json(c.m_avail)}, {"loss_pct", 100 * (1 - kept)},
                                    {"diff", ey > 0 ? c.specific_yield / ey - 1 : 0.0}, {"pvgis_poa", g.get("hi_y", 0)},
                                    {"soloptima_poa", c.poa_annual}, {"radiation_db", g["radiation_db"]},
                                    {"year_min", g["year_min"]}, {"year_max", g["year_max"]}, {"tracker", tracker}});
}

// Copy-on-write update of a dotted path ("pv.capacity_kwp") without touching the shared original.
json::Value with_path(const json::Value& root, const std::vector<std::string>& keys, size_t i, const json::Value& v) {
    if (i == keys.size()) return v;
    json::Object o = root.obj();
    o[keys[i]] = with_path(root[keys[i]], keys, i + 1, v);
    return json::Value(std::move(o));
}

// Many independent simulations (parametric sweeps, Monte Carlo) evaluated in parallel.
json::Value run_batch(const json::Value& base, const json::Array& cases) {
    if (cases.size() > 20000) throw std::runtime_error("Batch limited to 20000 cases.");
    const Project base_p = parse_project(base);
    PVProfile base_prof;
    std::vector<double> base_cs;
    if (base_p.wx.ghi.size() == HOURS) { base_prof = compute_pv_profile(base_p); base_cs = clearsky_pv_per_kwp(base_p); }
    std::vector<json::Value> out(cases.size());
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    const size_t nt = std::min<size_t>(cases.size(), std::max(1u, std::thread::hardware_concurrency()));
    for (size_t k = 0; k < nt; ++k)
        pool.emplace_back([&] {
            for (size_t i; (i = next.fetch_add(1)) < cases.size();) {
                try {
                    json::Value pj = base;
                    bool own_pv = false;
                    for (const auto& kv : cases[i]["overrides"].obj()) {
                        std::vector<std::string> keys;
                        std::stringstream ss(kv.first);
                        for (std::string part; std::getline(ss, part, '.');) keys.push_back(part);
                        pj = with_path(pj, keys, 0, kv.second);
                        // the per-kWp PV profile depends only on location, weather and the PV design, not its capacity
                        own_pv = own_pv || keys.empty() ||
                                 ((keys[0] == "location" || keys[0] == "weather" || keys[0] == "pv") && kv.first != "pv.capacity_kwp");
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
            }
        });
    for (auto& t : pool) t.join();
    return json::Value(json::Object{{"results", json::Value(std::move(out))}});
}

struct Job {
    Progress prog;
    std::atomic<bool> done{false};
    std::chrono::steady_clock::time_point finished;   // set before done
    std::mutex m;
    std::string result, error;
};
std::mutex jobs_m;
std::map<int, std::shared_ptr<Job>> jobs;
int next_job = 1;

// Long runs (optimisation, multi-year weather) work in a background thread; the GUI polls /api/job?id= for progress.
Response start_job(std::function<json::Value(Progress&)> fn) {
    auto job = std::make_shared<Job>();
    int id;
    {
        std::lock_guard<std::mutex> g(jobs_m);
        id = next_job++;
        jobs[id] = job;
        while (jobs.size() > 8) { jobs.begin()->second->prog.cancel = true; jobs.erase(jobs.begin()); }
    }
    std::thread([job, fn = std::move(fn)] {
        try {
            std::string res = fn(job->prog).dump();
            std::lock_guard<std::mutex> g(job->m);
            job->result = std::move(res);
        } catch (const std::exception& e) {
            std::lock_guard<std::mutex> g(job->m);
            job->error = e.what();
        }
        job->finished = std::chrono::steady_clock::now();
        job->done = true;
    }).detach();
    return ok(json::Value(json::Object{{"job", id}}));
}

// Historical weather years for the variability run, kept in memory (never in the project file: 19 years x 5 series is
// about 6 MB) by source, site rounded to 0.001 deg and range, so a second run with other inputs downloads nothing.
struct WeatherSet { int from = 0, to = 0; std::string database, note; std::vector<WeatherYear> years; };
std::mutex years_m;
std::map<std::string, std::shared_ptr<const WeatherSet>> years_cache;
int clear_weather_years() {
    std::lock_guard<std::mutex> g(years_m);
    const int n = int(years_cache.size());
    years_cache.clear();
    return n;
}
std::shared_ptr<const WeatherSet> weather_years(const std::string& source, double lat, double lon, int y0, int y1) {
    lat = std::round(lat * 1000) / 1000;
    lon = std::round(lon * 1000) / 1000;
    char key[128];
    std::snprintf(key, sizeof key, "%s %.3f %.3f %d %d", source.c_str(), lat, lon, y0, y1);
    {
        std::lock_guard<std::mutex> g(years_m);
        auto it = years_cache.find(key);
        if (it != years_cache.end()) return it->second;
    }
    const json::Value d = fetch_weather_years(source, lat, lon, y0, y1);
    auto w = std::make_shared<WeatherSet>();
    w->from = int(d.get("from", y0));
    w->to = int(d.get("to", y1));
    w->database = d.gets("database", source);
    int filled = 0, gap = 0;
    for (const auto& y : d["years"].arr()) {
        w->years.push_back({std::atoi(y.gets("years", "0").c_str()), parse_weather(y)});
        filled += int(y.get("n_filled", 0));
        gap = std::max(gap, int(y.get("max_gap_h", 0)));
    }
    if (filled > 0) w->note = std::to_string(filled) + " h with missing values filled in, longest gap " + std::to_string(gap) + " h.";
    std::lock_guard<std::mutex> g(years_m);
    if (years_cache.size() >= 4) years_cache.erase(years_cache.begin());
    years_cache[key] = w;
    return w;
}

std::string find_web_root(const std::string& given) {
    // next to the program, inside a macOS .app bundle (Contents/Resources/web), or the source tree
    namespace fs = std::filesystem;
    std::vector<fs::path> cands;
    if (!given.empty()) cands.push_back(fs::u8path(given));
    const fs::path d = exe_dir();
    for (const fs::path& c : {d / "web", d / ".." / "Resources" / "web", d / ".." / "web", fs::path("web"), fs::path("..") / "web"}) cands.push_back(c);
    for (const auto& c : cands) {
        std::error_code ec;
        if (fs::exists(c / "index.html", ec)) return fs::canonical(c, ec).u8string();
    }
    return "web";
}

// Where the data folder came from: "option" (--data), "setting" (chosen in Settings), "portable" (a data folder next to the
// program or in the working directory) or "default". settings_m guards these and a folder change in progress.
std::mutex settings_m;
std::string data_source = "default", data_note;
// beside the default folder, not in it: that folder may be deleted once the data has moved elsewhere
std::filesystem::path settings_file() { return user_data_dir().parent_path() / "Soloptima-settings.json"; }

// Saved projects: --data DIR, else the folder chosen in Settings, else a "data" folder next to the program or in the
// working directory (portable / development use), else the per-user application data folder.
std::filesystem::path find_data_dir(const std::string& given) {
    namespace fs = std::filesystem;
    if (!given.empty()) { data_source = "option"; return fs::u8path(given); }
    std::error_code ec;
    fs::path chosen;
    try {
        std::ifstream f(settings_file(), std::ios::binary);
        std::ostringstream ss;
        ss << f.rdbuf();
        if (f) chosen = fs::u8path(json::parse(ss.str()).gets("data_dir", ""));
    } catch (const std::exception&) { /* no setting */ }
    if (!chosen.empty()) {
        if (fs::is_directory(chosen / "users", ec)) { data_source = "setting"; return chosen; }
        data_note = "The projects folder chosen in Settings (" + chosen.u8string() + ") is not available, so another folder is used. "
                    "Connect the drive that holds it, then restart Soloptima, or choose the folder again.";
    }
    for (const fs::path& c : {exe_dir() / "data", fs::current_path(ec) / "data"})
        if (fs::exists(c / "users", ec)) { data_source = "portable"; return c; }
    const fs::path dir = user_data_dir(), old = dir.parent_path() / "SolarHybrid";   // folder name before the rename
    if (!fs::exists(dir, ec) && fs::exists(old, ec)) fs::rename(old, dir, ec);
    return dir;
}

// Paths compared as the file system does: resolved, without a trailing separator, and without case on Windows
std::filesystem::path path_key(const std::filesystem::path& p) {
    std::filesystem::path c = std::filesystem::weakly_canonical(p);
    if (!c.has_filename()) c = c.parent_path();
#ifdef _WIN32
    std::wstring w = c.wstring();
    for (auto& ch : w) ch = wchar_t(std::towlower(ch));
    c = w;
#endif
    return c;
}
bool path_within(const std::filesystem::path& a, const std::filesystem::path& b) {   // a is b or inside it
    auto ia = a.begin();
    for (auto ib = b.begin(); ib != b.end(); ++ib, ++ia)
        if (ia == a.end() || *ia != *ib) return false;
    return true;
}
long count_files(const std::filesystem::path& d) {
    long n = 0;
    std::error_code ec;
    for (auto it = std::filesystem::recursive_directory_iterator(d, ec); !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec))
        if (it->is_regular_file(ec)) ++n;
    return n;
}

// Settings: another data folder. "move" copies the profiles, projects and reports there and keeps the old folder as it was
// (a backup the user can delete); "use" opens the folder as it is. The choice is saved in Soloptima-settings.json.
json::Value change_data_dir(Storage& store, const std::string& path, const std::string& mode) {
    namespace fs = std::filesystem;
    std::lock_guard<std::mutex> g(settings_m);
    if (data_source == "option") throw std::runtime_error("Soloptima was started with --data, which sets the projects folder for this run.");
    if (mode != "move" && mode != "use") throw std::runtime_error("Unknown folder change.");
    fs::path to = fs::u8path(path);
    if (path.empty() || !to.is_absolute()) throw std::runtime_error("Enter the full path of a folder.");
    to = fs::weakly_canonical(to);
    if (!to.has_filename()) to = to.parent_path();
    const fs::path from = store.root(), kt = path_key(to), kf = path_key(from);
    if (kt == kf) throw std::runtime_error("That is already the projects folder.");
    if (path_within(kt, kf) || path_within(kf, kt)) throw std::runtime_error("Choose a folder outside the current projects folder, and not one that contains it.");
    std::error_code ec;
    const auto profiles = [&](const fs::path& d) {
        long n = 0;
        for (auto it = fs::directory_iterator(d / "users", ec); !ec && it != fs::directory_iterator(); it.increment(ec))
            if (fs::exists(it->path() / "profile.json", ec)) ++n;
        ec.clear();
        return n;
    };
    // opening a folder without profiles would leave nobody to sign in with
    if (mode == "use" && profiles(to) == 0)
        throw std::runtime_error("That folder holds no Soloptima profiles. To take your profiles and projects there, choose \"Move my data there\".");
    try {
        fs::create_directories(to);
        write_atomic(to / ".soloptima-write-test", "ok");
        fs::remove(to / ".soloptima-write-test");
    } catch (const std::exception&) { throw std::runtime_error("Soloptima cannot create or write to that folder. Choose another one."); }
    long copied = 0;
    if (mode == "move") {
        if (profiles(to) > 0 || count_files(to / "reports") > 0)
            throw std::runtime_error("That folder already holds Soloptima data. Choose an empty folder, or open the data in it instead.");
        for (const char* sub : {"users", "reports"})
            if (fs::exists(from / sub)) fs::copy(from / sub, to / sub, fs::copy_options::recursive | fs::copy_options::overwrite_existing);
        copied = count_files(to / "users") + count_files(to / "reports");
        if (copied != count_files(from / "users") + count_files(from / "reports"))
            throw std::runtime_error("Not every file could be copied, so the projects folder was not changed. Check the free space in the new folder.");
    }
    store.set_root(to);
    if (path_key(user_data_dir()) == kt) {   // the default folder needs no setting
        fs::remove(settings_file(), ec);
        data_source = "default";
    } else {
        fs::create_directories(settings_file().parent_path());
        write_atomic(settings_file(), json::Value(json::Object{{"data_dir", to.u8string()}}).dump());
        data_source = "setting";
    }
    data_note.clear();
    return json::Value(json::Object{{"data_dir", to.u8string()}, {"previous", from.u8string()}, {"copied", double(copied)}, {"profiles", double(profiles(to))}});
}

// Is another Soloptima already serving on this port?
bool is_soloptima(int port) {
    try {
        json::Value h = json::parse(http_get("http://127.0.0.1:" + std::to_string(port) + "/api/health"));
        return h.getb("ok", false) && h.gets("app", "") == "Soloptima";
    } catch (...) { return false; }
}

int serve(int port, const std::string& web, bool browser, const std::filesystem::path& data_dir) {
    HttpServer srv(web);
    static Storage store(data_dir);
    srv.route("POST", "/api/shutdown", [](const Request&) {
        std::thread([] { std::this_thread::sleep_for(std::chrono::milliseconds(300)); std::exit(0); }).detach();
        return ok();
    });
    srv.route("GET", "/api/info", [](const Request&) {
#if defined(_WIN32)
        const char* os = "Windows";
#elif defined(__APPLE__)
        const char* os = "macOS";
#else
        const char* os = "Linux";
#endif
#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
        const char* arch = "arm64";
#else
        const char* arch = "x64";
#endif
        return ok(json::Value(json::Object{{"data_dir", store.root().u8string()}, {"reports_dir", store.reports_dir().u8string()},
                                           {"version", SOLOPTIMA_VERSION}, {"os", os}, {"arch", arch}}));
    });
    // Licence, terms of use and third-party notices: Markdown files kept next to the web folder
    srv.route("GET", "/api/legal", [web](const Request& r) {
        static const std::map<std::string, std::string> docs{{"license", "LICENSE.md"}, {"terms", "TERMS.md"}, {"notices", "THIRD_PARTY_NOTICES.md"}};
        const auto it = docs.find(r.param("doc"));
        if (it == docs.end()) return Response{404, "text/plain", "unknown document"};
        std::ifstream f(std::filesystem::u8path(web).parent_path() / it->second, std::ios::binary);
        if (!f) return Response{404, "text/plain", it->second + " is missing next to the web folder"};
        std::ostringstream ss;
        ss << f.rdbuf();
        return Response{200, "text/plain; charset=utf-8", ss.str()};
    });
    srv.route("GET", "/api/users", [](const Request&) { return ok(store.list_users()); });
    srv.route("POST", "/api/users", [](const Request& r) { return ok(store.create_user(json::parse(r.body))); });
    srv.route("POST", "/api/users/terms", [](const Request& r) { return ok(store.accept_terms(r.param("id"), json::parse(r.body).gets("version", ""))); });
    srv.route("POST", "/api/users/update", [](const Request& r) { return ok(store.update_user(r.param("id"), json::parse(r.body))); });
    // Settings: the projects folder and the caches
    srv.route("GET", "/api/settings", [](const Request&) {
        std::lock_guard<std::mutex> g(settings_m);
        return ok(json::Value(json::Object{{"data_dir", store.root().u8string()}, {"default_dir", user_data_dir().u8string()},
                                           {"source", data_source}, {"note", data_note}}));
    });
    srv.route("POST", "/api/settings/data-dir", [](const Request& r) {
        const json::Value v = json::parse(r.body);
        return ok(change_data_dir(store, v.gets("path", ""), v.gets("mode", "")));
    });
    srv.route("POST", "/api/settings/pick-folder", [](const Request&) { return ok(json::Value(json::Object{{"path", pick_folder("Choose the folder for Soloptima projects")}})); });
    // Downloaded weather sets and PV yield checks, results of runs finished over 30 s ago, and leftovers of interrupted saves.
    // Profiles, projects and reports are never touched.
    srv.route("POST", "/api/cache/clear", [](const Request&) {
        long results = 0;
        {
            const auto cut = std::chrono::steady_clock::now() - std::chrono::seconds(30);
            std::lock_guard<std::mutex> g(jobs_m);
            for (auto it = jobs.begin(); it != jobs.end();)
                if (it->second->done && it->second->finished < cut) { it = jobs.erase(it); ++results; } else ++it;
        }
        return ok(json::Value(json::Object{{"weather_sets", clear_weather_years()}, {"yield_checks", clear_yield_cache()},
                                           {"results", double(results)}, {"temp_files", store.remove_temp_files()}}));
    });
    srv.route("POST", "/api/users/delete", [](const Request& r) { store.delete_user(r.param("id")); return ok(); });
    srv.route("GET", "/api/projects", [](const Request& r) { return ok(store.list_projects(r.param("user"))); });
    srv.route("GET", "/api/project", [](const Request& r) { return Response{200, "application/json", store.load_project(r.param("user"), r.param("id"))}; });
    srv.route("POST", "/api/project", [](const Request& r) {
        json::Value v = json::parse(r.body);
        return ok(store.save_project(r.param("user"), r.param("id"), v["project"], v["meta"]));
    });
    srv.route("POST", "/api/project/delete", [](const Request& r) { store.delete_project(r.param("user"), r.param("id")); return ok(); });
    srv.route("POST", "/api/project/duplicate", [](const Request& r) { return ok(store.duplicate_project(r.param("user"), r.param("id"))); });
    // Bug and feedback reports with their history (see web/js/reports.js)
    srv.route("GET", "/api/reports", [](const Request&) { return ok(store.list_reports()); });
    srv.route("GET", "/api/report", [](const Request& r) { return Response{200, "application/json", store.load_report(r.param("id"))}; });
    srv.route("POST", "/api/report", [](const Request& r) {
        if (r.body.size() > (24u << 20)) throw std::runtime_error("The report is too large (over 24 MB).");
        json::Value v = json::parse(r.body);
        return ok(store.save_report(v["report"], v.gets("markdown", "")));
    });
    srv.route("POST", "/api/report/delete", [](const Request& r) { store.delete_report(r.param("id")); return ok(); });
    srv.route("GET", "/api/health", [](const Request&) {
        return ok(json::Value(json::Object{{"ok", true}, {"app", "Soloptima"}, {"version", SOLOPTIMA_VERSION},
                                           {"threads", int(std::thread::hardware_concurrency())}}));
    });
    srv.route("POST", "/api/weather", [](const Request& r) {
        json::Value v = json::parse(r.body);
        return ok(fetch_weather(v.gets("source", "pvgis_tmy"), v.get("lat", 0), v.get("lon", 0), int(v.get("year", 2023))));
    });
    srv.route("POST", "/api/forecast-weather", [](const Request& r) {
        json::Value v = json::parse(r.body);
        return ok(fetch_forecast(v.gets("provider", "open_meteo"), v.get("lat", 0), v.get("lon", 0), forecast_days(v),
                                 v.gets("api_key", "")));
    });
    // Timestamped load or weather file as one year of hourly means with an import report: {text, options} (series.hpp).
    srv.route("POST", "/api/import-series", [](const Request& r) {
        json::Value v = json::parse(r.body);
        if (!v["text"].is_string()) throw std::runtime_error("The file text is missing.");
        if (v["text"].str().size() > (64u << 20)) throw std::runtime_error("The file is too large (over 64 MB): split it by year.");
        return ok(import_series(v["text"].str(), v["options"]));
    });
    // Data checks of the project's weather and load: {project, only: weather | load | ""}.
    srv.route("POST", "/api/data-qc", [](const Request& r) {
        json::Value v = json::parse(r.body);
        const std::string only = v.gets("only", "");
        if (only != "" && only != "weather" && only != "load") throw std::runtime_error("Unknown data set: " + only.substr(0, 20) + ".");
        return ok(data_qc(parse_project(v["project"]), only));
    });
    srv.route("POST", "/api/pv", [](const Request& r) { return ok(pv_json(compute_pv_profile(project_with_weather(r.body)))); });
    srv.route("POST", "/api/pv-reference", [](const Request& r) { return ok(pv_reference(project_with_weather(r.body))); });
    srv.route("POST", "/api/tilt-scan", [](const Request& r) {
        json::Value pts = json::Value::array();
        for (auto [t, y] : tilt_scan(project_with_weather(r.body), 0, 45, 2.5)) pts.push(json::Value(json::Array{t, y}));
        return ok(json::Value(json::Object{{"points", pts}}));
    });
    srv.route("POST", "/api/forecast/benchmark", [](const Request& r) {
        json::Value v = json::parse(r.body);
        Project p = parse_project(v["project"]);
        validate_project(p);
        return ok(forecast_benchmark(p, v.getb("with_value", true)));
    });
    srv.route("GET", "/api/forecast/methods", [](const Request&) {
        auto list = [](const std::vector<MethodInfo>& m) {
            json::Value a = json::Value::array();
            for (const auto& x : m) a.push(json::Value(json::Object{{"id", x.id}, {"name", x.name}, {"description", x.description}}));
            return a;
        };
        return ok(json::Value(json::Object{{"pv", list(pv_forecast_methods())}, {"load", list(load_forecast_methods())}}));
    });
    srv.route("POST", "/api/batch", [](const Request& r) {
        json::Value v = json::parse(r.body);
        return ok(run_batch(v["project"], v["cases"].arr()));
    });
    srv.route("POST", "/api/simulate", [](const Request& r) {
        json::Value v = json::parse(r.body);
        return ok(run_simulation(parse_project(v), v));
    });
    srv.route("POST", "/api/ems/schedule", [](const Request& r) {
        json::Value v = json::parse(r.body);
        Project p = parse_project(v["project"]);
        if (p.load_kw.size() != HOURS) throw std::runtime_error("Define the load profile first.");
        if (!(p.bess.reserve_duration_h > 0)) throw std::runtime_error("Battery reserve duration must be above 0 h.");
        if (p.wind.units > 0 && !(p.wind.v_in < p.wind.v_rated && p.wind.v_rated < p.wind.v_out))
            throw std::runtime_error("Wind turbine speeds must satisfy cut-in < rated < cut-out.");
        // now_utc: the browser's clock, so the plan starts at the current hour; days x 24 hours are planned
        return ok(day_ahead_schedule(p, sizing_of(p), v["forecast"], v.get("soc_now", 0.5), v.get("load_scale", 1.0),
                                     v.gets("now_utc", ""), forecast_days(v) * 24));
    });
    srv.route("POST", "/api/optimize", [](const Request& r) {
        json::Value v = json::parse(r.body);
        Project p = parse_project(v["project"]);
        validate_project(p);
        OptSettings o = parse_opt_settings(v["optimizer"], p);
        return start_job([p = std::move(p), o = std::move(o)](Progress& prog) { return optimize(p, o, prog); });
    });
    // Inter-annual variability: {project, source: pvgis | nasa_power, from, to, budget: {dataset, model, soiling}}.
    srv.route("POST", "/api/resource-years", [](const Request& r) {
        json::Value v = json::parse(r.body);
        Project p = parse_project(v["project"]);
        validate_project(p);
        const std::string source = v.gets("source", "pvgis");
        if (source != "pvgis" && source != "nasa_power") throw std::runtime_error("Unknown weather source: " + source);
        const int from = int(v.get("from", 2005)), to = int(v.get("to", 2023));
        if (from == to) throw std::runtime_error("Choose at least two weather years.");
        const json::Value& bj = v["budget"];
        UncertaintyBudget b;
        b.dataset = bj.get("dataset", b.dataset);
        b.model = bj.get("model", b.model);
        b.soiling = bj.get("soiling", b.soiling);
        if (!(b.dataset >= 0 && b.model >= 0 && b.soiling >= 0 && sigma_sys(b) < 1)) throw std::runtime_error("Uncertainties must be at least 0 % and together below 100 %.");
        return start_job([p = std::move(p), raw = v["project"], source, from, to, b](Progress& prog) {
            prog.total = std::max(2, std::abs(to - from) + 1) + 3;
            const auto w = weather_years(source, p.loc.lat, p.loc.lon, from, to);
            if (prog.cancel) throw std::runtime_error("Cancelled.");
            json::Value res = resource_years(p, raw, w->years, b, prog);
            res["range"] = json::Value(json::Object{{"from", w->from}, {"to", w->to}});
            res["database"] = w->database;
            res["source"] = source;
            res["note"] = w->note;
            return res;
        });
    });
    srv.route("GET", "/api/job", [](const Request& r) {
        std::shared_ptr<Job> job;
        {
            std::lock_guard<std::mutex> g(jobs_m);
            auto it = jobs.find(std::atoi(r.param("id").c_str()));
            if (it == jobs.end()) throw std::runtime_error("No such job.");
            job = it->second;
        }
        if (!job->done) {
            return ok(json::Value(json::Object{{"done", false}, {"progress", double(job->prog.done)},
                                               {"total", double(job->prog.total)}}));
        }
        std::lock_guard<std::mutex> g(job->m);
        if (!job->error.empty()) return ok(json::Value(json::Object{{"done", true}, {"error", job->error}}));
        return Response{200, "application/json", "{\"done\":true,\"result\":" + job->result + "}"};
    });
    srv.route("POST", "/api/job/cancel", [](const Request& r) {
        std::lock_guard<std::mutex> g(jobs_m);
        auto it = jobs.find(std::atoi(r.param("id").c_str()));
        if (it != jobs.end()) it->second->prog.cancel = true;
        return ok();
    });

    // Single instance: if Soloptima already runs, just open it; if the port is taken by something else, try the next ones.
    int bound = -1;
    for (int p = port; p < port + 20; ++p) {
        if (srv.bind_port(p)) { bound = p; break; }
        if (is_soloptima(p)) {
            const std::string url = "http://127.0.0.1:" + std::to_string(p) + "/";
            std::printf("Soloptima is already running at %s - opening it.\n", url.c_str());
            if (browser) open_browser(url);
            return 0;
        }
    }
    if (bound < 0) { std::fprintf(stderr, "No free port between %d and %d.\n", port, port + 19); return 1; }
    const std::string url = "http://127.0.0.1:" + std::to_string(bound) + "/";
    std::printf("Soloptima %s running at %s\n  web:  %s\n  data: %s\nClose this window or use Quit in the app to stop.\n",
                SOLOPTIMA_VERSION, url.c_str(), web.c_str(), data_dir.u8string().c_str());
    std::fflush(stdout);
    if (browser) std::thread([url] { std::this_thread::sleep_for(std::chrono::milliseconds(400)); open_browser(url); }).detach();
    srv.run();
    return 0;
}

void write_out(const std::string& path, const json::Value& v) {
    if (path.empty()) { std::cout << v.dump() << "\n"; return; }
    std::ofstream f(path);
    f << v.dump();
    f.close();
    if (!f) throw std::runtime_error("Cannot write " + path);
    std::fprintf(stderr, "Wrote %s\n", path.c_str());
}

} // namespace

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    // No command or a leading option means serve (older Finder versions also pass a lone -psn_… argument)
    std::string cmd = args.empty() || args[0].rfind("-", 0) == 0 ? "serve" : args[0];
    try {
        if (cmd == "serve") {
            int port = 8080;
            std::string web, data;
            bool browser = true;
            for (size_t i = 0; i < args.size(); ++i) {
                if (args[i] == "--port" && i + 1 < args.size()) port = std::atoi(args[++i].c_str());
                else if (args[i] == "--web" && i + 1 < args.size()) web = args[++i];
                else if (args[i] == "--no-browser") browser = false;
                else if (args[i] == "--data" && i + 1 < args.size()) data = args[++i];
            }
            return serve(port, find_web_root(web), browser, find_data_dir(data));
        }
        if ((cmd == "simulate" || cmd == "optimize") && args.size() >= 2) {
            json::Value v = json::parse(read_file(args[1]));
            Project p = parse_project(v);
            std::string out = args.size() >= 3 ? args[2] : "";
            if (cmd == "simulate") { write_out(out, run_simulation(p, v)); return 0; }
            validate_project(p);
            OptSettings o = parse_opt_settings(v["optimizer"], p);
            Progress prog;
            auto t0 = std::chrono::steady_clock::now();
            std::atomic<bool> fin{false};
            std::thread rep([&] {
                while (!fin) {
                    std::fprintf(stderr, "\r  %ld / %ld simulations", long(prog.done), long(prog.total));
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                }
            });
            json::Value res;
            try { res = optimize(p, o, prog); } catch (...) { fin = true; rep.join(); throw; }
            const double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            fin = true;
            rep.join();
            std::fprintf(stderr, "\r  %ld simulations in %.1f s\n", long(prog.done), sec);
            write_out(out, res);
            return 0;
        }
        std::fprintf(stderr, "usage: soloptima [serve --port N --web DIR --data DIR --no-browser] | simulate project.json [out.json] | "
                             "optimize project.json [out.json]\n");
        return 2;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "Error: %s\n", e.what());
        return 1;
    }
}
