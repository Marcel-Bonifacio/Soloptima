<!-- Battery energy storage page (tab 5) -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
</script>

<section id="tab-bess" class="tab" class:active={ws.tab === 'bess'}>
  <h1>Battery energy storage</h1>
  <p class="lead">Battery used for a single simulation. The optimiser varies its energy capacity and C-rate.</p>
  <div class="grid-2">
    <div class="card"><h3>Size &amp; operation</h3><div class="form"><SchemaForm name="bess" /></div></div>
    <div class="card"><h3>Ageing</h3><div class="form"><SchemaForm name="bess-age" /></div>
      <p class="hint">State of health falls each year by calendar fade + (DC equivalent full cycles × (1 − EOL) / (cycle life × its depth of discharge)). DC cycles = energy discharged ÷ one-way efficiency ÷ nameplate energy. The battery is replaced when it falls to the replacement threshold (blank = end of life) and restarts at 100 %.</p></div>
  </div>
  <div class="grid-2">
    <div class="card"><h3>Auxiliary loads</h3><div class="form"><SchemaForm name="aux" /></div>
      <p class="hint">Served every hour like the site load, also at night: battery part = nameplate MWh × kW/MWh × (1 + coefficient × ambient above the reference) + PCS MW × kW/MW, with a battery; plant auxiliaries with PV, wind or a battery; PV transformer no-load with PV, BESS transformer no-load with a battery. They do not grow with the load. LCOE, COE and billed energy count only the energy served to the site.</p></div>
  </div>
</section>
