// The words of the CSV import report and of the data checks: what the import found, unit hints, the timing check, notes on a data
// set, the quality summary for the report and the flag rows of the workbook (plain functions; ui/tests/tsimport.test.js).
import { fmtNum, fmtPct, fmtPower } from '../format.js';
import { HOURS, dateOfHour, sum } from '../series.js';

export const BASIS_TEXT = { utc: 'UTC', local_standard: 'local standard time', local_clock: 'local clock time with daylight saving' };
export const LABEL_TEXT = { start: 'the start of each interval', end: 'the end of each interval', instant: 'instantaneous samples' };
export const KIND_TEXT = { load: 'load', weather: 'weather' };
export const days = (n) => `${fmtNum(n)} day${n === 1 ? '' : 's'}`;
export const hourText = (h) => `${dateOfHour(h)} ${String(h % 24).padStart(2, '0')}:00`;
const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

// Unit hints from the imported values: a load peak far from the genset fleet, implausible irradiance, temperature or wind.
export function unitHints(kind, res, diesel) {
  const out = [];
  if (kind === 'load' && res.kw) {
    const peak = maxOf(res.kw), unit = +diesel.unit_kw || 0, fleet = (+diesel.units || 0) * unit, fits = (x) => x >= 0.2 * unit && x <= fleet;
    if (fleet > 0 && peak > fleet) out.push(`The peak load, ${fmtPower(peak)}, is above the genset fleet (${fmtPower(fleet)})${fits(peak / 1000) ? ': a file in W read as kW would do this (choose W)' : ''}.`);
    if (fleet > 0 && peak < 0.2 * unit) {
      const why = [];
      if (fits(peak * 4)) why.push('kWh per 15-min interval read as kW (four times too small)');
      if (fits(peak * 2)) why.push('kWh per 30-min interval read as kW (half)');
      if (fits(peak * 1000)) why.push('MW read as kW');
      out.push(`The peak load, ${fmtPower(peak)}, is below a fifth of one genset (${fmtPower(unit)})${why.length ? ': check the unit, for example ' + why.join(', or ') : ''}.`);
    }
  }
  if (kind === 'weather' && res.ghi) {
    const g = sum(res.ghi) / 1000, t = res.tamb && res.tamb.length ? sum(res.tamb) / res.tamb.length : null, w = res.wind && res.wind.length ? sum(res.wind) / res.wind.length : null;
    if (g < 700 || g > 2700) out.push(`Annual GHI is ${fmtNum(g)} kWh/m², outside 700–2,700 kWh/m²: check the irradiance unit (energy per interval read as W/m², or the reverse) and the GHI column.`);
    if (t != null && t > 150) out.push(`The mean temperature is ${fmtNum(t, 1)} °C: the column looks like kelvin.`);
    if (w != null && w > 20) out.push(`The mean wind speed is ${fmtNum(w, 1)} m/s: the column looks like km/h.`);
  }
  return out;
}

function runsText(R, n) {
  const runs = R.runs || [];
  return runs.slice(0, n).map(([h, len]) => `${hourText(h)} (${len} h)`).join(', ') + (runs.length > n ? ', …' : '');
}

// Import report as table rows [label, text]: rows read, interval, period, coverage, gaps.
export function reportRows(R) {
  const rows = [];
  if (R.positional) rows.push(['Rows', `${fmtNum(R.parsed)} values, one per ${R.interval_min} min from 1 January 00:00 (no time column)`]);
  else {
    rows.push(['Rows read', `${fmtNum(R.parsed)} of ${fmtNum(R.rows)}${R.header_lines ? `, after ${R.header_lines} header line${R.header_lines > 1 ? 's' : ''}` : ''}`]);
    if (R.n_bad) rows.push(['Rows not read', `${fmtNum(R.n_bad)} without a readable time or value (lines ${R.bad_rows.join(', ')}${R.n_bad > R.bad_rows.length ? ', …' : ''})`]);
    if (R.duplicates) rows.push(['Duplicate stamps', `${fmtNum(R.duplicates)}, averaged`]);
    if (R.out_of_order) rows.push(['Out of order', `${fmtNum(R.out_of_order)} rows, sorted`]);
    rows.push(['Interval', `${R.interval_min} min, stamps mark ${LABEL_TEXT[R.label] || R.label}; dates ${R.excel ? 'as Excel serial days' : { ymd: 'year, month, day', dmy: 'day, month, year', mdy: 'month, day, year' }[R.date_order] || ''}`]);
    (R.rate_changes || []).forEach((c) => rows.push(['Other interval', `${c.interval_min} min in ${fmtNum(c.rows)} steps${c.ranges.length ? ': ' + c.ranges.map(([a, b]) => `${a} to ${b}`).join('; ') : ''}`]));
    rows.push([`First and last sample (${R.base})`, `${R.first} to ${R.last}`]);
  }
  rows.push(['Period used', R.period]);
  rows.push(['Coverage', `${fmtPct(R.coverage)} of the 8,760 h`]);
  rows.push(['Missing hours', R.missing_h ? `${fmtNum(R.missing_h)} (below half covered)${R.runs && R.runs.length ? ': ' + runsText(R, 6) : ''}` : 'none']);
  if (R.missing && Object.keys(R.missing).length > 1) rows.push(['Missing by column', Object.entries(R.missing).map(([k, v]) => `${k.toUpperCase()} ${fmtNum(v)} h`).join(', ')]);
  rows.push(['Filled hours', `${fmtNum(R.filled_h)}, longest gap ${fmtNum(R.max_gap_h)} h`]);
  return rows;
}

