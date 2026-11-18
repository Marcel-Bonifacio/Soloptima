// What the simulation screens show, as plain data (no DOM): the KPI tiles, the comparison table and the chart traces.
import { fmtNum, fmtPct, fmtEnergy, fmtMoney } from './format.js';
import { weekStart, MONTHS, monthlySum, dateOfHour } from './series.js';
import { fleetUnits } from './fleet-view.js';

// Change against the previous run as a short "▲ +1.2 pp vs last run"; better: +1 if higher is better, -1 if lower is better.
export function delta(cur, prev, fmt, better) {
  if (prev == null || cur == null || !isFinite(cur) || !isFinite(prev)) return '';
  const d = cur - prev;
  if (Math.abs(d) < 1e-9 * Math.max(1, Math.abs(prev))) return '= same as last run';
  return `${d * better > 0 ? '▲' : '▼'} ${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} vs last run`;
}
const pp = (x) => x.toFixed(1) + ' pp';

// The best PV-only design of the last optimisation, when it can be compared with this run
function pvOnlyBest(S, O) {
  if (!S.comparison_bess || !O || !O.ranked) return null;
  const best = O.ranked.filter((r) => r.bess_kwh < 1e-6).reduce((a, r) => (!a || r.npc < a.npc ? r : a), null);
  if (!best) return null;
  const comparable = O.all_years === S.all_years && O.sizing_key === S.sizing_key;
  return { best, gap: comparable ? best.npc - S.result.econ.npc : null };
}

// A year figure summed over the project years (0 where the result does not have it)
export const total = (R, k) => ((R && R.years) || []).reduce((a, y) => a + (y[k] || 0), 0);
// Genset overhaul and replacement cost over the project, nominal at today's prices
export const wearCost = (R) => total(R, 'c_gen_overhaul') + total(R, 'c_gen_replace');

