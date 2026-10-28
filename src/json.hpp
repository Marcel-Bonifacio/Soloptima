// Minimal JSON value / parser / writer (no external dependencies).
#pragma once
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace json {

class Value;
using Array = std::vector<Value>;
using Object = std::map<std::string, Value>;

class Value {
public:
    enum Type { Null, Bool, Number, String, Arr, Obj };

    Value() : t_(Null) {}
    Value(std::nullptr_t) : t_(Null) {}
    Value(bool b) : t_(Bool), b_(b) {}
    Value(int n) : t_(Number), n_(n) {}
    Value(long n) : t_(Number), n_(double(n)) {}
    Value(long long n) : t_(Number), n_(double(n)) {}
    Value(size_t n) : t_(Number), n_(double(n)) {}
    Value(double n) : t_(Number), n_(n) {}
    Value(const char* s) : t_(String), s_(s) {}
    Value(std::string s) : t_(String), s_(std::move(s)) {}
    Value(Array a) : t_(Arr), a_(std::make_shared<Array>(std::move(a))) {}
    Value(Object o) : t_(Obj), o_(std::make_shared<Object>(std::move(o))) {}
    Value(const std::vector<double>& v) : t_(Arr), a_(std::make_shared<Array>()) {
        a_->reserve(v.size());
        for (double d : v) a_->emplace_back(d);
    }

    static Value object() { return Value(Object{}); }
    static Value array() { return Value(Array{}); }

    bool is_null() const { return t_ == Null; }
    bool is_string() const { return t_ == String; }
    bool is_array() const { return t_ == Arr; }
    bool is_object() const { return t_ == Obj; }

    double num(double def = 0.0) const {
        if (t_ == Number) return n_;
        if (t_ == Bool) return b_ ? 1.0 : 0.0;
        if (t_ == String) { char* e; double d = std::strtod(s_.c_str(), &e); return e != s_.c_str() ? d : def; }
        return def;
    }
    bool boolean(bool def = false) const {
        if (t_ == Bool) return b_;
        if (t_ == Number) return n_ != 0.0;
        return def;
    }
    const std::string& str() const { static const std::string empty; return t_ == String ? s_ : empty; }
    const Array& arr() const { static const Array empty; return t_ == Arr ? *a_ : empty; }
    const Object& obj() const { static const Object empty; return t_ == Obj ? *o_ : empty; }
    Array& arr_mut() { if (t_ != Arr) { t_ = Arr; a_ = std::make_shared<Array>(); } return *a_; }
    Object& obj_mut() { if (t_ != Obj) { t_ = Obj; o_ = std::make_shared<Object>(); } return *o_; }

    bool has(const std::string& k) const { return t_ == Obj && o_->count(k) > 0; }
    const Value& operator[](const std::string& k) const {
        static const Value null;
        if (t_ != Obj) return null;
        auto it = o_->find(k);
        return it == o_->end() ? null : it->second;
    }
    Value& operator[](const std::string& k) { return obj_mut()[k]; }
    const Value& operator[](size_t i) const { static const Value null; return (t_ == Arr && i < a_->size()) ? (*a_)[i] : null; }
    size_t size() const { return t_ == Arr ? a_->size() : (t_ == Obj ? o_->size() : 0); }
    void push(Value v) { arr_mut().push_back(std::move(v)); }

    // Convenience accessors with defaults
    double get(const std::string& k, double def) const { return (*this)[k].num(def); }
    bool getb(const std::string& k, bool def) const { return (*this)[k].boolean(def); }
    std::string gets(const std::string& k, const std::string& def) const { const Value& v = (*this)[k]; return v.is_string() ? v.s_ : def; }
    std::vector<double> getv(const std::string& k) const {
        const Array& a = (*this)[k].arr();
        std::vector<double> out;
        out.reserve(a.size());
        for (const auto& x : a) out.push_back(x.num(0.0));
        return out;
    }

    std::string dump() const { std::string out; out.reserve(1024); write(out); return out; }

    void write(std::string& out) const {
        switch (t_) {
        case Null: out += "null"; break;
        case Bool: out += b_ ? "true" : "false"; break;
        case Number: write_number(out, n_); break;
        case String: write_string(out, s_); break;
        case Arr:
            out += '[';
            for (size_t i = 0; i < a_->size(); ++i) { if (i) out += ','; (*a_)[i].write(out); }
            out += ']';
            break;
        case Obj: {
            out += '{';
            bool first = true;
            for (const auto& kv : *o_) {
                if (!first) out += ',';
                first = false;
                write_string(out, kv.first);
                out += ':';
                kv.second.write(out);
            }
            out += '}';
            break;
        }
        }
    }

    static void write_number(std::string& out, double d) {
        if (!std::isfinite(d)) { out += "null"; return; }
        char buf[32];
        if (d == std::floor(d) && std::fabs(d) < 1e15 && !(d == 0 && std::signbit(d)))   // -0 is left to %g
            out.append(buf, std::to_chars(buf, buf + sizeof buf, (long long)d).ptr);
        else {   // 15 digits when they read back exactly, else 17, so saved projects keep every value
            int n = std::snprintf(buf, sizeof buf, "%.15g", d);
            if (std::strtod(buf, nullptr) != d) n = std::snprintf(buf, sizeof buf, "%.17g", d);
            out.append(buf, size_t(n));
        }
    }
    static void write_string(std::string& out, const std::string& s) {
        out += '"';
        for (unsigned char c : s) {
            switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
                else out += char(c);
            }
        }
        out += '"';
    }

private:
    Type t_;
    bool b_ = false;
    double n_ = 0.0;
    std::string s_;
    std::shared_ptr<Array> a_;
    std::shared_ptr<Object> o_;
};

