// The site map of the Site & layout page: the Leaflet map (web/vendor/leaflet.js and Geoman, globals) with its imagery, the
// site marker and location, the place search, the address lookup, the Google Maps view and full screen. The drawn items and
// the tables are in edit.svelte.js, files, OpenStreetMap, the user's own image and roof tracing in tools.svelte.js.
// `lay` is what the components show; `M` holds the map and its layers (not Svelte state: Leaflet objects are not proxied).
import { mount, unmount } from 'svelte';
import { legacy } from '../legacy.js';
import { parseCoords, toDMS, km, wrapLon } from './coords.js';
import { fmtOffset } from '../format.js';
import { wire, setPlacing, undo, redo, restore, clearItems, mapClicked, roofClicked } from './edit.svelte.js';
import { dropImage, clearPreview } from './tools.svelte.js';

export const lay = $state({
  rev: 0,             // bumped after every change of the items, the tables, the shade or the site (the cards read it)
  view: 'leaflet',    // leaflet | google
  base: 'esri',
  full: false,
  placing: null,      // null | tree | trace | align | remove | move | drag
  info: '',           // the line over the map that says what a click does
  cursor: 'Move the mouse over the map',
  canUndo: false, canRedo: false, removed: 0,
  picks: null,        // places of the same name to pick from: [{ lat, lon, name }]
  bar: null,          // the bar over the map for a preview: { text, actions: [[label, fn, cls]], trace: { units } for a traced roof }
  traceBase: 0, traceUnits: true,
  ortho: null,        // the user's own image: { text }
  opacity: 1,
  osmBusy: false,
  auto: true,         // fill again after every edit
  showShade: true,    // colour the tables by their shade
  emptyAreas: 0,      // PV areas that take no table
  addr: '',           // the site's address; null while it is looked up
  gmaps: '',          // link to the site in Google Maps
  gmapSrc: '',        // the Google Maps view
});
export const M = { map: null, marker: null, tables: null, ghosts: null, canvas: null, base: {}, current: [] };
export const P = () => legacy.project();
export const bump = () => { lay.rev++; };
export const toast = (msg, err) => legacy.toast(msg, err);

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
// A text node for Leaflet's tooltips and popups, which put strings in as HTML
export const text = (s) => document.createTextNode(String(s));

// The map, in the element of MapCard. The project arrives later (reload).
export function init(el) {
  const L = window.L;
  const map = M.map = L.map(el, { zoomControl: true, maxZoom: 21 }).setView([0, 0], 2);
  M.canvas = L.canvas({ padding: 0.5 });
  const tile = (url, o) => L.tileLayer(url, { maxZoom: 21, maxNativeZoom: 19, ...o });
  const esriImg = () => tile(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community' });
  M.base.esri = [esriImg()];
  M.base.hybrid = [esriImg(), tile(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'),
    tile(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}')];
  M.base.osm = [tile('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' })];
  M.base.topo = [tile('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxNativeZoom: 17, attribution: '© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)' })];
  M.tables = L.layerGroup().addTo(map);
  M.ghosts = L.layerGroup().addTo(map);   // outlines of the tables taken out by hand, shown while removing tables
  L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);
  map.createPane('ortho').style.zIndex = 250;   // own imagery above the base map, under the drawn items

  M.marker = L.marker([0, 0], { draggable: true, title: 'Site location' }).addTo(map);
  M.marker.on('dragend', () => { const p = M.marker.getLatLng(); setLocation(p.lat, p.lng, { fly: false }); });
  map.on('click', mapClicked);
  // Ctrl+click (Cmd+click on a Mac, where Ctrl+click arrives as a context-menu event) lays out the roof under the pointer,
  // on whatever layer it lands: caught on the way down, before the layers see it.
  const roofClick = (e) => {
    if (!(e.ctrlKey || e.metaKey) || pmBusy() || e.target.closest('.leaflet-control, .leaflet-popup')) return;
    e.preventDefault();
    e.stopPropagation();
    roofClicked(map.mouseEventToLatLng(e));
  };
  map.getContainer().addEventListener('click', roofClick, true);
  map.getContainer().addEventListener('contextmenu', roofClick, true);
  map.on('mousemove', (e) => { lay.cursor = `Cursor ${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}  ·  ${toDMS(e.latlng.lat, e.latlng.lng)}  ·  zoom ${map.getZoom()}`; });

  map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawCircle: false,
                       drawText: false, drawPolygon: false, drawRectangle: false, cutPolygon: false, rotateMode: true });
  map.pm.setGlobalOptions({ snappable: true, allowSelfIntersection: false });
  wire(map);

  document.addEventListener('keydown', (e) => {   // Ctrl+Z / Cmd+Z undoes, with Shift (or Ctrl+Y) redoes, while the map is showing
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { fullScreen(false); setPlacing(null); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey || (k !== 'z' && k !== 'y') || !map.getContainer().offsetParent) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
  });
  window.addEventListener('hashchange', () => fullScreen(false));
}
export const pmBusy = () => { const pm = M.map.pm; return pm.globalDrawModeEnabled() || pm.globalEditModeEnabled() || pm.globalDragModeEnabled() || pm.globalRemovalModeEnabled() || pm.globalRotateModeEnabled(); };
export const invalidate = () => { if (M.map) M.map.invalidateSize(); };

