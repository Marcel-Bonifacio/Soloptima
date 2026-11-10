// Workbook sheets, second half: energy balance, baseline check, yearly and hourly series, options, tornado, finance (with the
// exchange-rate sensitivity) and debt periods, optimisation and forecasting.
import { rowOpts, PERIOD_COLS } from '../finance-view.js';
import { groupName } from '../fleet-view.js';

function energySheet({ SIM, h }) {
  const R = SIM.result, y = R.years[0], F = h.energyFlow(R), g = !!R.has_grid;
  const rows = [['Month', 'Load kWh', 'PV direct kWh', 'Wind direct kWh', 'Battery to load kWh', 'Diesel to load kWh', 'Diesel to battery kWh', 'Unmet kWh', 'RE curtailed kWh',
    'Genset dump kWh', 'Fuel L', 'RE fraction', ...(g ? ['Grid to load kWh', 'Exported kWh'] : [])]];
  h.monthBalance(R).forEach((x) => rows.push([x.label, x.load, x.pv, x.wind, x.bess, x.gen, x.gch, x.unmet, x.curt, x.dump, x.fuel, x.re, ...(g ? [x.grid, x.export] : [])]));
  rows.push([], ['Energy flow (yr 1)', 'kWh', '']);
  [['PV available', y.pv_avail], ['PV to load', y.pv_to_load], ['PV to battery', y.pv_to_bess], ['PV curtailed', y.pv_curtailed],
    ['Wind available', y.wind_avail], ['Wind to load', y.wind_to_load], ['Wind to battery', y.wind_to_bess], ['Wind curtailed', y.wind_curtailed],
    ['Genset energy', y.gen_kwh], ['Genset to load', y.gen_to_load], ['Genset to battery', y.gen_to_bess], ['Genset dump', y.gen_dump],
    ['Battery charged', y.bess_ch], ['Battery discharged', y.bess_dis], ['Battery losses', F.loss], ['Self-discharge', y.self_discharge],
    ['Stored energy, start of year', y.e_start], ['Stored energy, end of year', y.e_end], ['Unmet', y.unmet], ['Load', y.load], ['Auxiliaries', F.aux], ['Site load', y.load - F.aux],
    ...(g ? [['Grid import', y.grid_import], ['PV exported', y.pv_to_grid], ['Wind exported', y.wind_to_grid], ['Grid up (h)', y.grid_up_h], ['Grid outages', y.grid_outages],
      ['Highest grid import (kW)', y.grid_peak_kw]] : []),
    ['Direct RE share', F.direct], ['Inputs − outputs', F.gap]].forEach((r) => rows.push(r));
  return rows;
}

// A mixed fleet's groups in merit order, every project year: units online hours, energy, fuel, starts and O&M of each group
function groupsSheet({ P, SIM }) {
  const R = SIM.result, cur = P.econ.currency;
  const rows = [['Year', 'Group (merit order)', 'Units', 'Unit kW', 'Min. loading', 'Run hours', 'Energy kWh', 'Fuel L', 'Starts', 'O&M ' + cur]];
  R.years.forEach((y) => (y.groups || []).forEach((g, k) => {
    const f = R.fleet[k];
    rows.push([y.year, groupName(P.diesel, g.index), f.units, f.unit_kw, f.min_load, g.unit_hours, g.gen_kwh, g.fuel_l, g.starts, g.c_om]);
  }));
  return rows;
}

function baselineSheet(K) {
  const rows = [['Record', 'Unit', 'Site', 'Model', 'Difference', 'Tolerance', 'Flag']];
  K.rows.forEach((x) => rows.push([x.label, x.unit, x.site, x.model, x.d, x.tol, x.flag ? 'beyond tolerance' : 'within tolerance']));
  if (K.monthly) {
    rows.push([], ['Month', 'Site fuel L', 'Model fuel L', 'Difference']);
    K.months.forEach((x) => rows.push([x.label, x.site, x.model, x.d]));
    rows.push(['CV(RMSE)', K.cv, '', '', `over the ${K.nMonths} months with a record`]);
  }
  rows.push([], ['Source', K.recs.source], ['Period', K.recs.period], ['Scope', K.recs.scope],
    ['Basis', 'diesel-only case of the last simulation, year 1, without auxiliary loads; difference = model ÷ site − 1'],
    ['Fuel saved change per 1 % of baseline fuel error', K.lever, '%']);
  K.diag.forEach((t) => rows.push(['Diagnosis', t]));
  if (K.monthNote) rows.push(['Note', K.monthNote]);
  return rows;
}

