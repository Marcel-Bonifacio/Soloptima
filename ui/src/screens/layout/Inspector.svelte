<!-- The inspector beside the map: the fields of the selected item (ItemEditor.svelte), made again when the 3D view changes
     the item; with nothing selected, what the tools do. -->
<script>
  import ItemEditor from './ItemEditor.svelte';
  import Icon from './Icon.svelte';
  import { lay } from '../../lib/layout/map.svelte.js';
  import { itemAt, select } from '../../lib/layout/edit.svelte.js';
  const layer = $derived.by(() => { void lay.rev; return itemAt(lay.selected); });
</script>

<aside class="inspector" aria-label="Selected item">
  {#if layer}
    <button class="icon-btn inspector-close" title="Close (Esc in the 3D view)" aria-label="Close the inspector" onclick={() => select(null)}><Icon name="close" /></button>
    {#key `${lay.selected}:${lay.itemRev}`}<ItemEditor {layer} />{/key}
  {:else}
    <p class="inspector-head">Nothing selected</p>
    <p class="hint">Click an area, building or tree on the map or in the 3D view to change it here.</p>
    <p class="hint">In 3D, a selected item has handles: W moves it, E turns it, R sizes it. Drag a handle, or type the values here. Each drag is one undo step.</p>
    <p class="hint">Rooftop puts panels flush on the sunny roof planes of a building you click. Set the roof shape on the building first.</p>
  {/if}
</aside>
