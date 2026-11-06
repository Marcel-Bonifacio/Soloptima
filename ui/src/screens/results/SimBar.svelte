<!-- Run button, hourly CSV and status of the simulation page -->
<script>
  import { exportCsv } from '../../lib/sim.svelte.js';
  import { res, runSim } from '../../lib/results.svelte.js';
</script>

<div class="row gap">
  <button id="btnRun" class="btn primary" disabled={res.simBusy} onclick={() => runSim()}>{res.simBusy ? '… Run simulation' : '▶ Run simulation'}</button>
  <button id="btnCsv" class="btn ghost" onclick={() => exportCsv()}>Export hourly CSV</button>
  <span class="status inline {res.simKind}" role="status">{res.simStatus}</span>
</div>
