// Project finance page, as plain logic: the term presets, the depreciation presets, the tariff component rules, the rows of the
// annual cash-flow table and the CSV export, the debt-period and exchange-rate tables, and the note on the debt-sizing haircut.

// Art. 31E reduced rate with its turnover limits of IDR 4.8 bn and 50 bn, converted at 15,500 IDR per unit of another currency
export function idTax(currency) {
  const fx = currency === 'IDR' ? 1 : 15500;
  return { sme_31e: true, sme_low: Math.round(4.8e9 / fx), sme_high: Math.round(50e9 / fx) };
}

export const PRESET_LIST = [['generic', 'Generic'], ['pln', 'Indonesia PLN IPP (PV + BESS)'], ['lease', 'Captive lease to industrial host'], ['diesel', 'Tariff at a discount to diesel'],
  ['usd_loan', 'Quarterly loan in US dollars'], ['flip', 'Partnership flip with tax credit']];

export const MODELS = [
  ['host', 'Host-owned', 'The plant owner invests and earns the avoided diesel cost.'],
  ['ppa', 'Single owner (PPA)', 'An investor sells renewable kWh under a PPA, e.g. to PLN. Tariff can be solved for a target IRR.'],
  ['tpo', 'Third-party ownership', "A developer leases the plant or sells kWh to the host; shows both the developer return and the host's savings."],
  ['flip', 'Partnership flip (tax equity)', 'A tax equity investor and a sponsor share cash, tax losses and credits; the split flips when the investor reaches its target return.'],
];

// The values a preset sets; `currency` matters for the tax limits of the Indonesian presets and the rate of the dollar loan.
export function presetValues(id, currency) {
  const tax = idTax(currency);
  const annual = { debt_periods: '1', cfads_months: null, fx_currency: '' };   // the term-sheet presets start from a yearly loan in the project currency
  const all = {
    generic: () => ({ ...annual, tax_rate: 0.25, wht_pct: 0, sme_31e: false, gearing: 0.7, interest: 0.08, tenor: 12, grace: 0, repayment: 'sculpted', sizing: 'min',
      dscr_target: 1.3, dsra_months: 6, insurance_pct: 0.005, construction_years: 1, upfront_fee: 0.02, contingency_pct: 0.02, vat_pct: 0,
      receivable_days: 30, payable_days: 30, take_or_pay: 0, stage2_year: 0, tariff_mode: 'components', tariff_vat: 0, terminal: 'salvage',
      dep_method: 'sl', dep_life: 20, dep_life_bess: 10, dep_preset: 'sl_20', loss_cf_years: 5,
      components: [{ name: 'Energy tariff', v1: 0.12, v2: 0.12, idx: 0.02, pct: 0 }] }),
    // Indonesian IPP selling PV + BESS energy to PLN (staged A/B/E/F tariff)
    pln: () => ({ ...annual, model: 'ppa', term: 20, tariff_mode: 'components', stage2_year: 11,
      components: [{ name: 'A (capital)', v1: 0.085, v2: 0.035, idx: 0, pct: 0 }, { name: 'B (fixed O&M)', v1: 0.025, v2: 0.025, idx: 0, pct: 0 },
                   { name: 'E (special facility)', v1: 0, v2: 0, idx: 0, pct: 0.3 }, { name: 'F (BESS)', v1: 0, v2: 0, idx: 0, pct: 0.6 }],
      take_or_pay: 0, ace_factor: 1, penalty_threshold: 0.9, penalty_rate: 0, tariff_vat: 0, solve: false,
      tax_rate: 0.22, wht_pct: 0.02, ...tax, loss_cf_years: 5, tax_holiday_years: 0,
      dep_preset: 'id_g4', dep_method: 'db', dep_life: 20, dep_life_bess: 8,
      gearing: 0.7, interest: 0.074, tenor: 10, grace: 0, repayment: 'sculpted', sizing: 'min', dscr_target: 1.2, upfront_fee: 0.02, dsra_months: 6,
      construction_years: 1, contingency_pct: 0.02, vat_pct: 0.11, vat_recoverable: false, insurance_pct: 0.009, receivable_days: 60, payable_days: 30,
      terminal: 'transfer', equity_discount: 0.12 }),
    // Developer owns PV + BESS and sells kWh to an industrial host that keeps its gensets
    lease: () => ({ ...annual, model: 'tpo', term: 20, tariff_mode: 'components', stage2_year: 0,
      components: [{ name: 'Lease tariff', v1: 0.15, v2: 0.15, idx: 0.015, pct: 0 }],
      take_or_pay: 0.9, ace_factor: 1, deemed_share: 0, tariff_vat: 0.11, solve: false,
      tax_rate: 0.22, wht_pct: 0.02, ...tax, loss_cf_years: 5,
      dep_preset: 'sl_20', dep_method: 'sl', dep_life: 20, dep_life_bess: 10,
      gearing: 0.7, interest: 0.10, tenor: 10, grace: 0, repayment: 'equal', sizing: 'gearing', dscr_target: 1.2, upfront_fee: 0.01, dsra_months: 0,
      construction_years: 0, insurance_pct: 0.003, receivable_days: 30, payable_days: 30, terminal: 'transfer' }),
    diesel: () => ({ model: 'tpo', tariff_mode: 'diesel_discount', diesel_discount: 0.25, take_or_pay: 0.9, solve: false }),
    // a dollar loan paid quarterly to a project that earns the project currency (only the quarterly terms when that is the dollar)
    usd_loan: () => ({ debt_periods: '4', dsra_months: 6, repayment: 'sculpted', ...(currency === 'USD' ? { fx_currency: '' }
      : { fx_currency: 'USD', debt_fx: true, tariff_fx: false, fx_rate: currency === 'IDR' ? 15500 : 1, fx_mode: 'escalate', fx_escalation: 0.03, interest: 0.075 }) }),
    // a partnership flip with an investment tax credit, on a fast tax depreciation
    flip: () => ({ ...annual, model: 'flip', tariff_mode: 'components', tax_rate: 0.21, wht_pct: 0, sme_31e: false, loss_cf_years: 0, tax_holiday_years: 0,
      dep_preset: 'custom', dep_method: 'db', dep_life: 5, dep_life_bess: 5, itc_pct: 0.3, itc_basis_cut: 0.5, ptc_rate: 0,
      te_share: 0.4, te_pre_cash: 0.2, te_pre_tax: 0.99, te_post_cash: 0.05, te_post_tax: 0.05, flip_trigger: 'irr', te_target_irr: 0.07, flip_year: 5,
      sponsor_tax_use: false, gearing: 0.3, sizing: 'min', dscr_target: 1.3, repayment: 'sculpted', interest: 0.065, tenor: 15, solve: false }),
  };
  return all[id] ? all[id]() : null;
}

