// The only way the interface reaches the engine and the shell: the Tauri commands of docs/ipc.md.
import { apiError } from './reports/capture.js';
import { noteCall } from './reports/trail.js';
import { toast } from './toast.js';
import { safeFileName } from './filename.js';

const tauri = () => window.__TAURI__ || null;

// call('project_load', {user, id}) -> the command's JSON answer. Errors become Error objects with the engine's message;
// `internal` marks defects, which also go to the bug-report log as the old api() did.
export async function call(cmd, args = {}) {
  const T = tauri();
  if (!T) throw new Error('Soloptima runs in its desktop app. Start the app instead of opening this page.');
  const t0 = performance.now();
  try {
    const r = await T.core.invoke(cmd, args);
    noteCall(cmd, performance.now() - t0);
    return r;
  } catch (e) {
    const msg = (e && e.error) || (typeof e === 'string' ? e : (e && e.message) || 'Unknown error');
    noteCall(cmd, performance.now() - t0, msg);
    const internal = !!(e && e.internal) || /^JSON parse error/.test(msg);
    apiError(cmd, msg, internal ? 500 : 400, internal);
    const err = new Error(msg);
    err.internal = internal;
    return Promise.reject(err);
  }
}

// A shell event (quit-request); a no-op outside the app
export function listen(name, fn) {
  const T = tauri();
  if (T) T.event.listen(name, fn);
}

// A link in the user's browser (http, https, mailto only; the shell checks)
export const openExternal = (url) => call('open_url', { url }).catch((e) => toast(e.message || 'Cannot open the link.', true));

// A file for the user through the system's Save dialog (docs/ipc.md, save_file): `data` is a Blob or text. Resolves to the saved
// path, or null when the dialog was cancelled or the save failed (the user is told).
export async function saveFile(name, data, type = 'application/octet-stream') {
  name = safeFileName(name);
  const T = tauri();
  if (!T) { toast('Soloptima runs in its desktop app. Start the app instead of opening this page.', true); return null; }
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  try {
    const r = await T.core.invoke('save_file', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-name': encodeURIComponent(name) } });
    if (r && r.path) toast('Saved ' + r.path.split(/[\\/]/).pop());
    return (r && r.path) || null;
  } catch (e) {
    toast((e && e.error) || 'Cannot save the file.', true);
    return null;
  }
}
