// Shared helpers: DOM, engine API calls and jobs, formatting, input snapshots and diffs, CSV, time zones, Markdown, ⓘ buttons.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const HOURS = 8760;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_OF_HOUR = (() => {
  const m = new Uint8Array(HOURS); let h = 0;
  MDAYS.forEach((d, i) => { for (let k = 0; k < d * 24; k++) m[h++] = i; });
  return m;
})();

// The desktop shell (src-tauri) is the only host: Tauri injects window.__TAURI__ (withGlobalTauri). Every engine call is a
// command (docs/ipc.md); the system's own features (Save dialog, printing, links, quit) are commands of src-tauri/src/native.rs.
const Native = (() => {
  const T = window.__TAURI__ || null;
  const ua = navigator.userAgent;
  const platform = /Mac/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'linux';
  const invoke = (cmd, args, opts) => {
    if (!T) return Promise.reject({ error: 'Soloptima runs in its desktop app. Start the app instead of opening this page.', internal: false });
    return T.core.invoke(cmd, args, opts);
  };
  const listen = (name, fn) => { if (T) T.event.listen(name, fn); };
  return { app: !!T, platform, invoke, listen };
})();
window.SoloptimaNative = Native;

// "/api/project?user=u&id=p" + method -> the command and its arguments (docs/ipc.md): the path after /api/ with / and - as _,
// the query as named arguments, the JSON body as `body`. A few names are told apart by the method.
const COMMAND_BY_METHOD = { 'GET project': 'project_load', 'POST project': 'project_save', 'POST users': 'user_create',
  'GET report': 'report_load', 'POST report': 'report_save' };
function toCommand(path, body, method) {
  const [p, q] = path.split('?');
  const base = p.replace(/^\/api\//, ''), m = method || (body === undefined ? 'GET' : 'POST');
  const args = {};
  if (q) new URLSearchParams(q).forEach((v, k) => { args[k] = v; });
  if (body !== undefined) args.body = body;
  return [COMMAND_BY_METHOD[m + ' ' + base] || base.replace(/[/-]/g, '_'), args];
}
// Errors: ApiError {error, internal} from the shell; "internal" marks defects (anything but the engine's own worded messages)
async function api(path, body, method) {
  const [cmd, args] = toCommand(path, body, method);
  // every failure goes to the bug-report log (web/js/reports.js); unexpected ones also become a report
  const fail = (msg, status, unexpected) => {
    SoloptimaUI.reportError(toCommand(path, body, method)[0], msg, status, unexpected);
    const e = new Error(msg);
    e.logged = true;
    return e;
  };
  try { return await Native.invoke(cmd, args); }
  catch (e) {
    const msg = (e && e.error) || (typeof e === 'string' ? e : (e && e.message) || 'Unknown error');
    const internal = !!(e && e.internal) || /^JSON parse error/.test(msg);
    throw fail(msg, internal ? 500 : 400, internal);
  }
}
// The text of a legal document (licence, terms, notices)
const legalText = (doc) => Native.invoke('legal', { doc });
// A link in the user's browser
const openExternal = (url) => Native.invoke('open_url', { url }).catch((e) => toast((e && e.error) || 'Cannot open the link.', true));
// Links to other sites open in the browser, never in the app's window
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (a && /^(https?:|mailto:)/i.test(a.getAttribute('href'))) { e.preventDefault(); openExternal(a.href); }
});
// Result of a background job of the engine (/api/job), polled every ms milliseconds; onProgress(status) gets each status
// while the job runs. Throws the job's error.
async function waitJob(job, onProgress, ms = 400) {
  for (;;) {
    await new Promise((r) => setTimeout(r, ms));
    const s = await api('/api/job?id=' + job);
    if (s.done) { if (s.error) throw new Error(s.error); return s.result; }
    if (onProgress) onProgress(s);
  }
}

function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, path, v) {
  const ks = path.split('.'); let a = o;
  for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null || typeof a[ks[i]] !== 'object') a[ks[i]] = {}; a = a[ks[i]]; }
  a[ks[ks.length - 1]] = v;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

