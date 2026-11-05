// Updates from the GitHub releases (src/update.cpp). After sign-in Soloptima checks at most once a day, unless that is
// turned off in Settings; a newer version shows a button in the top bar. Nothing is downloaded until the user confirms;
// the engine installs the download only when its checksum matches the release's list, and the app then restarts.
'use strict';

const Update = (() => {
  const DAY = 24 * 3600e3;
  let info = null;   // the last check: {current, latest, newer, name, notes, url, published, asset, installable}
  // the download, which carries on while the window is closed: idle, downloading, ready, installing
  const dl = { phase: 'idle', done: 0, total: 0, msg: '', kind: '' };

  function showButton(version) {
    const b = $('#btnUpdate');
    b.textContent = `Update to ${version}`;
    b.hidden = false;
  }
  // The automatic check: quiet when offline, and at most once a day. A newer version found earlier shows its button
  // without asking GitHub again; the details are fetched when the button is used.
  async function auto() {
    try {
      const s = await api('/api/settings');
      if (!s.update_auto) return;
      if (s.update_checked && Date.now() - Date.parse(s.update_checked) < DAY) {
        if (s.update_latest && s.update_latest !== s.update_skip && s.update_latest !== s.version) showButton(s.update_latest);
        return;
      }
      await check(false);
    } catch (e) { /* GitHub unreachable: the next start tries again */ }
  }
  // manual: from Settings or the macOS app menu, which always answer and open the update window
  async function check(manual) {
    if (manual && !Home.current()) { toast('Sign in first to check for updates.'); return null; }   // no service before the terms
    try {
      info = await api('/api/update/check');
    } catch (e) {
      if (manual) toast('Could not check for updates: ' + e.message, true);
      return null;
    }
    api('/api/settings/update', { checked: new Date().toISOString(), latest: info.newer ? info.latest : '' }).catch(() => {});
    if (info.newer) {
      const s = manual ? {} : await api('/api/settings').catch(() => ({}));
      if (manual || s.update_skip !== info.latest) showButton(info.latest);
      if (manual) open();
    } else if (manual) toast(`Soloptima ${info.current} is the latest version.`);
    return info;
  }

  async function open() {
    if (!info || !info.newer) {   // the button came from an earlier check: fetch the details now
      try { info = await api('/api/update/check'); } catch (e) { toast('Could not reach GitHub: ' + e.message, true); return; }
      if (!info.newer) { $('#btnUpdate').hidden = true; toast(`Soloptima ${info.current} is the latest version.`); return; }
    }
    const d = $('#dlgUpdate'), date = info.published ? new Date(info.published).toLocaleDateString() : '';
    d.innerHTML = `<div class="dlg-body update">
      <div class="dlg-head"><h2>Soloptima ${escapeHtml(info.latest)} is available</h2><button type="button" class="btn ghost small" data-close>Close</button></div>
      <p class="hint">You have version ${escapeHtml(info.current)}.${date ? ` Released ${escapeHtml(date)}.` : ''}</p>
      ${info.notes ? `<div class="up-notes md">${mdToHtml(info.notes)}</div>` : ''}
      <div class="up-progress" hidden><div class="progress"><div></div></div><span class="status inline" id="upMsg" role="status"></span></div>
      <div class="dlg-foot">
        <button type="button" class="btn ghost" id="upSkip">Skip this version</button><button type="button" class="btn" data-close>Later</button>
        ${info.installable ? '<button type="button" class="btn primary" id="upGo">Download and install</button>' : '<button type="button" class="btn primary" id="upPage">Open the release page</button>'}
      </div></div>`;
    $$('[data-close]', d).forEach((b) => (b.onclick = () => d.close()));
    $('#upSkip', d).onclick = () => {
      api('/api/settings/update', { skip: info.latest }).catch(() => {});
      $('#btnUpdate').hidden = true;
      d.close();
    };
    const page = $('#upPage', d);
    if (page) page.onclick = () => { window.open(info.url, '_blank', 'noopener'); d.close(); };
    const go = $('#upGo', d);
    if (go) go.onclick = () => (dl.phase === 'ready' ? install() : download());
    wireJumps(d);
    paint();
    d.showModal();
  }

  // The dialog as the download stands (it may have been closed and opened again meanwhile)
  function paint() {
    const d = $('#dlgUpdate'), go = $('#upGo', d);
    if (!go) return;
    const busy = dl.phase === 'downloading' || dl.phase === 'installing';
    $('.up-progress', d).hidden = dl.phase === 'idle' && !dl.msg;
    $('.progress div', d).style.width = (dl.phase === 'ready' || dl.phase === 'installing' ? 100 : Math.min(100, (100 * dl.done) / Math.max(1, dl.total))) + '%';
    setStatus($('#upMsg', d), dl.msg, dl.kind);
    go.disabled = busy;
    go.textContent = dl.phase === 'ready' || dl.phase === 'installing' ? 'Install and restart' : dl.msg && dl.kind === 'err' ? 'Try again' : 'Download and install';
    $('#upSkip', d).disabled = busy || dl.phase === 'ready';
  }
  const mb = (b) => fmtNum(b / 1048576, 1) + ' MB';

  async function download() {
    if (dl.phase === 'downloading') return;
    Object.assign(dl, { phase: 'downloading', done: 0, total: (info.asset && info.asset.size) || 0, msg: 'Downloading…', kind: '' });
    paint();
    try {
      await waitJob((await api('/api/update/download', {})).job, (s) => {
        Object.assign(dl, { done: s.progress, total: s.total, msg: `Downloading: ${mb(s.progress)} of ${mb(s.total)}` });
        paint();
      });
      Object.assign(dl, { phase: 'ready', msg: 'Downloaded and verified. Soloptima saves your work, closes and installs the update.', kind: 'ok' });
    } catch (e) {
      Object.assign(dl, { phase: 'idle', msg: e.message, kind: 'err' });
    }
    paint();
  }

  async function install() {
    dl.phase = 'installing';
    paint();
    if (!(await Home.flush())) {   // the update closes the app: never with unsaved edits
      Object.assign(dl, { phase: 'ready', msg: 'Your latest changes could not be saved, so the update waits. Save the project, then try again.', kind: 'err' });
      paint();
      return;
    }
    try {
      const r = await api('/api/update/install', {});
      dl.msg = r.mode === 'opened' ? 'The disk image is open: drag Soloptima onto Applications to replace this version.'
        : r.mode === 'installer' ? 'The setup program has started. Soloptima closes now.' : 'Installed. Soloptima restarts in a moment.';
      dl.kind = 'ok';
    } catch (e) {
      Object.assign(dl, { phase: 'ready', msg: e.message, kind: 'err' });
    }
    paint();
  }

  function init() { $('#btnUpdate').onclick = open; }
  return { init, auto, check, open, get info() { return info; } };
})();
window.Update = Update;   // the macOS app menu's "Check for Updates…"
