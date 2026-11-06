<!-- Solar resource page: the weather source, the annual summary with its data checks, monthly and hourly charts, and the weather-year
     (P50/P90) card. The weather belongs to the open project; the page reads it again when the data change (dat.rev). -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import QcBlock from '../tsimport/QcBlock.svelte';
  import ResourceYears from '../results/ResourceYears.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { dat, fetchWeather, uploadWeather } from '../../lib/data.svelte.js';
  import { weatherKey, weatherView, weatherMonthlyFig, weatherTempFig, weatherHeatFig } from '../../lib/data-view.js';

  // the views are computed again only when the data themselves change, not after every edit of the project
  const key = $derived.by(() => { forms.rev; dat.rev; return weatherKey(W.P); });
  const view = $derived.by(() => { key; return weatherView(W.P); });

  function picked(e) {
    const f = e.currentTarget.files[0];
    e.currentTarget.value = '';
    uploadWeather(f);
  }
</script>

<section id="tab-resource" class="tab" class:active={ws.tab === 'resource'}>
  <h1>Solar resource</h1>
  <p class="lead">Hourly irradiance, temperature and wind for one year, from open-access databases or your own file, and how the results vary over historical years (P50/P90).</p>
  <div class="grid-2">
    <div class="card">
      <h3>Data source</h3>
      <div class="form"><SchemaForm name="weather" /></div>
      <div class="row gap">
        <button id="btnFetchWx" class="btn primary" disabled={dat.wxBusy} onclick={fetchWeather}>{dat.wxBusy ? '… Fetch data' : 'Fetch data'}</button>
        <label class="btn ghost">Upload CSV<input type="file" id="fileWx" accept=".csv,.txt" hidden onchange={picked}></label>
      </div>
      <p class="hint">CSV from a weather station or a data service: one row per interval of up to an hour with a timestamp, or one year of hourly, half-hourly or quarter-hourly rows without one. The import dialog shows the first rows, takes the columns (GHI, and optionally DNI, DHI, temperature and wind speed), the time basis and the units, and reports the interval, gaps and duplicates before the data are used.</p>
      <div id="wxStatus" class="status {dat.wxKind}" role="status">{dat.wxStatus}</div>
    </div>
    <div class="card"><h3>Annual summary</h3>
      <div id="wxStats">{#if view}<Kpis items={view.kpis} />{:else}<p class="hint">No data yet. Choose a database and press Fetch.</p>{/if}</div>
      <div id="wxQc" class="qc"><QcBlock kind="weather" /></div></div>
  </div>
  <div class="card"><h3>Monthly irradiation and temperature</h3><div class="chart-row">
    <Chart id="chWxMonthly" build={(c) => view && weatherMonthlyFig(c, view)} />
    <Chart id="chWxTemp" build={(c) => view && weatherTempFig(c, view)} /></div></div>
  <div class="card"><h3>Global horizontal irradiance by day and hour (local time)</h3><Chart id="chWxHeat" cls="tall" build={(c) => view && weatherHeatFig(c, view)} /></div>
  <ResourceYears />
</section>
