// What the project finance screen shows, as plain data: the tiles, the solved-tariff note, the chart traces, the cash-flow table,
// the debt periods and the exchange-rate sensitivity.
import { fmtNum, fmtPct, fmtMoney } from './format.js';
import { rowOpts, PERIOD_COLS, periodName } from './finance-view.js';

const yrs = (x) => (x == null ? 'never' : fmtNum(x, 1) + ' yr');

export function finTiles(R, P) {
  const m = R.metrics, cur = P.econ.currency, F = P.finance, host = R.model === 'host', fxc = R.fx_currency;
  const per = m.debt_periods ? periodName(m.debt_periods) : '';
  return [
    ...(R.model === 'flip' ? [['Sponsor IRR (after tax)', fmtPct(m.sponsor_irr, 2), `NPV ${fmtMoney(m.sponsor_npv, cur)} at ${fmtPct(F.equity_discount)} · invests ${fmtMoney(m.sponsor_investment, cur)}`, true],
      ['Investor IRR (after tax)', fmtPct(m.te_irr, 2), `invests ${fmtMoney(m.te_investment, cur)} · target ${fmtPct(F.te_target_irr, 1)}`, true],
      ['Flip', m.flip_year == null ? 'not reached' : 'after year ' + m.flip_year, `tax credits ${fmtMoney(m.tax_credits_total, cur)} (ITC ${fmtMoney(m.itc, cur)})`]] : []),
    [R.model === 'flip' ? 'Equity IRR, both partners' : 'Equity IRR (after tax)', fmtPct(m.equity_irr, 2), `NPV ${fmtMoney(m.equity_npv, cur)} at ${fmtPct(F.equity_discount)}`, true],
    ['Project IRR (after tax)', fmtPct(m.project_irr, 2), `NPV ${fmtMoney(m.project_npv, cur)} at ${fmtPct(P.econ.discount_rate)}`, true],
    [host ? 'Avoided cost, year 1' : 'Tariff, year 1', `${cur} ${fmtNum(m.tariff_y1, 4)}`, host ? 'per kWh of renewable energy' : `LPPA ${fmtNum(m.lppa_nominal, 4)} nominal · ${fmtNum(m.lppa_real, 4)} real`, true],
    ['LCOE (unlevered, pre-tax)', `${cur} ${fmtNum(m.lcoe_nominal, 4)}`, `real ${fmtNum(m.lcoe_real, 4)} /kWh`],
    ['Equity payback', yrs(m.equity_payback), `project ${yrs(m.project_payback)}`],
    per ? ['Minimum DSCR per ' + per, fmtNum(m.dscr_min_period, 2), m.dscr_avg == null ? 'no debt' : `per year ${fmtNum(m.dscr_min, 2)} min · ${fmtNum(m.dscr_avg, 2)} average · LLCR ${fmtNum(m.llcr, 2)}`]
      : ['Minimum DSCR', fmtNum(m.dscr_min, 2), m.dscr_avg == null ? 'no debt' : `average ${fmtNum(m.dscr_avg, 2)} · LLCR ${fmtNum(m.llcr, 2)}`],
    ['Debt', fmtMoney(m.debt, cur), `${fmtPct(m.debt_fraction, 1)} of total cost · DSCR capacity ${fmtMoney(m.debt_dscr_capacity, cur)}`],
    ['Total installed cost', fmtMoney(m.total_installed_cost, cur), `hard ${fmtMoney(m.hard_capex, cur)} · IDC ${fmtMoney(m.idc, cur)} · fee ${fmtMoney(m.financing_fee, cur)}`],
    ['Equity', fmtMoney(m.equity, cur), `DSRA at COD ${fmtMoney(m.dsra_initial, cur)}`],
    ...(fxc ? [[`Exchange rate (${cur} per ${fxc})`, fmtNum(m.fx_rate_cod, 4), `year ${m.term}: ${fmtNum(m.fx_rate_end, 4)}${m.debt_in_fx != null ? ` · loan ${fxc} ${fmtNum(m.debt_in_fx, 0)}` : ''}${m.tariff_y1_fx != null ? ` · tariff ${fxc} ${fmtNum(m.tariff_y1_fx, 4)}/kWh` : ''}`]] : []),
    ...(host || R.model === 'flip' ? [] : [['Host savings vs diesel', fmtPct(m.host_saving_pct, 1), `NPV ${fmtMoney(m.host_npv_savings, cur)} over ${m.term} yr`]]),
    ...(host ? [] : [['PLN-style levelised tariff', `${cur} ${fmtNum(m.pln_levelised_tariff, 4)}`, 'annuity of the tariff series']]),
  ];
}

// The note on the tariff solved for a target IRR; null when no solve was asked for. Plain text parts so the screen can escape them.
export function solvedNote(R, P) {
  const sv = R.solved, m = R.metrics, cur = P.econ.currency, F = P.finance;
  if (!sv) return null;
  if (!sv.ok) return { ok: false, text: sv.reason };
  return { ok: true, a: `Tariff solved for a ${fmtPct(F.target_irr)} ${F.solve_for} IRR: the input tariff scaled by `, b: fmtNum(m.tariff_scale, 4), c: ' → year-1 tariff ', d: `${cur} ${fmtNum(m.tariff_y1, 4)}/kWh`, e: '.' };
}

