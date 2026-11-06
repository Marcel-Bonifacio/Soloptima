// The documents of the bug reports (docs/ui.md): the names, the signature that groups equal errors, the Markdown copy saved next
// to each report, and the redaction for a public issue. Plain functions; `ctx` carries what the machine knows: { info, user, sel }.
export const KINDS = { bug: 'Bug', error: 'Error (captured)', feedback: 'Feedback', feature: 'Feature request' };
export const STATUS = { new: 'New', confirmed: 'Confirmed', in_progress: 'In progress', fixed: 'Fixed', closed: 'Closed', wont_fix: 'Will not fix', duplicate: 'Duplicate' };
export const SEVERITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const OPEN = ['new', 'confirmed', 'in_progress'];
export const REOPEN = ['fixed', 'closed'];   // a recurrence keeps "will not fix" and "duplicate"

export const now = () => new Date().toISOString();
export const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : '');

// The first stack frame in the app's own code, as "file.js:line" (Chrome and Safari formats).
export function appFrame(stack, skip = []) {
  for (const ln of String(stack || '').split('\n')) {
    const m = ln.match(/([\w.-]+\.js):(\d+)(?::\d+)?\)?\s*$/);
    if (m && !skip.includes(m[1])) return `${m[1]}:${m[2]}`;
  }
  return '';
}

// The app's frames of a stack as "src/lib/file.js: code line". The interface is built unminified with each module after a
// "// src/..." comment (vite.config.js), so a line of a bundle file maps back to its source file. `read` returns the text of a
// bundle file by its path (/ui/app.js); only paths on the app's own origin are read.
export async function sourceOf(stack, read, max = 4) {
  const out = [];
  for (const ln of String(stack || '').split('\n')) {
    const m = ln.match(/(\/ui\/[\w.-]+\.js):(\d+):\d+\)?\s*$/);
    if (!m) continue;
    const L = String(await read(m[1])).split('\n'), n = +m[2] - 1;
    let k = n;
    while (k >= 0 && !/^\/\/ src\//.test(L[k])) k--;
    const at = `${k >= 0 ? L[k].slice(3) : m[1]}: ${String(L[n] || '').trim().slice(0, 160)}`;
    if (!out.includes(at)) out.push(at);
    if (out.length >= max) break;
  }
  return out.join('\n');
}

// Errors of the same kind at the same place share one report. Numbers are left out of the key; for engine responses quoted text
// is too, while script errors keep it (it names the property or function that failed).
export function signatureOf(msg, where, script) {
  let s = String(msg).replace(/\d+(\.\d+)?/g, '#');
  if (!script) s = s.replace(/"[^"]*"|'[^']*'/g, '""');
  s = s.slice(0, 200) + '|' + (where || '');
  return [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16);
}

// Text for a public issue: no local paths, profile or project names
export function redact(s, ctx = {}) {
  let t = String(s == null ? '' : s);
  const swap = (a, b) => { if (a && String(a).length > 2) t = t.split(String(a)).join(b); };
  const { info, user, sel } = ctx;
  swap(info && info.reports_dir, '<reports>'); swap(info && info.data_dir, '<data>');
  t = t.replace(/(\/Users\/|\/home\/)[^/\s"']+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~')
    .replace(/users([\\/])[^\\/\s"']+/g, 'users$1<profile>').replace(/projects([\\/])[^\\/\s"']+\.json/g, 'projects$1<project>.json');
  if (user) { swap(user.id, '<profile>'); swap(user.name, '<profile>'); }
  if (sel && sel.context) { swap(sel.context.project_id, '<project>'); swap(sel.context.project, '<project>'); }
  return t;
}

// The Markdown copy saved next to each report. With pub=true (a public issue) the reporter, project, notes and history are left
// out and local paths and names are replaced.
export function toMarkdown(r, pub, ctx = {}) {
  const x = pub ? (s) => redact(s, ctx) : (s) => s;
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
  if (r.where || r.stack) L.push('', '## Error details', '', '```', x([r.where, r.source, r.stack].filter(Boolean).join('\n')).replace(/^```/gm, "'''"), '```');
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

// The GitHub address for a report: long reports go through the clipboard, so the address carries a short body then
export function issueUrl(repo, title, body) {
  const base = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=`;
  const url = base + encodeURIComponent(body);
  return url.length > 7500 ? { url: base + encodeURIComponent('Paste the report here (it was copied to the clipboard).'), clipboard: true } : { url, clipboard: false };
}

// "owner/name" from what was typed (a GitHub address is accepted), or null
export function repoName(v) {
  const t = String(v || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return !t || /^[\w.-]+\/[\w.-]+$/.test(t) ? t : null;
}
