<!-- Monthly fuel of the existing plant records: twelve fields; a blank or zero cell is a month without a record -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { onFieldChange } from '../../lib/ws/project.js';
  import { MONTHS } from '../../lib/series.js';
  import { recValue, pasteCells, pasteRecords } from '../../lib/diesel-view.js';

  const KEY = 'site_records.monthly_fuel_l';
  const values = $derived.by(() => { forms.rev; return W.P ? [...W.P.site_records.monthly_fuel_l] : []; });

  function change(e, m) {
    const inp = e.currentTarget;
    W.P.site_records.monthly_fuel_l[m] = recValue(inp.value);
    if (W.P.site_records.monthly_fuel_l[m] == null) inp.value = '';   // a typed zero is no record either
    onFieldChange(KEY);
  }
  function paste(e, m0) {
    const cells = pasteCells(e.clipboardData.getData('text'));
    if (!cells) return;
    e.preventDefault();
    pasteRecords(W.P.site_records.monthly_fuel_l, m0, cells);
    onFieldChange(KEY);
  }
</script>

<div id="recFuelEditor" class="daily-editor months">
  {#each values as v, m}
    <div><span>{MONTHS[m]}</span>
      <input type="number" step="any" min="0" value={v > 0 ? +v : ''} aria-label="Fuel in {MONTHS[m]} (L)" onchange={(e) => change(e, m)} onpaste={(e) => paste(e, m)}></div>
  {/each}
</div>
