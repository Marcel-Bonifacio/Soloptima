<!-- Shown while the result on show is from other inputs (Simulation results and Project finance) -->
<script>
  import { afterRerun } from '../../lib/sim.svelte.js';
  import { res, runSim } from '../../lib/results.svelte.js';
  const again = async () => { await runSim(); afterRerun(); };
</script>

{#if res.stale}
  <div class="warnbox">
    ⚠ {res.stale.list ? `The inputs changed after this run: ${res.stale.list}.` : 'The inputs changed after this run.'} The results below are from the earlier inputs.
    <button type="button" class="btn small" onclick={again}>Run again</button>
  </div>
{/if}
