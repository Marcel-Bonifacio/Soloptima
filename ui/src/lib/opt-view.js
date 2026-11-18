// What the optimisation screen shows, as plain data: the KPI tiles, warnings, the ranked table and the chart traces.
import { fmtNum, fmtPct, fmtMoney, fmtSig } from './format.js';
import { SENS_VARS } from './schema/consts.js';
import { optionLabel } from './ws/util.js';

const BOUNDS = { pv_max: 'Optimum PV at the upper bound of the search range: raise "PV max".', bess_max: 'Optimum battery at the upper bound of the search range: raise "BESS max".',
  pv_min: 'Optimum PV at the lower bound of the search range: lower "PV min".', bess_min: 'Optimum battery at the lower bound of the search range: lower "BESS min".',
  gen_max: 'Optimum genset count at the upper bound of the search range: raise "Genset units max".', gen_min: 'Optimum genset count at the lower bound of the search range: lower "Genset units min".',
  rating_max: 'Optimum at the largest genset rating listed: add larger ratings to the search.', rating_min: 'Optimum at the smallest genset rating listed: add smaller ratings to the search.' };

export function warnings(O) {
  const w = [];
  if (!O.best) w.push(`No configuration satisfies the constraints. Relax the unmet-load / loss-of-load / reserve / renewable / curtailment${O.settings && O.settings.min_autonomy_days ? ' / autonomy' : ''}${O.settings && O.settings.max_ramp_viol != null ? ' / ramp' : ''} limits or widen the search space.`);
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
    ...(b.gen_units != null ? [['Gensets', fmtNum(b.gen_units), b.gen_units ? `${fmtNum(b.gen_units * (b.gen_kw ?? P.diesel.unit_kw))} kW (main group)` : 'diesel-free', true]] : []),
    ...(b.gen_kw != null ? [['Genset unit rating', fmtNum(b.gen_kw) + ' kW', ratingName(O, b), true]] : []),
    ['Net present cost', fmtMoney(b.npc, cur), 'diesel-only ' + fmtMoney(O.baseline.econ.npc, cur)], ['LCOE', `${cur} ${fmtNum(b.lcoe, 4)}`, '/kWh'],
    ...(O.runs ? [['Runs', fmtNum(O.runs.n), `best from run ${O.runs.best_run ?? '–'}`]] : []),
    ['Renewable fraction', fmtPct(b.re), ''], ['Fuel saved', fmtNum((O.baseline.fuel_l_y1 - b.fuel) / 1000, 0) + ' kL/yr', fmtPct(1 - b.fuel / O.baseline.fuel_l_y1)],
    ['IRR', b.irr == null ? '–' : fmtPct(b.irr), ''], ['Payback', b.payback == null ? '–' : fmtNum(b.payback, 1) + ' yr', ''],
    ['Capex', fmtMoney(b.capex, cur), ''], ['Curtailment', fmtPct(b.curtail), ''],
    ...(b.autonomy_d !== undefined ? [['Autonomy', b.autonomy_d == null ? '–' : fmtNum(b.autonomy_d, 2) + ' days', `battery alone; at least ${fmtNum(O.settings.min_autonomy_days, 2)} asked`]] : []),
  ];
}

// The datasheet or list entry of a design's genset rating
export function ratingName(O, b) {
  const g = O.settings.gen_ratings && O.settings.gen_ratings[b.gen_rating];
  return g && g.name ? g.name : 'from the list';
}

// The genset columns of a run that sized the gensets: [key, head, cell of a design]
/** @type {[string, string, (b: any) => any][]} */
const GEN_COLS = [['gen_units', 'Gensets', (b) => b.gen_units], ['gen_kw', 'Genset kW', (b) => fmtNum(b.gen_kw)]];
// The genset columns some design of the list (null: none) has a value for
export const presentCols = (list) => GEN_COLS.filter(([k]) => list.some((d) => d && d[k] != null));

export function rankedTable(O, cur) {
  const wcol = O.ranked.some((r) => r.wind_units > 0), gen = presentCols(O.ranked);
  return {
    heads: ['#', 'PV kWp', 'BESS kWh', 'BESS kW', ...(wcol ? ['Wind units'] : []), ...gen.map((c) => c[1]), 'Capex', 'NPC', 'LCOE', 'RE', 'Fuel kL/yr', 'Curtail', 'IRR', 'Payback', ''],
    rows: O.ranked.slice(0, 60).map((r, i) => ({ i, cls: i === 0 ? 'best' : '', cells: [i + 1, fmtNum(r.pv_kwp), fmtNum(r.bess_kwh), fmtNum(r.bess_kw), ...(wcol ? [r.wind_units] : []), ...gen.map((c) => c[2](r)),
      fmtMoney(r.capex, cur), fmtMoney(r.npc, cur), fmtNum(r.lcoe, 4), fmtPct(r.re), fmtNum(r.fuel / 1000), fmtPct(r.curtail), r.irr == null ? '–' : fmtPct(r.irr),
      r.payback == null ? '–' : fmtNum(r.payback, 1)] })),
  };
}

