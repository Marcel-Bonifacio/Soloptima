// The report dialogs (screens/reports): the form for a new report, and the list with the history of each. The documents are in
// reports/doc.js, the automatic capture in reports/capture.js. Nothing here leaves the computer unless the user downloads a
// report, copies it or opens it as a GitHub issue.
import { call, openExternal, saveFile } from './ipc.js';
import { app } from './state.svelte.js';
import { storeGet, storeSet } from './storage.js';
import { OPEN, STATUS, SEVERITY, now, toMarkdown, issueUrl, repoName, redact } from './reports/doc.js';
import { getInfo, cachedInfo, context, recent, save, mutate, who, diagNow } from './reports/capture.js';
import { trail } from './reports/trail.js';
import { toast } from './toast.js';
import { W } from './ws/state.js';
import { shareable } from './ws/project.js';

const KEY_REPO = 'soloptima.issueRepo';
export const rp = $state({ form: false, list: false, kind: 'bug', items: [], sel: null, filter: 'open', q: '', repo: '', saving: false, confirmDel: false, gone: false });

const ctx = () => ({ info: cachedInfo(), user: app.user, sel: rp.sel });
export const markdown = (r, pub) => toMarkdown(r, pub, ctx());
export const infoNow = cachedInfo;
export const recentCount = () => recent.length;
export const trailCount = () => trail.length;
export const inHome = () => document.body.classList.contains('home-mode');

export async function openForm() { await getInfo(); rp.form = true; }
export const closeForm = () => { rp.form = false; };

export async function openList(id) {
  await getInfo();
  rp.repo = storeGet(KEY_REPO) || '';
  rp.list = true; rp.gone = false;
  try { rp.items = await call('reports'); } catch (e) { rp.items = []; toast(e.message, true); }
  if (id) rp.filter = 'all';
  const first = id || (rp.items.find((r) => OPEN.includes(r.status)) || rp.items[0] || {}).id;
  if (first) await show(first); else rp.sel = null;
}
export const closeList = () => { rp.list = false; rp.sel = null; };

export async function show(id) {
  try { rp.sel = await call('report_load', { id }); rp.confirmDel = false; rp.gone = false; } catch (e) { toast(e.message, true); }
}

// the filter and the search of the list
export function visible() {
  const q = rp.q.toLowerCase();
  return rp.items.filter((r) => (rp.filter === 'all' || (rp.filter === 'open' ? OPEN.includes(r.status) : r.kind === 'error')) && (!q || `${r.id} ${r.title}`.toLowerCase().includes(q)));
}

// the form: save a new report
export async function submit(f) {
  const u = app.user, kind = rp.kind;
  const r = {
    kind, status: 'new', severity: kind === 'bug' ? f.severity : 'low', title: f.title.trim(), reporter: u ? who() + (u.email ? ` <${u.email}>` : '') : '',
    description: f.what, steps: kind === 'bug' ? f.steps : '', expected: kind === 'bug' ? f.expected : '',
    context: context(), recent: f.recent ? recent.slice(-15) : [], history: [{ time: now(), event: 'created', text: `Reported by ${who()}.` }],
  };
  if (f.diag) r.diag = diagNow();
  if (f.project) r.project = shareable(W.P);   // without the API keys, like an exported file
  rp.saving = true;
  let s;
  try { s = await save(r); } catch (err) { toast(err.message, true); rp.saving = false; return; }
  rp.saving = false; rp.form = false;
  try { await openList(s.id); } finally { toast(`Saved as ${s.id}.`); }
}

// apply a change to the selected report on its latest saved copy
export async function commit(change) {
  try {
    rp.sel = await mutate(rp.sel.id, change);
    rp.items = await call('reports');
  } catch (e) { toast(e.message, true); }
}
export function setField(field, map, v, label) {
  return commit((x) => {
    if (v === x[field]) return;
    x.history.push({ time: now(), event: field, text: `${label} changed from ${map[x[field]] || x[field]} to ${map[v]} by ${who()}.` });
    x[field] = v;
  });
}
export const setStatus = (v) => setField('status', STATUS, v, 'Status');
export const setSeverity = (v) => setField('severity', SEVERITY, v, 'Severity');
export const addNote = (t) => commit((x) => x.history.push({ time: now(), event: 'note', text: `Note by ${who()}: ${t}` }));

export function setRepo(v) {
  const n = repoName(v);
  if (n == null) { toast('Enter the repository as owner/name, for example acme/soloptima.', true); return false; }
  storeSet(KEY_REPO, n); rp.repo = n;
  return true;
}

export const downloadMd = () => saveFile(`${rp.sel.id}.md`, markdown(rp.sel), 'text/markdown');
export async function copyForIssue() {
  try { await navigator.clipboard.writeText(markdown(rp.sel, true)); toast('Copied. Check the text before you post it anywhere public.'); }
  catch (e) { toast('The browser blocked the clipboard; use Download .md instead.', true); }
}
// the issue is only opened in the browser for the user to check and submit; long reports go through the clipboard
export async function openIssue() {
  const r = rp.sel, body = markdown(r, true), title = `${r.id}: ${redact(r.title, ctx())}`;
  const { url, clipboard } = issueUrl(rp.repo, title, body);
  if (clipboard) {
    try { await navigator.clipboard.writeText(body); } catch (e) { /* the user can still download it */ }
    toast('The report is long: it was copied to the clipboard. Paste it into the issue.');
  }
  openExternal(url);
  commit((x) => x.history.push({ time: now(), event: 'shared', text: `Opened as a GitHub issue in ${rp.repo} by ${who()}.` }));
}
export async function remove() {
  const id = rp.sel.id;
  try { await call('report_delete', { id, body: {} }); } catch (e) { toast(e.message, true); return; }
  rp.items = rp.items.filter((x) => x.id !== id); rp.sel = null; rp.gone = true; rp.confirmDel = false;
}
