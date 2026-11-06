<!-- Run, cancel and progress of the optimisation -->
<script>
  import { res, runOpt, cancelJob } from '../../lib/results.svelte.js';
</script>

<div class="row gap">
  <button id="btnOpt" class="btn primary" disabled={res.optBusy} onclick={runOpt}>⚙ Run optimisation</button>
  {#if res.optBusy}<button id="btnOptCancel" class="btn ghost" onclick={() => cancelJob(res.optJob)}>Cancel</button>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(res.optProgress * 100)}><div style:width="{(res.optProgress * 100).toFixed(1)}%"></div></div>{/if}
  <span class="status inline {res.optKind}" role="status">{res.optStatus}</span>
</div>
