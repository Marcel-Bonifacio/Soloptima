// Writes engine/tests/fixtures/finance.json from the C++ engine: run_finance on a synthetic simulation (years built by a
// formula, shared with engine/tests/finance.rs) for many finance blocks, as the hash of the answer and its metrics.
//   c++ -std=c++17 -O1 -ffp-contract=off -Isrc -DSOLOPTIMA_VERSION=\"x\" -o /tmp/genf tests/gen_finance_fixtures.cpp \
//       $(ls src/*.cpp | grep -v 'main.cpp') -lcurl -framework Security -framework CoreFoundation
//   /tmp/genf engine/tests/fixtures/finance.json [answer.json "case name"]
#include "finance.hpp"
#include "json.hpp"
#include "sim.hpp"
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>

static std::string hash(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    char b[24];
    std::snprintf(b, sizeof b, "%016llx", (unsigned long long)h);
    return b;
}
// n years: hybrid (diesel use falls) and the diesel-only baseline
static void build(SimResult& h, SimResult& b, int n) {
    h.years.assign(size_t(n), YearResult{});
    b.years.assign(size_t(n), YearResult{});
    for (int i = 1; i <= n; ++i) {
        const double g = std::pow(1.02, double(i));
        YearResult& y = h.years[size_t(i - 1)];
        YearResult& z = b.years[size_t(i - 1)];
        y.year = z.year = i;
        y.served_site = 900000 * (1 - 0.004 * (i - 1));
        y.re_fraction = 0.55 - 0.002 * i;
        y.pv_curtailed = 20000 + 300 * i;
        y.wind_curtailed = 1000.0 * (i % 3);
        y.gen_kwh = 400000 + 2000 * i;
        z.gen_kwh = 900000 * (1 - 0.004 * (i - 1));
        y.c_fuel = 380000 * g;
        y.c_om_dg = 40000 * g;
        y.c_carbon = 3000.0 * i;
        y.c_om_new = 70000 * g;
        y.c_replace = i == 12 ? 250000.0 : i == 8 ? 90000.0 : 0.0;
        y.c_salvage = i == n ? -150000.0 : 0.0;
        z.c_fuel = 900000 * g;
        z.c_om_dg = 60000 * g;
        z.c_carbon = 5000.0 * i;
    }
    h.econ.capex_pv = 900000;
    h.econ.capex_bess = 600000;
    h.econ.capex_wind = 150000;
    h.econ.capex_other = 50000;
}
struct Case { std::string name, json; int years = 25; int lifetime = 25; double scale = 0; };

