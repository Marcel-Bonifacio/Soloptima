<!-- The site map card of the Site & layout page. One slim bar on top (search, map or 3D, base map, undo, redo, the More menu
     with files and map data, full screen), the drawing tools down the left, the map or the 3D view in the middle and the
     inspector of the selected item on the right; the cursor and own-image line under it. The map is lib/layout/map.svelte.js. -->
<script>
  import { onMount } from 'svelte';
  import Layout3D from './Layout3D.svelte';
  import Inspector from './Inspector.svelte';
  import Icon from './Icon.svelte';
  import { lay, init, goTo, pick, setView, pickBase, fullScreen } from '../../lib/layout/map.svelte.js';
  import { startDraw, clearAll, undo, redo, toggle, restoreTables, showBlocks } from '../../lib/layout/edit.svelte.js';
  import { autoPlace } from '../../lib/layout/stations.svelte.js';
  import { loadOsm, loadImage, importFile, exportLayout, setOpacity, dropImage } from '../../lib/layout/tools.svelte.js';
  import { openExternal } from '../../lib/ipc.js';
  import { STATION_KINDS, stationMode } from '../../lib/layout/stations.js';

  let mapEl, query = $state(''), importAs = $state('site'), format = $state('geojson'), more = $state(false), plant = $state(false);
  onMount(() => init(mapEl));

  const BASES = [['esri', 'Satellite (Esri)'], ['hybrid', 'Hybrid (satellite with roads & labels)'], ['osm', 'Streets (OpenStreetMap)'],
    ['topo', 'Topographic (OpenTopoMap)'], ['google', 'Google satellite (API key)'], ['google_hybrid', 'Google hybrid (API key)'], ['google_road', 'Google roadmap (API key)']];
  const placing = $derived(['tree', 'trace', 'rooftop', 'align', 'remove'].includes(lay.placing) || !!stationMode(lay.placing));
  // the drawing tools: [id, icon, label, what it does, action, the placing mode it turns on]
  /** @type {[string, string, string, string, () => void, string?][]} */
  const DRAW = [
    ['site', 'area', 'PV area', 'Draw a PV area on the ground: click its corners, double-click to finish', () => startDraw('site')],
    ['rooftop', 'roof', 'Rooftop', 'Put panels on a building: click a building, panels go flush on its roof planes that face the sun', () => toggle('rooftop'), 'rooftop'],
    ['carport', 'carport', 'Carport', 'Draw a carport canopy: click its corners, double-click to finish', () => startDraw('carport')],
    ['building', 'building', 'Building', 'Draw a building footprint, then set its height and roof', () => startDraw('building')],
    ['tree', 'tree', 'Tree', 'Click the map to place trees, then set their shape, height and crown', () => toggle('tree'), 'tree'],
    ['exclusion', 'exclusion', 'Keep out', 'Draw a zone the tables keep out of', () => startDraw('exclusion')],
    ['path', 'path', 'Path', 'Draw a road or walkway the tables keep off, then give its width', () => startDraw('path')],
  ];
  function files(e, fn) { const f = Array.from(e.currentTarget.files); e.currentTarget.value = ''; more = false; if (f.length) fn(f); }
  const menu = (fn) => () => { more = false; fn(); };
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { more = false; plant = false; } }} />
<div class="card map-card" class:full={lay.full} id="mapCard">
  <div class="map-toolbar">
    <input id="geoSearch" placeholder="Coordinates, Google Maps link or place name…" aria-label="Go to coordinates or place" bind:value={query}
      onkeydown={(e) => { if (e.key === 'Enter') goTo(query); }}>
    <button id="btnGeo" class="btn small primary" onclick={() => goTo(query)}>Go</button>
    <div class="seg" id="mapView">
      <button class:on={lay.view === 'leaflet'} onclick={() => setView('leaflet')}>Map</button>
      <button class:on={lay.view === '3d'} title="The layout in 3D with the sun and the shadows at a chosen hour" onclick={() => setView('3d')}>3D</button>
      <button class:on={lay.view === 'google'} onclick={() => setView('google')}>Google Maps</button>
    </div>
    <select id="baseLayer" aria-label="Base map" value={lay.base} onchange={async (e) => { await pickBase(e.currentTarget.value); e.currentTarget.value = lay.base; }}>
      {#each BASES as [v, t]}<option value={v}>{t}</option>{/each}
    </select>
    <span class="spacer"></span>
    <button id="btnUndo" class="icon-btn" title="Undo (Ctrl+Z, Cmd+Z on a Mac)" aria-label="Undo" disabled={!lay.canUndo} onclick={undo}><Icon name="undo" /></button>
    <button id="btnRedo" class="icon-btn" title="Redo (Ctrl+Shift+Z or Ctrl+Y)" aria-label="Redo" disabled={!lay.canRedo} onclick={redo}><Icon name="redo" /></button>
    <div class="dd-wrap">
      <button id="btnMore" class="icon-btn" title="Files, map data and clearing" aria-label="More" aria-expanded={more} onclick={() => (more = !more)}><Icon name="more" /></button>
      {#if more}
        <div class="dd" role="menu">
          <label class="dd-item">Import KML, KMZ or GeoJSON…<input type="file" id="fileGeo" accept=".kml,.kmz,.geojson,.json" hidden onchange={(e) => files(e, (f) => importFile(f[0], importAs))}></label>
          <label class="dd-sub">as <select id="importAs" aria-label="Import shapes as" bind:value={importAs}><option value="site">PV areas</option><option value="exclusion">keep-out zones</option><option value="building">buildings</option></select></label>
          <div class="dd-sub"><button class="dd-item" onclick={menu(() => exportLayout(format))}>Export the layout</button>
            <select id="exportFormat" aria-label="Export format" bind:value={format}><option value="geojson">GeoJSON</option><option value="kml">KML</option></select></div>
          <hr>
          <label class="dd-item" title="Your own drone or survey image (PNG, JPEG or WebP) with its world file, and its .prj if you have one">Own drone or survey image…<input type="file" id="fileImage" multiple accept=".png,.jpg,.jpeg,.webp,.pgw,.pngw,.jgw,.jpgw,.jpegw,.wpw,.wld,.tfw,.prj" hidden onchange={(e) => files(e, loadImage)}></label>
          <button class="dd-item" class:on={lay.placing === 'trace'} onclick={menu(() => toggle('trace'))}>Trace a roof on your image</button>
          <button class="dd-item" disabled={lay.osmBusy} onclick={menu(loadOsm)}>Buildings from OpenStreetMap</button>
          <hr>
          <button class="dd-item danger" onclick={menu(clearAll)}>Clear all items</button>
        </div>
      {/if}
    </div>
    <button id="btnFull" class="icon-btn" title="Full screen" aria-label="Full screen" aria-pressed={lay.full} onclick={() => fullScreen(!lay.full)}><Icon name="full" /></button>
  </div>
  {#if lay.picks}
    <div id="geoPicks" class="geo-picks">
      <span class="hint">{lay.picks.length} places match. Pick one:</span>
      {#each lay.picks as x}<button type="button" onclick={() => pick(x)}>{x.name} <span class="hint">{x.lat.toFixed(4)}, {x.lon.toFixed(4)}</span></button>{/each}
      <button type="button" class="hint" onclick={() => pick(null)}>Cancel</button>
    </div>
  {/if}
  <div class="map-body">
    <nav class="tool-rail" aria-label="Drawing tools">
      <span class="rail-head">Draw</span>
      {#each DRAW as [id, icon, label, tip, act, mode] (id)}
        <button id={'tool_' + id} class="rail-btn" class:on={mode && lay.placing === mode} title={tip} aria-pressed={mode ? lay.placing === mode : undefined} onclick={act}><Icon name={icon} /><span>{label}</span></button>
      {/each}
      <span class="rail-head">Plant</span>
      <div class="dd-wrap">
        <button id="tool_plant" class="rail-btn" class:on={plant || !!stationMode(lay.placing)} aria-expanded={plant} title="Stations, inverters and inverter blocks" onclick={() => (plant = !plant)}><Icon name="plant" /><span>Stations</span></button>
        {#if plant}
          <div class="dd rail-dd" role="menu">
            {#each STATION_KINDS as [k, t, , tip] (k)}
              <button id={'btnStation_' + k} class="dd-item" class:on={lay.placing === 'station:' + k} title={tip + '. Click the map to place it, click a marker to edit or remove it, drag it to move it.'} onclick={() => toggle('station:' + k)}>{t}</button>
            {/each}
            <hr>
            <button id="btnAutoPlace" class="dd-item" title="Place the inverters (string inverters) or PV stations (central inverters) the electrical design counts, each with a block of tables of about equal size. Replaces the pins of that kind." onclick={menu(autoPlace)}>Auto-place inverters</button>
            <button id="btnBlocks" class="dd-item" class:on={lay.showBlocks} onclick={() => showBlocks(!lay.showBlocks)}>Colour tables by block</button>
          </div>
        {/if}
      </div>
      <span class="rail-head">Tables</span>
      <button id="btnRemoveTables" class="rail-btn" class:on={lay.placing === 'remove'} aria-pressed={lay.placing === 'remove'} title="Click tables to take them out of the layout; click a dashed outline to put one back" onclick={() => toggle('remove')}><Icon name="remove" /><span>Take out</span></button>
      {#if lay.removed}<button id="btnRestoreTables" class="rail-btn small" title="Put back every table taken out by hand" onclick={restoreTables}><span>Put all back</span></button>{/if}
    </nav>
    <div class="map-wrap">
      <div id="map" bind:this={mapEl} class:placing hidden={lay.view !== 'leaflet'}></div>
      {#if lay.view === '3d'}<Layout3D />{/if}
      {#if lay.view === 'google'}<iframe id="gmap" title="Google Maps" sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src={lay.gmapSrc}></iframe>{/if}
      {#if lay.info}<div id="drawInfo" class="map-info">{lay.info}</div>{/if}
      {#if lay.bar}
        <div id="mapBar" class="map-bar">
          <span>{lay.bar.text}</span>
          {#each lay.bar.actions as [label, fn, cls]}<button type="button" class={cls || 'btn small'} onclick={fn}>{label}</button>{/each}
          {#if lay.bar.trace}
            <span class="hint">Roof height <input type="number" min="0" max="500" step="0.5" style="width:60px" bind:value={lay.traceBase}> m
              {#if lay.bar.trace.units}<label><input type="checkbox" bind:checked={lay.traceUnits}> openings as units 1.5 m above the roof</label>{/if}</span>
          {/if}
        </div>
      {/if}
    </div>
    <Inspector />
  </div>
  <div class="map-foot">
    <span id="cursorPos">{lay.cursor}</span>
    {#if lay.ortho}
      <span id="orthoInfo" class="ortho-info"><span>{lay.ortho.text}</span>
        <input type="range" min="0.2" max="1" step="0.1" title="Opacity" value={lay.opacity} oninput={(e) => setOpacity(+e.currentTarget.value)}>
        <button type="button" class="btn small ghost" onclick={dropImage}>Remove</button></span>
    {/if}
    <span class="spacer"></span>
    <a id="openGmaps" href={lay.gmaps} onclick={(e) => { e.preventDefault(); if (lay.gmaps) openExternal(lay.gmaps); }}>Open in Google Maps ↗</a>
  </div>
</div>
