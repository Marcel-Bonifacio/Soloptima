#include "finance.hpp"
#include <algorithm>
#include <cmath>

namespace {

double npv(const std::vector<double>& cf, double r) {   // cf[0] at t = 0, undiscounted
    double v = 0;
    for (size_t t = 0; t < cf.size(); ++t) v += cf[t] / std::pow(1 + r, double(t));
    return v;
}
bool irr(const std::vector<double>& cf, double& out) {
    double lo = -0.99, hi = 10.0, flo = npv(cf, lo), fhi = npv(cf, hi);
    if (!std::isfinite(flo) || !std::isfinite(fhi) || flo * fhi >= 0) return false;
    for (int i = 0; i < 200; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (mid == lo || mid == hi) break;
        const double fm = npv(cf, mid);
        if ((fm > 0) == (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    out = 0.5 * (lo + hi);
    return true;
}
double payback(const std::vector<double>& cf) {   // interpolated simple payback, -1 if never
    double cum = cf[0];
    if (cum >= 0) return 0;
    for (size_t t = 1; t < cf.size(); ++t) {
        const double prev = cum;
        cum += cf[t];
        if (cum >= 0) return (t - 1) + (-prev) / cf[t];
    }
    return -1;
}

// Depreciation schedule for one asset class. db: declining balance at 2/life, switching to straight line on the
// remaining value when that is larger (fully depreciated by the end of the life), as allowed for Indonesian groups.
std::vector<double> depreciation(double base, int life, const std::string& method, int T) {
    std::vector<double> d(T + 1, 0.0);
    if (base <= 0 || life <= 0) return d;
    const bool db = method == "db";
    double rem = base;
    for (int t = 1; t <= T && t <= life; ++t) {
        const double x = std::min(db ? std::max(rem * 2.0 / life, rem / (life - t + 1)) : base / life, rem);
        d[t] = x;
        rem -= x;
    }
    return d;
}

struct Out {
    std::vector<double> energy, billed, ace, tariff, revenue, opex, opex_sim, replace, fixed, insurance, ebitda, dep, interest,
        taxable, tax, wht, cfads, ds, principal, bal, dscr, dsra, dwc, eq_cf, proj_cf, net_income, host_base, host_cost, host_save;
    double tic = 0, hard = 0, debt = 0, idc = 0, fee = 0, vat = 0, terminal = 0;
    double eq_irr = NAN, proj_irr = NAN, eq_npv = 0, proj_npv = 0, eq_payback = -1, proj_payback = -1;
    double dscr_min = NAN, dscr_avg = NAN, llcr = NAN, lppa_nom = NAN, lppa_real = NAN, lcoe_nom = NAN, lcoe_real = NAN, pln_level = NAN;
    double host_npv = 0, host_pct = 0, debt_dscr_cap = 0;
};

Out compute(const Project& p, const FinanceParams& f, const SimResult& h, const SimResult& b, double scale) {
    Out o;
    const int T = std::max(1, std::min<int>(f.term > 0 ? f.term : p.econ.lifetime, int(h.years.size())));
    auto vec = [&]() { return std::vector<double>(T + 1, 0.0); };
    for (auto* v : {&o.energy, &o.billed, &o.ace, &o.tariff, &o.revenue, &o.opex, &o.opex_sim, &o.replace, &o.fixed, &o.insurance, &o.ebitda,
                    &o.dep, &o.interest, &o.taxable, &o.tax, &o.wht, &o.cfads, &o.ds, &o.principal, &o.bal, &o.dscr, &o.dsra, &o.dwc,
                    &o.eq_cf, &o.proj_cf, &o.net_income, &o.host_base, &o.host_cost, &o.host_save})
        *v = vec();
    const bool host = f.model == "host";
    const double r = f.interest;
    const auto& E = h.econ;

    // ---- capital cost build-up -------------------------------------------------------------------------------
    const double hard = E.capex_pv + E.capex_bess + E.capex_wind + E.capex_other;   // new assets only
    const double bess_share = hard > 0 ? E.capex_bess / hard : 0.0;
    const double cont = hard * f.contingency_pct;
    o.vat = (hard + cont) * f.vat_pct;
    o.hard = hard;
    const double pre_fin = hard + cont + f.land + f.dev_fixed + o.vat;   // before financing costs

    // ---- operating years: energy, revenue, opex ----------------------------------------------------------------
    const double E1 = h.years[0].served_site * h.years[0].re_fraction;   // auxiliary consumption is not billed
    for (int t = 1; t <= T; ++t) {
        const YearResult& Y = h.years[t - 1];
        const YearResult& B = b.years[t - 1];
        const double esc = std::pow(1 + p.econ.om_escalation, t - 1);
        o.energy[t] = Y.served_site * Y.re_fraction;                          // renewable kWh delivered to the site load
        o.ace[t] = f.ace_factor * E1 * std::pow(1 - p.pv.degradation, t - 1);
        o.host_base[t] = B.c_fuel + B.c_om_dg + B.c_carbon;                   // diesel-only running cost
        const double host_run = Y.c_fuel + Y.c_om_dg + Y.c_carbon;           // diesel cost that remains with the hybrid
        if (host) {
            o.revenue[t] = o.host_base[t] - host_run;                          // avoided diesel cost = the owner's "revenue"
            o.billed[t] = o.energy[t];
            o.tariff[t] = o.energy[t] > 0 ? o.revenue[t] / o.energy[t] : 0;
        } else {
            double tariff = 0;
            if (f.tariff_mode == "diesel_discount") {
                const double avoided_kwh = B.gen_kwh > 0 ? (B.c_fuel + B.c_om_dg) / B.gen_kwh : 0;
                tariff = (1 - f.diesel_discount) * avoided_kwh;
            } else {
                const bool st2 = f.stage2_year > 0 && t >= f.stage2_year;
                double fixed = 0;
                for (const auto& c : f.components)
                    if (c.pct <= 0) fixed += (st2 ? c.v2 : c.v1) * std::pow(1 + c.idx, t - 1);
                double adders = 0;
                for (const auto& c : f.components) if (c.pct > 0) adders += c.pct * fixed;
                tariff = fixed + adders;
            }
            tariff *= scale;
            const double curtailed = Y.pv_curtailed + Y.wind_curtailed;
            o.billed[t] = std::max(o.energy[t], f.take_or_pay * o.ace[t]) + f.deemed_share * curtailed;
            const double shortfall = std::max(0.0, f.penalty_threshold * o.ace[t] - o.energy[t]);
            o.tariff[t] = tariff;
            o.revenue[t] = tariff * o.billed[t] - f.penalty_rate * tariff * shortfall;
            o.host_cost[t] = tariff * o.billed[t] * (1 + f.tariff_vat) + host_run - f.penalty_rate * tariff * shortfall;
            o.host_save[t] = o.host_base[t] - o.host_cost[t];
        }
        o.opex_sim[t] = Y.c_om_new;
        o.replace[t] = Y.c_replace;
        o.fixed[t] = (f.fixed_opex + f.land_lease) * esc;
        o.insurance[t] = f.insurance_pct * hard * esc;
        o.opex[t] = o.opex_sim[t] + o.replace[t] + o.fixed[t] + o.insurance[t];
        o.ebitda[t] = o.revenue[t] - o.opex[t];
        o.wht[t] = host ? 0.0 : f.wht_pct * o.revenue[t];
    }
    // working capital (receivables on revenue, payables on opex), released in the last year
    {
        double prev = 0;
        for (int t = 1; t <= T; ++t) {
            const double wc = f.receivable_days / 365.0 * o.revenue[t] - f.payable_days / 365.0 * o.opex[t];
            o.dwc[t] = wc - prev;
            prev = wc;
        }
        o.dwc[T] -= prev;
    }
    // terminal value: linear remaining life of the new assets, or zero for a transfer at the end of the term
    if (f.terminal != "transfer") {
        const double life = std::max(1.0, p.econ.pv_life);
        o.terminal = hard * (1 - bess_share) * std::max(0.0, (life - T) / life);
        if (T == int(h.years.size())) o.terminal = std::max(o.terminal, -h.years[T - 1].c_salvage);
    }

    // ---- tax helper (loss carry-forward with expiry, holiday, Art. 31E, creditable withholding) -----------------
    auto tax_of = [&](const std::vector<double>& taxable, std::vector<double>& tax) {
        std::vector<std::pair<int, double>> losses;   // (year incurred, remaining loss)
        for (int t = 1; t <= T; ++t) {
            double ti = taxable[t];
            if (ti < 0) { if (f.loss_cf_years >= 0) losses.push_back({t, -ti}); tax[t] = 0; continue; }
            for (auto& L : losses) {
                if (f.loss_cf_years > 0 && t - L.first > f.loss_cf_years) continue;
                const double use = std::min(L.second, ti);
                L.second -= use; ti -= use;
            }
            double rate = (host && !f.host_taxable) || t <= f.tax_holiday_years ? 0.0 : f.tax_rate;
            if (f.sme_31e && o.revenue[t] > 0 && o.revenue[t] <= f.sme_high)
                rate *= 1.0 - 0.5 * std::min(1.0, f.sme_low / o.revenue[t]);
            tax[t] = std::max(0.0, rate * ti);
        }
    };

    // ---- depreciation bases ------------------------------------------------------------------------------------
    // financing costs are capitalised into the main asset class; land and recoverable VAT are not depreciable
    auto dep_for = [&](double idc_fee) {
        const double cap_vat = f.vat_recoverable ? 0.0 : o.vat;
        const double base_bess = (hard + cont + cap_vat) * bess_share;
        const double base_main = (hard + cont + cap_vat) * (1 - bess_share) + f.dev_fixed + idc_fee;
        auto d1 = depreciation(base_main, f.dep_life, f.dep_method, T);
        auto d2 = depreciation(base_bess, f.dep_life_bess, f.dep_method, T);
        for (int t = 0; t <= T; ++t) d1[t] += d2[t];
        return d1;
    };

    // ---- project (unlevered, after tax) -----------------------------------------------------------------------
    {
        auto dep = dep_for(0.0);
        std::vector<double> ti(T + 1, 0.0), tx(T + 1, 0.0);
        for (int t = 1; t <= T; ++t) ti[t] = o.ebitda[t] - dep[t];
        tax_of(ti, tx);
        o.proj_cf[0] = -pre_fin;
        for (int t = 1; t <= T; ++t) {
            o.proj_cf[t] = o.ebitda[t] - std::max(tx[t], o.wht[t]) - o.dwc[t] + (f.vat_recoverable && t == 1 ? o.vat : 0.0);
            if (t == T) o.proj_cf[t] += o.terminal;
        }
    }

    // ---- debt sizing and schedule (iterated: tax depends on interest, sculpting depends on CFADS) ---------------
    const int tenor = std::min(f.tenor, T), grace = std::min(f.grace, tenor - 1);
    const int n_rep = std::max(1, tenor - grace);
    std::vector<double> cfads_sz(T + 1, 0.0);
    for (int t = 1; t <= T; ++t) cfads_sz[t] = o.ebitda[t] - (1 - f.p90_factor) * o.revenue[t];   // first pass: pre-tax
    double D = 0;
    for (int it = 0; it < 8; ++it) {
        // capacity of the cash flow to carry debt at the target DSCR (sculpted annuity value)
        double pv_ds = 0;
        for (int k = 1; k <= n_rep && grace + k <= T; ++k) pv_ds += std::max(0.0, cfads_sz[grace + k]) / f.dscr_target / std::pow(1 + r, k);
        o.debt_dscr_cap = pv_ds;
        o.tic = pre_fin + o.idc + o.fee + o.dsra[0];
        const double d_gear = f.gearing * o.tic;
        D = f.sizing == "dscr" ? pv_ds : f.sizing == "min" ? std::min(d_gear, pv_ds) : d_gear;
        D = std::max(0.0, std::min(D, o.tic));
        o.idc = f.construction_years > 0 ? D * r * 0.5 * f.construction_years : 0.0;   // average drawn balance
        o.fee = f.upfront_fee * D;
        // schedule
        double bal = D;
        const double ann = r > 0 ? D * r / (1 - std::pow(1 + r, -n_rep)) : D / n_rep;
        for (int t = 1; t <= T; ++t) {
            o.bal[t] = bal;
            o.interest[t] = r * bal;
            double prin = 0;
            if (t > grace && t <= tenor && bal > 1e-9) {
                if (f.repayment == "equal") prin = D / n_rep;
                else if (f.repayment == "annuity") prin = ann - o.interest[t];
                else {
                    const double ds = pv_ds > 0 ? std::max(0.0, cfads_sz[t]) / f.dscr_target * (D / pv_ds) : 0.0;
                    prin = ds - o.interest[t];
                }
                prin = std::clamp(prin, 0.0, bal);
                if (t == tenor) prin = bal;
            }
            o.principal[t] = prin;
            o.ds[t] = o.interest[t] + prin;
            bal -= prin;
        }
        // DSRA (dsra[0] funded at COD): next year's debt service x months/12, released when the loan is repaid
        for (int t = 0; t < T; ++t) o.dsra[t] = f.dsra_months / 12.0 * o.ds[t + 1];
        // levered tax and CFADS
        o.dep = dep_for(o.idc + o.fee);
        for (int t = 1; t <= T; ++t) o.taxable[t] = o.ebitda[t] - o.dep[t] - o.interest[t];
        tax_of(o.taxable, o.tax);
        for (int t = 1; t <= T; ++t) {
            const double tax_cash = std::max(0.0, o.tax[t] - o.wht[t]);   // withholding is a creditable prepayment
            o.cfads[t] = o.ebitda[t] - o.wht[t] - tax_cash - o.dwc[t] + (f.vat_recoverable && t == 1 ? o.vat : 0.0);
            o.net_income[t] = o.ebitda[t] - o.dep[t] - o.interest[t] - o.tax[t];
            // sizing case: optionally haircut revenue to a P90 energy level
            cfads_sz[t] = o.cfads[t] - (1 - f.p90_factor) * o.revenue[t];
        }
    }
    o.debt = D;
    o.tic = pre_fin + o.idc + o.fee + o.dsra[0];

    // ---- equity cash flow and returns --------------------------------------------------------------------------
    o.eq_cf[0] = -(o.tic - D);
    double mn = 1e300, sm = 0;
    int nd = 0;
    for (int t = 1; t <= T; ++t) {
        o.eq_cf[t] = o.cfads[t] - o.ds[t] - (o.dsra[t] - o.dsra[t - 1]) + (t == T ? o.terminal : 0.0);
        if (o.ds[t] > 1e-6) { o.dscr[t] = o.cfads[t] / o.ds[t]; mn = std::min(mn, o.dscr[t]); sm += o.dscr[t]; ++nd; }
    }
    double v;
    if (irr(o.eq_cf, v)) o.eq_irr = v;
    if (irr(o.proj_cf, v)) o.proj_irr = v;
    o.eq_npv = npv(o.eq_cf, f.equity_discount);
    o.proj_npv = npv(o.proj_cf, p.econ.discount_rate);
    o.eq_payback = payback(o.eq_cf);
    o.proj_payback = payback(o.proj_cf);
    if (nd) { o.dscr_min = mn; o.dscr_avg = sm / nd; }
    if (D > 0) {
        double pv = 0;
        for (int t = 1; t <= tenor; ++t) pv += o.cfads[t] / std::pow(1 + r, t);
        o.llcr = pv / D;
    }
    // levelised values: costs and revenue at the nominal rate; energy at the nominal rate for the
    // nominal value and at the inflation-adjusted rate for the real value
    const double dn = p.econ.discount_rate, dr = (1 + dn) / (1 + f.inflation) - 1;
    auto lev = [&](const std::vector<double>& num, const std::vector<double>& den, double d_energy) {
        const double c = npv(den, d_energy);
        return c > 0 ? npv(num, dn) / c : NAN;
    };
    o.lppa_nom = lev(o.revenue, o.billed, dn);
    o.lppa_real = lev(o.revenue, o.billed, dr);
    std::vector<double> cost(T + 1, 0.0);
    cost[0] = pre_fin;
    for (int t = 1; t <= T; ++t) cost[t] = o.opex[t] - (t == T ? o.terminal : 0.0) - (f.vat_recoverable && t == 1 ? o.vat : 0.0);
    o.lcoe_nom = lev(cost, o.energy, dn);
    o.lcoe_real = lev(cost, o.energy, dr);
    {   // PLN-style levelised tariff: annuity of the tariff series (not energy weighted)
        const double pv = npv(o.tariff, dn);
        o.pln_level = dn > 0 ? pv * dn / (1 - std::pow(1 + dn, -T)) : pv / T;
    }
    if (!host) {
        o.host_npv = npv(o.host_save, dn);
        double sb = 0, ss = 0;
        for (int t = 1; t <= T; ++t) { sb += o.host_base[t]; ss += o.host_save[t]; }
        o.host_pct = sb > 0 ? ss / sb : 0;
    }
    return o;
}

json::Value num_or_null(double x) { return std::isfinite(x) ? json::Value(x) : json::Value(); }

} // namespace

FinanceParams parse_finance(const json::Value& v, const Project&) {
    FinanceParams f;
    f.model = v.gets("model", f.model);
    f.term = int(v.get("term", f.term));
    f.construction_years = std::clamp(int(v.get("construction_years", f.construction_years)), 0, 3);
    f.inflation = v.get("inflation", f.inflation);
    f.equity_discount = v.get("equity_discount", f.equity_discount);
    f.land = v.get("land", f.land);
    f.dev_fixed = v.get("dev_fixed", f.dev_fixed);
    f.contingency_pct = v.get("contingency_pct", f.contingency_pct);
    f.vat_pct = v.get("vat_pct", f.vat_pct);
    f.vat_recoverable = v.getb("vat_recoverable", f.vat_recoverable);
    f.tariff_mode = v.gets("tariff_mode", f.tariff_mode);
    for (const auto& c : v["components"].arr())
        f.components.push_back({c.get("v1", 0), c.get("v2", c.get("v1", 0)), c.get("idx", 0), c.get("pct", 0)});
    if (f.components.empty()) f.components.push_back({0.15, 0.15, 0.0, 0.0});
    f.stage2_year = int(v.get("stage2_year", f.stage2_year));
    f.diesel_discount = v.get("diesel_discount", f.diesel_discount);
    f.tariff_vat = v.get("tariff_vat", f.tariff_vat);
    f.take_or_pay = v.get("take_or_pay", f.take_or_pay);
    f.ace_factor = v.get("ace_factor", f.ace_factor);
    f.deemed_share = v.get("deemed_share", f.deemed_share);
    f.penalty_threshold = v.get("penalty_threshold", f.penalty_threshold);
    f.penalty_rate = v.get("penalty_rate", f.penalty_rate);
    f.solve = v.getb("solve", f.solve);
    f.solve_for = v.gets("solve_for", f.solve_for);
    f.target_irr = v.get("target_irr", f.target_irr);
    f.fixed_opex = v.get("fixed_opex", f.fixed_opex);
    f.insurance_pct = v.get("insurance_pct", f.insurance_pct);
    f.land_lease = v.get("land_lease", f.land_lease);
    f.tax_rate = v.get("tax_rate", f.tax_rate);
    f.wht_pct = v.get("wht_pct", f.wht_pct);
    f.loss_cf_years = int(v.get("loss_cf_years", f.loss_cf_years));
    f.tax_holiday_years = int(v.get("tax_holiday_years", f.tax_holiday_years));
    f.host_taxable = v.getb("host_taxable", f.host_taxable);
    f.sme_31e = v.getb("sme_31e", f.sme_31e);
    f.sme_low = v.get("sme_low", f.sme_low);
    f.sme_high = v.get("sme_high", f.sme_high);
    f.dep_method = v.gets("dep_method", f.dep_method);
    f.dep_life = std::max(1, int(v.get("dep_life", f.dep_life)));
    f.dep_life_bess = std::max(1, int(v.get("dep_life_bess", f.dep_life_bess)));
    f.gearing = std::clamp(v.get("gearing", f.gearing), 0.0, 0.95);
    f.dscr_target = std::max(1.0, v.get("dscr_target", f.dscr_target));
    f.interest = v.get("interest", f.interest);
    f.upfront_fee = v.get("upfront_fee", f.upfront_fee);
    f.tenor = std::clamp(int(v.get("tenor", f.tenor)), 1, 40);
    f.grace = std::clamp(int(v.get("grace", f.grace)), 0, f.tenor - 1);
    f.sizing = v.gets("sizing", f.sizing);
    f.repayment = v.gets("repayment", f.repayment);
    f.dsra_months = v.get("dsra_months", f.dsra_months);
    f.p90_factor = v.get("p90_factor", f.p90_factor);
    f.receivable_days = v.get("receivable_days", f.receivable_days);
    f.payable_days = v.get("payable_days", f.payable_days);
    f.terminal = v.gets("terminal", f.terminal);
    return f;
}

json::Value run_finance(const Project& p, const FinanceParams& f, const SimResult& h, const SimResult& b, double tariff_scale) {
    using json::Value;
    double scale = tariff_scale > 0 ? tariff_scale : 1.0;
    json::Value solved;
    if (f.solve && f.model != "host" && !(tariff_scale > 0)) {
        // bisection on a multiplier of the tariff so that the chosen IRR hits the target (IRR rises with the tariff)
        auto metric = [&](double s) {
            Out o = compute(p, f, h, b, s);
            const double x = f.solve_for == "project" ? o.proj_irr : o.eq_irr;
            return std::isfinite(x) ? x : -1.0;
        };
        double lo = 0.0, hi = 1.0, m_hi = metric(hi);
        while (m_hi < f.target_irr && hi < 64) m_hi = metric(hi *= 2);
        if (m_hi >= f.target_irr) {
            for (int i = 0; i < 60; ++i) { const double mid = 0.5 * (lo + hi); (metric(mid) < f.target_irr ? lo : hi) = mid; }
            scale = hi;
            solved = Value(json::Object{{"scale", scale}, {"ok", true}});
        } else solved = Value(json::Object{{"ok", false}, {"reason", "Target IRR not reached with up to 64 times the input tariff."}});
    }
    Out o = compute(p, f, h, b, scale);
    const int T = int(o.revenue.size()) - 1;
    Value years = Value::array();
    for (int t = 0; t <= T; ++t) {
        years.push(Value(json::Object{
            {"year", t}, {"energy", o.energy[t]}, {"billed", o.billed[t]}, {"ace", o.ace[t]}, {"tariff", o.tariff[t]}, {"revenue", o.revenue[t]},
            {"opex_om", o.opex_sim[t]}, {"replacements", o.replace[t]}, {"fixed_opex", o.fixed[t]}, {"insurance", o.insurance[t]}, {"opex", o.opex[t]},
            {"ebitda", o.ebitda[t]}, {"depreciation", o.dep[t]}, {"interest", o.interest[t]}, {"taxable", o.taxable[t]}, {"tax", o.tax[t]},
            {"wht", o.wht[t]}, {"net_income", o.net_income[t]}, {"cfads", o.cfads[t]}, {"principal", o.principal[t]}, {"debt_service", o.ds[t]},
            {"debt_balance", o.bal[t]}, {"dscr", o.ds[t] > 1e-6 ? Value(o.dscr[t]) : Value()}, {"dsra", o.dsra[t]},
            {"d_wc", o.dwc[t]}, {"equity_cf", o.eq_cf[t]}, {"project_cf", o.proj_cf[t]},
            {"host_baseline", o.host_base[t]}, {"host_cost", o.host_cost[t]}, {"host_saving", o.host_save[t]}}));
    }
    auto cum = [&](const std::vector<double>& cf) { Value a = Value::array(); double c = 0; for (double x : cf) { c += x; a.push(c); } return a; };
    return Value(json::Object{
        {"model", f.model}, {"years", years}, {"equity_cum", cum(o.eq_cf)}, {"project_cum", cum(o.proj_cf)},
        {"metrics", Value(json::Object{
            {"tariff_y1", o.tariff[1]}, {"tariff_scale", scale}, {"lppa_nominal", num_or_null(o.lppa_nom)}, {"lppa_real", num_or_null(o.lppa_real)},
            {"lcoe_nominal", num_or_null(o.lcoe_nom)}, {"lcoe_real", num_or_null(o.lcoe_real)}, {"pln_levelised_tariff", num_or_null(o.pln_level)},
            {"equity_irr", num_or_null(o.eq_irr)}, {"project_irr", num_or_null(o.proj_irr)}, {"equity_npv", o.eq_npv}, {"project_npv", o.proj_npv},
            {"equity_payback", o.eq_payback >= 0 ? Value(o.eq_payback) : Value()}, {"project_payback", o.proj_payback >= 0 ? Value(o.proj_payback) : Value()},
            {"dscr_min", num_or_null(o.dscr_min)}, {"dscr_avg", num_or_null(o.dscr_avg)}, {"llcr", num_or_null(o.llcr)},
            {"debt", o.debt}, {"debt_fraction", o.tic > 0 ? o.debt / o.tic : 0.0}, {"debt_dscr_capacity", o.debt_dscr_cap},
            {"equity", o.tic - o.debt}, {"total_installed_cost", o.tic}, {"hard_capex", o.hard}, {"idc", o.idc}, {"financing_fee", o.fee},
            {"dsra_initial", o.dsra[0]}, {"vat_capex", o.vat}, {"terminal_value", o.terminal},
            {"host_npv_savings", o.host_npv}, {"host_saving_pct", o.host_pct}, {"term", T}})},
        {"solved", solved}});
}
