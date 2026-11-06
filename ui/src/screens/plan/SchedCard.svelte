<!-- Operational day-ahead schedule card of the Forecast & EMS page: live weather forecast, the plan, its chart, table and CSV -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import { forms } from '../../lib/state.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { plan, runSchedule, exportSchedule } from '../../lib/plan.svelte.js';
  import { schedStatus, schedWarning, schedTiles, schedFig, schedTable } from '../../lib/plan-view.js';

  // the schedule and what the page shows of it; the project's wind and genset counts are read again when an input changes
  const S = $derived.by(() => { plan.rev; return W.SCHED; });
  const v = $derived.by(() => {
    forms.rev; plan.rev;
    const s = W.SCHED;
    return s ? { warn: schedWarning(s), tiles: schedTiles(s, W.P), table: schedTable(s, W.P), status: schedStatus(s) } : null;
  });
  const status = $derived(plan.kind === 'err' || plan.busy ? plan.status : v ? v.status : plan.status);
  const kind = $derived(plan.busy ? '' : plan.kind === 'err' ? 'err' : v ? 'ok' : '');
</script>

<div class="card">
  <h3>Operational day-ahead schedule</h3>
  <p class="hint">Uses the PV, wind, battery and genset sizes currently in the project, the project load profile for the coming hours, and a live weather forecast. The plan starts at the current hour, from the battery SOC you enter. Open-Meteo's free API is for noncommercial use only. An Open-Meteo API key, or MET Norway (CC BY 4.0), covers the weather data's own terms; it does not license commercial use of Soloptima (see Terms of use).</p>
  <div class="form"><SchemaForm name="sched" /></div>
  <div class="row gap"><button id="btnSched" class="btn primary" disabled={plan.busy} onclick={runSchedule}>Fetch forecast &amp; plan</button>
    {#if S}<button id="btnSchedCsv" class="btn ghost" onclick={exportSchedule}>Export schedule CSV</button>{/if}
    <span id="schedStatus" class="status inline {kind}" role="status">{status}</span></div>
  {#if S && v}
    <div id="schedBody">
      {#if v.warn}<div id="schedWarn" class="warnbox">{v.warn}</div>{/if}
      <div id="schedKpis"><Kpis items={v.tiles} /></div>
      <Chart id="chSched" cls="xtall" build={(c) => { forms.rev; plan.rev; return W.SCHED ? schedFig(W.SCHED, W.P, c) : null; }} />
      <div id="schedTable"><DataTable heads={v.table.heads} rows={v.table.rows} /></div>
    </div>
  {/if}
</div>
