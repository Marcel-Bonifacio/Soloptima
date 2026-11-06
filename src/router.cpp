#include "router.hpp"
#include "json.hpp"
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <sstream>
#include <typeinfo>

namespace {

std::string url_decode(const std::string& s) {
    std::string o;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '+') o += ' ';
        else if (s[i] == '%' && i + 2 < s.size() && std::isxdigit((unsigned char)s[i + 1]) && std::isxdigit((unsigned char)s[i + 2])) {
            o += char(std::stoi(s.substr(i + 1, 2), nullptr, 16));
            i += 2;
        } else o += s[i];
    }
    return o;
}

} // namespace

std::string Request::param(const std::string& key) const {
    std::istringstream ss(query);
    std::string kv;
    while (std::getline(ss, kv, '&')) {
        auto eq = kv.find('=');
        if (url_decode(kv.substr(0, eq)) == key) return eq == std::string::npos ? "" : url_decode(kv.substr(eq + 1));
    }
    return "";
}

Response Router::call(const Request& req) {
    Response res;
    auto it = routes_.find(req.method + " " + req.path);
    if (it == routes_.end()) return {404, "application/json", "{\"error\":\"unknown endpoint\"}"};
    try { res = it->second(req); }
    catch (const std::filesystem::filesystem_error& e) {
        std::fprintf(stderr, "%s\n", e.what());
        res = {400, "application/json", json::Value(json::Object{{"error", "Cannot use the data folder: " + e.code().message() + "."}, {"internal", true}}).dump()};
    } catch (const std::exception& e) {
        json::Object o{{"error", e.what()}};
        if (typeid(e) != typeid(std::runtime_error)) o["internal"] = true;
        res = {400, "application/json", json::Value(std::move(o)).dump()};
    }
    return res;
}
