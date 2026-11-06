<!-- One design variant: its name and the settings it changes from the project, each with the project's own value beside it -->
<script>
  import VariantInput from './VariantInput.svelte';
  import { knobGroups } from '../../lib/variants.js';
  import { renameVariant, duplicateVariant, removeVariant, addChange, setChange, removeChange } from '../../lib/variants.svelte.js';

  let { v } = $props();
  const GROUPS = knobGroups();
  const free = (list) => list.filter((k) => !v.rows.some((r) => r.k === k.k));
</script>

<div class="card variant">
  <div class="row space">
    <input type="text" class="vname" maxlength="40" aria-label="Name of the variant" value={v.name}
      onchange={(e) => { renameVariant(v.id, e.currentTarget.value); e.currentTarget.value = v.name; }}>
    <div class="row gap">
      <button type="button" class="btn small ghost" onclick={() => duplicateVariant(v.id)}>Duplicate</button>
      <button type="button" class="btn small ghost" onclick={() => removeVariant(v.id)}>Remove</button>
    </div>
  </div>
  {#if v.rows.length}
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Setting</th><th>This variant</th><th></th></tr></thead>
        <tbody>
          {#each v.rows as r (r.k)}
            <tr>
              <td>{r.f.name}<span class="var-base">Project: {r.baseText}</span></td>
              <td class="cell-in"><VariantInput f={r.f} value={r.value} unit={r.unit} onset={(x) => setChange(v.id, r.k, x)} /></td>
              <td><button type="button" class="btn small ghost" aria-label="Remove this change: {r.f.name}" onclick={() => removeChange(v.id, r.k)}>×</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="hint">No change yet: this variant is the project as it is. Add the settings it changes.</p>
  {/if}
  <select class="vadd" aria-label="Add a setting to {v.name}" value="" onchange={(e) => { if (e.currentTarget.value) addChange(v.id, e.currentTarget.value); e.currentTarget.value = ''; }}>
    <option value="">Add a setting…</option>
    {#each GROUPS as [name, list] (name)}
      {@const rest = free(list)}
      {#if rest.length}<optgroup label={name}>{#each rest as k (k.k)}<option value={k.k}>{k.l}</option>{/each}</optgroup>{/if}
    {/each}
  </select>
</div>
