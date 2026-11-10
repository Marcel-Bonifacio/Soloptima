<!-- The popup editor of a drawn item: height and size of a building or tree; surface height, orientation and grid shift of a
     PV area; width of a path; the clearance tables keep; moving and removing it. Changes are saved as they are made. -->
<script>
  import NumField from './NumField.svelte';
  import { P, closePopup } from '../../lib/layout/map.svelte.js';
  import { changed, setPlacing, removeItem, kindOf, latlngsOf } from '../../lib/layout/edit.svelte.js';
  import { LIMITS, rectOf, rectCorners, alignedAzimuth, projectAz } from '../../lib/layout/items.js';
  import { stripOf, areaLatLng } from '../../lib/layout/geometry.js';
  import { fmtNum } from '../../lib/format.js';
  const BARE = 0.6;   // bare branches pass this share of the beam (BARE_TRANSMISSION in engine/src/layout.rs)

  import { untrack } from 'svelte';
  let { layer: item } = $props();
  const layer = untrack(() => item);   // one editor per item: the popup is made again for another
  const q = layer._props, k = kindOf(layer), path = q.kind === 'path', p = P(), tracker = p.pv.mount === 'tracker';
  const TITLE = { site: 'PV area', exclusion: 'Exclusion zone', building: 'Building', tree: 'Tree' };
  let rev = $state(0);   // the fields are made again after a change that moves other values (orientation, squaring)
  const r = k === 'building' ? rectOf(latlngsOf(layer)) : null;
  let orient = $state(q.canopy ? 'canopy' : q.east_west ? 'ew' : q.tilt != null || q.azimuth != null ? 'own' : 'project');

  const save = () => changed(layer);
  const set = (key, keepZero = false) => (v) => { if (v || (keepZero && v != null)) q[key] = v; else delete q[key]; save(); };
  const setRect = (field) => (v) => { const cur = rectOf(latlngsOf(layer)) || r; cur[field] = v; layer.setLatLngs(rectCorners(latlngsOf(layer), cur)); save(); };

  function orientation() {
    if (orient === 'project') { delete q.tilt; delete q.azimuth; delete q.east_west; delete q.canopy; }
    else {
      if (q.tilt == null) q.tilt = orient === 'ew' ? 10 : p.pv.tilt;
      if (q.azimuth == null) q.azimuth = orient === 'ew' ? 90 : projectAz(p);
      if (orient === 'ew') q.east_west = true; else delete q.east_west;
      if (orient === 'canopy') q.canopy = true; else delete q.canopy;
    }
    rev++;
    save();
  }
  function square() { q.azimuth = alignedAzimuth(latlngsOf(layer), orient === 'ew', p.location.lat); rev++; save(); }
  const mode = (m) => () => setPlacing(m, layer);
</script>

