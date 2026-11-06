// The "Compare operating options" card as plain data (no DOM, no store): the cases of one comparison, the figures of its result
// and the chart. Every function takes the open project P, so tests can use a hand-made one.
import { fmtNum, fmtPct, fmtMoney } from './format.js';
import { PV_FC_METHODS, LOAD_FC_METHODS } from './schema/index.js';
import { optionLabel } from './ws/util.js';

// Dispatch strategies with the battery. The perfect-forecast row is a benchmark, not an option.
export const OPTION_IDS = ['lf', 'cc60', 'cc80', 'cc100', 'pred'];

// The engine caps the cycle-charging setpoint at the maximum SOC.
export const ccSetpoint = (P, id) => Math.min(+id.slice(2) / 100, +P.bess.soc_max);
export const optionShort = (P, id) => (id === 'lf' ? 'load following' : id === 'pred' ? 'predictive EMS' : `cycle charging to ${Math.round(ccSetpoint(P, id) * 100)} %`);

// One batch of the project as it is, with one setting changed per row: [id, label, overrides].
export function optionCases(P) {
  const cap = (id) => ccSetpoint(P, id);
  return [
    ['diesel', 'Diesel only', { 'pv.capacity_kwp': 0, 'bess.energy_kwh': 0, 'bess.power_kw': 0, 'wind.units': 0 }],
    ['pv', P.wind.units > 0 ? 'PV + wind only' : 'PV only', { 'bess.energy_kwh': 0, 'bess.power_kw': 0 }],
    ['lf', 'Battery, load following', { 'diesel.strategy': 'load_following' }],
    // rows that coincide after the cap run once
    ...['cc60', 'cc80', 'cc100'].filter((id, i, a) => a.findIndex((j) => cap(j) === cap(id)) === i)
      .map((id) => [id, `Battery, cycle charging to ${Math.round(cap(id) * 100)} % SOC${cap(id) < +id.slice(2) / 100 ? ' (maximum SOC)' : ''}`,
        { 'diesel.strategy': 'cycle_charging', 'diesel.cc_setpoint': cap(id) }]),
    ['pred', `Battery, predictive EMS: ${optionLabel(PV_FC_METHODS, P.ems.pv_forecast)} / ${optionLabel(LOAD_FC_METHODS, P.ems.load_forecast)}`, { 'diesel.strategy': 'predictive' }],
    ['perfect', 'Battery, predictive EMS with perfect forecasts (benchmark)', { 'diesel.strategy': 'predictive', 'ems.pv_forecast': 'perfect', 'ems.load_forecast': 'perfect' }],
  ];
}

// First optimiser constraint a simulation result breaks, as the optimiser checks them; '' when it meets them all.
export function infeasible(P, R) {
  const O = P.optimizer, worst = (k) => Math.max(...R.years.map((y) => y[k] || 0));
  if (Math.max(R.unmet_fraction, R.unmet_fraction_max || 0) - O.max_unmet > 1e-9) return 'unmet load';
  if (O.min_re - R.re_fraction > 1e-9) return 'renewable fraction';
  if (R.curtail_fraction - O.max_curtail > 1e-9) return 'curtailment';
  if (O.max_lole_h >= 0 && worst('lol_h') - O.max_lole_h > 1e-9) return 'loss-of-load hours';
  if (O.max_reserve_short_h >= 0 && worst('reserve_short_h') - O.max_reserve_short_h > 1e-9) return 'reserve shortfall hours';
  if (O.max_pv_kwp > 0 && R.size.pv_kwp - O.max_pv_kwp > 1e-9) return 'land / PV limit';
  if (O.max_capex > 0 && R.econ.capex_total - O.max_capex > 1e-9) return 'capex budget';
  return '';
}

// The figures of one batch result: {err} for a case that failed, else the figures the tables show. ref: the diesel-only case, which has no
// savings against itself.
export function figures(P, res, ref = false) {
  if (res.error) return { err: res.error };
  const R = res.result, y = R.years[0], C = res.comparison || {}, F = res.finance || {};
  return { err: '', fuel: y.fuel_l, re: R.re_fraction, uh: y.unit_hours, starts: y.starts, load: R.avg_gen_load, efc: y.bess_efc, repl: R.bess_replacements,
    curt: R.curtail_fraction, unmet: R.unmet_fraction, capex: R.econ.capex_total, npc: R.econ.npc, lcoe: R.econ.lcoe, size: R.size, co2: y.co2_t,
    npv: ref ? null : C.npv_savings, irr: ref ? null : C.irr, eqIrr: ref ? null : F.equity_irr, why: infeasible(P, R) };
}

