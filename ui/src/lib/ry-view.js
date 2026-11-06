// The weather-year (P50/P90) card as plain data: formats, the summary of a run, chart traces and table rows.
// The old report and workbook (web/js/report.js) read the summary through window.SoloptimaUI.ry.
import { fmtNum, fmtPct, fmtMoney } from './format.js';

export const METRICS = [['yield', 'Specific yield'], ['fuel_saved', 'Fuel saved'], ['re', 'Renewable fraction'], ['revenue', 'Revenue'], ['fuel_used', 'Fuel used']];
export const QUANTILES = ['p50', 'p75_1', 'p90_1', 'p99_1', 'p90_10'];
export const HEADS = ['Result', 'P50', 'P75', 'P90 1-yr', 'P99 1-yr', 'P90 10-yr', 'Inter-annual σ', 'Elasticity', 'Worst year'];

// One value of result k as text
export function fmt(k, v, currency) {
  if (v == null || !isFinite(v)) return '–';
  return k === 'yield' ? fmtNum(v) + ' kWh/kWp' : k === 're' ? fmtPct(v) : k === 'revenue' ? fmtMoney(v, currency) : fmtNum(v / 1000) + ' kL';
}

// Figures of the last run X (project.resource_years.result): table rows, the revenue P90/P50 factors, the factor in use for debt
// sizing when it still comes from this run (applied, factor: the project's p90_factor), whether the inputs changed since (stale),
// and how far the project weather is from the multi-year mean (dev = P50 ÷ mean − 1 of the specific yield, with its note and a
// warning above 2 %). That gap moves P50 and the whole base case, not the P90 ÷ P50 factors, which are ratios.
export function summary(X, applied, factor, currentKey) {
  const rev = X.stats.revenue, sy = X.stats.yield;
  const rows = METRICS.map(([k, label]) => ({ k, label: k === 'revenue' ? (X.model === 'host' ? 'Revenue (avoided diesel cost)' : 'Revenue, year 1') : label, ...X.stats[k] }));
  const ratio = (v) => (rev.p50 > 0 ? Math.max(0, v / rev.p50) : null);
  const dev = sy.mean > 0 ? sy.p50 / sy.mean - 1 : null, db = `${X.database} ${X.range.from}–${X.range.to}`;
  const devNote = dev == null ? '' : `The project weather (${X.weather || 'not recorded'}) gives a specific yield ${fmtPct(Math.abs(dev))} ${dev >= 0 ? 'above' : 'below'} the multi-year mean of ${db}. P50 is on the project weather, so the gap moves P50 and the whole base case, but not the P90 ÷ P50 factors, which are ratios.`;
  // whether the project weather comes from the run's database: its label ends in "(db)" for PVGIS, or is "NASA POWER yyyy"
  const w = X.weather || '', tmy = /TMY/i.test(w);
  const same = X.database === 'NASA POWER' ? /^NASA POWER \d{4}$/.test(w) : w.includes(`(${X.database})`);
  const devWarn = dev == null || Math.abs(dev) <= 0.02 ? ''
    : tmy && same ? `The project weather is already a typical year from ${X.database}; the gap comes from its period and its choice of months against the mean of ${db}. Cross-check before relying on the base case.`
    : tmy ? `The project weather is already a typical year, so the gap is a difference between its database and ${X.database} at this site; cross-check them before relying on the base case.`
    : same ? `The P50 base case rests on a ${dev > 0 ? 'better' : 'poorer'} than average year; use a TMY or a long-term average weather file for the base case.`
    : `The P50 base case rests on weather ${dev > 0 ? 'better' : 'poorer'} than the multi-year mean of ${db}: an unusual year, a different database, or both. Use a TMY or a long-term average weather file for the base case.`;
  return { X, rows, f1: ratio(rev.p90_1), f10: ratio(rev.p90_10), applied: applied && applied.p90_factor === factor ? applied : null,
    stale: currentKey != null && X.key !== currentKey, dev, devNote, devWarn };
}

// Table body: one array of cell texts per result
export const tableRows = (S, currency) => S.rows.map((r) => [r.label, ...QUANTILES.map((q) => fmt(r.k, r[q], currency)), fmtPct(r.sigma_iav), fmtNum(r.elasticity, 2),
  `${r.worst_year} (${fmt(r.k, r.worst, currency)})`]);