const YEAR_KEYS = ['year', 'load', 'aux', 'served', 'served_site', 'unmet', 'pv_avail', 'pv_to_load', 'pv_to_bess', 'pv_curtailed', 'wind_avail', 'wind_to_load', 'wind_to_bess', 'wind_curtailed', 'bess_dis', 'bess_ch', 'self_discharge', 'e_start', 'e_end', 'bess_soh', 'bess_efc', 'bess_efc_dc', 'soh_loss_cal', 'soh_loss_cyc', 'max_c_rate', 'bess_replaced', 'gen_kwh', 'gen_to_load', 'gen_to_bess', 'gen_dump', 'fuel_l', 'unit_hours', 'starts', 'max_starts_h', 'max_units', 'fleet_full_h', 'minload_h', 'minload_run_max_h', 'lol_h', 'lol_events', 'lol_max_h', 'reserve_short_h', 'reserve_short_max_kw', 're_fraction', 'co2_t', 'c_fuel', 'c_om', 'c_replace', 'c_carbon', 'c_salvage', 'c_total'];

const YEAR_OPTIONAL = ['ramp_limited_h', 'unit_outages', 'unit_outage_h', 'n1_short_h', 'n1_short_max_kw'];   // when used
const YEAR_GRID = ['grid_import', 'grid_export', 'pv_to_grid', 'wind_to_grid', 'grid_up_h', 'grid_outages', 'grid_peak_kw', 'c_grid_import', 'c_grid_demand', 'c_grid_export', 'c_grid'];

function seriesSheets({ SIM, h }) {
  const R = SIM.result, y1 = R.years[0], YK = (R.has_grid ? YEAR_KEYS.concat(YEAR_GRID) : YEAR_KEYS).concat(YEAR_OPTIONAL.filter((k) => y1[k] != null)), H = R.hourly, hk = Object.keys(H).filter((k) => Array.isArray(H[k]) && H[k].length === h.HOURS);
  const mrows = [['Month'].concat(hk)];
  const ms = hk.map((k) => (k === 'soc' || k === 'soc_target' || k === 'gen_units' ? null : h.monthlySum(H[k])));
  h.MONTHS.forEach((m, i) => mrows.push([m].concat(ms.map((s) => (s ? s[i] : null)))));
  const hrows = [['Hour', 'Date', 'Hour of day'].concat(hk)];
  for (let t = 0; t < h.HOURS; t++) hrows.push([t, h.dateOfHour(t), t % 24].concat(hk.map((k) => H[k][t])));
  return [{ name: 'Yearly', rows: [YK].concat(R.years.map((y) => YK.map((k) => y[k]))) }, { name: 'Monthly (yr 1)', rows: mrows }, { name: 'Hourly (yr 1)', rows: hrows }];
}

function optionsSheet({ P, h }) {
  const cur = P.econ.currency, S = h.optionsSummary();
  const rows = [['Option', 'Feasible', 'Fuel L/yr (yr 1)', 'RE fraction', 'Unit-hours', 'Starts', 'Avg genset load', 'Battery EFC', 'Battery replacements',
    'Curtailment', 'Unmet load', 'Capex ' + cur, 'NPC ' + cur, 'LCOE ' + cur + '/kWh', 'NPV vs diesel only ' + cur, 'IRR vs diesel only', 'Equity IRR', 'NPC change vs row above ' + cur, 'Note']];
  S.rows.forEach((x) => rows.push(x.err ? [x.label].concat(new Array(17).fill(null), [x.err])
    : [x.label, x.why ? 'no: ' + x.why : 'yes', x.fuel, x.re, x.uh, x.starts, x.load, x.efc, x.repl, x.curt, x.unmet, x.capex, x.npc, x.lcoe, x.npv, x.irr, x.eqIrr, x.dnpc,
      [x === S.best ? 'lowest feasible NPC' : '', x.close ? 'within model accuracy' : '', x.id === 'perfect' ? 'benchmark, not an option' : ''].filter(Boolean).join('; ')]));
  rows.push([], ['Basis', S.fast ? 'year 1 repeated over the project life' : 'every project year']);
  if (S.stale) rows.push(['Note', 'The inputs changed after this comparison; run Compare options again.']);
  return rows;
}

