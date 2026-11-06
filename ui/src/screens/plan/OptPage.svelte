<!-- Optimisation page (#tab-opt): the search settings, the run bar and the results -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import OptBar from '../results/OptBar.svelte';
  import OptResults from '../results/OptResults.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { suggestRanges } from '../../lib/plan.svelte.js';
</script>

<section id="tab-opt" class="tab" class:active={ws.tab === 'opt'}>
  <h1>Optimise sizing</h1>
  <p class="lead">Searches PV and battery sizes (and wind turbines with the metaheuristics) for the given load and diesel fleet. Each candidate is a full chronological simulation over the project life, or of year 1 only in fast mode.</p>
  <div class="grid-3">
    <div class="card"><h3>Algorithm</h3><div class="form"><SchemaForm name="opt-alg" /></div>
      <p class="hint">Grid: every point simulated, then refined. PSO and SHO–QAO–GOA: population metaheuristics with constraint penalties. MOPSO: Pareto set of cost vs renewable share (or SSSI); the "best" is the knee point.</p></div>
    <div class="card"><h3>Search space</h3><div class="form"><SchemaForm name="opt-space" /></div><button id="btnOptAuto" class="btn small ghost" onclick={suggestRanges}>Suggest ranges</button></div>
    <div class="card"><h3>Objective &amp; constraints</h3><div class="form"><SchemaForm name="opt-obj" /></div></div>
    <div class="card"><h3>Sensitivity (optional)</h3><div class="form"><SchemaForm name="opt-sens" /></div>
      <p class="hint">Repeats the whole search for each value of the chosen input, so you can see how the best design shifts.</p></div>
  </div>
  <OptBar />
  <OptResults />
</section>
