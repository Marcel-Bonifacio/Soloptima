<!-- The results check: results of the last run outside a plausible range (engine/src/sim/checks.rs); nothing when all pass -->
<script>
  import { res, data } from '../../lib/results.svelte.js';
  import { checksOf, checkText } from '../../lib/sim-tables.js';

  const lines = $derived.by(() => { res.rev; return data.sim ? checksOf(data.sim.result).map(checkText) : []; });
</script>

{#if lines.length}
  <div class="card" id="simChecks"><h3>Results check</h3>
    <ul>{#each lines as t}<li>{t}</li>{/each}</ul>
    <p class="hint">Results outside a range a sound project stays within. Check the inputs behind each one; the ranges and why are in the manual.</p></div>
{/if}