function tornadoSheet({ P, TORNADO, h }) {
  const cur = P.econ.currency, S = h.tornadoSummary(P.tornado.metric), M = h.tornadoMetrics, ms = Object.keys(M), mode = { x: '×', '+': '+', '=': '=' };
  const get = (res, m) => { if (!res || res.error) return null; const x = M[m][1](res); return x == null || !isFinite(x) ? null : x; };
  const unit = { npv: ' ' + cur, lcoe: ' ' + cur + '/kWh', irr: '', eq_irr: '', fuel: ' L' };
  // the change in the card's units: percentages in % or pp, with the field's unit
  const chg = (x, i) => { const v = i ? x.hi : x.lo, u = h.tornadoUnit(x); return v == null ? '' : `${mode[x.mode] || x.mode} ${h.tornadoPct(x) ? +(v * 100).toFixed(6) : v}${u ? ' ' + u : ''}`; };
  const rows = [['Input', 'Path', 'Change', 'Case', 'Input value'].concat(ms.map((m) => M[m][0] + unit[m]))];
  rows.push(['Base', '', '', 'base', ''].concat(ms.map((m) => get(TORNADO.base, m))));
  S.rows.forEach((x) => ['low', 'high'].forEach((k, i) => rows.push([x.label, x.path, chg(x, i), k, x.vals[i]]
    .concat(x.err ? [x.err] : ms.map((m) => get(x.res[i], m))))));
  rows.push([], ['Order', 'largest swing of ' + S.name + ' first'], ['Basis', S.fast ? 'year 1 repeated over the project life' : 'every project year'],
    ['Battery prices move together', S.together ? 'yes' : 'no']);
  if (S.stale) rows.push(['Note', 'The inputs changed after this tornado; run it again.']);
  return rows;
}

function financeSheet({ SIM, h }) {
  const R = SIM.finance, rows = [['Item'].concat(R.years.map((y) => 'Year ' + y.year))];
  h.finRows(R.model === 'host', rowOpts(R)).filter((r) => r[0] !== 'g').forEach(([k, label]) => rows.push([label].concat(R.years.map((y) => y[k]))));
  rows.push([]);
  Object.entries(R.metrics).forEach(([k, v]) => rows.push([k, v]));
  if (R.fx_sensitivity) {
    const flip = R.model === 'flip';
    rows.push([], ['Exchange rate sensitivity (' + R.fx_currency + ')', 'Rate change', 'Rate, year 1', 'Equity IRR', ...(flip ? ['Sponsor IRR', 'Investor IRR'] : []), 'Project IRR', 'Minimum DSCR', 'Equity NPV']);
    R.fx_sensitivity.forEach((s) => rows.push(['', s.shock, s.fx_rate_y1, s.equity_irr, ...(flip ? [s.sponsor_irr, s.te_irr] : []), s.project_irr, s.dscr_min, s.equity_npv]));
  }
  return rows;
}

const periodSheet = (R) => [PERIOD_COLS.map((c) => c[1])].concat(R.periods.map((p) => PERIOD_COLS.map(([k]) => p[k])));

function forecastSheet(B) {
  const rows = [['Variable', 'Method', 'nMAE 1h', 'nMAE 6h', 'nMAE 24h', 'nRMSE 24h', 'Skill 24h', 'Bias 24h']];
  for (const v of ['pv', 'load']) B[v].methods.forEach((m) => rows.push([v, m.name, m.nmae[0], m.nmae[5], m.nmae[23], m.nrmse[23], m.skill[23], m.bias[23]]));
  if (B.value) { rows.push([]); rows.push(['EMS value', 'Method', 'Fuel L', 'Genset hours', 'NPC']); B.value.forEach((v) => rows.push([v.kind, v.name, v.fuel_l, v.unit_hours, v.npc])); }
  return rows;
}

export function sheetsB(D) {
  const { SIM, OPT, OPTIONS, TORNADO, forecast, h } = D, sheets = [];
  if (SIM) sheets.push({ name: 'Energy monthly', rows: energySheet(D) });
  const K = h.calibration();
  if (K) sheets.push({ name: 'Baseline check', rows: baselineSheet(K) });
  if (SIM) sheets.push(...seriesSheets(D));
  if (SIM && SIM.result.fleet) sheets.push({ name: 'Genset groups', rows: groupsSheet(D) });
  if (OPTIONS) sheets.push({ name: 'Options', rows: optionsSheet(D) });
  if (TORNADO) sheets.push({ name: 'Tornado', rows: tornadoSheet(D) });
  if (SIM && SIM.finance) sheets.push({ name: 'Finance', rows: financeSheet(D) });
  if (SIM && SIM.finance && SIM.finance.periods) sheets.push({ name: 'Debt periods', rows: periodSheet(SIM.finance) });
  if (OPT) {
    const cols = ['pv_kwp', 'bess_kwh', 'bess_kw', 'capex', 'npc', 'lcoe', 're', 'fuel', 'curtail', 'unmet', 'lole_h', 'res_short_h', 'irr', 'payback'];
    sheets.push({ name: 'Optimisation', rows: [cols].concat(OPT.ranked.map((r) => cols.map((k) => r[k]))) });
  }
  if (forecast) sheets.push({ name: 'Forecast', rows: forecastSheet(forecast) });
  return sheets;
}
