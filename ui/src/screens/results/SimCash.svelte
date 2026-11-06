<!-- Lifetime cash flow (nominal): the yearly costs of the simulated system as a chart -->
<script>
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { cashChart } from '../../lib/sim-view.js';
</script>

<div class="card"><h3>Lifetime cash flow (nominal)</h3>
  <Chart id="chCash" build={(c) => { res.rev; return data.sim && cashChart(data.sim, W.P.econ.currency, c); }} /></div>
