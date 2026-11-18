<!-- Metered PV output against the yield model: the meter file, monthly bars, statistics, and the fitted soiling and availability with Apply and Undo -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { pv } from '../../lib/pv.svelte.js';
  import { openImport } from '../../lib/tsimport.svelte.js';
  import { pm, meterResult, applyFit, undoFit, undoAllowed, clearMeter } from '../../lib/pvmeter.svelte.js';
  import { statRows, STAT_HEADS, monthRows, MONTH_HEADS, fitView, meterFig, meterLine } from '../../lib/pvmeter-view.js';
  import { toast } from '../../lib/toast.js';

  const R = $derived.by(() => { forms.rev; pv.rev; pm.rev; return meterResult(); });
  const M = $derived.by(() => { forms.rev; pm.rev; return W.P ? W.P.pv_meter : null; });
  const line = $derived(meterLine(M));
  const F = $derived(R ? fitView(R) : null);
  const undo = $derived.by(() => { forms.rev; pm.rev; return undoAllowed(); });
  const kwp = $derived.by(() => { forms.rev; return W.P ? W.P.pv.capacity_kwp : 0; });

  async function picked(e) {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!f) return;
    try { await openImport('pv', f); } catch (err) { toast(err.message, true); }
  }
</script>

<div class="card" id="pvMeterCard"><div class="row space"><h3>Measured output against the model <button type="button" class="info" data-k="pv_meter.card" data-title="Measured output against the model" aria-label="About Measured output against the model" aria-expanded="false">i</button></h3>
    <div class="row gap"><label class="btn small ghost">{M ? 'Replace meter CSV' : 'Upload meter CSV'}<input type="file" id="filePvMeter" accept=".csv,.txt" hidden onchange={picked}></label>
      {#if M}<button type="button" class="btn small ghost" onclick={clearMeter}>Remove</button>{/if}</div></div>
  {#if !M}
    <p class="hint">Metered AC output of an existing plant (kW or kWh per interval, any interval up to an hour, with timestamps; a part of a year is enough) is compared hour by hour with the yield model, and the soiling and availability that bring the model closest to it are offered to apply.</p>
  {:else}
    <p id="pvMeterLine" class="hint">{line}</p>
    {#if pm.err}<div class="warnbox">{pm.err}</div>
    {:else if !R}<p class="status">{pm.busy ? 'Comparing with the yield…' : 'Calculate the yield to compare it with the meter.'}</p>
    {:else}
      <Chart id="chPvMeter" build={(c) => meterFig(R, c, kwp)} />
      <DataTable heads={STAT_HEADS} rows={statRows(R)} />
      <ul class="cal-diag">{#each F.lines as t}<li>{t}</li>{/each}{#each R.notes as n}<li>{n}</li>{/each}</ul>
      <div class="row gap">
        {#if F.monthly}<select bind:value={pm.mode} aria-label="Soiling to apply"><option value="constant">Constant soiling</option><option value="monthly">Monthly soiling ({F.own} months fitted)</option></select>{/if}
        <button type="button" class="btn small" id="btnPvMeterApply" onclick={applyFit}>Apply soiling and availability</button>
        {#if undo}<button type="button" class="btn small ghost" id="btnPvMeterUndo" onclick={undoFit}>Undo</button>{/if}
      </div>
      <details><summary>By month</summary>
        <DataTable heads={MONTH_HEADS} rows={monthRows(R)} /></details>
    {/if}
  {/if}
</div>
