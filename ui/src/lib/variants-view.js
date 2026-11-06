// The Design variants page as plain data (no DOM, no store): what each variant changes, the side-by-side figures of a comparison and
// its two charts. Every function takes the open project P, so tests can use a hand-made one.
import { fmtNum } from './format.js';
import { display } from './field.js';
import { figures } from './options-view.js';
import { knob, getPath } from './variants.js';

// The unit of an input; a price per quantity ("/L") gets the project's currency, as the list of changed inputs does (ws/diff.js)
export const unitOf = (f, cur) => (!f.u ? '' : f.u.startsWith('/') ? cur + f.u : f.u);

// A value of an input as text, with its unit: "4000 kWh"
export function showValue(f, v, cur = '') {
  if (f.t === 'chk') return v ? 'on' : 'off';
  if (f.t === 'sel') return (f.o.find(([x]) => x === v) || [, String(v)])[1];
  if (v == null) return 'not set (default)';
  const u = unitOf(f, cur);
  return u ? `${display(f, v)} ${u}` : display(f, v);
}

// What the editor shows: each variant with its changes as {k, f (the input), value, base (the project's value), baseText, unit}
export function variantView(P) {
  const cur = P.econ.currency;
  return (P.variants || []).map((v) => ({
    id: v.id, name: v.name,
    rows: Object.keys(v.overrides).map((k) => ({ k, f: knob(k), value: v.overrides[k], base: getPath(P, k) })).filter((r) => r.f)
      .map((r) => ({ ...r, baseText: showValue(r.f, r.base, cur), unit: unitOf(r.f, cur) })),
  }));
}

// The changes of one variant as lines of text with the project's value: "Battery · Energy capacity: 8000 kWh, was 4000 kWh"
export const changeLines = (P, v) => Object.keys(v.overrides).filter((k) => knob(k)).map((k) => {
  const f = knob(k), was = getPath(P, k), cur = P.econ.currency;
  return `${f.name}: ${showValue(f, v.overrides[k], cur)}${was === undefined ? '' : ', was ' + showValue(f, was, cur)}`;
});

const sign = (x, d = 1) => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(d) + ' %';

// The rows of the side-by-side table: [label, value of a case, decimals, better ('low' | 'high' | null)]
const rowsOf = (cur) => [
  ['PV capacity, kWp', (x) => x.size.pv_kwp, 0, null],
  ['Battery energy, kWh', (x) => x.size.bess_kwh, 0, null],
  ['Battery power, kW', (x) => x.size.bess_kw, 0, null],
  ['Wind turbines', (x) => x.size.wind_units, 0, null],
  ['Renewable share, %', (x) => x.re * 100, 1, 'high'],
  ['Diesel fuel, kL in year 1', (x) => x.fuel / 1000, 0, 'low'],
  ['Genset run hours, year 1', (x) => x.uh, 0, 'low'],
  ['CO2, t in year 1', (x) => x.co2, 0, 'low'],
  ['Curtailed, %', (x) => x.curt * 100, 1, 'low'],
  ['Unmet load, %', (x) => x.unmet * 100, 3, 'low'],
  ['Capex, ' + cur, (x) => x.capex, 0, 'low'],
  ['Net present cost, ' + cur, (x) => x.npc, 0, 'low'],
  ['LCOE, ' + cur + '/kWh', (x) => x.lcoe, 4, 'low'],
  ['NPV against diesel only, ' + cur, (x) => x.npv, 0, 'high'],
  ['IRR against diesel only, %', (x) => (x.irr == null ? null : x.irr * 100), 1, 'high'],
  ['Equity IRR, %', (x) => (x.eqIrr == null ? null : x.eqIrr * 100), 1, 'high'],
];

