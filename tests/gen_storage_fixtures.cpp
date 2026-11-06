// Writes engine/tests/fixtures/storage.json from the C++ engine: a scripted run of Storage on a planted data folder (profiles,
// projects, reports, some of them bad), each step's answer or error with times and random ids normalised. The Rust tests
// (engine/tests/storage.rs) plant the same folder and run the same steps.
//   c++ -std=c++17 -O1 -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/gens2 tests/gen_storage_fixtures.cpp src/storage.cpp src/platform.cpp -lcurl
//   /tmp/gens2 engine/tests/fixtures/storage.json /tmp/storage-gen
#include "json.hpp"
#include "platform.hpp"
#include "storage.hpp"
#include <fstream>
#include <algorithm>
#include <iostream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;
static void put(const fs::path& p, const std::string& text) { fs::create_directories(p.parent_path()); std::ofstream(p, std::ios::binary) << text; }
static std::string slurp(const fs::path& p) { std::ifstream f(p, std::ios::binary); std::stringstream s; s << f.rdbuf(); return s.str(); }
static std::vector<std::string> ids;   // the random ids made so far
static std::string norm(std::string s) {
    s = std::regex_replace(s, std::regex(R"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)"), "T");
    for (const auto& id : ids) for (size_t p; (p = s.find(id)) != std::string::npos;) s.replace(p, id.size(), "ID");
    return s;
}
// an array with its elements in the order of their text: the order among equal times is not defined
static std::string sorted(const json::Value& v) {
    std::vector<std::string> e;
    for (const auto& x : v.arr()) e.push_back(norm(x.dump()));
    std::sort(e.begin(), e.end());
    std::string s = "[";
    for (size_t i = 0; i < e.size(); ++i) s += (i ? "," : "") + e[i];
    return s + "]";
}