// S: the simulation response, prev: the figures kept from the run before it, cur: currency, O: the last optimisation
export function headlineTiles(S, prev, cur, O) {
  const R = S.result, B = S.baseline, C = S.comparison, y1 = R.years[0], b1 = B.years[0];
  const PR = prev && prev.result, PC = prev && prev.comparison, CB = S.comparison_bess, PCB = prev && prev.comparison_bess;
  const pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only', pb = pvOnlyBest(S, O), aux1 = y1.aux || 0;
  const other = O && O.all_years !== S.all_years ? (O.all_years ? 'every project year' : 'year 1 only') : 'other inputs';
  const ref = R.has_grid ? 'grid + diesel' : 'diesel-only';
  return [
    ['Renewable fraction', fmtPct(R.re_fraction), 'year 1', true, PR && delta(R.re_fraction * 100, PR.re_fraction * 100, pp, 1)],
    ['Fuel saved', fmtNum(C.fuel_saved_l_y1 / 1000, 0) + ' kL', fmtPct(C.fuel_saved_l_y1 / B.fuel_l_y1) + ' vs ' + ref, true,
      PC && delta(C.fuel_saved_l_y1 / 1000, PC.fuel_saved_l_y1 / 1000, (x) => fmtNum(x) + ' kL', 1)],
    ['LCOE', `${cur} ${fmtNum(R.econ.lcoe, 4)}`, `${ref} ${fmtNum(C.lcoe_base, 4)} /kWh`, true, PR && delta(R.econ.lcoe, PR.econ.lcoe, (x) => fmtNum(x, 4), -1)],
    ['NPV of savings', fmtMoney(C.npv_savings, cur), 'hybrid vs ' + ref, false, PC && delta(C.npv_savings, PC.npv_savings, (x) => fmtMoney(x, cur), 1)],
    ['IRR', C.irr == null ? '–' : fmtPct(C.irr), 'on incremental investment', false, PC && PC.irr != null && C.irr != null ? delta(C.irr * 100, PC.irr * 100, pp, 1) : ''],
    ['Payback', C.payback_years == null ? '> life' : fmtNum(C.payback_years, 1) + ' yr', 'simple, nominal'],
    ...(CB ? [['Battery adds', fmtMoney(CB.npv_savings, cur),
      `NPV vs ${pvLbl} · IRR ${CB.irr == null ? '–' : fmtPct(CB.irr)} · fuel ${CB.fuel_saved_l_y1 >= 0 ? '−' : '+'}${fmtNum(Math.abs(CB.fuel_saved_l_y1) / 1000, 0)} kL/yr`,
      CB.npv_savings < 0 ? 'bad' : false, PCB && delta(CB.npv_savings, PCB.npv_savings, (x) => fmtMoney(x, cur), 1)]] : []),
    ...(pb ? [['Best PV-only design', fmtNum(pb.best.pv_kwp) + ' kWp', pb.gap == null
      ? `NPC ${fmtMoney(pb.best.npc, cur)} from the last optimisation (${other}), not comparable with this run`
      : `NPC ${fmtMoney(pb.best.npc, cur)} from the last optimisation; hybrid ${fmtMoney(Math.abs(pb.gap), cur)} ${pb.gap >= 0 ? 'lower' : 'higher'}`, pb.gap != null && pb.gap < 0 ? 'bad' : false]] : []),
    ['Capex (excl. gensets)', fmtMoney(R.econ.capex_pv + R.econ.capex_bess + R.econ.capex_wind + R.econ.capex_other, cur), ''],
    ...(S.grid_extension ? [['Grid extension break-even', fmtNum(S.grid_extension.break_even_km, 1) + ' km',
      S.grid_extension.break_even_km > 0 ? 'a longer line costs more than this plant' : 'the grid costs more even at 0 km']] : []),
    ['CO₂ avoided', fmtNum(C.co2_saved_t_y1, 0) + ' t/yr', ''],
    ['PV curtailed', fmtPct(R.curtail_fraction), fmtEnergy(y1.pv_curtailed) + (S.deferrable_ref ? ` · ${fmtPct(S.deferrable_ref.curtail_fraction)} without the deferrable load` : '')
      + (S.re_ramp_ref ? ` · ${fmtPct(S.re_ramp_ref.curtail_fraction)} without the ramp limit` : '')],
    ...(y1.dl_kwh != null ? [['Deferrable load', fmtEnergy(y1.dl_kwh), `${fmtPct(y1.dl_kwh > 0 ? y1.dl_re / y1.dl_kwh : 0)} from PV and wind · ${fmtEnergy(y1.dl_kwh - y1.dl_re)} from the battery, gensets${R.has_grid ? ' or grid' : ''}`]] : []),
    ['Unmet load', fmtPct(R.unmet_fraction, 3), fmtEnergy(y1.unmet)],
    ['Genset run-hours', fmtNum(y1.unit_hours, 0), `${fmtNum(b1.unit_hours - y1.unit_hours, 0)} fewer · ${fmtNum(y1.starts)} starts${y1.gen_replacements != null
      ? ` · ${fmtNum(total(R, 'gen_replacements'))} replacements over the project (${ref} ${fmtNum(total(B, 'gen_replacements'))})` : ''}`],
    ['Battery cycles', fmtNum(y1.bess_efc, 0) + ' /yr', `${R.bess_replacements} replacement(s)`],
    ['Auxiliary consumption', fmtNum(aux1 / 1000, 1) + ' MWh/yr', aux1 > 0 ? fmtPct(aux1 / (y1.load - aux1 - (y1.dl_kwh || 0)), 2) + ' of site load' : 'none set (Battery tab)'],
  ];
}

