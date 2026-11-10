<!-- The further genset groups of a mixed fleet (P.diesel.more_groups): one row per group, with add and remove -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { onFieldChange } from '../../lib/ws/project.js';
  import { toast } from '../../lib/toast.js';
  import { GROUP_COLUMNS, MAX_GROUPS, groupsOf, addGroup, removeGroup, cellValue, setCell, curveWarnings, fleetLabel } from '../../lib/fleet-view.js';

  const KEY = 'diesel.more_groups';
  const view = $derived.by(() => {
    forms.rev;
    const D = W.P ? W.P.diesel : null;
    return D ? { rows: groupsOf(D).map((g) => GROUP_COLUMNS.map(([k]) => cellValue(g, k))), label: fleetLabel(D), warn: curveWarnings(D) } : { rows: [], label: '', warn: [] };
  });
  const apply = (r) => { if (r.error) toast(r.error, true); if (r.changed) onFieldChange(KEY); };
  function change(e, i, key) { const r = setCell(W.P.diesel, i, key, e.currentTarget.value); apply(r); if (!r.changed) e.currentTarget.value = cellValue(groupsOf(W.P.diesel)[i], key); }
</script>

<p class="hint">Fleet: {view.label}. Units are started in merit order, the group with the cheapest energy (fuel at 75 % loading and O&amp;M) first, and the online units share the load at one loading. A blank fuel efficiency takes the main group's curve; a blank cost the main group's (Costs page).</p>
{#if view.rows.length}
  <div class="table-wrap"><table class="data">
    <thead><tr>{#each GROUP_COLUMNS as [, l, u]}<th>{l}{u ? ` (${u})` : ''}</th>{/each}<th></th></tr></thead>
    <tbody>
      {#each view.rows as row, i}
        <tr>
          {#each GROUP_COLUMNS as [k, l, , kind], c}
            <td><input style="width: {kind === 'text' ? 9 : 6}em" type={kind === 'text' ? 'text' : 'number'} step="any" value={row[c]} aria-label="{l}, group {i + 2}" onchange={(e) => change(e, i, k)}></td>
          {/each}
          <td><button type="button" class="btn small" onclick={() => apply(removeGroup(W.P.diesel, i))} aria-label="Remove group {i + 2}">Remove</button></td>
        </tr>
      {/each}
    </tbody>
  </table></div>
{/if}
{#each view.warn as w}<p class="hint">⚠ {w}</p>{/each}
<button type="button" class="btn" disabled={view.rows.length >= MAX_GROUPS} onclick={() => apply(addGroup(W.P.diesel))}>Add a genset group</button>
