// The outage survival study of the Simulation results page (engine/src/sim/resilience.rs, docs/ipc.md `resilience`): the table,
// the chart and the start-hour strip of its result R (plain functions; ui/tests/resilience.test.js).
import { fmtNum, fmtPct } from './format.js';

// Outage lengths of the table and of the strip (up to the study's longest outage, which is always included)
export const RESIL_DURS = [1, 2, 4, 8, 12, 24, 48, 72, 96, 168, 240, 336, 504, 720];

export const RESIL_HEADS = ['Outage', 'Minimum', '5th percentile', 'Mean', 'Starts below 90 %', 'Hour d alone, mean', 'Critical energy served, mean'];

// One row per outage length d of RESIL_DURS: the cumulative survival over the start hours (minimum, 5th percentile, mean, share of
// starts below 90 %), the mean chance of serving hour d itself, and the mean share of the critical energy served over d hours
export function resilRows(R) {
  const ds = RESIL_DURS.filter((d) => d < R.max_h).concat([R.max_h]);
  return ds.map((d) => ({ d, min: R.cum.min[d - 1], p5: R.cum.p5[d - 1], mean: R.cum.mean[d - 1], below: R.cum.below90[d - 1],
    hourly: R.hourly.mean[d - 1], served: R.served_mean[d - 1] }));
}

export const resilCells = (x) => [fmtNum(x.d) + ' h', fmtPct(x.min, 1), fmtPct(x.p5, 1), fmtPct(x.mean, 1), fmtPct(x.below, 1), fmtPct(x.hourly, 1), fmtPct(x.served, 1)];

// Do the gensets fail in the study (failure to start, running failures or units out for repair)?
export const unitFails = (R) => R.units > 0 && (R.fail_start > 0 || R.mttf_h != null || R.availability < 1);

// Survival against outage length: minimum, 5th percentile and mean over the start hours, the hourly (non-absorbing) mean dotted,
// and with genset failures the chance that one unit still runs
export function resilFig(R, c) {
  const x = Array.from({ length: R.max_h }, (_, i) => i + 1);
  const line = (y, name, color, dash = 'solid') => ({ type: 'scatter', mode: 'lines', x, y: y.map((v) => v * 100), name,
    line: { color, width: dash === 'solid' ? 2 : 1.5, dash }, hovertemplate: '%{x} h: %{y:.1f} %<extra>' + name + '</extra>' });
  const traces = [line(R.cum.mean, 'Mean', c.bess), line(R.cum.p5, '5th percentile', c.gen), line(R.cum.min, 'Minimum', c.unmet),
    line(R.hourly.mean, 'Hour d alone, mean', c.muted, 'dot')];
  if (unitFails(R)) traces.push(line(R.unit_reliability, 'One genset still running', c.text2, 'dash'));
  return { traces, layout: { xaxis: { title: { text: 'Outage length d (h)' }, ...(R.max_h > 48 ? { dtick: 24 } : {}) },
    yaxis: { title: { text: 'Critical load served in full (%)' }, range: [0, 102] } } };
}

// The outage lengths the strip can show, and the one to show for the length asked
export const stripDurations = (R) => (R && R.strip ? R.strip.durations : []);
export function stripPick(R, want) {
  const ds = stripDurations(R);
  return ds.includes(+want) ? +want : ds.includes(24) ? 24 : ds[ds.length - 1];
}

// The cumulative survival of an outage of d hours by start: day of year across, hour of day down when the step fits the day
// (one row of starts otherwise)
export function resilStripFig(R, d, c) {
  const i = stripDurations(R).indexOf(d);
  if (i < 0) return null;
  const v = R.strip.values[i].map((x) => x * 100), st = R.stride;
  const scale = [[0, c.unmet], [0.9, c.pv], [1, c.bess]];
  const bar = { title: { text: '%', side: 'right' }, thickness: 12, tickfont: { color: c.text2 } };
  if (24 % st === 0) {
    const rows = 24 / st, days = Math.floor(v.length / rows);
    const z = Array.from({ length: rows }, (_, r) => Array.from({ length: days }, (_, k) => v[k * rows + r]));
    return { traces: [{ type: 'heatmap', z, x: Array.from({ length: days }, (_, k) => k + 1), y: Array.from({ length: rows }, (_, r) => r * st),
      zmin: 0, zmax: 100, colorscale: scale, colorbar: bar, hovertemplate: 'day %{x}, %{y}:00<br>%{z:.1f} %<extra></extra>' }],
    layout: { xaxis: { title: { text: 'Day of year the outage starts' } }, yaxis: { title: { text: 'Hour' }, dtick: 6 }, margin: { l: 56, r: 10, t: 10, b: 40 } } };
  }
  return { traces: [{ type: 'heatmap', z: [v], x: v.map((_, k) => 1 + (k * st) / 24), y: [''], zmin: 0, zmax: 100, colorscale: scale, colorbar: bar,
    hovertemplate: 'day %{x:.2f}<br>%{z:.1f} %<extra></extra>' }],
  layout: { xaxis: { title: { text: 'Day of year the outage starts' } }, margin: { l: 56, r: 10, t: 10, b: 40 } } };
}

// What the study assumed, in a few sentences
export function resilNotes(R) {
  const out = [`${fmtNum(R.starts)} outages start ${R.stride > 1 ? `every ${fmtNum(R.stride)} hours` : 'at every hour'} of year 1, each from the stored energy the simulation had then, and run up to ${fmtNum(R.max_h)} h with PV, wind, the battery and the gensets and no grid.`,
    `The plant serves the critical load: ${R.critical_share < 1 ? `${fmtPct(R.critical_share, 0)} of the site load and the auxiliaries` : 'all of it (no critical share set)'}, ${fmtNum(R.critical_kw_mean)} kW on average.`];
  if (R.units > 0) {
    out.push(unitFails(R)
      ? `Each of the ${fmtNum(R.units)} gensets is available at the start with probability ${fmtPct(R.availability, 1)}, starts with ${fmtPct(1 - R.fail_start, 1)} and then runs ${R.mttf_h != null ? `for a mean of ${fmtNum(R.mttf_h)} h before it fails` : 'without failing'}; a failed unit is not repaired within the outage.`
      : `The ${fmtNum(R.units)} gensets start and run without failing (no failure to start, running failures or forced outages set).`);
  }
  out.push('Minimum, 5th percentile and mean are over the start hours of the chance that the critical load has been served in full in every hour of the first d hours (cumulative). The dotted line is the chance that hour d itself is served, whatever happened before. Fuel is unlimited.');
  return out;
}