export function indicatorTiles(S, P, cur) {
  const R = S.result, B = S.baseline, y1 = R.years[0], b1 = B.years[0], M = R.metrics || {};
  const worst = R.years.reduce((a, y) => (y.lol_h > a.lol_h ? y : a), y1);
  return [
    ['Loss-of-load hours', fmtNum(y1.lol_h) + ' h', `${fmtNum(y1.lol_events)} events, longest ${fmtNum(y1.lol_max_h)} h${worst.lol_h > y1.lol_h ? ` · ${fmtNum(worst.lol_h)} h in year ${worst.year}` : ''}`, y1.lol_h > 0 ? 'bad' : false],
    ...(y1.unmet_crit != null ? [['Unserved critical load', fmtEnergy(y1.unmet_crit), `${fmtPct(R.unmet_crit_fraction, 3)} of the critical load · ${fmtNum(y1.lol_crit_h)} h with any`, y1.lol_crit_h > 0 ? 'bad' : false],
      ['Unserved non-critical load', fmtEnergy(y1.unmet_nc), `${fmtNum(y1.lol_nc_h)} h with any${y1.nc_shed != null ? ` · ${fmtEnergy(y1.nc_shed)} shed while the grid was down` : ''}`]] : []),
    ...(y1.dl_unmet != null ? [['Unserved deferrable energy', fmtEnergy(y1.dl_unmet), `${fmtPct(R.dl_unmet_fraction, 3)} of its demand · worst year ${fmtPct(R.dl_unmet_fraction_max, 3)}`, y1.dl_unmet > 0 ? 'bad' : false]] : []),
    ['Reserve shortfall', fmtNum(y1.reserve_short_h) + ' h', `max ${fmtNum(y1.reserve_short_max_kw)} kW · diesel-only ${fmtNum(b1.reserve_short_h)} h, max ${fmtNum(b1.reserve_short_max_kw)} kW`, y1.reserve_short_h > 0 ? 'bad' : false],
    ['Gensets needed', `${fmtNum(y1.max_units)} of ${fmtNum(fleetUnits(P.diesel))}`, `diesel-only ${fmtNum(b1.max_units)} · whole fleet online ${fmtNum(y1.fleet_full_h)} h`],
    ['Low-load running', fmtNum(y1.minload_h) + ' h', `every online unit at minimum · longest run ${fmtNum(y1.minload_run_max_h)} h`],
    ...reliabilityTiles(R.summary && R.summary.reliability),
    ...(y1.n1_short_h != null ? [['N-1 shortfall', fmtNum(y1.n1_short_h, 1) + ' h', `largest unit lost, max gap ${fmtNum(y1.n1_short_max_kw)} kW · diesel-only ${fmtNum(b1.n1_short_h, 1)} h`, y1.n1_short_h > 0 ? 'bad' : false]] : []),
    ...(y1.unit_outages != null ? [['Forced outages', fmtNum(y1.unit_outages), `${fmtNum(y1.unit_outage_h)} unit-hours out of service`]] : []),
    ...(y1.inverter_outages != null ? [['Inverter block outages', fmtNum(y1.inverter_outages), `${fmtNum(y1.inverter_outage_h)} block-hours out, ${fmtNum(y1.inverter_outage_kwh / 1000)} MWh of PV lost`]] : []),
    ...(y1.pcs_outages != null ? [['Battery PCS outages', fmtNum(y1.pcs_outages), `${fmtNum(y1.pcs_outage_h)} unit-hours out of service`]] : []),
    ...(y1.min_down_override != null ? [['Early restarts', fmtNum(y1.min_down_override), 'units started within the minimum down time, for the load']] : []),
    ...(y1.ramp_limited_h != null ? [['Ramp or start limited', fmtNum(y1.ramp_limited_h, 1) + ' h', 'genset output held below what was asked']] : []),
    ...(y1.re_ramp_viol != null ? [['PV and wind ramp violations', fmtNum(y1.re_ramp_viol) + ' steps', `${fmtEnergy(y1.re_ramp_viol_kwh)} the battery could not make up · `
      + `battery ${fmtEnergy(y1.re_ramp_bess_ch + y1.re_ramp_bess_dis)} and ${fmtEnergy(y1.re_ramp_curtailed)} curtailed for the limit${S.re_ramp_ref
        ? ` · throughput ${fmtEnergy(y1.bess_ch + y1.bess_dis)}, ${fmtEnergy(S.re_ramp_ref.bess_ch + S.re_ramp_ref.bess_dis)} without it` : ''}`, y1.re_ramp_viol > 0 ? 'bad' : false]] : []),
    ['LPSP', fmtPct(M.lpsp, 3), 'loss of power supply'], ['REP (reliability)', fmtNum(M.rep, 2) + ' %', '100 (1 − LPSP)'],
    ['SSSI', fmtPct(M.sssi), 'direct RE use / load'], ['SSCI', fmtPct(M.ssci), 'direct RE use / RE available'],
    ['Excess energy', fmtEnergy(M.excess_kwh), fmtPct(M.excess_fraction) + ' of load'],
    M.pm25_kg != null ? ['CO₂ / NOx / SOx / PM2.5 / CO', `${fmtNum(M.co2_t)} t`, `${fmtNum(M.nox_kg)} kg NOx · ${fmtNum(M.sox_kg)} kg SOx · ${fmtNum(M.pm25_kg)} kg PM2.5 · ${fmtNum(M.co_kg)} kg CO`]
      : ['CO₂ / NOx / SOx', `${fmtNum(M.co2_t)} t`, `${fmtNum(M.nox_kg)} kg NOx · ${fmtNum(M.sox_kg)} kg SOx`],
    ...(y1.co2_pv_t != null ? [['Embodied CO₂ of PV', `${fmtNum(y1.co2_pv_t, 1)} t/yr`, 'part of the CO₂ above']] : []),
    ['Jobs created', fmtNum(M.jobs, 1), 'job-years (factor method)'],
    ['HDI', M.hdi == null ? '–' : M.hdi.toFixed(3), M.hdi == null ? 'set population in Costs' : 'from per-capita electricity'],
    ['TAC', fmtMoney(R.econ.tac, cur) + '/yr', `CRF ${fmtNum(R.econ.crf, 4)}`], ['COE', `${cur} ${fmtNum(R.econ.coe, 4)}/kWh`, 'TAC / energy served to the site (yr 1)'],
  ];
}

