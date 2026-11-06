<!-- The selected report: status and severity, the tools, a note to the history, and the report as Markdown -->
<script>
  import Markdown from '../../lib/Markdown.svelte';
  import { rp, markdown, setStatus, setSeverity, addNote, downloadMd, copyForIssue, openIssue, remove } from '../../lib/reports.svelte.js';
  import { STATUS, SEVERITY } from '../../lib/reports/doc.js';

  let note = $state('');
  const r = $derived(rp.sel);
  const text = $derived(markdown(r));
  async function add() { const t = note.trim(); if (t) { note = ''; await addNote(t); } }
</script>

<div class="rp-tools">
  <label>Status
    <select value={r.status} onchange={(e) => setStatus(e.target.value)}>{#each Object.entries(STATUS) as [k, t] (k)}<option value={k}>{t}</option>{/each}</select>
  </label>
  <label>Severity
    <select value={r.severity} onchange={(e) => setSeverity(e.target.value)}>{#each Object.entries(SEVERITY) as [k, t] (k)}<option value={k}>{t}</option>{/each}</select>
  </label>
  <span class="spacer"></span>
  <button type="button" class="btn small" onclick={downloadMd}>Download .md</button>
  <button type="button" class="btn small" title="Copy without the reporter, project, notes and history; local paths and names are replaced" onclick={copyForIssue}>Copy for an issue</button>
  {#if rp.repo}<button type="button" class="btn small" onclick={openIssue}>Open GitHub issue</button>{/if}
  {#if rp.confirmDel}
    <button type="button" class="btn small danger" onclick={remove}>Delete {r.id} for good</button>
    <button type="button" class="btn ghost small" onclick={() => (rp.confirmDel = false)}>Keep</button>
  {:else}
    <button type="button" class="btn ghost small danger" onclick={() => (rp.confirmDel = true)}>Delete</button>
  {/if}
</div>
<div class="row gap rp-note">
  <textarea rows="2" bind:value={note} placeholder="Add a note to the history: what you tried, a workaround, the fix and the version it is in"></textarea>
  <button type="button" class="btn small" onclick={add}>Add note</button>
</div>
<Markdown {text} />
