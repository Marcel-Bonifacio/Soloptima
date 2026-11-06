<!-- The Site & layout page under its heading: the map card, and beside it the location, the layout parameters with the fill and
     its figures, and the sun path. Mounted into <div class="grid-2 map-grid" data-ui-view="layout"> (web/index.html). -->
<script>
  import MapCard from './MapCard.svelte';
  import SiteInfo from './SiteInfo.svelte';
  import LayoutStats from './LayoutStats.svelte';
  import SchemaForm from '../../lib/SchemaForm.svelte';
  import SunPath from '../results/SunPath.svelte';
  import { lay } from '../../lib/layout/map.svelte.js';
  import { run, shadeFree } from '../../lib/layout/edit.svelte.js';
</script>

<MapCard />
<div class="col">
  <div class="card"><h3>Location</h3><div class="form"><SchemaForm name="site" /></div><SiteInfo /></div>
  <div class="card"><h3>Layout parameters</h3><div class="form"><SchemaForm name="layout" /></div>
    <div class="row gap"><button id="btnLayout" class="btn primary" onclick={run}>Fill area with tables</button>
      <label class="hint inline"><input type="checkbox" id="autoLayout" bind:checked={lay.auto}> auto-update</label>
      <button id="btnShadeFree" class="btn small ghost" title="Ground coverage ratio for rows clear of each other's shadow in the hours above" onclick={shadeFree}>GCR for shade-free rows</button></div>
    <LayoutStats />
  </div>
  <div class="card"><h3>Sun path and horizon</h3><SunPath />
    <p class="hint">Solar time. Grey: the terrain horizon (PV page, Mounting). Brown: buildings and trees as the tables see them, for the median and the most shaded table.</p></div>
</div>
