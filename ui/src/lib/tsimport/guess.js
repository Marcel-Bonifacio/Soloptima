// The CSV import dialog's reading of a file: preview lines, the columns, date order, units and time basis guessed from them, and
// the options as the engine's import_series takes them (docs/ipc.md). Plain functions over the session `S`
// ({kind, file, delim, lines, tail, hdr, names, ncol, nlines}) and the project facts in `ctx` ({tz, utcOffset, prev, isUtc}).
import { csvSplit, csvDelimOf } from '../csv.js';
import { zoneOffsets, zoneFormat, wallOffset } from '../zone.js';

export const LOAD_UNITS = [['kw', 'kW (mean power)'], ['w', 'W (mean power)'], ['mw', 'MW (mean power)'], ['kwh_interval', 'kWh per interval'], ['mwh_interval', 'MWh per interval']];
export const IRR_UNITS = [['w_m2', 'W/m² (mean)'], ['wh_m2_interval', 'Wh/m² per interval'], ['kwh_m2_interval', 'kWh/m² per interval'], ['mj_m2_interval', 'MJ/m² per interval']];
export const TEMP_UNITS = [['c', '°C'], ['k', 'K']];
export const WIND_UNITS = [['m_s', 'm/s'], ['km_h', 'km/h']];
export const SNOW_UNITS = [['cm', 'cm of snow per interval'], ['mm', 'mm of snow per interval'], ['mm_water', 'mm of water per interval (snow water equivalent)']];
export const RH_UNITS = [['pct', '%'], ['fraction', 'Fraction (0 to 1)']];
export const LABELS = [['auto', 'Detect from the first and last stamps'], ['start', 'Start of the interval'], ['end', 'End of the interval'], ['instant', 'Instant (a sample at the stamp)']];
export const ORDERS = [['auto', 'Detect (a day above 12)'], ['ymd', 'Year, month, day'], ['dmy', 'Day, month, year'], ['mdy', 'Month, day, year']];
// weather columns with the header names the guess looks for (as the positional upload did)
/** @type {[string, string, string[]][]} */
export const WX = [['ghi', 'GHI', ['ghi', 'g(h)', 'globhor', 'global']], ['dni', 'DNI', ['dni', 'gb(n)', 'beam']], ['dhi', 'DHI', ['dhi', 'gd(h)', 'diff']],
  ['tamb', 'Temperature', ['temp', 't2m', 'tamb', 'air_temp', 'ta']], ['wind', 'Wind speed', ['wind', 'ws', 'wspd']],
  ['snow', 'Snowfall', ['snowfall', 'snow', 'precsno']], ['rh', 'Relative humidity', ['rh', 'relative_humidity', 'humidity', 'hum']]];
const DATE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|^\d{8}([:T ]?\d{2}:?\d{2})?$/;
const word = (h, w) => new RegExp(`(^|[^a-z])(${w})([^a-z]|$)`).test(h);

// The first n non-blank lines (from the end with back = true), as the engine and parseCSV skip blank lines.
export function someLines(text, n, back) {
  const out = [];
  if (!back) {
    let p = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (p < text.length && out.length < n) {
      let q = text.indexOf('\n', p);
      if (q < 0) q = text.length;
      const l = text.slice(p, q).replace(/\r$/, '');
      if (l.trim()) out.push(l);
      p = q + 1;
    }
    return out;
  }
  let q = text.length;
  while (q > 0 && out.length < n) {
    const p = text.lastIndexOf('\n', q - 1) + 1, l = text.slice(p, q).replace(/\r$/, '');
    if (l.trim()) out.unshift(l);
    q = p - 1;
  }
  return out;
}

// a cell as a number (decimal comma in semicolon files), or NaN
const numOf = (S, c) => {
  if (c === '' || c == null) return NaN;
  const v = Number(S.delim === ';' ? c.replace(',', '.') : c);
  return isFinite(v) ? v : NaN;
};
const isTime = (c) => DATE_RE.test(c || '');
export const cells = (S, l) => csvSplit(l, S.delim);

