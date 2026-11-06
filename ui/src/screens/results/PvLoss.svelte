<!-- Loss diagram of the PV page (year 1): irradiance steps, then energy steps -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { plant, shown } from '../../lib/plant.svelte.js';
  import { lossChart } from '../../lib/sun.js';
</script>

<Chart id="chPvLoss" cls="tall" build={(c) => { plant.rev; return shown.losses ? lossChart(shown.losses, c) : null; }} />
