<!-- The genset groups of a mixed fleet in year 1 (shown only for a mixed fleet) -->
<script>
  import DataTable from '../../lib/DataTable.svelte';
  import { W } from '../../lib/ws/state.js';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { groupTable } from '../../lib/fleet-view.js';

  const table = $derived.by(() => { res.rev; forms.rev; return data.sim ? groupTable(data.sim, W.P.diesel) : null; });
</script>

{#if table}
  <div class="card"><h3>Genset groups (year 1)</h3>
    <DataTable heads={table.heads} rows={table.rows} />
    <p class="hint">Groups in merit order: units start from the top of the list and share the load at one loading, so the later groups run only when the earlier ones are all online.</p></div>
{/if}