const NUM_FMT = [];
function fmtNum(x, d = 0) {
  if (x == null || !isFinite(x)) return '–';
  return (NUM_FMT[d] || (NUM_FMT[d] = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))).format(Number(x));
}
function fmtSig(x) {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  return fmtNum(x, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}
function fmtEnergy(kwh) {
  if (kwh == null || !isFinite(kwh)) return '–';
  const a = Math.abs(kwh);
  if (a >= 1e6) return fmtSig(kwh / 1e6) + ' GWh';
  if (a >= 1e3) return fmtSig(kwh / 1e3) + ' MWh';
  return fmtSig(kwh) + ' kWh';
}
function fmtPower(kw) {
  if (kw == null || !isFinite(kw)) return '–';
  return Math.abs(kw) >= 1000 ? fmtSig(kw / 1000) + ' MW' : fmtSig(kw) + ' kW';
}
// Plan area: square metres below 1000 m², hectares above.
const fmtArea = (m2) => (m2 < 1000 ? `${fmtNum(m2)} m²` : `${fmtNum(m2 / 1e4, 2)} ha`);
// Area of a polygon of [x, y] corners (shoelace).
function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
function fmtMoney(x, cur) {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x), c = cur || '';
  if (a >= 1e9) return c + ' ' + fmtSig(x / 1e9) + ' B';
  if (a >= 1e6) return c + ' ' + fmtSig(x / 1e6) + ' M';
  if (a >= 1e3) return c + ' ' + fmtSig(x / 1e3) + ' k';
  return c + ' ' + fmtSig(x);
}
const fmtPct = (x, d = 1) => (x == null || !isFinite(x)) ? '–' : (x * 100).toFixed(d) + ' %';

// ---------------------------------------------------------------- input snapshots: which inputs changed after a run
// FNV-1a hash of a string, in hex (projectKey fingerprints the engine project with it).
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
// Nested object as [path, value] rows. Arrays of up to 24 values become JSON text; longer ones are left out, or become long(array)
// when long is given.
function flatten(o, pre = '', out = [], long) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, long);
    else if (!Array.isArray(v) || v.length <= 24) out.push([key, Array.isArray(v) ? JSON.stringify(v) : v]);
    else if (long) out.push([key, long(v)]);
  }
  return out;
}
// Engine inputs of a project as {path: value}, without the name (not an input of the results). Longer arrays (weather and load
// series) become {n, sum, h}: their length, sum and the hash of their JSON, so a run keeps a small copy of its inputs.
function inputSnapshot(p) {
  const q = { ...p };
  delete q.name;
  return Object.fromEntries(flatten(q, '', [], (a) => {
    const s = a.every((x) => typeof x === 'number') ? sum(a) : null;
    return { n: a.length, sum: s == null ? null : +s.toPrecision(9), h: fnv1a(JSON.stringify(a)) };
  }));
}
// The input fields by project path (the first form that has the path) and the paths of each label, indexed on first use
// (FORMS is in schema.js and does not change).
let FIELDS = null;
function fieldIndex() {
  if (!FIELDS) {
    FIELDS = { byPath: new Map(), pathsOfLabel: new Map() };
    for (const fs of Object.values(FORMS)) for (const f of fs) {
      if (!FIELDS.byPath.has(f.k)) FIELDS.byPath.set(f.k, f);
      FIELDS.pathsOfLabel.set(f.l, (FIELDS.pathsOfLabel.get(f.l) || new Set()).add(f.k));
    }
  }
  return FIELDS;
}
// Input field of a project path in the input forms (any type), or null.
function inputField(path) { return fieldIndex().byPath.get(path) || null; }
// Label of value v in a list of [value, label] options, or v itself.
const optionLabel = (list, v) => (list.find(([k]) => k === v) || [v, v])[1];
// Labels of the engine inputs that have no input field (set by tables, cards, the weather download or import).
const PATH_LABELS = { 'finance.model': 'Finance model', 'finance.components': 'Tariff components', 'diesel.fuel_curve': 'Fuel curve',
  'pv.absorptance': 'Module absorptance', 'weather.source': 'Weather source', 'weather.ghi': 'Weather GHI', 'weather.dni': 'Weather DNI',
  'weather.dhi': 'Weather DHI', 'weather.tamb': 'Weather air temperature', 'weather.wind': 'Weather wind speed' };
