<!-- Year-by-year results of the simulation as a table -->
<script>
  import { W } from '../../lib/ws/state.js';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { yearHeads, yearCells } from '../../lib/sim-view.js';

  const rows = $derived.by(() => { res.rev; return data.sim ? data.sim.result.years.map((y) => yearCells(y, !!data.sim.result.has_grid)) : []; });
  const heads = $derived.by(() => { res.rev; return yearHeads(data.sim ? W.P.econ.currency : '', !!(data.sim && data.sim.result.has_grid)); });
</script>

<div class="card"><h3>Year-by-year results</h3>
  <DataTable {heads} {rows} /></div>
