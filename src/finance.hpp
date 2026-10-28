// Project-finance module: annual after-tax cash flow
// built on the simulated yearly energy and cost flows of the hybrid (and of the diesel-only baseline).
//
// Financial structures:
//   host  - host-owned: the plant owner invests and earns the avoided diesel cost
//   ppa   - single owner / IPP: an investor sells renewable kWh under a PPA
//   tpo   - third-party ownership: developer cash flow under a PPA / lease plus the
//           host's savings versus running diesel only
//
// Mechanics: construction period (0-3 years) with interest during construction, soft costs, debt sized by gearing and/or
// DSCR sculpting, equal-principal / annuity / sculpted repayment, DSRA, depreciation by asset class
// (straight line or declining balance with switch), loss carry-forward, tax holiday, creditable withholding
// tax, Indonesian Art. 31E reduced rate (optional), working capital, take-or-pay / deemed energy / shortfall
// penalty, staged multi-component tariffs (PLN A/B/E/F style) with indexation, tariff solving for a target IRR.
#pragma once
#include "json.hpp"
#include "model.hpp"
#include "sim.hpp"
#include <string>
#include <vector>

struct TariffComponent {
    double v1 = 0, v2 = 0;     // per kWh in stage 1 and stage 2
    double idx = 0;            // annual indexation
    double pct = 0;            // > 0: adder = pct x (sum of the fixed components), e.g. E = 30 % (A + B)
};

struct FinanceParams {
    std::string model = "host";            // host | ppa | tpo
    int term = 0;                          // operating years analysed (0 = project lifetime)
    int construction_years = 1;            // 0-3; IDC on the average drawn balance
    double inflation = 0.03;               // for real-terms LCOE / LPPA
    double equity_discount = 0.12;
    // capital cost build-up (hard capex comes from the simulation)
    double land = 0, dev_fixed = 0, contingency_pct = 0.0, vat_pct = 0.0;
    bool vat_recoverable = false;
    // tariff (ppa / tpo)
    std::string tariff_mode = "components";  // components | diesel_discount
    std::vector<TariffComponent> components;
    int stage2_year = 0;                     // first year of stage 2 (0 = no stage 2)
    double diesel_discount = 0.2;            // tariff = (1 - d) x avoided diesel cost per kWh
    double tariff_vat = 0.0;                 // VAT the host pays on top of the tariff
    double take_or_pay = 0.0;                // billed >= ToP x contracted energy
    double ace_factor = 1.0;                 // contracted energy = factor x year-1 delivered x degradation
    double deemed_share = 0.0;               // share of curtailed RE paid as deemed energy
    double penalty_threshold = 0.0, penalty_rate = 0.0;   // shortfall below threshold x ACE pays rate x tariff
    bool solve = false;                      // solve the tariff scale for a target IRR
    std::string solve_for = "equity";        // equity | project
    double target_irr = 0.12;
    // operating costs on top of the simulated O&M
    double fixed_opex = 0, insurance_pct = 0.005, land_lease = 0;
    // tax
    double tax_rate = 0.22, wht_pct = 0.0;
    int loss_cf_years = 5, tax_holiday_years = 0;   // loss carry-forward: years (0 = unlimited, -1 = none)
    bool host_taxable = true;
    bool sme_31e = false;                    // Indonesian Art. 31E: 50 % rate on turnover share up to the threshold
    double sme_low = 4.8e9, sme_high = 50e9; // turnover thresholds in model currency
    std::string dep_method = "sl";           // sl | db (declining balance, switch to SL)
    int dep_life = 20, dep_life_bess = 8;
    // debt
    double gearing = 0.7, dscr_target = 1.3, interest = 0.074, upfront_fee = 0.02;
    int tenor = 10, grace = 0;
    std::string sizing = "gearing";          // gearing | dscr | min
    std::string repayment = "sculpted";      // sculpted | annuity | equal
    double dsra_months = 6, p90_factor = 1.0;
    // working capital and end of term
    double receivable_days = 0, payable_days = 0;
    std::string terminal = "salvage";        // salvage | transfer
};

FinanceParams parse_finance(const json::Value& v, const Project& p);

// hybrid: simulation of the configured system; base: diesel-only simulation (same fleet, same rules).
// tariff_scale > 0: use this multiplier of the input tariff instead of solving it (f.solve), e.g. the scale solved for the
// P50 case when the same contract is evaluated in other weather years.
json::Value run_finance(const Project& p, const FinanceParams& f, const SimResult& hybrid, const SimResult& base, double tariff_scale = 0);
