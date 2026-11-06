// What the project finance screen shows, as plain data: the tiles, the solved-tariff note, the chart traces and the cash-flow table.
import { fmtNum, fmtPct, fmtMoney } from './format.js';

const yrs = (x) => (x == null ? 'never' : fmtNum(x, 1) + ' yr');

export function finTiles(R, P) {
  const m = R.metrics, cur = P.econ.currency, F = P.finance, host = R.model === 'host';
  return [
    ['Equity IRR (after tax)', fmtPct(m.equity_irr, 2), `NPV ${fmtMoney(m.equity_npv, cur)} at ${fmtPct(F.equity_discount)}`, true],
    ['Project IRR (after tax)', fmtPct(m.project_irr, 2), `NPV ${fmtMoney(m.project_npv, cur)} at ${fmtPct(P.econ.discount_rate)}`, true],
    [host ? 'Avoided cost, year 1' : 'Tariff, year 1', `${cur} ${fmtNum(m.tariff_y1, 4)}`, host ? 'per kWh of renewable energy' : `LPPA ${fmtNum(m.lppa_nominal, 4)} nominal · ${fmtNum(m.lppa_real, 4)} real`, true],
    ['LCOE (unlevered, pre-tax)', `${cur} ${fmtNum(m.lcoe_nominal, 4)}`, `real ${fmtNum(m.lcoe_real, 4)} /kWh`],
    ['Equity payback', yrs(m.equity_payback), `project ${yrs(m.project_payback)}`],
    ['Minimum DSCR', fmtNum(m.dscr_min, 2), m.dscr_avg == null ? 'no debt' : `average ${fmtNum(m.dscr_avg, 2)} · LLCR ${fmtNum(m.llcr, 2)}`],
    ['Debt', fmtMoney(m.debt, cur), `${fmtPct(m.debt_fraction, 1)} of total cost · DSCR capacity ${fmtMoney(m.debt_dscr_capacity, cur)}`],
    ['Total installed cost', fmtMoney(m.total_installed_cost, cur), `hard ${fmtMoney(m.hard_capex, cur)} · IDC ${fmtMoney(m.idc, cur)} · fee ${fmtMoney(m.financing_fee, cur)}`],
    ['Equity', fmtMoney(m.equity, cur), `DSRA at COD ${fmtMoney(m.dsra_initial, cur)}`],
    ...(host ? [] : [['Host savings vs diesel', fmtPct(m.host_saving_pct, 1), `NPV ${fmtMoney(m.host_npv_savings, cur)} over ${m.term} yr`],
      ['PLN-style levelised tariff', `${cur} ${fmtNum(m.pln_levelised_tariff, 4)}`, 'annuity of the tariff series']]),
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
  const dy = Y.filter((y) => y.dscr != null);
  const dscr = { traces: dy.length ? [{ type: 'bar', x: dy.map((y) => y.year), y: dy.map((y) => y.dscr), marker: { color: c.bess, cornerradius: 3 }, hovertemplate: 'year %{x}: DSCR %{y:.2f}<extra></extra>' }] : [],
    layout: { showlegend: false, xaxis: { title: { text: 'Year' } }, yaxis: { title: { text: 'CFADS / debt service' }, rangemode: 'tozero' },
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
    rows: ROWS(host).map(([k, label, dp, cls]) => (k === 'g' ? { group: label } : { cls: cls || '', cells: [label, ...Y.map((y) => (y[k] == null ? '' : fmtNum(y[k], dp || 0)))] })) };
}
