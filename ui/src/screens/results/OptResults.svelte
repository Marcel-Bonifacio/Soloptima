<!-- Optimisation results: warnings, tiles, search-space map, Pareto, convergence, ranked systems and the sensitivity -->
<script>
  import { sensLabel } from '../../lib/plan.svelte.js';
  import { applySize } from '../../lib/plan.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { warnings, optTiles, rankedTable, convChart, heatChart, paretoChart, sensChart, sensTable } from '../../lib/opt-view.js';

  let metric = $state('npc'), crate = $state(0);
  const O = $derived.by(() => { res.rev; return data.opt; });
  const P = $derived.by(() => { forms.rev; return W.P; });
  const cur = $derived(P.econ.currency);
  const isGrid = $derived(O && O.settings.algorithm_id === 'grid');
  const ranked = $derived(O ? rankedTable(O, cur) : null);
  const label = $derived(O && O.sensitivity ? sensLabel(O.sensitivity.variable) : '');

  // a new result starts at the C-rate of its optimum
  $effect(() => { if (O && O.best) crate = O.best.crate_idx; });
</script>

{#if O}
  {@const warn = warnings(O)}
  {#if warn.length}<div class="warnbox">{#each warn as w, i}{#if i}<br>{/if}⚠ {w}{/each}</div>{/if}
  <div class="card">
    <Kpis items={optTiles(O, P)} />
    <div class="row gap"><button id="btnApplyBest" class="btn primary small" disabled={!O.best} onclick={() => applySize(O.best)}>Apply best sizes &amp; simulate</button></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="row space"><h3>Search-space map</h3>
      <div class="row gap">
        <select bind:value={metric} aria-label="Metric of the map">
          <option value="npc">Net present cost</option><option value="lcoe">LCOE</option><option value="re">Renewable fraction</option><option value="fuel">Fuel (year 1)</option><option value="curtail">PV curtailment</option></select>
        {#if isGrid && O.settings.c_rates.length > 1}
          <select bind:value={crate} aria-label="C-rate of the map">{#each O.settings.c_rates as cr, i}<option value={i}>C-rate {cr}</option>{/each}</select>{/if}
      </div></div>
      <Chart id="chOptHeat" cls="tall" build={(c) => (data.opt ? heatChart(data.opt, metric, +crate || 0, cur, c) : null)} /></div>
    <div class="card"><h3>Cost vs renewable fraction</h3>
      <Chart id="chPareto" cls="tall" build={(c) => (data.opt ? paretoChart(data.opt, cur, c) : null)} /></div>
  </div>
  {#if O.history && O.history.length}
    <div class="card"><h3>Convergence</h3><Chart id="chConv" cls="short" build={(c) => (data.opt ? convChart(data.opt, cur, c) : null)} /></div>
  {/if}
  <div class="card"><h3>Feasible systems, ranked</h3>
    <div class="table-wrap">
      <table class="data">
        <thead><tr>{#each ranked.heads as h}<th>{h}</th>{/each}</tr></thead>
        <tbody>{#each ranked.rows as r}
          <tr class={r.cls}>{#each r.cells as v}<td>{v}</td>{/each}<td><button class="btn small" onclick={() => applySize(O.ranked[r.i])}>Apply</button></td></tr>
        {/each}</tbody>
      </table>
    </div></div>
  {#if O.sensitivity}
    {@const st = sensTable(O, label, cur)}
    <div class="card"><h3>Sensitivity results</h3>
      <Chart id="chSens" build={(c) => (data.opt && data.opt.sensitivity ? sensChart(data.opt, label, cur, c) : null)} />
      <DataTable heads={st.heads} rows={st.rows} /></div>
  {/if}
{/if}
