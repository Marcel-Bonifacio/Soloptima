<!-- Diesel fleet & control strategy page (tab 6) -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import FuelCard from './FuelCard.svelte';
  import RecFuel from './RecFuel.svelte';
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { strategyHelp } from '../../lib/diesel-view.js';

  const strategy = $derived.by(() => { forms.rev; return W.P ? W.P.diesel.strategy : ''; });
</script>

<section id="tab-diesel" class="tab" class:active={ws.tab === 'diesel'}>
  <h1>Diesel fleet &amp; control strategy</h1>
  <p class="lead">The genset fleet is fixed (known capacity). The control strategy decides how PV, battery and gensets share the load each hour.</p>
  <div class="grid-2">
    <div class="card"><h3>Gensets</h3><div class="form"><SchemaForm name="diesel" /></div></div>
    <div class="card"><h3>Dispatch strategy</h3><div class="form"><SchemaForm name="control" /></div>
      <div id="strategyHelp" class="hint">{strategyHelp(strategy)}</div>
      <div id="emsBox" hidden={strategy !== 'predictive'}><h3 class="mt">Forecast-based EMS</h3><div class="form"><SchemaForm name="ems" /></div></div>
    </div>
  </div>
  <div class="card"><h3>Grid connection</h3>
    <p class="hint">Optional. A utility grid beside the gensets: while it is up and cheaper than genset energy it serves the load first, its spare import counts as spinning reserve, and PV and wind the battery cannot take are exported up to the limit. During outages the gensets and the battery carry the load. The diesel-only baseline then becomes grid + diesel.</p>
    <div class="form"><SchemaForm name="grid" /></div></div>
  <div class="card"><h3>Existing diesel plant records</h3>
    <p class="hint">Optional. Figures of the plant as it runs today, checked against the modelled diesel-only case on the Simulation results page. Every result is measured against that case, so a lender or client checks it first. Leave blank what you do not have.</p>
    <div class="grid-2"><div class="form"><SchemaForm name="records" /></div>
      <div><h3>Monthly fuel (L) <button type="button" class="info" data-k="site_records.monthly_fuel_l" data-title="Monthly fuel" aria-label="About Monthly fuel" aria-expanded="false">i</button></h3>
        <RecFuel /></div></div>
  </div>
  <FuelCard />
</section>
