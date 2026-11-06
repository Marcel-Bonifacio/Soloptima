<!-- One option of the CSV import dialog: label with its ⓘ button, and a select (list of [value, text, disabled]) or the children -->
<script>
  import { legacy } from '../../lib/legacy.js';
  let { help, label, list = null, value = null, disabled = false, wide = false, onpick = null, children = null } = $props();
</script>

<div class="ts-f" class:wide>
  <div class="ts-l"><span>{label}</span>{#if legacy.hasHelp(help)}<button type="button" class="info" data-k={help} data-title={label} aria-label="About {label}" aria-expanded="false">i</button>{/if}</div>
  {#if list}
    <select aria-label={label} {disabled} onchange={(e) => onpick(e.currentTarget.value)}>
      {#each list as [k, l, dis] (k)}<option value={String(k)} selected={String(k) === String(value)} disabled={!!dis}>{l}</option>{/each}
    </select>
  {:else}{@render children()}{/if}
</div>
