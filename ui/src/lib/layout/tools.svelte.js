// Items from outside the map: KML, KMZ and GeoJSON files in and out, building outlines from OpenStreetMap, the user's own
// image (orthophoto with its world file), roof tracing on it and the assisted roof layout (Ctrl+click).
import { saveFile } from '../ipc.js';
import { lay, M, P, toast, popup, closePopup, info, setView } from './map.svelte.js';
import { addItem, removeItem, savePolys, setPlacing, editor, layers, kindOf, latlngsOf } from './edit.svelte.js';
import { STYLE, LIMITS, num, clampTo, importedItems, alignedAzimuth } from './items.js';
import { inPoly, boxOf, areaLatLng } from './geometry.js';
import { read as readGeo, toGeoJSON, toKML, osmBuildings } from './geodata.js';
import * as Ortho from './ortho.js';
import { traceRoof } from './rooftrace.js';
import { fmtNum, plural } from '../format.js';
import OsmPick from '../../screens/layout/OsmPick.svelte';

const OSM_ATTR = 'Buildings © OpenStreetMap contributors (ODbL)';
let preview = null, ortho = null, tracing = false, osmSeen = [];

// ---------------------------------------------------------------- files
export async function importFile(file, as) {
  let r;
  try { r = await readGeo(file); } catch (e) { toast(`${file.name}: ${e.message}`, true); return; }
  if (!r.items.length) { toast(`${file.name}: no areas or points found.`, true); return; }
  const added = importedItems(r.items, as).map(addItem);
  if (!added.length) { toast(`${file.name}: nothing to import (tables are filled again from the areas).`, true); return; }
  savePolys();
  M.map.fitBounds(window.L.featureGroup(added).getBounds(), { padding: [30, 30] });
  const n = (k, one, many) => plural(added.filter((l) => kindOf(l) === k).length, one, many);
  toast(`Imported from ${file.name}: ${[n('site', 'PV area', 'PV areas'), n('exclusion', 'exclusion zone', 'exclusion zones'), n('building', 'building', 'buildings'), n('tree', 'tree', 'trees')].filter((x) => !x.startsWith('0 ')).join(', ')}` +
        (r.skipped ? `; ${r.skipped} shapes skipped (fewer than 3 corners or out of range)` : '') + '. Check the heights of buildings and trees.');
}
export function exportLayout(fmt) {
  const p = P();
  if (!layers().length) { toast('Nothing drawn to export yet.', true); return; }
  const name = String(p.name || 'layout').replace(/[^\w\- ]+/g, '_');
  if (fmt === 'kml') saveFile(`${name}.kml`, toKML(p.layout, p.name || 'Layout'), 'application/vnd.google-earth.kml+xml');
  else saveFile(`${name}.geojson`, toGeoJSON(p.layout), 'application/geo+json');
}

// ---------------------------------------------------------------- previews
// A preview layer of candidates (OSM buildings, a traced roof) with a bar of actions over the map.
export function clearPreview() {
  if (preview) { M.map.removeLayer(preview); preview = null; }
  if (M.map) M.map.attributionControl.removeAttribution(OSM_ATTR);
  lay.bar = null;
}
const bar = (text, actions, trace = null) => { lay.bar = { text, actions, trace }; };