// The best feasible design of each system type (PV, battery, wind, gensets present or not), from a run that sized the gensets
export function archTable(O, cur) {
  if (!O.architectures || !O.architectures.length) return null;
  const wcol = O.architectures.some((a) => a.wind), kcol = !!O.settings.gen_ratings;
  return {
    heads: ['System type', 'PV kWp', 'BESS kWh', ...(wcol ? ['Wind units'] : []), 'Gensets', ...(kcol ? ['Genset kW'] : []), 'NPC', 'LCOE', 'RE', 'Fuel kL/yr', 'Feasible / evaluated'],
    // the engine lists the types with a feasible design first, best objective first
    rows: O.architectures.map((a, i) => {
      const b = a.best, n = `${fmtNum(a.n_feasible)} / ${fmtNum(a.n_evaluated)}`;
      if (!b) return { cls: '', best: null, cells: [a.label, 'no feasible design', '', ...(wcol ? [''] : []), '', ...(kcol ? [''] : []), '', '', '', '', n] };
      return { cls: i === 0 ? 'best' : '', best: b, cells: [a.label, fmtNum(b.pv_kwp), fmtNum(b.bess_kwh), ...(wcol ? [b.wind_units] : []), b.gen_units ?? '–',
        ...(kcol ? [b.gen_kw != null && (b.gen_units ?? 1) > 0 ? fmtNum(b.gen_kw) : '–'] : []), fmtMoney(b.npc, cur), fmtNum(b.lcoe, 4), fmtPct(b.re), fmtNum(b.fuel / 1000), n] };
    }),
  };
}

// Repeated runs of a metaheuristic: the value of each run (the objective of its best design, or the hypervolume of its MOPSO
// front) and best, mean, worst and standard deviation over the runs. Null for a single run.
export function runsTable(O, cur) {
  const R = O.runs;
  if (!R) return null;
  const m = R.metric, mo = m === 'hypervolume';
  const f = (v) => (v == null ? '–' : m === 'npc' ? fmtMoney(v, cur) : m === 'lcoe' ? fmtNum(v, 4) : m === 're' ? fmtPct(v, 2) : fmtNum(v, 4));
  const name = { npc: 'Best NPC', lcoe: `Best LCOE (${cur}/kWh)`, re: 'Best renewable fraction', hypervolume: 'Hypervolume' }[m] || m;
  return {
    name, better: R.higher_is_better ? 'higher' : 'lower',
    stats: [['Best', f(R.best)], ['Mean', f(R.mean)], ['Worst', f(R.worst)], ['Standard deviation', f(R.std)],
      ['Runs with a feasible design', `${fmtNum(R.n_with_value)} of ${fmtNum(R.n)}`], ['Run reported', R.best_run ?? '–']],
    heads: ['Run', 'Seed', 'Evaluations', 'New simulations', name, ...(mo ? ['Front points', 'Spacing'] : [])],
    rows: R.rows.map((r) => ({ cls: r.run === R.best_run ? 'best' : '', cells: [r.run, r.seed, fmtNum(r.evaluations), fmtNum(r.simulations), f(r.value),
      ...(mo ? [fmtNum(r.front), r.spacing == null ? '–' : fmtNum(r.spacing, 4)] : [])] })),
  };
}

