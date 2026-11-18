// Metered PV output against the yield model: the tables, the monthly chart, the fitted values and the workbook sheet of the PV
// meter card, the report and the workbook. Plain functions over the answer R of the engine's pv_reconcile (docs/ipc.md) and the
// project's P.pv_meter; ui/tests/pvmeter.test.js.
import { MONTHS } from './series.js';
import { fmtNum, fmtPct, fmtEnergy } from './format.js';
import { calPct } from './sim-extra.js';

// A month needs this many of its own running hours for its own soiling (engine MONTH_MIN_H); the monthly profile is offered from
// three such months
const MONTHLY_FROM = 3;

// The statistics: the model as it is over the running hours (outages left out) and over all daylight hours compared, and the model
// with the fitted values over all daylight hours
export const STAT_HEADS = ['', 'Running hours', 'All hours', 'Fitted, constant', 'Fitted, monthly'];
const sets = (R) => [R.stats.running, R.stats.all, R.fit.after, R.fit.after_monthly];
export function statRows(R) {
  const row = (label, f) => [label, ...sets(R).map(f)];
  return [
    row('Hours', (s) => fmtNum(s.hours)),
    row('Meter', (s) => fmtEnergy(s.meter_kwh)),
    row('Model', (s) => fmtEnergy(s.model_kwh)),
    row('MBE', (s) => `${calPct(s.mbe)} (${fmtNum(s.mbe_kw, 1)} kW)`),
    row('RMSE', (s) => `${fmtNum(s.rmse_kw, 1)} kW (${fmtPct(s.nrmse)})`),
    row('R²', (s) => fmtNum(s.r2, 3)),
  ];
}

// The project's soiling as text: one value or "monthly"
const soilText = (P0) => (Array.isArray(P0.soiling_monthly) ? 'a monthly profile' : fmtPct(P0.soiling));

// What the card and the report say about the fit
export function fitView(R) {
  const F = R.fit, P0 = R.project, own = F.own_month.filter(Boolean).length;
  const gain = (g) => (g >= 0 ? `${fmtPct(g)} lower` : `${fmtPct(-g)} higher`);
  return {
    monthly: own >= MONTHLY_FROM,
    own,
    lines: [
      `${fmtNum(R.hours)} h of the meter compared, ${fmtNum(R.daylight_h)} of them in daylight; ${fmtNum(R.outage_h)} h look like outages (no output with 200 W/m² or more of sun) and are left out of the soiling fit.`,
      `Fitted soiling ${fmtPct(F.soiling)}${F.at_bound ? ' (at the 0 to 30 % limit)' : ''} against the project's ${soilText(P0)}; availability ${fmtPct(F.availability)} against ${fmtPct(P0.availability)}.`,
      `With them the RMSE over all daylight hours is ${gain(F.rmse_gain)}${own >= MONTHLY_FROM ? `, with the monthly soiling ${gain(F.rmse_gain_monthly)}` : ''}.`,
    ],
  };
}

// The monthly bars: meter, model and the model with the fitted constant soiling, in kWh or MWh. A month without data has no bars.
export function meterFig(R, c, kwp) {
  const k = kwp >= 1000 ? 1000 : 1, unit = k > 1 ? 'MWh' : 'kWh';
  const y = (f) => R.monthly.map((x) => (x.hours ? f(x) / k : null));
  const bar = (name, v, color, extra = {}) => ({ type: 'bar', name, x: MONTHS, y: v, marker: { color, cornerradius: 3 }, hovertemplate: `%{x}: %{y:,.1f} ${unit}<extra>${name}</extra>`, ...extra });
  return {
    traces: [
      bar('Meter', y((x) => x.meter_kwh), c.load),
      bar('Model', y((x) => x.model_kwh), c.pv, { customdata: R.monthly.map((x) => (x.dev == null ? 'no meter data' : calPct(x.dev) + ' vs meter')),
        hovertemplate: `%{x}: %{y:,.1f} ${unit}, %{customdata}<extra>Model</extra>` }),
      bar('Fitted', y((x) => x.fit_kwh), c.muted),
    ],
    layout: { barmode: 'group', yaxis: { title: { text: `PV output on the hours compared (${unit})` } } },
  };
}

