<!-- The comparison of the project and its variants: one batch of the engine, the figures side by side and two charts -->
<script>
  import Chart from '../../lib/Chart.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { vs, runVariants, variantsKey } from '../../lib/variants.svelte.js';
  import { compareTable, costFig, supplyFig } from '../../lib/variants-view.js';

  // Does the stored comparison still match the project and the variants? The fingerprint stringifies the project, so it waits for a
  // pause in editing.
  let stale = $state(false);
  $effect(() => {
    forms.rev; vs.rev;
    const t = setTimeout(() => { stale = !!W.VARIANTS && W.VARIANTS.key !== variantsKey(); }, 250);
    return () => clearTimeout(t);
  });

  const T = $derived.by(() => { vs.rev; forms.rev; return W.VARIANTS && W.P ? compareTable(W.P, W.VARIANTS, W.P.econ.currency) : null; });
  const many = $derived.by(() => { vs.rev; forms.rev; return !!W.P && (W.P.variants || []).length > 0; });
</script>

<div class="card">
  <div class="row space"><h3>Comparison</h3>
    <div class="row gap"><label class="hint inline"><input type="checkbox" id="variantsFast" bind:checked={vs.fast}> Year 1 only (fast)</label>
      <button id="btnVariants" class="btn" disabled={vs.busy || !many} onclick={runVariants}>{vs.busy ? '… Compare variants' : 'Compare variants'}</button></div></div>
  <p class="hint">Simulates the project as it is set now and each variant, with the settings the variant changes. The best value of each row among the designs that meet the optimiser constraints is highlighted. NPV and IRR are against diesel only, at the prices and costs of the same design.</p>
  <span id="variantsStatus" class="status inline {vs.kind}" role="status">{vs.status}</span>
  <div id="variantsBody" hidden={!T}>
    {#if T}
      <div id="variantsTable" class="table-wrap">
        <table class="data cmp-variants">
          <thead>
            <tr><th></th>{#each T.heads as h}<th>{h}</th>{/each}</tr>
            <tr class="changes"><th>Changes</th>{#each T.changes as lines}<td>{#each lines as l}<div>{l}</div>{/each}</td>{/each}</tr>
          </thead>
          <tbody>
            {#each T.rows as r}
              <tr><td>{r.label}</td>{#each r.cells as c, i}<td class:best={r.best === i}>{c}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="hint">
        {#if stale}⚠ The project or the variants have changed since this comparison: press Compare variants again. {/if}
        {#each T.notes as n}{n} {/each}
        {#if W.VARIANTS.fast}Year 1 is simulated and repeated over the project life: PV degradation and load growth are left out; battery ageing is still counted.{/if}
      </p>
    {/if}
    <div class="grid-2">
      <div><h3>Net present cost</h3><Chart id="chVarCost" build={(c) => { vs.rev; forms.rev; return W.VARIANTS && W.P && costFig(W.P, W.VARIANTS, c); }} /></div>
      <div><h3>Year-1 energy supply</h3><Chart id="chVarSupply" build={(c) => { vs.rev; forms.rev; return W.VARIANTS && supplyFig(W.VARIANTS, c); }} /></div>
    </div>
  </div>
</div>