const hov = (cur) => (t) => ({ ...t, hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra>' + t.name + '</extra>' });

export function finCharts(R, P, c) {
  const Y = R.years, cur = P.econ.currency, F = P.finance, host = R.model === 'host', h = hov(cur), yr = Y.map((y) => y.year);
  const cash = { traces: [{ type: 'bar', x: yr, y: Y.map((y) => y.equity_cf), marker: { color: Y.map((y) => (y.equity_cf >= 0 ? c.gen : c.unmet)), cornerradius: 3 }, hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra></extra>' }],
    layout: { showlegend: false, xaxis: { title: { text: 'Year (0 = construction / COD)' } }, yaxis: { title: { text: cur } } } };
  const cum = { traces: [
    { type: 'scatter', mode: 'lines', name: 'Equity', x: yr, y: R.equity_cum, line: { color: c.gen, width: 2.5 } },
    { type: 'scatter', mode: 'lines', name: 'Project (unlevered)', x: yr, y: R.project_cum, line: { color: c.text2, width: 2, dash: 'dash' } }].map(h),
  layout: { xaxis: { title: { text: 'Year' } }, yaxis: { title: { text: cur + ' cumulative' }, zeroline: true }, hovermode: 'x unified' } };
  // the cover of each debt period when the loan is paid in periods, at the year plus the elapsed part of it
  const per = R.periods, m = R.metrics.debt_periods || 1;
  const dy = per ? per.filter((p) => p.dscr != null).map((p) => ({ year: p.year - 1 + (p.period - 1) % m / m, dscr: p.dscr, n: p.period }))
    : Y.filter((y) => y.dscr != null);
  const dscr = { traces: dy.length ? [{ type: 'bar', x: dy.map((y) => y.year), y: dy.map((y) => y.dscr), marker: { color: c.bess, cornerradius: per ? 1 : 3 },
    hovertemplate: per ? '%{text}: DSCR %{y:.2f}<extra></extra>' : 'year %{x}: DSCR %{y:.2f}<extra></extra>', text: per ? dy.map((p) => periodName(m) + ' ' + p.n) : undefined }] : [],
    layout: { showlegend: false, xaxis: { title: { text: per ? 'Year (each bar one ' + periodName(m) + ')' : 'Year' } }, yaxis: { title: { text: 'CFADS / debt service' }, rangemode: 'tozero' },
      shapes: dy.length ? [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: F.dscr_target, y1: F.dscr_target, line: { color: c.unmet, dash: 'dot', width: 1.5 } }] : [],
      annotations: dy.length ? [] : [{ text: 'No debt', showarrow: false, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, font: { color: c.muted } }] } };
  const op = Y.slice(1), oy = op.map((y) => y.year);
  const hostChart = host
    ? { traces: [{ type: 'bar', name: 'Avoided diesel cost', x: oy, y: op.map((y) => y.revenue), marker: { color: c.bess } },
      { type: 'bar', name: 'O&M, insurance, replacements', x: oy, y: op.map((y) => -y.opex), marker: { color: c.unmet } }].map(h),
    layout: { barmode: 'relative', yaxis: { title: { text: cur } }, xaxis: { title: { text: 'Year' } } } }
    : { traces: [{ type: 'scatter', mode: 'lines', name: 'Diesel only', x: oy, y: op.map((y) => y.host_baseline), line: { color: c.unmet, width: 2.5 } },
      { type: 'scatter', mode: 'lines', name: 'With the plant (tariff + remaining diesel)', x: oy, y: op.map((y) => y.host_cost), line: { color: c.gen, width: 2.5 } }].map(h),
    layout: { yaxis: { title: { text: cur + ' per year' }, rangemode: 'tozero' }, xaxis: { title: { text: 'Year' } }, hovermode: 'x unified' } };
  return { cash, cum, dscr, host: hostChart };
}

// rows: [key, label, decimals, class] or ['g', group title]
export function finTable(R, P, ROWS) {
  const Y = R.years, host = R.model === 'host';
  return { heads: [P.econ.currency, ...Y.map((y) => y.year)],
    rows: ROWS(host, rowOpts(R)).map(([k, label, dp, cls]) => (k === 'g' ? { group: label } : { cls: cls || '', cells: [label, ...Y.map((y) => (y[k] == null ? '' : fmtNum(y[k], dp || 0)))] })) };
}

// The debt periods as a table; null when the loan is paid yearly
export function periodTable(R) {
  if (!R.periods) return null;
  return { heads: PERIOD_COLS.map((c) => c[1]), rows: R.periods.map((p) => PERIOD_COLS.map(([k, , dp]) => (p[k] == null ? '' : fmtNum(p[k], dp)))) };
}

// The returns with the exchange rate of every operating year moved; null without another currency
export function fxTable(R, P) {
  const S = R.fx_sensitivity, cur = P.econ.currency;
  if (!S) return null;
  const flip = R.model === 'flip';
  return { heads: ['Rate change', `Rate, year 1 (${cur} per ${R.fx_currency})`, 'Equity IRR', ...(flip ? ['Sponsor IRR', 'Investor IRR'] : []), 'Project IRR', 'Minimum DSCR', 'Equity NPV'],
    rows: S.map((s) => ({ base: s.shock === 0, cells: [(s.shock > 0 ? '+' : '') + fmtPct(s.shock, 0), fmtNum(s.fx_rate_y1, 4), fmtPct(s.equity_irr, 2),
      ...(flip ? [fmtPct(s.sponsor_irr, 2), fmtPct(s.te_irr, 2)] : []), fmtPct(s.project_irr, 2), fmtNum(s.dscr_min, 2), fmtMoney(s.equity_npv, cur)] })) };
}
