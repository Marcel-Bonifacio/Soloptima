<!-- Year-by-year results of the simulation as a table -->
<script>
  import { W } from '../../lib/ws/state.js';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { yearHeads, yearCells } from '../../lib/sim-view.js';

  const rows = $derived.by(() => { res.rev; return data.sim ? data.sim.result.years.map((y) => yearCells(y, !!data.sim.result.has_grid)) : []; });
  const heads = $derived.by(() => { res.rev; const R = data.sim && data.sim.result; return yearHeads(R ? W.P.econ.currency : '', !!(R && R.has_grid), !!(R && R.years[0].gen_overhauls != null)); });
</script>

<div class="card"><h3>Year-by-year results</h3>
  <DataTable {heads} {rows} /></div>
