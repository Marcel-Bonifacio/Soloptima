#include "storage.hpp"
#include "platform.hpp"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <random>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;

void write_atomic(const fs::path& p, const std::string& text) {
    fs::path tmp = p;
    tmp += ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (f) { f << text; f.close(); }
        if (!f) {   // disk full or no access: keep the existing file
            std::error_code ec;
            fs::remove(tmp, ec);
            throw std::runtime_error("Cannot write a file in the data folder (is the disk full?).");
        }
    }
    replace_file(tmp, p);
}

namespace {
std::string read_text(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("Not found.");
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}
std::string now_iso() {
    std::time_t t = std::time(nullptr);
    char buf[32];
    std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return buf;
}
std::string slug(const std::string& name) {
    std::string s;
    for (char c : name) {
        if (std::isalnum(static_cast<unsigned char>(c))) s += char(std::tolower(static_cast<unsigned char>(c)));
        else if (!s.empty() && s.back() != '-') s += '-';
        if (s.size() >= 24) break;
    }
    while (!s.empty() && s.back() == '-') s.pop_back();
    return s.empty() ? "item" : s;
}
std::string rand_suffix() {
    static std::mt19937 rng(unsigned(std::chrono::steady_clock::now().time_since_epoch().count()));
    static std::mutex m;
    static const char* al = "abcdefghijkmnpqrstuvwxyz23456789";
    std::lock_guard<std::mutex> g(m);
    std::string s;
    for (int i = 0; i < 6; ++i) s += al[rng() % 32];
    return s;
}
// The first max_cp code points of a UTF-8 string (never cuts inside a character)
std::string utf8_prefix(const std::string& s, size_t max_cp) {
    size_t n = 0;
    for (size_t i = 0; i < s.size(); ++i)
        if ((static_cast<unsigned char>(s[i]) & 0xC0) != 0x80 && n++ == max_cp) return s.substr(0, i);
    return s;
}
bool valid_id(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    return std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_'; });
}
} // namespace

Storage::Storage(fs::path root) : root_(std::move(root)) { fs::create_directories(root_ / "users"); }

fs::path Storage::root() const {
    std::lock_guard<std::mutex> g(root_m_);
    return root_;
}
void Storage::set_root(const fs::path& root) {
    fs::create_directories(root / "users");
    std::lock_guard<std::mutex> g(root_m_);
    root_ = root;
}
int Storage::remove_temp_files() const {
    const auto old = fs::file_time_type::clock::now() - std::chrono::minutes(1);   // a save may be writing a newer one
    int n = 0;
    std::error_code ec;
    for (auto it = fs::recursive_directory_iterator(root(), ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec))
        if (it->is_regular_file(ec) && it->path().extension() == ".tmp" && it->last_write_time(ec) < old && fs::remove(it->path(), ec)) ++n;
    return n;
}

fs::path Storage::user_dir(const std::string& user) const {
    if (!valid_id(user)) throw std::runtime_error("Invalid user id.");
    return root() / "users" / user;
}

json::Value Storage::list_users() const {
    json::Array v;
    for (const auto& e : fs::directory_iterator(root() / "users")) {
        if (!e.is_directory()) continue;
        json::Value u;
        try { u = json::parse(read_text(e.path() / "profile.json")); } catch (...) { continue; }
        long n = 0;
        if (fs::exists(e.path() / "projects"))
            for (const auto& f : fs::directory_iterator(e.path() / "projects"))
                if (f.path().extension() == ".json" && f.path().filename().string().find(".meta.") == std::string::npos) ++n;
        u["projects"] = n;
        v.push_back(std::move(u));
    }
    std::sort(v.begin(), v.end(), [](const json::Value& a, const json::Value& b) { return a.gets("name", "") < b.gets("name", ""); });
    return json::Value(std::move(v));
}

