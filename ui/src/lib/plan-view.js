// Plain logic of the Optimisation and Forecast & EMS pages (no browser needed, tests in ui/tests/plan.test.js): the optimiser request,
// the suggested ranges, the sizes applied from a result, the forecast figures and the day-ahead schedule (tiles, chart, table, CSV).
import { fmtNum, fmtPct, fmtEnergy } from './format.js';
import { HOURS, MONTHS, dateOfHour, sum } from './series.js';
import { optionLabel } from './ws/util.js';
import { projectKey } from './ws/diff.js';
import { PV_FC_METHODS, LOAD_FC_METHODS } from './schema/consts.js';
import { fleetUnits } from './fleet-view.js';

export { projectKey };

// Overrides for the engine project that leave out what the NPC of a design without a battery does not depend on: the sizes the
// optimiser varies, the dispatch (every strategy reduces to load following without a battery) and the financing.
export function sizingOverrides(P) {
  return { name: '', pv: { ...P.pv, capacity_kwp: 0 }, bess: { ...P.bess, energy_kwh: 0, power_kw: 0 },
    wind: { ...P.wind, units: 0 }, diesel: { ...P.diesel, strategy: '', cc_setpoint: 0 }, finance: null };
}

// Numbers typed in a text field, separated by commas, semicolons or spaces, that pass ok
export const parseNums = (s, ok) => (s || '').split(/[,;\s]+/).filter((x) => x !== '').map(Number).filter((x) => isFinite(x) && ok(x));

// The optimiser settings sent to the engine: C-rates and sensitivity values parsed from their text fields
export function optSettings(O) {
  const positive = (x) => x > 0, cr = parseNums(O.c_rates_text, positive);
  // rates can be zero or negative; fade, replacement price, degradation and O&M can be zero
  const sensOk = O.sens_var === 'discount_rate' || O.sens_var === 'fuel_escalation' ? () => true
    : ['bess_calendar_fade', 'bess_replace_kwh', 'bess_prices_scale', 'pv_degradation', 'diesel_om_unit_hour'].includes(O.sens_var) ? (x) => x >= 0 : positive;
  return { ...O, c_rates: cr.length ? cr : [0.5], sens_values: O.sens_var ? parseNums(O.sens_values_text, sensOk) : [] };
}

// Search ranges from the load: PV up to 120 % of the annual load, the battery up to 12 h of average load (rounded to 100).
// Sets them on P.optimizer and returns the toast text, or null when there is no load.
export function suggestRanges(P, pvr) {
  if (!P.load.kw) return null;
  const annual = sum(P.load.kw), sy = pvr ? pvr.specific_yield : 1300, O = P.optimizer;
  O.pv_min = 0; O.pv_max = Math.round(1.2 * annual / sy / 100) * 100;
  if (O.max_pv_kwp > 0) O.pv_max = Math.min(O.pv_max, O.max_pv_kwp);
  O.bess_min = 0; O.bess_max = Math.round(annual / 365 * 0.5 / 100) * 100;
  return `Ranges: PV 0–${fmtNum(O.pv_max)} kWp (≈120 % of annual load), BESS 0–${fmtNum(O.bess_max)} kWh (12 h of average load)`;
}

// Puts the sizes of an optimiser result in the project; returns the toast text
export function applySizes(P, r) {
  P.pv.capacity_kwp = Math.round(r.pv_kwp); P.bess.energy_kwh = Math.round(r.bess_kwh); P.bess.power_kw = Math.round(r.bess_kw);
  if (r.wind_units != null) P.wind.units = Math.round(r.wind_units);
  return `Applied PV ${fmtNum(r.pv_kwp)} kWp, BESS ${fmtNum(r.bess_kwh)} kWh / ${fmtNum(r.bess_kw)} kW. Simulating…`;
}

