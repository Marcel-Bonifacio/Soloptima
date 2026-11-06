<!-- Year-1 energy supply and the comparison with diesel only -->
<script>
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { fmtNum } from '../../lib/format.js';
  import { mixChart, compareTable } from '../../lib/sim-view.js';

  const cmp = $derived.by(() => {
    res.rev; forms.rev;
    if (!data.sim) return null;
    const t = compareTable(data.sim, W.P.econ.currency);
    return { ...t, rows: t.rows.map((r) => [r.label, ...r.cells.map((x) => fmtNum(x, r.d))]) };
  });
</script>

<div class="grid-2">
  <div class="card"><h3>Year-1 energy supply</h3>
    <Chart id="chMix" build={(c) => { res.rev; return data.sim && mixChart(data.sim, c); }} /></div>
  <div class="card"><h3 id="cmpTitle">{cmp ? cmp.title : ''}</h3>
    {#if cmp}<DataTable heads={cmp.heads} rows={cmp.rows} cls="cmp {cmp.four ? 'four' : ''}" titles={{ 4: cmp.four ? 'Hybrid − PV only' : '' }} />{/if}</div>
</div>
