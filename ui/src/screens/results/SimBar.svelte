<!-- Run button, hourly CSV and status of the simulation page -->
<script>
  import { exportCsv, exportStepCsv } from '../../lib/sim.svelte.js';
  import { res, runSim, data } from '../../lib/results.svelte.js';
</script>

<div class="row gap">
  <button id="btnRun" class="btn primary" disabled={res.simBusy} onclick={() => runSim()}>{res.simBusy ? '… Run simulation' : '▶ Run simulation'}</button>
  <button id="btnCsv" class="btn ghost" onclick={() => exportCsv()}>Export hourly CSV</button>
  {#if (res.rev, data.sim && data.sim.result.steps)}<button id="btnStepCsv" class="btn ghost" onclick={() => exportStepCsv()}>Export {data.sim.result.step_min} min CSV</button>{/if}
  <span class="status inline {res.simKind}" role="status">{res.simStatus}</span>
</div>