// Label of a project path in change lists: its field's label (with the path when a field of another path has the same label), a
// label of PATH_LABELS, or the path.
function inputLabel(path) {
  if (path === 'load.kw') return 'Load';
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  if (path.startsWith('weather.')) return `Weather data (${path.slice(8)})`;
  const f = inputField(path);
  return !f ? path : fieldIndex().pathsOfLabel.get(f.l).size > 1 ? `${f.l} (${path})` : f.l;
}
// Two numbers as text that tells them apart: whole numbers without decimals, others to 3 significant digits, or more when those
// read the same. none stands for a missing value.
function numPair(x, y, none = 'none') {
  const ok = (v) => typeof v === 'number' && isFinite(v), whole = [x, y].every((v) => !ok(v) || Number.isInteger(v));
  let f = (v) => (!ok(v) ? none : whole ? fmtNum(v) : fmtSig(v));
  if (ok(x) && ok(y) && x !== y && f(x) === f(y)) f = (v) => (!ok(v) ? none : String(+v.toPrecision(10)));
  return [f(x), f(y)];
}
// Inputs that differ between two snapshots (inputSnapshot), in the order of b: [{path, label, from, to, unit, series}]. from and to
// are the values as text in the units of the input field (options by their label, percentages in %), or the sums of a series
// (series: true); both are null when a text is too long to show or a series has no sum on one side.
const FIN_MODELS = { host: 'Host-owned', ppa: 'Single owner (PPA)', tpo: 'Third-party ownership' };   // as on the model cards
function inputDiff(a, b) {
  a = a || {}; b = b || {};
  const isSeries = (v) => v != null && typeof v === 'object', out = [];
  for (const path of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const x = a[path], y = b[path];
    if (x === y || (Number.isNaN(x) && Number.isNaN(y)) || (isSeries(x) && isSeries(y) && x.h === y.h && x.n === y.n)) continue;
    const f = inputField(path), d = { path, label: inputLabel(path), from: null, to: null, unit: '', series: isSeries(x) || isSeries(y) };
    if (d.series) {
      if (isSeries(x) && isSeries(y) && x.sum != null && y.sum != null) [d.from, d.to] = numPair(x.sum, y.sum);
      if (path === 'load.kw') d.unit = 'kWh';
    } else if (path === 'finance.model') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : FIN_MODELS[v] || String(v)));
    else if (f && f.t === 'sel') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : String(optionLabel(f.o, v))));
    else if (typeof x === 'boolean' || typeof y === 'boolean') [d.from, d.to] = [x, y].map((v) => (v == null ? 'none' : v ? 'yes' : 'no'));
    else if (typeof x === 'number' || typeof y === 'number') {
      const pct = !!f && f.t === PCT, n = (v) => (typeof v === 'number' && pct ? +(v * 100).toPrecision(12) : v);
      [d.from, d.to] = numPair(n(x), n(y), (f && f.ph) || 'none');
      // the unit after the pair ('1.00 to 1.10 USD/L'), or next to the number when the other side is a placeholder ('80 % to EOL')
      const u = !f || !f.u ? '' : f.u.startsWith('/') ? P.econ.currency + f.u : f.u, num = (v) => typeof v === 'number' && isFinite(v);
      if (u && !(num(x) && num(y))) { if (num(x)) d.from += ' ' + u; if (num(y)) d.to += ' ' + u; } else d.unit = u;
    } else {
      const t = [x, y].map((v) => (v == null ? 'none' : String(v)));
      if (t.every((s) => s.length <= 40)) [d.from, d.to] = t;
    }
    out.push(d);
  }
  return out;
}
// One change as text: 'Diesel price (delivered) 1.00 to 1.10 USD/L', 'Load changed (sum 8,760,000 to 9,198,000 kWh)'.
function diffText(d) {
  const u = d.unit ? ' ' + d.unit : '';
  if (d.from == null || d.to == null) return d.label + ' changed';
  if (d.series) return d.from === d.to ? `${d.label} changed (same sum, ${d.from}${u})` : `${d.label} changed (sum ${d.from} to ${d.to}${u})`;
  return `${d.label} ${d.from} to ${d.to}${u}`;
}
// The first n changes as one list: 'A, B, C (and 4 more)'.
function diffList(diff, n = 6) {
  return diff.slice(0, n).map(diffText).join(', ') + (diff.length > n ? ` (and ${diff.length - n} more)` : '');
}

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  // a pop-over is drawn in the top layer, above an open dialog; shown again so it also comes above a dialog opened since
  if (t.showPopover) { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); }, err ? 7000 : 3500);
}
function setStatus(el, msg, kind) { if (typeof el === 'string') el = $(el); el.textContent = msg || ''; el.className = el.className.replace(/\b(err|ok)\b/g, '').trim() + (kind ? ' ' + kind : ''); }