// The lines of the note under the card
export function notes(S, windUnits) {
  const X = S.X, b = X.budget || {}, out = [];
  if (S.stale) out.push('⚠ The inputs have changed since this run: press Run weather years again.');
  out.push(`${X.years.length} weather years of ${X.database} ${X.range.from}–${X.range.to}${X.requested && (X.range.from > X.requested.from || X.range.to < X.requested.to) ? ' (the years the database covers)' : ''}. `
    + `${S.devNote || `P50 is on the project's weather, ${X.weather || '–'}.`}${S.devWarn ? ' ⚠ ' + S.devWarn : ''} `
    + `Systematic uncertainty ${fmtPct(X.sigma_sys)} (root-sum-square of ${fmtPct(b.dataset)}, ${fmtPct(b.model)} and ${fmtPct(b.soiling)}), scaled by each result's elasticity: its relative change per relative change of irradiance at P50. `
    + 'The 10-year values assume independent years. The worst year of each result is outlined in red.');
  if (windUnits > 0) out.push('With wind turbines, each weather year also brings its own wind speeds, but the systematic uncertainty and the elasticity cover irradiance only, so the P90 leaves out the uncertainty of the long-term wind resource.');
  if (X.note) out.push(X.note);
  return out;
}

export function factorText(S) {
  if (S.f1 == null) return 'Revenue P50 is zero: no factor to apply.';
  return `Revenue P90 ÷ P50: ${fmtNum(S.f1, 3)} for one year, ${fmtNum(S.f10, 3)} for a 10-year average.`
    + (S.applied ? ` Debt sizing uses ${S.applied.p90_factor} (${S.applied.basis === 10 ? '10-year average' : 'one year'}).` : '');
}

// The debt-sizing factor of the chosen basis, rounded to 4 places, or null when revenue P50 is zero
export function chosenFactor(S, basis) {
  const f = basis === 10 ? S.f10 : S.f1;
  return f == null ? null : Math.round(f * 1e4) / 1e4;
}

// Bars from 100 % (the multi-year mean) for specific yield and fuel saved, the worst year outlined, P50 and P90 as lines
export function chart(S, c, currency) {
  const X = S.X, yrs = X.years.map((y) => y.year), x0 = yrs[0] - 0.5, x1 = yrs[yrs.length - 1] + 0.5;
  const bars = (k, field, name, color) => {
    const st = X.stats[k];
    return { type: 'bar', name, x: yrs, base: 100, y: X.years.map((y) => (st.mean ? 100 * y[field] / st.mean - 100 : null)),
      marker: { color, cornerradius: 3, line: { color: c.unmet, width: yrs.map((y) => (y === st.worst_year ? 2.5 : 0)) } },
      customdata: X.years.map((y) => fmt(k, y[field], currency)), hovertemplate: `%{x}: %{customdata}, %{y:+.1f} % from the mean<extra>${name}</extra>` };
  };
  const level = (name, v, color, dash) => ({ type: 'scatter', mode: 'lines', name, x: [x0, x1], y: [v, v], line: { color, width: 1.5, dash }, hovertemplate: `${name}: %{y:.1f} %<extra></extra>` });
  // P50 and P90 on the bars' basis: P50 is the project weather, which need not be an average year
  const rel = (k, q) => (X.stats[k].mean ? 100 * X.stats[k][q] / X.stats[k].mean : null);
  return {
    traces: [bars('yield', 'sy', 'Specific yield', c.pv), bars('fuel_saved', 'fuel_saved', 'Fuel saved', c.gen), level('Multi-year mean', 100, c.muted, 'solid'),
      level('P50, specific yield', rel('yield', 'p50'), c.pv, 'dot'), level('P50, fuel saved', rel('fuel_saved', 'p50'), c.gen, 'dot'),
      level('P90 1-yr, specific yield', rel('yield', 'p90_1'), c.pv, 'dash'), level('P90 1-yr, fuel saved', rel('fuel_saved', 'p90_1'), c.gen, 'dash')],
    layout: { barmode: 'group', xaxis: { title: { text: 'Weather year' }, dtick: 1, range: [x0, x1] }, yaxis: { title: { text: '% of the multi-year mean' } } },
  };
}
