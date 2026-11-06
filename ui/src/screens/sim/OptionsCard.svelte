<!-- Compare operating options: one batch with a setting changed per row, the figures per option and the NPC waterfall -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { ops, runOptions } from '../../lib/options.svelte.js';
  import { optionsKey } from '../../lib/ws/keys.js';
  import { summarize, optionHeads, optionRows, bestNote, waterfallFig } from '../../lib/options-view.js';

  // Does the stored comparison still match the inputs? The fingerprint stringifies the project, so it waits for a pause in editing.
  let stale = $state(false);
  $effect(() => {
    forms.rev; ops.rev;
    const t = setTimeout(() => { stale = !!W.OPTIONS && W.OPTIONS.key !== optionsKey(); }, 250);
    return () => clearTimeout(t);
  });

  const S = $derived.by(() => { ops.rev; forms.rev; return W.OPTIONS && W.P ? summarize(W.P, W.OPTIONS, stale) : null; });
  const cur = $derived.by(() => { forms.rev; return W.P ? W.P.econ.currency : ''; });
  const rows = $derived(S ? optionRows(S) : []);
  const best = $derived(S ? bestNote(S, cur) : null);
</script>

<div class="card">
  <div class="row space"><h3>Operating options</h3>
    <div class="row gap"><label class="hint inline"><input type="checkbox" id="optionsFast" bind:checked={ops.fast}> Year 1 only (fast)<button type="button" class="info" data-k="options.fast" data-title="Year 1 only (fast)" aria-label="About Year 1 only (fast)" aria-expanded="false">i</button></label>
      <button id="btnOptions" class="btn" disabled={ops.busy} onclick={runOptions}>{ops.busy ? '… Compare options' : 'Compare options'}</button></div></div>
  <p class="hint">Simulates the project as it is set now, changing one setting per row: diesel only as the reference, no battery (PV only), every dispatch strategy with the battery, and the predictive EMS with perfect forecasts as a benchmark for better forecasting. Feasible means the optimiser constraints (Optimise sizing) are met. The predictive EMS takes about a second per full-life run.</p>
  <span id="optionsStatus" class="status inline {ops.kind}" role="status">{ops.status}</span>
  <div id="optionsBody" hidden={!S}>
    {#if S}
      {@const heads = optionHeads(cur)}
      <div id="optionsTable" class="table-wrap">
        <table class="data">
          <thead><tr>{#each heads as h}<th>{h}</th>{/each}</tr></thead>
          <tbody>
            {#each rows as x}
              {#if x.err}
                <tr><td>{x.label}</td><td colspan={heads.length - 1}>{x.err}</td></tr>
              {:else}
                <tr class={x.best ? 'best' : ''}>
                  <td>{x.label}{#if x.why}<span class="why">infeasible: {x.why}</span>{/if}</td>
                  {#each x.cells as c}<td>{c}</td>{/each}
                  <td>{x.change}{#if x.close}<span class="close">within model accuracy</span>{/if}</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      <p id="optionsNote" class="hint">
        {#if S.stale}⚠ The inputs have changed since this comparison: press Compare options again. {/if}
        {#if best}Lowest net present cost meeting the constraints: <b>{best.label}</b> ({best.npc}).{#if best.near.length} Within 0.5 % of it, which is within model accuracy: {best.near.join('; ')}.{/if}{:else}No option meets the optimiser constraints.{/if}
        NPV and IRR are against diesel only; NPC change is against the row above, and changes below 0.5 % of NPC are within model accuracy. The perfect-forecast row is a benchmark, not an option, and is never highlighted. The EMS plans over a rolling horizon, so perfect forecasts do not always give a lower NPC.
        {#if S.fast} Year 1 is simulated and repeated over the project life: PV degradation and load growth are left out; battery ageing is still counted.{/if}
      </p>
    {/if}
    <Chart id="chOptFall" build={(c) => { ops.rev; forms.rev; return S && waterfallFig(W.P, S, c); }} />
    {#if S}
      <p class="hint">Net present cost from diesel only to the hybrid with its best strategy, one step at a time. The split depends on the order: PV is added first, then the battery, then the best strategy. Added before PV, the battery would take part of the saving shown here for PV.</p>
    {/if}
  </div>
</div>
