// Automatic capture of script errors and engine defects as reports (docs/ui.md). Each report is a file pair in the data folder
// (reports/SOL-nnnn.json and .md, plus an index README.md) with a dated history. Nothing leaves this computer unless the user
// downloads a report or opens it as a GitHub issue.
import { call } from '../ipc.js';
import { app } from '../state.svelte.js';
import { storeGet, storeSet } from '../storage.js';
import { STATUS, OPEN, REOPEN, now, appFrame, signatureOf, sourceOf, toMarkdown } from './doc.js';
import { toast } from '../toast.js';
import { W } from '../ws/state.js';
import { simStale, simChanges } from '../ws/keys.js';
import { note, diagnostics, startTrail } from './trail.js';

const KEY_PENDING = 'soloptima.pendingReports';
export const recent = [];        // the last errors of this session, attached to new reports
const seen = new Map();          // signature -> occurrences waiting to be added to its report
const SKIP = ['reports.js', 'util.js', 'capture.js', 'ipc.js'];
let info = null, chain = Promise.resolve();
const readBundle = (path) => fetch(path).then((r) => (r.ok ? r.text() : '')).catch(() => '');

export async function getInfo() { if (!info) info = await call('info').catch(() => ({})); return info; }
export const cachedInfo = () => info || {};
export const who = () => { const u = app.user; return u ? u.name + (u.organisation ? ` (${u.organisation})` : '') : 'someone without a profile'; };

// what was on screen when the report was made
export function context() {
  const c = { app_version: (info && info.version) || '', os: info && info.os ? `${info.os} ${info.arch}` : '', browser: navigator.userAgent };
  try {
    const b = document.body.classList;
    c.page = b.contains('signin-mode') ? 'Sign-in' : b.contains('home-mode') ? 'Projects' : ((location.hash.match(/t=(\w+)/) || [])[1] || '');
    const P = W.P;
    if (P && !b.contains('home-mode')) { c.project = P.name; c.project_id = P.id || ''; }
  } catch (e) { /* the app is still loading */ }
  return c;
}

const log = (e) => { recent.push(e); if (recent.length > 30) recent.shift(); note('error', `${e.where}: ${e.message}`); };

// the diagnostic log with the machine and the open project's outline, as a report carries it (trail.js)
export function diagNow() {
  let stale = {};
  try { if (W.SIM && W.P) stale = { stale: simStale(), changes: simStale() ? simChanges(6) : '' }; } catch (e) { /* half-loaded project */ }
  let inProject = true;
  try { const b = document.body.classList; inProject = !b.contains('home-mode') && !b.contains('signin-mode'); } catch (e) { /* tests */ }
  return diagnostics(info || {}, stale, inProject);
}

// every engine failure goes to the log; unexpected ones also become a report
export function apiError(cmd, message, status, unexpected) {
  if (/^report/.test(cmd)) return;   // never report on the reporter itself
  log({ time: now(), where: cmd, message, status });
  if (unexpected) capture(message, { where: cmd, status, logged: true });
}

export function capture(message, extra = {}) {
  message = String(message || 'Unknown error');
  if (/ResizeObserver loop/.test(message)) return;
  if (!extra.logged) log({ time: now(), where: extra.where || 'script', message });
  const sig = signatureOf(message, extra.where, !extra.status);
  const item = { message, extra, sig, time: now(), context: context(), recent: recent.slice(-10) };
  const s = seen.get(sig);
  if (s) {
    // a repeat: count it and add it to the report in one save every 30 s at most
    s.pending++; s.item = item;
    if (!s.timer) s.timer = setTimeout(() => flushSig(sig), 30000);
    return;
  }
  if (seen.size >= 20) return;   // 20 different errors in one session is enough; a broken loop must not flood the folder
  // the diagnostic log only with the first of its kind: it fingerprints the whole project, too dear for an error in a loop
  item.diag = diagNow();
  seen.set(sig, { pending: 0, timer: null, item });
  queue({ ...item, add: 1 });
}
function flushSig(sig) {
  const s = seen.get(sig);
  if (!s || !s.pending) return;
  clearTimeout(s.timer); s.timer = null;
  queue({ ...s.item, add: s.pending });
  s.pending = 0;
}
const queue = (it) => { chain = chain.then(() => record(it)).catch(() => park(it)); };
// the engine is down: keep the error in browser storage and file it on the next start
function park(it) {
  // browser storage is small: a parked error keeps the last 50 entries of its log
  if (it.diag) it = { ...it, diag: { ...it.diag, log: it.diag.log.slice(-50) } };
  try { const p = JSON.parse(storeGet(KEY_PENDING) || '[]'); p.push(it); storeSet(KEY_PENDING, JSON.stringify(p.slice(-20))); } catch (e) { /* storage blocked */ }
}