// The longest run of low-PV days in the weather year and of hours with unserved load in year 1 (summary.rs)
export function reliabilityTiles(Q) {
  if (!Q) return [];
  return [
    ['Longest low-PV spell', Q.low_pv_run_d == null ? '–' : fmtNum(Q.low_pv_run_d) + ' days', Q.low_pv_run_d == null ? 'no PV yield'
      : `${Q.low_pv_run_d ? 'from ' + dateOfHour(Q.low_pv_run_start * 24) + ' · ' : ''}${fmtNum(Q.low_pv_days)} days below ${fmtPct(Q.low_pv_frac, 0)} of the mean daily PV`],
    ['Longest unserved run', fmtNum(Q.unmet_run_h) + ' h', Q.unmet_run_h ? 'year 1, from ' + dateOfHour(Q.unmet_run_start) + ` ${String(Q.unmet_run_start % 24).padStart(2, '0')}:00` : 'year 1, no hour with unserved load', Q.unmet_run_h > 0 ? 'bad' : false],
  ];
}

// Hybrid against diesel only (and PV only with a battery): title, column heads and rows of numbers
export function compareTable(S, cur) {
  const R = S.result, B = S.baseline, V = S.pv_only, y1 = R.years[0], b1 = B.years[0], v1 = V ? V.years[0] : {}, VA = V || { econ: {} };
  const pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
  const row = (label, a, v, b, d = 0) => ({ label, d, cells: V ? [a, v, b, b - v] : [a, b, b - a] });
  // a year 1 figure over `div`; blank in the cases without it is 0
  const rowK = (label, k, div = 1, d = 0) => row(label, (b1[k] || 0) / div, (v1[k] || 0) / div, y1[k] / div, d);
  return {
    title: V ? `Hybrid vs ${R.has_grid ? 'grid + diesel' : 'diesel only'} and ${pvLbl}` : `Hybrid vs ${R.has_grid ? 'grid + diesel' : 'diesel-only'}`,
    heads: ['', R.has_grid ? 'Grid + diesel' : 'Diesel only', ...(V ? [pvLbl] : []), 'Hybrid', V ? 'Battery adds' : 'Change'], four: !!V,
    rows: [
      rowK('Fuel (L/yr)', 'fuel_l'), rowK('Diesel energy (MWh/yr)', 'gen_kwh', 1000), rowK('Genset run-hours', 'unit_hours'), rowK('Genset starts', 'starts'),
      ...(y1.c_starts != null ? [rowK(`Start cost yr 1 (${cur})`, 'c_starts')] : []),
      ...(y1.gen_overhauls != null ? [row('Genset overhauls (project)', total(B, 'gen_overhauls'), total(VA, 'gen_overhauls'), total(R, 'gen_overhauls')),
        row('Genset replacements (project)', total(B, 'gen_replacements'), total(VA, 'gen_replacements'), total(R, 'gen_replacements')),
        row(`Overhaul + replacement cost, project (${cur})`, wearCost(B), wearCost(VA), wearCost(R))] : []),
      row('Avg genset loading (%)', B.avg_gen_load * 100, VA.avg_gen_load * 100, R.avg_gen_load * 100, 1), rowK('CO₂ (t/yr)', 'co2_t'),
      ...(y1.c_pollutants != null ? [rowK(`Pollutant cost yr 1 (${cur})`, 'c_pollutants')] : []),
      rowK(`Fuel cost yr 1 (${cur})`, 'c_fuel'), row(`Capex (${cur})`, B.econ.capex_total, VA.econ.capex_total, R.econ.capex_total),
      ...(R.has_grid ? [rowK('Grid import (MWh/yr)', 'grid_import', 1000), rowK('Grid export (MWh/yr)', 'grid_export', 1000), rowK(`Net grid cost yr 1 (${cur})`, 'c_grid')] : []),
      ...(y1.grid_to_bess != null ? [rowK('Grid → battery (MWh/yr)', 'grid_to_bess', 1000)] : []),
      ...(y1.fr_held_h != null ? [rowK('Frequency reserve held (h/yr)', 'fr_held_h'), rowK('Reserve: PV and wind not stored (MWh/yr)', 'fr_spill', 1000),
        rowK('Reserve: load not served by the battery (MWh/yr)', 'fr_shift', 1000), rowK(`Reserve revenue yr 1 (${cur})`, 'c_fr')] : []),
      row(`Net present cost (${cur})`, B.econ.npc, VA.econ.npc, R.econ.npc), row(`LCOE (${cur}/kWh)`, B.econ.lcoe, VA.econ.lcoe, R.econ.lcoe, 4),
    ],
  };
}

