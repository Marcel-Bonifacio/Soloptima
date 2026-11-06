<!-- A newer version: its notes, then download (with progress), install and restart; or skip it, or open the release page -->
<script>
  import { app } from '../lib/state.svelte.js';
  import { upd, skip, download, install } from '../lib/update.svelte.js';
  import { openExternal } from '../lib/ipc.js';
  import Dialog from '../lib/Dialog.svelte';
  import Markdown from '../lib/Markdown.svelte';

  const info = $derived(upd.info), dl = $derived(upd.dl);
  const date = $derived(info && info.published ? new Date(info.published).toLocaleDateString() : '');
  const busy = $derived(dl.phase === 'downloading' || dl.phase === 'installing');
  const done = $derived(dl.phase === 'ready' || dl.phase === 'installing');
  const width = $derived(done ? 100 : Math.min(100, (100 * dl.done) / Math.max(1, dl.total)));
  const close = () => { app.dialog = null; };
</script>

<Dialog open={!!info} onclose={close} title="Soloptima {info?.latest} is available" label="Update" class="update">
  <p class="hint">You have version {info.current}.{date ? ` Released ${date}.` : ''}</p>
  {#if info.notes}<Markdown class="up-notes md" text={info.notes} />{/if}
  {#if dl.phase !== 'idle' || dl.msg}
    <div class="up-progress"><div class="progress"><div style:width="{width}%"></div></div><span class="status inline {dl.kind}" role="status">{dl.msg}</span></div>
  {/if}
  <div class="dlg-foot">
    <button type="button" class="btn ghost" disabled={busy || dl.phase === 'ready'} onclick={skip}>Skip this version</button>
    <button type="button" class="btn" onclick={close}>Later</button>
    {#if info.installable}
      <button type="button" class="btn primary" disabled={busy} onclick={() => (dl.phase === 'ready' ? install() : download())}>
        {done ? 'Install and restart' : dl.msg && dl.kind === 'err' ? 'Try again' : 'Download and install'}</button>
    {:else}
      <button type="button" class="btn primary" onclick={() => { openExternal(info.url); close(); }}>Open the release page</button>
    {/if}
  </div>
</Dialog>
