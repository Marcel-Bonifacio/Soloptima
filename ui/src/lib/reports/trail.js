// The diagnostic log of the session (docs/ui.md): what the user and the app did before a report, the machine and an outline of
// the open project. Kept in memory only (the last 300 entries); every report carries a copy, so a bug can be traced without
// asking the reporter what they did. Values of keys, tokens and passwords are never recorded.
import { W } from '../ws/state.js';

const MAX = 300, T0 = Date.now();
const SECRET = /key|token|password|secret/i;
export const trail = [];

export function note(kind, text) {
  trail.push({ time: new Date().toISOString(), kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 300) });
  if (trail.length > MAX) trail.shift();
}

// a value as a short text: numbers and short strings as they are, series and objects by size only
export function short(v) {
  if (v == null) return String(v);
  if (Array.isArray(v)) return `[${v.length} values]`;
  if (typeof v === 'object') return '{…}';
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
const at = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

// a project field changed on a page
export function noteInput(key) {
  note('input', SECRET.test(key) ? `${key} changed` : `${key} = ${short(at(W.P, key))}`);
}

// an engine call, with its time and how it ended
export function noteCall(cmd, ms, err) {
  if (/^report/.test(cmd)) return;   // the reporter's own calls say nothing about a bug
  note('call', err ? `${cmd} failed after ${Math.round(ms)} ms: ${err}` : `${cmd} ${Math.round(ms)} ms`);
}

// The machine and the session; `info` is the engine's answer to `info`
export function environment(info = {}) {
  const e = {
    app_version: info.version || '', os: info.os ? `${info.os} ${info.arch || ''}`.trim() : '', data_dir: info.data_dir || '',
    session_min: Math.round((Date.now() - T0) / 6e4),
  };
  try {
    Object.assign(e, {
      browser: navigator.userAgent, language: navigator.language, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cpus: navigator.hardwareConcurrency || 0, online: navigator.onLine,
      screen: `${screen.width}×${screen.height} @${window.devicePixelRatio || 1}x`, window: `${window.innerWidth}×${window.innerHeight}`,
    });
    const m = /** @type {any} */ (performance).memory;   // Chromium only
    if (m) e.memory_mb = Math.round(m.usedJSHeapSize / 1048576);
  } catch (err) { /* not in a browser (tests) */ }
  return e;
}

// The open project in outline: sizes, models and data lengths, not its series or keys. `stale` says whether the last simulation is
// from other inputs, `changes` which ones.
export function outline(P, S = {}) {
  if (!P) return null;
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  const kw = (P.load && P.load.kw) || [];
  const dg = P.diesel || {};
  return {
    name: P.name || '', location: P.location ? `${short(P.location.lat)}, ${short(P.location.lon)}, UTC${P.location.utc_offset >= 0 ? '+' : ''}${P.location.utc_offset}` : '',
    weather: P.weather ? `${P.weather.source || 'unknown source'}, ${n(P.weather.ghi)} h` : 'none',
    load: `${(P.load && P.load.source) || '?'}, ${n(kw)} h, peak ${Math.round(kw.reduce((a, x) => Math.max(a, +x || 0), 0))} kW`,
    pv: P.pv ? `${short(P.pv.capacity_kwp)} kWp, ${P.pv.mount}, DC/AC ${short(P.pv.dc_ac_ratio)}` : '',
    battery: P.bess ? `${short(P.bess.energy_kwh)} kWh / ${short(P.bess.power_kw)} kW` : '',
    wind: P.wind && P.wind.units ? `${P.wind.units} × ${short(P.wind.rated_kw)} kW` : 'none',
    gensets: `${short(dg.units)} × ${short(dg.unit_kw)} kW${n(dg.more_groups) ? ` + ${n(dg.more_groups)} more groups` : ''}, ${dg.strategy || '?'}`,
    grid: P.grid && P.grid.enabled ? 'connected' : 'none',
    sim: P.sim ? `${P.sim.all_years === false ? 'year 1 only' : 'every year'}, step ${short(P.sim.step_min || 60)} min` : '',
    results: [W.PVR && 'PV yield', W.SIM && (S.stale ? `simulation (from other inputs: ${S.changes || '?'})` : 'simulation'), W.OPT && 'optimisation']
      .filter(Boolean).join(', ') || 'none',
  };
}

// Everything a report carries; `inProject` is false on the sign-in and project pages, where W.P is only a placeholder
export function diagnostics(info, stale, inProject = true) {
  return { environment: environment(info), project: inProject ? outline(W.P, stale) : null, log: trail.slice() };
}

// Pages, clicks and console warnings (engine calls and input changes are noted where they happen)
export function startTrail() {
  try {
    window.addEventListener('hashchange', () => note('page', location.hash || '#'));
    document.addEventListener('click', (e) => {
      const t = e.target;
      const el = t instanceof Element ? t.closest('button, a, summary, [role=tab], [role=menuitem], [role=button]') : null;
      if (!el) return;
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent;
      if (label && label.trim()) note('click', label);
    }, true);
    for (const level of ['error', 'warn']) {
      const orig = console[level].bind(console);
      console[level] = (...a) => { note('console', `${level}: ${a.map((x) => (x && x.message) || String(x)).join(' ')}`); orig(...a); };
    }
    note('page', 'session started');
  } catch (e) { /* not in a browser (tests) */ }
}