class Parser {
public:
    explicit Parser(const std::string& s) : s_(s), p_(0) {}
    Value parse() {
        ws();
        Value v = value(0);
        ws();
        if (p_ != s_.size()) fail("trailing characters");
        return v;
    }

private:
    const std::string& s_;
    size_t p_;

    [[noreturn]] void fail(const char* msg) { throw std::runtime_error(std::string("JSON parse error: ") + msg + " at offset " + std::to_string(p_)); }
    void ws() { while (p_ < s_.size() && (s_[p_] == ' ' || s_[p_] == '\n' || s_[p_] == '\r' || s_[p_] == '\t')) ++p_; }
    char peek() { return p_ < s_.size() ? s_[p_] : '\0'; }
    bool lit(const char* w) {
        size_t n = std::char_traits<char>::length(w);
        if (s_.compare(p_, n, w) == 0) { p_ += n; return true; }
        return false;
    }

    Value value(int depth) {
        if (depth > 200) fail("nesting too deep");
        char c = peek();
        if (c == '{') return object(depth);
        if (c == '[') return array(depth);
        if (c == '"') return Value(string());
        if (lit("true")) return Value(true);
        if (lit("false")) return Value(false);
        if (lit("null")) return Value();
        return number();
    }
    Value object(int depth) {
        ++p_;
        Object o;
        ws();
        if (peek() == '}') { ++p_; return Value(std::move(o)); }
        for (;;) {
            ws();
            if (peek() != '"') fail("expected key");
            std::string k = string();
            ws();
            if (peek() != ':') fail("expected ':'");
            ++p_;
            ws();
            o[k] = value(depth + 1);
            ws();
            if (peek() == ',') { ++p_; continue; }
            if (peek() == '}') { ++p_; break; }
            fail("expected ',' or '}'");
        }
        return Value(std::move(o));
    }
    Value array(int depth) {
        ++p_;
        Array a;
        ws();
        if (peek() == ']') { ++p_; return Value(std::move(a)); }
        for (;;) {
            ws();
            a.push_back(value(depth + 1));
            ws();
            if (peek() == ',') { ++p_; continue; }
            if (peek() == ']') { ++p_; break; }
            fail("expected ',' or ']'");
        }
        return Value(std::move(a));
    }
    static void utf8(std::string& out, unsigned cp) {
        if (cp < 0x80) out += char(cp);
        else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
        else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    }
    unsigned hex4() {
        if (p_ + 4 > s_.size()) fail("bad \\u escape");
        unsigned v = 0;
        for (int i = 0; i < 4; ++i) {
            char c = s_[p_++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= c - '0';
            else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
            else fail("bad hex digit");
        }
        return v;
    }
    std::string string() {
        ++p_;
        std::string out;
        while (p_ < s_.size()) {
            char c = s_[p_++];
            if (c == '"') return out;
            if (c != '\\') { out += c; continue; }
            if (p_ >= s_.size()) break;
            char e = s_[p_++];
            switch (e) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
                unsigned cp = hex4();
                if (cp >= 0xD800 && cp <= 0xDBFF && p_ + 6 <= s_.size() && s_[p_] == '\\' && s_[p_ + 1] == 'u') {
                    p_ += 2;
                    unsigned lo = hex4();
                    if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    else p_ -= 6;
                }
                utf8(out, cp);
                break;
            }
            default: fail("bad escape");
            }
        }
        fail("unterminated string");
    }
    Value number() {
        const char* start = s_.c_str() + p_;
        char* end;
        double d = std::strtod(start, &end);
        if (end == start) fail("unexpected character");
        p_ += size_t(end - start);
        return Value(d);
    }
};

inline Value parse(const std::string& s) { return Parser(s).parse(); }

} // namespace json
