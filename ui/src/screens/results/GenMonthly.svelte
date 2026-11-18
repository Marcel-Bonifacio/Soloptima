<!-- The gensets by month in year 1: run hours, starts, energy, fuel, capacity factor, specific fuel and efficiency -->
<script>
  import DataTable from '../../lib/DataTable.svelte';
  import { W } from '../../lib/ws/state.js';
  import { res, data } from '../../lib/results.svelte.js';
  import { gensetMonthly, GEN_MONTH_HEADS, genMonthCells, DIESEL_KWH_PER_L } from '../../lib/sim-tables.js';

  const rows = $derived.by(() => { res.rev; const G = data.sim ? gensetMonthly(data.sim.result, W.P.diesel) : null; return G && G.map((x) => ({ cls: x.label === 'Year' ? 'total' : '', cells: genMonthCells(x) })); });
</script>

{#if rows}
  <div class="card"><h3>Gensets by month (year 1)</h3>
    <DataTable heads={GEN_MONTH_HEADS} rows={rows} />
    <p class="hint">Run hours of all units; starts count the units started; capacity factor = energy ÷ (fleet rating × hours of the month); efficiency = energy ÷ (fuel × {DIESEL_KWH_PER_L} kWh/L).</p></div>
{/if}
