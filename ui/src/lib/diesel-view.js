// What the Diesel & control page computes, as plain functions: the fuel curve table and figure, the
// strategy help text, the monthly fuel records. ui/tests/diesel.test.js covers it.
import { fmtNum } from './format.js';

export const STRATEGY_HELP = {
  load_following: 'Load following: PV first, battery covers the deficit, gensets only produce what the load needs. Genset minimum loading can force PV curtailment.',
  cycle_charging: 'Cycle charging: the battery covers the deficit as in load following until it is empty (or until gensets at minimum loading plus PV cover the load); the running gensets then charge it from their spare capacity up to the SOC setpoint, and until it gets there it discharges only to cover load the gensets cannot. No genset is started only to charge. The battery then carries load again so fewer gensets run. Each cycle loses 1 − RTE of its energy.',
  predictive: 'Predictive EMS: every re-plan interval the EMS forecasts PV and load, then dynamic programming over the battery SOC chooses charge/discharge set-points and genset commitment that minimise fuel, run-hours and battery wear across the horizon. In real time the battery compensates forecast errors only where that avoids an unplanned genset start; gensets take the rest.',
};
export const strategyHelp = (s) => STRATEGY_HELP[s] || '';

// Fuel use (L/h per rated kW) at loading lf, from the linear model or by interpolating the datasheet table
export function fuelRate(D, lf) {
  if (D.fuel_model === 'linear') return D.fuel_intercept + D.fuel_slope * lf;
  const pts = D.fuel_curve.map(([l, e]) => [l, l / e]).sort((a, b) => a[0] - b[0]);
  let j = 1; while (j < pts.length - 1 && lf > pts[j][0]) j++;
  const [x0, y0] = pts[j - 1], [x1, y1] = pts[j];
  return Math.max(0, y0 + (y1 - y0) * (lf - x0) / (x1 - x0));
}

// Table rows of the fuel curve: load in %, efficiency in kWh/L and the fuel use of one unit in L/h
export const fuelRows = (D) => D.fuel_curve.map(([lf, ef]) => ({ load: +(lf * 100).toFixed(2), eff: +ef, lph: fmtNum(lf * D.unit_kw / ef, 1) }));

// Change one cell of the curve (column 0 = load in %, column 1 = efficiency); the curve stays sorted by load
export function setFuelCell(D, i, col, value) {
  D.fuel_curve[i][col] = col === 0 ? value / 100 : value;
  D.fuel_curve.sort((a, b) => a[0] - b[0]);
}
export const addFuelPoint = (D) => { D.fuel_curve.push([1, 3.9]); };
// A curve keeps at least two points; false when nothing was removed
export function removeFuelPoint(D, i) {
  if (D.fuel_curve.length <= 2) return false;
  D.fuel_curve.splice(i, 1);
  return true;
}

export function fuelFig(D, c) {
  const xs = Array.from({ length: 19 }, (_, i) => 0.1 + i * 0.05);
  return {
    traces: [{ type: 'scatter', mode: 'lines', name: 'Efficiency', x: xs.map((x) => x * 100), y: xs.map((x) => x / fuelRate(D, x)), line: { color: c.gen, width: 2 }, hovertemplate: '%{x:.0f} %: %{y:.2f} kWh/L<extra></extra>' },
      ...(D.fuel_model === 'table' ? [{ type: 'scatter', mode: 'markers', name: 'Datasheet points', x: D.fuel_curve.map((p) => p[0] * 100), y: D.fuel_curve.map((p) => p[1]), marker: { color: c.gen, size: 9 } }] : [])],
    layout: { xaxis: { title: { text: 'Loading (% of rating)' } }, yaxis: { title: { text: 'kWh per litre' } }, showlegend: false,
      shapes: [{ type: 'line', x0: D.min_load * 100, x1: D.min_load * 100, yref: 'paper', y0: 0, y1: 1, line: { color: c.unmet, dash: 'dot', width: 1.5 } }] },
  };
}

// A monthly fuel record typed or pasted: blank, zero or not a number is a month without a record (null)
export const recValue = (s) => { const t = String(s).trim(), v = Number(t); return t !== '' && isFinite(v) && v > 0 ? v : null; };
// Values pasted from a spreadsheet row or column: cells split on tabs and line breaks (blank cells kept, so only the final line
// break is dropped), thousands separators dropped. Null when it is a single value (the browser pastes that one itself).
export function pasteCells(text) {
  const cells = /[\t\n]/.test(text) ? text.replace(/\r?\n$/, '').split(/\t|\r?\n/) : text.trim().split(/[\s;]+/);
  return cells.length < 2 ? null : cells.map((c) => c.replace(/[,\s]/g, ''));
}
// Put pasted cells into the twelve records from month m0 on
export function pasteRecords(rec, m0, cells) {
  cells.slice(0, 12 - m0).forEach((c, k) => { rec[m0 + k] = recValue(c); });
}
