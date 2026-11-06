// The engine's routes, called in process by the desktop shell (soloptima_call in main.cpp, docs/ipc.md). There is no
// socket: a route is a function from a Request to a Response, found by method and path.
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

class Router {
public:
    void route(const std::string& method, const std::string& path, Handler h) { routes_[method + " " + path] = std::move(h); }
    // One API call: the route's answer, or its error as {"error", "internal"}
    Response call(const Request& req);

private:
    std::map<std::string, Handler> routes_;
};
