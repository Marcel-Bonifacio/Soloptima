// Updates from the GitHub releases (src-tauri/src/update.rs, the Tauri updater). After sign-in Soloptima checks at most once
// a day, unless that is turned off in Settings; a newer version shows a button in the top bar. Nothing is downloaded until
// the user confirms; the app installs the download only when its signature verifies with a release key, and then restarts.
import { app, openDialog } from './state.svelte.js';
import { call } from './ipc.js';
import { flush } from './projects.svelte.js';
import { fmtNum } from './format.js';
import { toast } from './toast.js';

const DAY = 24 * 3600e3;
export const upd = $state({
  info: null,     // the last check: {current, latest, newer, name, notes, url, published, installable}
  button: '',     // the version on the top bar's button; '' hides it
  // the download, which carries on while the dialog is closed: idle, downloading, ready, installing
  dl: { phase: 'idle', done: 0, total: 0, msg: '', kind: '' },
});

// The automatic check: quiet when offline, and at most once a day. A newer version found earlier shows its button
// without asking GitHub again; the details are fetched when the button is used.
export async function autoCheck() {
  try {
    const s = await call('settings');
    if (!s.update_auto) return;
    if (s.update_checked && Date.now() - Date.parse(s.update_checked) < DAY) {
      if (s.update_latest && s.update_latest !== s.update_skip && s.update_latest !== s.version) upd.button = s.update_latest;
      return;
    }
    await check(false);
  } catch (e) { /* GitHub unreachable: the next start tries again */ }
}

// manual: from Settings, which always answers and opens the update dialog
export async function check(manual) {
  if (manual && !app.user) { toast('Sign in first to check for updates.'); return null; }   // no service before the terms
  let info;
  try { info = await call('update_check'); } catch (e) {
    if (manual) toast('Could not check for updates: ' + e.message, true);
    return null;
  }
  upd.info = info;
  call('settings_update', { body: { checked: new Date().toISOString(), latest: info.newer ? info.latest : '' } }).catch(() => {});
  if (info.newer) {
    const s = manual ? {} : await call('settings').catch(() => ({}));
    if (manual || s.update_skip !== info.latest) upd.button = info.latest;
    if (manual) openDialog('update');
  } else if (manual) toast(`Soloptima ${info.current} is the latest version.`);
  return info;
}

// The top bar's button: the details of an earlier check are fetched first
export async function openUpdate() {
  if (!upd.info || !upd.info.newer) {
    try { upd.info = await call('update_check'); } catch (e) { toast('Could not reach GitHub: ' + e.message, true); return; }
    if (!upd.info.newer) { upd.button = ''; toast(`Soloptima ${upd.info.current} is the latest version.`); return; }
  }
  openDialog('update');
}

export function skip() {
  call('settings_update', { body: { skip: upd.info.latest } }).catch(() => {});
  upd.button = '';
  app.dialog = null;
}

const mb = (b) => fmtNum(b / 1048576, 1) + ' MB';

export async function download() {
  const dl = upd.dl;
  if (dl.phase === 'downloading') return;
  Object.assign(dl, { phase: 'downloading', done: 0, total: 0, msg: 'Downloading…', kind: '' });
  try {
    const run = call('update_download', { body: {} });
    const poll = setInterval(async () => {
      const s = await call('update_progress').catch(() => null);
      if (!s || dl.phase !== 'downloading' || !s.total) return;
      Object.assign(dl, { done: s.progress, total: s.total, msg: `Downloading: ${mb(s.progress)} of ${mb(s.total)}` });
    }, 400);
    try { await run; } finally { clearInterval(poll); }
    Object.assign(dl, { phase: 'ready', msg: 'Downloaded and verified. Soloptima saves your work, closes and installs the update.', kind: 'ok' });
  } catch (e) {
    Object.assign(dl, { phase: 'idle', msg: e.message, kind: 'err' });
  }
}

export async function install() {
  const dl = upd.dl;
  dl.phase = 'installing';
  if (!(await flush())) {   // the update closes the app: never with unsaved edits
    Object.assign(dl, { phase: 'ready', msg: 'Your latest changes could not be saved, so the update waits. Save the project, then try again.', kind: 'err' });
    return;
  }
  try {
    const r = await call('update_install', { body: {} });
    Object.assign(dl, { msg: r.mode === 'installer' ? 'The setup program has started. Soloptima closes now.' : 'Installed. Soloptima restarts in a moment.', kind: 'ok' });
  } catch (e) {
    Object.assign(dl, { phase: 'ready', msg: e.message, kind: 'err' });
  }
}