// The monthly table: month, hours, outage hours, meter, model, model ÷ meter − 1
export const MONTH_HEADS = ['Month', 'Hours', 'Outage h', 'Meter', 'Model', 'Model vs meter', 'Fitted soiling'];
export function monthRows(R) {
  return R.monthly.filter((x) => x.hours).map((x) => {
    const i = R.monthly.indexOf(x);
    return [MONTHS[i], fmtNum(x.hours), fmtNum(x.outage_h), fmtEnergy(x.meter_kwh), fmtEnergy(x.model_kwh), calPct(x.dev), R.fit.own_month[i] ? fmtPct(R.fit.soiling_monthly[i]) : '–'];
  });
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

// The PV inputs Apply sets ('constant' or 'monthly' soiling, and the availability) and the values they replace, for Undo
export function applyValues(R, pv, mode) {
  const F = R.fit, monthly = mode === 'monthly';
  const values = { soiling: round4(F.soiling), soiling_monthly: monthly ? F.soiling_monthly.map(round4) : null, availability: round4(F.availability) };
  const prev = { soiling: pv.soiling, soiling_monthly: Array.isArray(pv.soiling_monthly) ? [...pv.soiling_monthly] : null, availability: pv.availability };
  return { values, prev };
}

// Undo is offered while the PV inputs still hold the applied values
export function canUndo(A, pv) {
  if (!A || !A.values) return false;
  const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b || (a == null && b == null));
  return same(pv.soiling, A.values.soiling) && same(pv.availability, A.values.availability) && same(pv.soiling_monthly, A.values.soiling_monthly);
}

// One line on the meter file of the project (P.pv_meter)
export function meterLine(M) {
  if (!M || !Array.isArray(M.kw)) return '';
  const n = M.kw.filter((x) => x != null).length, I = M.import, R = I && I.report;
  return `${(I && I.file) || 'Meter file'}: ${fmtNum(n)} h${R && R.period ? ` of ${R.period}` : ''}${R && R.interval_min ? `, logged every ${fmtNum(R.interval_min)} min` : ''}.`;
}

// The workbook sheet "PV meter"
export function meterSheet(R, M) {
  const F = R.fit, P0 = R.project;
  /** @type {any[][]} */
  const rows = [['Month', 'Hours compared', 'Outage hours', 'Meter kWh', 'Model kWh', 'Model ÷ meter − 1', 'Fitted kWh', 'Fitted monthly kWh', 'Fitted soiling']];
  R.monthly.forEach((x, i) => rows.push([MONTHS[i], x.hours, x.outage_h, x.meter_kwh, x.model_kwh, x.dev, x.fit_kwh, x.fit_monthly_kwh, F.own_month[i] ? F.soiling_monthly[i] : null]));
  rows.push([], ['Statistic', 'Running hours, model', 'All daylight hours, model', 'All daylight hours, fitted constant soiling', 'All daylight hours, fitted monthly soiling']);
  const S = sets(R);
  for (const [k, l] of [['hours', 'Hours'], ['meter_kwh', 'Meter kWh'], ['model_kwh', 'Model kWh'], ['mbe_kw', 'MBE kW'], ['mbe', 'MBE (share of the mean meter output)'],
    ['rmse_kw', 'RMSE kW'], ['nrmse', 'nRMSE (share of the mean meter output)'], ['r2', 'R²']]) rows.push([l, ...S.map((s) => s[k])]);
  rows.push([], ['Fit', 'Value', 'Project']);
  rows.push(['Soiling', F.soiling, Array.isArray(P0.soiling_monthly) ? 'monthly' : P0.soiling], ['Soiling at the 0 to 30 % limit', F.at_bound ? 'yes' : 'no', ''],
    ['Availability', F.availability, P0.availability], ['RMSE change, constant soiling', -F.rmse_gain, ''], ['RMSE change, monthly soiling', -F.rmse_gain_monthly, ''],
    ['Outage hours', R.outage_h, ''], ['File', (M && M.import && M.import.file) || '', '']);
  if (M && M.applied) rows.push(['Applied to the project', M.applied.mode === 'monthly' ? 'monthly soiling and availability' : 'soiling and availability', '']);
  rows.push(['Basis', 'hours present in the file and the model; outage: GHI of 200 W/m² or more with the meter at 1 % of the model or less; MBE and RMSE as model − meter', '']);
  (R.notes || []).forEach((n) => rows.push(['Note', n, '']));
  return rows;
}
