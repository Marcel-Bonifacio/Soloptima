<!-- The popup of an OpenStreetMap building: what to make of it. actions: [[label, fn]] -->
<script>
  import { fmtNum } from '../../lib/format.js';
  let { height, actions } = $props();
</script>

<div class="edit-pop">
  <b>OpenStreetMap building{height ? `, ${fmtNum(height, 1)} m high` : ''}</b>
  {#each actions as [label, fn]}<button type="button" class="btn small" onclick={fn}>{label}</button>{/each}
</div>
