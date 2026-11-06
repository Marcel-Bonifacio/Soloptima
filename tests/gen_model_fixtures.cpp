// Writes the expected results of the Rust engine's model tests from the C++ engine (engine/tests/fixtures):
//   c++ -std=c++17 -O1 -Isrc -o /tmp/gen tests/gen_model_fixtures.cpp src/model.cpp
//   /tmp/gen web/examples/example_study.json engine/tests/fixtures
// reads cases_in.json (mutations of the example project) and roundtrip_in.json (JSON texts), writes cases.json and
// roundtrip.json (and example_canonical.json, see below) with what json::parse / dump / validate_project answer.
#include "json.hpp"
#include "model.hpp"
#include <fstream>
#include <iostream>
#include <sstream>

static std::string slurp(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream s;
    s << f.rdbuf();
    return s.str();
}

// {"$repeat": [x, n]} stands for an array of n times x
static json::Value expand(const json::Value& v) {
    if (v.has("$repeat")) return json::Value(json::Array(size_t(v["$repeat"][1].num()), v["$repeat"][0]));
    return v;
}

static void set_path(json::Value& root, const std::string& path, const json::Value& v) {
    json::Value* cur = &root;
    std::stringstream ss(path);
    std::string seg;
    while (std::getline(ss, seg, '.')) {
        const bool last = ss.peek() == EOF;
        const bool idx = !seg.empty() && std::isdigit(static_cast<unsigned char>(seg[0]));
        json::Value* next = idx ? &cur->arr_mut()[size_t(std::stoi(seg))] : &(*cur)[seg];
        if (last) *next = v; else cur = next;
    }
}

int main(int argc, char** argv) {
    if (argc < 3) return 2;
    const std::string dir = argv[2];
    const std::string example_text = slurp(argv[1]);
    const json::Value example = json::parse(example_text);
    {   // the canonical form of the example project
        const std::string d = example.dump();
        std::ofstream(dir + "/example_canonical.json", std::ios::binary) << d;
    }
    json::Array out;
    const json::Value cases = json::parse(slurp(dir + "/cases_in.json"));
    for (const json::Value& c : cases.arr()) {
        json::Value doc = json::parse(example_text);   // Value copies share their contents
        for (const json::Value& s : c["set"].arr()) set_path(doc, s[0].str(), expand(s[1]));
        std::string result = "OK";
        try { validate_project(parse_project(doc)); } catch (const std::exception& e) { result = std::string("ERR ") + e.what(); }
        out.push_back(json::Object{{"name", c["name"]}, {"result", result}});
    }
    std::ofstream(dir + "/cases.json") << json::Value(out).dump();
    json::Array rt;
    const json::Value texts = json::parse(slurp(dir + "/roundtrip_in.json"));
    for (const json::Value& t : texts.arr()) {
        std::string result;
        try { result = "OK " + json::parse(t.str()).dump(); } catch (const std::exception& e) { result = std::string("ERR ") + e.what(); }
        rt.push_back(json::Object{{"text", t}, {"result", result}});
    }
    std::ofstream(dir + "/roundtrip.json", std::ios::binary) << json::Value(rt).dump();
}
