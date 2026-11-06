<!-- Bug reports and feedback: the list with its filter and search, and the selected report with its history -->
<script>
  import Dialog from '../../lib/Dialog.svelte';
  import ReportDetail from './ReportDetail.svelte';
  import { rp, closeList, show, visible, setRepo, infoNow } from '../../lib/reports.svelte.js';
  import { KINDS, STATUS, fmtTime } from '../../lib/reports/doc.js';

  const rows = $derived(visible());
  const info = $derived(infoNow());
</script>

<Dialog open={rp.list} onclose={closeList} title="Bug reports and feedback" label="Bug reports" class="reports" wide>
  <div class="rp-split">
    <aside class="rp-list">
      <div class="row gap"><div class="seg" role="group" aria-label="Filter">
        {#each [['open', 'Open'], ['all', 'All'], ['error', 'Captured errors']] as [v, t] (v)}
          <button type="button" class:on={rp.filter === v} onclick={() => (rp.filter = v)}>{t}</button>
        {/each}
      </div></div>
      <input type="search" placeholder="Search reports" aria-label="Search reports" bind:value={rp.q}>
      <div>
        {#each rows as r (r.id)}
          <button type="button" class="rp-item" class:on={rp.sel && rp.sel.id === r.id} onclick={() => show(r.id)}>
            <span class="rp-id">{r.id}</span><b>{r.title || ''}</b>
            <span class="rp-meta"><span class="tag st-{STATUS[r.status] ? r.status : 'other'}">{STATUS[r.status] || r.status}</span>{KINDS[r.kind] || ''}{r.count > 1 ? ` · ${+r.count}×` : ''} · {fmtTime(r.updated).slice(0, 10)}</span>
          </button>
        {:else}
          <p class="hint">{rp.items.length ? 'No report matches.' : 'No reports yet. Use Report in the top bar; errors are also recorded here automatically.'}</p>
        {/each}
      </div>
      <div class="hint">Files: {info.reports_dir || ''}</div>
      <label class="hint">GitHub repository for issues
        <input placeholder="owner/repository" value={rp.repo} onchange={(e) => { if (!setRepo(e.target.value)) e.target.value = rp.repo; }}>
      </label>
    </aside>
    <section class="rp-detail">
      {#if rp.sel}<ReportDetail />
      {:else}<p class="hint">{rp.gone ? 'Report deleted.' : 'Select a report.'}</p>{/if}
    </section>
  </div>
</Dialog>