// depreciation preset: [method, life of the plant, life of the battery]; 0 means the whole term
const DEP = { id_g2: ['db', 8, 8], id_g3: ['db', 16, 8], id_g4: ['db', 20, 8], sl_20: ['sl', 20, 10], sl_term: ['sl', 0, 0] };

// What a change of the depreciation fields does to the others: a preset sets method and lives, an edit of method or life makes the
// preset "custom". Returns the values to assign to the finance block, or null when nothing follows.
export function depFollow(key, F, lifetime) {
  if (key === 'finance.dep_preset' && DEP[F.dep_preset]) {
    const [m, a, b] = DEP[F.dep_preset], term = F.term || lifetime;
    return { dep_method: m, dep_life: a || term, dep_life_bess: b || term };
  }
  if (/^finance\.dep_(method|life)/.test(key)) return { dep_preset: 'custom' };
  return null;
}

// One edit of the tariff component table. `raw` is the text of the input; index and share are typed in percent.
export function editComponent(c, field, raw, stage2) {
  const n = +raw || 0;
  if (field === 'name') c.name = raw;
  else if (field === 'idx' || field === 'pct') c[field] = n / 100;
  else c[field] = n;
  if (field === 'v1' && !stage2) c.v2 = c.v1;
}
export const newComponent = () => ({ name: 'New component', v1: 0, v2: 0, idx: 0, pct: 0 });
export const pctText = (x) => +(x * 100).toFixed(4);

// Which text the revenue card shows instead of the table: 'host', 'discount' or null for the component table
export function revenueMode(F) {
  if (F.model === 'host') return 'host';
  return F.tariff_mode !== 'components' ? 'discount' : null;
}

// Where the debt-sizing haircut comes from, while the project still holds the value "Use for debt sizing" set; '' otherwise
export function p90Note(P) {
  const A = P.resource_years && P.resource_years.applied;
  if (!A || A.p90_factor !== P.finance.p90_factor) return '';
  return `Revenue haircut ${A.p90_factor}: revenue P90 ÷ P50 of ${A.basis === 10 ? 'a 10-year average' : 'one year'} from the inter-annual variability run (Solar resource, ${A.database} ${A.from}–${A.to}).`;
}

// What a finance result holds beyond the annual model: an exchange rate, a loan in the other currency, a partnership flip
export function rowOpts(R) {
  const y = R && R.years && R.years[0];
  return { fx: !!y && y.fx_rate != null, fxDebt: !!y && y.fx_loss != null, flip: !!R && R.model === 'flip', cur: (R && R.fx_currency) || '' };
}