int main(int, char** argv) {
    const fs::path root = argv[2];
    fs::remove_all(root);
    const fs::path A = root / "users" / "alice-abc123" / "projects";
    put(root / "users" / "alice-abc123" / "profile.json", R"({"id":"alice-abc123","name":"Alice","organisation":"Org"})");
    put(A / "p1.json", R"({"id":"p1","name":"P one","a":1})");
    put(A / "p1.meta.json", R"({"id":"p1","name":"P one","updated":"2025-02-01T10:00:00Z","created":"2025-01-01T10:00:00Z"})");
    put(A / "p2.json", R"({"name":"P two"})");
    put(A / "p2.meta.json", R"({"id":"p2","name":"P two","updated":"evil<script>","created":"2025-01-02T10:00:00Z"})");
    put(A / "p3.meta.json", R"({"id":"other","name":"X"})");
    put(A / "notes.txt", "hello");
    put(root / "users" / "bob-xyz789" / "profile.json", R"({"id":"bob-xyz789","name":"Bob"})");
    fs::create_directories(root / "users" / "bob-xyz789" / "projects");
    put(root / "users" / "mismatch" / "profile.json", R"({"id":"other","name":"M"})");
    put(root / "users" / "COM1" / "profile.json", R"({"id":"COM1","name":"Dev"})");
    fs::create_directories(root / "users" / "nofile");
    put(root / "reports" / "SOL-0001.json", R"({"kind":"bug","status":"new","severity":"low","title":"First | bug\nline","created":"2025-01-01T00:00:00Z","updated":"2025-01-01T00:00:00Z","count":2,"signature":"sig1","revision":1,"body":"x"})");
    put(root / "reports" / "SOL-0002.json", std::string(R"({"kind":"feedback","status":"closed","severity":"high","title":")") + std::string(95, 'z') + R"(","created":"2025-01-02T00:00:00Z","updated":"2025-01-03T00:00:00Z","revision":3})");
    put(root / "reports" / "SOL-12.json", "{}");
    put(root / "reports" / "SOL-0003.txt", "x");
    put(root / "reports" / "SOL-0004.json", "{not json");

    Storage st(root);
    json::Array out;
    auto rec = [&](const std::string& name, auto fn, const std::string& id_key = "") {
        std::string r;
        try {
            const json::Value v = fn();
            if (!id_key.empty() && id_key[0] != '*') ids.push_back(v.gets(id_key, ""));
            r = "OK " + (id_key == "*sorted" ? sorted(v) : norm(v.dump()));
        } catch (const std::exception& e) { r = std::string("ERR ") + e.what(); }
        out.push_back(json::Object{{"name", name}, {"result", r}});
    };
    auto rec_text = [&](const std::string& name, auto fn) {
        std::string r;
        try { r = "OK " + norm(fn()); } catch (const std::exception& e) { r = std::string("ERR ") + e.what(); }
        out.push_back(json::Object{{"name", name}, {"result", r}});
    };
    auto J = [](const char* s) { return json::parse(s); };
    rec("list users", [&] { return st.list_users(); });
    rec("projects alice", [&] { return st.list_projects("alice-abc123"); });
    rec("projects bob", [&] { return st.list_projects("bob-xyz789"); });
    rec("projects nofile", [&] { return st.list_projects("nofile"); });
    rec("projects COM1", [&] { return st.list_projects("COM1"); });
    rec("projects dotdot", [&] { return st.list_projects("../x"); });
    rec_text("load p1", [&] { return st.load_project("alice-abc123", "p1"); });
    rec_text("load p9", [&] { return st.load_project("alice-abc123", "p9"); });
    rec_text("load bad id", [&] { return st.load_project("alice-abc123", "a/b"); });
    rec("save p4", [&] { return st.save_project("alice-abc123", "p4", J(R"({"name":"Four","x":[1,2]})"), J(R"({"tags":["a"]})")); });
    rec_text("p4 file", [&] { return slurp(A / "p4.json"); });
    rec_text("p4 meta file", [&] { return slurp(A / "p4.meta.json"); });
    rec("save p1 again", [&] { return st.save_project("alice-abc123", "p1", J(R"({"name":"P one v2"})"), J("{}")); });
    rec("save bad id", [&] { return st.save_project("alice-abc123", "bad id", J("{}"), J("{}")); });
    rec("save nofile user", [&] { return st.save_project("nofile", "q", J("{}"), J("{}")); });
    rec("save non-object", [&] { return st.save_project("alice-abc123", "p5", J("[1]"), J("5")); });
    rec_text("p5 file", [&] { return slurp(A / "p5.json"); });
    rec("save new id", [&] { return st.save_project("alice-abc123", "", J(R"({"name":"Fresh Start!"})"), J("{}")); }, "id");
    rec("duplicate p1", [&] { return st.duplicate_project("alice-abc123", "p1"); }, "id");
    rec("projects alice after", [&] { return st.list_projects("alice-abc123"); }, "*sorted");
    rec("delete p2", [&] { st.delete_project("alice-abc123", "p2"); return json::Value(true); });
    rec("delete p2 again", [&] { st.delete_project("alice-abc123", "p2"); return json::Value(true); });
    rec("create user", [&] { return st.create_user(J(R"({"name":"  Carol Ng ","organisation":"X","email":"c@x","terms_version":"1.3"})")); }, "id");
    rec("create blank", [&] { return st.create_user(J(R"({"name":"   "})")); });
    rec("create long name", [&] { return st.create_user(J(R"({"name":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","terms_version":"12345678901234567890123"})")); }, "id");
    rec("accept terms", [&] { return st.accept_terms("alice-abc123", "1.3"); });
    rec("accept bad version", [&] { return st.accept_terms("alice-abc123", ""); });
    rec("update user", [&] { return st.update_user("alice-abc123", J(R"({"name":"Alicia","organisation":"","email":"a@b","avatar":"data:image/png;base64,iVBOR="})")); });
    rec("update bad avatar", [&] { return st.update_user("alice-abc123", J(R"({"avatar":"data:text/html;base64,AAAA"})")); });
    rec("update avatar removed", [&] { return st.update_user("alice-abc123", J(R"({"avatar":""})")); });
    rec("update blank name", [&] { return st.update_user("alice-abc123", J(R"({"name":""})")); });
    rec("update nobody", [&] { return st.update_user("nobody-aaaaaa", J("{}")); });
    rec("delete nobody", [&] { st.delete_user("nobody-aaaaaa"); return json::Value(true); });
    rec("list users after", [&] { return st.list_users(); });
    rec("list reports", [&] { return st.list_reports(); });
    rec_text("load report 1", [&] { return st.load_report("SOL-0001"); });
    rec_text("load report missing", [&] { return st.load_report("SOL-9999"); });
    rec_text("load report invalid", [&] { return st.load_report("SOL-1"); });
    rec("save report new", [&] { return st.save_report(J(R"({"kind":"bug","status":"new","severity":"low","title":"New one","signature":"sigN"})"), "# {{id}} title\n{{id}}\n"); });
    rec_text("report 5 md", [&] { return slurp(root / "reports" / "SOL-0005.md"); });
    rec_text("report index", [&] { return slurp(root / "reports" / "README.md"); });
    rec("save report same signature", [&] { return st.save_report(J(R"({"kind":"bug","status":"new","severity":"low","signature":"sigN"})"), "x"); });
    rec("save report update", [&] { return st.save_report(J(R"({"id":"SOL-0005","revision":1,"kind":"bug","status":"fixed","severity":"low","title":"New | one\r\nx"})"), "md"); });
    rec("save report stale", [&] { return st.save_report(J(R"({"id":"SOL-0005","revision":1,"kind":"bug","status":"fixed","severity":"low"})"), "md"); });
    rec("save report deleted", [&] { return st.save_report(J(R"({"id":"SOL-0100","kind":"bug","status":"new","severity":"low"})"), "md"); });
    rec("save report bad id", [&] { return st.save_report(J(R"({"id":"x","kind":"bug","status":"new","severity":"low"})"), "md"); });
    rec("save report bad kind", [&] { return st.save_report(J(R"({"kind":"nope","status":"new","severity":"low"})"), "md"); });
    rec("save report not object", [&] { return st.save_report(J("[]"), "md"); });
    rec("delete report 2", [&] { st.delete_report("SOL-0002"); return json::Value(true); });
    rec("delete report invalid", [&] { st.delete_report("../x"); return json::Value(true); });
    rec("list reports after", [&] { return st.list_reports(); });
    rec_text("report index after", [&] { return slurp(root / "reports" / "README.md"); });
    rec_text("last id", [&] { return slurp(root / "reports" / ".last-id"); });
    std::ofstream(argv[1], std::ios::binary) << json::Value(out).dump();
    std::cout << out.size() << " steps\n";
}
