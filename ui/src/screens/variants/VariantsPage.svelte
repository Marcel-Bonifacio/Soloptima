<!-- The Design variants page (tab-variants): named copies of the project with some settings changed, compared side by side -->
<script>
  import { ws } from '../../lib/ws/tabs.svelte.js';
  import { W } from '../../lib/ws/state.js';
  import { forms } from '../../lib/state.svelte.js';
  import { vs, addVariant } from '../../lib/variants.svelte.js';
  import { variantView } from '../../lib/variants-view.js';
  import { MAX_VARIANTS } from '../../lib/variants.js';
  import VariantCard from './VariantCard.svelte';
  import VariantResults from './VariantResults.svelte';

  // a new list of plain objects after every change: the project is edited in place, so Svelte would not see the same ones change
  const list = $derived.by(() => { vs.rev; forms.rev; return W.P ? variantView(W.P) : []; });
</script>

<section id="tab-variants" class="tab" class:active={ws.tab === 'variants'}>
  <h1>Design variants</h1>
  <p class="lead">Try other designs without touching the project: a variant is the project with a few settings changed, such as a larger battery, another dispatch strategy or a different fuel price. The comparison simulates the project and every variant and puts the results side by side. A variant keeps only what it changes, so the other settings follow the project.</p>
  <div class="row space"><h2>Variants</h2>
    <button id="btnAddVariant" class="btn" disabled={list.length >= MAX_VARIANTS} onclick={addVariant}>Add a variant</button></div>
  {#if list.length}
    <div class="grid-2 variants">{#each list as v (v.id)}<VariantCard {v} />{/each}</div>
  {:else}
    <div class="empty">No variant yet. Add one, then choose the settings it changes.</div>
  {/if}
  <VariantResults />
</section>
