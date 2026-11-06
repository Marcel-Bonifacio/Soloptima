// What the optimisation screen shows, as plain data: the KPI tiles, warnings, the ranked table and the chart traces.
import { fmtNum, fmtPct, fmtMoney, fmtSig } from './format.js';

const BOUNDS = { pv_max: 'Optimum PV at the upper bound of the search range: raise "PV max".', bess_max: 'Optimum battery at the upper bound of the search range: raise "BESS max".',
  pv_min: 'Optimum PV at the lower bound of the search range: lower "PV min".', bess_min: 'Optimum battery at the lower bound of the search range: lower "BESS min".' };

export function warnings(O) {
  const w = [];
  if (!O.best) w.push('No configuration satisfies the constraints. Relax the unmet-load / loss-of-load / reserve / renewable / curtailment limits or widen the search space.');
  (O.at_boundary || []).forEach((e) => { if (BOUNDS[e]) w.push(BOUNDS[e]); });
  return w;
}

export function optTiles(O, P) {
  const b = O.best, cur = P.econ.currency;
  if (!b) return [];
  return [
    ['Optimal PV', fmtNum(b.pv_kwp, 0) + ' kWp', O.settings.algorithm_id === 'mopso' ? 'Pareto knee (compromise)' : O.settings.algorithm, true],
    ['Optimal battery', fmtNum(b.bess_kwh, 0) + ' kWh', fmtNum(b.bess_kw, 0) + ' kW', true],
    ...(b.wind_units > 0 ? [['Wind turbines', fmtNum(b.wind_units), `${fmtNum(b.wind_units * P.wind.rated_kw)} kW`, true]] : []),
    ['Net present cost', fmtMoney(b.npc, cur), 'diesel-only ' + fmtMoney(O.baseline.econ.npc, cur)], ['LCOE', `${cur} ${fmtNum(b.lcoe, 4)}`, '/kWh'],
    ['Renewable fraction', fmtPct(b.re), ''], ['Fuel saved', fmtNum((O.baseline.fuel_l_y1 - b.fuel) / 1000, 0) + ' kL/yr', fmtPct(1 - b.fuel / O.baseline.fuel_l_y1)],
    ['IRR', b.irr == null ? '–' : fmtPct(b.irr), ''], ['Payback', b.payback == null ? '–' : fmtNum(b.payback, 1) + ' yr', ''],
    ['Capex', fmtMoney(b.capex, cur), ''], ['Curtailment', fmtPct(b.curtail), ''],
  ];
}

export function rankedTable(O, cur) {
  const wcol = O.ranked.some((r) => r.wind_units > 0);
  return {
    heads: ['#', 'PV kWp', 'BESS kWh', 'BESS kW', ...(wcol ? ['Wind units'] : []), 'Capex', 'NPC', 'LCOE', 'RE', 'Fuel kL/yr', 'Curtail', 'IRR', 'Payback', ''],
    rows: O.ranked.slice(0, 60).map((r, i) => ({ i, cls: i === 0 ? 'best' : '', cells: [i + 1, fmtNum(r.pv_kwp), fmtNum(r.bess_kwh), fmtNum(r.bess_kw), ...(wcol ? [r.wind_units] : []),
      fmtMoney(r.capex, cur), fmtMoney(r.npc, cur), fmtNum(r.lcoe, 4), fmtPct(r.re), fmtNum(r.fuel / 1000), fmtPct(r.curtail), r.irr == null ? '–' : fmtPct(r.irr),
      r.payback == null ? '–' : fmtNum(r.payback, 1)] })),
  };
}

const STAR = (c) => ({ symbol: 'star', size: 18, color: c.pv, line: { color: c.surface, width: 2 } });

export function convChart(O, cur, c) {
  if (!(O.history && O.history.length)) return null;
  const ob = O.settings.objective, mo = O.settings.algorithm_id === 'mopso', sc = ob === 're' && !mo ? -100 : ob === 'lcoe' ? 1 : 1e-6;
  return { traces: [{ type: 'scatter', mode: 'lines+markers', x: O.history.map((_, i) => i + 1), y: O.history.map((v) => v * sc), line: { color: c.accent, width: 2 }, marker: { size: 6 },
    hovertemplate: 'iteration %{x}: %{y:,.4f}<extra></extra>' }],
  layout: { showlegend: false, xaxis: { title: { text: 'Iteration' } },
    yaxis: { title: { text: mo ? 'Lowest cost in Pareto archive' : ob === 're' ? 'Best renewable fraction (%)' : ob === 'lcoe' ? 'Best LCOE' : 'Best NPC (M ' + cur + ')' } } } };
}

