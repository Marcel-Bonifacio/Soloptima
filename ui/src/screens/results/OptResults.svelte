<!-- Optimisation results: warnings, tiles, search-space map, Pareto, convergence, repeated runs, the MOPSO front by LPSP, best design per system type, ranked systems, the sensitivity and the two-way map -->
<script>
  import { applySize } from '../../lib/plan.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import DataTable from '../../lib/DataTable.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { warnings, optTiles, rankedTable, archTable, runsTable, lpspTable, paretoAxis, convChart, heatChart, paretoChart, sensChart, sensTable, sensName, mapTable, mapChart } from '../../lib/opt-view.js';

  let metric = $state('npc'), crate = $state(0);
  const O = $derived.by(() => { res.rev; return data.opt; });
  const P = $derived.by(() => { forms.rev; return W.P; });
  const cur = $derived(P.econ.currency);
  const isGrid = $derived(O && O.settings.algorithm_id === 'grid');
  const ranked = $derived(O ? rankedTable(O, cur) : null);
  const arch = $derived(O ? archTable(O, cur) : null);
  const label = $derived(O && O.sensitivity ? sensName(O.sensitivity.variable) : '');
  const map = $derived(O ? mapTable(O, cur) : null);
  const runs = $derived(O ? runsTable(O, cur) : null);
  const lpsp = $derived(O ? lpspTable(O, cur) : null);

  // a new result starts at the C-rate of its optimum
  $effect(() => { if (O && O.best) crate = O.best.crate_idx; });
</script>

{#snippet applyBest(r)}{#if r.best}<button class="btn small" onclick={() => applySize(r.best)}>Apply</button>{/if}{/snippet}
{#snippet applyRanked(r)}<button class="btn small" onclick={() => applySize(O.ranked[r.i])}>Apply</button>{/snippet}

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
    <div class="card"><h3>Cost vs {paretoAxis(O).name}</h3>
      <Chart id="chPareto" cls="tall" build={(c) => (data.opt ? paretoChart(data.opt, cur, c) : null)} /></div>
  </div>
  {#if O.history && O.history.length}
    <div class="card"><h3>Convergence</h3><Chart id="chConv" cls="short" build={(c) => (data.opt ? convChart(data.opt, cur, c) : null)} /></div>
  {/if}
  {#if runs}
    <div class="card"><h3>Repeated runs</h3>
      <DataTable heads={['', runs.name]} rows={runs.stats} />
      <DataTable heads={runs.heads} rows={runs.rows} />
      <p class="hint">Each run starts from its own seed, derived from the random seed. {runs.better === 'higher' ? 'Higher' : 'Lower'} is better. The best design{runs.name === 'Hypervolume' ? ', the Pareto front' : ''} and the convergence chart are those of the run reported; the search-space map and the ranked table take every run.</p></div>
  {/if}
  {#if lpsp}
    <div class="card"><h3>Pareto front by LPSP target</h3>
      <DataTable heads={lpsp.heads} rows={lpsp.rows} action={applyBest} />
      <p class="hint">The cheapest design of the front whose unmet load meets each target. The front holds only designs within the max unmet load, so with LPSP as the second objective raise that limit to 10 %. {lpsp.quality}</p></div>
  {/if}
  {#if arch}
    <div class="card"><h3>Best design per system type</h3>
      <DataTable heads={[...arch.heads, '']} rows={arch.rows} action={applyBest} />
      <p class="hint">The best design by the objective that meets the constraints, for each combination of PV, battery, wind and gensets among the candidates the search simulated. The genset count and rating are those of the main group.</p></div>
  {/if}
  <div class="card"><h3>Feasible systems, ranked</h3>
    <DataTable heads={ranked.heads} rows={ranked.rows} action={applyRanked} /></div>
  {#if O.sensitivity}
    {@const st = sensTable(O, label, cur)}
    <div class="card"><h3>Sensitivity results</h3>
      <Chart id="chSens" build={(c) => (data.opt && data.opt.sensitivity ? sensChart(data.opt, label, cur, c) : null)} />
      <DataTable heads={st.heads} rows={st.rows} /></div>
  {/if}
  {#if map}
    <div class="card"><h3>Two-way map: winning system type</h3>
      <Chart id="chOptMap" build={(c) => (data.opt && data.opt.map ? mapChart(data.opt, cur, c) : null)} />
      <DataTable heads={map.heads} rows={map.rows} />
      <p class="hint">{map.fixed ? 'Each cell simulates the best design of each system type from the main search again with the two inputs set, and shows the cheapest that meets the constraints; the sizes stay those of the main search.' : 'Each cell runs the whole search again with the two inputs set and shows its best design.'} Colour: NPC of the winner.</p></div>
  {/if}
{/if}