// A file for the user: the system's Save dialog in the desktop app, a browser download otherwise
async function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (Native.app) {
    try {
      const r = await Native.invoke('save_file', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-name': encodeURIComponent(name) } });
      if (r.path) toast('Saved ' + r.path.split(/[\\/]/).pop());
    } catch (e) { toast((e && e.error) || 'Cannot save the file.', true); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}

// Delimiter of a CSV line (parseCSV).
function csvDelim(line) {
  return (line.match(/;/g) || []).length > (line.match(/,/g) || []).length ? ';' : (line.includes('\t') ? '\t' : ',');
}
// Delimiter of a CSV file from its first non-blank lines: of ';', tab and ',', the one that splits most of them evenly (the same
// count on the most lines; ties in that order), so a title or metadata line above the data does not decide it. The engine's
// import chooses it the same way (src/series.cpp), so the columns match.
function csvDelimOf(lines) {
  let best = ',', top = 0;
  for (const d of [';', '\t', ',']) {
    const n = new Map();
    for (const l of lines) { const c = l.split(d).length - 1; if (c) n.set(c, (n.get(c) || 0) + 1); }
    for (const k of n.values()) if (k > top) { top = k; best = d; }
  }
  return best;
}
// One CSV line as trimmed cells: quoted fields may contain the delimiter; "" is a literal quote.
function csvSplit(l, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) {
      if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
// Parse CSV text into { header: [...] | null, rows: [[...]] } of numbers where possible.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: null, rows: [] };
  const delim = csvDelim(lines[0]), split = (l) => csvSplit(l, delim);
  let header = null, start = 0;
  const first = split(lines[0]);
  if (first.some((c) => c !== '' && isNaN(Number(c)) && !/^\d{1,4}[-/:]/.test(c))) { header = first.map((c) => c.toLowerCase()); start = 1; }
  const rows = [];
  for (let i = start; i < lines.length; i++) rows.push(split(lines[i]));
  return { header, rows };
}

// Deterministic RNG (mulberry32) with normal deviates: the same seed gives the same sequence (synthetic loads, welcome lines).
function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  u.normal = () => { let x = 0, y = 0; while (x === 0) x = u(); while (y === 0) y = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * y); };
  return u;
}

function monthlySum(arr) { const m = new Array(12).fill(0); for (let i = 0; i < HOURS; i++) m[MONTH_OF_HOUR[i]] += arr[i]; return m; }
// 24 x 365 matrix for heatmaps (rows = hour, cols = day)
function dayHourMatrix(arr, scale = 1) {
  const z = Array.from({ length: 24 }, () => new Array(365));
  for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) z[h][d] = arr[d * 24 + h] * scale;
  return z;
}
function dateOfHour(h) {
  let d = Math.floor(h / 24), m = 0;
  while (m < 11 && d >= MDAYS[m]) { d -= MDAYS[m]; m++; }
  return `${d + 1} ${MONTHS[m]}`;
}