// ---------------------------------------------------------------- documents
export function save(r) {
  const t = now();   // the engine sets the same fields; set them here too so the Markdown written with this save has them
  r.updated = t;
  r.created = r.created || t;
  return call('report_save', { body: { report: r, markdown: toMarkdown(r) } });
}
// Load a report, apply a change and save it. A save based on an older copy is refused by the engine (another tab, or an error
// recorded while the dialog was open): reload and apply the change again.
export async function mutate(id, change) {
  for (let k = 0; ; k++) {
    const r = await call('report_load', { id });
    change(r);
    try { return await save(r); } catch (e) { if (k >= 3 || !/changed since/.test(e.message)) throw e; }
  }
}

async function record(it) {
  await getInfo();
  if (!it.context.app_version) it.context = { ...it.context, app_version: info.version || '', os: info.os ? `${info.os} ${info.arch}` : '' };
  const hit = (await call('reports')).find((r) => r.signature === it.sig);
  if (hit) return recur(hit.id, it);
  const where = it.extra.where ? ` at ${it.extra.where}` : '';
  const s = await save({
    kind: 'error', status: 'new', severity: 'medium', title: it.message.slice(0, 120), signature: it.sig, count: it.add || 1, first_seen: it.time, last_seen: it.time,
    description: it.message, where: it.extra.where || '', source: await sourceOf(it.extra.stack, readBundle).catch(() => ''),
    stack: String(it.extra.stack || '').slice(0, 4000), context: it.context, recent: it.recent, diag: it.diag,
    history: [{ time: it.time, event: 'created', text: `Captured automatically${where}${it.extra.status ? ` (HTTP ${it.extra.status})` : ''}.` }],
  });
  if (s.existing) return recur(s.id, it);   // another tab filed it a moment ago
  toast(`Error recorded as ${s.id}. Open Bug reports in the profile menu to add what you were doing.`, true);
}
// add occurrences to an existing report
function recur(id, it) {
  const where = it.extra.where ? ` at ${it.extra.where}` : '';
  return mutate(id, (r) => {
    r.count = (r.count || 1) + (it.add || 1);
    r.last_seen = it.time;
    const other = it.message !== r.description ? ` with a different message: ${it.message}` : '';
    if (REOPEN.includes(r.status)) {
      r.history.push({ time: it.time, event: 'status', text: `Occurred again${where} in version ${it.context.app_version}${other}; reopened (was ${STATUS[r.status]}).` });
      r.status = 'new';
      return;
    }
    // one history line per hour is enough (the count records every occurrence), unless the message differs
    const last = [...r.history].reverse().find((h) => h.event === 'occurred' || h.event === 'created' || h.event === 'status');
    if (other || !last || Date.parse(it.time) - Date.parse(last.time) > 3600e3)
      r.history.push({ time: it.time, event: 'occurred', text: `Occurred again${where} (${r.count} times in all${OPEN.includes(r.status) ? '' : `, status kept as ${STATUS[r.status]}`})${other}.` });
  });
}
async function flushPending() {
  let p = [];
  try { p = JSON.parse(storeGet(KEY_PENDING) || '[]'); } catch (e) { return; }
  if (!p.length) return;
  storeSet(KEY_PENDING, '[]');
  p.forEach(queue);
}

export function startCapture() {
  startTrail();
  window.addEventListener('error', (e) => {
    if (!e.message && !e.error) return;
    const stack = e.error && e.error.stack;
    capture(e.error && e.error.message ? e.error.message : e.message, { where: appFrame(stack, SKIP) || `${(e.filename || '').split('/').pop()}:${e.lineno || ''}`, stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    if (r.logged) return;   // already handled by apiError
    capture(r.message || String(r), { where: appFrame(r.stack, SKIP) || 'promise', stack: r.stack });
  });
  // repeats still waiting for their 30 s save go to browser storage when the tab closes
  window.addEventListener('pagehide', () => seen.forEach((s) => { if (s.pending) { park({ ...s.item, add: s.pending }); s.pending = 0; } }));
  getInfo().then(flushPending);
}
