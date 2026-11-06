<!-- Sun path chart of the layout map: the terrain horizon (PV page), the near horizon of the objects, the sun on the 21st of the month -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { plant, shown } from '../../lib/plant.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  import { sunChart } from '../../lib/sun.js';
</script>

<Chart id="chSunPath" cls="chart-sun" build={(c) => {
  plant.rev; forms.rev;
  const P = legacy.project();
  return P ? sunChart(P.location.lat, P.pv.horizon, shown.shade, c) : null;
}} />
