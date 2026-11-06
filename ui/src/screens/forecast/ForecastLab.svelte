<!-- Forecast Lab card of the Forecast & EMS page: benchmark every PV and load forecasting method and its value to the EMS -->
<script>
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import { forms } from '../../lib/state.svelte.js';
  import { fl, runBench, result, togglePick, useMethod } from '../../lib/forecast.svelte.js';
  import { METRICS, TABLE_HEADS, leadChart, valueChart, tableRows, seriesChart, weekLabel, colorOf } from '../../lib/forecast-view.js';
  import { colours } from '../../lib/chart.js';

  // the result, and the method in use (the EMS settings are the project's: forms.rev says they changed)
  const B = $derived.by(() => { fl.rev; return result(); });
  const inUse = $derived.by(() => { forms.rev; fl.rev; const E = W.P.ems; return fl.variable === 'pv' ? E.pv_forecast : E.load_forecast; });
  const rows = $derived.by(() => { forms.rev; return B ? tableRows(B, fl.variable, inUse, W.P.econ.currency, colours()) : []; });
  const methods = $derived(B ? B[fl.variable].methods.filter((m) => m.id !== 'perfect') : []);
  const note = $derived(B && B.value_note ? B.value_note : '');
</script>

<div class="card">
  <div class="row space"><h3>Forecast Lab: compare forecasting methods</h3>
    <div class="row gap"><button id="btnBench" class="btn primary" disabled={fl.busy} onclick={runBench}>Run benchmark</button><span id="benchStatus" class="status inline {fl.kind}" role="status">{fl.status}</span></div></div>
  <p class="hint">Every method except "Perfect forecast" and "Perfect + random error" uses only data from before the forecast is issued. Errors are normalised by the mean actual value (PV: daylight hours). Skill = 1 − RMSE / RMSE of persistence. "Value" re-runs the predictive EMS for year 1 with each method and compares fuel, genset hours and cost against load following.</p>
  {#if B}
    <div id="benchBody">
      {#if note}<p class="hint">{note}</p>{/if}
      <div class="row gap">
        <div class="seg" id="benchVar">{#each [['pv', 'PV'], ['load', 'Load']] as [v, l] (v)}<button type="button" class:on={fl.variable === v} onclick={() => (fl.variable = v)}>{l}</button>{/each}</div>
        <select id="benchMetric" aria-label="Metric" bind:value={fl.metric}>{#each METRICS as [v, l] (v)}<option value={v}>{l}</option>{/each}</select>
      </div>
      <div class="grid-2">
        <div><Chart id="chBenchLead" cls="tall" build={(c) => leadChart(B, fl.variable, fl.metric, inUse, c)} /></div>
        <div><Chart id="chBenchValue" cls="tall" build={(c) => valueChart(B, fl.variable, c)} /></div>
      </div>
      <div id="benchTable" class="table-wrap">
        <table class="data">
          <thead><tr>{#each TABLE_HEADS as h (h)}<th>{h}</th>{/each}<th></th></tr></thead>
          <tbody>{#each rows as r (r.id)}
            <tr><td title={r.description}><span class="chip-dot" style:background={r.color}></span>{r.name}{#if r.best}<span class="tag good">best day-ahead</span>{/if}{#if r.inUse}<span class="tag">in use</span>{/if}</td>
              {#each r.cells as x, i (i)}<td>{x}</td>{/each}
              <td>{#if r.usable}<button type="button" class="btn small" onclick={() => useMethod(r.id)}>Use in EMS</button>{/if}</td></tr>
          {/each}</tbody>
        </table>
      </div>
      <div class="row space mt"><h3>Forecast vs actual</h3>
        <div class="row gap"><div class="seg" id="benchHorizon">{#each [['da', 'Day-ahead (issued 12:00 D-1)'], ['h1', 'Hour-ahead']] as [v, l] (v)}<button type="button" class:on={fl.horizon === v} onclick={() => (fl.horizon = v)}>{l}</button>{/each}</div>
          <label>Week <input type="range" id="benchWeek" min="0" max="51" bind:value={fl.week}></label><span id="benchWeekLabel" class="hint inline">{weekLabel(fl.week)}</span></div></div>
      <div id="benchPick" class="chips">{#each methods as m (m.id)}
        <button type="button" class="chip" class:on={fl.picked[fl.variable].includes(m.id)} aria-pressed={fl.picked[fl.variable].includes(m.id)} onclick={() => togglePick(m.id)}><i style:background={colorOf(m.id, colours())}></i>{m.name}</button>
      {/each}</div>
      <Chart id="chBenchSeries" cls="tall" build={(c) => seriesChart(B, fl.variable, fl.horizon, fl.week, fl.picked[fl.variable], c)} />
    </div>
  {/if}
</div>
