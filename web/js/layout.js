// Site map and PV layout: go to coordinates, switch imagery (Esri / OSM / topo / Google), draw the PV areas, exclusion zones
// and the buildings and trees that shade them, and fill the areas with module tables, again after every edit while
// auto-update is on. Areas, objects and tables also come from KML, KMZ and GeoJSON files, OpenStreetMap and the imagery
// (roof tracing), and go out as GeoJSON or KML.
'use strict';

const Layout = (() => {
  let map, marker, P, onChange, drawType = 'site', tablesLayer, polyLayers = [], baseLayers = {}, current = [];
  let relayoutTimer = null, view = 'leaflet', ghostLayer, history = [], future = [], restoring = false;
  let placing = null, moving = null, clickTimer = null, tracing = false, emptyAreas = 0, preview = null, shade = null, showShade = true;
  let ortho = null;   // the user's own image: { im (Ortho.load), layer, src (Ortho.source) }
  let mapClick = () => {};   // what a click on the map does; a click on a drawn item passes to it in the placing modes
  const canvas = L.canvas({ padding: 0.5 });
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

  function init(project, changed) {
    P = project; onChange = changed;
    map = L.map('map', { zoomControl: true, maxZoom: 21 }).setView([P.location.lat, P.location.lon], 15);
    const tile = (url, o) => L.tileLayer(url, { maxZoom: 21, maxNativeZoom: 19, ...o });
    const esriImg = () => tile(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community' });
    baseLayers.esri = [esriImg()];
    baseLayers.hybrid = [esriImg(), tile(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'),
      tile(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}')];
    baseLayers.osm = [tile('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' })];
    baseLayers.topo = [tile('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxNativeZoom: 17, attribution: '© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)' })];
    $('#baseLayer').value = P.layout.base || 'esri';   // imagery loads when a project opens (reload), after sign-in
    tablesLayer = L.layerGroup().addTo(map);
    ghostLayer = L.layerGroup().addTo(map);   // outlines of the tables taken out by hand, shown while removing tables
    L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);

    marker = L.marker([P.location.lat, P.location.lon], { draggable: true, title: 'Site location' }).addTo(map);
    marker.on('dragend', () => setLocation(marker.getLatLng().lat, marker.getLatLng().lng, { fly: false }));
    mapClick = (e) => {
      if (pmBusy()) return;
      if (moving) setPlacing(null);
      else if (placing === 'tree') addTree(e.latlng);
      else if (placing === 'trace') traceAt(e.latlng);
      else if (placing === 'align') alignAt(e.latlng);
      else if (placing === 'remove') toggleTableAt(e.latlng);
      else setLocation(e.latlng.lat, e.latlng.lng);
    };
    map.on('click', mapClick);
    // Ctrl+click (Cmd+click on a Mac, where Ctrl+click arrives as a context-menu event) lays out the roof under the pointer,
    // on whatever layer it lands: caught on the way down, before the layers see it.
    const roofClick = (e) => {
      if (!(e.ctrlKey || e.metaKey) || pmBusy() || e.target.closest('.leaflet-control, .leaflet-popup')) return;
      e.preventDefault();
      e.stopPropagation();
      roofLayout(map.mouseEventToLatLng(e));
    };
    map.getContainer().addEventListener('click', roofClick, true);
    map.getContainer().addEventListener('contextmenu', roofClick, true);
    map.on('mousemove', (e) => { $('#cursorPos').textContent = `Cursor ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}  ·  ${toDMS(e.latlng.lat, e.latlng.lng)}  ·  zoom ${map.getZoom()}`; });

    map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false,
                         drawText: false, drawPolygon: false, drawRectangle: false, cutPolygon: false, rotateMode: true });
    map.pm.setGlobalOptions({ snappable: true, allowSelfIntersection: false });
    map.on('pm:create', (e) => {
      if (e.shape === 'Line') {   // a path becomes a strip of its width, under its own editor
        const path = e.layer.getLatLngs().map((p) => [+p.lat.toFixed(7), +p.lng.toFixed(7)]);
        map.removeLayer(e.layer);
        $('#drawInfo').hidden = true;
        if (path.length < 2) return;
        const l = addPoly(L.polygon(stripOf(path, 4)).addTo(map), 'exclusion', { kind: 'path', path, width: 4 });
        savePolys();
        editor(l, l.getBounds().getCenter());
        return;
      }
      const building = drawType === 'building';
      const l = addPoly(e.layer, building ? 'obstacle' : drawType, building ? { kind: 'building', height: 6 } : {});
      $('#drawInfo').hidden = true;
      savePolys();
      if (building) editor(l, l.getBounds().getCenter());
    });
    map.on('pm:remove', (e) => forget(e.layer));
    map.on('pm:drawstart', ({ workingLayer }) => {
      const line = drawType === 'path';
      $('#drawInfo').hidden = false;
      $('#drawInfo').textContent = line ? 'Click to add points along the path · double-click or click the last point to finish' : 'Click to add corners · double-click or click the first point to finish';
      workingLayer.on('pm:vertexadded', () => {
        const pts = workingLayer.getLatLngs().map((p) => [p.lat, p.lng]);
        if (line && pts.length >= 2) $('#drawInfo').textContent = `${pts.length} points · ${fmtNum(pathLength(pts))} m so far`;
        else if (!line && pts.length >= 3) $('#drawInfo').textContent = `${pts.length} corners · ${fmtNum(areaLatLng(pts) / 1e4, 2)} ha so far`;
      });
    });
    map.on('pm:drawend', () => setTimeout(() => ($('#drawInfo').hidden = true), 300));

    $('#btnDrawSite').onclick = () => startDraw('site');
    $('#btnDrawExcl').onclick = () => startDraw('exclusion');
    $('#btnDrawPath').onclick = () => startDraw('path');
    $('#btnRemoveTables').onclick = () => setPlacing(placing === 'remove' ? null : 'remove');
    $('#btnRestoreTables').onclick = () => { setPlacing(null); P.layout.removed = []; remember(); onChange('layout.removed'); if (hasSites()) run(); updateUndo(); };
    $('#btnUndo').onclick = undo;
    $('#btnRedo').onclick = redo;
    document.addEventListener('keydown', (e) => {   // Ctrl+Z / Cmd+Z undoes, with Shift (or Ctrl+Y) redoes, while the map is showing
      const k = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || e.altKey || (k !== 'z' && k !== 'y') || !map.getContainer().offsetParent) return;
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
    });
    $('#btnBuilding').onclick = () => startDraw('building');
    $('#btnTree').onclick = () => setPlacing(placing === 'tree' ? null : 'tree');
    $('#btnTrace').onclick = () => setPlacing(placing === 'trace' ? null : 'trace');
    $('#fileImage').onchange = (e) => { const f = Array.from(e.target.files); e.target.value = ''; if (f.length) loadImage(f); };
    map.createPane('ortho').style.zIndex = 250;   // own imagery above the base map, under the drawn items
    $('#btnOsm').onclick = loadOsm;
    $('#fileGeo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
    $('#btnExportGeo').onclick = () => exportLayout($('#exportFormat').value);
    $('#btnClearPoly').onclick = () => {
      if (polyLayers.length && !confirm('Remove all drawn areas, buildings, trees and the layout?')) return;
      polyLayers.forEach((l) => map.removeLayer(l)); polyLayers = []; tablesLayer.clearLayers(); P.layout.result = null; shade = null; savePolys(); renderStats(); sunPath();
    };
    $('#btnLayout').onclick = run;
    $('#btnShadeFree').onclick = shadeFreeGcr;
    $('#baseLayer').onchange = (e) => { P.layout.base = e.target.value; setBase(e.target.value); onChange('layout.base'); };
    $('#btnGeo').onclick = goTo;
    $('#geoSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') goTo(); });
    $('#siteInfo').addEventListener('click', (e) => {   // "Use" / "Keep" offset buttons of the time zone line
      const b = e.target.closest('[data-tz]'), L = P.location;
      if (!b) return;
      const { z } = zoneCheck(L);
      if (b.dataset.tz === 'use' && z) { L.utc_offset = z.std; L.utc_offset_src = 'zone'; syncForms(P); onChange('location'); }
      if (b.dataset.tz === 'keep') { L.utc_offset_src = 'typed'; onChange('location.utc_offset_src'); }
      siteInfo();
    });
    $('#btnFull').onclick = () => fullScreen(!$('#mapCard').classList.contains('full'));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { fullScreen(false); setPlacing(null); } });
    window.addEventListener('hashchange', () => fullScreen(false));
    $$('#mapView button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
    restore(false);   // the address lookup waits until a project opens (reload), after sign-in
    updateExternal();
  }

  // Full-screen map. The page under it is made inert, so keyboard focus cannot reach controls hidden under the map.
  function fullScreen(on) {
    const c = $('#mapCard');
    if (c.classList.contains('full') === on) return;
    c.classList.toggle('full', on);
    $$('.skip, .topbar, #nav, #tab-site > :not(.map-grid), #mapCard ~ *').forEach((el) => (el.inert = on));
    setTimeout(() => map && map.invalidateSize(), 50);
  }

  // ---------------------------------------------------------------- imagery
  async function setBase(name) {
    if (name.startsWith('google')) {
      const key = (P.layout.google_key || '').trim();
      if (!key) {
        toast('Google imagery inside the layout map needs a Google Maps API key (Map Tiles API). Without a key use the "Google Maps" view tab.', true);
        $('#baseLayer').value = 'esri'; name = 'esri';
      } else {
        try {
          const req = { google: { mapType: 'satellite' }, google_hybrid: { mapType: 'satellite', layerTypes: ['layerRoadmap'] }, google_road: { mapType: 'roadmap' } }[name];
          const r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(key), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req, language: 'en-US', region: 'US' }) });
          const j = await r.json();
          if (!j.session) throw new Error(j.error ? j.error.message : 'no session');
          baseLayers[name] = [L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${j.session}&key=${encodeURIComponent(key)}`,
            { maxZoom: 22, maxNativeZoom: 21, attribution: 'Map data © Google' })];
        } catch (e) { toast('Google Map Tiles: ' + e.message, true); $('#baseLayer').value = 'esri'; name = 'esri'; }
      }
    }
    current.forEach((l) => map.removeLayer(l));
    current = baseLayers[name];
    current.forEach((l) => l.addTo(map));
  }

  function setView(v) {
    view = v;
    $$('#mapView button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#map').hidden = v !== 'leaflet';
    $('#gmap').hidden = v !== 'google';
    if (v === 'google') updateExternal(true); else setTimeout(() => map.invalidateSize(), 30);
  }
  // Google Maps embed (no key needed) + external link, kept in sync with the site location.
  function updateExternal(force) {
    const { lat, lon } = P.location;
    $('#openGmaps').href = `https://www.google.com/maps/@${lat},${lon},700m/data=!3m1!1e3`;
    if (view === 'google' || force) {
      const z = map ? Math.min(20, map.getZoom()) : 17;
      const src = `https://www.google.com/maps/embed?origin=mfe&pb=!1m4!2m1!1s${lat},${lon}!5e1!6i${z}`;
      if ($('#gmap').src !== src) $('#gmap').src = src;
    }
  }

  // ---------------------------------------------------------------- location
  function parseCoords(q) {
    q = q.trim();
    let m = q.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
    if (m) return [+m[1], +m[2]];
    m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return [+m[1], +m[2]];
    // DMS, e.g. 2°30'15"S 115°30'E  or  2 30 15 S, 115 30 0 E
    const dms = [...q.matchAll(/(\d+(?:\.\d+)?)\s*[°d\s]\s*(?:(\d+(?:\.\d+)?)\s*['′m\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?([NSEW])/gi)];
    if (dms.length === 2) {
      const val = (g) => { let v = +g[1] + (+g[2] || 0) / 60 + (+g[3] || 0) / 3600; if (/[SW]/i.test(g[4])) v = -v; return { v, ns: /[NS]/i.test(g[4]) }; };
      const a = val(dms[0]), b = val(dms[1]);
      return a.ns ? [a.v, b.v] : [b.v, a.v];
    }
    return null;
  }
  async function goTo() {
    const q = $('#geoSearch').value;
    showPicks(null);
    if (!q.trim()) return;
    const c = parseCoords(q);
    if (c) {
      if (Math.abs(c[0]) > 90 || Math.abs(c[1]) > 180) { toast('Coordinates out of range (latitude ±90, longitude ±180).', true); return; }
      setLocation(c[0], c[1], { fly: true }); return;
    }
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q));
      const j = (await r.json()).map((x) => ({ lat: +x.lat, lon: +x.lon, name: String(x.display_name || '') })).filter((x) => isFinite(x.lat) && isFinite(x.lon));
      if (!j.length) { toast('Place not found. Try "lat, lon" or paste a Google Maps link.', true); return; }
      // places of the same name far apart: let the user pick one rather than take the first
      if (j.some((x) => km(x, j[0]) > 1)) showPicks(j); else setLocation(j[0].lat, j[0].lon, { fly: true, zoom: 14 });
    } catch (e) { toast('Search failed: ' + e.message, true); }
  }
  const km = (a, b) => {
    const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  function showPicks(list) {
    const box = $('#geoPicks');
    box.hidden = !list;
    if ($('#mapCard').classList.contains('full')) setTimeout(() => map.invalidateSize(), 0);   // the list changes the map height
    if (!list) { box.innerHTML = ''; return; }
    box.innerHTML = `<span class="hint">${list.length} places match. Pick one:</span>` +
      list.map((x, i) => `<button type="button" data-pick="${i}">${escapeHtml(x.name)} <span class="hint">${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}</span></button>`).join('') +
      '<button type="button" data-pick="-1" class="hint">Cancel</button>';
    $$('[data-pick]', box).forEach((b) => (b.onclick = () => { const x = list[+b.dataset.pick]; showPicks(null); if (x) setLocation(x.lat, x.lon, { fly: true, zoom: 14 }); }));
  }
  // Time zone of the site from the offline lookup: its standard offset becomes the UTC offset. A typed offset is kept while
  // the site stays in the same zone; without a zone the offset falls back to the longitude.
  function applyZone() {
    const L = P.location, z = siteZone(L.lat, L.lon), same = (z ? z.tz : '') === L.tz;
    L.tz = z ? z.tz : '';
    if (L.utc_offset_src === 'typed' && same) return;
    if (z) {
      if (L.utc_offset_src === 'typed' && Math.abs(L.utc_offset - z.std) > 1e-9) toast(`The site is now in ${z.tz}: UTC offset set to ${fmtOffset(z.std)} instead of the typed ${fmtOffset(L.utc_offset)}.`);
      L.utc_offset = z.std; L.utc_offset_src = 'zone';
    } else {
      L.utc_offset = Math.round(L.lon / 15); L.utc_offset_src = 'longitude';
      toast(`No time zone found for this location: UTC offset set to ${fmtOffset(L.utc_offset)} from the longitude. Check it.`, true);
    }
  }
  function setLocation(lat, lon, opts = {}) {
    const lon180 = Math.abs(lon) > 180 ? ((+lon + 180) % 360 + 360) % 360 - 180 : +lon;   // the map repeats round the globe
    P.location.lat = +(+lat).toFixed(6); P.location.lon = +lon180.toFixed(6);
    applyZone();
    marker.setLatLng([lat, lon]);
    if (opts.fly) map.flyTo([lat, lon], opts.zoom || 17, { duration: 1.2 });
    syncForms(P); onChange('location');
    updateExternal(); siteInfo();
  }
  // Called when lat/lon are typed into the form.
  function moveMarker() {
    applyZone(); syncForms(P);
    marker.setLatLng([P.location.lat, P.location.lon]);
    map.flyTo([P.location.lat, P.location.lon], Math.max(map.getZoom(), 16), { duration: 1.0 });
    updateExternal(); siteInfo();
  }
  // Time zone line of the site info: the offset in use, where it comes from and what to check.
  function zoneHtml() {
    const L = P.location, { z, differs, warn } = zoneCheck(L), off = fmtOffset(L.utc_offset), typed = L.utc_offset_src === 'typed';
    const line = !z ? (typed ? `${off} typed; no time zone found for this location` : `${off} from longitude: no time zone found, check it`)
      : !differs ? `${off} (${z.tz}, standard time)`
        : typed ? `${off} typed; the site's time zone ${z.tz} is ${fmtOffset(z.std)}`
          : `${off} as saved; the site's time zone ${z.tz} is ${fmtOffset(z.std)}, check it`;
    let h = warn ? `<span class="warn-text">${escapeHtml(line)}</span>` : escapeHtml(line);
    if (differs) h += ` <button type="button" class="btn small" data-tz="use">Use ${fmtOffset(z.std)}</button>` + (typed ? '' : ` <button type="button" class="btn small ghost" data-tz="keep">Keep ${off}</button>`);
    const offs = z ? z.all.map(fmtOffset) : [];
    if (z && z.irregular) h += `<br><span class="warn-text">${escapeHtml(z.tz)} has ${offs.length} different offsets this year (${offs.join(', ')}): check the offset.</span>`;
    else if (z && z.dst) h += `<br><span class="hint">${escapeHtml(z.tz)} observes daylight saving (${offs.join(' and ')}). Soloptima works in local standard time, the lower offset. Import clock-time logger data with the time basis Local clock time with daylight saving.</span>`;
    return h;
  }
  let infoTimer, place = null;   // last address found by the reverse lookup: { lat, lon, name }
  function siteInfo() {
    const { lat, lon } = P.location;
    const known = !!place && place.lat === lat && place.lon === lon;
    infoHtml(known ? place.name : null);
    if (known) return;
    clearTimeout(infoTimer);
    infoTimer = setTimeout(async () => {
      let name = '';
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${lat}&lon=${lon}`);
        const j = await r.json();
        name = String(j.display_name || '');
        place = { lat, lon, name };
        marker.bindPopup(`<b>Site</b><br>${lat.toFixed(5)}, ${lon.toFixed(5)}<br>${escapeHtml(name)}`);
      } catch (e) { /* offline: no address */ }
      if (P.location.lat === lat && P.location.lon === lon) infoHtml(name);
    }, 700);
  }
  // addr: the address, '' for none, null while it is being looked up
  function infoHtml(addr) {
    const { lat, lon } = P.location;
    $('#siteInfo').innerHTML = `<b>${toDMS(lat, lon)}</b><br>${zoneHtml()}` +
      (weatherAtSite()
        ? `<br>Elevation ${fmtNum(P.weather.elevation)} m (from ${escapeHtml(P.weather.source)})` : '<br><span class="hint">Solar data not yet fetched for this location (tab 2).</span>') +
      (addr == null ? '<br><span class="hint">Looking up address…</span>' : addr ? `<br>${escapeHtml(addr)}` : '');
  }
  // Rounded to 0.1″ before the split, so 106.85 prints 106°51′00.0″. Also used by the report.
  function toDMS(lat, lon) {
    const f =(v, pos, neg) => { const t = Math.round(Math.abs(v) * 36000), d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`; };
    return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
  }

  // ---------------------------------------------------------------- polygons and objects
  // Drawn items: PV areas, exclusion zones and the objects that shade the tables (a building: footprint and height; a tree:
  // crown diameter and height, drawn as a circle). Each layer keeps its type in _ptype and its other saved fields in _props.
  const STYLE = {
    site: { color: '#eda100', weight: 2, fillOpacity: 0.06 },
    exclusion: { color: '#e34948', weight: 2, fillOpacity: 0.25, dashArray: '6 4' },
    building: { color: '#5d4a3a', weight: 1.5, fillColor: '#8a7560', fillOpacity: 0.55 },
    tree: { color: '#0f3d12', weight: 1.5, fillColor: '#5fbf4a', fillOpacity: 0.6 },
    preview: { color: '#0b84d8', weight: 2, fillOpacity: 0.15, dashArray: '5 4' },
    osm: { color: '#6b6b6b', weight: 1, fillOpacity: 0.08, dashArray: '3 3' },
  };
  const OSM_ATTR = 'Buildings © OpenStreetMap contributors (ODbL)';
  const kindOf = (l) => (l._ptype === 'obstacle' ? l._props.kind : l._ptype);
  const pmBusy = () => map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled() || map.pm.globalDragModeEnabled() || map.pm.globalRemovalModeEnabled() || map.pm.globalRotateModeEnabled();
  const projectAz = () => (P.pv.azimuth_auto ? (P.location.lat >= 0 ? 180 : 0) : P.pv.azimuth);
  const hasObjects = () => (P.layout.polygons || []).some((g) => g.type === 'obstacle');
  // Orientation of a PV area's tables: its own tilt and azimuth (or east-west pairs) on fixed mounts, else the project's.
  function orientationOf(g) {
    const own = P.pv.mount !== 'tracker' && (g.tilt != null || g.azimuth != null || !!g.east_west || !!g.canopy);
    return { own, ew: own && !!g.east_west, canopy: own && !!g.canopy && !g.east_west, tilt: own && g.tilt != null ? g.tilt : P.pv.tilt || 0, azimuth: own && g.azimuth != null ? g.azimuth : projectAz() };
  }
  // Whether the engine uses the layout: for the shade of its objects or for areas with their own orientation (as layout_used).
  function layoutUsed() {
    const g = P.layout.polygons || [];
    return (P.pv.near_shading !== false && g.some((x) => x.type === 'obstacle')) || g.some((x) => x.type === 'site' && orientationOf(x).own);
  }
  // Ranges of the fields of layout items, for the editor, saved projects and imported files.
  const LIMITS = { height: [0.1, 1000], treeHeight: [0.1, 100], crown: [0.5, 60], base: [0, 500], tilt: [0, 90], azimuth: [0, 360], clearance: [0, 100], width: [0.5, 100], shift: [0, 200] };
  const num = (v) => (v != null && v !== '' && Number.isFinite(+v) ? +v : null);
  const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  // A layout item as P.layout.polygons keeps it, from a project file or an imported shape: numbers from text (KML), sizes
  // brought into range, angles out of range dropped; null when it cannot be used.
  function cleanItem(g) {
    if (!g || !['site', 'exclusion', 'obstacle'].includes(g.type)) return null;
    const fin = (q) => Array.isArray(q) && q.length === 2 && num(q[0]) != null && num(q[1]) != null;
    const q = { type: g.type };
    if (g.type === 'exclusion' && g.kind === 'path') {   // a keepout line: the strip is made from the centre line and the width
      if (!(Array.isArray(g.path) && g.path.length >= 2 && g.path.length <= 500 && g.path.every(fin))) return null;
      const path = g.path.map(([a, b]) => [+a, +b]), width = num(g.width) > 0 ? clampTo(num(g.width), LIMITS.width) : 4;
      Object.assign(q, { kind: 'path', path, width, latlngs: stripOf(path, width) });
      if (num(g.clearance) > 0) q.clearance = clampTo(num(g.clearance), LIMITS.clearance);
      return q;
    }
    if (g.type === 'obstacle' && g.kind === 'tree') {
      if (!fin(g.center) || !(num(g.diameter) > 0)) return null;
      Object.assign(q, { kind: 'tree', center: g.center.map(Number), diameter: clampTo(num(g.diameter), LIMITS.crown),
                         height: num(g.height) > 0 ? clampTo(num(g.height), LIMITS.treeHeight) : 8 });
    } else {
      if (!(Array.isArray(g.latlngs) && g.latlngs.length >= 3 && g.latlngs.length <= 5000 && g.latlngs.every(fin))) return null;
      q.latlngs = g.latlngs.map(([a, b]) => [+a, +b]);
      if (g.type === 'obstacle') Object.assign(q, { kind: 'building', height: num(g.height) > 0 ? clampTo(num(g.height), LIMITS.height) : 6 });
    }
    if (g.type === 'site') {
      const base = num(g.base), tilt = num(g.tilt), az = num(g.azimuth);
      if (base > 0) q.base = clampTo(base, LIMITS.base);
      if (tilt != null && tilt >= 0 && tilt <= 90) q.tilt = tilt;
      if (az != null && az >= 0 && az <= 360) q.azimuth = az;
      if (g.east_west === true || g.east_west === 'true') q.east_west = true;
      else if (g.canopy === true || g.canopy === 'true') q.canopy = true;   // one plane of tables, no row spacing (not with east-west pairs)
      for (const k of ['shift_u', 'shift_v']) if (num(g[k]) != null && num(g[k]) >= 0) q[k] = clampTo(num(g[k]), LIMITS.shift);   // grid shift of the tables
    } else if (num(g.clearance) > 0) q.clearance = clampTo(num(g.clearance), LIMITS.clearance);   // distance tables keep from the item
    if (['osm', 'traced', 'import'].includes(g.source)) q.source = g.source;
    return q;
  }
  const hint = (text) => Object.assign(document.createElement('p'), { className: 'hint', textContent: text });
  const button = (text, onclick, cls = 'btn small') => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, onclick });
  const count = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

  function startDraw(type) {
    if (view !== 'leaflet') setView('leaflet');
    setPlacing(null);
    drawType = type;
    const s = STYLE[type === 'path' ? 'exclusion' : type];
    map.pm.enableDraw(type === 'path' ? 'Line' : 'Polygon', { templineStyle: { color: s.color }, hintlineStyle: { color: s.color, dashArray: [5, 5] }, pathOptions: s });
  }
  function addPoly(layer, type, props = {}) {
    layer._ptype = type;
    layer._props = props;
    if (props.kind === 'path') layer._pts = latlngsOf(layer);   // where its strip stood at the last save, to follow a drag
    layer.options.bubblingMouseEvents = false;   // a click on an item edits it rather than moving the site
    layer.setStyle(STYLE[kindOf(layer)]);
    layer.on('pm:edit', () => changed(layer));
    layer.on('pm:markerdrag', () => label(layer));
    // a click opens the editor once it is clear it is not the first of a double-click, which starts moving the item
    layer.on('click', (e) => {
      clearTimeout(clickTimer);
      if (placing && placing !== 'move' && placing !== 'drag') mapClick(e);   // placing a tree, tracing, aligning or removing tables works over items too
      else if (!pmBusy() && !placing) clickTimer = setTimeout(() => editor(layer, e.latlng), 250);
    });
    layer.on('dblclick', (e) => {
      clearTimeout(clickTimer);
      L.DomEvent.stop(e);   // no zoom
      if (!pmBusy() && (!placing || moving)) setPlacing('move', layer);
    });
    polyLayers.push(layer);
    label(layer);
    return layer;
  }
  function changed(layer) { followPath(layer); label(layer); savePolys(); }
  // A keepout line moves with its strip when the strip is dragged. Any other change to the strip (rotated, a corner moved)
  // makes it an ordinary exclusion zone with its current outline.
  function followPath(layer) {
    const q = layer._props;
    if (layer._ptype !== 'exclusion' || q.kind !== 'path') return;
    const now = latlngsOf(layer), was = layer._pts || now, d = [now[0][0] - was[0][0], now[0][1] - was[0][1]];
    if (now.length === was.length && now.every((p, i) => Math.abs(p[0] - was[i][0] - d[0]) < 1e-9 && Math.abs(p[1] - was[i][1] - d[1]) < 1e-9))
      q.path = q.path.map(([a, b]) => [+(a + d[0]).toFixed(7), +(b + d[1]).toFixed(7)]);
    else { delete q.kind; delete q.path; delete q.width; }
    layer._pts = now;
  }
  const pathLength = (pts) => { const pr = localProjector(pts), m = pts.map(pr.fwd); return m.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - m[i][0], p[1] - m[i][1]), 0); };
  function forget(layer) {
    if (moving === layer) setPlacing(null);
    polyLayers = polyLayers.filter((l) => l !== layer);
    if (!polyLayers.some((l) => l._ptype === 'site')) { tablesLayer.clearLayers(); P.layout.result = null; renderStats(); }
    savePolys();
  }
  const latlngsOf = (layer) => layer.getLatLngs()[0].map((p) => [p.lat, p.lng]);
  function label(layer) {
    const k = kindOf(layer), q = layer._props;
    let txt;
    if (k === 'tree') txt = `Tree · ${fmtNum(q.height, 1)} m high · crown ${fmtNum(2 * layer.getRadius(), 1)} m`;
    else if (k === 'building') {
      const pts = latlngsOf(layer), r = rectOf(pts);
      txt = `Building · ${fmtNum(q.height, 1)} m high · ` + (r ? `${fmtNum(r.length, 1)} × ${fmtNum(r.width, 1)} m` : `${fmtNum(areaLatLng(pts))} m²`);
    } else if (q.kind === 'path') {
      txt = `Path · ${fmtNum(q.width, 1)} m wide · ${fmtNum(pathLength(q.path))} m long`;
    } else {
      txt = `${k === 'site' ? 'PV area' : 'Exclusion'} · ${fmtArea(areaLatLng(latlngsOf(layer)))}`;
      const o = orientationOf(q);
      if (k === 'site' && o.own) txt += ` · ${o.canopy ? 'canopy ' : o.ew ? 'east-west ' : ''}${fmtNum(o.tilt)}° / ${fmtNum(o.azimuth)}°`;
      if (k === 'site' && q.base) txt += ` · ${fmtNum(q.base, 1)} m up`;
    }
    if (q.clearance) txt += ` · ${fmtNum(q.clearance, 1)} m clear`;
    const permanent = k === 'site' || k === 'exclusion';
    if (layer.getTooltip()) layer.setTooltipContent(txt);
    else layer.bindTooltip(txt, permanent ? { permanent: true, direction: 'center', className: 'poly-label' } : { sticky: true, className: 'poly-label' });
  }
  function polyOf(l) {
    const q = { type: l._ptype, ...l._props };
    if (l instanceof L.Circle) {
      const c = l.getLatLng();
      q.center = [+c.lat.toFixed(7), +c.lng.toFixed(7)];
      q.diameter = +(2 * l.getRadius()).toFixed(2);
    } else q.latlngs = latlngsOf(l);
    return q;
  }
  function savePolys() {
    P.layout.polygons = polyLayers.map(polyOf);
    remember();
    onChange('layout.polygons');
    scheduleRelayout();
  }
  function scheduleRelayout() {
    if (!$('#autoLayout').checked) return;
    if (!(P.layout.polygons || []).some((p) => p.type === 'site')) return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(run, 350);
  }
  // Adds a saved item (cleanItem) to the map.
  function addItem(g) {
    const { type, latlngs, center, diameter, ...props } = g;
    return addPoly((center ? L.circle(center, { radius: diameter / 2 }) : L.polygon(latlngs)).addTo(map), type, props);
  }
  function restore(lookup = true) {
    (P.layout.polygons || []).forEach(addItem);
    history = [snapshot()]; future = [];
    updateUndo();
    if (polyLayers.length) map.fitBounds(L.featureGroup(polyLayers).getBounds(), { padding: [30, 30] });
    if (P.layout.result && P.layout.result.tables && P.layout.result.tables.length) draw(P.layout.result.tables);
    else if (polyLayers.some((l) => l._ptype === 'site')) setTimeout(run, 100);
    renderStats();
    sunPath();
    if (lookup) siteInfo();
  }
  function reload(project) {
    P = project;
    polyLayers.forEach((l) => map.removeLayer(l)); polyLayers = []; tablesLayer.clearLayers();
    clearPreview(); setPlacing(null); shade = null; emptyAreas = 0; dropImage();
    marker.setLatLng([P.location.lat, P.location.lon]);
    map.setView([P.location.lat, P.location.lon], 15);
    const base = P.layout.base || 'esri';
    $('#baseLayer').value = base; setBase(base);
    restore(); updateExternal();
  }

  // Clicking places a tree or traces a roof until the button is pressed again or Esc.
  // Moving a placed item, with the item: 'move' drags its corners (a tree's centre and crown), 'drag' the whole shape. Each
  // change is saved as it is made (pm:edit); a click on the map, Esc or any other mode ends it.
  let aligning = null;   // the PV area whose tables are being aligned to a click
  function setPlacing(mode, layer) {
    if (moving) { moving.pm.disable(); moving.pm.disableLayerDrag(); moving = null; }
    placing = mode;
    aligning = mode === 'align' ? layer : null;
    if (mode === 'move' || mode === 'drag') {
      map.closePopup();
      moving = layer;
      if (mode === 'move') layer.pm.enable({ allowSelfIntersection: false, snappable: true, draggable: false });
      else layer.pm.enableLayerDrag();
    }
    $('#map').classList.toggle('placing', mode === 'tree' || mode === 'trace' || mode === 'align' || mode === 'remove');
    $('#btnRemoveTables').classList.toggle('on', mode === 'remove');
    drawGhosts();
    $('#btnTree').classList.toggle('on', mode === 'tree');
    $('#btnTrace').classList.toggle('on', mode === 'trace');
    info({ tree: 'Click the map to place a tree · Esc to stop', trace: 'Click a roof to trace its outline · Esc to stop',
           align: 'Click where a table corner should sit · Esc to cancel',
           remove: 'Click a table to take it out, a dashed outline to put it back · Esc to stop',
           move: 'Drag the corners · click the map or Esc to finish', drag: 'Drag the shape · click the map or Esc to finish' }[mode]);
  }
  // The line over the map that says what a click does; hidden without a message.
  function info(msg) {
    $('#drawInfo').hidden = !msg;
    if (msg) $('#drawInfo').textContent = msg;
  }
  function addTree(ll) {
    const l = addPoly(L.circle(ll, { radius: 3 }).addTo(map), 'obstacle', { kind: 'tree', height: 8 });
    savePolys();
    editor(l, ll);
  }

  // ---------------------------------------------------------------- editing
  // Popup editor of a drawn item: height and size of a building or tree; surface height and orientation of a PV area.
  function editor(layer, at) {
    const k = kindOf(layer), q = layer._props, box = document.createElement('div');
    box.className = 'edit-pop';
    const path = q.kind === 'path';
    box.append(Object.assign(document.createElement('b'), { textContent: path ? 'Path keepout' : { site: 'PV area', exclusion: 'Exclusion zone', building: 'Building', tree: 'Tree' }[k] }));
    // A number checked against [min, max]; blank (null) only where `blank` names what blank means
    const field = (parent, text, unit, value, min, max, apply, blank) => {
      const row = document.createElement('label');
      const inp = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: value == null ? '' : +(+value).toFixed(2) });
      if (blank) inp.placeholder = blank;
      row.append(Object.assign(document.createElement('span'), { textContent: text }), inp, unit);
      inp.onchange = () => {
        const v = inp.value.trim() === '' ? null : +inp.value;
        if (v == null ? !blank : !(v >= min && v <= max)) {
          toast(`${text}: ${min} to ${max} ${unit}.`, true);
          inp.value = value == null ? '' : +(+value).toFixed(2);
          return;
        }
        value = v;
        apply(v);
        changed(layer);
      };
      parent.append(row);
    };
    if (k === 'building') {
      field(box, 'Height above ground', 'm', q.height, ...LIMITS.height, (v) => (q.height = v));
      const r = rectOf(latlngsOf(layer));
      if (r) {
        const set = (field) => (v) => { const cur = rectOf(latlngsOf(layer)) || r; cur[field] = v; layer.setLatLngs(rectCorners(latlngsOf(layer), cur)); };
        field(box, 'Length', 'm', r.length, 0.5, 2000, set('length'));
        field(box, 'Width', 'm', r.width, 0.5, 2000, set('width'));
        field(box, 'Rotation from north', '°', r.rotation, 0, 180, set('rotation'));
      } else box.append(hint(`Footprint ${fmtNum(areaLatLng(latlngsOf(layer)))} m². Use Move corners to change its outline.`));
    } else if (k === 'tree') {
      field(box, 'Height above ground', 'm', q.height, ...LIMITS.treeHeight, (v) => (q.height = v));
      field(box, 'Crown diameter', 'm', 2 * layer.getRadius(), ...LIMITS.crown, (v) => layer.setRadius(v / 2));
      box.append(hint('Shades as a solid column of the crown diameter up to its height.'));
    } else if (k === 'site') {
      field(box, 'Surface height above ground', 'm', q.base || 0, ...LIMITS.base, (v) => { if (v) q.base = v; else delete q.base; });
      if (P.pv.mount === 'tracker') box.append(hint('Trackers follow the project\'s tracker settings.'));
      else siteOrientation(box, layer, field);
      field(box, 'Shift the tables along the rows', 'm', q.shift_u, 0, LIMITS.shift[1], (v) => { if (v) q.shift_u = v; else delete q.shift_u; }, '0');
      field(box, 'Shift the first row by', 'm', q.shift_v, 0, LIMITS.shift[1], (v) => { if (v != null) q.shift_v = v; else delete q.shift_v; }, 'auto');
      box.append(button('Align to click', () => { map.closePopup(); setPlacing('align', layer); }, 'btn small ghost'));
    } else if (path) {
      field(box, 'Width', 'm', q.width, ...LIMITS.width, (v) => { q.width = v; layer.setLatLngs(stripOf(q.path, v)); layer._pts = latlngsOf(layer); });
      box.append(hint('Tables keep off the strip. To change its route, remove it and draw it again.'));
    }
    if (k !== 'site') field(box, 'Keep tables clear by', 'm', q.clearance, 0, LIMITS.clearance[1], (v) => { if (v) q.clearance = v; else delete q.clearance; }, 'none');
    if (k !== 'tree' && !path) box.append(button('Move corners', () => setPlacing('move', layer), 'btn small ghost'));
    box.append(button(k === 'tree' ? 'Move' : 'Move shape', () => setPlacing(k === 'tree' ? 'move' : 'drag', layer), 'btn small ghost'),
               button('Remove', () => { map.closePopup(); map.removeLayer(layer); forget(layer); }, 'btn small ghost'));
    L.popup({ maxWidth: 340, maxHeight: Math.max(240, map.getSize().y - 120), className: 'edit-popup' }).setLatLng(at).setContent(box).openOn(map);   // long editors scroll instead of running off the map
  }
  // Orientation of a PV area's tables: the project's, its own tilt and azimuth, east-west pairs back to back, or a canopy (one
  // plane of tables that touch across the rows, with no row shading).
  function siteOrientation(box, layer, field) {
    const q = layer._props, row = document.createElement('label'), sel = document.createElement('select'), sub = document.createElement('div');
    [['project', 'Project tilt and azimuth'], ['own', 'Own tilt and azimuth'], ['ew', 'East-west, back to back'], ['canopy', 'Canopy: one plane, no row spacing']].forEach(([v, t]) => sel.add(new Option(t, v)));
    sel.value = q.canopy ? 'canopy' : q.east_west ? 'ew' : q.tilt != null || q.azimuth != null ? 'own' : 'project';
    row.append(Object.assign(document.createElement('span'), { textContent: 'Orientation' }), sel);
    box.append(row, sub);
    const fields = () => {
      sub.innerHTML = '';
      if (sel.value === 'project') return;
      field(sub, 'Tilt', '°', q.tilt, ...LIMITS.tilt, (v) => (q.tilt = v));
      field(sub, sel.value === 'ew' ? 'Azimuth of one side' : 'Azimuth (from north)', '°', q.azimuth, ...LIMITS.azimuth, (v) => (q.azimuth = v));
      sub.append(button('Square to the longest side', () => { q.azimuth = alignedAzimuth(latlngsOf(layer), sel.value === 'ew'); fields(); changed(layer); }, 'btn small ghost'));
      if (sel.value === 'canopy') sub.append(hint('One plane: no row spacing, no row shading, no rear-side gain. Set the canopy height above, the cooling on the PV page.'));
    };
    sel.onchange = () => {
      if (sel.value === 'project') { delete q.tilt; delete q.azimuth; delete q.east_west; delete q.canopy; }
      else {
        if (q.tilt == null) q.tilt = sel.value === 'ew' ? 10 : P.pv.tilt;
        if (q.azimuth == null) q.azimuth = sel.value === 'ew' ? 90 : projectAz();
        if (sel.value === 'ew') q.east_west = true; else delete q.east_west;
        if (sel.value === 'canopy') q.canopy = true; else delete q.canopy;
      }
      fields();
      changed(layer);
    };
    fields();
  }
  // Length, width and rotation (deg from north, 0-180, of the first side) of a four-cornered footprint with square corners
  // (within 3 deg); null for any other shape.
  function rectOf(pts) {
    if (pts.length !== 4) return null;
    const c = pts.map(localProjector(pts).fwd);
    const e = c.map((p, i) => [c[(i + 1) % 4][0] - p[0], c[(i + 1) % 4][1] - p[1]]);
    for (let i = 0; i < 4; i++) {
      const a = e[i], b = e[(i + 1) % 4];
      if (Math.abs(a[0] * b[0] + a[1] * b[1]) > Math.sin(3 * Math.PI / 180) * Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1])) return null;
    }
    return { length: Math.hypot(e[0][0], e[0][1]), width: Math.hypot(e[1][0], e[1][1]), rotation: ((Math.atan2(e[0][0], e[0][1]) * 180 / Math.PI) % 180 + 180) % 180 };
  }
  // Corners of a rectangle of r's size and rotation about the centre of pts.
  function rectCorners(pts, r) {
    const pr = localProjector(pts);
    const a = r.rotation * Math.PI / 180, u = [Math.sin(a), Math.cos(a)], v = [Math.cos(a), -Math.sin(a)], hl = r.length / 2, hw = r.width / 2;
    return [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([s, t]) => pr.inv([s * u[0] + t * v[0], s * u[1] + t * v[1]]));
  }
  // Azimuth square to the area's longest side: the one facing the equator, or for east-west tables the one between 0 and 180.
  function alignedAzimuth(pts, eastWest) {
    const c = pts.map(localProjector(pts).fwd);
    let side = 0, len = -1;
    c.forEach((p, i) => {
      const q = c[(i + 1) % c.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > len) { len = l; side = Math.atan2(q[0] - p[0], q[1] - p[1]) * 180 / Math.PI; }
    });
    const n1 = ((side + 90) % 360 + 360) % 360, n2 = (n1 + 180) % 360, eq = P.location.lat >= 0 ? 180 : 0;
    const off = (x) => Math.abs(((x - eq + 540) % 360) - 180);
    return Math.round((eastWest ? (n1 < 180 ? n1 : n2) : off(n1) <= off(n2) ? n1 : n2) * 10) / 10;
  }

  // ---------------------------------------------------------------- geometry (local metres)
  function projector(lat0, lon0) {
    const ky = 110574, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    return { fwd: ([la, lo]) => [(lo - lon0) * kx, (la - lat0) * ky], inv: ([x, y]) => [lat0 + y / ky, lon0 + x / kx] };
  }
  function inPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToEdges(pt, poly) {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[j], [bx, by] = poly[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2)) : 0;
      d = Math.min(d, Math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy)));
    }
    return d;
  }
  const segX = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => { const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (!d) return false; const s = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, t = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d; return s > 0 && s < 1 && t > 0 && t < 1; };
  const edgesCross = (a, b) => a.some((p, i) => b.some((q, j) => segX(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
  // Projector centred on the mean of a set of [lat, lon] points.
  const localProjector = (pts) => projector(pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length);
  const areaLatLng = (pts) => polyArea(pts.map(localProjector(pts).fwd));
  const boxOf = (poly) => poly.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  // Footprint of a saved item as [lat, lon] corners (a tree's crown as a 16-sided polygon, as the engine takes it).
  function footprint(g) {
    if (!g.center) return g.latlngs;
    const pr = projector(g.center[0], g.center[1]), r = g.diameter / 2;
    return Array.from({ length: 16 }, (_, k) => pr.inv([r * Math.sin(k * Math.PI / 8), r * Math.cos(k * Math.PI / 8)]));
  }

  // A keepout line as a polygon: the centre line [lat, lon] pairs with square ends, widened to `width` metres by offsetting
  // each side, with mitred joins (a sharp bend stops at twice the half width).
  function stripOf(path, width) {
    const pr = localProjector(path), h = width / 2, pts = path.map(pr.fwd), n = pts.length;
    const dir = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
    const d0 = dir(pts[0], pts[1]), d1 = dir(pts[n - 2], pts[n - 1]);
    pts[0] = [pts[0][0] - d0[0] * h, pts[0][1] - d0[1] * h];   // square ends reach half a width past the first and last point
    pts[n - 1] = [pts[n - 1][0] + d1[0] * h, pts[n - 1][1] + d1[1] * h];
    const side = (s) => pts.map((p, i) => {
      const a = i > 0 ? dir(pts[i - 1], p) : dir(p, pts[1]), b = i < n - 1 ? dir(p, pts[i + 1]) : a;
      let mx = -a[1] - b[1], my = a[0] + b[0];   // the two left normals added
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) { mx = -b[1]; my = b[0]; } else { mx /= ml; my /= ml; }
      const k = h / Math.max(0.5, mx * -b[1] + my * b[0]);
      return [p[0] + s * mx * k, p[1] + s * my * k];
    });
    return side(1).concat(side(-1).reverse()).map(pr.inv).map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)]);
  }
  // The polygons (local metres, fwd) tables must keep off for one item: its footprint, or for a keepout line a rectangle for
  // each segment with square ends, so a self-overlapping bend cannot open a hole.
  function blockedOf(g, fwd) {
    if (g.kind !== 'path') return [footprint(g).map(fwd)];
    const h = g.width / 2, pts = g.path.map(fwd);
    return pts.slice(1).map((b, i) => {
      const a = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
      const p = [a[0] - ux * h, a[1] - uy * h], q = [b[0] + ux * h, b[1] + uy * h];
      return [[p[0] - uy * h, p[1] + ux * h], [q[0] - uy * h, q[1] + ux * h], [q[0] + uy * h, q[1] - ux * h], [p[0] + uy * h, p[1] - ux * h]];
    });
  }
  // Whether polygons a and b come closer than d (when they do not touch): a corner of one nearer than d to an edge of the other.
  const closerThan = (a, b, d) => a.some((p) => distToEdges(p, b) < d) || b.some((p) => distToEdges(p, a) < d);

  // ---------------------------------------------------------------- table fill
  // Rows of a PV area: along r, facing f (unit vectors in local metres), table depth across the row, row pitch, east-west pairs;
  // its own tilt and azimuth or the project's (trackers always the project's).
  function rowsOf(s, slant, along) {
    const pv = P.pv, tracker = pv.mount === 'tracker', o = orientationOf(s);
    const a = (tracker ? pv.tracker_axis_azimuth : o.azimuth) * Math.PI / 180;
    const r = tracker ? [Math.sin(a), Math.cos(a)] : [Math.cos(a), -Math.sin(a)];
    const depth = tracker ? slant : slant * Math.cos(o.tilt * Math.PI / 180);
    return { r, f: [-r[1], r[0]], along, ew: o.ew, depth, pitch: o.canopy ? depth : (o.ew ? 2 : 1) * slant / Math.max(0.05, pv.gcr),   // a canopy's rows touch
             label: o.own ? `${o.canopy ? 'canopy ' : o.ew ? 'east-west ' : ''}${fmtNum(o.tilt, 1)}° / ${fmtNum(o.azimuth, 1)}°` : 'project' };
  }
  // Where the tables of a PV area start: the corner of its bounding box in row coordinates, moved in by the setback.
  function gridOf(site, g) {
    const { r, f } = g, toUV = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]], b = boxOf(site.map(toUV)), sb = P.layout.setback || 0;
    return { toUV, u0: b[0] + sb, v0: b[1] + sb };
  }
  // One PV area filled with tables: rows at the pitch from the setback inward, the first a fraction dv of a pitch further in
  // and the first table of each row `shift` metres along it; after every `aisle_every` rows a strip of `aisle_width` is left.
  // Along a row a table goes in where it fits clear of the blocked polygons X (each kept C[i] metres away), else the next try
  // is an eighth of a table on. East-west tables stand in pairs, ridge to ridge. Corners: the upper edge first.
  function fillArea(site, X, C, g, dv, shift = 0) {
    const { r, f, along, depth, pitch, ew } = g, lay = P.layout, setback = lay.setback || 0, unit = ew ? 2 * depth : depth;
    const every = lay.aisle_every > 0 ? Math.floor(lay.aisle_every) : 0, aisle = every ? Math.max(0, lay.aisle_width || 0) : 0;
    const toUV = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]];
    const toXY = ([u, v]) => [u * r[0] + v * f[0], u * r[1] + v * f[1]];
    const [umin, vmin, umax, vmax] = boxOf(site.map(toUV));
    // boxes of the blocked polygons in row coordinates, grown by their clearance
    const xb = X.map((x, i) => { const b = boxOf(x.map(toUV)); return [b[0] - C[i], b[1] - C[i], b[2] + C[i], b[3] + C[i]]; });
    const out = [];
    for (let row = 0, v = vmin + setback + dv * pitch; v + unit <= vmax - setback + 1e-6; v += pitch + (every && ++row % every === 0 ? aisle : 0)) {
      const inRow = X.map((_, i) => i).filter((i) => xb[i][1] <= v + unit && xb[i][3] >= v);   // blocked polygons reaching this row
      for (let u = umin + setback + shift; u + along <= umax - setback + 1e-6;) {
        const corners = [[u, v], [u + along, v], [u + along, v + unit], [u, v + unit]].map(toXY);
        const probes = corners.concat([toXY([u + along / 2, v + unit / 2]), toXY([u + along / 2, v]), toXY([u + along / 2, v + unit])]);
        const ok = probes.every((p) => inPoly(p, site)) && !edgesCross(corners, site) && (setback <= 0 || corners.every((p) => distToEdges(p, site) >= setback - 1e-6)) &&
                   !inRow.some((i) => xb[i][0] <= u + along && xb[i][2] >= u &&
                                      (probes.some((p) => inPoly(p, X[i])) || X[i].some((q) => inPoly(q, corners)) || edgesCross(corners, X[i]) ||
                                       (C[i] > 0 && closerThan(corners, X[i], C[i]))));
        if (ok) {
          if (!ew) out.push(corners);
          else out.push([[u, v + depth], [u + along, v + depth], [u + along, v], [u, v]].map(toXY),
                        [[u, v + depth], [u + along, v + depth], [u + along, v + unit], [u, v + unit]].map(toXY));
          u += along + (lay.table_gap || 0);
        } else u += Math.max(0.5, along / 8);
      }
    }
    return out;
  }

  // Fills every PV area, trying the first row at 8 offsets across the pitch and keeping the one with the most tables. Tables
  // keep clear of exclusion zones and of the footprints of buildings and trees.
  // Aligns the tables of the PV area being edited so a table corner sits at the click: the shifts along the rows and of the
  // first row that put the table grid there, in the same local frame the fill uses.
  function alignAt(ll) {
    const layer = aligning;
    setPlacing(null);
    if (!layer) return;
    const item = polyOf(layer), sites = (P.layout.polygons || []).filter((g) => g.type === 'site');
    const pr = localProjector(sites.flatMap((s) => s.latlngs)), { slant, along } = tableSize(), g = rowsOf(item, slant, along);
    const grid = gridOf(item.latlngs.map(pr.fwd), g), [u, v] = grid.toUV(pr.fwd([ll.lat, ll.lng]));
    const mod = (x, m) => ((x % m) + m) % m;
    layer._props.shift_u = +mod(u - grid.u0, along + (P.layout.table_gap || 0)).toFixed(2);
    layer._props.shift_v = +mod(v - grid.v0, g.pitch).toFixed(2);
    changed(layer);
    toast(`Tables aligned to the click: shifted ${fmtNum(layer._props.shift_u, 2)} m along the rows, first row ${fmtNum(layer._props.shift_v, 2)} m in.`);
  }
  // Size of a table: across the rows (slant, up the module plane) and along them, from the modules it holds.
  function tableSize() {
    const pv = P.pv, lay = P.layout, portrait = lay.orientation === 'portrait';
    return { slant: lay.modules_across * (portrait ? pv.module_length : pv.module_width),
             along: lay.modules_per_table * (portrait ? pv.module_width : pv.module_length) + 0.02 * lay.modules_per_table };
  }
  function run() {
    const all = P.layout.polygons || [], sites = all.filter((p) => p.type === 'site');
    if (!sites.length) { toast('Draw at least one PV area first.', true); return; }
    const excl = all.filter((p) => p.type === 'exclusion'), blocks = all.filter((p) => p.type === 'exclusion' || p.type === 'obstacle');
    const pr = localProjector(sites.flatMap((s) => s.latlngs));
    const S = sites.map((s) => s.latlngs.map(pr.fwd)), X = [], C = [];   // blocked polygons and the clearance kept around each
    blocks.forEach((g) => blockedOf(g, pr.fwd).forEach((poly) => { X.push(poly); C.push(g.clearance || 0); }));

    const pv = P.pv, lay = P.layout, { slant, along } = tableSize();
    const tables = [], labels = [], areas = [];
    const gone = (lay.removed || []).map((t) => { const c = t.map(pr.fwd); return [c.reduce((a, p) => a + p[0], 0) / c.length, c.reduce((a, p) => a + p[1], 0) / c.length]; });
    S.forEach((site, i) => {
      const g = rowsOf(sites[i], slant, along), shift = sites[i].shift_u || 0, rowShift = sites[i].shift_v;
      let best = null;
      for (let k = 0; k < (rowShift != null ? 1 : 8); k++) {   // a typed first-row shift is the only try, else the best of 8 offsets
        const t = fillArea(site, X, C, g, rowShift != null ? rowShift / g.pitch : k / 8, shift);
        if (!best || t.length > best.length) best = t;
      }
      if (gone.length) {   // tables taken out by hand stay out: a new table whose centre is within half a table of one is dropped
        const rad = 0.45 * Math.min(along, g.depth);
        best = best.filter((t) => { const cx = t.reduce((a, p) => a + p[0], 0) / t.length, cy = t.reduce((a, p) => a + p[1], 0) / t.length; return !gone.some(([x, y]) => Math.hypot(cx - x, cy - y) < rad); });
      }
      best.forEach((t) => { tables.push(t.map(pr.inv)); labels.push(g.label); areas.push(i); });
    });
    emptyAreas = S.length - new Set(areas).size;
    const modules = tables.length * lay.modules_across * lay.modules_per_table;
    const siteArea = S.reduce((a, s) => a + polyArea(s), 0), exclArea = excl.reduce((a, g) => a + blockedOf(g, pr.fwd).reduce((t, p) => t + polyArea(p), 0), 0);
    const g0 = rowsOf({}, slant, along);
    P.layout.result = { tables: tables.length <= MAX_LAYOUT_TABLES ? tables.map((t) => t.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)])) : [],
                        n_tables: tables.length, modules, kwp: modules * pv.module_wp / 1000, site_m2: siteArea, excl_m2: exclArea,
                        pitch: g0.pitch, slant, along, depth: g0.depth };
    if (P.layout.result.tables.length) P.layout.result.table_area = areas;
    const groups = countGroups(labels);
    if (groups.length > 1 || (groups.length && groups[0].label !== 'project')) P.layout.result.groups = groups;
    shade = null;
    draw(tables);
    renderStats();
    onChange('layout.result');   // the yield is calculated again when the engine uses the layout, and brings the shade (setShade)
  }
  const countGroups = (labels) => [...labels.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map())].map(([label, n]) => ({ label, n }));

  // ---------------------------------------------------------------- tables taken out by hand, undo and redo
  const hasSites = () => (P.layout.polygons || []).some((g) => g.type === 'site');
  // The tables the user took out, as saved: four [lat, lon] corners each. A new fill drops the tables that sit where one was.
  function cleanRemoved(list) {
    const fin = (q) => Array.isArray(q) && q.length === 2 && num(q[0]) != null && num(q[1]) != null;
    return (Array.isArray(list) ? list : []).filter((t) => Array.isArray(t) && t.length === 4 && t.every(fin)).slice(0, 5000).map((t) => t.map(([a, b]) => [+a, +b]));
  }
  // Orientation label of each table of a layout result, from the PV area it stands in.
  function labelsOf(R) {
    const { slant, along } = tableSize(), by = (P.layout.polygons || []).filter((g) => g.type === 'site').map((s) => rowsOf(s, slant, along).label);
    return (R.table_area || []).map((i) => by[i] || 'project');
  }
  // A layout result without the tables where keep is false: counts, capacity, areas and orientation groups follow.
  function keepOnly(R, keep) {
    const pick = (a) => a.filter((_, i) => keep[i]), tables = pick(R.tables), per = P.layout.modules_across * P.layout.modules_per_table;
    const out = { ...R, tables, n_tables: tables.length, modules: tables.length * per, kwp: tables.length * per * P.pv.module_wp / 1000 };
    if (R.table_area) out.table_area = pick(R.table_area);
    if (R.groups) out.groups = countGroups(labelsOf(out));
    return out;
  }
  // Outlines of the tables taken out, shown only while removing tables so one can be put back.
  function drawGhosts() {
    ghostLayer.clearLayers();
    if (placing !== 'remove') return;
    (P.layout.removed || []).forEach((t) => L.polygon(t, { color: '#7a7a7a', weight: 1, dashArray: '3 3', fillOpacity: 0.05, interactive: false, pmIgnore: true }).addTo(ghostLayer));
  }
  // A click while removing tables: on a dashed outline puts that table back, on a table takes it out.
  function toggleTableAt(ll) {
    const R = P.layout.result, here = [ll.lat, ll.lng], removed = P.layout.removed || (P.layout.removed = []);
    const back = removed.findIndex((t) => inPoly(here, t));
    if (back >= 0) {
      removed.splice(back, 1);
      remember(); onChange('layout.removed'); drawGhosts(); updateUndo();
      run();
      return;
    }
    const i = R && R.tables ? R.tables.findIndex((t) => inPoly(here, t)) : -1;
    if (i < 0) {
      if (R && R.n_tables && !(R.tables || []).length) toast('This layout has too many tables to take them out one by one. Draw an exclusion zone instead.', true);
      return;
    }
    if (removed.length >= 5000) { toast('At most 5000 tables can be taken out by hand.', true); return; }
    removed.push(R.tables[i].map(([a, b]) => [a, b]));
    P.layout.result = keepOnly(R, R.tables.map((_, k) => k !== i));
    shade = null;   // the shade belongs to the tables as they were; the yield calculation that follows brings it back
    draw(P.layout.result.tables);
    renderStats(); drawGhosts(); remember(); updateUndo();
    onChange('layout.removed');
    onChange('layout.result');
  }
  // Undo and redo of the drawn items and the removed tables: each save is a snapshot; layout parameters are not part of it.
  const snapshot = () => JSON.stringify({ polygons: P.layout.polygons || [], removed: P.layout.removed || [] });
  function remember() {
    if (restoring) return;
    const s = snapshot();
    if (history[history.length - 1] === s) return;
    history.push(s);
    if (history.length > 101) history.shift();
    future = [];
    updateUndo();
  }
  function updateUndo() {
    $('#btnUndo').disabled = history.length < 2;
    $('#btnRedo').disabled = !future.length;
    $('#btnRestoreTables').hidden = !(P.layout.removed || []).length;
  }
  function undo() { if (history.length < 2) return; future.push(history.pop()); applyState(history[history.length - 1]); }
  function redo() { if (!future.length) return; const s = future.pop(); history.push(s); applyState(s); }
  function applyState(s) {
    const st = JSON.parse(s);
    restoring = true;
    setPlacing(null);
    polyLayers.forEach((l) => map.removeLayer(l)); polyLayers = [];
    P.layout.removed = cleanRemoved(st.removed);
    st.polygons.map(cleanItem).filter(Boolean).forEach(addItem);
    savePolys();
    restoring = false;
    clearTimeout(relayoutTimer);
    if (hasSites()) run();
    else { tablesLayer.clearLayers(); P.layout.result = null; shade = null; renderStats(); sunPath(); }
    updateUndo();
  }

  // ---------------------------------------------------------------- near shading
  // Shade from the last yield calculation (its shade: the share of each table's beam the objects hide over the year, and the
  // near horizon they form), for the layout result R it was made with. Tables shaded over the chosen limit are then left out;
  // the yield is calculated again for the tables that remain.
  function setShade(s, R) {
    if (R !== P.layout.result) return;   // the layout changed since: its own calculation follows
    shade = s || null;
    const lim = P.layout.max_table_shade, T = (R && R.tables) || [];
    if (shade && lim > 0 && shade.tables.length === T.length && shade.tables.some((x) => x > lim)) {
      const keep = shade.tables.map((x) => x <= lim);
      P.layout.result = { ...keepOnly(R, keep), dropped: (R.dropped || 0) + keep.filter((k) => !k).length };
      shade = { ...shade, tables: shade.tables.filter((_, i) => keep[i]) };
      onChange('layout.result');
    }
    if (P.layout.result) draw(P.layout.result.tables || []);
    renderStats();
    sunPath();
  }

  const SHADE_CLASSES = [[0.01, '#3987e5', 'under 1 %'], [0.05, '#e2b93b', '1-5 %'], [0.1, '#f08c2e', '5-10 %'], [0.2, '#e0561b', '10-20 %'], [Infinity, '#b4232a', 'over 20 %']];
  function draw(tables) {
    tablesLayer.clearLayers();
    const st = { renderer: canvas, color: '#2a78d6', weight: 0.6, fillColor: '#3987e5', fillOpacity: 0.7, interactive: false, pmIgnore: true };
    const shown = tables.slice(0, MAX_LAYOUT_TABLES);
    if (!shown.length) return;
    if (!(showShade && shade && shade.tables.length === tables.length)) { L.polygon(shown.map((t) => [t]), st).addTo(tablesLayer); return; }
    const byClass = SHADE_CLASSES.map(() => []);
    shown.forEach((t, i) => byClass[SHADE_CLASSES.findIndex(([lim]) => shade.tables[i] < lim)].push([t]));
    byClass.forEach((g, k) => { if (g.length) L.polygon(g, { ...st, color: SHADE_CLASSES[k][1], fillColor: SHADE_CLASSES[k][1] }).addTo(tablesLayer); });
  }

  function renderStats() {
    const R = P.layout.result, box = $('#layoutStats');
    if (!R) { box.innerHTML = '<p class="hint">No layout yet. Draw a PV area, then press "Fill area with tables" or keep auto-update on.</p><div id="layoutMore"></div>'; renderShade(); return; }
    const net = (R.site_m2 - R.excl_m2) / 1e4;
    box.innerHTML = `<div class="kpis">${kpis([
      ['Max DC capacity', fmtPower(R.kwp).replace('kW', 'kWp').replace('MW', 'MWp'), `${fmtNum(R.modules)} modules`, true],
      ['Tables', fmtNum(R.n_tables), `${fmtNum(R.along || 0, 1)} × ${fmtNum(R.slant, 2)} m`],
      ['Net area', `${fmtNum(net, 1)} ha`, `${fmtNum(R.excl_m2 / 1e4, 1)} ha excluded`],
      ['Power density', fmtNum(net > 0 ? R.kwp / 1000 / net : 0, 2), `MWp/ha · pitch ${fmtNum(R.pitch, 1)} m`]])}</div>
      <div class="row gap"><button class="btn small" id="useCap">Use as PV capacity</button><button class="btn small" id="useLim">Use as optimiser land limit</button></div>
      <div id="layoutMore"></div>`;
    $('#useCap').onclick = () => { P.pv.capacity_kwp = Math.round(R.kwp); syncForms(P); onChange('pv.capacity_kwp'); toast('PV capacity set to ' + fmtNum(R.kwp) + ' kWp'); };
    $('#useLim').onclick = () => { P.optimizer.max_pv_kwp = Math.round(R.kwp); if (!P.optimizer.pv_max || P.optimizer.pv_max > R.kwp) P.optimizer.pv_max = Math.round(R.kwp); syncForms(P); onChange('optimizer.max_pv_kwp'); toast('Optimiser PV limit set to ' + fmtNum(R.kwp) + ' kWp'); };
    renderShade();
  }
  // Orientations of the tables, the objects and the shade on the tables under the layout figures.
  function renderShade() {
    const box = $('#layoutMore');
    if (!box) return;
    const R = P.layout.result, objs = (P.layout.polygons || []).filter((g) => g.type === 'obstacle');
    let h = '';
    if (R && R.groups) h += `<p class="hint">Tables by orientation: ${R.groups.map((g) => `${fmtNum(g.n)} ${g.label === 'project' ? 'at the project\'s tilt and azimuth' : 'at ' + escapeHtml(g.label)}`).join(', ')}. The yield adds up each orientation under the shared inverters.</p>`;
    if (R && emptyAreas) h += `<p class="hint">${count(emptyAreas, 'PV area takes', 'PV areas take')} no table: the edge setback (${fmtNum(P.layout.setback || 0, 1)} m) or the table size leaves no room.</p>`;
    if (R && (P.layout.removed || []).length) h += `<p class="hint">${count(P.layout.removed.length, 'table', 'tables')} taken out by hand; <i>Restore all</i> in the toolbar puts them back.</p>`;
    if (R && R.dropped) h += `<p class="hint">${count(R.dropped, 'table', 'tables')} left out, shaded over ${fmtPct(P.layout.max_table_shade, 0)} by buildings and trees.</p>`;
    if (objs.length) {
      const trees = objs.filter((g) => g.kind === 'tree').length;
      h += `<p class="hint">${count(objs.length - trees, 'building', 'buildings')} and ${count(trees, 'tree', 'trees')} shade the array`;
      if (P.pv.near_shading === false) h += ' (switched off on the PV page)';
      else if (!(P.weather && P.weather.ghi)) h += ' (shade map once the solar data are fetched, tab 2)';
      else if (shade && shade.tables.length && R && shade.tables.length === (R.tables || []).length) {
        const mean = sum(shade.tables) / shade.tables.length, worst = maxOf(shade.tables);
        h += `: beam lost ${fmtPct(mean)} on average, ${fmtPct(worst)} on the worst table`;
      }
      h += '.</p>';
      if (shade && shade.tables.length)
        h += `<label class="hint inline"><input type="checkbox" id="shadeShow" ${showShade ? 'checked' : ''}> shade on the tables</label>
              <span class="shade-legend">${SHADE_CLASSES.map(([, c, t]) => `<i style="background:${c}"></i>${t}`).join('')}</span>`;
    }
    box.innerHTML = h;
    const cb = $('#shadeShow');
    if (cb) cb.onchange = () => { showShade = cb.checked; if (P.layout.result) draw(P.layout.result.tables || []); };
  }

  // ---------------------------------------------------------------- sun path
  // Sun elevation and azimuth (deg, azimuth from north clockwise) at a latitude, declination and hour angle (deg).
  function sunAt(lat, decl, ha) {
    const r = Math.PI / 180;
    const el = Math.asin(Math.max(-1, Math.min(1, Math.sin(lat * r) * Math.sin(decl * r) + Math.cos(lat * r) * Math.cos(decl * r) * Math.cos(ha * r)))) / r;
    const az = Math.atan2(Math.sin(ha * r), Math.cos(ha * r) * Math.sin(lat * r) - Math.tan(decl * r) * Math.cos(lat * r)) / r + 180;
    return { el, az: (az + 360) % 360 };
  }
  // Sun paths on the 21st of each month (solar time) over the terrain horizon of the PV page and the near horizon of the
  // objects as the tables see it (median and highest over the tables), azimuths centred on the equator.
  function sunPath() {
    const el = $('#chSunPath');
    if (!el || typeof Plotly === 'undefined') return;
    const lat = P.location.lat, south = lat < 0, xOf = (az) => (south ? (az > 180 ? az - 360 : az) : az);
    const c = COL(), traces = [];
    // a profile at equal azimuth steps from north, linear between them, drawn every 2 deg across the chart
    const profile = (h, name, colour, fill, dash) => {
      const n = h.length, xs = [], ys = [];
      for (let x = south ? -180 : 0; x <= (south ? 180 : 360); x += 2) {
        const k = ((x % 360) + 360) % 360 * n / 360, i = Math.floor(k) % n;
        xs.push(x);
        ys.push(h[i] + (k - Math.floor(k)) * (h[(i + 1) % n] - h[i]));
      }
      traces.push({ x: xs, y: ys, name, type: 'scatter', mode: 'lines', line: { color: colour, width: 1, dash }, fill: fill ? 'tozeroy' : 'none', fillcolor: fill, hoverinfo: 'skip' });
    };
    if (Array.isArray(P.pv.horizon) && P.pv.horizon.length) profile(P.pv.horizon, 'Terrain horizon', c.muted, 'rgba(128,128,128,0.35)');
    if (shade && shade.median && shade.median.length) {
      profile(shade.median, 'Buildings and trees (median table)', '#8a5a2b', 'rgba(138,90,43,0.35)');
      profile(shade.max, 'Buildings and trees (most shaded table)', '#8a5a2b', null, 'dot');
    }
    const day21 = [20, 51, 79, 110, 140, 171, 201, 232, 263, 293, 324, 354];
    [11, 0, 1, 2, 3, 4, 5].forEach((m) => {
      const decl = 23.45 * Math.sin(2 * Math.PI * (284 + day21[m] + 1) / 365), xs = [], ys = [], tx = [];
      for (let ha = -180; ha <= 180; ha += 1) {
        const s = sunAt(lat, decl, ha);
        if (s.el <= 0) continue;
        const x = xOf(s.az);
        if (xs.length && Math.abs(x - xs[xs.length - 1]) > 180) { xs.push(null); ys.push(null); tx.push(''); }
        xs.push(x); ys.push(s.el); tx.push(`${MONTHS[m]}${m !== 11 && m !== 5 ? ' / ' + MONTHS[10 - m] : ''} 21 · ${fmtNum(12 + ha / 15, 1)} h solar time`);
      }
      traces.push({ x: xs, y: ys, text: tx, hoverinfo: 'text', type: 'scatter', mode: 'lines', name: m === 5 ? 'Sun path, 21st of the month' : '',
                    showlegend: m === 5, line: { color: c.pv, width: m === 11 || m === 5 ? 2 : 1 } });
    });
    const ticks = south ? [-180, -90, 0, 90, 180] : [0, 90, 180, 270, 360];
    plot(el, traces, { margin: { l: 48, r: 10, t: 8, b: 36 }, showlegend: true,
      xaxis: { range: south ? [-180, 180] : [0, 360], tickvals: ticks, ticktext: ticks.map((t) => ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N', '-90': 'W', '-180': 'S' })[t]) },
      yaxis: { range: [0, 90], title: { text: 'Elevation (°)' } } });
  }

  // ---------------------------------------------------------------- row spacing
  // Ground coverage ratio for fixed rows that do not shade each other between the chosen solar hours on the winter solstice
  // (the lowest sun of the year): the pitch keeps the shadow of a row's upper edge, cast along the sun's direction relative
  // to the rows, off the row behind. Rounded down to 0.01.
  function shadeFreeGcr() {
    const pv = P.pv, lay = P.layout;
    if (pv.mount === 'tracker') { toast('Trackers avoid row shading by backtracking.', true); return; }
    const from = lay.shade_free_from, to = lay.shade_free_to;
    if (!(from >= 6 && to <= 18 && from < to)) { toast('Shade-free hours: from 6 to 12 h and to 12 to 18 h.', true); return; }
    const lat = P.location.lat, decl = lat >= 0 ? -23.44 : 23.44, az = projectAz(), r = Math.PI / 180;
    const slant = lay.modules_across * (lay.orientation === 'portrait' ? pv.module_length : pv.module_width), tilt = pv.tilt || 0;
    let pitch = slant * Math.cos(tilt * r);
    for (let h = from; h <= to + 1e-9; h += 0.25) {
      const s = sunAt(lat, decl, 15 * (h - 12));
      if (s.el < 2) { toast(`The sun is below 2° at ${fmtNum(h, 2)} h solar time on the winter solstice here: choose shorter hours.`, true); return; }
      const cd = Math.cos((s.az - az) * r);
      if (cd > 0) pitch = Math.max(pitch, slant * Math.cos(tilt * r) + slant * Math.sin(tilt * r) * cd / Math.tan(s.el * r));
    }
    const gcr = Math.min(0.95, Math.max(0.1, Math.floor(slant / pitch * 100) / 100));
    pv.gcr = gcr;
    syncForms(P);
    onChange('pv.gcr');
    toast(`GCR ${gcr.toFixed(2)}: rows ${fmtNum(slant / gcr, 1)} m apart stay clear of each other's shadow from ${fmtNum(from, 1)} to ${fmtNum(to, 1)} h on the winter solstice.`);
  }

  // ---------------------------------------------------------------- files
  // Imported items: those written by the layout export keep their kind and fields; other shapes become the kind chosen next
  // to the Import button (holes of a polygon exclusion zones), points become trees.
  async function importFile(file) {
    let r;
    try { r = await GeoData.read(file); } catch (e) { toast(`${file.name}: ${e.message}`, true); return; }
    if (!r.items.length) { toast(`${file.name}: no areas or points found.`, true); return; }
    const as = $('#importAs').value, added = [];
    for (const it of r.items) {
      const p = it.props || {}, kind = p.soloptima || (it.kind === 'point' ? 'tree' : it.kind === 'hole' ? 'exclusion' : as);
      if ((it.kind === 'point') !== (kind === 'tree')) continue;   // tables are filled again from the areas
      const g = cleanItem({ ...p, type: kind === 'building' || kind === 'tree' ? 'obstacle' : kind, kind, latlngs: it.latlngs, center: it.latlng,
                            diameter: p.diameter != null ? p.diameter : 6, source: 'import' });
      if (g) added.push(addItem(g));
    }
    if (!added.length) { toast(`${file.name}: nothing to import (tables are filled again from the areas).`, true); return; }
    savePolys();
    map.fitBounds(L.featureGroup(added).getBounds(), { padding: [30, 30] });
    const n = (k, one, many) => count(added.filter((l) => kindOf(l) === k).length, one, many);
    toast(`Imported from ${file.name}: ${[n('site', 'PV area', 'PV areas'), n('exclusion', 'exclusion zone', 'exclusion zones'), n('building', 'building', 'buildings'), n('tree', 'tree', 'trees')].filter((x) => !x.startsWith('0 ')).join(', ')}` +
          (r.skipped ? `; ${r.skipped} shapes skipped (fewer than 3 corners or out of range)` : '') + '. Check the heights of buildings and trees.');
  }
  function exportLayout(fmt) {
    if (!polyLayers.length) { toast('Nothing drawn to export yet.', true); return; }
    const name = String(P.name || 'layout').replace(/[^\w\- ]+/g, '_');
    if (fmt === 'kml') download(`${name}.kml`, GeoData.toKML(P.layout, P.name || 'Layout'), 'application/vnd.google-earth.kml+xml');
    else download(`${name}.geojson`, GeoData.toGeoJSON(P.layout), 'application/geo+json');
  }

  // ---------------------------------------------------------------- OpenStreetMap buildings and roof tracing
  // A preview layer of candidates (OSM buildings, a traced roof) with a bar of actions over the map.
  function clearPreview() {
    if (preview) { map.removeLayer(preview); preview = null; }
    map.attributionControl.removeAttribution(OSM_ATTR);
    $('#mapBar').hidden = true;
    $('#mapBar').innerHTML = '';
  }
  function bar(text, actions) {
    const b = $('#mapBar');
    b.innerHTML = '';
    b.append(Object.assign(document.createElement('span'), { textContent: text }), ...actions.map(([t, fn, cls]) => button(t, fn, cls)));
    b.hidden = false;
  }
  async function loadOsm() {
    if (view !== 'leaflet') setView('leaflet');
    const b = map.getBounds(), s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
    if (areaLatLng([[s, w], [s, e], [n, e], [n, w]]) > 4e6) { toast('Zoom in to an area of 4 km² or less to load its buildings.', true); return; }
    const btn = $('#btnOsm');
    btn.disabled = true;
    try { showOsm(await GeoData.osmBuildings(s, w, n, e)); } catch (err) { toast('OpenStreetMap buildings: ' + err.message, true); }
    finally { btn.disabled = false; }
  }
  function showOsm(list) {
    clearPreview();
    if (!list.length) { toast('OpenStreetMap has no buildings in this view.'); return; }
    osmSeen = osmSeen.concat(list);
    preview = L.layerGroup().addTo(map);
    map.attributionControl.addAttribution(OSM_ATTR);
    const taken = new Set(polyLayers.filter((l) => !(l instanceof L.Circle)).map((l) => latlngsOf(l)[0].join(',')));
    const fresh = list.filter((bd) => !taken.has(bd.latlngs[0].join(',')));
    const asBuilding = (bd) => addItem({ type: 'obstacle', kind: 'building', height: bd.height || 6, latlngs: bd.latlngs, source: 'osm' });
    fresh.forEach((bd) => {
      const l = L.polygon(bd.latlngs, { ...STYLE.osm, bubblingMouseEvents: false }).addTo(preview);
      l.on('click', (ev) => {
        const box = document.createElement('div');
        box.className = 'edit-pop';
        box.append(Object.assign(document.createElement('b'), { textContent: `OpenStreetMap building${bd.height ? ', ' + fmtNum(bd.height, 1) + ' m high' : ''}` }));
        const use = (fn) => () => { map.closePopup(); preview.removeLayer(l); fn(); savePolys(); };
        box.append(button('Roof as PV area', use(() => addRoof(bd.latlngs, [], bd.height, 'osm'))),
                   button('Building', use(() => asBuilding(bd))),
                   button('Exclusion zone', use(() => addItem({ type: 'exclusion', latlngs: bd.latlngs, source: 'osm' }))));
        L.popup({ className: 'edit-popup' }).setLatLng(ev.latlng).setContent(box).openOn(map);
      });
    });
    const unknown = fresh.filter((bd) => !bd.height).length;
    bar(`${count(fresh.length, 'building', 'buildings')} from OpenStreetMap${unknown ? `, ${fmtNum(unknown)} without a height (6 m taken)` : ''}. Click one to use it, or:`, [
      ['Add all as buildings', () => { fresh.forEach(asBuilding); clearPreview(); savePolys(); }],
      ['Those in PV areas as exclusions', () => {
        const sites = polyLayers.filter((l) => l._ptype === 'site').map(latlngsOf);
        const inside = fresh.filter((bd) => { const b = boxOf(bd.latlngs), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; return sites.some((sp) => inPoly(c, sp)); });
        inside.forEach((bd) => addItem({ type: 'exclusion', latlngs: bd.latlngs, source: 'osm' }));
        clearPreview(); savePolys();
        toast(`${count(inside.length, 'building', 'buildings')} inside PV areas added as exclusion zones.`);
      }],
      ['Close', clearPreview, 'btn small ghost'],
    ]);
  }

  // ---------------------------------------------------------------- own imagery
  // The user's orthophoto as an overlay, with a line under the map: its file, ground resolution and coordinate system, an
  // opacity slider and removal.
  async function loadImage(files) {
    let im;
    try { im = await Ortho.load(files, P.location); } catch (e) { toast('Own image: ' + e.message, true); return; }
    dropImage();
    ortho = { im, layer: Ortho.layer(im, { pane: 'ortho', interactive: false }).addTo(map), src: Ortho.source(im) };
    map.fitBounds(im.bounds, { padding: [20, 20] });
    const range = Object.assign(document.createElement('input'), { type: 'range', min: 0.2, max: 1, step: 0.1, value: 1, title: 'Opacity' });
    range.oninput = () => ortho && ortho.layer.setOpacity(+range.value);
    const info = document.createElement('span');
    info.textContent = `${im.name}, ${fmtNum(im.mpp * 100, 1)} cm per pixel, ${Ortho.crsLabel(im.crs)}`;
    const box = $('#orthoInfo');
    box.replaceChildren(info, range, button('Remove', dropImage, 'btn small ghost'));
    box.hidden = false;
    toast(`${im.name} placed by its world file in ${Ortho.crsLabel(im.crs)}. Check that it lines up with the map; Trace roof now reads it.`);
  }
  function dropImage() {
    if (ortho) { map.removeLayer(ortho.layer); ortho.im.canvas.width = 0; }   // a zero-size canvas frees its pixels
    ortho = null;
    const box = $('#orthoInfo');
    if (box) { box.hidden = true; box.replaceChildren(); }
  }

  // Roof tracing reads only the user's own image: Esri's and Google's terms do not allow deriving outlines from their imagery.
  function traceAt(ll) {
    if (!ortho) { toast('Roof tracing reads your own image: load a drone or survey image with its world file (Own image…) first.', true); return; }
    if (!ortho.layer.getBounds().contains(ll)) { toast('Click a roof inside your own image.', true); return; }
    if (tracing) return;
    tracing = true;
    info('Tracing the roof…');
    const src = ortho.src;
    setTimeout(() => {   // let the message show before the work
      try { showTrace(traceOwn(ll, src)); } catch (e) { toast(e.message, true); }
      finally { tracing = false; setPlacing(placing); }
    }, 30);
  }
  // The roof traced at ll on the user's image; throws the reason when there is none.
  function traceOwn(ll, src) {
    const r = RoofTrace.traceRoof(ll.lat, ll.lng, src);
    if (!r) throw new Error('No roof stands out from its surroundings there. Click nearer its middle, or draw it.');
    if (r.offEdge) throw new Error('That roof runs off the edge of your image. Draw it, or load an image that covers all of it.');
    return r;
  }
  // A roof as a PV area at its height (m above ground), with its openings as exclusion zones and, with units, as rooftop
  // units 1.5 m above it; own (tilt, azimuth) when given.
  function addRoof(outline, holes, height, source, { units = true, own } = {}) {
    const h = height > 0 ? clampTo(height, LIMITS.base) : 0;
    const l = addItem({ type: 'site', latlngs: outline, ...(h ? { base: h } : {}), ...own, ...(source ? { source } : {}) });
    holes.forEach((hole) => {
      addItem({ type: 'exclusion', latlngs: hole, source: 'traced' });
      if (units) addItem({ type: 'obstacle', kind: 'building', height: Math.round((h + 1.5) * 10) / 10, latlngs: hole, source: 'traced' });
    });
    return l;
  }
  // OpenStreetMap buildings received this session, searched before a new request; a request covers the 0.002° cell
  // (about 220 m) holding the point, so clicks on neighbouring roofs share it.
  let osmSeen = [];
  async function osmBuildingAt(ll) {
    const pt = [ll.lat, ll.lng], at = () => osmSeen.find((bd) => inPoly(pt, bd.latlngs)) || null;
    if (at()) return at();
    const d = 0.002, s = Math.floor(ll.lat / d) * d, w = Math.floor(ll.lng / d) * d;
    osmSeen = osmSeen.concat(await GeoData.osmBuildings(s, w, s + d, w + d));
    return at();
  }
  // Assisted roof layout (Ctrl+click): the roof under the click becomes a PV area at its height, tables at the project tilt
  // and square to its longest side. Outline from a drawn building, else the user's own image, else OpenStreetMap.
  async function roofLayout(ll) {
    if (tracing) return;
    if (view !== 'leaflet') setView('leaflet');
    setPlacing(null);
    tracing = true;
    info('Laying out the roof…');
    try {
      const pt = [ll.lat, ll.lng], roof = { holes: [] };
      const drawn = polyLayers.find((l) => kindOf(l) === 'building' && inPoly(pt, latlngsOf(l)));
      if (drawn) {
        Object.assign(roof, { outline: latlngsOf(drawn), height: drawn._props.height, source: drawn._props.source, from: 'the building drawn there' });
        map.removeLayer(drawn);
        forget(drawn);
      } else if (ortho && ortho.layer.getBounds().contains(ll)) {
        const bd = osmBuildingAt(ll).catch(() => null);   // only for the height; runs while the image is traced
        await new Promise((r) => setTimeout(r, 30));   // let the message show before the work
        const r = traceOwn(ll, ortho.src);
        Object.assign(roof, { outline: r.outline, holes: r.holes, height: ((await bd) || {}).height, source: 'traced', from: 'your image' });
      } else {
        let bd;
        try { bd = await osmBuildingAt(ll); } catch (e) { throw new Error('OpenStreetMap buildings: ' + e.message); }
        if (!bd) throw new Error('No building there. Draw it, load your own image (Own image…), or check that OpenStreetMap covers this place.');
        Object.assign(roof, { outline: bd.latlngs, height: bd.height, source: 'osm', from: 'OpenStreetMap' });
      }
      const own = { tilt: clampTo(P.pv.tilt || 0, LIMITS.tilt), azimuth: alignedAzimuth(roof.outline, false) };
      const l = addRoof(roof.outline, roof.holes, roof.height, roof.source, { own });
      clearPreview();
      savePolys();
      const parts = [`Roof from ${roof.from}`, `${fmtNum(areaLatLng(roof.outline))} m²`, l._props.base ? `${fmtNum(l._props.base, 1)} m high` : 'height not known, set it below'];
      if (roof.holes.length) parts.push(`${count(roof.holes.length, 'opening', 'openings')} kept clear`);
      toast(`${parts.join(', ')}. Tables face ${fmtNum(own.azimuth, 0)}° at ${fmtNum(own.tilt, 0)}° tilt.`);
      editor(l, l.getBounds().getCenter());
    } catch (e) { toast(e.message, true); }
    finally { tracing = false; setPlacing(placing); }
  }
  // The traced outline (and openings in it) for review: used as a PV area, a building or an exclusion zone, or dropped.
  function showTrace(r) {
    clearPreview();
    preview = L.layerGroup().addTo(map);
    L.polygon(r.outline, { ...STYLE.preview, interactive: false }).addTo(preview);
    r.holes.forEach((h) => L.polygon(h, { ...STYLE.preview, dashArray: '2 3', interactive: false }).addTo(preview));
    const units = r.holes.length;
    const take = (type, props) => () => {
      const roof = $('#traceBase') ? clampTo(num($('#traceBase').value) || 0, LIMITS.base) : 0;
      if (type === 'site') addRoof(r.outline, r.holes, roof, 'traced', { units: !!($('#traceUnits') && $('#traceUnits').checked) });
      else addItem({ type, latlngs: r.outline, ...props, source: 'traced' });
      clearPreview();
      savePolys();
    };
    bar(`Traced roof, ${fmtNum(areaLatLng(r.outline))} m²${units ? `, ${count(units, 'opening', 'openings')} (rooftop units, skylights)` : ''}. Check it against the imagery.`, [
      ['PV area', take('site')], ['Building', take('obstacle', { kind: 'building', height: 6 })], ['Exclusion', take('exclusion', {})], ['Discard', clearPreview, 'btn small ghost'],
    ]);
    const extra = document.createElement('span');
    extra.className = 'hint';
    extra.innerHTML = `Roof height <input id="traceBase" type="number" min="0" max="500" step="0.5" value="0" style="width:60px"> m` +
      (units ? ` <label><input type="checkbox" id="traceUnits" checked> openings as units 1.5 m above the roof</label>` : '');
    $('#mapBar').append(extra);
  }

  return { init, reload, moveMarker, toDMS, refreshInfo: () => siteInfo(), scheduleRelayout, setShade, orientationOf, layoutUsed, footprint, cleanItem, cleanRemoved,
           invalidate: () => map && map.invalidateSize(), exitFullScreen: () => fullScreen(false) };
})();
