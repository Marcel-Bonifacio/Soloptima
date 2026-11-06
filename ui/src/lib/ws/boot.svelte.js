// The workspace's start: the engine's state for the side navigation, the placeholder project, and the landing page.
import { call } from '../ipc.js';
import { toast } from '../toast.js';
import { reload } from '../layout/map.svelte.js';

export const engine = $state({ text: 'engine: connecting…' });

export async function bootWorkspace() {
  reload(false);   // the placeholder project: no address lookup
  try { await call('info'); engine.text = 'engine · Rust'; } catch (e) { engine.text = 'engine offline'; toast(e.message, true); }
}