// The side-by-side table of a comparison V ({rows: [{id, name, changes, res}]}): {heads, changes (lines per case), rows: [{label, cells, best}],
// notes}. best is the index of the case with the best value (those that failed or break the optimiser constraints do not count).
export function compareTable(P, V, cur) {
  const cases = V.rows, figs = cases.map((r) => figures(P, r.res));
  const ok = figs.map((x) => !x.err && !x.why);
  const value = (fn, x) => { const v = x.err ? null : fn(x); return v != null && Number.isFinite(v) ? v : null; };
  const rows = rowsOf(cur).map(([label, fn, d, better]) => {
    const vs = figs.map((x) => value(fn, x));
    let best = -1;
    const pool = vs.map((v, i) => (ok[i] && v != null ? i : -1)).filter((i) => i >= 0);
    if (better && pool.length > 1) {
      const pick = better === 'low' ? Math.min : Math.max, top = pick(...pool.map((i) => vs[i]));
      if (pool.some((i) => vs[i] !== top)) best = pool.find((i) => vs[i] === top);
    }
    return { label, cells: vs.map((v) => (v == null ? '–' : fmtNum(v, d))), best };
  });
  // the change against the current design, which is the first case
  // a change below 0.5 % of the net present cost is within model accuracy, as in the operating options
  const rel = (label, fn, near = false) => {
    const b = value(fn, figs[0]);
    return { label, best: -1, cells: figs.map((x, i) => {
      const v = value(fn, x);
      if (i === 0 || b == null || v == null || b === 0) return '–';
      const pct = (v - b) / Math.abs(b) * 100;
      return sign(pct) + (near && Math.abs(pct) < 0.5 ? ', within model accuracy' : '');
    }) };
  };
  rows.push(rel('Net present cost against the current design', (x) => x.npc, true), rel('LCOE against the current design', (x) => x.lcoe));
  const notes = figs.map((x, i) => (x.err ? `${cases[i].name}: ${x.err}` : x.why ? `${cases[i].name} breaks the optimiser constraint on ${x.why}, so it is not counted as best.` : '')).filter(Boolean);
  const changes = cases.map((r) => r.changes || []);   // as they were when the case was simulated (variants.svelte.js)
  return { heads: cases.map((r) => r.name), changes, rows, notes };
}

// Net present cost of each case split into the capex of each asset and everything after construction (fuel, O&M, replacements)
export function costFig(P, V, c) {
  const cur = P.econ.currency, names = V.rows.map((r) => r.name), E = V.rows.map((r) => (r.res.error ? null : r.res.result.econ));
  const part = (name, color, fn) => ({ type: 'bar', name, x: names, y: E.map((e) => (e ? fn(e) : null)), marker: { color },
    hovertemplate: '%{x}: %{y:,.0f} ' + cur + '<extra>' + name + '</extra>' });
  const traces = [part('PV capex', c.pv, (e) => e.capex_pv), part('Battery capex', c.bess, (e) => e.capex_bess), part('Wind capex', c.wind, (e) => e.capex_wind),
    part('Diesel capex', c.gen, (e) => e.capex_diesel), part('Other capex', c.muted, (e) => e.capex_other),
    part('Fuel, O&M and replacements', c.text2, (e) => e.npc - e.capex_total)];
  return { traces, layout: { barmode: 'stack', showlegend: true, yaxis: { title: { text: 'Net present cost (' + cur + ')' } }, margin: { l: 70, r: 10, t: 10, b: 60 } } };
}

// Year-1 energy of each case by source, in MWh
export function supplyFig(V, c) {
  const names = V.rows.map((r) => r.name), Y = V.rows.map((r) => (r.res.error ? null : r.res.result.years[0]));
  const part = (name, color, fn) => ({ type: 'bar', name, x: names, y: Y.map((y) => (y ? fn(y) / 1000 : null)), marker: { color },
    hovertemplate: '%{x}: %{y:,.0f} MWh<extra>' + name + '</extra>' });
  const traces = [part('PV to load', c.pv, (y) => y.pv_to_load), part('Wind to load', c.wind, (y) => y.wind_to_load || 0), part('Battery to load', c.bess, (y) => y.bess_dis),
    part('Diesel to load', c.gen, (y) => y.gen_to_load), part('Unmet', c.unmet, (y) => y.unmet)];
  return { traces, layout: { barmode: 'stack', showlegend: true, yaxis: { title: { text: 'MWh in year 1' } }, margin: { l: 70, r: 10, t: 10, b: 60 } } };
}
