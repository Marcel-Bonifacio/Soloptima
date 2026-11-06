<!-- The site map card of the Site & layout page: search, imagery, drawing and shade tools, tables, files, the map itself
     with its messages, and the cursor and own-image line under it. The map is lib/layout/map.svelte.js. -->
<script>
  import { onMount } from 'svelte';
  import { lay, init, goTo, pick, setView, pickBase, fullScreen } from '../../lib/layout/map.svelte.js';
  import { startDraw, clearAll, undo, redo, toggle, restoreTables } from '../../lib/layout/edit.svelte.js';
  import { loadOsm, loadImage, importFile, exportLayout, setOpacity, dropImage } from '../../lib/layout/tools.svelte.js';
  import { openExternal } from '../../lib/ipc.js';
  import { STATION_KINDS, stationMode } from '../../lib/layout/stations.js';

  let mapEl, query = $state(''), importAs = $state('site'), format = $state('geojson');
  onMount(() => init(mapEl));

  const BASES = [['esri', 'Satellite (Esri)'], ['hybrid', 'Hybrid (satellite with roads & labels)'], ['osm', 'Streets (OpenStreetMap)'],
    ['topo', 'Topographic (OpenTopoMap)'], ['google', 'Google satellite (API key)'], ['google_hybrid', 'Google hybrid (API key)'], ['google_road', 'Google roadmap (API key)']];
  const placing = $derived(['tree', 'trace', 'align', 'remove'].includes(lay.placing) || !!stationMode(lay.placing));

  function files(e, fn) { const f = Array.from(e.target.files); e.target.value = ''; if (f.length) fn(f); }
</script>

