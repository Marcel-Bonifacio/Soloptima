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

    /// debt periods per year: 1 (annual, the default), 2, 4 or 12. Above 1 the loan is scheduled period by period inside the
    /// annual model (sizing, sculpting, DSCR and DSRA per period), and interest during construction follows a drawdown schedule.
    pub debt_periods: i32,
    /// share of each calendar month in the year's CFADS for the debt periods (12 weights; empty = even)
    pub cfads_months: Vec<f64>,

    /// code of the other currency ("" = everything in the project currency)
    pub fx_currency: String,
    /// the loan, and the tariff components, are in the other currency
    pub debt_fx: bool,
    pub tariff_fx: bool,
    /// project currency per unit of the other currency at COD (year 0)
    pub fx_rate: f64,
    /// flat | escalate | table
    pub fx_mode: String,
    /// yearly change of the rate (escalate), e.g. 0.03 = the project currency loses 3 %/yr
    pub fx_escalation: f64,
    /// rate of years 1, 2, ... (table); the last one holds afterwards
    pub fx_table: Vec<f64>,
    /// multiplier on the rate of every operating year (sensitivity runs; not an input)
    pub fx_shock: f64,

    /// partnership flip (model "flip"): the tax equity investor's share of the equity at COD
    pub te_share: f64,
    /// investor share of distributed cash and of taxable income and credits, before and after the flip
    pub te_pre_cash: f64,
    pub te_pre_tax: f64,
    pub te_post_cash: f64,
    pub te_post_tax: f64,
    /// irr | year: the flip comes when the investor reaches its target IRR (not before `flip_year`), or after `flip_year`
    pub flip_trigger: String,
    pub te_target_irr: f64,
    pub flip_year: i32,
    /// the sponsor can use its share of tax losses and credits when they arise; if not, they are carried forward
    pub sponsor_tax_use: bool,
    /// investment tax credit on hard capex + contingency, and the share of it that reduces the depreciation base
    pub itc_pct: f64,
    pub itc_basis_cut: f64,
    /// production tax credit per kWh delivered, indexed with inflation, for the first `ptc_years`
    pub ptc_rate: f64,
    pub ptc_years: i32,
}

impl FinanceParams {
    /// Debt in periods shorter than a year, or in the other currency: the general schedule (`debt.rs`)
    pub fn periodic_debt(&self) -> bool { self.debt_periods > 1 || self.debt_in_fx() }
    /// Something is in the other currency: the loan, or a tariff of components (a host-owned plant has no tariff, and a
    /// discount to diesel follows the diesel cost in the project currency)
    pub fn fx_on(&self) -> bool { self.debt_in_fx() || self.tariff_in_fx() }
    pub fn debt_in_fx(&self) -> bool { !self.fx_currency.is_empty() && self.debt_fx }
    pub fn tariff_in_fx(&self) -> bool { !self.fx_currency.is_empty() && self.tariff_fx && self.model != "host" && self.tariff_mode != "diesel_discount" }
    pub fn flip(&self) -> bool { self.model == "flip" }
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
            debt_periods: 1, cfads_months: vec![], fx_currency: String::new(), debt_fx: false, tariff_fx: false, fx_rate: 1.0, fx_mode: s("flat"),
            fx_escalation: 0.0, fx_table: vec![], fx_shock: 1.0, te_share: 0.4, te_pre_cash: 0.2, te_pre_tax: 0.99, te_post_cash: 0.05,
            te_post_tax: 0.05, flip_trigger: s("irr"), te_target_irr: 0.07, flip_year: 5, sponsor_tax_use: true, itc_pct: 0.0, itc_basis_cut: 0.5,
            ptc_rate: 0.0, ptc_years: 10,
        }
    }
}

pub(crate) fn clamp(v: f64, lo: f64, hi: f64) -> f64 { if v < lo { lo } else if hi < v { hi } else { v } }
fn clamp_i(v: i32, lo: i32, hi: i32) -> i32 { if v < lo { lo } else if hi < v { hi } else { v } }

/// Numbers given as an array or as text separated by commas, semicolons or spaces; anything else is skipped
fn numbers(v: &Value) -> Vec<f64> {
    if v.is_string() {
        return v.str().split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter_map(|x| x.parse::<f64>().ok()).filter(|x| x.is_finite()).collect();
    }
    v.arr().iter().map(|x| x.num(f64::NAN)).filter(|x| x.is_finite()).collect()
}

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
    let per = v.get("debt_periods", 1.0) as i32;
    f.debt_periods = if [1, 2, 4, 12].contains(&per) { per } else { 1 };
    let w = numbers(v.at("cfads_months"));
    if w.len() == 12 && w.iter().all(|x| *x >= 0.0) && w.iter().sum::<f64>() > 0.0 { f.cfads_months = w; }
    f.fx_currency = v.gets("fx_currency", "").trim().chars().take(8).collect();
    flag!("debt_fx", f.debt_fx);
    flag!("tariff_fx", f.tariff_fx);
    f.fx_rate = { let x = v.get("fx_rate", 1.0); if x > 0.0 && x.is_finite() { x } else { 1.0 } };
    text!("fx_mode", f.fx_mode);
    f.fx_escalation = clamp(v.get("fx_escalation", 0.0), -0.5, 1.0);
    f.fx_table = numbers(v.at("fx_table")).into_iter().filter(|x| *x > 0.0).take(100).collect();
    f.te_share = clamp(v.get("te_share", f.te_share), 0.0, 1.0);
    f.te_pre_cash = clamp(v.get("te_pre_cash", f.te_pre_cash), 0.0, 1.0);
    f.te_pre_tax = clamp(v.get("te_pre_tax", f.te_pre_tax), 0.0, 1.0);
    f.te_post_cash = clamp(v.get("te_post_cash", f.te_post_cash), 0.0, 1.0);
    f.te_post_tax = clamp(v.get("te_post_tax", f.te_post_tax), 0.0, 1.0);
    text!("flip_trigger", f.flip_trigger);
    num!("te_target_irr", f.te_target_irr);
    f.flip_year = clamp_i(v.get("flip_year", f64::from(f.flip_year)) as i32, 1, 40);
    flag!("sponsor_tax_use", f.sponsor_tax_use);
    f.itc_pct = clamp(v.get("itc_pct", f.itc_pct), 0.0, 1.0);
    f.itc_basis_cut = clamp(v.get("itc_basis_cut", f.itc_basis_cut), 0.0, 1.0);
    f.ptc_rate = v.get("ptc_rate", f.ptc_rate).max(0.0);
    f.ptc_years = clamp_i(v.get("ptc_years", f64::from(f.ptc_years)) as i32, 0, 40);
    f
}
