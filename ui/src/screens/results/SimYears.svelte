<script>
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  import { yearHeads, yearCells } from '../../lib/sim-view.js';

  const rows = $derived.by(() => { res.rev; return data.sim ? data.sim.result.years.map(yearCells) : []; });
  const heads = $derived.by(() => { res.rev; return yearHeads(data.sim ? legacy.project().econ.currency : ''); });
</script>

<div class="card"><h3>Year-by-year results</h3>
  <DataTable {heads} {rows} /></div>
