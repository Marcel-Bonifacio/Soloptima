// What the simulation screens show, as plain data (no DOM): the KPI tiles, the comparison table and the chart traces.
import { fmtNum, fmtPct, fmtEnergy, fmtMoney } from './format.js';
import { weekStart, MONTHS, monthlySum, dateOfHour } from './series.js';

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

// S: the simulation response, prev: the figures kept from the run before it, cur: currency, O: the last optimisation
export function headlineTiles(S, prev, cur, O) {
  const R = S.result, B = S.baseline, C = S.comparison, y1 = R.years[0], b1 = B.years[0];
  const PR = prev && prev.result, PC = prev && prev.comparison, CB = S.comparison_bess, PCB = prev && prev.comparison_bess;
  const pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only', pb = pvOnlyBest(S, O), aux1 = y1.aux || 0;
  const other = O && O.all_years !== S.all_years ? (O.all_years ? 'every project year' : 'year 1 only') : 'other inputs';
  return [
    ['Renewable fraction', fmtPct(R.re_fraction), 'year 1', true, PR && delta(R.re_fraction * 100, PR.re_fraction * 100, pp, 1)],
    ['Fuel saved', fmtNum(C.fuel_saved_l_y1 / 1000, 0) + ' kL', fmtPct(C.fuel_saved_l_y1 / B.fuel_l_y1) + ' vs diesel-only', true,
      PC && delta(C.fuel_saved_l_y1 / 1000, PC.fuel_saved_l_y1 / 1000, (x) => fmtNum(x) + ' kL', 1)],
    ['LCOE', `${cur} ${fmtNum(R.econ.lcoe, 4)}`, `diesel-only ${fmtNum(C.lcoe_base, 4)} /kWh`, true, PR && delta(R.econ.lcoe, PR.econ.lcoe, (x) => fmtNum(x, 4), -1)],
    ['NPV of savings', fmtMoney(C.npv_savings, cur), 'hybrid vs diesel-only', false, PC && delta(C.npv_savings, PC.npv_savings, (x) => fmtMoney(x, cur), 1)],
    ['IRR', C.irr == null ? '–' : fmtPct(C.irr), 'on incremental investment', false, PC && PC.irr != null && C.irr != null ? delta(C.irr * 100, PC.irr * 100, pp, 1) : ''],
    ['Payback', C.payback_years == null ? '> life' : fmtNum(C.payback_years, 1) + ' yr', 'simple, nominal'],
    ...(CB ? [['Battery adds', fmtMoney(CB.npv_savings, cur),
      `NPV vs ${pvLbl} · IRR ${CB.irr == null ? '–' : fmtPct(CB.irr)} · fuel ${CB.fuel_saved_l_y1 >= 0 ? '−' : '+'}${fmtNum(Math.abs(CB.fuel_saved_l_y1) / 1000, 0)} kL/yr`,
      CB.npv_savings < 0 ? 'bad' : false, PCB && delta(CB.npv_savings, PCB.npv_savings, (x) => fmtMoney(x, cur), 1)]] : []),
    ...(pb ? [['Best PV-only design', fmtNum(pb.best.pv_kwp) + ' kWp', pb.gap == null
      ? `NPC ${fmtMoney(pb.best.npc, cur)} from the last optimisation (${other}), not comparable with this run`
      : `NPC ${fmtMoney(pb.best.npc, cur)} from the last optimisation; hybrid ${fmtMoney(Math.abs(pb.gap), cur)} ${pb.gap >= 0 ? 'lower' : 'higher'}`, pb.gap != null && pb.gap < 0 ? 'bad' : false]] : []),
    ['Capex (excl. gensets)', fmtMoney(R.econ.capex_pv + R.econ.capex_bess + R.econ.capex_wind + R.econ.capex_other, cur), ''],
    ['CO₂ avoided', fmtNum(C.co2_saved_t_y1, 0) + ' t/yr', ''],
    ['PV curtailed', fmtPct(R.curtail_fraction), fmtEnergy(y1.pv_curtailed)],
    ['Unmet load', fmtPct(R.unmet_fraction, 3), fmtEnergy(y1.unmet)],
    ['Genset run-hours', fmtNum(y1.unit_hours, 0), `${fmtNum(b1.unit_hours - y1.unit_hours, 0)} fewer · ${fmtNum(y1.starts)} starts`],
    ['Battery cycles', fmtNum(y1.bess_efc, 0) + ' /yr', `${R.bess_replacements} replacement(s)`],
    ['Auxiliary consumption', fmtNum(aux1 / 1000, 1) + ' MWh/yr', aux1 > 0 ? fmtPct(aux1 / (y1.load - aux1), 2) + ' of site load' : 'none set (Battery tab)'],
  ];
}