// Time zones. The model works in local standard time: the UTC offset of a site is the standard offset of its IANA zone.
// Hours between the zone's wall clock and UTC at the instant t (ms), from a formatter made by zoneFormat.
const zoneFormat = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function wallOffset(fmt, t) {
  const f = {};
  for (const x of fmt.formatToParts(t)) f[x.type] = +x.value;
  return (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - t) / 3.6e6;
}
// Offsets of the zone over a year, read at 12:00 UTC on the 15th of every month: std is the lowest (local standard time;
// for a zone with negative daylight saving, such as Europe/Dublin, the winter clock), all the distinct values, dst when the
// clock changes during the year, irregular when it takes more than two values. Throws for an unknown zone.
const ZONE_CACHE = new Map();
function zoneOffsets(tz, year = new Date().getUTCFullYear()) {
  const key = tz + '|' + year;
  if (!ZONE_CACHE.has(key)) {
    const fmt = zoneFormat(tz), all = [];
    for (let m = 0; m < 12; m++) { const o = wallOffset(fmt, Date.UTC(year, m, 15, 12)); if (!all.includes(o)) all.push(o); }
    all.sort((a, b) => a - b);
    ZONE_CACHE.set(key, { std: all[0], all, dst: all.length > 1, irregular: all.length > 2 });
  }
  return ZONE_CACHE.get(key);
}
// The site's zone from the bundled offline lookup (vendor/tz-lookup.js; nothing leaves the computer) with its offsets, or
// null when there is no lookup or no zone. The lookup is approximate within a few kilometres of a zone border.
function siteZone(lat, lon) {
  try {
    const tz = typeof tzlookup === 'function' ? tzlookup(+lat, +lon) : '';
    return tz ? { tz, ...zoneOffsets(tz) } : null;
  } catch (e) { return null; }
}
// The site's zone (location.tz) against its UTC offset: differs when the offset is not the zone's standard offset; warn when
// it needs checking: no zone found, an offset kept from an older project that differs, or a zone with more than two offsets
// in the year. A typed offset that differs is the user's choice and does not warn.
function zoneCheck(loc) {
  let z = null;
  try { if (loc.tz) z = { tz: loc.tz, ...zoneOffsets(loc.tz) }; } catch (e) { /* unknown zone name */ }
  const differs = !!z && Math.abs(+loc.utc_offset - z.std) > 1e-9;
  return { z, differs, warn: !z || z.irregular || (differs && loc.utc_offset_src !== 'typed') };
}
// 'UTC+7', 'UTC+5:30', 'UTC-3:30'
function fmtOffset(h) {
  h = +h;
  if (!isFinite(h)) return 'UTC offset not set';
  const m = Math.round(Math.abs(h) * 60), hh = Math.floor(m / 60), mm = m % 60;   // total minutes first, so 5.995 is UTC+6, not 5:60
  return `UTC${h < 0 ? '-' : '+'}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}
function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
try {   // keys were prefixed solarhybrid. before the rename to Soloptima
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('solarhybrid.')) continue;
    const n = 'soloptima.' + k.slice(12);
    if (localStorage.getItem(n) === null) localStorage.setItem(n, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch (e) { /* storage blocked */ }
// Minimal Markdown for the bundled legal texts and bug reports: headings, paragraphs, lists (indented lines continue an
// item), block quotes, tables, fenced code, inline code, bold and links. Text is escaped first and the inline rules run as
// one pass, so generated HTML is never matched again; links are http(s) only, and #anchors become in-page jumps.
function mdToHtml(md) {
  const INLINE = /`([^`]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+)\]\(#([\w-]+)\)|&lt;(https?:\/\/\S+?)&gt;/g;
  const inline = (s) => escapeHtml(s).replace(INLINE, (m, code, bi, b, lt, lu, jt, ja, au) =>
    code != null ? `<code>${code}</code>` : bi != null ? `<b><i>${bi}</i></b>` : b != null ? `<b>${b}</b>`
      : lt != null ? `<a href="${lu}" target="_blank" rel="noopener">${lt}</a>` : jt != null ? `<a href="" data-jump="${ja}">${jt}</a>`
        : `<a href="${au}" target="_blank" rel="noopener">${au}</a>`);
  const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  const lines = String(md).replace(/\r/g, '').split('\n'), out = [];
  const LIST = /^\s*([-*]|\d+\.)\s/;
  let para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,4}\s/.test(l)) {
      flush();
      const n = l.match(/^#+/)[0].length, t = l.slice(n).trim();
      out.push(`<h${n + 1} id="md-${slug(t)}">${inline(t)}</h${n + 1}>`);
    } else if (/^\|/.test(l) && /^\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      flush();
      const cells = (s) => s.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table class="data"><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
    } else if (LIST.test(l)) {
      flush();
      const ordered = /^\s*\d+\./.test(l), items = [];
      for (; i < lines.length; i++) {
        if (LIST.test(lines[i])) items.push([lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')]);
        else if (/^ {2,}\S/.test(lines[i])) items[items.length - 1].push(lines[i].trim());
        else break;
      }
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${t.map(inline).join('<br>')}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, '').trim());
      i--;
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
    } else if (!l.trim()) flush();
    else para.push(l.trim());
  }
  flush();
  return out.join('\n');
}
// In-page jumps for rendered Markdown (a #hash would trigger the app's router)
function wireJumps(el) {
  $$('[data-jump]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); const t = $('#md-' + a.dataset.jump, el); if (t) t.scrollIntoView({ behavior: 'smooth' }); }));
}
// Were the weather data fetched for this site (within 0.05°)? Only then is their elevation the site's.
function weatherAtSite() {
  const W = P && P.weather, L = P && P.location;
  return !!(W && L && W.elevation != null && Math.abs(W.lat - +L.lat) < 0.05 && Math.abs(W.lon - +L.lon) < 0.05);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