<div class="card map-card" class:full={lay.full} id="mapCard">
  <div class="map-toolbar">
    <input id="geoSearch" placeholder="Coordinates, Google Maps link or place name…" aria-label="Go to coordinates or place" bind:value={query}
      onkeydown={(e) => { if (e.key === 'Enter') goTo(query); }}>
    <button id="btnGeo" class="btn small primary" onclick={() => goTo(query)}>Go</button>
    <div class="seg" id="mapView">
      <button class:on={lay.view === 'leaflet'} onclick={() => setView('leaflet')}>Layout map</button>
      <button class:on={lay.view === 'google'} onclick={() => setView('google')}>Google Maps</button>
    </div>
    <select id="baseLayer" aria-label="Base map" value={lay.base} onchange={async (e) => { await pickBase(e.target.value); e.target.value = lay.base; }}>
      {#each BASES as [v, t]}<option value={v}>{t}</option>{/each}
    </select>
    <span class="spacer"></span>
    <button id="btnDrawSite" class="btn small" onclick={() => startDraw('site')}>▱ Draw PV area</button>
    <button id="btnDrawExcl" class="btn small warn" onclick={() => startDraw('exclusion')}>▱ Draw exclusion</button>
    <button id="btnDrawPath" class="btn small warn" title="Draw a road or walkway the tables keep off, then give its width" onclick={() => startDraw('path')}>⟋ Draw path</button>
    <button id="btnClearPoly" class="btn small ghost" onclick={clearAll}>Clear</button>
    <button id="btnUndo" class="btn small ghost" title="Undo the last change to the drawn items or removed tables (Ctrl+Z, Cmd+Z on a Mac)" disabled={!lay.canUndo} onclick={undo}>↶ Undo</button>
    <button id="btnRedo" class="btn small ghost" title="Redo (Ctrl+Shift+Z or Ctrl+Y)" disabled={!lay.canRedo} onclick={redo}>↷ Redo</button>
    <button id="btnFull" class="btn small ghost" title="Full screen map" onclick={() => fullScreen(!lay.full)}>⤢</button>
  </div>
  <div class="map-toolbar map-tools">
    <span class="hint">Shade:</span>
    <button id="btnBuilding" class="btn small" title="Draw the footprint of a building, then give its height" onclick={() => startDraw('building')}>▱ Building</button>
    <button id="btnTree" class="btn small" class:on={lay.placing === 'tree'} title="Click the map to place trees, then give height and crown" onclick={() => toggle('tree')}>● Tree</button>
    <button id="btnOsm" class="btn small ghost" title="Buildings of the map view from OpenStreetMap" disabled={lay.osmBusy} onclick={loadOsm}>OSM buildings</button>
    <label class="btn small ghost" title="Your own drone or survey image (PNG, JPEG or WebP) with its world file, and its .prj if you have one">Own image…<input type="file" id="fileImage" multiple accept=".png,.jpg,.jpeg,.webp,.pgw,.pngw,.jgw,.jpgw,.jpegw,.wpw,.wld,.tfw,.prj" hidden onchange={(e) => files(e, loadImage)}></label>
    <button id="btnTrace" class="btn small ghost" class:on={lay.placing === 'trace'} title="Click a roof on your own image to trace its outline" onclick={() => toggle('trace')}>Trace roof</button>
    <span class="tb-group"><span class="hint">Tables:</span>
      <button id="btnRemoveTables" class="btn small ghost" class:on={lay.placing === 'remove'} title="Click tables to take them out of the layout; click a dashed outline to put one back" onclick={() => toggle('remove')}>Remove tables</button>
      {#if lay.removed}<button id="btnRestoreTables" class="btn small ghost" title="Put back every table taken out by hand" onclick={restoreTables}>Restore all</button>{/if}</span>
    <span class="tb-group"><span class="hint">Plant:</span>
      {#each STATION_KINDS as [k, t, , tip] (k)}
        <button id={'btnStation_' + k} class="btn small ghost" class:on={lay.placing === 'station:' + k} title={tip + '. Click the map to place it, click a marker to edit or remove it, drag it to move it.'} onclick={() => toggle('station:' + k)}>{t}</button>
      {/each}</span>
    <span class="spacer"></span>
    <label class="btn small ghost">Import…<input type="file" id="fileGeo" accept=".kml,.kmz,.geojson,.json" hidden onchange={(e) => files(e, (f) => importFile(f[0], importAs))}></label>
    <select id="importAs" aria-label="Import shapes as" bind:value={importAs}><option value="site">shapes as PV areas</option><option value="exclusion">shapes as exclusions</option><option value="building">shapes as buildings</option></select>
    <select id="exportFormat" aria-label="Export format" bind:value={format}><option value="geojson">GeoJSON</option><option value="kml">KML</option></select>
    <button id="btnExportGeo" class="btn small ghost" onclick={() => exportLayout(format)}>Export</button>
  </div>
  {#if lay.picks}
    <div id="geoPicks" class="geo-picks">
      <span class="hint">{lay.picks.length} places match. Pick one:</span>
      {#each lay.picks as x}<button type="button" onclick={() => pick(x)}>{x.name} <span class="hint">{x.lat.toFixed(4)}, {x.lon.toFixed(4)}</span></button>{/each}
      <button type="button" class="hint" onclick={() => pick(null)}>Cancel</button>
    </div>
  {/if}
  <div class="map-wrap">
    <div id="map" bind:this={mapEl} class:placing hidden={lay.view !== 'leaflet'}></div>
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
  <div class="map-foot">
    <span id="cursorPos">{lay.cursor}</span>
    {#if lay.ortho}
      <span id="orthoInfo" class="ortho-info"><span>{lay.ortho.text}</span>
        <input type="range" min="0.2" max="1" step="0.1" title="Opacity" value={lay.opacity} oninput={(e) => setOpacity(+e.target.value)}>
        <button type="button" class="btn small ghost" onclick={dropImage}>Remove</button></span>
    {/if}
    <span class="spacer"></span>
    <a id="openGmaps" href={lay.gmaps} onclick={(e) => { e.preventDefault(); if (lay.gmaps) openExternal(lay.gmaps); }}>Open in Google Maps ↗</a>
  </div>
</div>