// ---------------------------------------------------------------- forecast vs actual
export function forecastTiles(sim, P) {
  const F = sim.result.forecast, pred = P.diesel.strategy === 'predictive';
  return [
    ['PV forecast error, hour-ahead', fmtPct(F.pv_nmae_h1), 'MAE / mean PV · ' + optionLabel(PV_FC_METHODS, P.ems.pv_forecast), true],
    ['PV forecast error, day-ahead', fmtPct(F.pv_nmae_da), 'bias ' + fmtPct(F.pv_bias_da)],
    ['Load forecast error, hour-ahead', fmtPct(F.load_nmae_h1), 'MAE / mean load · ' + optionLabel(LOAD_FC_METHODS, P.ems.load_forecast)],
    ['Load forecast error, day-ahead', fmtPct(F.load_nmae_da), 'bias ' + fmtPct(F.load_bias_da)],
    ['EMS re-plans (year 1)', pred ? fmtNum(F.plans) : 'n/a', pred ? `every ${P.ems.replan} h, ${P.ems.horizon} h horizon` : 'select Predictive EMS'],
    ['Net-load forecast error', pred ? fmtEnergy(F.net_error_kwh) : 'n/a', 'sum of |error|, year 1'],
    ['Battery compensation', pred ? fmtEnergy(F.bess_compensation_kwh) : 'n/a', 'deviation from plan to avoid unplanned starts'],
  ];
}

// The 168 hours of week `w` (0-51)
export const weekHours = (w) => { const s = Math.min(w * 168, HOURS - 168); return Array.from({ length: 168 }, (_, i) => s + i); };

export function forecastFig(sim, v, week, c) {
  const H = sim.result.hourly, idx = weekHours(week);
  // the load forecasts are of the site load, so the actual leaves out the auxiliaries (only the week shown is computed)
  const act = v === 'pv' ? (h) => H.pv_avail[h] : H.aux ? (h) => H.load[h] - H.aux[h] : (h) => H.load[h];
  const h1 = v === 'pv' ? H.pv_fc_h1 : H.load_fc_h1, da = v === 'pv' ? H.pv_fc_da : H.load_fc_da;
  const actName = v === 'load' && H.aux && H.aux.some((x) => x > 0) ? 'Actual site load' : 'Actual';
  const ticks = idx.filter((h) => h % 24 === 0);
  const traces = [
    { type: 'scatter', mode: 'lines', name: actName, x: idx, y: idx.map(act), line: { color: v === 'pv' ? c.pv : c.load, width: 2.5 } },
    { type: 'scatter', mode: 'lines', name: 'Hour-ahead forecast', x: idx, y: idx.map((h) => h1[h]), line: { color: c.gen, width: 1.5 } },
    { type: 'scatter', mode: 'lines', name: 'Day-ahead forecast', x: idx, y: idx.map((h) => da[h]), line: { color: c.soc, width: 1.5, dash: 'dash' } },
  ].map((t) => ({ ...t, hovertemplate: '%{y:,.0f} kW<extra>' + t.name + '</extra>' }));
  return { traces, layout: { hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour) }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } } };
}

// The planned and the actual battery state of charge; null unless the predictive EMS ran with a battery
export function planFig(sim, P, week, c) {
  if (P.diesel.strategy !== 'predictive' || !(P.bess.energy_kwh > 0)) return null;
  const H = sim.result.hourly, idx = weekHours(week), ticks = idx.filter((h) => h % 24 === 0);
  return {
    traces: [
      { type: 'scatter', mode: 'lines', name: 'Actual SOC', x: idx, y: idx.map((h) => H.soc[h] * 100), line: { color: c.soc, width: 2.5 } },
      { type: 'scatter', mode: 'lines', name: 'EMS target', x: idx, y: idx.map((h) => H.soc_target[h] * 100), line: { color: c.soc, width: 1.5, dash: 'dash' } },
      { type: 'scatter', mode: 'lines', name: 'Gensets online', x: idx, y: idx.map((h) => H.gen_units[h]), yaxis: 'y2', line: { color: c.gen, width: 2, shape: 'hv' } },
    ],
    layout: { hovermode: 'x unified', xaxis: { tickvals: ticks, ticktext: ticks.map(dateOfHour), anchor: 'y2' },
      yaxis: { title: { text: 'SOC (%)' }, domain: [0.38, 1], range: [0, 100] }, yaxis2: { title: { text: 'Units' }, domain: [0, 0.3], rangemode: 'tozero' } },
  };
}

