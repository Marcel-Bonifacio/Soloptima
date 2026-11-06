<!-- Load page: the synthetic profile settings and the daily shape editors, the upload of measured data, the statistics with their
     data checks and the load charts. The load belongs to the open project; the page reads it again when it changes (dat.rev). -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import QcBlock from '../tsimport/QcBlock.svelte';
  import LoadEditors from './LoadEditors.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { dat, generateButton, uploadLoad } from '../../lib/data.svelte.js';
  import { loadKey, loadView, loadDailyFig, loadMonthlyFig, loadHeatFig, SYNTHETIC_NOTE } from '../../lib/data-view.js';

  const key = $derived.by(() => { forms.rev; dat.rev; return loadKey(W.P); });
  const view = $derived.by(() => { key; return loadView(W.P); });
  // a synthetic profile says so; a measured one shows what the import said
  const status = $derived.by(() => { forms.rev; dat.rev; return dat.loadStatus || (W.P && W.P.load.source !== 'csv' ? SYNTHETIC_NOTE : ''); });

  function picked(e) {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    uploadLoad(f);
  }
</script>

<section id="tab-load" class="tab" class:active={ws.tab === 'load'}>
  <h1>Load</h1>
  <p class="lead">Build an 8760-hour load profile from a daily shape (a synthetic load with day-to-day and hour-to-hour variability), or upload measured data.</p>
  <div class="grid-2">
    <div class="card">
      <h3>Profile</h3>
      <div class="form"><SchemaForm name="load" /></div>
      <div class="row gap">
        <button id="btnLoadGen" class="btn primary" onclick={generateButton}>Generate 8760 profile</button>
        <label class="btn ghost">Upload CSV<input type="file" id="fileLoad" accept=".csv,.txt" hidden onchange={picked}></label>
      </div>
      <p class="hint">CSV from a logger or meter: one row per interval with a timestamp (15-min and 30-min data, gaps and duplicate rows included), or one year of hourly, half-hourly or quarter-hourly rows without one. Mean power or energy per interval; several feeder columns can be summed. The import dialog reports the interval, gaps and duplicates before the data are used.</p>
      <div id="loadStatus" class="status {dat.loadKind}" role="status">{status}</div>
    </div>
    <div class="card"><LoadEditors /></div>
  </div>
  <div class="card"><div id="loadStats">{#if view}<Kpis items={view.kpis} />{/if}</div><div id="loadQc" class="qc"><QcBlock kind="load" /></div></div>
  <div class="card"><h3>Load profile</h3><div class="chart-row">
    <Chart id="chLoadDaily" build={(c) => view && loadDailyFig(c, view)} />
    <Chart id="chLoadMonthly" build={(c) => view && loadMonthlyFig(c, view)} /></div></div>
  <div class="card"><h3>Load by day and hour</h3><Chart id="chLoadHeat" cls="tall" build={(c) => view && loadHeatFig(c, view)} /></div>
</section>