// What the project keeps of an import (P.load.import, P.weather.import)
export function importInfo(kind, file, sent, R) {
  return { file, interval_min: R.interval_min, label: R.label, basis: sent.basis,
    units: kind === 'load' ? sent.units : { irradiance: sent.irr_units, temperature: sent.temp_units, wind: sent.wind_units }, report: R };
}
export const usedText = (R) => `${R.period}, ${fmtPct(R.coverage)} covered${R.filled_h ? `, ${fmtNum(R.filled_h)} h filled` : ''}`;

// The timing check as text: {text, fix: [[label, action, argument]], ok}.
export function timing(T, W) {
  if (!T || T.median_min == null || T.verdict === 'none') return { text: `Too few clear days (${T ? T.n_days : 0}) to check the timestamps against the sun.`, fix: [], ok: true };
  const m = T.median_min, k = Number.isFinite(+T.shift_h) ? Math.round(+T.shift_h) : 0;
  const base = `On ${T.n_days} clear days the irradiance peaks ${fmtNum(Math.abs(m), 0)} min ${m >= 0 ? 'later' : 'earlier'} than the sun (median; interquartile range ${fmtNum(T.iqr_min, 0)} min)`;
  const clock = T.clock_change ? ` The monthly medians differ by ${fmtNum(T.month_spread_min, 0)} min: the logger clock may have changed during the year.` : '';
  switch (T.verdict) {
    case 'ok': return { text: `${base}: the timestamps match the sun.${clock}`, fix: [], ok: !clock };
    // data late by half an hour are samples at the hour starts: each hour is the mean of its own sample and the next (early: the previous)
    case 'half': return { text: `${base}: instantaneous samples read as hour means, or the reverse.${clock}`, fix: [['Treat as instantaneous samples', 'instant', m > 0 ? 1 : -1]] };
    case 'hours': return { text: `${base}: ${Math.abs(k) > 1 ? `a clock error of ${Math.abs(k)} h` : `${k > 0 ? 'interval-end stamps read as interval-start' : 'interval-start stamps read as interval-end'}, or a clock error of 1 h`}.${clock}`,
      fix: [[`Shift ${Math.abs(k)} h ${k > 0 ? 'earlier' : 'later'}`, 'shift', k]] };
    case 'utc': return { text: `${base}: about the UTC offset of the site, so the timestamps are ${W && W.is_utc ? 'local time, not UTC' : 'UTC, not local time'}.${clock}`,
      fix: [[`Timestamps are ${W && W.is_utc ? 'local time' : 'UTC'}`, 'utc', 0]] };
    default: return { text: `${base}: this matches no known timing error; check the timestamps.${clock}`, fix: [] };
  }
}

