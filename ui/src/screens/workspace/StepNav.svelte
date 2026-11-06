<!-- Back and next buttons at the foot of every page -->
<script>
  import { ws, showTab, STEP_ORDER } from '../../lib/ws/tabs.svelte.js';
  import { label } from '../../lib/ws/nav.js';
  const i = $derived(STEP_ORDER.indexOf(ws.tab));
  const prev = $derived(STEP_ORDER[i - 1]), next = $derived(STEP_ORDER[i + 1]);
</script>

<div class="step-nav">
  {#if prev}<button class="btn ghost" onclick={() => showTab(prev)}>← <span>Back:</span> {label(prev)}</button>{:else}<span></span>{/if}
  {#if next}<button class="btn" onclick={() => showTab(next)}><span>Next:</span> {label(next)} →</button>{/if}
</div>