// The session for a file: its preview lines, header lines (those before the first line with a date, or without dates with a
// number; the last of them names the columns), column count and line count. `opt` is set by guess().
export function openSession(kind, file, text, ctx) {
  const lines = someLines(text, 20);
  if (!lines.length) throw new Error(`${file} is empty.`);
  const S = { kind, file, delim: csvDelimOf(lines), lines, tail: someLines(text, 40, true), res: null, err: '', stale: false };
  let hdr = lines.findIndex((l) => cells(S, l).some(isTime));
  if (hdr < 0) hdr = Math.max(0, lines.findIndex((l) => cells(S, l).some((c) => isFinite(numOf(S, c)))));
  S.hdr = hdr;
  S.names = hdr ? cells(S, lines[hdr - 1]).map((c) => c.toLowerCase()) : [];
  S.ncol = Math.min(256, Math.max(...lines.map((l) => cells(S, l).length)));
  let n = 0;
  for (let p = -1; (p = text.indexOf('\n', p + 1)) >= 0;) n++;
  S.nlines = text.endsWith('\n') ? n : n + 1;
  S.opt = guess(S, ctx);
  return S;
}

// Columns, date order, units and time basis guessed from the header names and the first rows; the time basis of the previous
// import of the same kind is kept.
export function guess(S, ctx) {
  const rows = S.lines.slice(S.hdr).map((l) => cells(S, l)), r0 = rows[0] || [], r1 = rows[1] || [], names = S.names, kind = S.kind;
  const num = (c) => numOf(S, c), name = (i) => names[i] || '';
  let tc = names.findIndex((h, i) => word(h, 'date|time|timestamp|datetime|date ?time|zeit|datum') && (isTime(r0[i]) || isFinite(num(r0[i]))));
  if (tc < 0) tc = r0.findIndex(isTime);
  if (tc < 0) {   // Excel serial days stepping by an hour, half an hour or a quarter of an hour
    tc = r0.findIndex((c, i) => { const a = num(c), b = num(r1[i]); return a >= 20000 && a <= 80000 && [1 / 24, 1 / 48, 1 / 96].some((s) => Math.abs(b - a - s) < 1e-6); });
  }
  let t2 = -1;
  if (tc >= 0 && !/\d:\d\d/.test(r0[tc] || '') && !/^\d{8}[:T ]?\d{4}$/.test(r0[tc] || '')) {   // a date alone: the time of day in its own column
    t2 = r0.findIndex((c, i) => i !== tc && /^\d{1,2}:\d{2}(:\d{2})?(\s*[ap]m)?$/i.test(c));
  }
  const isVal = (i) => i !== tc && i !== t2 && isFinite(num(r0[i]));
  const vals = Array.from({ length: S.ncol }, (_, i) => i).filter(isVal);
  const prev = ctx.prev || {};
  const o = { time_col: tc, time2_col: t2, date_order: 'auto', year: 'auto', label: 'auto', fill_long: false,
    basis: prev.basis || (kind === 'weather' && ctx.isUtc ? 'utc' : 'local_standard') };
  if (o.basis === 'local_clock' && !clockOk(S, tc, ctx)) o.basis = 'local_standard';
  if (kind === 'load') {
    const named = vals.filter((i) => word(name(i), 'kw|kwh|mw|mwh|w|load|power|demand|p|active power|consumption'));
    const total = named.find((i) => /total|sum/.test(name(i)));
    o.cols = [total != null ? total : named.length ? named[0] : vals.length ? vals[vals.length - 1] : 0];
    const h = name(o.cols[0]);
    o.units = /kwh/.test(h) ? 'kwh_interval' : /mwh/.test(h) ? 'mwh_interval' : word(h, 'mw') ? 'mw' : word(h, 'w') ? 'w' : 'kw';
  } else {
    for (const [k, , keys] of WX) o[k] = names.findIndex((h, i) => i !== tc && i !== t2 && keys.some((n) => h === n || h.startsWith(n)));
    if (o.ghi < 0) o.ghi = vals.length ? vals[0] : -1;
    const g = name(o.ghi), t = name(o.tamb), w = name(o.wind);
    o.irr_units = /kwh\/m/.test(g) ? 'kwh_m2_interval' : /wh\/m/.test(g) ? 'wh_m2_interval' : /mj/.test(g) ? 'mj_m2_interval' : 'w_m2';
    o.temp_units = /kelvin|\(k\)|\[k\]/.test(t) ? 'k' : 'c';
    o.wind_units = /km\/h|kmh|kph/.test(w) ? 'km_h' : 'm_s';
    const sn = name(o.snow);
    o.snow_units = /water|swe|w\.e|precsno/.test(sn) ? 'mm_water' : /mm/.test(sn) ? 'mm' : 'cm';
    o.rh_units = 'pct';
  }
  return o;
}

