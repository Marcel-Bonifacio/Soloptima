// Tiny HTTP/1.1 server for the local GUI. Binds to 127.0.0.1 only; one thread per connection, at most 64 at a time, and a
// request must arrive within 15 s. Requests must carry a localhost Host header (blocks DNS rebinding), and every API call
// must carry the session key in X-Soloptima (set_token): the window injects it, the browser page gets it once for its launch
// code (/api/session). Only /api/health and /api/session are exempt. Responses refuse framing by other sites.
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
    void set_token(std::string t) { token_ = std::move(t); }
    bool bind_port(int port);   // false if the port is taken
    void run();                 // serve forever on the bound port
    Response call(const Request& req);   // one API route without a socket (key and host checks are the caller's)

private:
    std::string web_root_, token_;
    std::map<std::string, Handler> routes_;
    long long sock_ = -1;
    void handle(long long fd);    // one connection: respond, then close it whatever happens
    void respond(long long fd);
    Response serve_static(const std::string& path) const;
};