// The open project on the map: its site, imagery, items and tables. lookup: find the site's address (not for the placeholder
// project the workspace holds before one opens).
export function reload(lookup = true) {
  const p = P();
  if (!M.map || !p) return;
  clearItems();
  clearPreview(); setPlacing(null); dropImage();
  M.marker.setLatLng([p.location.lat, p.location.lon]);
  M.map.setView([p.location.lat, p.location.lon], 15);
  setBase(p.layout.base || 'esri');
  restore();
  updateExternal();
  if (lookup) siteInfo(); else lay.addr = '';
  bump();
}

// Full-screen map. The page under it is made inert, so keyboard focus cannot reach controls hidden under the map.
export function fullScreen(on) {
  if (lay.full === on) return;
  lay.full = on;
  document.querySelectorAll('.skip, .topbar, #nav, #tab-site > :not(.map-grid), #mapCard ~ *').forEach((el) => (el.inert = on));
  setTimeout(invalidate, 50);
}

// ---------------------------------------------------------------- imagery
export async function setBase(name) {
  const L = window.L, p = P();
  if (name.startsWith('google')) {
    const key = (p.layout.google_key || '').trim();
    if (!key) {
      toast('Google imagery inside the layout map needs a Google Maps API key (Map Tiles API). Without a key use the "Google Maps" view tab.', true);
      name = 'esri';
    } else {
      try {
        const req = { google: { mapType: 'satellite' }, google_hybrid: { mapType: 'satellite', layerTypes: ['layerRoadmap'] }, google_road: { mapType: 'roadmap' } }[name];
        const r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req, language: 'en-US', region: 'US' }) });
        const j = await r.json();
        if (!j.session) throw new Error(j.error ? j.error.message : 'no session');
        M.base[name] = [L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(j.session)}&key=${encodeURIComponent(key)}`,
          { maxZoom: 22, maxNativeZoom: 21, attribution: 'Map data © Google' })];
      } catch (e) { toast('Google Map Tiles: ' + e.message, true); name = 'esri'; }
    }
  }
  lay.base = name;
  M.current.forEach((l) => M.map.removeLayer(l));
  M.current = M.base[name] || M.base.esri;
  M.current.forEach((l) => l.addTo(M.map));
}
// The imagery picked in the toolbar, kept with the project: the one that could be shown (Esri when Google has no key)
export async function pickBase(name) {
  await setBase(name);
  P().layout.base = lay.base;
  legacy.onFieldChange('layout.base');
}

export function setView(v) {
  lay.view = v;
  if (v === 'google') updateExternal(true); else setTimeout(invalidate, 30);
}
// Google Maps embed (no key needed) and the external link, kept in sync with the site location.
export function updateExternal(force) {
  const { lat, lon } = P().location;
  lay.gmaps = `https://www.google.com/maps/@${lat},${lon},700m/data=!3m1!1e3`;
  if (lay.view === 'google' || force) {
    const z = M.map ? Math.min(20, M.map.getZoom()) : 17;
    lay.gmapSrc = `https://www.google.com/maps/embed?origin=mfe&pb=!1m4!2m1!1s${+lat},${+lon}!5e1!6i${z}`;
  }
}