<div class="edit-pop">
  <b>{path ? 'Path keepout' : TITLE[k]}</b>
  {#if k === 'building'}
    <NumField text="Height above ground" unit="m" value={q.height} min={LIMITS.height[0]} max={LIMITS.height[1]} apply={(v) => { q.height = v; save(); }} />
    {#if r}
      <NumField text="Length" unit="m" value={r.length} min={0.5} max={2000} apply={setRect('length')} />
      <NumField text="Width" unit="m" value={r.width} min={0.5} max={2000} apply={setRect('width')} />
      <NumField text="Rotation from north" unit="°" value={r.rotation} min={0} max={180} apply={setRect('rotation')} />
    {:else}
      <p class="hint">Footprint {fmtNum(areaLatLng(latlngsOf(layer)))} m². Use Move corners to change its outline.</p>
    {/if}
  {:else if k === 'tree'}
    <NumField text="Height above ground" unit="m" value={q.height} min={LIMITS.treeHeight[0]} max={LIMITS.treeHeight[1]} apply={(v) => { q.height = v; save(); }} />
    <NumField text="Crown diameter" unit="m" value={2 * layer.getRadius()} min={LIMITS.crown[0]} max={LIMITS.crown[1]} apply={(v) => { layer.setRadius(v / 2); save(); }} />
    <NumField text="Light through the crown" unit="%" value={q.transmission ? +(q.transmission * 100).toFixed(1) : null} min={0} max={LIMITS.transmission[1] * 100} blank="none (solid)"
      apply={(v) => { if (v) q.transmission = v / 100; else delete q.transmission; save(); }} />
    <label><span>Leaves</span>
      <select value={q.leaves === 'deciduous' ? 'deciduous' : 'evergreen'} onchange={(e) => { if (e.currentTarget.value === 'deciduous') q.leaves = 'deciduous'; else delete q.leaves; save(); }}>
        <option value="evergreen">Evergreen: the same all year</option><option value="deciduous">Deciduous: bare branches in winter</option>
      </select></label>
    <p class="hint">Shades as a column of the crown diameter up to its height, passing the share of the beam typed (a deciduous tree passes {Math.round(BARE * 100)} % in winter, without leaves).</p>
  {:else if k === 'site'}
    <NumField text="Surface height above ground" unit="m" value={q.base || 0} min={LIMITS.base[0]} max={LIMITS.base[1]} apply={set('base')} />
    {#if tracker}
      <p class="hint">Trackers follow the project's tracker settings.</p>
    {:else}
      <label><span>Orientation</span>
        <select bind:value={orient} onchange={orientation}>
          <option value="project">Project tilt and azimuth</option><option value="own">Own tilt and azimuth</option>
          <option value="ew">East-west, back to back</option><option value="canopy">Canopy: one plane, no row spacing</option>
        </select></label>
      {#key rev}
        {#if orient !== 'project'}
            <NumField text="Tilt" unit="°" value={q.tilt} min={LIMITS.tilt[0]} max={LIMITS.tilt[1]} apply={(v) => { q.tilt = v; save(); }} />
            <NumField text={orient === 'ew' ? 'Azimuth of one side' : 'Azimuth (from north)'} unit="°" value={q.azimuth} min={LIMITS.azimuth[0]} max={LIMITS.azimuth[1]} apply={(v) => { q.azimuth = v; save(); }} />
            <button type="button" class="btn small ghost" onclick={square}>Square to the longest side</button>
            {#if orient === 'canopy'}<p class="hint">One plane: no row spacing, no row shading, no rear-side gain. Set the canopy height above, the cooling on the PV page.</p>{/if}
        {/if}
      {/key}
    {/if}
    {#if !tracker}
      {#key rev}
      <NumField text="Ground slope" unit="°" value={q.slope} min={0} max={LIMITS.slope[1]} blank="level" apply={(v) => { if (!v) delete q.slope_azimuth; set('slope')(v); rev++; }} />
      {#if q.slope > 0}
        <NumField text="Falls towards (azimuth from north)" unit="°" value={q.slope_azimuth} min={0} max={360} blank="the way the tables face" apply={set('slope_azimuth', true)} />
        <p class="hint">Rows stand on the slope at their tilt; the ground coverage ratio counts along the ground, so the rows come closer on the map. Sets the row shading and the ground the rows see.</p>
      {/if}
      {/key}
    {/if}
    <NumField text="Shift the tables along the rows" unit="m" value={q.shift_u} min={0} max={LIMITS.shift[1]} blank="0" apply={set('shift_u')} />
    <NumField text="Shift the first row by" unit="m" value={q.shift_v} min={0} max={LIMITS.shift[1]} blank="auto" apply={set('shift_v', true)} />
    <button type="button" class="btn small ghost" onclick={() => { closePopup(); setPlacing('align', layer); }}>Align to click</button>
  {:else if path}
    <NumField text="Width" unit="m" value={q.width} min={LIMITS.width[0]} max={LIMITS.width[1]} apply={(v) => { q.width = v; layer.setLatLngs(stripOf(q.path, v)); layer._pts = latlngsOf(layer); save(); }} />
    <p class="hint">Tables keep off the strip. To change its route, remove it and draw it again.</p>
  {/if}
  {#if k !== 'site'}
    <NumField text="Keep tables clear by" unit="m" value={q.clearance} min={0} max={LIMITS.clearance[1]} blank="none" apply={set('clearance')} />
  {/if}
  {#if k !== 'tree' && !path}<button type="button" class="btn small ghost" onclick={mode('move')}>Move corners</button>{/if}
  <button type="button" class="btn small ghost" onclick={mode(k === 'tree' ? 'move' : 'drag')}>{k === 'tree' ? 'Move' : 'Move shape'}</button>
  <button type="button" class="btn small ghost" onclick={() => { closePopup(); removeItem(layer); }}>Remove</button>
</div>
