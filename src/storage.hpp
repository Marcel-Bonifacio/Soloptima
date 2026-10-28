// Local project store: one folder per user profile, one JSON file per project plus a small metadata sidecar
// for fast listing, and a reports folder with the bug and feedback reports (JSON, a Markdown copy of each, and an index).
// Lives under the data directory chosen by main.cpp (find_data_dir).
#pragma once
#include "json.hpp"
#include <filesystem>
#include <mutex>
#include <string>

// Writes through a temporary file, so a crash or a full disk never leaves a half-written file in place.
void write_atomic(const std::filesystem::path& p, const std::string& text);

class Storage {
public:
    explicit Storage(std::filesystem::path root);
    json::Value list_users() const;
    json::Value create_user(const json::Value& profile);   // name, organisation, email, terms_version (accepted now)
    json::Value accept_terms(const std::string& user, const std::string& version);
    json::Value update_user(const std::string& user, const json::Value& changes);   // name, organisation, email, avatar (Settings)
    void delete_user(const std::string& user);
    json::Value list_projects(const std::string& user) const;
    std::string load_project(const std::string& user, const std::string& id) const;   // raw JSON text
    json::Value save_project(const std::string& user, const std::string& id, const json::Value& project,
                             const json::Value& meta);
    void delete_project(const std::string& user, const std::string& id);
    json::Value duplicate_project(const std::string& user, const std::string& id);
    json::Value list_reports() const;
    std::string load_report(const std::string& id) const;   // raw JSON text
    json::Value save_report(const json::Value& report, const std::string& markdown);   // assigns an id to a new report
    void delete_report(const std::string& id);
    std::filesystem::path reports_dir() const { return root() / "reports"; }
    std::filesystem::path root() const;
    void set_root(const std::filesystem::path& root);   // another data folder (Settings), used from the next request on
    int remove_temp_files() const;   // leftovers of interrupted saves, older than a minute

private:
    mutable std::mutex root_m_;
    std::filesystem::path root_;
    std::filesystem::path user_dir(const std::string& user) const;   // validates the id
    void write_report_index() const;
};
