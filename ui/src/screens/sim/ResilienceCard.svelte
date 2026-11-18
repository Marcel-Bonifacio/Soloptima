<!-- Outage survival: the chance that the plant, cut off from the grid, serves its critical load through outages of 1 h and longer -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { live, keyLater } from '../../lib/results.svelte.js';
  import { rsl, runResilience, cancelResilience, setStrip, resilStale } from '../../lib/resilience.svelte.js';
  import { RESIL_HEADS, resilRows, resilCells, resilFig, resilStripFig, stripDurations, stripPick, resilNotes } from '../../lib/resilience-view.js';

  const R = $derived.by(() => { rsl.rev; return W.RESIL ? W.RESIL.res : null; });
  const rows = $derived(R ? resilRows(R).map(resilCells) : []);
  const notes = $derived(R ? resilNotes(R) : []);
  const strip = $derived.by(() => { rsl.rev; forms.rev; return R && W.P ? stripPick(R, W.P.resilience.strip_h) : null; });

  // Does the last study still match the inputs? The fingerprint of the project comes after a pause in editing.
  $effect(() => { forms.rev; keyLater(); });
  const stale = $derived.by(() => { rsl.rev; forms.rev; return !!live.key && resilStale(live.key); });
</script>

<div class="card">
  <div class="row space"><h3>Outage survival</h3>
    <div class="row gap">
      {#if rsl.busy}<button id="btnResilCancel" class="btn ghost" onclick={cancelResilience}>Cancel</button>
        <div class="progress"><div style:width="{(rsl.progress * 100).toFixed(1)}%"></div></div>{/if}
      <button id="btnResil" class="btn" disabled={rsl.busy} onclick={runResilience}>{rsl.busy ? '… Run study' : 'Run study'}</button></div></div>
  <p class="hint">Starts a grid outage at every hour of year 1 (or every few hours) from the stored energy the simulation had then, and follows it up to the longest outage set below with PV, wind, the battery and the gensets serving the critical load (Load page). Gensets fail to start and fail while running as set on the Gensets card. The result is the chance that the critical load has been served in full for the whole outage so far.</p>
  <div class="form"><SchemaForm name="resilience" /></div>
  <div id="resilStatus" class="status {rsl.kind}" role="status">{rsl.status}</div>
  {#if R}
    {#if stale}<div class="warnbox">The inputs changed after this study. Run it again for current figures.</div>{/if}
    <Chart id="chResil" build={(c) => resilFig(R, c)} />
    <DataTable heads={RESIL_HEADS} rows={rows} />
    <div class="row gap"><label class="hint inline">By start hour, outage of
        <select id="resilStrip" aria-label="Outage length of the strip" value={String(strip)} onchange={(e) => setStrip(+e.currentTarget.value)}>
          {#each stripDurations(R) as d}<option value={String(d)}>{d} h</option>{/each}</select>
        <button type="button" class="info" data-k="resilience.strip_h" data-title="Outage length of the strip" aria-label="About the outage length of the strip" aria-expanded="false">i</button></label></div>
    <Chart id="chResilStrip" build={(c) => resilStripFig(R, strip, c)} />
    <p id="resilNote" class="hint">{notes.join(' ')}</p>
  {/if}
</div>