// Monthly table: headers and rows (kWh) for the 12 months and the year
export const monthHeads = (wind, grid) => ['', 'Load MWh', 'PV direct', ...(wind ? ['Wind direct'] : []), 'Battery → load', 'Diesel → load', ...(grid ? ['Grid → load'] : []),
  'Unmet', 'RE curtailed', ...(grid ? ['Exported'] : []), 'Genset dump', 'Fuel kL', 'RE fraction'];

// with genset wear, the units overhauled and replaced each year follow the unit-hours
export const yearHeads = (cur, grid, wear) => ['Year', 'Load MWh', 'PV used MWh', 'Curtailed MWh', 'BESS out MWh', 'Diesel MWh', ...(grid ? ['Grid in MWh', 'Grid out MWh'] : []),
  'Fuel kL', 'RE %', 'Unmet MWh', 'LOL h', 'Reserve short h', 'Unit-h', ...(wear ? ['Overhauls', 'Gensets repl.'] : []), 'SOH %', 'EFC', 'Repl.', 'Cost ' + cur];
export const yearCells = (y, grid) => [y.year, fmtNum(y.load / 1000), fmtNum((y.pv_to_load + y.pv_to_bess + (y.pv_to_grid || 0)) / 1000), fmtNum(y.pv_curtailed / 1000), fmtNum(y.bess_dis / 1000),
  fmtNum(y.gen_kwh / 1000), ...(grid ? [fmtNum(y.grid_import / 1000), fmtNum(y.grid_export / 1000)] : []), fmtNum(y.fuel_l / 1000), fmtNum(y.re_fraction * 100, 1),
  fmtNum(y.unmet / 1000, 1), fmtNum(y.lol_h), fmtNum(y.reserve_short_h), fmtNum(y.unit_hours), ...(y.gen_overhauls != null ? [fmtNum(y.gen_overhauls), fmtNum(y.gen_replacements)] : []),
  fmtNum(y.bess_soh * 100, 1), fmtNum(y.bess_efc), y.bess_replaced ? '●' : '', fmtNum(y.c_total)];

