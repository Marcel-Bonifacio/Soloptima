<!-- The appliance list of the Load page: one row per appliance with its hours a day in each season and the hour it starts, and
     the number of households. An edit that leaves energy in the list makes the profile from it (template "Appliance list"). -->
<script>
  import { forms } from '../../lib/state.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { SEASONS } from '../../lib/series.js';
  import { fmtNum } from '../../lib/format.js';
  import { dat, setAppliances } from '../../lib/data.svelte.js';
  import { cleanAppliances, seasonEnergy, MAX_APPLIANCES } from '../../lib/appliances.js';

  const A = $derived.by(() => { forms.rev; dat.rev; return cleanAppliances(W.P && W.P.load.appliances); });
  const used = $derived.by(() => { forms.rev; dat.rev; return !!W.P && W.P.load.template === 'appliances'; });
  const E = $derived(seasonEnergy(A));
  const cols = [['w', 'Power', 'W'], ['qty', 'Quantity', '']];
  const cell = (e, row, key) => setAppliances({ row, key, value: e.currentTarget.value });
</script>

<h3>Appliance list <button type="button" class="info" data-k="load.appliances" data-title="Appliance list" aria-label="About the appliance list" aria-expanded="false">i</button></h3>
{#if A.items.length}
  <div class="table-wrap"><table class="data">
    <thead><tr><th>Appliance</th>{#each cols as [, l, u]}<th>{l}{u ? ` (${u})` : ''}</th>{/each}
      {#each SEASONS as s}<th>h/day {s}</th>{/each}<th>Starts at</th><th></th></tr></thead>
    <tbody>
      {#each A.items as x, i (i)}
        <tr>
          <td><input style="width: 9em" type="text" value={x.name} aria-label="Appliance {i + 1}" onchange={(e) => cell(e, i, 'name')}></td>
          {#each cols as [k, l]}<td><input style="width: 6em" type="number" step="any" min="0" value={x[k]} aria-label="{l}, appliance {i + 1}" onchange={(e) => cell(e, i, k)}></td>{/each}
          {#each SEASONS as s, j}<td><input style="width: 4.5em" type="number" step="any" min="0" max="24" value={x.h[j]} aria-label="Hours a day {s}, appliance {i + 1}" onchange={(e) => cell(e, i, 'h' + j)}></td>{/each}
          <td><input style="width: 4em" type="number" step="1" min="0" max="23" value={x.start} aria-label="Start hour, appliance {i + 1}" onchange={(e) => cell(e, i, 'start')}></td>
          <td><button type="button" class="btn small" onclick={() => setAppliances({ remove: i })} aria-label="Remove appliance {i + 1}">Remove</button></td>
        </tr>
      {/each}
    </tbody>
  </table></div>
{/if}
<div class="row gap mt">
  <button type="button" class="btn" disabled={A.items.length >= MAX_APPLIANCES} onclick={() => setAppliances({ add: true })}>Add an appliance</button>
  <label>Households <input style="width: 6em" type="number" step="1" min="0" value={A.households} onchange={(e) => setAppliances({ households: e.currentTarget.value })}></label>
</div>
{#if E.some((x) => x.kwh > 0)}
  <p class="hint">{SEASONS.map((s, j) => `${s}: ${fmtNum(E[j].kwh, 1)} kWh a day, ${fmtNum(E[j].peak, 1)} kW at most`).join(' · ')}.{used ? '' : ' Pick "Appliance list" as the daily shape template to use it.'}</p>
{/if}
<p class="hint">Each appliance runs its hours a day from the start hour on, the last hour in part, past midnight when needed; the list is the average day of every month in its season, times the households. Weekend load, the variability and the scale to an average load apply as for a daily shape.</p>