// Search-space map: a heat map over the grid, or a scatter of every evaluated configuration for the metaheuristics
export function heatChart(O, metric, crate, cur, c) {
  const scale = { npc: 1e-6, lcoe: 1, re: 100, fuel: 1e-3, curtail: 100 }[metric], unit = { npc: cur + ' M', lcoe: cur + '/kWh', re: '%', fuel: 'kL/yr', curtail: '%' }[metric];
  const blues = [[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']], bar = { title: { text: unit, side: 'right' }, thickness: 12 };
  const layout = { xaxis: { title: { text: 'PV capacity (kWp)' } }, yaxis: { title: { text: 'Battery energy (kWh)' } }, showlegend: false, margin: { l: 70, r: 10, t: 20, b: 50 } };
  const cross = (name, xs, ys, size) => ({ type: 'scatter', mode: 'markers', name, x: xs, y: ys, marker: { symbol: 'x-thin', size, line: { color: c.muted, width: 1.2 } }, hovertemplate: 'infeasible<extra></extra>' });
  if (O.settings.algorithm_id !== 'grid') {
    const ev = O.evaluated || [], fe = ev.filter((g) => g.feasible), inf = ev.filter((g) => !g.feasible);
    const tr = [{ type: 'scatter', mode: 'markers', name: 'Feasible', x: fe.map((g) => g.pv_kwp), y: fe.map((g) => g.bess_kwh),
      marker: { size: 8, color: fe.map((g) => g[metric] * scale), colorscale: blues, reversescale: metric === 're', colorbar: bar },
      text: fe.map((g) => `${fmtNum(g.bess_kw)} kW${g.wind_units ? ' · ' + g.wind_units + ' WT' : ''}`),
      hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh · %{text}<br>%{marker.color:,.3f} ' + unit + '<extra></extra>' }];
    if (inf.length) tr.push(cross('Infeasible', inf.map((g) => g.pv_kwp), inf.map((g) => g.bess_kwh), 7));
    if (O.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [O.best.pv_kwp], y: [O.best.bess_kwh], marker: STAR(c), hovertemplate: 'optimum<extra></extra>' });
    return { traces: tr, layout };
  }
  const px = O.pv_axis, bx = O.bess_axis, z = bx.map(() => px.map(() => null)), txt = bx.map(() => px.map(() => ''));
  O.grid.filter((g) => g.crate_idx === crate).forEach((g) => { z[g.j][g.i] = g.feasible ? g[metric] * scale : null; txt[g.j][g.i] = g.feasible ? '' : 'infeasible: ' + g.why; });
  const tr = [{ type: 'heatmap', x: px, y: bx, z, text: txt, colorscale: blues, reversescale: metric === 're', colorbar: bar, hoverongaps: false,
    hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh<br>%{z:,.3f} ' + unit + '<br>%{text}<extra></extra>' }];
  const inf = O.grid.filter((g) => g.crate_idx === crate && !g.feasible);
  if (inf.length) tr.push(cross('Infeasible', inf.map((g) => px[g.i]), inf.map((g) => bx[g.j]), 8));
  if (O.best) tr.push({ type: 'scatter', mode: 'markers+text', name: 'Optimum', x: [O.best.pv_kwp], y: [O.best.bess_kwh], text: ['★ optimum'], textposition: 'top center', textfont: { color: c.text }, marker: STAR(c), hovertemplate: 'optimum<extra></extra>' });
  return { traces: tr, layout };
}

export function paretoChart(O, cur, c) {
  const all = (O.grid.length ? O.grid : O.evaluated || []).filter((g) => g.feasible), pf = O.pareto.slice().sort((a, b) => a.re - b.re);
  const text = (rs) => rs.map((r) => `PV ${fmtNum(r.pv_kwp)} kWp · BESS ${fmtNum(r.bess_kwh)} kWh`), hov = '%{text}<br>RE %{x:.1f} %, LCOE %{y:.4f}<extra></extra>';
  const tr = [
    { type: 'scatter', mode: 'markers', name: 'Feasible systems', x: all.map((r) => r.re * 100), y: all.map((r) => r.lcoe), marker: { color: c.border, size: 8 }, text: text(all), hovertemplate: hov },
    { type: 'scatter', mode: 'lines+markers', name: 'Cheapest for each RE level', x: pf.map((r) => r.re * 100), y: pf.map((r) => r.lcoe), line: { color: c.accent, width: 2 }, marker: { size: 8 }, text: text(pf), hovertemplate: hov },
    { type: 'scatter', mode: 'markers', name: 'Diesel only', x: [0], y: [O.baseline.econ.lcoe], marker: { color: c.unmet, size: 12, symbol: 'diamond' }, hovertemplate: 'Diesel only: %{y:.4f}<extra></extra>' },
  ];
  if (O.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [O.best.re * 100], y: [O.best.lcoe], marker: STAR(c) });
  return { traces: tr, layout: { xaxis: { title: { text: 'Renewable fraction (%)' } }, yaxis: { title: { text: 'LCOE (' + cur + '/kWh)' } } } };
}

export function sensChart(O, label, cur, c) {
  const S = O.sensitivity, rows = S.rows;
  return { traces: [
    { type: 'scatter', mode: 'lines+markers', name: 'Optimal hybrid LCOE', x: rows.map((r) => r.value), y: rows.map((r) => (r.best ? r.best.lcoe : null)), line: { color: c.accent, width: 2 }, marker: { size: 9 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Diesel-only LCOE', x: rows.map((r) => r.value), y: rows.map((r) => r.baseline_lcoe), line: { color: c.unmet, width: 2, dash: 'dot' }, marker: { size: 9 } },
  ], layout: { xaxis: { title: { text: label } }, yaxis: { title: { text: cur + '/kWh' } } } };
}

export function sensTable(O, label, cur) {
  return { heads: [label, 'Optimal PV kWp', 'Optimal BESS kWh', 'NPC', 'LCOE', 'RE', 'Diesel-only LCOE'],
    rows: O.sensitivity.rows.map((r) => [fmtSig(r.value), r.best ? fmtNum(r.best.pv_kwp) : '–', r.best ? fmtNum(r.best.bess_kwh) : '–', r.best ? fmtMoney(r.best.npc, cur) : '–',
      r.best ? fmtNum(r.best.lcoe, 4) : '–', r.best ? fmtPct(r.best.re) : '–', fmtNum(r.baseline_lcoe, 4)]) };
}
