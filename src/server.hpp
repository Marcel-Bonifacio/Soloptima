// Tiny HTTP/1.1 server for the local GUI. Binds to 127.0.0.1 only; one thread per connection.
// Hardening against other websites open in the same browser: requests must carry a localhost Host header
// (blocks DNS rebinding) and every non-GET API call must carry the X-Soloptima header (blocks cross-site
// form posts, because a custom header forces a CORS preflight this server never approves).
#pragma once
#include <functional>
#include <map>
#include <string>

struct Request {
    std::string method, path, query, body;
    std::map<std::string, std::string> headers;
    std::string param(const std::string& key) const;   // query-string parameter
};

struct Response {
    int status = 200;
    std::string content_type = "application/json";
    std::string body;
};

using Handler = std::function<Response(const Request&)>;

class HttpServer {
public:
    HttpServer(std::string web_root) : web_root_(std::move(web_root)) {}
    void route(const std::string& method, const std::string& path, Handler h) { routes_[method + " " + path] = std::move(h); }
    bool bind_port(int port);   // false if the port is taken
    void run();                 // serve forever on the bound port

private:
    std::string web_root_;
    std::map<std::string, Handler> routes_;
    long long sock_ = -1;
    void handle(long long fd);
    Response serve_static(const std::string& path) const;
};
