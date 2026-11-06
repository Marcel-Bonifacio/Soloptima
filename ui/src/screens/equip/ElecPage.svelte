<!-- Electrical design page: basis, string sizing, losses, transformers, cables, warnings, load flow, single-line diagram -->
<script>
  import { design, el } from '../../lib/equip/electrical.svelte.js';
  import ElecResults from './ElecResults.svelte';
  import ElecCables from './ElecCables.svelte';
  import LoadFlow from './LoadFlow.svelte';
  import Sld from './Sld.svelte';

  const warn = $derived(design().warn);
</script>

{#if el.active}
  <ElecResults />
  <ElecCables />
  {#if warn.length}<div class="warnbox">{#each warn as w, i}{#if i}<br>{/if}⚠ {w}{/each}</div>{/if}
  <LoadFlow />
  <Sld />
{/if}
