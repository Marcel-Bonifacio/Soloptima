// Site map and PV layout tool: go to coordinates, switch imagery (Esri / OSM / topo / Google), draw the
// available land and exclusions, then fill with module tables. Layout refreshes live as you edit.
'use strict';

const Layout = (() => {
  let map, marker, P, onChange, drawType = 'site', tablesLayer, polyLayers = [], baseLayers = {}, current = [];
  let relayoutTimer = null, view = 'leaflet';
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
    L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);

    marker = L.marker([P.location.lat, P.location.lon], { draggable: true, title: 'Site location' }).addTo(map);
    marker.on('dragend', () => setLocation(marker.getLatLng().lat, marker.getLatLng().lng, { fly: false }));
    const pmBusy = () => map.pm.globalDrawModeEnabled() || map.pm.globalEditModeEnabled() || map.pm.globalDragModeEnabled() || map.pm.globalRemovalModeEnabled() || map.pm.globalRotateModeEnabled();
    map.on('click', (e) => { if (!pmBusy()) setLocation(e.latlng.lat, e.latlng.lng); });
    map.on('mousemove', (e) => { $('#cursorPos').textContent = `Cursor ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}  ·  ${toDMS(e.latlng.lat, e.latlng.lng)}  ·  zoom ${map.getZoom()}`; });

    map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false,
                         drawText: false, drawPolygon: false, drawRectangle: false, cutPolygon: false, rotateMode: true });
    map.pm.setGlobalOptions({ snappable: true, allowSelfIntersection: false });
    map.on('pm:create', (e) => { addPoly(e.layer, drawType); $('#drawInfo').hidden = true; savePolys(); });
    map.on('pm:remove', (e) => { polyLayers = polyLayers.filter((l) => l !== e.layer); if (!polyLayers.some((l) => l._ptype === 'site')) { tablesLayer.clearLayers(); P.layout.result = null; renderStats(); } savePolys(); });
    map.on('pm:drawstart', ({ workingLayer }) => {
      $('#drawInfo').hidden = false; $('#drawInfo').textContent = 'Click to add corners · double-click or click the first point to finish';
      workingLayer.on('pm:vertexadded', () => {
        const pts = workingLayer.getLatLngs().map((p) => [p.lat, p.lng]);
        if (pts.length >= 3) $('#drawInfo').textContent = `${pts.length} corners · ${fmtNum(areaLatLng(pts) / 1e4, 2)} ha so far`;
      });
    });
    map.on('pm:drawend', () => setTimeout(() => ($('#drawInfo').hidden = true), 300));

    $('#btnDrawSite').onclick = () => startDraw('site');
    $('#btnDrawExcl').onclick = () => startDraw('exclusion');
    $('#btnClearPoly').onclick = () => {
      if (polyLayers.length && !confirm('Remove all drawn areas and the layout?')) return;
      polyLayers.forEach((l) => map.removeLayer(l)); polyLayers = []; tablesLayer.clearLayers(); P.layout.result = null; savePolys(); renderStats();
    };
    $('#btnLayout').onclick = run;
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fullScreen(false); });
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
  function toDMS(lat, lon) {
    const f = (v, pos, neg) => { const t = Math.round(Math.abs(v) * 36000), d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`; };
    return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
  }

  // ---------------------------------------------------------------- polygons
  function startDraw(type) {
    if (view !== 'leaflet') setView('leaflet');
    drawType = type;
    map.pm.enableDraw('Polygon', { templineStyle: { color: type === 'site' ? '#eda100' : '#e34948' },
                                   hintlineStyle: { color: type === 'site' ? '#eda100' : '#e34948', dashArray: [5, 5] },
                                   pathOptions: style(type) });
  }
  const style = (type) => type === 'site' ? { color: '#eda100', weight: 2, fillOpacity: 0.06 } : { color: '#e34948', weight: 2, fillOpacity: 0.25, dashArray: '6 4' };
  function addPoly(layer, type) {
    layer._ptype = type;
    layer.setStyle(style(type));
    const upd = () => { label(layer); savePolys(); };
    layer.on('pm:edit', upd);
    layer.on('pm:markerdrag', () => label(layer));
    polyLayers.push(layer);
    label(layer);
  }
  function label(layer) {
    const pts = layer.getLatLngs()[0].map((p) => [p.lat, p.lng]);
    const txt = `${layer._ptype === 'site' ? 'PV area' : 'Exclusion'} · ${fmtNum(areaLatLng(pts) / 1e4, 2)} ha`;
    if (layer.getTooltip()) layer.setTooltipContent(txt);
    else layer.bindTooltip(txt, { permanent: true, direction: 'center', className: 'poly-label' });
  }
  function savePolys() {
    P.layout.polygons = polyLayers.map((l) => ({ type: l._ptype, latlngs: l.getLatLngs()[0].map((p) => [p.lat, p.lng]) }));
    onChange('layout.polygons');
    scheduleRelayout();
  }
  function scheduleRelayout() {
    if (!$('#autoLayout').checked) return;
    if (!(P.layout.polygons || []).some((p) => p.type === 'site')) return;
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(run, 350);
  }
  function restore(lookup = true) {
    (P.layout.polygons || []).forEach((pg) => { const l = L.polygon(pg.latlngs).addTo(map); addPoly(l, pg.type); });
    if (polyLayers.length) map.fitBounds(L.featureGroup(polyLayers).getBounds(), { padding: [30, 30] });
    if (P.layout.result && P.layout.result.tables && P.layout.result.tables.length) draw(P.layout.result.tables);
    else if (polyLayers.some((l) => l._ptype === 'site')) setTimeout(run, 100);
    renderStats();
    if (lookup) siteInfo();
  }
  function reload(project) {
    P = project;
    polyLayers.forEach((l) => map.removeLayer(l)); polyLayers = []; tablesLayer.clearLayers();
    marker.setLatLng([P.location.lat, P.location.lon]);
    map.setView([P.location.lat, P.location.lon], 15);
    $('#baseLayer').value = P.layout.base || 'esri'; setBase(P.layout.base || 'esri');
    restore(); updateExternal();
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
  const area = (poly) => { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); };
  function areaLatLng(pts) {
    const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length, lon0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return area(pts.map(projector(lat0, lon0).fwd));
  }

  function run() {
    const sites = (P.layout.polygons || []).filter((p) => p.type === 'site');
    if (!sites.length) { toast('Draw at least one PV area first.', true); return; }
    const excl = (P.layout.polygons || []).filter((p) => p.type === 'exclusion');
    const all = sites.flatMap((s) => s.latlngs);
    const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length, lon0 = all.reduce((a, p) => a + p[1], 0) / all.length;
    const pr = projector(lat0, lon0);
    const S = sites.map((s) => s.latlngs.map(pr.fwd)), X = excl.map((s) => s.latlngs.map(pr.fwd));

    const pv = P.pv, lay = P.layout;
    const portrait = lay.orientation === 'portrait';
    const slant = lay.modules_across * (portrait ? pv.module_length : pv.module_width);
    const along = lay.modules_per_table * (portrait ? pv.module_width : pv.module_length) + 0.02 * lay.modules_per_table;
    const tracker = pv.mount === 'tracker';
    const depth = tracker ? slant : slant * Math.cos((pv.tilt || 0) * Math.PI / 180);
    const pitch = slant / Math.max(0.05, pv.gcr);
    const az = tracker ? pv.tracker_axis_azimuth : (pv.azimuth_auto ? (P.location.lat >= 0 ? 180 : 0) : pv.azimuth);
    const r = tracker ? [Math.sin(az * Math.PI / 180), Math.cos(az * Math.PI / 180)] : [Math.cos(az * Math.PI / 180), -Math.sin(az * Math.PI / 180)];
    const f = [-r[1], r[0]];
    const toUV = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]];
    const toXY = ([u, v]) => [u * r[0] + v * f[0], u * r[1] + v * f[1]];

    const tables = [];
    const setback = lay.setback || 0;
    for (const site of S) {
      const uv = site.map(toUV);
      const umin = Math.min(...uv.map((p) => p[0])), umax = Math.max(...uv.map((p) => p[0]));
      const vmin = Math.min(...uv.map((p) => p[1])), vmax = Math.max(...uv.map((p) => p[1]));
      for (let v = vmin + setback; v + depth <= vmax - setback + 1e-6; v += pitch) {
        for (let u = umin + setback; u + along <= umax - setback + 1e-6;) {
          const corners = [[u, v], [u + along, v], [u + along, v + depth], [u, v + depth]].map(toXY);
          const probes = corners.concat([toXY([u + along / 2, v + depth / 2]), toXY([u + along / 2, v]), toXY([u + along / 2, v + depth])]);
          const ok = probes.every((p) => inPoly(p, site)) && !edgesCross(corners, site) && (setback <= 0 || corners.every((p) => distToEdges(p, site) >= setback)) &&
                     !X.some((x) => probes.some((p) => inPoly(p, x)) || x.some((q) => inPoly(q, corners)) || edgesCross(corners, x));
          if (ok) { tables.push(corners.map(pr.inv)); u += along + (lay.table_gap || 0); }
          else u += Math.max(0.5, along / 8);
        }
      }
    }
    const modules = tables.length * lay.modules_across * lay.modules_per_table;
    const siteArea = S.reduce((a, s) => a + area(s), 0), exclArea = X.reduce((a, s) => a + area(s), 0);
    P.layout.result = { tables: tables.length <= MAX_LAYOUT_TABLES ? tables.map((t) => t.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)])) : [],
                        n_tables: tables.length, modules, kwp: modules * pv.module_wp / 1000, site_m2: siteArea, excl_m2: exclArea, pitch, slant, along, depth };
    draw(tables);
    renderStats();
    onChange('layout.result');
  }

  function draw(tables) {
    tablesLayer.clearLayers();
    const st = { renderer: canvas, color: '#2a78d6', weight: 0.6, fillColor: '#3987e5', fillOpacity: 0.7, interactive: false, pmIgnore: true };
    if (tables.length) L.polygon(tables.slice(0, MAX_LAYOUT_TABLES).map((t) => [t]), st).addTo(tablesLayer);
  }

  function renderStats() {
    const R = P.layout.result, box = $('#layoutStats');
    if (!R) { box.innerHTML = '<p class="hint">No layout yet. Draw a PV area, then press "Fill area with tables" or keep auto-update on.</p>'; return; }
    const net = (R.site_m2 - R.excl_m2) / 1e4;
    box.innerHTML = `<div class="kpis">${kpis([
      ['Max DC capacity', fmtPower(R.kwp).replace('kW', 'kWp').replace('MW', 'MWp'), `${fmtNum(R.modules)} modules`, true],
      ['Tables', fmtNum(R.n_tables), `${fmtNum(R.along || 0, 1)} × ${fmtNum(R.slant, 2)} m`],
      ['Net area', `${fmtNum(net, 1)} ha`, `${fmtNum(R.excl_m2 / 1e4, 1)} ha excluded`],
      ['Power density', fmtNum(net > 0 ? R.kwp / 1000 / net : 0, 2), `MWp/ha · pitch ${fmtNum(R.pitch, 1)} m`]])}</div>
      <div class="row gap"><button class="btn small" id="useCap">Use as PV capacity</button><button class="btn small" id="useLim">Use as optimiser land limit</button></div>`;
    $('#useCap').onclick = () => { P.pv.capacity_kwp = Math.round(R.kwp); syncForms(P); onChange('pv.capacity_kwp'); toast('PV capacity set to ' + fmtNum(R.kwp) + ' kWp'); };
    $('#useLim').onclick = () => { P.optimizer.max_pv_kwp = Math.round(R.kwp); if (!P.optimizer.pv_max || P.optimizer.pv_max > R.kwp) P.optimizer.pv_max = Math.round(R.kwp); syncForms(P); onChange('optimizer.max_pv_kwp'); toast('Optimiser PV limit set to ' + fmtNum(R.kwp) + ' kWp'); };
  }

  return { init, reload, moveMarker, refreshInfo: () => siteInfo(), scheduleRelayout, invalidate: () => map && map.invalidateSize(), exitFullScreen: () => fullScreen(false) };
})();