// Notes on the whole data set (absent columns, annual GHI, units, level shifts).
export function setNotes(Q) {
  return ((Q && Q.set) || []).map((s) => {
    if (s.id === 't_absent') return s.value == null ? 'No temperature data.' : `No temperature data: ${fmtNum(s.value, 1)} °C in every hour (module temperature and the battery auxiliaries follow it).`;
    if (s.id === 'wind_absent') return s.value == null ? 'No wind speed data: the module temperature assumes 1 m/s and wind turbines produce nothing.' : `Wind speed is ${fmtNum(s.value, 1)} m/s in every hour.`;
    if (s.id === 'ghi_annual') return `Annual GHI is ${fmtNum(s.kwh_m2)} kWh/m², outside 700–2,700 kWh/m²: check the irradiance unit and the interval.`;
    if (s.id === 'units') {
      const H = { w: 'a file in W read as kW', kwh_15min: 'kWh per 15-min interval read as kW (×4)', kwh_30min: 'kWh per 30-min interval read as kW (×2)', mw: 'MW read as kW (×1,000)' };
      return `The peak load, ${fmtPower(s.peak_kw)}, is ${s.above ? `above the genset fleet (${fmtPower(s.fleet_kw)})` : `below a fifth of one genset (${fmtPower(s.unit_kw)})`}${s.hints.length ? ': ' + s.hints.map((h) => H[h] || h).join(', or ') + ' would do this; import the file again with the right unit' : ''}.`;
    }
    if (s.id === 'level_shift') return 'Level shift' + (s.shifts.length > 1 ? 's' : '') + ' of the daily mean load: ' + s.shifts.map((x) =>
      `${dateOfHour(x.day * 24)} from ${fmtPower(x.before_kw)} to ${fmtPower(x.after_kw)} (${x.after_kw >= x.before_kw ? '+' : '−'}${fmtNum(Math.abs(x.after_kw / x.before_kw - 1) * 100, 0)} %)`).join('; ') +
      '. A new process or a meter change; use the period that represents the future load.';
    return s.id;
  });
}

const SHORT = { night: 'Irradiance at night', dropout: 'Zero GHI in daylight', ghi_limit: 'GHI above the limit', dhi_limit: 'DHI above the limit', dhi_gt_ghi: 'DHI above GHI', closure: 'Components do not add up', beam_gt_ghi: 'Beam above GHI',
  flat_ghi: 'GHI stuck', copy_ghi: 'GHI repeated', t_range: 'Temperature out of range', t_step: 'Temperature step', flat_t: 'Temperature stuck',
  copy_t: 'Temperature repeated', wind_range: 'Wind speed out of range', flat_wind: 'Wind speed stuck', outage: 'Near-zero load', flat: 'Load stuck',
  linear: 'Linear infill', spike: 'Spike' };
const FLAG_UNIT = { dhi_limit: 'W/m²', dhi_gt_ghi: 'W/m²', t_range: '°C', t_step: '°C', flat_t: '°C', copy_t: '°C', wind_range: 'm/s', flat_wind: 'm/s' };
export const unitOf = (kind, id) => (kind === 'load' ? 'kW' : FLAG_UNIT[id] || 'W/m²');
export const flagName = (id) => SHORT[id] || id;

// One line on the imported file (or the downloaded weather) for the page.
export function sourceLine(kind, D) {
  const I = D && D.import, R = I && I.report;
  if (!R) return kind === 'weather' && D ? `${D.source || 'Weather'}${D.years ? ', ' + D.years : ''}${D.n_filled ? `: ${fmtNum(D.n_filled)} h filled, longest gap ${fmtNum(D.max_gap_h)} h` : ''}.` : '';
  return `Imported from ${I.file}: ${R.interval_min}-min data, stamps mark ${LABEL_TEXT[I.label] || I.label}, ${BASIS_TEXT[I.basis] || I.basis}; ${R.period}, ${fmtPct(R.coverage)} covered, ${fmtNum(R.filled_h)} h filled, longest gap ${fmtNum(R.max_gap_h)} h.`;
}

// The Data checks block of a page as data, or null when the data set has none to show (no weather; a load that is not measured).
export function pageView(kind, P) {
  const D = kind === 'load' ? P.load : P.weather;
  if (!D || (kind === 'load' && (P.load.source !== 'csv' || !P.load.kw))) return null;
  const Q = D.qc, weather = kind === 'weather', v = { kind, weather, line: sourceLine(kind, D), Q };
  if (!Q) return v;
  v.flags = Q.flags.filter((f) => f.hours > 0);
  v.notes = setNotes(Q);
  v.timing = weather ? timing(Q.timing, D) : null;
  v.hours = Q.hours.map((x) => ({ when: hourText(x.h), flag: flagName(x.flag), value: `${fmtNum(x.v, 1)} ${unitOf(kind, x.flag)}` }));
  return v;
}