json::Value Storage::create_user(const json::Value& profile) {
    std::string clean = utf8_prefix(profile.gets("name", ""), 60);
    if (clean.find_first_not_of(" \t") == std::string::npos) throw std::runtime_error("Enter a name.");
    const std::string id = slug(clean) + "-" + rand_suffix();
    const fs::path d = user_dir(id);
    fs::create_directories(d / "projects");
    const std::string now = now_iso();
    json::Value u(json::Object{{"id", id}, {"name", clean}, {"created", now}});
    for (const char* k : {"organisation", "email"}) {
        const std::string v = utf8_prefix(profile.gets(k, ""), 120);
        if (!v.empty()) u[k] = v;
    }
    const std::string tv = utf8_prefix(profile.gets("terms_version", ""), 20);
    if (!tv.empty()) { u["terms_version"] = tv; u["terms_accepted"] = now; }
    write_atomic(d / "profile.json", u.dump());
    u["projects"] = 0;
    return u;
}

json::Value Storage::accept_terms(const std::string& user, const std::string& version) {
    const fs::path f = user_dir(user) / "profile.json";
    if (version.empty() || version.size() > 20) throw std::runtime_error("Invalid terms version.");
    json::Value u = json::parse(read_text(f));
    u["terms_version"] = version;
    u["terms_accepted"] = now_iso();
    write_atomic(f, u.dump());
    return u;
}

namespace {
// A profile picture: a small PNG, JPEG or WebP data URL (the GUI scales it to 160 px)
bool valid_avatar(const std::string& s) {
    static const char* const heads[] = {"data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"};
    if (s.size() > 400000) return false;
    for (const char* h : heads) {
        const size_t n = std::strlen(h);
        if (s.compare(0, n, h) != 0 || s.size() == n) continue;
        size_t i = n;
        while (i < s.size() && (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '+' || s[i] == '/')) ++i;
        while (i < s.size() && s[i] == '=') ++i;
        return i == s.size();
    }
    return false;
}
} // namespace

json::Value Storage::update_user(const std::string& user, const json::Value& ch) {
    const fs::path f = user_dir(user) / "profile.json";
    if (!fs::exists(f)) throw std::runtime_error("No such user.");
    json::Object u = json::parse(read_text(f)).obj();
    if (ch.has("name")) {
        const std::string name = utf8_prefix(ch.gets("name", ""), 60);
        if (name.find_first_not_of(" \t") == std::string::npos) throw std::runtime_error("Enter a name.");
        u["name"] = name;
    }
    for (const char* k : {"organisation", "email"})
        if (ch.has(k)) {
            const std::string v = utf8_prefix(ch.gets(k, ""), 120);
            if (v.empty()) u.erase(k); else u[k] = v;
        }
    if (ch.has("avatar")) {
        const std::string a = ch.gets("avatar", "");
        if (a.empty()) u.erase("avatar");
        else if (!valid_avatar(a)) throw std::runtime_error("The picture must be a PNG, JPEG or WebP image under 300 kB.");
        else u["avatar"] = a;
    }
    json::Value out(std::move(u));
    write_atomic(f, out.dump());
    return out;
}

void Storage::delete_user(const std::string& user) {
    const fs::path d = user_dir(user);
    if (!fs::exists(d)) throw std::runtime_error("No such user.");
    fs::remove_all(d);
}

json::Value Storage::list_projects(const std::string& user) const {
    const fs::path d = user_dir(user) / "projects";
    json::Array v;
    if (fs::exists(d))
        for (const auto& e : fs::directory_iterator(d)) {
            const std::string fn = e.path().filename().string();
            if (fn.size() < 10 || fn.compare(fn.size() - 10, 10, ".meta.json") != 0) continue;
            try { v.push_back(json::parse(read_text(e.path()))); } catch (...) {}
        }
    std::sort(v.begin(), v.end(), [](const json::Value& a, const json::Value& b) { return a.gets("updated", "") > b.gets("updated", ""); });
    return json::Value(std::move(v));
}

std::string Storage::load_project(const std::string& user, const std::string& id) const {
    if (!valid_id(id)) throw std::runtime_error("Invalid project id.");
    return read_text(user_dir(user) / "projects" / (id + ".json"));
}

