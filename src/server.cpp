#include "server.hpp"
#include "json.hpp"
#include "platform.hpp"
#include <atomic>
#include <cctype>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <sstream>
#include <thread>
#include <typeinfo>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
static void close_sock(sock_t s) { closesocket(s); }
static void no_inherit(sock_t s) { SetHandleInformation(reinterpret_cast<HANDLE>(s), HANDLE_FLAG_INHERIT, 0); }
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
static void close_sock(sock_t s) { close(s); }
static void no_inherit(sock_t s) { fcntl(s, F_SETFD, FD_CLOEXEC); }
#endif

namespace {

constexpr size_t MAX_BODY = 96u * 1024 * 1024;
constexpr int MAX_CONNECTIONS = 64;           // the window needs a handful; more are dropped instead of exhausting threads
constexpr int REQUEST_DEADLINE_MS = 15000;    // the whole request (headers and body) must arrive within this time
constexpr int SEND_TIMEOUT_MS = 15000;        // a send that stalls this long (the client stopped reading) ends the connection
std::atomic<int> active_connections{0};

using Clock = std::chrono::steady_clock;

// Limits the next recv to the time left before the request's deadline; false when it has passed
bool arm_deadline(sock_t fd, Clock::time_point deadline) {
    const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (ms <= 0) return false;
#ifdef _WIN32
    const DWORD t = DWORD(ms);
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&t), sizeof t);
#else
    timeval tv{time_t(ms / 1000), suseconds_t((ms % 1000) * 1000)};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
#endif
    return true;
}

bool same_key(const std::string& a, const std::string& b) {   // time does not depend on where the strings differ
    if (b.empty() || a.size() != b.size()) return false;
    unsigned char d = 0;
    for (size_t i = 0; i < a.size(); ++i) d |= static_cast<unsigned char>(a[i] ^ b[i]);
    return d == 0;
}

bool valid_utf8(const std::string& s) {
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        const size_t n = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
        if (n == 0 || i + n > s.size()) return false;
        for (size_t k = 1; k < n; ++k) if ((static_cast<unsigned char>(s[i + k]) >> 6) != 2) return false;
        i += n;
    }
    return true;
}

// A static path the web root can serve: no parent references, backslashes, stream syntax, control bytes or invalid UTF-8,
// and no component Windows maps to a device (CON, NUL, COM1, ... with or without an extension)
bool safe_static_path(const std::string& p) {
    if (p.empty() || p[0] != '/' || p.find("..") != std::string::npos || p.find_first_of("\\:") != std::string::npos || !valid_utf8(p))
        return false;
    for (unsigned char c : p) if (c < 0x20 || c == 0x7f) return false;
    for (size_t a = 1; a <= p.size();) {
        size_t b = p.find('/', a);
        if (b == std::string::npos) b = p.size();
        std::string stem = p.substr(a, std::min(p.find('.', a), b) - a);
        for (auto& ch : stem) ch = char(std::toupper(static_cast<unsigned char>(ch)));
        if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CONIN$" || stem == "CONOUT$" ||
            (stem.size() == 4 && (stem.compare(0, 3, "COM") == 0 || stem.compare(0, 3, "LPT") == 0) && std::isdigit(static_cast<unsigned char>(stem[3]))))
            return false;
        a = b + 1;
    }
    return true;
}

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
    const std::string p = path == "/" ? "/index.html" : path;
    if (!safe_static_path(p)) return {400, "text/plain", "bad path"};
    const auto file = std::filesystem::u8path(web_root_ + p);
    std::error_code ec;
    std::string body;
    if (!std::filesystem::is_regular_file(file, ec) || !read_file(file, body)) return {404, "text/plain", "not found"};
    return {200, mime(p), std::move(body)};
}

void HttpServer::handle(long long fd_) {
    sock_t fd = sock_t(fd_);
    try { respond(fd); } catch (...) {}   // nothing a client sends may end the engine
    close_sock(fd);
}

