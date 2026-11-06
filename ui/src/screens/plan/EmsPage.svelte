<!-- Forecast & EMS page (#tab-ems): the Forecast Lab, the forecast errors and EMS plan of the last simulation, the day-ahead schedule -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import ForecastLab from '../forecast/ForecastLab.svelte';
  import SchedCard from './SchedCard.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { res } from '../../lib/results.svelte.js';
  import { hasSim } from '../../lib/sim.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { plan } from '../../lib/plan.svelte.js';
  import { forecastTiles, forecastFig, planFig } from '../../lib/plan-view.js';

  const sim = $derived.by(() => { res.rev; return hasSim() ? W.SIM : null; });
  const tiles = $derived.by(() => { forms.rev; return sim ? forecastTiles(sim, W.P) : []; });
  const predictive = $derived.by(() => { forms.rev; return !!sim && W.P.diesel.strategy === 'predictive' && W.P.bess.energy_kwh > 0; });
</script>

<section id="tab-ems" class="tab" class:active={ws.tab === 'ems'}>
  <h1>Forecast &amp; energy management</h1>
  <p class="lead">How well PV and load can be forecast at this site, how the predictive EMS plans the battery and gensets, and an operational day-ahead schedule from a live weather forecast.</p>
  <ForecastLab />
  {#if !sim}
    <div id="emsEmpty" class="empty">Run a simulation first. Forecast errors are shown for every strategy; the EMS plan needs the "Predictive EMS" strategy (Diesel &amp; control tab).</div>
  {:else}
    <div id="emsBody">
      <div class="card"><div id="fcKpis"><Kpis items={tiles} /></div></div>
      <div class="card"><div class="row space"><h3>Forecast vs actual</h3>
        <div class="row gap"><select id="fcVar" bind:value={plan.variable}><option value="pv">PV output</option><option value="load">Load</option></select>
        <label>Week <input type="range" id="fcWeek" min="0" max="51" bind:value={plan.week}></label></div></div>
        <Chart id="chFc" cls="tall" build={(c) => { res.rev; return W.SIM ? forecastFig(W.SIM, plan.variable, +plan.week, c) : null; }} /></div>
      <div class="card"><h3>EMS: planned vs actual battery state of charge</h3>
        {#if predictive}
          <Chart id="chPlan" build={(c) => { forms.rev; res.rev; return W.SIM ? planFig(W.SIM, W.P, +plan.week, c) : null; }} />
        {:else}
          <div id="chPlan" class="chart"><p class="hint" style="padding:20px">Select "Predictive EMS" in Diesel &amp; control and re-run the simulation to see the EMS plan.</p></div>
        {/if}
      </div>
    </div>
  {/if}
  <SchedCard />
</section>