json::Value Storage::save_project(const std::string& user, const std::string& id_in, const json::Value& project, const json::Value& meta_in) {
    const fs::path dir = user_dir(user), d = dir / "projects";
    if (!fs::exists(dir / "profile.json")) throw std::runtime_error("No such user.");
    fs::create_directories(d);
    const std::string id = id_in.empty() ? slug(project.gets("name", "project")) + "-" + rand_suffix() : id_in;
    if (!valid_id(id)) throw std::runtime_error("Invalid project id.");
    const std::string now = now_iso();
    std::string created = now;
    try { created = json::parse(read_text(d / (id + ".meta.json"))).gets("created", now); } catch (...) {}
    json::Value p(project.obj());   // shallow copy: adding "id" must not touch the caller's object
    p["id"] = id;
    write_atomic(d / (id + ".json"), p.dump());
    json::Value meta(meta_in.obj());
    meta["id"] = id;
    meta["name"] = project.gets("name", "Untitled");
    meta["created"] = created;
    meta["updated"] = now;
    write_atomic(d / (id + ".meta.json"), meta.dump());
    return meta;
}

void Storage::delete_project(const std::string& user, const std::string& id) {
    if (!valid_id(id)) throw std::runtime_error("Invalid project id.");
    const fs::path d = user_dir(user) / "projects";
    fs::remove(d / (id + ".json"));
    fs::remove(d / (id + ".meta.json"));
}

namespace {
bool valid_report_id(const std::string& s) {   // SOL-0001 ... SOL-999999
    if (s.size() < 8 || s.size() > 10 || s.compare(0, 4, "SOL-") != 0) return false;
    return std::all_of(s.begin() + 4, s.end(), [](char c) { return std::isdigit(static_cast<unsigned char>(c)); });
}
std::mutex reports_mutex;   // id allocation, revisions and the index are shared by concurrent requests
// One Markdown table cell: no line breaks or pipes, at most 90 characters
std::string cell(std::string s) {
    for (char& c : s) if (c == '\n' || c == '\r' || c == '|') c = ' ';
    const std::string cut = utf8_prefix(s, 87);
    return utf8_prefix(s, 90) == s ? s : cut + "...";
}
// Labels as in web/js/reports.js
const std::map<std::string, std::string> KINDS{{"bug", "Bug"}, {"error", "Error (captured)"}, {"feedback", "Feedback"}, {"feature", "Feature request"}};
const std::map<std::string, std::string> STATUSES{{"new", "New"}, {"confirmed", "Confirmed"}, {"in_progress", "In progress"}, {"fixed", "Fixed"},
                                                  {"closed", "Closed"}, {"wont_fix", "Will not fix"}, {"duplicate", "Duplicate"}};
const std::map<std::string, std::string> SEVERITIES{{"low", "Low"}, {"medium", "Medium"}, {"high", "High"}, {"critical", "Critical"}};
std::string label(const std::map<std::string, std::string>& m, const std::string& k) { const auto it = m.find(k); return it == m.end() ? k : it->second; }
// Highest report number on disk or ever issued (reports/.last-id), so deleted numbers are not reused
int last_report_number(const fs::path& d) {
    int n = 0;
    try { n = std::atoi(read_text(d / ".last-id").c_str()); } catch (...) {}
    if (fs::exists(d))
        for (const auto& e : fs::directory_iterator(d)) {
            const std::string stem = e.path().stem().string();
            if (e.path().extension() == ".json" && valid_report_id(stem)) n = std::max(n, std::atoi(stem.c_str() + 4));
        }
    return n;
}
} // namespace

json::Value Storage::list_reports() const {
    json::Array v;
    if (fs::exists(reports_dir()))
        for (const auto& e : fs::directory_iterator(reports_dir())) {
            const std::string fn = e.path().filename().string();
            if (e.path().extension() != ".json" || !valid_report_id(e.path().stem().string())) continue;
            try {
                json::Value r = json::parse(read_text(e.path()));
                json::Object s;   // summary for the list; the full report is loaded on demand
                for (const char* k : {"kind", "status", "severity", "title", "created", "updated", "count", "signature"})
                    if (r.has(k)) s[k] = r[k];
                s["id"] = e.path().stem().string();
                v.push_back(json::Value(std::move(s)));
            } catch (...) {}
        }
    std::sort(v.begin(), v.end(), [](const json::Value& a, const json::Value& b) { return a.gets("id", "") > b.gets("id", ""); });
    return json::Value(std::move(v));
}

std::string Storage::load_report(const std::string& id) const {
    if (!valid_report_id(id)) throw std::runtime_error("Invalid report id.");
    json::Value r = json::parse(read_text(reports_dir() / (id + ".json")));
    r["id"] = id;
    return r.dump();
}