// Timing fixes of the weather: roll every series by k hours (k > 0: earlier), take each hour as the mean of instantaneous samples at
// its two ends (x = +1: this hour and the next; -1: the previous), or toggle the UTC flag. Changes W; returns what was done.
export function applyFix(W, what, x) {
  const keys = ['ghi', 'dni', 'dhi', 'tamb', 'wind'].filter((k) => Array.isArray(W[k]) && W[k].length === HOURS), at = (v, i) => v[((i % HOURS) + HOURS) % HOURS];
  let done;
  if (what === 'shift') { keys.forEach((k) => { const v = W[k]; W[k] = v.map((_, i) => at(v, i + x)); }); done = `shifted ${Math.abs(x)} h ${x > 0 ? 'earlier' : 'later'}`; }
  else if (what === 'instant') { keys.forEach((k) => { const v = W[k]; W[k] = v.map((y, i) => (y + at(v, i + x)) / 2); }); done = 'each hour taken as the mean of the samples at its start and end'; }
  else { W.is_utc = !W.is_utc; done = `timestamps taken as ${W.is_utc ? 'UTC' : 'local standard time'}`; }
  W.note = `${W.note || ''} After the data checks: ${done}.`.trim();
  W.qc = null;
  return done;
}

// Data quality of the weather or a measured load for the report: [label, value] rows, flag rows [label, hours, days, share of GHI]
// and notes; null without such data.
export function quality(kind, P) {
  const D = kind === 'load' ? P.load : P.weather;
  if (!D || (kind === 'load' ? P.load.source !== 'csv' || !P.load.kw : !D.ghi)) return null;
  const I = D.import, R = I && I.report, Q = D.qc, rows = [];
  rows.push(['Source', I ? I.file : kind === 'weather' ? D.source || '' : 'Measured profile (CSV)']);
  if (R) {
    rows.push(['Interval', `${R.interval_min} min, stamps mark ${LABEL_TEXT[I.label] || I.label}, ${BASIS_TEXT[I.basis] || I.basis}`], ['Period', R.period],
      ['Coverage', fmtPct(R.coverage)], ['Filled hours', fmtNum(R.filled_h)], ['Longest gap', fmtNum(R.max_gap_h) + ' h']);
    if (R.duplicates || R.out_of_order || R.n_bad) rows.push(['Rows', `${fmtNum(R.duplicates || 0)} duplicate stamps averaged, ${fmtNum(R.out_of_order || 0)} out of order, ${fmtNum(R.n_bad || 0)} not read`]);
  } else if (kind === 'weather') {
    rows.push(['Interval', '60 min'], ['Period', D.years || '–']);
    if (D.n_filled != null) rows.push(['Filled hours', fmtNum(D.n_filled)], ['Longest gap', fmtNum(D.max_gap_h || 0) + ' h']);
  }
  const fl = Q ? Q.flags.filter((f) => f.hours > 0) : [];
  rows.push(['Flags', !Q ? 'data checks not run' : fl.length ? `${fmtNum(Q.n_flagged)} h on ${days(Q.days.length)}; ${fmtPct(Q.score)} of the days without a flag` : 'none']);
  const T = Q && kind === 'weather' ? timing(Q.timing, D) : null;
  if (T) rows.push(['Timing', T.text]);
  return { rows, flags: fl.map((f) => [f.label, fmtNum(f.hours), fmtNum(f.days), kind === 'weather' ? fmtPct(f.ghi_share, 2) : null]), notes: setNotes(Q), timingOk: !T || T.ok };
}

// Workbook rows: one per flagged hour of each data set (data set, hour, local date, flag, value), then the flag counts.
export function sheetRows(P) {
  const sets = [['Weather', P.weather && P.weather.qc, 'weather'], ['Load', P.load.source === 'csv' && P.load.qc, 'load']].filter((x) => x[1]);
  if (!sets.length) return null;
  const rows = [['Data set', 'Hour of the year (local)', 'Local date and hour', 'Flag', 'Value', 'Unit']], tail = [[], ['Data set', 'Flag', 'Hours', 'Days', 'Share of GHI']];
  for (const [name, Q, kind] of sets) {
    const label = Object.fromEntries(Q.flags.map((f) => [f.id, f.label]));
    Q.hours.forEach((x) => rows.push([name, x.h, hourText(x.h), label[x.flag] || x.flag, x.v, unitOf(kind, x.flag)]));
    if (Q.n_list > Q.hours.length) rows.push([name, null, null, `The first ${Q.hours.length} of ${Q.n_list} flagged hours are listed`]);
    Q.flags.forEach((f) => tail.push([name, f.label, f.hours, f.days, kind === 'weather' ? f.ghi_share : null]));
    tail.push([name, 'Days without a flag', null, 365 - Q.days.length]);
    setNotes(Q).forEach((t) => tail.push([name, 'Note', t]));
    if (kind === 'weather') tail.push([name, 'Timing', timing(Q.timing, P.weather).text]);
  }
  return rows.concat(tail);
}
