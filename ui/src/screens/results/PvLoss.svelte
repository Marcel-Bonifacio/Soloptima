<!-- Loss diagram of the PV page (year 1, lib/loss-diagram.js): the whole system on one trunk to the energy served, or the PV, the
     plant and the battery apart; the choice is the project's and the report follows it -->
<script>
  import { plant, shown } from '../../lib/plant.svelte.js';
  import { lossDiagram } from '../../lib/loss-diagram.js';
  import { svgNode } from '../../lib/report/svg-node.js';
  import { W } from '../../lib/ws/state.js';
  import { data } from '../../lib/results.svelte.js';
  import { rep } from '../../lib/report.svelte.js';
  import { setLossView } from '../../lib/report-figs.svelte.js';
  const mode = $derived.by(() => { void rep.rev; return (W.P && W.P.report && W.P.report.losses) || 'system'; });
  const svg = $derived.by(() => { plant.rev; return shown.losses && W.P ? lossDiagram(shown.losses, W.P.pv, data.sim && data.sim.result.years[0], mode) : ''; });
</script>

<div class="seg small" role="group" aria-label="Loss diagram">
  <button type="button" class:on={mode === 'system'} title="One trunk from the sun to the energy served, with wind, gensets, the grid and the battery" onclick={() => setLossView('system')}>Whole system</button>
  <button type="button" class:on={mode === 'separate'} title="The PV, the plant and the battery as separate sections" onclick={() => setLossView('separate')}>Separate</button>
</div>
{#if svg}<div class="loss-svg" use:svgNode={svg}></div>{:else}<p class="hint">Calculate the PV yield to see the loss diagram.</p>{/if}
{#if svg && !data.sim}<p class="hint">Run a simulation to carry the diagram through the plant and the battery to the energy served.</p>{/if}
