//! The finance inputs and their parsing (`FinanceParams`, `parse_finance` of src/finance.cpp).
use crate::json::Value;

#[derive(Debug, Clone, Default)]
pub struct TariffComponent {
    /// per kWh in stage 1 and stage 2
    pub v1: f64,
    pub v2: f64,
    /// annual indexation
    pub idx: f64,
    /// > 0: adder = pct x (sum of the fixed components), e.g. E = 30 % (A + B)
    pub pct: f64,
}

#[derive(Debug, Clone)]
pub struct FinanceParams {
    /// host | ppa | tpo
    pub model: String,
    /// operating years analysed (0 = project lifetime)
    pub term: i32,
    /// 0-3; IDC on the average drawn balance
    pub construction_years: i32,
    /// for real-terms LCOE / LPPA
    pub inflation: f64,
    pub equity_discount: f64,
    pub land: f64,
    pub dev_fixed: f64,
    pub contingency_pct: f64,
    pub vat_pct: f64,
    pub vat_recoverable: bool,
    /// components | diesel_discount
    pub tariff_mode: String,
    pub components: Vec<TariffComponent>,
    /// first year of stage 2 (0 = no stage 2)
    pub stage2_year: i32,
    /// tariff = (1 - d) x avoided diesel cost per kWh
    pub diesel_discount: f64,
    pub tariff_vat: f64,
    /// billed >= ToP x contracted energy
    pub take_or_pay: f64,
    /// contracted energy = factor x year-1 delivered x degradation
    pub ace_factor: f64,
    /// share of curtailed RE paid as deemed energy
    pub deemed_share: f64,
    /// shortfall below threshold x ACE pays rate x tariff
    pub penalty_threshold: f64,
    pub penalty_rate: f64,
    /// solve the tariff scale for a target IRR
    pub solve: bool,
    /// equity | project
    pub solve_for: String,
    pub target_irr: f64,
    pub fixed_opex: f64,
    pub insurance_pct: f64,
    pub land_lease: f64,
    pub tax_rate: f64,
    pub wht_pct: f64,
    /// loss carry-forward: years (0 = unlimited, -1 = none)
    pub loss_cf_years: i32,
    pub tax_holiday_years: i32,
    pub host_taxable: bool,
    /// Indonesian Art. 31E: 50 % rate on turnover share up to the threshold
    pub sme_31e: bool,
    pub sme_low: f64,
    pub sme_high: f64,
    /// sl | db (declining balance, switch to SL)
    pub dep_method: String,
    pub dep_life: i32,
    pub dep_life_bess: i32,
    pub gearing: f64,
    pub dscr_target: f64,
    pub interest: f64,
    pub upfront_fee: f64,
    pub tenor: i32,
    pub grace: i32,
    /// gearing | dscr | min
    pub sizing: String,
    /// sculpted | annuity | equal
    pub repayment: String,
    pub dsra_months: f64,
    pub p90_factor: f64,
    pub receivable_days: f64,
    pub payable_days: f64,
    /// salvage | transfer
    pub terminal: String,
}

impl Default for FinanceParams {
    fn default() -> Self {
        let s = |x: &str| x.to_string();
        FinanceParams {
            model: s("host"), term: 0, construction_years: 1, inflation: 0.03, equity_discount: 0.12, land: 0.0, dev_fixed: 0.0, contingency_pct: 0.0,
            vat_pct: 0.0, vat_recoverable: false, tariff_mode: s("components"), components: vec![], stage2_year: 0, diesel_discount: 0.2, tariff_vat: 0.0,
            take_or_pay: 0.0, ace_factor: 1.0, deemed_share: 0.0, penalty_threshold: 0.0, penalty_rate: 0.0, solve: false, solve_for: s("equity"),
            target_irr: 0.12, fixed_opex: 0.0, insurance_pct: 0.005, land_lease: 0.0, tax_rate: 0.22, wht_pct: 0.0, loss_cf_years: 5, tax_holiday_years: 0,
            host_taxable: true, sme_31e: false, sme_low: 4.8e9, sme_high: 50e9, dep_method: s("sl"), dep_life: 20, dep_life_bess: 8, gearing: 0.7,
            dscr_target: 1.3, interest: 0.074, upfront_fee: 0.02, tenor: 10, grace: 0, sizing: s("gearing"), repayment: s("sculpted"), dsra_months: 6.0,
            p90_factor: 1.0, receivable_days: 0.0, payable_days: 0.0, terminal: s("salvage"),
        }
    }
}

