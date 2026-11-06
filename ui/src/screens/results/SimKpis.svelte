<!-- The headline tiles of the simulation and the change since the previous run -->
<script>
  import { changedText } from '../../lib/sim.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import Kpis from '../../lib/Kpis.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { headlineTiles } from '../../lib/sim-view.js';

  const tiles = $derived.by(() => { res.rev; forms.rev; return data.sim ? headlineTiles(data.sim, data.prev, W.P.econ.currency, data.opt) : []; });
  const changed = $derived.by(() => { res.rev; return data.sim && data.prev && data.prev.snap ? changedText(data.prev.snap, data.sim.snap) : null; });
</script>

<div class="card">
  <Kpis items={tiles} />
  {#if changed != null}<p class="hint">{changed}</p>{/if}
</div>
