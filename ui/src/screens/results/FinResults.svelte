<!-- Project finance results: tiles, four charts, the exchange-rate sensitivity, the annual cash-flow table and the debt periods -->
<script>
  import { finRows, finCsv, periodCsv } from '../../lib/finance.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import Chart from '../../lib/Chart.svelte';
  import Kpis from '../../lib/Kpis.svelte';
  import { res, data } from '../../lib/results.svelte.js';
  import { forms } from '../../lib/state.svelte.js';
  import { finTiles, solvedNote, finCharts, finTable, periodTable, fxTable } from '../../lib/fin-view.js';

  const R = $derived.by(() => { res.rev; return data.sim && data.sim.finance; });
  const P = $derived.by(() => { forms.rev; return W.P; });
  const solved = $derived(R ? solvedNote(R, P) : null);
  const table = $derived(R ? finTable(R, P, finRows) : null);
  const ptable = $derived(R ? periodTable(R) : null);
  const fx = $derived(R ? fxTable(R, P) : null);
  const charts = (key) => (c) => { res.rev; forms.rev; const r = data.sim && data.sim.finance; return r ? finCharts(r, W.P, c)[key] : null; };
</script>

{#if !R}
  <div id="finEmpty" class="empty">Run the analysis to see returns, debt cover and the annual cash flow.</div>
{:else}
  <div id="finBody">
    {#if solved}
      <div class="warnbox">{#if solved.ok}{solved.a}<b>{solved.b}</b>{solved.c}<b>{solved.d}</b>{solved.e}{:else}⚠ {solved.text}{/if}</div>
    {/if}
    <div class="card"><Kpis items={finTiles(R, P)} /></div>
    <div class="grid-2">
      <div class="card"><h3>After-tax cash flow to equity</h3><Chart id="chFinCash" build={charts('cash')} /></div>
      <div class="card"><h3>Cumulative cash flow</h3><Chart id="chFinCum" build={charts('cum')} /></div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>Debt service cover{ptable ? ' by period' : ''}</h3><Chart id="chFinDscr" build={charts('dscr')} /></div>
      <div class="card" id="finHostCard"><h3>{R.model === 'host' ? 'Avoided diesel cost vs cost of the new assets' : 'Host energy cost: diesel only vs with the plant'}</h3>
        <Chart id="chFinHost" build={charts('host')} /></div>
    </div>
    <div class="card"><div class="row space"><h3>Annual cash flow</h3><button id="btnFinCsv" class="btn small ghost" onclick={() => finCsv()}>Export CSV</button></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>{#each table.heads as h}<th>{h}</th>{/each}</tr></thead>
          <tbody>{#each table.rows as r}
            {#if r.group}<tr class="group"><td colspan={table.heads.length}>{r.group}</td></tr>
            {:else}<tr class={r.cls}>{#each r.cells as v}<td>{v}</td>{/each}</tr>{/if}
          {/each}</tbody>
        </table>
      </div></div>
    {#if fx}
      <div class="card" id="finFx"><h3>Exchange rate sensitivity</h3>
        <p class="hint">The rate of every operating year moved by the change shown, the tariff and the loan terms kept.</p>
        <div class="table-wrap"><table class="data">
          <thead><tr>{#each fx.heads as h}<th>{h}</th>{/each}</tr></thead>
          <tbody>{#each fx.rows as r}<tr class={r.base ? 'total' : ''}>{#each r.cells as v}<td>{v}</td>{/each}</tr>{/each}</tbody>
        </table></div></div>
    {/if}
    {#if ptable}
      <div class="card" id="finPeriods"><div class="row space"><h3>Debt periods</h3><button id="btnFinPerCsv" class="btn small ghost" onclick={() => periodCsv()}>Export CSV</button></div>
        <div class="table-wrap"><table class="data">
          <thead><tr>{#each ptable.heads as h}<th>{h}</th>{/each}</tr></thead>
          <tbody>{#each ptable.rows as r}<tr>{#each r as v}<td>{v}</td>{/each}</tr>{/each}</tbody>
        </table></div></div>
    {/if}
  </div>
{/if}