int main(int argc, char** argv) {
    std::vector<Case> cs{
        {"host", R"({"model":"host"})"},
        {"host no debt", R"({"model":"host","gearing":0})"},
        {"ppa sculpted", R"({"model":"ppa","components":[{"name":"E","v1":0.2}],"sizing":"dscr","repayment":"sculpted","dscr_target":1.35,"tenor":10,"interest":0.08,"construction_years":1})"},
        {"ppa solve equity", R"({"model":"ppa","components":[{"name":"E","v1":0.1}],"solve":true,"target_irr":0.13,"gearing":0.6,"sizing":"gearing","repayment":"annuity"})"},
        {"ppa solve project", R"({"model":"ppa","components":[{"v1":0.1}],"solve":true,"solve_for":"project","target_irr":0.09})"},
        {"ppa solve unreachable", R"({"model":"ppa","components":[{"v1":0.001}],"solve":true,"target_irr":0.9})"},
        {"ppa solve with scale", R"({"model":"ppa","components":[{"v1":0.1}],"solve":true,"target_irr":0.13})", 25, 25, 1.37},
        {"ppa loss cf 0 db", R"({"model":"ppa","components":[{"v1":0.2}],"loss_cf_years":0,"dep_method":"db","dep_life":4,"gearing":0.8})"},
        {"ppa loss cf -1 db", R"({"model":"ppa","components":[{"v1":0.2}],"loss_cf_years":-1,"dep_method":"db","dep_life":4,"gearing":0.8})"},
        {"ppa loss cf 2 db", R"({"model":"ppa","components":[{"v1":0.12}],"loss_cf_years":2,"dep_method":"db","dep_life":6,"gearing":0.8})"},
        {"ppa two stages indexed adder", R"({"model":"ppa","components":[{"v1":0.10,"v2":0.12,"idx":0.01},{"v1":0.03,"idx":0.02},{"pct":0.3}],"stage2_year":8})"},
        {"ppa diesel discount", R"({"model":"ppa","tariff_mode":"diesel_discount","diesel_discount":0.15})"},
        {"tpo", R"({"model":"tpo","components":[{"v1":0.22}],"tariff_vat":0.11})"},
        {"ppa top deemed penalty", R"({"model":"ppa","components":[{"v1":0.2}],"take_or_pay":0.97,"ace_factor":1.05,"deemed_share":0.5,"penalty_threshold":0.9,"penalty_rate":0.5})"},
        {"ppa sme 31e", R"({"model":"ppa","components":[{"v1":0.2}],"sme_31e":true,"sme_low":300000,"sme_high":50000000})"},
        {"ppa tax holiday wht", R"({"model":"ppa","components":[{"v1":0.2}],"tax_holiday_years":3,"wht_pct":0.02})"},
        {"host not taxable", R"({"model":"host","host_taxable":false})"},
        {"sizing dscr", R"({"model":"ppa","components":[{"v1":0.2}],"sizing":"dscr","dscr_target":1.5})"},
        {"sizing min", R"({"model":"ppa","components":[{"v1":0.2}],"sizing":"min","gearing":0.9})"},
        {"repayment equal grace", R"({"model":"ppa","components":[{"v1":0.2}],"repayment":"equal","grace":2,"tenor":12})"},
        {"repayment annuity zero rate", R"({"model":"ppa","components":[{"v1":0.2}],"repayment":"annuity","interest":0})"},
        {"construction 0", R"({"model":"ppa","components":[{"v1":0.2}],"construction_years":0})"},
        {"construction 3", R"({"model":"ppa","components":[{"v1":0.2}],"construction_years":9})"},
        {"vat recoverable", R"({"model":"host","vat_pct":0.11,"vat_recoverable":true,"contingency_pct":0.05,"land":40000,"dev_fixed":60000})"},
        {"vat not recoverable", R"({"model":"host","vat_pct":0.11,"contingency_pct":0.05})"},
        {"working capital", R"({"model":"ppa","components":[{"v1":0.2}],"receivable_days":45,"payable_days":30})"},
        {"terminal transfer", R"({"model":"ppa","components":[{"v1":0.2}],"terminal":"transfer"})"},
        {"p90 factor", R"({"model":"ppa","components":[{"v1":0.2}],"p90_factor":0.9,"sizing":"dscr"})"},
        {"term 10", R"({"model":"ppa","components":[{"v1":0.2}],"term":10,"tenor":15})"},
        {"term over years", R"({"model":"host","term":40})", 20, 25},
        {"lifetime 15", R"({"model":"host"})", 25, 15},
        {"fixed costs and lease", R"({"model":"ppa","components":[{"v1":0.2}],"fixed_opex":20000,"land_lease":10000,"insurance_pct":0.01})"},
        {"no energy tariff zero", R"({"model":"ppa","components":[{"v1":0}]})"},
        {"defaults ppa", R"({"model":"ppa"})"},
        {"parse limits", R"({"model":"ppa","gearing":2,"tenor":99,"grace":50,"dscr_target":0.5,"dep_life":0,"dep_life_bess":-3,"construction_years":-1})"},
        {"inflation and discount", R"({"model":"ppa","components":[{"v1":0.2}],"inflation":0.06,"equity_discount":0.15})"},
        {"interest high", R"({"model":"ppa","components":[{"v1":0.05}],"interest":0.2,"gearing":0.8})"},
    };
    json::Array out;
    for (const Case& c : cs) {
        Project p;
        p.econ.lifetime = c.lifetime;
        SimResult h, b;
        build(h, b, c.years);
        json::Object o{{"name", c.name}};
        try {
            const json::Value r = run_finance(p, parse_finance(json::parse(c.json), p), h, b, c.scale);
            o["hash"] = hash(r.dump());
            if (argc > 3 && c.name == argv[3]) std::ofstream(argv[2], std::ios::binary) << r.dump();   // a whole answer, to find a difference
            o["metrics"] = r["metrics"].dump();
            o["solved"] = r["solved"].dump();
        } catch (const std::exception& e) { o["error"] = e.what(); }
        out.push_back(json::Value(o));
    }
    // cash-flow measures
    json::Array cf;
    const std::vector<std::vector<double>> series{{-100, 30, 40, 50, 60}, {-100, 10, 10, 10}, {50, 10}, {-100, 200}, {-100, -10, -5}, {0, 0}, {-1e6, 3e5, 3e5, 3e5, 3e5, 3e5}, {100, -50, -50, -50, 400}};
    for (const auto& s : series) {
        double v = 0;
        const bool ok = irr(s, v);
        cf.push_back(json::Object{{"npv0", npv(s, 0.0)}, {"npv8", npv(s, 0.08)}, {"npv_neg", npv(s, -0.5)}, {"irr", ok ? json::Value(v) : json::Value()}, {"payback", payback(s)}});
    }
    out.push_back(json::Object{{"name", "cashflow"}, {"series", json::Value(cf)}});
    std::ofstream(argv[1], std::ios::binary) << json::Value(out).dump();
    std::cout << out.size() << " cases\n";
}