pub(crate) fn clamp(v: f64, lo: f64, hi: f64) -> f64 { if v < lo { lo } else if hi < v { hi } else { v } }
fn clamp_i(v: i32, lo: i32, hi: i32) -> i32 { if v < lo { lo } else if hi < v { hi } else { v } }

/// The "finance" block of a project document
pub fn parse_finance(v: &Value) -> FinanceParams {
    let mut f = FinanceParams::default();
    macro_rules! num { ($k:literal, $d:expr) => { $d = v.get($k, $d); }; }
    macro_rules! int { ($k:literal, $d:expr) => { $d = v.get($k, f64::from($d)) as i32; }; }
    macro_rules! flag { ($k:literal, $d:expr) => { $d = v.getb($k, $d); }; }
    macro_rules! text { ($k:literal, $d:expr) => { $d = v.gets($k, &$d); }; }
    text!("model", f.model);
    int!("term", f.term);
    f.construction_years = clamp_i(v.get("construction_years", f64::from(f.construction_years)) as i32, 0, 3);
    num!("inflation", f.inflation);
    num!("equity_discount", f.equity_discount);
    num!("land", f.land);
    num!("dev_fixed", f.dev_fixed);
    num!("contingency_pct", f.contingency_pct);
    num!("vat_pct", f.vat_pct);
    flag!("vat_recoverable", f.vat_recoverable);
    text!("tariff_mode", f.tariff_mode);
    for c in v.at("components").arr() {
        f.components.push(TariffComponent { v1: c.get("v1", 0.0), v2: c.get("v2", c.get("v1", 0.0)), idx: c.get("idx", 0.0), pct: c.get("pct", 0.0) });
    }
    if f.components.is_empty() { f.components.push(TariffComponent { v1: 0.15, v2: 0.15, idx: 0.0, pct: 0.0 }); }
    int!("stage2_year", f.stage2_year);
    num!("diesel_discount", f.diesel_discount);
    num!("tariff_vat", f.tariff_vat);
    num!("take_or_pay", f.take_or_pay);
    num!("ace_factor", f.ace_factor);
    num!("deemed_share", f.deemed_share);
    num!("penalty_threshold", f.penalty_threshold);
    num!("penalty_rate", f.penalty_rate);
    flag!("solve", f.solve);
    text!("solve_for", f.solve_for);
    num!("target_irr", f.target_irr);
    num!("fixed_opex", f.fixed_opex);
    num!("insurance_pct", f.insurance_pct);
    num!("land_lease", f.land_lease);
    num!("tax_rate", f.tax_rate);
    num!("wht_pct", f.wht_pct);
    int!("loss_cf_years", f.loss_cf_years);
    int!("tax_holiday_years", f.tax_holiday_years);
    flag!("host_taxable", f.host_taxable);
    flag!("sme_31e", f.sme_31e);
    num!("sme_low", f.sme_low);
    num!("sme_high", f.sme_high);
    text!("dep_method", f.dep_method);
    f.dep_life = (v.get("dep_life", f64::from(f.dep_life)) as i32).max(1);
    f.dep_life_bess = (v.get("dep_life_bess", f64::from(f.dep_life_bess)) as i32).max(1);
    f.gearing = clamp(v.get("gearing", f.gearing), 0.0, 0.95);
    f.dscr_target = { let x = v.get("dscr_target", f.dscr_target); if 1.0 < x { x } else { 1.0 } };   // std::max(1.0, x)
    num!("interest", f.interest);
    num!("upfront_fee", f.upfront_fee);
    f.tenor = clamp_i(v.get("tenor", f64::from(f.tenor)) as i32, 1, 40);
    f.grace = clamp_i(v.get("grace", f64::from(f.grace)) as i32, 0, f.tenor - 1);
    text!("sizing", f.sizing);
    text!("repayment", f.repayment);
    num!("dsra_months", f.dsra_months);
    num!("p90_factor", f.p90_factor);
    num!("receivable_days", f.receivable_days);
    num!("payable_days", f.payable_days);
    text!("terminal", f.terminal);
    f
}
