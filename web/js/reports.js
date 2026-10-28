// Bug and feedback reports. Each report is a file pair in the data folder (reports/SOL-nnnn.json and .md, plus an
// index README.md) with a dated history: created, notes, status and severity changes, and each recurrence of a
// captured error. Script errors and engine defects are captured automatically. Nothing leaves this computer unless
// the user downloads a report or opens it as a GitHub issue.
'use strict';

const Reports = (() => {
  const KINDS = { bug: 'Bug', error: 'Error (captured)', feedback: 'Feedback', feature: 'Feature request' };
  const STATUS = { new: 'New', confirmed: 'Confirmed', in_progress: 'In progress', fixed: 'Fixed', closed: 'Closed', wont_fix: 'Will not fix', duplicate: 'Duplicate' };
  const SEVERITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
  const OPEN = ['new', 'confirmed', 'in_progress'], REOPEN = ['fixed', 'closed'];   // a recurrence keeps "will not fix" and "duplicate"
  const KEY_REPO = 'soloptima.issueRepo', KEY_PENDING = 'soloptima.pendingReports';
  const recent = [];        // the last errors of this session, attached to new reports
  const seen = new Map();   // signature -> occurrences waiting to be added to its report
  let info = null, chain = Promise.resolve(), list = [], sel = null, filter = 'open', kind = 'bug';

  const now = () => new Date().toISOString();
  const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : '');
  const who = () => { const u = Home.current(); return u ? u.name + (u.organisation ? ` (${u.organisation})` : '') : 'someone without a profile'; };
  const select = (id, map, v) => `<select id="${id}">${Object.entries(map).map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  async function getInfo() { if (!info) info = await api('/api/info').catch(() => ({})); return info; }

  // what was on screen when the report was made
  function context() {
    const c = { app_version: (info && info.version) || '', os: info && info.os ? `${info.os} ${info.arch}` : '', browser: navigator.userAgent };
    try {
      c.page = document.body.classList.contains('signin-mode') ? 'Sign-in' : document.body.classList.contains('home-mode') ? 'Projects' : ((location.hash.match(/t=(\w+)/) || [])[1] || '');
      if (P && !document.body.classList.contains('home-mode')) { c.project = P.name; c.project_id = P.id || ''; }
    } catch (e) { /* the app is still loading */ }
    return c;
  }
  // The first stack frame in the app's own code (not this file or util.js), as "file.js:line". Chrome and Safari formats.
  function appFrame(stack) {
    for (const ln of String(stack || '').split('\n')) {
      const m = ln.match(/([\w.-]+\.js):(\d+)(?::\d+)?\)?\s*$/);
      if (m && m[1] !== 'reports.js' && m[1] !== 'util.js') return `${m[1]}:${m[2]}`;
    }
    return '';
  }
  // Errors of the same kind at the same place share one report. Numbers are left out of the key; for engine responses
  // quoted text is too, while script errors keep it (it names the property or function that failed).
  function signatureOf(msg, where, script) {
    let s = String(msg).replace(/\d+(\.\d+)?/g, '#');
    if (!script) s = s.replace(/"[^"]*"|'[^']*'/g, '""');
    s = s.slice(0, 200) + '|' + (where || '');
    return [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16);
  }

  // ---------------------------------------------------------------- capture
  function log(e) { recent.push(e); if (recent.length > 30) recent.shift(); }
  function apiError(path, message, status, unexpected) {
    if (/^\/api\/report/.test(path)) return;   // never report on the reporter itself
    const where = path.split('?')[0];
    log({ time: now(), where, message, status });
    if (unexpected) capture(message, { where, status, logged: true });
  }
  function capture(message, extra = {}) {
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
  function queue(it) {
    chain = chain.then(() => record(it)).catch(() => park(it));
  }
  // the engine is down: keep the error in browser storage and file it on the next start
  function park(it) {
    try { const p = JSON.parse(storeGet(KEY_PENDING) || '[]'); p.push(it); storeSet(KEY_PENDING, JSON.stringify(p.slice(-20))); } catch (e) { /* storage blocked */ }
  }
  async function record(it) {
    await getInfo();
    if (!it.context.app_version) it.context = { ...it.context, app_version: info.version || '', os: info.os ? `${info.os} ${info.arch}` : '' };
    const hit = (await api('/api/reports')).find((r) => r.signature === it.sig);
    if (hit) return recur(hit.id, it);
    const where = it.extra.where ? ` at ${it.extra.where}` : '';
    const s = await save({
      kind: 'error', status: 'new', severity: 'medium', title: it.message.slice(0, 120), signature: it.sig, count: it.add || 1, first_seen: it.time, last_seen: it.time,
      description: it.message, where: it.extra.where || '', stack: String(it.extra.stack || '').slice(0, 4000), context: it.context, recent: it.recent,
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
  function init() {
    window.addEventListener('error', (e) => {
      if (!e.message && !e.error) return;
      const stack = e.error && e.error.stack;
      capture(e.error && e.error.message ? e.error.message : e.message, { where: appFrame(stack) || `${(e.filename || '').split('/').pop()}:${e.lineno || ''}`, stack });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason || {};
      if (r.logged) return;   // already handled by apiError
      capture(r.message || String(r), { where: appFrame(r.stack) || 'promise', stack: r.stack });
    });
    // repeats still waiting for their 30 s save go to browser storage when the tab closes
    window.addEventListener('pagehide', () => seen.forEach((s) => { if (s.pending) { park({ ...s.item, add: s.pending }); s.pending = 0; } }));
    getInfo().then(flushPending);
  }

  // ---------------------------------------------------------------- documents
  function save(r) {
    const t = now();   // the engine sets the same fields; set them here too so the Markdown written with this save has them
    r.updated = t;
    r.created = r.created || t;
    return api('/api/report', { report: r, markdown: toMarkdown(r) });
  }
  // Load a report, apply a change and save it. A save based on an older copy is refused by the engine (another tab, or an
  // error recorded while the dialog was open): reload and apply the change again.
  async function mutate(id, change) {
    for (let k = 0; ; k++) {
      const r = await api('/api/report?id=' + encodeURIComponent(id));
      change(r);
      try { return await save(r); } catch (e) { if (k >= 3 || !/changed since/.test(e.message)) throw e; }
    }
  }
  // Text for a public issue: no local paths, profile or project names
  function redact(s) {
    let t = String(s == null ? '' : s);
    const swap = (a, b) => { if (a && String(a).length > 2) t = t.split(String(a)).join(b); };
    swap(info && info.reports_dir, '<reports>'); swap(info && info.data_dir, '<data>');
    t = t.replace(/(\/Users\/|\/home\/)[^/\s"']+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~')
      .replace(/users([\\/])[^\\/\s"']+/g, 'users$1<profile>').replace(/projects([\\/])[^\\/\s"']+\.json/g, 'projects$1<project>.json');
    const u = Home.current();
    if (u) { swap(u.id, '<profile>'); swap(u.name, '<profile>'); }
    if (sel && sel.context) { swap(sel.context.project_id, '<project>'); swap(sel.context.project, '<project>'); }
    return t;
  }
  // The Markdown copy saved next to each report. With pub=true (a public issue) the reporter, project, notes and history
  // are left out and local paths and names are replaced.
  function toMarkdown(r, pub) {
    const x = pub ? redact : (s) => s;
    const id = r.id || '{{id}}', L = [`# ${id}: ${x(r.title)}`, '', '| Field | Value |', '|---|---|'];
    const row = (k, v) => { if (v) L.push(`| ${k} | ${String(v).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')} |`); };
    const c = r.context || {};
    row('Kind', KINDS[r.kind]); row('Status', STATUS[r.status]); row('Severity', SEVERITY[r.severity]);
    if (!pub) row('Reported by', r.reporter);
    row('Created', fmtTime(r.created || r.first_seen)); row('Last updated', fmtTime(r.updated));
    if (r.kind === 'error') row('Occurrences', `${r.count || 1} (first ${fmtTime(r.first_seen)}, last ${fmtTime(r.last_seen)})`);
    row('App version', [c.app_version, c.os].filter(Boolean).join(', ')); row('Browser', c.browser); row('Page', c.page);
    if (!pub) row('Project', c.project ? `${c.project}${c.project_id ? ` (${c.project_id})` : ''}` : '');
    // free text; an unclosed code fence would swallow the rest of the document
    const sec = (h, t) => {
      t = String(t || '').trim();
      if (!t) return;
      L.push('', '## ' + h, '', x(t));
      if ((t.match(/^```/gm) || []).length % 2) L.push('```');
    };
    sec('What happened', r.description); sec('Steps to reproduce', r.steps); sec('Expected result', r.expected);
    if (r.where || r.stack) L.push('', '## Error details', '', '```', x([r.where, r.stack].filter(Boolean).join('\n')).replace(/^```/gm, "'''"), '```');
    if (r.recent && r.recent.length) {
      L.push('', '## Errors before this report', '');
      r.recent.forEach((e) => L.push(`- ${fmtTime(e.time)} · ${e.where}${e.status ? ` (HTTP ${e.status})` : ''} · ${x(String(e.message)).replace(/\s*\n\s*/g, ' ')}`));
    }
    if (!pub) {
      if (r.project) L.push('', '## Attached project', '', `The project inputs are stored under "project" in ${id}.json.`);
      L.push('', '## History', '');
      // continuation lines are indented so a multi-line note stays one entry
      (r.history || []).forEach((h) => L.push(`- ${fmtTime(h.time)} · ${String(h.text).replace(/\r?\n/g, '\n  ').replace(/^ {2}```/gm, "  '''")}`));
    }
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- new report
  async function openForm() {
    await getInfo();
    const d = $('#dlgReport');
    d.innerHTML = `<form method="dialog" class="dlg-body">
      <div class="dlg-head"><h2>Report a problem or send feedback</h2><button type="button" class="btn ghost small" data-close>Close</button></div>
      <div class="seg" id="rpKind">${['bug', 'feedback', 'feature'].map((k) => `<button type="button" data-v="${k}" class="${k === kind ? 'on' : ''}">${KINDS[k]}</button>`).join('')}</div>
      <label>Title<input id="rpTitle" maxlength="120" required placeholder="Short summary, for example: Optimiser stops at 40 %"></label>
      <label><span id="rpWhatLbl">What happened</span><textarea id="rpWhat" rows="4"></textarea></label>
      <div class="bug-only grid-2">
        <label>Steps to reproduce<textarea id="rpSteps" rows="3" placeholder="1. Open the example study&#10;2. ..."></textarea></label>
        <label>What you expected<textarea id="rpExpect" rows="3"></textarea></label>
      </div>
      <label class="bug-only">Severity ${select('rpSev', SEVERITY, 'medium')}</label>
      <label class="check"><input type="checkbox" id="rpRecent" ${recent.length ? 'checked' : 'disabled'}><span>Attach the errors of this session (${recent.length})</span></label>
      <label class="check"><input type="checkbox" id="rpProject" ${document.body.classList.contains('home-mode') ? 'disabled' : ''}><span>Attach the open project's inputs</span></label>
      <p class="hint">The report is saved in ${escapeHtml(info.reports_dir || 'the reports folder')} with a dated history. Nothing is sent anywhere.</p>
      <div class="dlg-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="rpSave">Save report</button></div>
    </form>`;
    const paint = () => {
      $$('#rpKind button', d).forEach((b) => b.classList.toggle('on', b.dataset.v === kind));
      $$('.bug-only', d).forEach((e) => (e.hidden = kind !== 'bug'));
      $('#rpWhatLbl', d).textContent = { bug: 'What happened', feedback: 'Your feedback', feature: 'What you would like Soloptima to do, and why' }[kind];
    };
    $$('#rpKind button', d).forEach((b) => (b.onclick = () => { kind = b.dataset.v; paint(); }));
    $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
    $('form', d).onsubmit = async (e) => {
      e.preventDefault();
      const title = $('#rpTitle', d).value.trim();
      if (!title) { $('#rpTitle', d).focus(); return; }
      const u = Home.current(), r = {
        kind, status: 'new', severity: kind === 'bug' ? $('#rpSev', d).value : 'low', title, reporter: u ? who() + (u.email ? ` <${u.email}>` : '') : '',
        description: $('#rpWhat', d).value, steps: kind === 'bug' ? $('#rpSteps', d).value : '', expected: kind === 'bug' ? $('#rpExpect', d).value : '',
        context: context(), recent: $('#rpRecent', d).checked ? recent.slice(-15) : [], history: [{ time: now(), event: 'created', text: `Reported by ${who()}.` }],
      };
      if ($('#rpProject', d).checked) r.project = clone(P);
      $('#rpSave', d).disabled = true;
      let s;
      try { s = await save(r); } catch (err) { toast(err.message, true); $('#rpSave', d).disabled = false; return; }
      d.close();
      try { await openList(s.id); } finally { toast(`Saved as ${s.id}.`); }   // after the list dialog opens, so it shows above it
    };
    paint();
    d.showModal();
    $('#rpTitle', d).focus();
  }

  // ---------------------------------------------------------------- report list and history
  async function openList(id) {
    await getInfo();
    const d = $('#dlgReports');
    d.innerHTML = `<div class="dlg-body reports">
      <div class="dlg-head"><h2>Bug reports and feedback</h2><button class="btn ghost small" data-close>Close</button></div>
      <div class="rp-split">
        <aside class="rp-list">
          <div class="row gap"><div class="seg" id="rpFilter"><button data-v="open">Open</button><button data-v="all">All</button><button data-v="error">Captured errors</button></div></div>
          <input id="rpSearch" type="search" placeholder="Search reports" aria-label="Search reports">
          <div id="rpItems"></div>
          <div class="hint">Files: ${escapeHtml(info.reports_dir || '')}</div>
          <label class="hint">GitHub repository for issues<input id="rpRepo" placeholder="owner/repository" value="${escapeHtml(storeGet(KEY_REPO) || '')}"></label>
        </aside>
        <section class="rp-detail" id="rpDetail"><p class="hint">Select a report.</p></section>
      </div></div>`;
    $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
    $$('#rpFilter button', d).forEach((b) => (b.onclick = () => { filter = b.dataset.v; paintList(); }));
    $('#rpSearch', d).oninput = paintList;
    $('#rpRepo', d).onchange = (e) => {
      const v = e.target.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) { toast('Enter the repository as owner/name, for example acme/soloptima.', true); return; }
      storeSet(KEY_REPO, v);
      if (sel) paintDetail();
    };
    if (!d.open) d.showModal();
    try { list = await api('/api/reports'); } catch (e) { list = []; toast(e.message, true); }
    if (id) filter = 'all';
    paintList();
    const first = id || ((list.find((r) => OPEN.includes(r.status)) || list[0] || {}).id);
    if (first) await show(first);
  }
  function paintList() {
    const d = $('#dlgReports'), q = ($('#rpSearch', d).value || '').toLowerCase();
    $$('#rpFilter button', d).forEach((b) => b.classList.toggle('on', b.dataset.v === filter));
    const rows = list.filter((r) => (filter === 'all' || (filter === 'open' ? OPEN.includes(r.status) : r.kind === 'error'))
      && (!q || `${r.id} ${r.title}`.toLowerCase().includes(q)));
    $('#rpItems', d).innerHTML = rows.length ? rows.map((r) => `<button class="rp-item ${sel && sel.id === r.id ? 'on' : ''}" data-id="${escapeHtml(r.id)}">
        <span class="rp-id">${escapeHtml(r.id)}</span><b>${escapeHtml(r.title || '')}</b>
        <span class="rp-meta"><span class="tag st-${STATUS[r.status] ? r.status : 'other'}">${STATUS[r.status] || escapeHtml(r.status)}</span>${KINDS[r.kind] || ''}${r.count > 1 ? ` · ${+r.count}×` : ''} · ${escapeHtml(fmtTime(r.updated).slice(0, 10))}</span></button>`).join('')
      : `<p class="hint">${list.length ? 'No report matches.' : 'No reports yet. Use Report a problem in the top bar, or wait: errors are recorded here automatically.'}</p>`;
    $$('[data-id]', d).forEach((b) => (b.onclick = () => show(b.dataset.id)));
  }
  async function show(id) {
    try { sel = await api('/api/report?id=' + encodeURIComponent(id)); } catch (e) { toast(e.message, true); return; }
    paintList();
    paintDetail();
  }
  function paintDetail() {
    const r = sel, el = $('#rpDetail'), repo = storeGet(KEY_REPO) || '';
    el.innerHTML = `<div class="rp-tools">
        <label>Status ${select('rpStatus', STATUS, r.status)}</label>
        <label>Severity ${select('rpSevD', SEVERITY, r.severity)}</label>
        <span class="spacer"></span>
        <button class="btn small" id="rpMd">Download .md</button>
        <button class="btn small" id="rpCopy" title="Copy without the reporter, project, notes and history; local paths and names are replaced">Copy for an issue</button>
        ${repo ? '<button class="btn small" id="rpGh">Open GitHub issue</button>' : ''}
        <button class="btn ghost small danger" id="rpDel">Delete</button>
      </div>
      <div class="row gap rp-note"><textarea id="rpNote" rows="2" placeholder="Add a note to the history: what you tried, a workaround, the fix and the version it is in"></textarea><button class="btn small" id="rpAddNote">Add note</button></div>
      <div class="md">${mdToHtml(toMarkdown(r))}</div>`;
    const change = (field, map, v, labelText) => commit((x) => {
      if (v === x[field]) return;
      x.history.push({ time: now(), event: field, text: `${labelText} changed from ${map[x[field]] || x[field]} to ${map[v]} by ${who()}.` });
      x[field] = v;
    });
    $('#rpStatus', el).onchange = (e) => change('status', STATUS, e.target.value, 'Status');
    $('#rpSevD', el).onchange = (e) => change('severity', SEVERITY, e.target.value, 'Severity');
    $('#rpAddNote', el).onclick = () => {
      const t = $('#rpNote', el).value.trim();
      if (t) commit((x) => x.history.push({ time: now(), event: 'note', text: `Note by ${who()}: ${t}` }));
    };
    $('#rpMd', el).onclick = () => download(`${r.id}.md`, toMarkdown(r), 'text/markdown');
    $('#rpCopy', el).onclick = async () => {
      try { await navigator.clipboard.writeText(toMarkdown(r, true)); toast('Copied. Check the text before you post it anywhere public.'); } catch (e) { toast('The browser blocked the clipboard; use Download .md instead.', true); }
    };
    const gh = $('#rpGh', el);
    if (gh) gh.onclick = async () => {
      // the issue is only opened in the browser for the user to check and submit; long reports go through the clipboard
      const body = toMarkdown(r, true), title = `${r.id}: ${redact(r.title)}`;
      let url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      if (url.length > 7500) {
        try { await navigator.clipboard.writeText(body); } catch (e) { /* the user can still download it */ }
        url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent('Paste the report here (it was copied to the clipboard).')}`;
        toast('The report is long: it was copied to the clipboard. Paste it into the issue.');
      }
      window.open(url, '_blank', 'noopener');
      commit((x) => x.history.push({ time: now(), event: 'shared', text: `Opened as a GitHub issue in ${repo} by ${who()}.` }));
    };
    $('#rpDel', el).onclick = async () => {
      if (!confirm(`Delete ${r.id} and its history from this computer? This cannot be undone.`)) return;
      try { await api('/api/report/delete?id=' + encodeURIComponent(r.id), {}, 'POST'); } catch (e) { toast(e.message, true); return; }
      list = list.filter((x) => x.id !== r.id); sel = null;
      paintList();
      $('#rpDetail').innerHTML = '<p class="hint">Report deleted.</p>';
    };
  }
  // apply a change to the selected report on its latest saved copy
  async function commit(change) {
    try {
      sel = await mutate(sel.id, change);
      list = await api('/api/reports');
    } catch (e) { toast(e.message, true); }
    paintList();
    paintDetail();
  }

  return { init, apiError, capture, openForm, openList };
})();