// ---------------------------------------------------------------- day-ahead schedule
// A time stamp shifted to the site's local time: "05 Mar 14:00"
export function localLabel(iso, off) {
  const d = new Date(Date.parse(iso + ':00Z') + off * 3600e3);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Hours from a row's time_utc to the start of its hour: -1 for Open-Meteo (stamps the end of the hour), 0 for MET Norway.
export function schedLead(S) {
  const l = S.plan_start_utc && S.rows.length ? (Date.parse(S.plan_start_utc + ':00Z') - Date.parse(S.rows[0].time_utc + ':00Z')) / 3600e3 : 0;
  return Number.isFinite(l) ? l : 0;
}

// Hours the forecast's model run was updated before it was fetched (MET Norway), or null
export const schedAge = (S) => {
  const a = S.model_updated_utc && S.issued_utc ? (Date.parse(S.issued_utc) - Date.parse(S.model_updated_utc)) / 3600e3 : null;
  return a != null && isFinite(a) ? a : null;
};

// The text next to the button once a schedule is planned, and the warning above it when the forecast is old
export function schedStatus(S) {
  const rows = S.rows, off = S.utc_offset, age = schedAge(S);
  const at = (iso) => (iso ? localLabel(iso.slice(0, 16), off) : '–');
  return `✓ ${rows.length} h planned. Forecast from ${S.provider}, fetched ${at(S.issued_utc)}${age != null ? `; model run updated ${fmtNum(age, 1)} h earlier` : ''}. ` +
    `Plan from ${at(S.plan_start_utc)}; the SOC you entered applies at that time. ${S.note}`;
}
export const schedWarning = (S) => { const age = schedAge(S); return age > 12 ? `⚠ The ${S.provider} model run was updated ${fmtNum(age, 1)} h before the forecast was fetched, so the forecast may be out of date. Fetch it again later.` : ''; };

export function schedTiles(S, P) {
  const rows = S.rows, T = S.totals, wind = P.wind.units > 0;
  return [
    ['Planned fuel', fmtNum(T.fuel_l, 0) + ' L', `next ${rows.length} h`, true], ['PV used', fmtEnergy(T.pv_used_kwh), fmtPct(T.pv_used_kwh / T.load_kwh) + ' of load'],
    ...(wind ? [['Wind used', fmtEnergy(T.wind_used_kwh), fmtPct(T.wind_used_kwh / T.load_kwh) + ' of load']] : []),
    ['Diesel energy', fmtEnergy(T.gen_kwh), ''], [wind ? 'PV and wind curtailed' : 'PV curtailed', fmtEnergy(T.curtail_kwh), ''],
    ...(T.grid_kwh != null ? [['Grid import', fmtEnergy(T.grid_kwh), `export ${fmtEnergy(T.export_kwh)}`]] : []),
    ['Peak units online', fmtNum(rows.reduce((m, r) => Math.max(m, r.units), -Infinity)), 'of ' + fleetUnits(P.diesel)],
  ];
}

// Each row by the start of its hour, as "Plan from"
export const schedLabels = (S) => { const lead = schedLead(S); return S.rows.map((r) => localLabel(r.time_utc, S.utc_offset + lead)); };

export function schedFig(S, P, c) {
  const rows = S.rows, wind = P.wind.units > 0, x = schedLabels(S);
  return {
    traces: [
      { type: 'bar', name: 'Diesel', x, y: rows.map((r) => r.gen_kw), marker: { color: c.gen } },
      { type: 'bar', name: 'Battery (+ discharge / − charge)', x, y: rows.map((r) => r.bess_kw), marker: { color: c.bess } },
      ...(rows.length && rows[0].grid_kw != null ? [{ type: 'bar', name: 'Grid (+ import / − export)', x, y: rows.map((r) => r.grid_kw - r.export_kw), marker: { color: c.text2 } }] : []),
      { type: 'scatter', mode: 'lines', name: 'PV forecast', x, y: rows.map((r) => r.pv_kw), line: { color: c.pv, width: 2 } },
      ...(wind ? [{ type: 'scatter', mode: 'lines', name: 'Wind forecast', x, y: rows.map((r) => r.wind_kw), line: { color: c.wind, width: 2 } }] : []),
      { type: 'scatter', mode: 'lines', name: 'Load forecast', x, y: rows.map((r) => r.load_kw), line: { color: c.load, width: 2, shape: 'hv' } },
      { type: 'scatter', mode: 'lines', name: 'SOC target', x, y: rows.map((r) => r.soc * 100), yaxis: 'y2', line: { color: c.soc, width: 2 } },
      { type: 'scatter', mode: 'lines', name: 'Gensets online', x, y: rows.map((r) => r.units), yaxis: 'y3', line: { color: c.gen, width: 2, shape: 'hv' } },
    ],
    layout: { barmode: 'relative', hovermode: 'x unified', xaxis: { anchor: 'y3', nticks: 16 },
      yaxis: { title: { text: 'kW' }, domain: [0.42, 1] }, yaxis2: { title: { text: 'SOC %' }, domain: [0.2, 0.37], range: [0, 100] },
      yaxis3: { title: { text: 'Units' }, domain: [0, 0.15], rangemode: 'tozero' }, legend: { orientation: 'h', y: -0.1 } },
  };
}

export function schedTable(S, P) {
  const wind = P.wind.units > 0, x = schedLabels(S), grid = S.rows.length > 0 && S.rows[0].grid_kw != null;
  return {
    heads: ['Hour from (local)', 'Load kW', 'PV kW', ...(wind ? ['Wind kW'] : []), 'Battery kW', 'SOC', 'Units', 'Diesel kW', ...(grid ? ['Grid in kW', 'Grid out kW'] : []),
      'Curtail kW', 'Fuel L'],
    rows: S.rows.map((r, i) => [x[i], fmtNum(r.load_kw), fmtNum(r.pv_kw), ...(wind ? [fmtNum(r.wind_kw)] : []), fmtNum(r.bess_kw), fmtPct(r.soc, 0), String(r.units),
      fmtNum(r.gen_kw), ...(grid ? [fmtNum(r.grid_kw), fmtNum(r.export_kw)] : []), fmtNum(r.curtail_kw), fmtNum(r.fuel_l)]),
  };
}

export function schedCsv(S) {
  const v = (s) => s || 'none';
  const lines = [`# provider ${v(S.provider)}, fetched UTC ${v(S.issued_utc)}, model updated UTC ${v(S.model_updated_utc)}, plan start UTC ${v(S.plan_start_utc)}, SOC now ${S.soc_now}`,
    'time_utc,time_local,load_kw,pv_kw,wind_kw,bess_kw,soc,units,gen_kw,curtail_kw,fuel_l,start_local' + (S.rows.length && S.rows[0].grid_kw != null ? ',grid_kw,export_kw' : '')];
  // time_utc and time_local are the provider's stamp; start_local is the start of the hour the row covers
  const lead = schedLead(S);
  S.rows.forEach((r) => lines.push([r.time_utc, localLabel(r.time_utc, S.utc_offset), r.load_kw, r.pv_kw, r.wind_kw || 0, r.bess_kw, r.soc, r.units, r.gen_kw, r.curtail_kw, r.fuel_l,
    localLabel(r.time_utc, S.utc_offset + lead), ...(r.grid_kw != null ? [r.grid_kw, r.export_kw] : [])].map((x) => (typeof x === 'number' ? +x.toFixed(3) : x)).join(',')));
  return lines.join('\n');
}
