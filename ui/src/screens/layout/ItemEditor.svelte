<!-- The popup editor of a drawn item: height and size of a building or tree; surface height, orientation and grid shift of a
     PV area; width of a path; the clearance tables keep; moving and removing it. Changes are saved as they are made. -->
<script>
  import NumField from './NumField.svelte';
  import { P, lay } from '../../lib/layout/map.svelte.js';
  import { changed, setPlacing, removeItem, kindOf, latlngsOf, roofPanelsOn } from '../../lib/layout/edit.svelte.js';
  import { defaultRidge } from '../../lib/layout/transform.js';
  import { ROOF_FIELDS, ROOF_DEFAULTS, NO_PANELS, roofOf } from '../../lib/layout/solids.js';
  import { LIMITS, rectOf, rectCorners, alignedAzimuth, projectAz, roundCorners, roundDiameter } from '../../lib/layout/items.js';
  import { stripOf, areaLatLng, localProjector } from '../../lib/layout/geometry.js';
  import { fmtNum } from '../../lib/format.js';
  const BARE = 0.6;   // bare branches pass this share of the beam (BARE_TRANSMISSION in engine/src/layout.rs)

  import { untrack } from 'svelte';
  let { layer: item } = $props();
  const layer = untrack(() => item);   // one editor per item: the popup is made again for another
  const q = layer._props, k = kindOf(layer), path = q.kind === 'path', p = P(), tracker = p.pv.mount === 'tracker';
  const TITLE = { site: q.carport ? 'Carport' : q.rooftop ? 'Panels on a roof' : 'PV area', exclusion: 'Exclusion zone', building: 'Building', tree: 'Tree' };
  const map = $derived(lay.view !== '3d');   // moving corners and aligning work on the map; the 3D view has its own handles
  const ROOF_NAMES = { flat: 'Flat', parapet: 'Flat with a parapet', gable: 'Gable (two planes)', hip: 'Hip (four planes)', pyramid: 'Pyramid (four planes to a point)',
    shed: 'Shed (one plane)', mansard: 'Mansard (four sides, two pitches)', gambrel: 'Gambrel (barn: two sides, two pitches)', butterfly: 'Butterfly (two planes to a valley)',
    sawtooth: 'Sawtooth (teeth with upright faces)', barrel: 'Barrel vault', cone: 'Cone or spire', dome: 'Dome' };
  const RISE_TEXT = { parapet: 'Parapet height', mansard: 'Break height above the eaves', gambrel: 'Break height above the eaves', barrel: 'Vault rise', cone: 'Cone height', dome: 'Dome height' };
  const AZ_TEXT = { shed: 'Falls towards (azimuth)', sawtooth: 'Planes fall towards (azimuth)', butterfly: 'Valley runs towards (azimuth)', barrel: 'Vault runs towards (azimuth)',
    pyramid: 'Long sides run towards (azimuth)', mansard: 'Ridge runs towards (azimuth)' };
  const HEIGHT_TEXT = { parapet: 'Roof height above ground', barrel: 'Wall height', cone: 'Wall height', dome: 'Wall height' };
  const uses = (f) => !!q.roof && ROOF_FIELDS[q.roof].includes(f);
  // the rise a vault, cone or dome takes from its footprint when none is typed
  const autoRise = () => { const ll = latlngsOf(layer), r = roofOf({ ...q, rise: undefined }, ll.map(localProjector(ll).fwd)); return r.rise; };
  const SHAPES = { column: 'Column (as drawn before)', round: 'Round crown', cone: 'Cone (pine)', palm: 'Palm' };
  // a new shape takes its own defaults; the pitch stays between the plain pitched roofs
  const PLAIN = ['gable', 'hip', 'pyramid', 'shed'];
  function roofShape(v) {
    const keep = PLAIN.includes(q.roof) && PLAIN.includes(v) ? q.pitch : null;
    for (const f of ['pitch', 'pitch2', 'rise', 'width', 'ridge_az']) delete q[f];
    if (v === 'flat') delete q.roof;
    else {
      q.roof = v;
      for (const f of ROOF_FIELDS[v]) if (ROOF_DEFAULTS[v][f] != null) q[f] = ROOF_DEFAULTS[v][f];
      if (keep != null) q.pitch = keep;
      if (ROOF_FIELDS[v].includes('ridge_az')) q.ridge_az = defaultRidge({ latlngs: latlngsOf(layer) }, v, p.location.lat);
    }
    rev++;
    save();
  }
  function makeRound(d) { q.round = true; layer.setLatLngs(roundCorners(latlngsOf(layer), d)); rev++; save(); }
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
    {#key rev}
    <NumField text={HEIGHT_TEXT[q.roof] || (q.roof ? 'Eave height (top of the walls)' : 'Height above ground')} unit="m" value={q.height} min={LIMITS.height[0]} max={LIMITS.height[1]} apply={(v) => { q.height = v; save(); }} />
    <label><span>Roof</span>
      <select value={q.roof || 'flat'} onchange={(e) => roofShape(e.currentTarget.value)}>
        {#each Object.entries(ROOF_NAMES) as [v, t] (v)}<option value={v}>{t}</option>{/each}
      </select></label>
    {#if uses('pitch')}
      <NumField text={uses('pitch2') ? 'Lower pitch' : 'Pitch'} unit="°" value={q.pitch} min={LIMITS.pitch[0]} max={LIMITS.pitch[1]} apply={(v) => { q.pitch = v; if (q.pitch2 > v) q.pitch2 = v; rev++; save(); }} />
    {/if}
    {#if uses('pitch2')}
      <NumField text="Upper pitch" unit="°" value={q.pitch2} min={LIMITS.pitch[0]} max={q.pitch} apply={(v) => { q.pitch2 = v; save(); }} />
    {/if}
    {#if uses('rise')}
      <NumField text={RISE_TEXT[q.roof]} unit="m" value={q.rise} min={(q.roof === 'parapet' ? LIMITS.parapet : LIMITS.rise)[0]} max={(q.roof === 'parapet' ? LIMITS.parapet : LIMITS.rise)[1]}
        blank={ROOF_DEFAULTS[q.roof].rise == null ? `auto (${fmtNum(autoRise(), 1)} m)` : undefined} apply={(v) => { if (v) q.rise = v; else if (ROOF_DEFAULTS[q.roof].rise == null) delete q.rise; save(); }} />
    {/if}
    {#if uses('width')}
      <NumField text="Tooth width" unit="m" value={q.width} min={LIMITS.tooth[0]} max={LIMITS.tooth[1]} apply={(v) => { q.width = v; save(); }} />
    {/if}
    {#if uses('ridge_az')}
      <NumField text={AZ_TEXT[q.roof] || 'Ridge runs towards (azimuth)'} unit="°" value={q.ridge_az} min={0} max={360} apply={(v) => { q.ridge_az = v; save(); }} />
    {/if}
    {#if q.roof === 'cone' || q.roof === 'dome'}<p class="hint">Fitted inside the footprint: the largest ellipse of its proportions, flat roof round it at the wall height. Blank height: {q.roof === 'cone' ? 'the shorter half width' : 'half the shorter half width'}.</p>{/if}
    {#if q.roof === 'parapet'}<p class="hint">The parapet shades panels on this roof. Panels on this roof keep its height plus 0.5 m from the edge.</p>{/if}
    {/key}
    {#if NO_PANELS.includes(q.roof)}
      <p class="hint">No panels are laid on a {ROOF_NAMES[q.roof].toLowerCase()} roof. Draw a PV area on it by hand if needed.</p>
    {:else}
      <button type="button" class="btn small" onclick={() => roofPanelsOn(layer)}>Panels on this roof</button>
    {/if}
    {#key rev}
    {#if q.round}
      <NumField text="Diameter" unit="m" value={+roundDiameter(latlngsOf(layer)).toFixed(2)} min={LIMITS.diameter[0]} max={LIMITS.diameter[1]} apply={makeRound} />
    {:else}
      <button type="button" class="btn small ghost" onclick={() => makeRound(+roundDiameter(latlngsOf(layer)).toFixed(2))}>Make round (silo, tank)</button>
    {/if}
    {/key}
    {#if q.round}
      <p class="hint">A round footprint: a cylinder. Give it a cone or dome roof for a silo.</p>
    {:else if r}
      <NumField text="Length" unit="m" value={r.length} min={0.5} max={2000} apply={setRect('length')} />
      <NumField text="Width" unit="m" value={r.width} min={0.5} max={2000} apply={setRect('width')} />
      <NumField text="Rotation from north" unit="°" value={r.rotation} min={0} max={180} apply={setRect('rotation')} />
    {:else}
      <p class="hint">Footprint {fmtNum(areaLatLng(latlngsOf(layer)))} m². Use Move corners to change its outline.</p>
    {/if}
  {:else if k === 'tree'}
    <label><span>Shape</span>
      <select value={q.shape || 'column'} onchange={(e) => { if (e.currentTarget.value === 'column') delete q.shape; else q.shape = e.currentTarget.value; save(); }}>
        {#each Object.entries(SHAPES) as [v, t] (v)}<option value={v}>{t}</option>{/each}
      </select></label>
    <NumField text="Height above ground" unit="m" value={q.height} min={LIMITS.treeHeight[0]} max={LIMITS.treeHeight[1]} apply={(v) => { q.height = v; save(); }} />
    <NumField text="Crown diameter" unit="m" value={2 * layer.getRadius()} min={LIMITS.crown[0]} max={LIMITS.crown[1]} apply={(v) => { layer.setRadius(v / 2); save(); }} />
    <NumField text="Light through the crown" unit="%" value={q.transmission ? +(q.transmission * 100).toFixed(1) : null} min={0} max={LIMITS.transmission[1] * 100} blank="none (solid)"
      apply={(v) => { if (v) q.transmission = v / 100; else delete q.transmission; save(); }} />
    <label><span>Leaves</span>
      <select value={q.leaves === 'deciduous' ? 'deciduous' : 'evergreen'} onchange={(e) => { if (e.currentTarget.value === 'deciduous') q.leaves = 'deciduous'; else delete q.leaves; save(); }}>
        <option value="evergreen">Evergreen: the same all year</option><option value="deciduous">Deciduous: bare branches in winter</option>
      </select></label>
    <p class="hint">Shades as its crown: a column of the crown diameter up to its height, a round crown, a cone narrowing to the top, or a palm's fronds drooping from the top; passing the share of the beam typed (a deciduous tree passes {Math.round(BARE * 100)} % in winter, without leaves).</p>
  {:else if k === 'site'}
    {#if !q.carport}<NumField text="Surface height above ground" unit="m" value={q.base || 0} min={LIMITS.base[0]} max={LIMITS.base[1]} apply={set('base')} />{/if}
    <NumField text={q.carport ? 'Canopy height (table centre)' : 'Table centre over the surface'} unit="m" value={q.h0} min={LIMITS.h0[0]} max={LIMITS.h0[1]}
      blank={`project (${p.pv.mount_height ?? 1.5} m)`} apply={set('h0', true)} />
    {#if q.rooftop}<p class="hint">Flush on a roof plane: tilt and slope are the roof pitch, the tables {q.h0 ?? 0.15} m over it.</p>{/if}
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
            {#if orient === 'canopy'}<p class="hint">One plane: no row spacing, no row shading; with edge rows on (PV page) bifacial modules see the ground under and around it as one wide open row. Set the canopy height above, the cooling on the PV page.</p>{/if}
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
    {#if map}<button type="button" class="btn small ghost" onclick={() => setPlacing('align', layer)}>Align to click</button>{/if}
  {:else if path}
    <NumField text="Width" unit="m" value={q.width} min={LIMITS.width[0]} max={LIMITS.width[1]} apply={(v) => { q.width = v; layer.setLatLngs(stripOf(q.path, v)); layer._pts = latlngsOf(layer); save(); }} />
    <p class="hint">Tables keep off the strip. To change its route, remove it and draw it again.</p>
  {/if}
  {#if k !== 'site'}
    <NumField text="Keep tables clear by" unit="m" value={q.clearance} min={0} max={LIMITS.clearance[1]} blank="none" apply={set('clearance')} />
  {/if}
  {#if map && k !== 'tree' && !path}<button type="button" class="btn small ghost" onclick={mode('move')}>Move corners</button>{/if}
  {#if map}<button type="button" class="btn small ghost" onclick={mode(k === 'tree' ? 'move' : 'drag')}>{k === 'tree' ? 'Move' : 'Move shape'}</button>{/if}
  <button type="button" class="btn small ghost" onclick={() => removeItem(layer)}>Remove</button>
</div>
