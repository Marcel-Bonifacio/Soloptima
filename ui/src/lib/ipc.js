// The only way the interface reaches the engine and the shell: the Tauri commands of docs/ipc.md.
import { legacy } from './legacy.js';

const tauri = () => window.__TAURI__ || null;

// call('project_load', {user, id}) -> the command's JSON answer. Errors become Error objects with the engine's message;
// `internal` marks defects, which also go to the bug-report log as the old api() did.
export async function call(cmd, args = {}) {
  const T = tauri();
  if (!T) throw new Error('Soloptima runs in its desktop app. Start the app instead of opening this page.');
  try {
    return await T.core.invoke(cmd, args);
  } catch (e) {
    const msg = (e && e.error) || (typeof e === 'string' ? e : (e && e.message) || 'Unknown error');
    const internal = !!(e && e.internal) || /^JSON parse error/.test(msg);
    legacy.apiError(cmd, msg, internal ? 500 : 400, internal);
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
export const openExternal = (url) => call('open_url', { url }).catch((e) => legacy.toast(e.message || 'Cannot open the link.', true));