json::Value Storage::save_report(const json::Value& report_in, const std::string& markdown) {
    if (!report_in.is_object()) throw std::runtime_error("A report must be a JSON object.");
    if (!KINDS.count(report_in.gets("kind", "")) || !STATUSES.count(report_in.gets("status", "")) || !SEVERITIES.count(report_in.gets("severity", "")))
        throw std::runtime_error("A report needs a known kind, status and severity.");
    std::lock_guard<std::mutex> g(reports_mutex);
    const fs::path d = reports_dir();
    fs::create_directories(d);
    std::string id = report_in.gets("id", "");
    const std::string now = now_iso();
    json::Value r(report_in.obj());
    if (id.empty()) {
        // a captured error that another tab filed a moment ago: hand back that report instead of a duplicate
        const std::string sig = report_in.gets("signature", "");
        const json::Value all = sig.empty() ? json::Value() : list_reports();   // named: arr() refers into it
        if (!sig.empty())
            for (const auto& x : all.arr())
                if (x.gets("signature", "") == sig) {
                    json::Value e = json::parse(load_report(x.gets("id", "")));
                    e["existing"] = true;
                    return e;
                }
        const int n = last_report_number(d) + 1;
        char buf[16];
        std::snprintf(buf, sizeof buf, "SOL-%04d", n);
        id = buf;
        write_atomic(d / ".last-id", std::to_string(n));
        r["created"] = now;
        r["revision"] = 1;
    } else {
        if (!valid_report_id(id)) throw std::runtime_error("Invalid report id.");
        json::Value old;
        try { old = json::parse(read_text(d / (id + ".json"))); } catch (...) { throw std::runtime_error("This report was deleted."); }
        // optimistic concurrency: a save based on an older copy is refused, and the GUI reloads and reapplies its change
        const double rev = old.get("revision", 0.0);
        if (report_in.get("revision", 0.0) != rev) throw std::runtime_error("The report changed since it was opened.");
        r["created"] = old.gets("created", now);
        r["revision"] = rev + 1;
    }
    r["id"] = id;
    r["updated"] = now;
    write_atomic(d / (id + ".json"), r.dump());
    // the Markdown copy names the report by its id; the client writes it with a placeholder until the id is known
    std::string md = markdown;
    for (size_t p; (p = md.find("{{id}}")) != std::string::npos;) md.replace(p, 6, id);
    write_atomic(d / (id + ".md"), md);
    write_report_index();
    return r;
}

void Storage::delete_report(const std::string& id) {
    if (!valid_report_id(id)) throw std::runtime_error("Invalid report id.");
    std::lock_guard<std::mutex> g(reports_mutex);
    fs::remove(reports_dir() / (id + ".json"));
    fs::remove(reports_dir() / (id + ".md"));
    write_report_index();
}

// README.md in the reports folder: every report, newest first
void Storage::write_report_index() const {
    fs::create_directories(reports_dir());
    json::Value all = list_reports();
    std::ostringstream ix;
    ix << "# Soloptima bug and feedback reports\n\nOne file per report: `SOL-nnnn.md` (readable history) and `SOL-nnnn.json` (data).\n\n"
       << "| Report | Kind | Status | Title | Created | Updated |\n|---|---|---|---|---|---|\n";
    for (const auto& x : all.arr())
        ix << "| [" << x.gets("id", "") << "](" << x.gets("id", "") << ".md) | " << label(KINDS, x.gets("kind", "")) << " | " << label(STATUSES, x.gets("status", "")) << " | "
           << cell(x.gets("title", "")) << " | " << x.gets("created", "").substr(0, 10) << " | " << x.gets("updated", "").substr(0, 10) << " |\n";
    write_atomic(reports_dir() / "README.md", ix.str());
}

json::Value Storage::duplicate_project(const std::string& user, const std::string& id) {
    json::Value p = json::parse(load_project(user, id));
    json::Value meta;
    try { meta = json::parse(read_text(user_dir(user) / "projects" / (id + ".meta.json"))); } catch (...) { meta = json::Value::object(); }
    p["name"] = p.gets("name", "Project") + " (copy)";
    return save_project(user, "", p, meta);
}
