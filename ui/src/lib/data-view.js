// What the Solar resource and Load pages show, as plain functions (no browser, no stores): the weather on local standard time, the
// synthetic load, the tiles, the monthly statistics and the chart traces. ui/tests/data.test.js covers them.
import { HOURS, MONTHS, MDAYS, sum, monthlySum } from './series.js';
import { fmtNum, fmtPct, fmtEnergy, fmtPower } from './format.js';
import { LOAD_TEMPLATES } from './schema/index.js';
import { MONTH_OF_HOUR, maxOf, dayHourMatrix } from './ws/util.js';
import { fnv1a } from './ws/diff.js';
import { heatmapFig, monthlyBarsFig } from './chart-kit.js';

// ---------------------------------------------------------------- weather
// UTC weather onto local standard time with the engine's weights: for an offset n + f, local hour L = f x UTC hour L - n - 1 +
// (1 - f) x UTC hour L - n. Local data (is_utc false) come back unchanged.
export function localSeries(arr, weather, utcOffset) {
  if (!weather || !weather.is_utc) return arr;
  const off = +utcOffset || 0, n = Math.floor(off), f = off - n, o = new Array(HOURS).fill(0);
  for (let i = 0; i < HOURS; i++) {
    o[(((i + n) % HOURS) + HOURS) % HOURS] += (1 - f) * arr[i];
    if (f > 0) o[(((i + n + 1) % HOURS) + HOURS) % HOURS] += f * arr[i];
  }
  return o;
}

// Monthly mean and maximum of an hourly series
export function monthlyMeanMax(t) {
  const tm = monthlySum(t).map((x, i) => x / (MDAYS[i] * 24)), tmax = new Array(12).fill(-99);
  for (let i = 0; i < t.length; i++) { const m = MONTH_OF_HOUR[i]; if (t[i] > tmax[m]) tmax[m] = t[i]; }
  return { tm, tmax };
}

// The weather page: tiles, monthly values and the day x hour matrix; null while there are no data
export function weatherView(P) {
  const W = P && P.weather;
  if (!W || !W.ghi) return null;
  const ghi = localSeries(W.ghi, W, P.location.utc_offset), t = localSeries(W.tamb, W, P.location.utc_offset);
  const gm = monthlySum(ghi).map((x) => x / 1000), { tm, tmax } = monthlyMeanMax(t);
  const hasWind = W.wind && W.wind.length;
  return {
    gm, tm, tmax, heat: dayHourMatrix(ghi), marks: W.qc ? W.qc.days : null,
    kpis: [
      ['Annual GHI', fmtNum(sum(ghi) / 1000, 0), 'kWh/m²·yr', true],
      ['Daily average', fmtNum(sum(ghi) / 1000 / 365, 2), 'kWh/m²·day'],
      ['Mean temperature', fmtNum(sum(t) / HOURS, 1), '°C'],
      ['Max temperature', fmtNum(maxOf(t), 1), '°C'],
      ['Mean wind', hasWind ? fmtNum(sum(W.wind) / HOURS, 1) : '–', 'm/s'],
      ['Source', W.source, W.lat != null ? `${(+W.lat).toFixed(3)}, ${(+W.lon).toFixed(3)}` : ''],
    ],
  };
}

export const weatherMonthlyFig = (c, v) => monthlyBarsFig([{ name: 'GHI', y: v.gm, color: c.pv, unit: 'kWh/m²' }], 'kWh/m²');
export const weatherTempFig = (c, v) => ({
  traces: [
    { type: 'scatter', mode: 'lines+markers', name: 'Mean', x: MONTHS, y: v.tm, line: { color: c.gen, width: 2 }, marker: { size: 8 } },
    { type: 'scatter', mode: 'lines+markers', name: 'Maximum', x: MONTHS, y: v.tmax, line: { color: c.unmet, width: 2 }, marker: { size: 8 } },
  ],
  layout: { yaxis: { title: { text: '°C' } } },
});
export const weatherHeatFig = (c, v) => heatmapFig(c, v.heat, [[0, c.surface2], [0.3, '#f6d27a'], [0.7, '#eda100'], [1, '#8a5a00']], 'W/m²', v.marks);

// ---------------------------------------------------------------- synthetic load
// Deterministic generator (mulberry32) with normal deviates: the same seed gives the same sequence.
export function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  u.normal = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  return u;
}

// A chosen template (not yet applied to the daily shape) replaces the 24 values, scaled to the current peak (1000 kW when there is
// none). Returns true when the shape changed.
export function applyTemplate(L) {
  const tpl = LOAD_TEMPLATES[L.template];
  if (!(tpl && tpl.shape && L._tpl !== L.template)) return false;
  const peak = maxOf(L.daily) > 0 ? maxOf(L.daily) : 1000;
  L.daily = tpl.shape.map((s) => +(s * peak).toFixed(3));
  L._tpl = L.template;
  return true;
}

// Synthetic load: daily shape x month factor x weekend factor x random day and hour perturbations, optionally scaled to an average.
export function synthLoad(L) {
  const R = rng(L.seed || 1), out = new Array(HOURS);
  for (let d = 0; d < 365; d++) {
    const dayF = 1 + (L.var_day || 0) * R.normal();
    const weekend = d % 7 >= 5;
    for (let h = 0; h < 24; h++) {
      const i = d * 24 + h;
      const v = L.daily[h] * L.monthly[MONTH_OF_HOUR[i]] * (weekend ? L.weekend_factor : 1) * dayF * (1 + (L.var_hour || 0) * R.normal());
      out[i] = Math.max(0, v);
    }
  }
  if (L.target_avg > 0) { const k = L.target_avg / (sum(out) / HOURS); for (let i = 0; i < HOURS; i++) out[i] *= k; }
  return out.map((x) => Math.round(x * 100) / 100);
}

