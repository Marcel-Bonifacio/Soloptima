<!-- Loss diagram of the PV page (year 1): the funnel from the horizontal irradiation to the energy available (lib/loss-diagram.js) -->
<script>
  import { plant, shown } from '../../lib/plant.svelte.js';
  import { lossDiagram } from '../../lib/loss-diagram.js';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { W } from '../../lib/ws/state.js';
  import { data } from '../../lib/results.svelte.js';
  const svg = $derived.by(() => { plant.rev; return shown.losses && W.P ? lossDiagram(shown.losses, W.P.pv, data.sim && data.sim.result.years[0]) : ''; });
</script>

{#if svg}<div class="loss-svg" use:svgNode={svg}></div>{:else}<p class="hint">Calculate the PV yield to see the loss diagram.</p>{/if}