// Clock time with daylight saving needs a time column and the site's zone with a clock change in the file's years (a zone that
// has since dropped daylight saving still had it then).
export function clockOk(S, tc, ctx) {
  try {
    const tz = ctx.tz;
    if (!tz || !(tc >= 0)) return false;
    const [y0, y1] = fileYears(S, tc);
    for (let y = y0; y <= Math.min(y1, y0 + 60); y++) if (zoneOffsets(tz, y).dst) return true;
    return false;
  } catch (e) { return false; }
}

// Calendar years of the file from time column tc of its first and last lines (for the zone's clock changes).
function fileYears(S, tc) {
  const ys = [];
  for (const l of S.lines.slice(S.hdr).concat(S.tail)) {
    const c = cells(S, l)[tc] || '', m = c.match(/(?:^|\D)((?:19|20|21)\d\d)(?:\D|$)/), x = numOf(S, c);
    if (m) ys.push(+m[1]);
    else if (x >= 20000 && x <= 80000) ys.push(new Date(Date.UTC(1899, 11, 30) + x * 864e5).getUTCFullYear());
  }
  const now = new Date().getUTCFullYear();
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : [1990, now + 1];
}

// The zone's clock from y0 to y1: {start: offset in h, changes: [[UTC minute since 1970, offset in h after it], ...]}. Each change is
// found to the minute between two days whose offsets differ.
export function clockOf(tz, y0, y1) {
  const fmt = zoneFormat(tz), at = (t) => wallOffset(fmt, t), changes = [], end = Date.UTC(y1 + 1, 0, 1, 12);
  let tp = Date.UTC(y0 - 1, 11, 31, 12), prev = at(tp);
  const start = prev;
  for (let t = tp + 864e5; t <= end; t += 864e5) {
    const o = at(t);
    if (o !== prev) {
      let lo = tp, hi = t;
      while (hi - lo > 60000) { const m = lo + Math.floor((hi - lo) / 120000) * 60000; if (at(m) === prev) lo = m; else hi = m; }
      changes.push([Math.round(hi / 60000), o]);
      prev = o;
    }
    tp = t;
  }
  return { start, changes };
}

// Options as import_series takes them.
export function engineOpt(S, ctx) {
  const o = S.opt, e = { kind: S.kind, time_col: o.time_col, time2_col: o.time_col >= 0 ? o.time2_col : -1, date_order: o.date_order, time_basis: o.basis,
    label: o.label, utc_offset: +ctx.utcOffset || 0, year: o.time_col < 0 || o.year === 'auto' ? 'auto' : o.year === 'last12' ? 'last12' : +o.year };
  if (S.kind === 'load') Object.assign(e, { cols: [...o.cols], units: o.units, fill_long: !!o.fill_long });
  else {
    Object.assign(e, { ghi: o.ghi, dni: o.dni, dhi: o.dhi, tamb: o.tamb, wind: o.wind, irr_units: o.irr_units, temp_units: o.temp_units, wind_units: o.wind_units });
    if (o.snow >= 0) Object.assign(e, { snow: o.snow, snow_units: o.snow_units || 'cm' });   // only when chosen, as the engine reads them
    if (o.rh >= 0) Object.assign(e, { rh: o.rh, rh_units: o.rh_units || 'pct' });
  }
  if (o.basis === 'local_clock') { const [y0, y1] = fileYears(S, o.time_col); e.clock = clockOf(ctx.tz, y0, Math.min(y1, y0 + 60)); }
  return e;
}