// rows of the annual table: [key, label, decimals, class] or ['g', group title]; `o` is rowOpts of the result
export const finRows = (host, o = {}) => [
  ['g', 'Energy'], ['energy', 'Renewable energy delivered (kWh)'], ...(host ? [] : [['billed', 'Energy billed (kWh)'], ['ace', 'Contracted energy (kWh)']]),
  ['tariff', host ? 'Avoided cost per kWh' : 'Tariff per kWh', 4],
  ['g', 'Operating cash flow'], ['revenue', host ? 'Avoided diesel cost' : 'Revenue'], ['opex_om', 'Less O&M (PV, BESS, wind)'], ['replacements', 'Less Replacements'],
  ['fixed_opex', 'Less fixed opex & land lease'], ['insurance', 'Less insurance'], ['opex', 'Total operating cost', 0, 'total'], ['ebitda', 'EBITDA', 0, 'total'],
  ['g', 'Tax'], ['depreciation', 'Depreciation'], ['interest', 'Interest'], ['taxable', 'Taxable income'], ['tax', 'Income tax'], ...(host ? [] : [['wht', 'Withholding (credited)']]),
  ['net_income', 'Net income', 0, 'total'],
  ['g', 'Debt'], ['cfads', 'Cash flow available for debt service', 0, 'total'], ['debt_balance', 'Opening debt balance'], ['principal', 'Principal'],
  ['debt_service', 'Debt service'], ['dscr', 'DSCR', 2], ['dsra', 'DSRA balance'],
  ['g', 'Returns'], ['d_wc', 'Change in working capital'], ['project_cf', 'Project cash flow (unlevered, after tax)', 0, 'total'], ['equity_cf', 'Equity cash flow (after tax)', 0, 'total'],
  ...(o.fx ? [['g', 'Currency'], ['fx_rate', `Exchange rate (per ${o.cur || 'unit'})`, 4],
    ...(o.fxDebt ? [['fx_loss', 'Realised exchange loss on principal'], ['debt_balance_fx', `Opening debt balance (${o.cur || 'loan currency'})`]] : [])] : []),
  ...(o.flip ? [['g', 'Partnership flip'], ['tax_credits', 'Tax credits'], ['distributable', 'Cash distributed', 0, 'total'], ['te_cash_share', 'Investor share of cash', 2],
    ['te_cash', 'Investor cash'], ['te_tax', 'Investor tax saved (credits less tax)'], ['te_cf', 'Investor cash flow (after tax)', 0, 'total'],
    ['sponsor_cash', 'Sponsor cash'], ['sponsor_tax', 'Sponsor tax saved (credits less tax)'], ['sponsor_cf', 'Sponsor cash flow (after tax)', 0, 'total']] : []),
  ...(host || o.flip ? [] : [['g', 'Host'], ['host_baseline', 'Diesel-only cost'], ['host_cost', 'Cost with the plant'], ['host_saving', 'Host saving', 0, 'total']]),
];

// columns of the debt-period table: [key, label, decimals]
/** @type {[string, string, number][]} */
export const PERIOD_COLS = [['period', 'Period', 0], ['year', 'Year', 0], ['month', 'From month', 0], ['cfads', 'CFADS', 0], ['interest', 'Interest', 0],
  ['principal', 'Principal', 0], ['debt_service', 'Debt service', 0], ['debt_balance', 'Opening balance', 0], ['dsra', 'Reserve at end', 0], ['dscr', 'DSCR', 2]];
export const periodName = (n) => ({ 2: 'half-year', 4: 'quarter', 12: 'month' })[+n] || 'year';

// The debt periods as CSV text; null when the result has none
export function periodsCsv(R) {
  if (!R || !R.periods) return null;
  return [PERIOD_COLS.map((c) => '"' + c[1] + '"').join(',')].concat(R.periods.map((p) => PERIOD_COLS.map(([k]) => (p[k] == null ? '' : +(+p[k]).toFixed(4))).join(','))).join('\n');
}

// The cash-flow table as CSV text; null when there is no finance result
export function cashflowCsv(R) {
  if (!R) return null;
  const lines = [['Item'].concat(R.years.map((y) => 'Y' + y.year)).join(',')];
  finRows(R.model === 'host', rowOpts(R)).filter((r) => r[0] !== 'g').forEach(([k, label]) =>
    lines.push(['"' + label + '"'].concat(R.years.map((y) => (y[k] == null ? '' : +(+y[k]).toFixed(4)))).join(',')));
  return lines.join('\n');
}