// ---------------------------------------------------------------- location
export async function goTo(q) {
  lay.picks = null;
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
export function showPicks(list) {
  lay.picks = list;
  if (lay.full) setTimeout(invalidate, 0);   // the list changes the map height
}
export function pick(x) {
  showPicks(null);
  if (x) setLocation(x.lat, x.lon, { fly: true, zoom: 14 });
}
// Time zone of the site from the offline lookup: its standard offset becomes the UTC offset. A typed offset is kept while
// the site stays in the same zone; without a zone the offset falls back to the longitude.
function applyZone() {
  const L = P().location, z = legacy.siteZone(L.lat, L.lon), same = (z ? z.tz : '') === L.tz, off = fmtOffset;
  L.tz = z ? z.tz : '';
  if (L.utc_offset_src === 'typed' && same) return;
  if (z) {
    if (L.utc_offset_src === 'typed' && Math.abs(L.utc_offset - z.std) > 1e-9) toast(`The site is now in ${z.tz}: UTC offset set to ${off(z.std)} instead of the typed ${off(L.utc_offset)}.`);
    L.utc_offset = z.std; L.utc_offset_src = 'zone';
  } else {
    L.utc_offset = Math.round(L.lon / 15); L.utc_offset_src = 'longitude';
    toast(`No time zone found for this location: UTC offset set to ${off(L.utc_offset)} from the longitude. Check it.`, true);
  }
}
export function setLocation(lat, lon, opts = {}) {
  const loc = P().location;
  loc.lat = +(+lat).toFixed(6); loc.lon = +wrapLon(lon).toFixed(6);
  applyZone();
  M.marker.setLatLng([lat, lon]);
  if (opts.fly) M.map.flyTo([lat, lon], opts.zoom || 17, { duration: 1.2 });
  legacy.onFieldChange('location');
  updateExternal(); siteInfo();
}
// Latitude or longitude typed into the Location form
export function moveMarker() {
  const loc = P().location;
  applyZone(); legacy.syncForms();
  M.marker.setLatLng([loc.lat, loc.lon]);
  M.map.flyTo([loc.lat, loc.lon], Math.max(M.map.getZoom(), 16), { duration: 1.0 });
  updateExternal(); siteInfo();
}
// "Use" the zone's standard offset, or "keep" the offset as it is
export function zoneChoice(choice) {
  const L = P().location, { z } = legacy.zoneCheck(L);
  if (choice === 'use' && z) { L.utc_offset = z.std; L.utc_offset_src = 'zone'; legacy.onFieldChange('location'); }
  if (choice === 'keep') { L.utc_offset_src = 'typed'; legacy.onFieldChange('location.utc_offset_src'); }
  bump();
}

// The site's address from the reverse lookup, once the site has stayed put for a moment
let infoTimer, place = null;   // the last address found: { lat, lon, name }
export function siteInfo() {
  const { lat, lon } = P().location;
  bump();
  if (place && place.lat === lat && place.lon === lon) { lay.addr = place.name; return; }
  lay.addr = null;
  clearTimeout(infoTimer);
  infoTimer = setTimeout(async () => {
    let name = '';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${+lat}&lon=${+lon}`);
      name = String((await r.json()).display_name || '');
      place = { lat, lon, name };
      const box = document.createElement('div'), b = document.createElement('b');
      b.textContent = 'Site';
      box.append(b, document.createElement('br'), text(`${lat.toFixed(5)}, ${lon.toFixed(5)}`), document.createElement('br'), text(name));
      M.marker.bindPopup(box);
    } catch (e) { /* offline: no address */ }
    const now = P().location;
    if (now.lat === lat && now.lon === lon) lay.addr = name;
  }, 700);
}

// ---------------------------------------------------------------- popups and messages
// A Svelte component in a Leaflet popup at `at`, unmounted when the popup closes
export function popup(at, Component, props, opts = {}) {
  const el = document.createElement('div'), c = mount(Component, { target: el, props });
  const p = window.L.popup({ className: 'edit-popup', ...opts }).setLatLng(at).setContent(el);
  p.on('remove', () => setTimeout(() => unmount(c), 0));
  p.openOn(M.map);
  return p;
}
export const closePopup = () => M.map.closePopup();
// The line over the map that says what a click does; hidden without a message.
export const info = (msg) => { lay.info = msg || ''; };