// ---- chart definitions: (data, colours) -> {traces, layout}
export function mixChart(S, c) {
  const y1 = S.result.years[0], wind = y1.wind_avail > 0, aux = y1.aux || 0, grid = !!S.result.has_grid, dl = y1.dl_kwh || 0;
  // [name, kWh, colour], reversed as the categories run bottom-up
  const bars = [['PV → load', y1.pv_to_load, c.pv], wind && ['Wind used', y1.wind_used, c.wind], ['Battery → load', y1.bess_dis, c.bess], ['Diesel → load', y1.gen_to_load, c.gen],
    grid && ['Grid → load', y1.grid_import, c.text2], grid && ['Exported', y1.grid_export, c.text2 + '99'], aux > 0 && ['Auxiliaries (own use)', aux, c.load],
    dl > 0 && ['Deferrable load', dl, c.load + '99'], ['RE curtailed', y1.pv_curtailed + (y1.wind_curtailed || 0), c.curt], ['Unmet', y1.unmet, c.unmet]].filter(Boolean).reverse();
  const vals = bars.map((b) => b[1] / 1000);
  return {
    traces: [{ type: 'bar', orientation: 'h', y: bars.map((b) => b[0]), x: vals, marker: { color: bars.map((b) => b[2]), cornerradius: 4 },
      text: vals.map((v) => fmtEnergy(v * 1000)), textposition: 'auto', textfont: { color: c.text }, hovertemplate: '%{y}: %{x:,.0f} MWh<extra></extra>' }],
    layout: { xaxis: { title: { text: 'MWh (year 1)' } }, showlegend: false, margin: { l: 10, r: 10, t: 10, b: 40 } },
  };
}

export function monthlyChart(S, c) {
  const H = S.result.hourly, y1 = S.result.years[0], wind = y1.wind_avail > 0, ms = (a) => monthlySum(a).map((x) => x / 1000);
  const bar = (name, y, color) => ({ type: 'bar', name, x: MONTHS, y, marker: { color }, hovertemplate: '%{x}: %{y:,.0f} MWh<extra>' + name + '</extra>' });
  const traces = [bar('PV → load', ms(H.pv_to_load), c.pv), ...(wind ? [bar('Wind → load', ms(H.wind_to_load), c.wind)] : []),
    bar('Battery → load', ms(H.bess_dis), c.bess), bar('Diesel → load', ms(H.gen_to_load), c.gen), ...(H.grid_import ? [bar('Grid → load', ms(H.grid_import), c.text2)] : []),
    bar('Unmet', ms(H.unmet), c.unmet),
    bar('RE curtailed', ms(wind ? H.pv_curtailed.map((v, i) => v + H.wind_curtailed[i]) : H.pv_curtailed), c.curt)];
  // parts of the supply above, drawn below zero so they are not counted twice
  const below = (name, a, color) => traces.push({ type: 'bar', name, x: MONTHS, y: ms(a).map((v) => -v), customdata: ms(a), marker: { color },
    hovertemplate: '%{x}: %{customdata:,.1f} MWh<extra>' + name + '</extra>' });
  if ((y1.aux || 0) > 0 && H.aux) below('Auxiliaries (own use)', H.aux, c.load);
  if (H.dl) below('Deferrable load', H.dl, c.load + '99');
  return { traces, layout: { barmode: 'relative', yaxis: { title: { text: 'MWh' } } } };
}

export function cashChart(S, cur, c) {
  const R = S.result, B = S.baseline, yrs = R.years.map((y) => y.year), cf = (k) => R.years.map((y) => -y[k]);
  const traces = [
    { type: 'bar', name: 'Capex', x: [0], y: [-R.econ.capex_total], marker: { color: c.text2 } },
    { type: 'bar', name: 'Fuel', x: yrs, y: cf('c_fuel'), marker: { color: c.gen } },
    { type: 'bar', name: 'O&M', x: yrs, y: cf('c_om'), marker: { color: c.bess } },
    { type: 'bar', name: 'Replacements', x: yrs, y: cf('c_replace'), marker: { color: c.soc } },
    { type: 'bar', name: 'Salvage', x: yrs, y: cf('c_salvage'), marker: { color: c.pv } },
    { type: 'scatter', mode: 'lines', name: 'Diesel-only fuel + O&M', x: B.years.map((y) => y.year), y: B.years.map((y) => -y.c_total), line: { color: c.unmet, dash: 'dot', width: 2 } },
  ].map((t) => ({ ...t, hovertemplate: 'year %{x}: %{y:,.0f} ' + cur + '<extra>' + t.name + '</extra>' }));
  return { traces, layout: { barmode: 'relative', yaxis: { title: { text: cur + ' (negative = cost)' } }, xaxis: { title: { text: 'Project year' } } } };
}