export async function loadOsm() {
  if (lay.view !== 'leaflet') setView('leaflet');
  const b = M.map.getBounds(), s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
  if (areaLatLng([[s, w], [s, e], [n, e], [n, w]]) > 4e6) { toast('Zoom in to an area of 4 km² or less to load its buildings.', true); return; }
  lay.osmBusy = true;
  try { showOsm(await osmBuildings(s, w, n, e)); } catch (err) { toast('OpenStreetMap buildings: ' + err.message, true); }
  finally { lay.osmBusy = false; }
}
function showOsm(list) {
  clearPreview();
  if (!list.length) { toast('OpenStreetMap has no buildings in this view.'); return; }
  osmSeen = osmSeen.concat(list);
  const L = window.L;
  preview = L.layerGroup().addTo(M.map);
  M.map.attributionControl.addAttribution(OSM_ATTR);
  const taken = new Set(layers().filter((l) => !(l instanceof L.Circle)).map((l) => latlngsOf(l)[0].join(',')));
  const fresh = list.filter((bd) => !taken.has(bd.latlngs[0].join(',')));
  const asBuilding = (bd) => addItem({ type: 'obstacle', kind: 'building', height: bd.height || 6, latlngs: bd.latlngs, source: 'osm' });
  fresh.forEach((bd) => {
    const l = L.polygon(bd.latlngs, { ...STYLE.osm, bubblingMouseEvents: false }).addTo(preview);
    l.on('click', (ev) => {
      const use = (fn) => () => { closePopup(); if (preview) preview.removeLayer(l); fn(); savePolys(); };
      popup(ev.latlng, OsmPick, { height: bd.height, actions: [
        ['Roof as PV area', use(() => addRoof(bd.latlngs, [], bd.height, 'osm'))],
        ['Building', use(() => asBuilding(bd))],
        ['Exclusion zone', use(() => addItem({ type: 'exclusion', latlngs: bd.latlngs, source: 'osm' }))]] });
    });
  });
  const unknown = fresh.filter((bd) => !bd.height).length;
  bar(`${plural(fresh.length, 'building')} from OpenStreetMap${unknown ? `, ${fmtNum(unknown)} without a height (6 m taken)` : ''}. Click one to use it, or:`, [
    ['Add all as buildings', () => { fresh.forEach(asBuilding); clearPreview(); savePolys(); }],
    ['Those in PV areas as exclusions', () => {
      const sites = layers().filter((l) => l._ptype === 'site').map(latlngsOf);
      const inside = fresh.filter((bd) => { const b = boxOf(bd.latlngs), c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; return sites.some((sp) => inPoly(c, sp)); });
      inside.forEach((bd) => addItem({ type: 'exclusion', latlngs: bd.latlngs, source: 'osm' }));
      clearPreview(); savePolys();
      toast(`${plural(inside.length, 'building')} inside PV areas added as exclusion zones.`);
    }],
    ['Close', clearPreview, 'btn small ghost'],
  ]);
}

// ---------------------------------------------------------------- own imagery
// The user's orthophoto as an overlay, with a line under the map: its file, ground resolution and coordinate system, an
// opacity slider and removal.
export async function loadImage(files) {
  let im;
  try { im = await Ortho.load(files, P().location); } catch (e) { toast('Own image: ' + e.message, true); return; }
  dropImage();
  ortho = { im, layer: Ortho.layer(im, { pane: 'ortho', interactive: false }).addTo(M.map), src: Ortho.source(im) };
  M.map.fitBounds(im.bounds, { padding: [20, 20] });
  lay.opacity = 1;
  lay.ortho = { text: `${im.name}, ${fmtNum(im.mpp * 100, 1)} cm per pixel, ${Ortho.crsLabel(im.crs)}` };
  toast(`${im.name} placed by its world file in ${Ortho.crsLabel(im.crs)}. Check that it lines up with the map; Trace roof now reads it.`);
}
export function setOpacity(v) { lay.opacity = v; if (ortho) ortho.layer.setOpacity(v); }
export function dropImage() {
  if (ortho) { M.map.removeLayer(ortho.layer); ortho.im.canvas.width = 0; }   // a zero-size canvas frees its pixels
  ortho = null;
  lay.ortho = null;
}

