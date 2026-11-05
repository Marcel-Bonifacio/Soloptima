#include "storage.hpp"
#include "platform.hpp"
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <random>
#include <sstream>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {
constexpr std::uintmax_t MAX_DATA_FILE = 256u << 20;   // a project with every hourly series is a few MiB
std::string rand_suffix();
}

// The new content goes to a new file under an unused name next to the target, created exclusively (never through a name or a
// link someone placed there), and then replaces the target in one rename. The .tmp ending lets Clear cache find leftovers.
void write_atomic(const fs::path& p, const std::string& text) {
    const auto fail = [] { throw std::runtime_error("Cannot write a file in the data folder (is the disk full?)."); };
    for (int attempt = 0;; ++attempt) {
        fs::path tmp = p.parent_path() / ("." + p.filename().string() + "." + rand_suffix() + ".tmp");
#ifdef _WIN32
        HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            if (GetLastError() == ERROR_FILE_EXISTS && attempt < 8) continue;
            fail();
        }
        DWORD n = 0;
        const bool ok = WriteFile(h, text.data(), DWORD(text.size()), &n, nullptr) && n == text.size();
        CloseHandle(h);
#else
        const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (fd < 0) {
            if (errno == EEXIST && attempt < 8) continue;
            fail();
        }
        bool ok = true;
        for (size_t off = 0; ok && off < text.size();) {
            const ssize_t k = ::write(fd, text.data() + off, text.size() - off);
            if (k <= 0) ok = false; else off += size_t(k);
        }
        ok = (::close(fd) == 0) && ok;
#endif
        if (!ok) {   // disk full or no access: keep the existing file
            std::error_code ec;
            fs::remove(tmp, ec);
            fail();
        }
        replace_file(tmp, p);
        return;
    }
}

namespace {
// A file in the data folder: a regular file of sane size, never read through a link (the folder may come from elsewhere)
std::string read_text(const fs::path& p) {
    std::string s;
#ifdef _WIN32
    std::error_code ec;
    const auto st = fs::symlink_status(p, ec);
    if (ec || !fs::is_regular_file(st) || fs::file_size(p, ec) > MAX_DATA_FILE || !read_file(p, s)) throw std::runtime_error("Not found.");
#else
    const int fd = ::open(p.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) throw std::runtime_error("Not found.");
    struct stat st {};
    if (::fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || std::uintmax_t(st.st_size) > MAX_DATA_FILE) {
        ::close(fd);
        throw std::runtime_error("Not found.");
    }
    s.resize(size_t(st.st_size));
    size_t off = 0;
    for (ssize_t k; off < s.size() && (k = ::read(fd, &s[off], s.size() - off)) > 0;) off += size_t(k);
    ::close(fd);
    s.resize(off);
#endif
    return s;
}
// No folder between the data root and p may be a link: a folder opened from another computer must not point Soloptima's
// reads and writes at the user's other files
void no_link(const fs::path& root, const fs::path& p) {
    fs::path cur = root;
    for (const auto& part : p.lexically_relative(root)) {
        cur /= part;
        std::error_code ec;
        if (fs::is_symlink(fs::symlink_status(cur, ec)))
            throw std::runtime_error("The data folder holds a link (" + part.u8string() + "), which Soloptima does not follow.");
    }
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
    if (!std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_'; })) return false;
    std::string u;   // names Windows reserves for devices
    for (char c : s) u += char(std::toupper(static_cast<unsigned char>(c)));
    if (u == "CON" || u == "PRN" || u == "AUX" || u == "NUL") return false;
    return !(u.size() == 4 && (u.compare(0, 3, "COM") == 0 || u.compare(0, 3, "LPT") == 0) && u[3] >= '1' && u[3] <= '9');
}
// An "updated" or "created" time as the engine writes it (2026-01-31T12:00:00Z)
bool iso_time(const std::string& s) {
    return s.size() <= 32 && std::all_of(s.begin(), s.end(), [](char c) {
        return std::isdigit(static_cast<unsigned char>(c)) || c == '-' || c == ':' || c == 'T' || c == 'Z' || c == '.' || c == '+';
    });
}
// A profile name: at most 60 characters, not blank
std::string profile_name(const json::Value& v) {
    std::string name = utf8_prefix(v.gets("name", ""), 60);
    if (name.find_first_not_of(" \t") == std::string::npos) throw std::runtime_error("Enter a name.");
    return name;
}
} // namespace

Storage::Storage(fs::path root) : root_(std::move(root)) { make_private_dirs(root_ / "users"); }

fs::path Storage::root() const {
    std::lock_guard<std::mutex> g(root_m_);
    return root_;
}
void Storage::set_root(const fs::path& root) {
    make_private_dirs(root / "users");
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
    const fs::path r = root(), d = r / "users" / user;
    no_link(r, d / "projects");
    return d;
}

fs::path Storage::reports_dir() const {
    const fs::path r = root(), d = r / "reports";
    no_link(r, d);
    return d;
}

json::Value Storage::list_users() const {
    json::Array v;
    const fs::path users = root() / "users";
    no_link(root(), users);
    for (const auto& e : fs::directory_iterator(users)) {
        std::error_code ec;
        if (e.is_symlink(ec) || !e.is_directory(ec)) continue;
        // a profile counts only when its id is the folder's name: the GUI uses these ids in its pages
        const std::string dir = e.path().filename().string();
        json::Value u;
        try { u = json::parse(read_text(e.path() / "profile.json")); } catch (...) { continue; }
        if (!valid_id(dir) || !u.is_object() || u.gets("id", "") != dir) continue;
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
    const std::string name = profile_name(profile);
    const std::string id = slug(name) + "-" + rand_suffix();
    const fs::path d = user_dir(id);
    make_private_dirs(d / "projects");
    const std::string now = utc_now_iso();
    json::Value u(json::Object{{"id", id}, {"name", name}, {"created", now}});
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
    u["terms_accepted"] = utc_now_iso();
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
    if (ch.has("name")) u["name"] = profile_name(ch);
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
            json::Value m;
            try { m = json::parse(read_text(e.path())); } catch (...) { continue; }
            // only metas whose id is their file's name, with times as the engine writes them
            const std::string id = fn.substr(0, fn.size() - 10);
            if (!valid_id(id) || !m.is_object() || m.gets("id", "") != id) continue;
            for (const char* k : {"updated", "created"})
                if (m.has(k) && !iso_time(m.gets(k, ""))) m.obj_mut().erase(k);
            v.push_back(std::move(m));
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
    make_private_dirs(d);
    const std::string id = id_in.empty() ? slug(project.gets("name", "project")) + "-" + rand_suffix() : id_in;
    if (!valid_id(id)) throw std::runtime_error("Invalid project id.");
    const std::string now = utc_now_iso();
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
    return utf8_prefix(s, 90) == s ? s : utf8_prefix(s, 87) + "...";
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
    make_private_dirs(d);
    std::string id = report_in.gets("id", "");
    const std::string now = utc_now_iso();
    json::Value r(report_in.obj());
    if (id.empty()) {
        // a captured error that another tab filed a moment ago: hand back that report instead of a duplicate
        const std::string sig = report_in.gets("signature", "");
        if (!sig.empty()) {
            const json::Value all = list_reports();   // named: arr() refers into it
            for (const auto& x : all.arr())
                if (x.gets("signature", "") == sig) {
                    json::Value e = json::parse(load_report(x.gets("id", "")));
                    e["existing"] = true;
                    return e;
                }
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
    make_private_dirs(reports_dir());
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
