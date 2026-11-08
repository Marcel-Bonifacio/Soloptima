<!-- Year-1 energy flow (Sankey) -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { flowFigure, flowTiles, flowNote } from '../../lib/sim-extra.js';

  const R1 = $derived.by(() => { res.rev; return data.sim ? data.sim.result : null; });
</script>

<div class="card"><h3>Energy flow (year 1)</h3>
  {#if R1}<Kpis items={flowTiles(R1)} />{/if}
  <Chart id="chFlow" cls="tall" build={(c) => { res.rev; return R1 && flowFigure(c, R1); }} />
  <p class="hint">Where the energy of year 1 comes from (left) and where it ends (right), through the battery and the load, in MWh. Battery losses = energy charged − energy discharged − self-discharge − change in stored energy, so the battery's own balance closes. Unmet is the part of the load not served.</p>
  <p id="flowNote" class="hint">{R1 ? flowNote(R1) : ''}</p></div>