export function indicatorTiles(S, P, cur) {
  const R = S.result, B = S.baseline, y1 = R.years[0], b1 = B.years[0], M = R.metrics || {};
  const worst = R.years.reduce((a, y) => (y.lol_h > a.lol_h ? y : a), y1);
  return [
    ['Loss-of-load hours', fmtNum(y1.lol_h) + ' h', `${fmtNum(y1.lol_events)} events, longest ${fmtNum(y1.lol_max_h)} h${worst.lol_h > y1.lol_h ? ` · ${fmtNum(worst.lol_h)} h in year ${worst.year}` : ''}`, y1.lol_h > 0 ? 'bad' : false],
    ['Reserve shortfall', fmtNum(y1.reserve_short_h) + ' h', `max ${fmtNum(y1.reserve_short_max_kw)} kW · diesel-only ${fmtNum(b1.reserve_short_h)} h, max ${fmtNum(b1.reserve_short_max_kw)} kW`, y1.reserve_short_h > 0 ? 'bad' : false],
    ['Gensets needed', `${fmtNum(y1.max_units)} of ${fmtNum(P.diesel.units)}`, `diesel-only ${fmtNum(b1.max_units)} · whole fleet online ${fmtNum(y1.fleet_full_h)} h`],
    ['Low-load running', fmtNum(y1.minload_h) + ' h', `every online unit at minimum · longest run ${fmtNum(y1.minload_run_max_h)} h`],
    ['LPSP', fmtPct(M.lpsp, 3), 'loss of power supply'], ['REP (reliability)', fmtNum(M.rep, 2) + ' %', '100 (1 − LPSP)'],
    ['SSSI', fmtPct(M.sssi), 'direct RE use / load'], ['SSCI', fmtPct(M.ssci), 'direct RE use / RE available'],
    ['Excess energy', fmtEnergy(M.excess_kwh), fmtPct(M.excess_fraction) + ' of load'],
    ['CO₂ / NOx / SOx', `${fmtNum(M.co2_t)} t`, `${fmtNum(M.nox_kg)} kg NOx · ${fmtNum(M.sox_kg)} kg SOx`],
    ['Jobs created', fmtNum(M.jobs, 1), 'job-years (factor method)'],
    ['HDI', M.hdi == null ? '–' : M.hdi.toFixed(3), M.hdi == null ? 'set population in Costs' : 'from per-capita electricity'],
    ['TAC', fmtMoney(R.econ.tac, cur) + '/yr', `CRF ${fmtNum(R.econ.crf, 4)}`], ['COE', `${cur} ${fmtNum(R.econ.coe, 4)}/kWh`, 'TAC / energy served to the site (yr 1)'],
  ];
}

// Hybrid against diesel only (and PV only with a battery): title, column heads and rows of numbers
export function compareTable(S, cur) {
  const R = S.result, B = S.baseline, V = S.pv_only, y1 = R.years[0], b1 = B.years[0], v1 = V ? V.years[0] : {}, VA = V || { econ: {} };
  const pvLbl = R.size.wind_units > 0 ? 'PV + wind only' : 'PV only';
  const row = (label, a, v, b, d = 0) => ({ label, d, cells: V ? [a, v, b, b - v] : [a, b, b - a] });
  return {
    title: V ? `Hybrid vs diesel only and ${pvLbl}` : 'Hybrid vs diesel-only',
    heads: ['', 'Diesel only', ...(V ? [pvLbl] : []), 'Hybrid', V ? 'Battery adds' : 'Change'], four: !!V,
    rows: [
      row('Fuel (L/yr)', b1.fuel_l, v1.fuel_l, y1.fuel_l), row('Diesel energy (MWh/yr)', b1.gen_kwh / 1000, v1.gen_kwh / 1000, y1.gen_kwh / 1000),
      row('Genset run-hours', b1.unit_hours, v1.unit_hours, y1.unit_hours), row('Genset starts', b1.starts, v1.starts, y1.starts),
      row('Avg genset loading (%)', B.avg_gen_load * 100, VA.avg_gen_load * 100, R.avg_gen_load * 100, 1), row('CO₂ (t/yr)', b1.co2_t, v1.co2_t, y1.co2_t),
      row(`Fuel cost yr 1 (${cur})`, b1.c_fuel, v1.c_fuel, y1.c_fuel), row(`Capex (${cur})`, B.econ.capex_total, VA.econ.capex_total, R.econ.capex_total),
      row(`Net present cost (${cur})`, B.econ.npc, VA.econ.npc, R.econ.npc), row(`LCOE (${cur}/kWh)`, B.econ.lcoe, VA.econ.lcoe, R.econ.lcoe, 4),
    ],
  };
}

// Monthly table: headers and rows (kWh) for the 12 months and the year
export const monthHeads = (wind) => ['', 'Load MWh', 'PV direct', ...(wind ? ['Wind direct'] : []), 'Battery → load', 'Diesel → load', 'Unmet', 'RE curtailed', 'Genset dump', 'Fuel kL', 'RE fraction'];