// Figures of a comparison (shared by the card, the report and the workbook): every row with its NPC change from the row above, the
// lowest feasible NPC, the options within 0.5 % of it, and the NPC steps for the waterfall. OPTIONS is {key, fast, rows}.
export function summarize(P, OPTIONS, stale) {
  const rows = OPTIONS.rows.map((r) => ({ id: r.id, label: r.label, ...figures(P, r.res, r.id === 'diesel') }));
  rows.forEach((x, i) => {
    const p = rows[i - 1];
    if (p && x.npc != null && p.npc != null) { x.dnpc = x.npc - p.npc; x.close = Math.abs(x.dnpc) < 0.005 * Math.abs(x.npc); }
  });
  const by = Object.fromEntries(rows.map((x) => [x.id, x]));
  const cheapest = (ids, feasible) => ids.map((k) => by[k]).filter((x) => x && x.npc != null && (!feasible || !x.why)).reduce((a, x) => (!a || x.npc < a.npc ? x : a), null);
  const ops = ['diesel', 'pv', ...OPTION_IDS];
  const best = cheapest(ops, true), strat = cheapest(OPTION_IDS, true) || cheapest(OPTION_IDS, false);
  const near = best ? rows.filter((x) => x !== best && ops.includes(x.id) && x.npc != null && !x.why && x.npc - best.npc < 0.005 * Math.abs(best.npc)) : [];
  const D = by.diesel, V = by.pv, L = by.lf;
  const fall = D && V && L && strat && [D, V, L].every((x) => x.npc != null) ? { D, V, L, S: strat } : null;
  return { rows, by, best, strat, near, fall, fast: OPTIONS.fast, stale: !!stale };
}

// Money without the currency, "0" for zero.
const m = (v) => (v === 0 ? '0' : fmtMoney(v, '').trim());

export const optionHeads = (cur) => ['Option', 'Fuel kL/yr', 'RE', 'Unit-h', 'Starts', 'Avg genset load', 'EFC', 'Repl.', 'Curtailed', 'Unmet', 'Capex ' + cur, 'NPC ' + cur, 'LCOE',
  'NPV vs diesel ' + cur, 'IRR', 'Equity IRR', 'NPC change ' + cur];

// Table rows: {label, err, best, why, cells (the 15 figure columns), change, close}
export function optionRows(S) {
  return S.rows.map((x) => (x.err ? { label: x.label, err: x.err } : {
    label: x.label, err: '', best: x === S.best, why: x.why,
    cells: [fmtNum(x.fuel / 1000), fmtPct(x.re), fmtNum(x.uh), fmtNum(x.starts), fmtPct(x.load), fmtNum(x.efc), fmtNum(x.repl), fmtPct(x.curt), fmtPct(x.unmet, 3),
      m(x.capex), m(x.npc), fmtNum(x.lcoe, 4), m(x.npv), fmtPct(x.irr), fmtPct(x.eqIrr)],
    change: x.dnpc == null ? '–' : (x.dnpc < 0 ? '−' : '+') + m(Math.abs(x.dnpc)), close: !!x.close,
  }));
}

// The sentence about the best option: {label, npc (text), near: [labels]} or null
export const bestNote = (S, cur) => (S.best ? { label: S.best.label, npc: fmtMoney(S.best.npc, cur), near: S.near.map((x) => x.label) } : null);

// Waterfall of the net present cost from diesel only to the hybrid with its best strategy; null when a step is missing.
export function waterfallFig(P, S, c) {
  if (!S.fall) return null;
  const cur = P.econ.currency, F = S.fall, pv = F.V.label === 'PV only' ? 'PV' : 'PV and wind', s = optionShort(P, F.S.id);
  const steps = [F.D.npc, F.V.npc - F.D.npc, F.L.npc - F.V.npc, F.S.npc - F.L.npc, F.S.npc];
  return {
    traces: [{ type: 'waterfall', measure: ['absolute', 'relative', 'relative', 'relative', 'total'],
      x: ['Diesel only', '+ ' + pv, '+ battery<br>(load following)', '+ best strategy<br>(' + s + ')', 'Hybrid<br>(' + s + ')'], y: steps,
      text: steps.map((v, i) => (i && i < 4 ? `${cur} ${v < 0 ? '−' : '+'}${fmtMoney(Math.abs(v), '').trim()}` : fmtMoney(v, cur))), textposition: 'outside', textfont: { color: c.text },
      increasing: { marker: { color: c.unmet } }, decreasing: { marker: { color: c.bess } }, totals: { marker: { color: c.gen } }, connector: { line: { color: c.border } },
      hovertemplate: '%{x}: %{y:,.0f} ' + cur + '<extra></extra>' }],
    layout: { showlegend: false, yaxis: { title: { text: 'Net present cost (' + cur + ')' } } },
  };
}
