<!-- Shown while the result on show is from other inputs (Simulation results and Project finance) -->
<script>
  import { res, runSim } from '../../lib/results.svelte.js';
  import { legacy } from '../../lib/legacy.js';
  const again = async () => { await runSim(); legacy.afterRerun(); };
</script>

{#if res.stale}
  <div class="warnbox">
    ⚠ {res.stale.list ? `The inputs changed after this run: ${res.stale.list}.` : 'The inputs changed after this run.'} The results below are from the earlier inputs.
    <button type="button" class="btn small" onclick={again}>Run again</button>
  </div>
{/if}