// Numbers pasted into the 24 hour fields: at least two are needed, else the paste is an ordinary one (null)
export function pastedNumbers(text) {
  const nums = (String(text || '').match(/-?\d+(\.\d+)?/g) || []).map(Number);
  return nums.length < 2 ? null : nums;
}
// Put pasted values into the daily shape from hour h0 on (negative values become 0); the rest of the paste is dropped
export function pasteInto(daily, h0, nums) {
  nums.slice(0, 24 - h0).forEach((n, k) => { daily[h0 + k] = Math.max(0, n); });
}

// ---------------------------------------------------------------- load page
// Mean, maximum and minimum by hour of day over the year
export function dailyProfile(kw) {
  const mean = new Array(24).fill(0), mx = new Array(24).fill(0), mn = new Array(24).fill(Infinity);
  for (let i = 0; i < HOURS; i++) { const h = i % 24; mean[h] += kw[i] / 365; mx[h] = Math.max(mx[h], kw[i]); mn[h] = Math.min(mn[h], kw[i]); }
  return { mean, mx, mn };
}

export function loadKpis(P) {
  const L = P.load, kw = L.kw, tot = sum(kw), peak = maxOf(kw), avg = tot / HOURS, csv = L.source === 'csv';
  return [
    ['Annual energy', fmtEnergy(tot), '', true], ['Average load', fmtPower(avg), ''], ['Peak load', fmtPower(peak), ''],
    ['Load factor', fmtPct(avg / peak), ''], ['Daily energy', fmtEnergy(tot / 365), 'average'],
    ['Source', csv ? 'Measured (CSV)' : 'Synthetic', csv ? '' : (LOAD_TEMPLATES[L.template] || {}).name || ''],
  ];
}

// The load page: tiles, the profile by hour of day, monthly energy (MWh) and the day x hour matrix; null while there is no load
export function loadView(P) {
  const kw = P && P.load && P.load.kw;
  if (!kw || !kw.length) return null;
  const measured = P.load.source === 'csv';
  return { kpis: loadKpis(P), prof: dailyProfile(kw), monthly: monthlySum(kw).map((x) => x / 1000), heat: dayHourMatrix(kw), marks: measured && P.load.qc ? P.load.qc.days : null };
}

export const SYNTHETIC_NOTE = 'Synthetic profile, regenerated when you edit the shape or settings.';

export const loadDailyFig = (c, v) => {
  const hrs = Array.from({ length: 24 }, (_, h) => h);
  return {
    traces: [
      { type: 'scatter', mode: 'lines', name: 'Min', x: hrs, y: v.prof.mn, line: { width: 0, shape: 'hv' }, showlegend: false, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', name: 'Range (min–max)', x: hrs, y: v.prof.mx, fill: 'tonexty', fillcolor: c.surface2, line: { width: 0, shape: 'hv' }, hovertemplate: '%{y:,.0f} kW<extra>max</extra>' },
      { type: 'scatter', mode: 'lines', name: 'Average day', x: hrs, y: v.prof.mean, line: { color: c.load, width: 2, shape: 'hv' }, hovertemplate: '%{x}:00 %{y:,.0f} kW<extra>average</extra>' },
    ],
    layout: { xaxis: { title: { text: 'Hour of day' }, dtick: 3 }, yaxis: { title: { text: 'kW' }, rangemode: 'tozero' } },
  };
};
export const loadMonthlyFig = (c, v) => monthlyBarsFig([{ name: 'Energy', y: v.monthly, color: c.gen, unit: 'MWh' }], 'MWh');
export const loadHeatFig = (c, v) => heatmapFig(c, v.heat, null, 'kW', v.marks);

// ---------------------------------------------------------------- change keys and fingerprints
// The charts are redrawn when this text changes, not on every edit of the project: objects are told apart by a counter.
const IDS = new WeakMap();
let nextId = 1;
export function idOf(o) {
  if (!o || typeof o !== 'object') return 0;
  if (!IDS.has(o)) IDS.set(o, nextId++);
  return IDS.get(o);
}
export function weatherKey(P) {
  const W = P && P.weather;
  return [idOf(P), idOf(W), W ? idOf(W.qc) : 0, W ? W.is_utc : '', W ? W.time_offset : '', P && P.location ? P.location.utc_offset : ''].join('|');
}
export function loadKey(P) {
  const L = P && P.load;
  return [idOf(P), L ? idOf(L.kw) : 0, L ? idOf(L.qc) : 0, L ? L.source : '', L ? L.template : ''].join('|');
}

// Sorted keys and numbers with 7 significant digits: the form the engine saves a project in, so a fingerprint taken on it still
// matches after the project is reopened.
export function canon(v) {
  return Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(7) : v;
}
// Fingerprint of an engine project (a string as FNV-1a hash and length)
export function projectKey(p) {
  const s = JSON.stringify(p);
  return fnv1a(s) + ':' + s.length;
}
// Fingerprint of the weather-year run's inputs: the engine project (p90_factor fixed by the caller) and the run's settings
export function ryFingerprint(engineP, R) {
  return projectKey(canon({ ...engineP, ry: [R.source, R.from, R.to, R.unc_dataset, R.unc_model, R.unc_soiling] }));
}
// The request of a weather-year run
export function ryBody(engineP, R) {
  return { project: engineP, source: R.source, from: R.from, to: R.to, budget: { dataset: R.unc_dataset, model: R.unc_model, soiling: R.unc_soiling } };
}
