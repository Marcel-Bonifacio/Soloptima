<!-- Fuel curve (form, datasheet table with add and remove) and the efficiency chart -->
<script>
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import Chart from '../../lib/Chart.svelte';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { onFieldChange } from '../../lib/ws/project.js';
  import { fuelRows, fuelFig, setFuelCell, addFuelPoint, removeFuelPoint } from '../../lib/diesel-view.js';

  // the curve is edited in place, so the card also reads its own counter
  let rev = $state(0);
  const D = $derived.by(() => { forms.rev; rev; return W.P ? W.P.diesel : null; });
  const isTable = $derived(!!D && D.fuel_model === 'table');
  const rows = $derived(isTable ? fuelRows(D) : []);

  const edited = () => { rev++; onFieldChange('diesel.fuel_curve'); };
  function change(e, i, col) {
    setFuelCell(W.P.diesel, i, col, +e.currentTarget.value);
    edited();
  }
  const remove = (i) => { if (removeFuelPoint(W.P.diesel, i)) edited(); };
  const add = () => { addFuelPoint(W.P.diesel); edited(); };
</script>

<div class="grid-2">
  <div class="card"><h3>Fuel curve</h3><div class="form"><SchemaForm name="fuel" /></div>
    <div id="fuelTable">
      {#if isTable}
        <table class="data"><thead><tr><th>Load (%)</th><th>Efficiency (kWh/L)</th><th>Fuel (L/h per unit)</th><th></th></tr></thead>
          <tbody>
            {#each rows as r, i (i)}
              <tr><td><input type="number" step="1" value={r.load} style="width:80px" aria-label="Load of point {i + 1} (%)" onchange={(e) => change(e, i, 0)}></td>
                <td><input type="number" step="0.01" value={r.eff} style="width:90px" aria-label="Efficiency of point {i + 1} (kWh/L)" onchange={(e) => change(e, i, 1)}></td>
                <td>{r.lph}</td><td><button class="btn small ghost" aria-label="Remove point {i + 1}" onclick={() => remove(i)}>✕</button></td></tr>
            {/each}
          </tbody></table>
      {:else}<p class="hint">Fuel (L/h) = intercept × rated kW + slope × output kW.</p>{/if}
    </div>
    <div class="row gap"><button id="btnFuelAdd" class="btn small ghost" hidden={!isTable} onclick={add}>+ point</button></div></div>
  <div class="card"><h3>Fuel efficiency vs loading</h3><Chart id="chFuel" build={(c) => { forms.rev; rev; return W.P ? fuelFig(W.P.diesel, c) : null; }} /></div>
</div>
