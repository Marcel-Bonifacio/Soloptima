<!-- The values of one datasheet, with the consistency checks under them -->
<script>
  import { legacy } from '../../lib/legacy.js';
  import { hasHelp } from '../../lib/help/index.js';
  import { EQ_TYPES, checks, findIn } from '../../lib/equip/library.js';
  import { eq, setField } from '../../lib/equip/equipment.svelte.js';

  const e = $derived.by(() => { eq.rev; return eq.editId ? findIn(legacy.project().equipment.lib, eq.type, eq.editId) : null; });
  const T = $derived(EQ_TYPES[eq.type]);
  const chk = $derived(e ? checks(eq.type, e) : null);
</script>

{#if !e}
  <p class="hint">Select <b>Edit</b> on a row to view or change its datasheet values, or add a new one.</p>
{:else}
  <h3>{e.name}</h3>
  <div class="form">
    {#each T.fields as [k, l, t, u] (k)}
      <label for="eq_{k}">{l}{#if hasHelp('eq.' + k)}<button type="button" class="info" data-k="eq.{k}" data-title={l} aria-label="About {l}" aria-expanded="false">i</button>{/if}</label>
      <div class="field">
        <input id="eq_{k}" type={t === 'num' ? 'number' : 'text'} step="any" value={e[k] ?? ''} onchange={(ev) => setField(e.id, k, ev.currentTarget.value)}>
        {#if u}<span class="unit">{u}</span>{/if}
      </div>
    {/each}
  </div>
  <div class="eq-checks">
    {#if chk.warn.length}<div class="warnbox mt">{#each chk.warn as w, i}{#if i}<br>{/if}⚠ {w}{/each}</div>{/if}
    {#each chk.notes as n}<p class="hint">{n}</p>{/each}
  </div>
{/if}