// ---------------------------------------------------------------- roofs
// Roof tracing reads only the user's own image: Esri's and Google's terms do not allow deriving outlines from their imagery.
export function traceAt(ll) {
  if (!ortho) { toast('Roof tracing reads your own image: load a drone or survey image with its world file (Own image…) first.', true); return; }
  if (!ortho.layer.getBounds().contains(ll)) { toast('Click a roof inside your own image.', true); return; }
  if (tracing) return;
  tracing = true;
  info('Tracing the roof…');
  const src = ortho.src;
  setTimeout(() => {   // let the message show before the work
    try { showTrace(traceOwn(ll, src)); } catch (e) { toast(e.message, true); }
    finally { tracing = false; setPlacing(lay.placing); }
  }, 30);
}
// The roof traced at ll on the user's image; throws the reason when there is none.
function traceOwn(ll, src) {
  const r = traceRoof(ll.lat, ll.lng, src);
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
async function osmBuildingAt(ll) {
  const pt = [ll.lat, ll.lng], at = () => osmSeen.find((bd) => inPoly(pt, bd.latlngs)) || null;
  if (at()) return at();
  const d = 0.002, s = Math.floor(ll.lat / d) * d, w = Math.floor(ll.lng / d) * d;
  osmSeen = osmSeen.concat(await osmBuildings(s, w, s + d, w + d));
  return at();
}
// Assisted roof layout (Ctrl+click): the roof under the click becomes a PV area at its height, tables at the project tilt
// and square to its longest side. Outline from a drawn building, else the user's own image, else OpenStreetMap.
export async function roofLayout(ll) {
  if (tracing) return;
  if (lay.view !== 'leaflet') setView('leaflet');
  setPlacing(null);
  tracing = true;
  info('Laying out the roof…');
  try {
    const pt = [ll.lat, ll.lng], roof = { holes: [] };
    const drawn = layers().find((l) => kindOf(l) === 'building' && inPoly(pt, latlngsOf(l)));
    if (drawn) {
      Object.assign(roof, { outline: latlngsOf(drawn), height: drawn._props.height, source: drawn._props.source, from: 'the building drawn there' });
      removeItem(drawn);
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
    const p = P(), own = { tilt: clampTo(p.pv.tilt || 0, LIMITS.tilt), azimuth: alignedAzimuth(roof.outline, false, p.location.lat) };
    const l = addRoof(roof.outline, roof.holes, roof.height, roof.source, { own });
    clearPreview();
    savePolys();
    const parts = [`Roof from ${roof.from}`, `${fmtNum(areaLatLng(roof.outline))} m²`, l._props.base ? `${fmtNum(l._props.base, 1)} m high` : 'height not known, set it below'];
    if (roof.holes.length) parts.push(`${plural(roof.holes.length, 'opening')} kept clear`);
    toast(`${parts.join(', ')}. Tables face ${fmtNum(own.azimuth, 0)}° at ${fmtNum(own.tilt, 0)}° tilt.`);
    editor(l, l.getBounds().getCenter());
  } catch (e) { toast(e.message, true); }
  finally { tracing = false; setPlacing(lay.placing); }
}
// The traced outline (and openings in it) for review: used as a PV area, a building or an exclusion zone, or dropped.
function showTrace(r) {
  clearPreview();
  const L = window.L;
  preview = L.layerGroup().addTo(M.map);
  L.polygon(r.outline, { ...STYLE.preview, interactive: false }).addTo(preview);
  r.holes.forEach((h) => L.polygon(h, { ...STYLE.preview, dashArray: '2 3', interactive: false }).addTo(preview));
  const units = r.holes.length;
  lay.traceBase = 0; lay.traceUnits = true;
  const take = (type, props) => () => {
    const roof = clampTo(num(lay.traceBase) || 0, LIMITS.base);
    if (type === 'site') addRoof(r.outline, r.holes, roof, 'traced', { units: units > 0 && lay.traceUnits });
    else addItem({ type, latlngs: r.outline, ...props, source: 'traced' });
    clearPreview();
    savePolys();
  };
  bar(`Traced roof, ${fmtNum(areaLatLng(r.outline))} m²${units ? `, ${plural(units, 'opening')} (rooftop units, skylights)` : ''}. Check it against the imagery.`, [
    ['PV area', take('site')], ['Building', take('obstacle', { kind: 'building', height: 6 })], ['Exclusion', take('exclusion', {})], ['Discard', clearPreview, 'btn small ghost'],
  ], { units });
}
