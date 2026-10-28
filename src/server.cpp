#include "server.hpp"
#include "json.hpp"
#include <cctype>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>
#include <typeinfo>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
static void close_sock(sock_t s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
static void close_sock(sock_t s) { close(s); }
#endif

namespace {

constexpr size_t MAX_BODY = 96u * 1024 * 1024;

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

const char* status_text(int s) {
    switch (s) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 413: return "Payload Too Large";
    default: return "OK";
    }
}

std::string mime(const std::string& path) {
    auto ends = [&](const char* e) { size_t n = std::strlen(e); return path.size() >= n && path.compare(path.size() - n, n, e) == 0; };
    if (ends(".html")) return "text/html; charset=utf-8";
    if (ends(".js")) return "application/javascript; charset=utf-8";
    if (ends(".css")) return "text/css; charset=utf-8";
    if (ends(".json")) return "application/json";
    if (ends(".png")) return "image/png";
    if (ends(".svg")) return "image/svg+xml";
    if (ends(".woff2")) return "font/woff2";
    return "application/octet-stream";
}

bool send_all(sock_t fd, const char* data, size_t n) {
    while (n > 0) {
        auto k = send(fd, data, int(n), 0);
        if (k <= 0) return false;
        data += k;
        n -= size_t(k);
    }
    return true;
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

Response HttpServer::serve_static(const std::string& path) const {
    std::string p = path == "/" ? "/index.html" : path;
    if (p[0] != '/' || p.find("..") != std::string::npos || p.find('\\') != std::string::npos) return {400, "text/plain", "bad path"};
    std::ifstream f(web_root_ + p, std::ios::binary);
    if (!f) return {404, "text/plain", "not found"};
    std::ostringstream ss;
    ss << f.rdbuf();
    return {200, mime(p), ss.str()};
}

void HttpServer::handle(long long fd_) {
    sock_t fd = sock_t(fd_);
    std::string buf;
    char tmp[65536];
    size_t header_end = std::string::npos;
    while (header_end == std::string::npos) {
        auto k = recv(fd, tmp, sizeof tmp, 0);
        if (k <= 0) { close_sock(fd); return; }
        buf.append(tmp, size_t(k));
        header_end = buf.find("\r\n\r\n");
        if (buf.size() > 1 << 20 && header_end == std::string::npos) { close_sock(fd); return; }
    }
    Request req;
    std::istringstream hs(buf.substr(0, header_end));
    std::string line, target;
    std::getline(hs, line);
    std::istringstream rl(line);
    rl >> req.method >> target;
    while (std::getline(hs, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        auto c = line.find(':');
        if (c == std::string::npos) continue;
        std::string k = line.substr(0, c), v = line.substr(c + 1);
        for (auto& ch : k) ch = char(std::tolower((unsigned char)ch));
        while (!v.empty() && v.front() == ' ') v.erase(0, 1);
        req.headers[k] = v;
    }
    auto q = target.find('?');
    req.path = target.substr(0, q);
    req.query = q == std::string::npos ? "" : target.substr(q + 1);

    Response res;
    const std::string& host = req.headers["host"];
    const auto host_is = [&](const char* h) { size_t n = std::strlen(h); return host.compare(0, n, h) == 0 && (host.size() == n || host[n] == ':'); };
    const bool local_host = host_is("127.0.0.1") || host_is("localhost") || host_is("[::1]");
    const bool api_write = req.path.rfind("/api/", 0) == 0 && req.method != "GET";
    size_t clen = req.headers.count("content-length") ? std::strtoull(req.headers["content-length"].c_str(), nullptr, 10) : 0;
    if (!local_host) {
        res = {403, "text/plain", "Soloptima only answers requests addressed to 127.0.0.1"};
    } else if (api_write && !req.headers.count("x-soloptima")) {
        res = {403, "application/json", "{\"error\":\"missing X-Soloptima header\"}"};
    } else if (clen > MAX_BODY) {
        res = {413, "text/plain", "request too large"};
    } else {
        req.body = buf.substr(header_end + 4);
        req.body.reserve(clen);
        while (req.body.size() < clen) {
            auto k = recv(fd, tmp, sizeof tmp, 0);
            if (k <= 0) break;
            req.body.append(tmp, size_t(k));
        }
        auto it = routes_.find(req.method + " " + req.path);
        if (it != routes_.end()) {
            // The engine's own messages are std::runtime_error. Anything else is a defect ("internal": the GUI files a bug
            // report); file-system errors carry local paths, so they are logged here and answered without them.
            try { res = it->second(req); }
            catch (const std::filesystem::filesystem_error& e) {
                std::fprintf(stderr, "%s\n", e.what());
                res = {400, "application/json", json::Value(json::Object{{"error", "Cannot use the data folder: " + e.code().message() + "."}, {"internal", true}}).dump()};
            } catch (const std::exception& e) {
                json::Object o{{"error", e.what()}};
                if (typeid(e) != typeid(std::runtime_error)) o["internal"] = true;
                res = {400, "application/json", json::Value(std::move(o)).dump()};
            }
        } else if (req.method == "GET" && req.path.rfind("/api/", 0) != 0) {
            res = serve_static(req.path);
        } else {
            res = {404, "application/json", "{\"error\":\"unknown endpoint\"}"};
        }
    }
    std::string head = "HTTP/1.1 " + std::to_string(res.status) + " " + status_text(res.status) +
                       "\r\nContent-Type: " + res.content_type + "\r\nContent-Length: " + std::to_string(res.body.size()) +
                       "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    if (send_all(fd, head.data(), head.size())) send_all(fd, res.body.data(), res.body.size());
    close_sock(fd);
}

bool HttpServer::bind_port(int port) {
#ifdef _WIN32
    static bool wsa_ok = [] { WSADATA wsa; return WSAStartup(MAKEWORD(2, 2), &wsa) == 0; }();
    (void)wsa_ok;
#endif
    sock_t s = socket(AF_INET, SOCK_STREAM, 0);
#ifndef _WIN32
    int yes = 1;   // on Windows SO_REUSEADDR would let a second instance steal the port
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof yes);
#endif
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(uint16_t(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // local only
    if (bind(s, (sockaddr*)&addr, sizeof addr) != 0 || ::listen(s, 64) != 0) { close_sock(s); return false; }
    sock_ = (long long)s;
    return true;
}

void HttpServer::run() {
#ifndef _WIN32
    std::signal(SIGPIPE, SIG_IGN);   // a browser that drops the connection mid-response must not end the process
#endif
    const sock_t s = sock_t(sock_);
    for (;;) {
        sock_t c = accept(s, nullptr, nullptr);
#ifdef _WIN32
        if (c == INVALID_SOCKET) continue;
#else
        if (c < 0) continue;
#endif
        std::thread([this, c] { handle((long long)c); }).detach();
    }
}
