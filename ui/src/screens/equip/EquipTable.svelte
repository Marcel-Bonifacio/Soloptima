<!-- The datasheets of the chosen type as a table, with Use, Edit, Duplicate and Delete -->
<script>
  import { W } from '../../lib/ws/state.js';
  import { fmtSig } from '../../lib/format.js';
  import { EQ_TYPES } from '../../lib/equip/library.js';
  import { eq, edit, duplicate, remove, use } from '../../lib/equip/equipment.svelte.js';

  const T = $derived(EQ_TYPES[eq.type]);
  const rows = $derived.by(() => { eq.rev; return W.P.equipment.lib[eq.type] || []; });
  const chosen = $derived.by(() => { eq.rev; return W.P.equipment.sel[eq.type]; });
  const field = (k) => T.fields.find((f) => f[0] === k);
</script>

<table class="data">
  <thead>
    <tr>
      {#if T.sel}<th>Use</th>{/if}
      <th>Name</th>
      {#each T.cols as k}{@const f = field(k)}<th>{f[1]}{f[3] ? ` (${f[3]})` : ''}</th>{/each}
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each rows as e (e.id)}
      <tr class={e.id === eq.editId ? 'best' : ''}>
        {#if T.sel}<td><input type="radio" name="eqsel" aria-label="Use {e.name || 'this datasheet'}" checked={chosen === e.id} onchange={() => use(e.id)}></td>{/if}
        <td>{e.name || ''}</td>
        {#each T.cols as k}<td>{typeof e[k] === 'number' ? fmtSig(e[k]) : e[k] || ''}</td>{/each}
        <td>
          <button class="btn small" onclick={() => edit(e.id)}>Edit</button>
          <button class="btn small ghost" title="Duplicate" aria-label="Duplicate" onclick={() => duplicate(e.id)}>⧉</button>
          <button class="btn small ghost" title="Delete" aria-label="Delete" onclick={() => remove(e.id)}>✕</button>
        </td>
      </tr>
    {/each}
  </tbody>
</table>