// Stacked supply above zero, battery charging below, the load as a line; SOC and gensets online in panels of their own.
export function dispatchChart(H, start, len, socTarget, c) {
  const x = Array.from({ length: len }, (_, i) => start + i), pick = (a, k = 1) => x.map((h) => (a ? k * a[h] : 0)), ticks = [], labels = [];
  for (let h = start; h < start + len; h += 24) { ticks.push(h); labels.push(dateOfHour(h)); }
  const area = (name, y, color, stack) => ({ type: 'scatter', mode: 'lines', name, x, y, stackgroup: stack, line: { width: 0.5, color, shape: 'hv' }, fillcolor: color, hovertemplate: '%{y:,.0f} kW<extra>' + name + '</extra>' });
  const line = (name, y, extra) => ({ type: 'scatter', mode: 'lines', name, x, y, ...extra });
  const wind = H.wind_avail && H.wind_avail.some((v) => v > 0), aux = H.aux && H.aux.some((a) => a > 0), dl = !!H.dl;
  const traces = [
    area('PV → load', pick(H.pv_to_load), c.pv, 'sup'),
    ...(wind ? [area('Wind → load', pick(H.wind_to_load), c.wind, 'sup'), area('Wind → battery', pick(H.wind_to_bess, -1), c.wind + '99', 'chg')] : []),
    area('Battery → load', pick(H.bess_dis), c.bess, 'sup'), area('Diesel → load', pick(H.gen_to_load), c.gen, 'sup'),
    ...(H.grid_import ? [area('Grid → load', pick(H.grid_import), c.text2, 'sup')] : []), area('Unmet', pick(H.unmet), c.unmet, 'sup'),
    area('PV → battery', pick(H.pv_to_bess, -1), c.pv + '99', 'chg'), area('Diesel → battery', pick(H.gen_to_bess, -1), c.gen + '99', 'chg'),
    ...(H.grid_to_bess ? [area('Grid → battery', pick(H.grid_to_bess, -1), c.text2 + 'cc', 'chg')] : []),
    ...(H.grid_export ? [area('Exported', pick(H.grid_export, -1), c.text2 + '99', 'chg')] : []),
    line('Load', pick(H.load), { line: { color: c.load, width: 2, shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Load</extra>' }),
    ...(aux || dl ? [line('Site load', x.map((h) => H.load[h] - H.aux[h] - (dl ? H.dl[h] : 0)), { line: { color: c.load, width: 1.5, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Site load</extra>' })] : []),
    ...(dl ? [line('Deferrable load', pick(H.dl), { line: { color: c.load, width: 1.5, dash: 'dash', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Deferrable load</extra>' })] : []),
    line('PV available', pick(H.pv_avail), { line: { color: c.pv, width: 1.5, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>PV available</extra>' }),
    line('Battery SOC', pick(H.soc, 100), { yaxis: 'y2', line: { color: c.soc, width: 2 }, hovertemplate: '%{y:.0f} %<extra>SOC</extra>' }),
    line('Gensets online', pick(H.gen_units), { yaxis: 'y3', line: { color: c.gen, width: 2, shape: 'hv' }, hovertemplate: '%{y} units<extra>Gensets online</extra>' }),
  ];
  if (socTarget && H.soc_target) traces.push(line('EMS SOC target', pick(H.soc_target, 100), { yaxis: 'y2', line: { color: c.soc, width: 1.5, dash: 'dash' }, hovertemplate: '%{y:.0f} %<extra>SOC target</extra>' }));
  return { traces, layout: {
    hovermode: 'x unified', showlegend: true, legend: { orientation: 'h', y: -0.08, x: 0, font: { size: 11, color: c.text2 } },
    xaxis: { tickvals: ticks, ticktext: labels, range: [start, start + len - 1], anchor: 'y3' },
    yaxis: { title: { text: 'Power (kW)' }, domain: [0.42, 1] }, yaxis2: { title: { text: 'SOC (%)' }, domain: [0.2, 0.37], range: [0, 100] },
    yaxis3: { title: { text: 'Units' }, domain: [0, 0.15], rangemode: 'tozero' }, margin: { l: 64, r: 16, t: 10, b: 60 } } };
}

export { weekStart };