void HttpServer::respond(long long fd_) {
    sock_t fd = sock_t(fd_);
#ifdef _WIN32
    const DWORD send_timeout = SEND_TIMEOUT_MS;
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&send_timeout), sizeof send_timeout);
#else
    const timeval send_timeout{time_t(SEND_TIMEOUT_MS / 1000), 0};
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof send_timeout);
#endif
    const auto deadline = Clock::now() + std::chrono::milliseconds(REQUEST_DEADLINE_MS);
    std::string buf;
    char tmp[65536];
    size_t header_end = std::string::npos;
    while (header_end == std::string::npos) {
        if (!arm_deadline(fd, deadline)) return;
        auto k = recv(fd, tmp, sizeof tmp, 0);
        if (k <= 0) return;   // closed, failed or too slow
        const size_t from = buf.size() < 3 ? 0 : buf.size() - 3;
        buf.append(tmp, size_t(k));
        header_end = buf.find("\r\n\r\n", from);
        if (buf.size() > 1 << 20 && header_end == std::string::npos) return;
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
    const bool api = req.path.rfind("/api/", 0) == 0;
    // every API call carries the session key, in the window and in the browser; /api/session trades the one-time launch
    // code for it and /api/health only says that Soloptima runs
    const bool key_ok = !api || req.path == "/api/health" || req.path == "/api/session" ||
                        (req.headers.count("x-soloptima") && same_key(req.headers["x-soloptima"], token_));
    const bool needs_header = api && req.method != "GET" && !req.headers.count("x-soloptima");   // forces a CORS preflight
    size_t clen = req.headers.count("content-length") ? std::strtoull(req.headers["content-length"].c_str(), nullptr, 10) : 0;
    if (!local_host) {
        res = {403, "text/plain", "Soloptima only answers requests addressed to 127.0.0.1"};
    } else if (needs_header || !key_ok) {
        res = {403, "application/json", "{\"error\":\"This page has no valid session key. Start Soloptima again, or open the address it printed.\"}"};
    } else if (clen > MAX_BODY) {
        res = {413, "text/plain", "request too large"};
    } else {
        req.body = buf.substr(header_end + 4);
        req.body.reserve(std::min<size_t>(clen, 1 << 20));   // grows with what arrives, not with what the client declares
        while (req.body.size() < clen) {
            if (!arm_deadline(fd, deadline)) return;
            auto k = recv(fd, tmp, sizeof tmp, 0);
            if (k <= 0) return;
            req.body.append(tmp, size_t(k));
        }
        if (routes_.count(req.method + " " + req.path)) {
            res = call(req);
        } else if (req.method == "GET" && !api) {
            res = serve_static(req.path);
        } else {
            res = {404, "application/json", "{\"error\":\"unknown endpoint\"}"};
        }
    }
    static const bool log = std::getenv("SOLOPTIMA_LOG") != nullptr;   // one line per request, for diagnosing the window
    if (log) std::fprintf(stderr, "%s %s %d\n", req.method.c_str(), req.path.c_str(), res.status);
    // no other site may frame the interface (clickjacking) or reinterpret a response's type
    std::string head = "HTTP/1.1 " + std::to_string(res.status) + " " + status_text(res.status) +
                       "\r\nContent-Type: " + res.content_type + "\r\nContent-Length: " + std::to_string(res.body.size()) +
                       "\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff" +
                       "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    if (send_all(fd, head.data(), head.size())) send_all(fd, res.body.data(), res.body.size());
}

bool HttpServer::bind_port(int port) {
#ifdef _WIN32
    static bool wsa_ok = [] { WSADATA wsa; return WSAStartup(MAKEWORD(2, 2), &wsa) == 0; }();
    (void)wsa_ok;
#endif
    sock_t s = socket(AF_INET, SOCK_STREAM, 0);
    no_inherit(s);   // programs the engine starts (folder picker, update helper) must not keep the port
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
        const bool failed = c == INVALID_SOCKET;
#else
        const bool failed = c < 0;
#endif
        if (failed) { std::this_thread::sleep_for(std::chrono::milliseconds(50)); continue; }   // e.g. out of descriptors: no busy loop
        no_inherit(c);
        if (active_connections.load() >= MAX_CONNECTIONS) { close_sock(c); continue; }
        ++active_connections;
        try {
            std::thread([this, c] {
                struct Done { ~Done() { --active_connections; } } done;
                handle((long long)c);
            }).detach();
        } catch (...) {   // no thread to be had: drop this connection, keep serving
            --active_connections;
            close_sock(c);
        }
    }
}

// One API call without a socket: the route's answer, or its error as {"error", "internal"} (the desktop shell calls this)
Response HttpServer::call(const Request& req) {
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
