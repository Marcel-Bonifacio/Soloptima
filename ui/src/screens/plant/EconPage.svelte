<!-- Costs page (tab 7) -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
</script>

<section id="tab-econ" class="tab" class:active={ws.tab === 'econ'}>
  <h1>Costs</h1>
  <p class="lead">Capital, operating and fuel costs used by the simulation, the optimiser and the finance model. Emission and social factors feed the indicator panel.</p>
  <div class="grid-3">
    <div class="card"><h3>Project &amp; fuel</h3><div class="form"><SchemaForm name="econ-gen" /></div></div>
    <div class="card"><h3>PV &amp; battery costs</h3><div class="form"><SchemaForm name="econ-cap" /></div></div>
    <div class="card"><h3>Diesel &amp; emissions</h3><div class="form"><SchemaForm name="econ-dg" /></div></div>
  </div>
</section>