// MOPSO front statistics: the cheapest design of the front at each LPSP target, and the quality of the front. Null without them.
export function lpspTable(O, cur) {
  if (!O.lpsp_table) return null;
  const gen = presentCols(O.lpsp_table.map((t) => t.best));
  const Q = O.pareto_quality, second = { re: 'renewable fraction', sssi: 'SSSI', lpsp: 'LPSP', co2: 'CO2' }[O.settings.mo_second] || 'renewable fraction';
  const refSecond = !Q ? '' : O.settings.mo_second === 'co2' ? `${fmtNum(Q.ref_second)} t/yr` : fmtPct(Q.ref_second, 2);
  return {
    heads: ['LPSP at most', 'PV kWp', 'BESS kWh', 'BESS kW', ...gen.map((c) => c[1]), 'Fuel kL/yr', 'CO2 t/yr', 'NPC', 'LCOE', 'LPSP', ''],
    rows: O.lpsp_table.map((t) => {
      const b = t.best, lab = fmtPct(t.target, 0);
      if (!b) return { best: null, cells: [lab, 'no front design meets it', '', '', ...gen.map(() => ''), '', '', '', '', ''] };
      return { best: b, cells: [lab, fmtNum(b.pv_kwp), fmtNum(b.bess_kwh), fmtNum(b.bess_kw), ...gen.map((c) => c[2](b)),
        fmtNum(b.fuel / 1000), fmtNum(b.co2_t), fmtMoney(b.npc, cur), fmtNum(b.lcoe, 4), fmtPct(b.unmet, 2)] };
    }),
    quality: Q ? `${fmtNum(Q.points)} designs on the front. Spacing ${Q.spacing == null ? '–' : fmtNum(Q.spacing, 4)} (0 = evenly spread, lower is better); hypervolume ${fmtNum(Q.hypervolume, 4)} of the box from the best to the reference point (${O.settings.objective === 'lcoe' ? 'LCOE ' + fmtNum(Q.ref_cost, 4) : 'NPC ' + fmtMoney(Q.ref_cost, cur)}, ${second} ${refSecond}), higher is better.` : '',
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
    /** @type {any[]} */
    const tr = [{ type: 'scatter', mode: 'markers', name: 'Feasible', x: fe.map((g) => g.pv_kwp), y: fe.map((g) => g.bess_kwh),
      marker: { size: 8, color: fe.map((g) => g[metric] * scale), colorscale: blues, reversescale: metric === 're', colorbar: bar },
      text: fe.map((g) => `${fmtNum(g.bess_kw)} kW${g.wind_units ? ' · ' + g.wind_units + ' WT' : ''}${g.gen_units != null ? ' · ' + g.gen_units + ' gensets' : ''}${g.gen_kw != null ? ' of ' + fmtNum(g.gen_kw) + ' kW' : ''}`),
      hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh · %{text}<br>%{marker.color:,.3f} ' + unit + '<extra></extra>' }];
    if (inf.length) tr.push(cross('Infeasible', inf.map((g) => g.pv_kwp), inf.map((g) => g.bess_kwh), 7));
    if (O.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [O.best.pv_kwp], y: [O.best.bess_kwh], marker: STAR(c), hovertemplate: 'optimum<extra></extra>' });
    return { traces: tr, layout };
  }
  const px = O.pv_axis, bx = O.bess_axis, z = bx.map(() => px.map(() => null)), txt = bx.map(() => px.map(() => ''));
  // with genset sizing the grid repeats for each count: map the plane at the optimum's count (the largest without an optimum)
  // and with a rating search at the optimum's rating (the largest without an optimum)
  const gu = O.best ? O.best.gen_units : O.settings.gen_units_max, gr = O.best ? O.best.gen_rating : (O.settings.gen_ratings || []).length - 1;
  const grid = O.grid.filter((g) => (g.gen_units == null || g.gen_units === gu) && (g.gen_rating == null || g.gen_rating === gr));
  grid.filter((g) => g.crate_idx === crate).forEach((g) => { z[g.j][g.i] = g.feasible ? g[metric] * scale : null; txt[g.j][g.i] = g.feasible ? '' : 'infeasible: ' + g.why; });
  /** @type {any[]} */
  const tr = [{ type: 'heatmap', x: px, y: bx, z, text: txt, colorscale: blues, reversescale: metric === 're', colorbar: bar, hoverongaps: false,
    hovertemplate: 'PV %{x:,.0f} kWp<br>BESS %{y:,.0f} kWh<br>%{z:,.3f} ' + unit + '<br>%{text}<extra></extra>' }];
  const inf = grid.filter((g) => g.crate_idx === crate && !g.feasible);
  if (inf.length) tr.push(cross('Infeasible', inf.map((g) => px[g.i]), inf.map((g) => bx[g.j]), 8));
  if (O.best) tr.push({ type: 'scatter', mode: 'markers+text', name: 'Optimum', x: [O.best.pv_kwp], y: [O.best.bess_kwh], text: ['★ optimum'], textposition: 'top center', textfont: { color: c.text }, marker: STAR(c), hovertemplate: 'optimum<extra></extra>' });
  return { traces: tr, layout };
}

// The x axis of the cost chart: the renewable fraction, or the MOPSO second objective when that is LPSP or CO2
export function paretoAxis(O) {
  const m = O.settings && O.settings.algorithm_id === 'mopso' ? O.settings.mo_second : '';
  if (m === 'lpsp') return { name: 'unmet load', title: 'Unmet load, LPSP (%)', short: 'LPSP', unit: '%', of: (r) => r.unmet * 100, base: O.baseline.unmet_fraction * 100 };
  if (m === 'co2' && O.pareto.length && O.pareto[0].co2_t != null) return { name: 'CO2', title: 'CO2, year 1 (t)', short: 'CO2', unit: ' t', of: (r) => r.co2_t, base: O.baseline.metrics.co2_t };
  return { name: 'renewable fraction', title: 'Renewable fraction (%)', short: 'RE', unit: ' %', of: (r) => r.re * 100, base: 0 };
}

export function paretoChart(O, cur, c) {
  const A = paretoAxis(O), all = (O.grid.length ? O.grid : O.evaluated || []).filter((g) => g.feasible && A.of(g) != null), pf = O.pareto.slice().sort((a, b) => A.of(a) - A.of(b));
  const text = (rs) => rs.map((r) => `PV ${fmtNum(r.pv_kwp)} kWp · BESS ${fmtNum(r.bess_kwh)} kWh`), hov = `%{text}<br>${A.short} %{x:.1f}${A.unit}, LCOE %{y:.4f}<extra></extra>`;
  /** @type {any[]} */
  const tr = [
    { type: 'scatter', mode: 'markers', name: 'Feasible systems', x: all.map(A.of), y: all.map((r) => r.lcoe), marker: { color: c.border, size: 8 }, text: text(all), hovertemplate: hov },
    { type: 'scatter', mode: 'lines+markers', name: A.short === 'RE' ? 'Cheapest for each RE level' : 'Pareto front', x: pf.map(A.of), y: pf.map((r) => r.lcoe), line: { color: c.accent, width: 2 }, marker: { size: 8 }, text: text(pf), hovertemplate: hov },
    { type: 'scatter', mode: 'markers', name: 'Diesel only', x: [A.base], y: [O.baseline.econ.lcoe], marker: { color: c.unmet, size: 12, symbol: 'diamond' }, hovertemplate: 'Diesel only: %{y:.4f}<extra></extra>' },
  ];
  if (O.best) tr.push({ type: 'scatter', mode: 'markers', name: 'Optimum', x: [A.of(O.best)], y: [O.best.lcoe], marker: STAR(c) });
  return { traces: tr, layout: { xaxis: { title: { text: A.title } }, yaxis: { title: { text: 'LCOE (' + cur + '/kWh)' } } } };
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

// The name of a sensitivity or map variable
export const sensName = (v) => optionLabel(SENS_VARS, v);

// The two-way map: the winning system type and its NPC in each cell (rows: the second variable, columns: the first). Null when
// the run has no map.
export function mapTable(O, cur) {
  const M = O.map;
  if (!M) return null;
  const cell = (c) => (!c ? 'not run' : !c.best ? 'no feasible design' : `${c.type} · ${fmtMoney(c.best.npc, cur)}`);
  return {
    x: sensName(M.x), y: sensName(M.y), fixed: M.mode === 'fixed',
    heads: [`${sensName(M.y)} \\ ${sensName(M.x)}`, ...M.x_values.map(fmtSig)],
    rows: M.cells.map((r, i) => [fmtSig(M.y_values[i]), ...r.map(cell)]),
    types: [...new Set(M.cells.flat().filter((c) => c && c.type).map((c) => c.type))],
  };
}

// The map as a heat map of the winner's NPC, each cell labelled with its system type
export function mapChart(O, cur, c) {
  const M = O.map, blues = [[0, '#cde2fb'], [0.5, '#3987e5'], [1, '#0d366b']];
  const z = M.cells.map((r) => r.map((x) => (x && x.best ? x.best.npc * 1e-6 : null)));
  const text = M.cells.map((r) => r.map((x) => (!x ? 'not run' : x.type || 'no feasible design')));
  return { traces: [{ type: 'heatmap', x: M.x_values.map(fmtSig), y: M.y_values.map(fmtSig), z, text, texttemplate: '%{text}', textfont: { size: 11 },
    colorscale: blues, colorbar: { title: { text: cur + ' M', side: 'right' }, thickness: 12 }, hoverongaps: false,
    hovertemplate: `${sensName(M.x)} %{x}<br>${sensName(M.y)} %{y}<br>%{text}<br>NPC %{z:,.2f} M ${cur}<extra></extra>` }],
  layout: { xaxis: { title: { text: sensName(M.x) }, type: 'category' }, yaxis: { title: { text: sensName(M.y) }, type: 'category' }, margin: { l: 70, r: 10, t: 20, b: 50 } } };
}
