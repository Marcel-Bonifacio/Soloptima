<!-- The legal and report links under the sign-in page and the landing page -->
<script>
  import { openDialog } from '../lib/state.svelte.js';
  import { openForm, openList } from '../lib/reports.svelte.js';
  let { list = false } = $props();
  const go = (fn) => (e) => { e.preventDefault(); fn(); };
</script>

<footer class="app-foot">
  <a href="#terms" onclick={go(() => openDialog('legal', 'terms'))}>Terms of use</a> ·
  <a href="#license" onclick={go(() => openDialog('legal', 'license'))}>Licence (Apache 2.0)</a> ·
  <a href="#notices" onclick={go(() => openDialog('legal', 'notices'))}>Third-party notices</a> ·
  <a href="#report" onclick={go(() => openForm())}>Report a problem</a>
  {#if list} · <a href="#reports" onclick={go(() => openList())}>Bug reports</a>{/if}
</footer>
