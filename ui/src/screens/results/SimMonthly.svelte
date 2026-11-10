<!-- Monthly energy supply: chart, table; a click on a month opens its first dispatch week -->
<script>
  import { monthBalance } from '../../lib/sim.svelte.js';
  import Chart from '../../lib/Chart.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data, gotoWeek } from '../../lib/results.svelte.js';
  import { fmtNum, fmtPct } from '../../lib/format.js';
  import { monthlyChart, monthHeads } from '../../lib/sim-view.js';
  import { MONTHS, MDAYS, sum } from '../../lib/series.js';

  const table = $derived.by(() => {
    res.rev;
    if (!data.sim) return null;
    const MB = monthBalance(data.sim.result), wind = data.sim.result.years[0].wind_avail > 0, grid = !!data.sim.result.has_grid, d = (v) => fmtNum(v / 1000, MB[12].load >= 1e7 ? 0 : 1);
    return { heads: monthHeads(wind, grid), rows: MB.map((x) => ({ cls: x.label === 'Year' ? 'total' : '',
      cells: [x.label, d(x.load), d(x.pv), ...(wind ? [d(x.wind)] : []), d(x.bess), d(x.gen), ...(grid ? [d(x.grid)] : []), d(x.unmet), d(x.curt), ...(grid ? [d(x.export)] : []),
        d(x.dump), fmtNum(x.fuel / 1000), fmtPct(x.re)] })) };
  });
  const open = (pt) => { gotoWeek(sum(MDAYS.slice(0, MONTHS.indexOf(pt.x))) * 24); document.getElementById('chDispatch')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
</script>

<div class="card"><h3>Monthly energy supply</h3>
  <Chart id="chMonthly" build={(c) => { res.rev; return data.sim && monthlyChart(data.sim, c); }} onclick={open} />
  {#if table}<div class="mt"><DataTable heads={table.heads} rows={table.rows} /></div>{/if}
  <p class="hint">Load (auxiliaries included) = PV direct + wind direct + battery → load + diesel → load{table && table.heads.includes('Grid → load') ? ' + grid → load' : ''} + unmet. RE fraction = 1 − diesel energy to the load and the battery{table && table.heads.includes('Grid → load') ? ' and the grid import' : ''} ÷ energy served.</p></div>