export const yearHeads = (cur) => ['Year', 'Load MWh', 'PV used MWh', 'Curtailed MWh', 'BESS out MWh', 'Diesel MWh', 'Fuel kL', 'RE %', 'Unmet MWh', 'LOL h', 'Reserve short h', 'Unit-h', 'SOH %', 'EFC', 'Repl.', 'Cost ' + cur];
export const yearCells = (y) => [y.year, fmtNum(y.load / 1000), fmtNum((y.pv_to_load + y.pv_to_bess) / 1000), fmtNum(y.pv_curtailed / 1000), fmtNum(y.bess_dis / 1000),
  fmtNum(y.gen_kwh / 1000), fmtNum(y.fuel_l / 1000), fmtNum(y.re_fraction * 100, 1), fmtNum(y.unmet / 1000, 1), fmtNum(y.lol_h), fmtNum(y.reserve_short_h),
  fmtNum(y.unit_hours), fmtNum(y.bess_soh * 100, 1), fmtNum(y.bess_efc), y.bess_replaced ? '●' : '', fmtNum(y.c_total)];

// ---- chart definitions: (data, colours) -> {traces, layout}
export function mixChart(S, c) {
  const y1 = S.result.years[0], wind = y1.wind_avail > 0, aux = y1.aux || 0;
  const names = ['PV → load', ...(wind ? ['Wind used'] : []), 'Battery → load', 'Diesel → load', ...(aux > 0 ? ['Auxiliaries (own use)'] : []), 'RE curtailed', 'Unmet'];
  const vals = [y1.pv_to_load, ...(wind ? [y1.wind_used] : []), y1.bess_dis, y1.gen_to_load, ...(aux > 0 ? [aux] : []), y1.pv_curtailed + (y1.wind_curtailed || 0), y1.unmet].map((x) => x / 1000);
  const cols = [c.pv, ...(wind ? [c.wind] : []), c.bess, c.gen, ...(aux > 0 ? [c.load] : []), c.curt, c.unmet];
  return {
    traces: [{ type: 'bar', orientation: 'h', y: names.slice().reverse(), x: vals.slice().reverse(), marker: { color: cols.reverse(), cornerradius: 4 },
      text: vals.slice().reverse().map((v) => fmtEnergy(v * 1000)), textposition: 'auto', textfont: { color: c.text }, hovertemplate: '%{y}: %{x:,.0f} MWh<extra></extra>' }],
    layout: { xaxis: { title: { text: 'MWh (year 1)' } }, showlegend: false, margin: { l: 10, r: 10, t: 10, b: 40 } },
  };
}

export function monthlyChart(S, c) {
  const H = S.result.hourly, y1 = S.result.years[0], wind = y1.wind_avail > 0, ms = (a) => monthlySum(a).map((x) => x / 1000);
  const bar = (name, y, color) => ({ type: 'bar', name, x: MONTHS, y, marker: { color }, hovertemplate: '%{x}: %{y:,.0f} MWh<extra>' + name + '</extra>' });
  const traces = [bar('PV → load', ms(H.pv_to_load), c.pv), ...(wind ? [bar('Wind → load', ms(H.wind_to_load), c.wind)] : []),
    bar('Battery → load', ms(H.bess_dis), c.bess), bar('Diesel → load', ms(H.gen_to_load), c.gen), bar('Unmet', ms(H.unmet), c.unmet),
    bar('RE curtailed', ms(wind ? H.pv_curtailed.map((v, i) => v + H.wind_curtailed[i]) : H.pv_curtailed), c.curt)];
  if ((y1.aux || 0) > 0 && H.aux) {
    // part of the supply above, drawn below zero so it is not counted twice
    traces.push({ type: 'bar', name: 'Auxiliaries (own use)', x: MONTHS, y: ms(H.aux).map((v) => -v), customdata: ms(H.aux), marker: { color: c.load },
      hovertemplate: '%{x}: %{customdata:,.1f} MWh<extra>Auxiliaries (own use)</extra>' });
  }
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
  const wind = H.wind_avail && H.wind_avail.some((v) => v > 0), aux = H.aux && H.aux.some((a) => a > 0);
  const traces = [
    area('PV → load', pick(H.pv_to_load), c.pv, 'sup'),
    ...(wind ? [area('Wind → load', pick(H.wind_to_load), c.wind, 'sup'), area('Wind → battery', pick(H.wind_to_bess, -1), c.wind + '99', 'chg')] : []),
    area('Battery → load', pick(H.bess_dis), c.bess, 'sup'), area('Diesel → load', pick(H.gen_to_load), c.gen, 'sup'), area('Unmet', pick(H.unmet), c.unmet, 'sup'),
    area('PV → battery', pick(H.pv_to_bess, -1), c.pv + '99', 'chg'), area('Diesel → battery', pick(H.gen_to_bess, -1), c.gen + '99', 'chg'),
    line('Load', pick(H.load), { line: { color: c.load, width: 2, shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Load</extra>' }),
    ...(aux ? [line('Site load', x.map((h) => H.load[h] - H.aux[h]), { line: { color: c.load, width: 1.5, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>Site load</extra>' })] : []),
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
