<script>
  import Chart from '../../lib/Chart.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  import { cashChart } from '../../lib/sim-view.js';
</script>

<div class="card"><h3>Lifetime cash flow (nominal)</h3>
  <Chart id="chCash" build={(c) => { res.rev; return data.sim && cashChart(data.sim, legacy.project().econ.currency, c); }} /></div>
