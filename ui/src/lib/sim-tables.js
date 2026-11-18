// Tables of a simulation computed from the hourly series it already has: the gensets by month, the battery state of charge by
// band and season, the renewable fraction by capacity and by peak, and the text of the results check (engine/src/sim/checks.rs).
// Shared by the Simulation results page, the report and the workbook; plain functions (ui/tests/sim-tables.test.js).
import { HOURS, MONTHS, SEASONS, SEASON_OF_MONTH, MDAYS } from './series.js';
import { MONTH_OF_HOUR } from './ws/util.js';
import { fmtNum, fmtPct, fmtSig } from './format.js';
import { fleetKw } from './fleet-view.js';

// Energy in a litre of diesel (lower heating value, about 35.8 MJ/L), as in the results check
export const DIESEL_KWH_PER_L = 9.94;

// Rated kW of the genset fleet the run used: the result's merit order for a mixed fleet, else its units (sized by the optimiser
// or the project's) of the main rating. D: P.diesel
export function runFleetKw(R, D) {
  if (R.fleet) return R.fleet.reduce((a, g) => a + g.units * g.unit_kw, 0);
  return R.size.gen_units != null ? R.size.gen_units * D.unit_kw : fleetKw(D);
}

// ---------------------------------------------------------------- gensets by month
// Year 1 by month and for the year (13 rows): run hours (all units), starts, energy (kWh), fuel (L), capacity factor (energy ÷
// fleet rating × hours), specific fuel (L/kWh) and efficiency (energy ÷ fuel energy). Starts count the units added from one step
// to the next as the engine does, from the steps of a run under an hour; null without genset energy.
export function gensetMonthly(R, D) {
  const H = R.hourly, kw = runFleetKw(R, D);
  if (!H || !(R.years[0].gen_kwh > 0)) return null;
  const rows = MONTHS.map((label, m) => ({ label, hours: 0, starts: 0, kwh: 0, fuel: 0, span: MDAYS[m] * 24 }));
  for (let t = 0; t < HOURS; t++) {
    const x = rows[MONTH_OF_HOUR[t]];
    x.hours += H.gen_units[t]; x.kwh += H.gen_to_load[t] + H.gen_to_bess[t] + H.gen_dump[t]; x.fuel += H.fuel_l[t];
  }
  const S = R.steps && R.steps.gen_units ? R.steps.gen_units : H.gen_units, k = S.length / HOURS;
  for (let i = 0, prev = 0; i < S.length; i++) {
    if (S[i] > prev) rows[MONTH_OF_HOUR[Math.floor(i / k)]].starts += S[i] - prev;
    prev = S[i];
  }
  const year = rows.reduce((a, x) => ({ ...a, hours: a.hours + x.hours, starts: a.starts + x.starts, kwh: a.kwh + x.kwh, fuel: a.fuel + x.fuel, span: a.span + x.span }),
    { label: 'Year', hours: 0, starts: 0, kwh: 0, fuel: 0, span: 0 });
  return rows.concat(year).map((x) => ({ ...x, cf: kw > 0 ? x.kwh / (kw * x.span) : null, sfc: x.kwh > 0 ? x.fuel / x.kwh : null,
    eff: x.fuel > 0 ? x.kwh / (x.fuel * DIESEL_KWH_PER_L) : null }));
}
export const GEN_MONTH_HEADS = ['Month', 'Run hours', 'Starts', 'Energy MWh', 'Fuel kL', 'Capacity factor', 'L/kWh', 'Efficiency'];
export const genMonthCells = (x) => [x.label, fmtNum(x.hours), fmtNum(x.starts), fmtNum(x.kwh / 1000, 1), fmtNum(x.fuel / 1000, 1), fmtPct(x.cf),
  x.sfc == null ? '–' : fmtNum(x.sfc, 3), fmtPct(x.eff)];

// ---------------------------------------------------------------- battery state of charge by band and season
export const SOC_BANDS = Array.from({ length: 10 }, (_, i) => `${i * 10}–${i * 10 + 10} %`);
// Hours of year 1 in each 10 % band of state of charge (at the end of the hour, against the year's capacity), by season and for
// the year: {seasons: [4 x 10], year: [10]}; null without a battery
export function socHistogram(R) {
  const H = R.hourly;
  if (!H || !H.soc || !(R.size.bess_kwh > 1e-6 && R.size.bess_kw > 1e-6)) return null;
  const seasons = SEASONS.map(() => new Array(10).fill(0)), year = new Array(10).fill(0);
  for (let t = 0; t < HOURS; t++) {
    const b = Math.max(0, Math.min(9, Math.floor(H.soc[t] * 10 + 1e-9)));
    seasons[SEASON_OF_MONTH[MONTH_OF_HOUR[t]]][b]++; year[b]++;
  }
  return { seasons, year };
}
export function socHistFigure(c, S) {
  const cols = [c.pv, c.bess, c.gen, c.wind];
  return {
    traces: SEASONS.map((name, s) => ({ type: 'bar', name, x: SOC_BANDS, y: S.seasons[s], marker: { color: cols[s], cornerradius: 3 },
      hovertemplate: `%{x}: %{y:,} h<extra>${name}</extra>` })),
    layout: { barmode: 'group', xaxis: { title: { text: 'State of charge' } }, yaxis: { title: { text: 'Hours' } } },
  };
}

// ---------------------------------------------------------------- renewable fraction three ways
// By energy: the share of the served load not met by the gensets or the grid (year 1, the engine's). By capacity: PV (kWp) and
// wind rating over those plus the genset fleet's rating. By peak: the highest share of the load PV and wind serve directly in
// any hour of year 1. P: the project (wind rating, diesel).
export function reFractions(R, P) {
  const H = R.hourly, re = R.size.pv_kwp + R.size.wind_units * P.wind.rated_kw, all = re + runFleetKw(R, P.diesel);
  let peak = 0;
  if (H) for (let t = 0; t < HOURS; t++) if (H.load[t] > 0) peak = Math.max(peak, (H.pv_to_load[t] + (H.wind_to_load ? H.wind_to_load[t] : 0)) / H.load[t]);
  return { energy: R.re_fraction, capacity: all > 0 ? re / all : 0, peak: H ? Math.min(1, peak) : null };
}
export const reTiles = (F) => [['RE fraction by capacity', fmtPct(F.capacity), 'PV and wind rating ÷ all generating capacity'],
  ['RE fraction by peak', fmtPct(F.peak), 'highest hourly share of the load from PV and wind directly']];

// ---------------------------------------------------------------- results check
// A failed check as one line: label, value, expected range and why. A narrow range shows enough digits to tell value and ends apart.
export function checkText(c) {
  const w = c.lo != null && c.hi != null ? c.hi - c.lo : null;
  const d = w != null && w > 0 && w < 0.05 * Math.max(Math.abs(c.lo), Math.abs(c.hi)) ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(w)) + 1)) : null;
  const f = (x) => (d == null ? fmtSig(x) : fmtNum(x, d)), u = ' ' + c.unit;
  const range = c.lo != null && c.hi != null ? `${f(c.lo)} to ${f(c.hi)}${u}` : c.hi != null ? `at most ${f(c.hi)}${u}` : `at least ${f(c.lo)}${u}`;
  return `${c.label}: ${f(c.value)}${u}, expected ${range}. ${c.why[0].toUpperCase()}${c.why.slice(1)}.`;
}
export const checksOf = (R) => (R.summary && Array.isArray(R.summary.checks) ? R.summary.checks : []);
