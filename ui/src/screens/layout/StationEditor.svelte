<!-- The popup of a station on the map: what it is, its name, and removing it. Changes are saved as they are made. -->
<script>
  import { untrack } from 'svelte';
  import { STATION_KINDS } from '../../lib/layout/stations.js';

  let { station: st, apply, remove } = $props();
  const s = untrack(() => st);   // one editor per station: the popup is made again for another
  let kind = $state(s.kind), name = $state(s.name || '');
  const isSub = s.kind === 'substation';

  function change() {
    s.kind = kind;
    const n = name.trim().slice(0, 40);
    if (n) s.name = n; else delete s.name;
    apply();
  }
</script>

<div class="edit-pop">
  <b>Station</b>
  <label><span>Kind</span>
    <select bind:value={kind} onchange={change} disabled={isSub} aria-label="Kind of station">
      {#each STATION_KINDS as [k, t] (k)}<option value={k} disabled={k === 'substation' && !isSub}>{t}</option>{/each}
    </select>
  </label>
  <label><span>Name</span><input type="text" maxlength="40" bind:value={name} onchange={change} aria-label="Name of the station" placeholder="optional"></label>
  <p class="hint">The electrical design measures cable lengths from the stations: string cables from the tables to the nearest PV station, feeders from each station to the MV substation.</p>
  <button type="button" class="btn small ghost" onclick={remove}>Remove</button>
</div>
