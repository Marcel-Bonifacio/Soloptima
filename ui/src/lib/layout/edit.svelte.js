// The drawn items of the layout map (PV areas, exclusion zones and paths, buildings and trees), what a click on the map does,
// moving corners and shapes, undo and redo, the fill with tables, the tables taken out by hand and the shade on the tables.
// Each item is a Leaflet layer with its type in _ptype and its other saved fields in _props; P.layout.polygons is saved from them.
import { setSunShade } from '../plant.svelte.js';
import { lay, M, P, bump, toast, text, popup, closePopup, info, pmBusy, setView, setLocation } from './map.svelte.js';
import { STYLE, cleanItem, cleanRemoved, itemLabel, followPath, layoutUsed } from './items.js';
import { inPoly, stripOf, pathLength, areaLatLng } from './geometry.js';
import { fillLayout, keepOnly, alignShift, shadeFreeGcr, SHADE_CLASSES, MAX_LAYOUT_TABLES } from './fill.js';
import { fmtNum } from '../format.js';
import { traceAt, roofLayout } from './tools.svelte.js';
import ItemEditor from '../../screens/layout/ItemEditor.svelte';
import { onFieldChange } from '../ws/project.js';

let items = [], drawType = 'site', clickTimer = null, relayoutTimer = null, moving = null, aligning = null;
let history = [], future = [], restoring = false;
export const E = { shade: null };   // shade of the last yield calculation for the tables shown: { tables, ... } (setShade)

export const kindOf = (l) => (l._ptype === 'obstacle' ? l._props.kind : l._ptype);
export const latlngsOf = (layer) => layer.getLatLngs()[0].map((p) => [p.lat, p.lng]);
export const layers = () => items;
const hasSites = () => (P().layout.polygons || []).some((g) => g.type === 'site');

// Geoman's drawing: a polygon becomes the item being drawn, a line a keepout path of its width
export function wire(map) {
  map.on('pm:create', (e) => {
    if (e.shape === 'Line') {
      const path = e.layer.getLatLngs().map((p) => [+p.lat.toFixed(7), +p.lng.toFixed(7)]);
      map.removeLayer(e.layer);
      info('');
      if (path.length < 2) return;
      const l = addPoly(window.L.polygon(stripOf(path, 4)).addTo(map), 'exclusion', { kind: 'path', path, width: 4 });
      savePolys();
      editor(l, l.getBounds().getCenter());
      return;
    }
    const building = drawType === 'building';
    const l = addPoly(e.layer, building ? 'obstacle' : drawType, building ? { kind: 'building', height: 6 } : {});
    info('');
    savePolys();
    if (building) editor(l, l.getBounds().getCenter());
  });
  map.on('pm:remove', (e) => forget(e.layer));
  map.on('pm:drawstart', ({ workingLayer }) => {
    const line = drawType === 'path';
    info(line ? 'Click to add points along the path · double-click or click the last point to finish' : 'Click to add corners · double-click or click the first point to finish');
    workingLayer.on('pm:vertexadded', () => {
      const pts = workingLayer.getLatLngs().map((p) => [p.lat, p.lng]);
      if (line && pts.length >= 2) info(`${pts.length} points · ${fmtNum(pathLength(pts))} m so far`);
      else if (!line && pts.length >= 3) info(`${pts.length} corners · ${fmtNum(areaLatLng(pts) / 1e4, 2)} ha so far`);
    });
  });
  map.on('pm:drawend', () => setTimeout(() => info(''), 300));
}

export function startDraw(type) {
  if (lay.view !== 'leaflet') setView('leaflet');
  setPlacing(null);
  drawType = type;
  const s = STYLE[type === 'path' ? 'exclusion' : type];
  M.map.pm.enableDraw(type === 'path' ? 'Line' : 'Polygon', { templineStyle: { color: s.color }, hintlineStyle: { color: s.color, dashArray: [5, 5] }, pathOptions: s });
}

// What a click on the map does: places a tree, traces a roof, aligns tables, takes a table out or back, ends moving an item,
// or moves the site there
export function mapClicked(e) {
  if (pmBusy()) return;
  if (moving) setPlacing(null);
  else if (lay.placing === 'tree') addTree(e.latlng);
  else if (lay.placing === 'trace') traceAt(e.latlng);
  else if (lay.placing === 'align') alignAt(e.latlng);
  else if (lay.placing === 'remove') toggleTableAt(e.latlng);
  else setLocation(e.latlng.lat, e.latlng.lng);
}
export const roofClicked = (ll) => roofLayout(ll);

// ---------------------------------------------------------------- items
export function addPoly(layer, type, props = {}) {
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
    if (lay.placing && lay.placing !== 'move' && lay.placing !== 'drag') mapClicked(e);   // placing a tree, tracing, aligning or removing tables works over items too
    else if (!pmBusy() && !lay.placing) clickTimer = setTimeout(() => editor(layer, e.latlng), 250);
  });
  layer.on('dblclick', (e) => {
    clearTimeout(clickTimer);
    window.L.DomEvent.stop(e);   // no zoom
    if (!pmBusy() && (!lay.placing || moving)) setPlacing('move', layer);
  });
  items.push(layer);
  label(layer);
  return layer;
}
// Adds a saved item (cleanItem) to the map.
export function addItem(g) {
  const { type, latlngs, center, diameter, ...props } = g, L = window.L;
  return addPoly((center ? L.circle(center, { radius: diameter / 2 }) : L.polygon(latlngs)).addTo(M.map), type, props);
}
export function changed(layer) {
  if (layer._ptype === 'exclusion' && layer._props.kind === 'path') {
    const now = latlngsOf(layer);
    followPath(layer._props, layer._pts || now, now);
    layer._pts = now;
  }
  label(layer);
  savePolys();
}
export function removeItem(layer) {
  M.map.removeLayer(layer);
  forget(layer);
}
function forget(layer) {
  if (moving === layer) setPlacing(null);
  items = items.filter((l) => l !== layer);
  if (!items.some((l) => l._ptype === 'site')) { M.tables.clearLayers(); P().layout.result = null; P().layout.removed = []; }   // tables taken out belong to areas that are gone
  savePolys();
}
function label(layer) {
  const k = kindOf(layer), txt = itemLabel(P(), polyOf(layer));
  if (layer.getTooltip()) layer.setTooltipContent(text(txt));
  else layer.bindTooltip(text(txt), k === 'site' || k === 'exclusion' ? { permanent: true, direction: 'center', className: 'poly-label' } : { sticky: true, className: 'poly-label' });
}
export function polyOf(l) {
  const q = { type: l._ptype, ...l._props };
  if (l instanceof window.L.Circle) {
    const c = l.getLatLng();
    q.center = [+c.lat.toFixed(7), +c.lng.toFixed(7)];
    q.diameter = +(2 * l.getRadius()).toFixed(2);
  } else q.latlngs = latlngsOf(l);
  return q;
}
export function savePolys() {
  P().layout.polygons = items.map(polyOf);
  remember();
  onFieldChange('layout.polygons');
  scheduleRelayout();
  bump();
}
export function scheduleRelayout() {
  if (!lay.auto || !hasSites()) return;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(run, 350);
}
// The open project's items and tables on the map
export function restore() {
  (P().layout.polygons || []).forEach(addItem);
  history = [snapshot()]; future = [];
  updateUndo();
  if (items.length) M.map.fitBounds(window.L.featureGroup(items).getBounds(), { padding: [30, 30] });
  const R = P().layout.result;
  if (R && R.tables && R.tables.length) draw(R.tables);
  else if (items.some((l) => l._ptype === 'site')) setTimeout(run, 100);
  sunPath();
}
export function clearItems() {
  items.forEach((l) => M.map.removeLayer(l)); items = [];
  M.tables.clearLayers();
  E.shade = null; lay.emptyAreas = 0;
}
// The Clear button: every drawn item and the layout go
export function clearAll() {
  if (items.length && !confirm('Remove all drawn areas, buildings, trees and the layout?')) return;
  clearItems();
  P().layout.result = null; P().layout.removed = [];
  savePolys(); sunPath();
}

// Clicking places a tree, traces a roof, aligns tables or takes tables out until the button is pressed again or Esc.
// Moving a placed item, with the item: 'move' drags its corners (a tree's centre and crown), 'drag' the whole shape. Each
// change is saved as it is made (pm:edit); a click on the map, Esc or any other mode ends it.
export function setPlacing(mode, layer) {
  if (moving) { moving.pm.disable(); moving.pm.disableLayerDrag(); moving = null; }
  lay.placing = mode;
  aligning = mode === 'align' ? layer : null;
  if (mode === 'move' || mode === 'drag') {
    closePopup();
    moving = layer;
    if (mode === 'move') layer.pm.enable({ allowSelfIntersection: false, snappable: true, draggable: false });
    else layer.pm.enableLayerDrag();
  }
  drawGhosts();
  info({ tree: 'Click the map to place a tree · Esc to stop', trace: 'Click a roof to trace its outline · Esc to stop',
         align: 'Click where a table corner should sit · Esc to cancel',
         remove: 'Click a table to take it out, a dashed outline to put it back · Esc to stop',
         move: 'Drag the corners · click the map or Esc to finish', drag: 'Drag the shape · click the map or Esc to finish' }[mode]);
}
export const toggle = (mode) => setPlacing(lay.placing === mode ? null : mode);
function addTree(ll) {
  const l = addPoly(window.L.circle(ll, { radius: 3 }).addTo(M.map), 'obstacle', { kind: 'tree', height: 8 });
  savePolys();
  editor(l, ll);
}
// The editor of an item in a popup (ItemEditor.svelte)
export function editor(layer, at) {
  popup(at, ItemEditor, { layer }, { maxWidth: 340, maxHeight: Math.max(240, M.map.getSize().y - 120) });   // long editors scroll instead of running off the map
}
// Aligns the tables of the PV area being edited so a table corner sits at the click
function alignAt(ll) {
  const layer = aligning;
  setPlacing(null);
  if (!layer) return;
  Object.assign(layer._props, alignShift(P(), polyOf(layer), [ll.lat, ll.lng]));
  changed(layer);
  toast(`Tables aligned to the click: shifted ${fmtNum(layer._props.shift_u, 2)} m along the rows, first row ${fmtNum(layer._props.shift_v, 2)} m in.`);
}

// ---------------------------------------------------------------- the fill
export function run() {
  const p = P(), F = fillLayout(p);
  if (!F) { toast('Draw at least one PV area first.', true); return; }
  p.layout.result = F.result;
  lay.emptyAreas = F.emptyAreas;
  E.shade = null;
  draw(F.tables);
  bump();
  onFieldChange('layout.result');   // the yield is calculated again when the engine uses the layout, and brings the shade (setShade)
}
export function draw(tables) {
  M.tables.clearLayers();
  const L = window.L, st = { renderer: M.canvas, color: '#2a78d6', weight: 0.6, fillColor: '#3987e5', fillOpacity: 0.7, interactive: false, pmIgnore: true };
  const shown = tables.slice(0, MAX_LAYOUT_TABLES), shade = E.shade;
  if (!shown.length) return;
  if (!(lay.showShade && shade && shade.tables.length === tables.length)) { L.polygon(shown.map((t) => [t]), st).addTo(M.tables); return; }
  const byClass = SHADE_CLASSES.map(() => []);
  shown.forEach((t, i) => byClass[SHADE_CLASSES.findIndex(([lim]) => shade.tables[i] < lim)].push([t]));
  byClass.forEach((g, k) => { if (g.length) L.polygon(g, { ...st, color: SHADE_CLASSES[k][1], fillColor: SHADE_CLASSES[k][1] }).addTo(M.tables); });
}
export function showShade(on) {
  lay.showShade = on;
  const R = P().layout.result;
  if (R) draw(R.tables || []);
}
// "Use as PV capacity" and "Use as optimiser land limit"
export function useCapacity(what) {
  const p = P(), R = p.layout.result;
  if (!R) return;
  if (what === 'pv') {
    p.pv.capacity_kwp = Math.round(R.kwp);
    onFieldChange('pv.capacity_kwp');
    toast('PV capacity set to ' + fmtNum(R.kwp) + ' kWp');
  } else {
    p.optimizer.max_pv_kwp = Math.round(R.kwp);
    if (!p.optimizer.pv_max || p.optimizer.pv_max > R.kwp) p.optimizer.pv_max = Math.round(R.kwp);
    onFieldChange('optimizer.max_pv_kwp');
    toast('Optimiser PV limit set to ' + fmtNum(R.kwp) + ' kWp');
  }
}
export function shadeFree() {
  const p = P(), r = shadeFreeGcr(p);
  if (r.error) { toast(r.error, true); return; }
  p.pv.gcr = r.gcr;
  onFieldChange('pv.gcr');
  toast(`GCR ${r.gcr.toFixed(2)}: rows ${fmtNum(r.slant / r.gcr, 1)} m apart stay clear of each other's shadow from ${fmtNum(p.layout.shade_free_from, 1)} to ${fmtNum(p.layout.shade_free_to, 1)} h on the winter solstice.`);
}
export const isUsed = () => layoutUsed(P());

// ---------------------------------------------------------------- tables taken out by hand, undo and redo
// Outlines of the tables taken out, shown only while removing tables so one can be put back.
function drawGhosts() {
  M.ghosts.clearLayers();
  if (lay.placing !== 'remove') return;
  (P().layout.removed || []).forEach((t) => window.L.polygon(t, { color: '#7a7a7a', weight: 1, dashArray: '3 3', fillOpacity: 0.05, interactive: false, pmIgnore: true }).addTo(M.ghosts));
}
// A click while removing tables: on a dashed outline puts that table back, on a table takes it out.
function toggleTableAt(ll) {
  const p = P(), R = p.layout.result, here = [ll.lat, ll.lng], removed = p.layout.removed || (p.layout.removed = []);
  const back = removed.findIndex((t) => inPoly(here, t));
  if (back >= 0) {
    removed.splice(back, 1);
    remember(); onFieldChange('layout.removed'); drawGhosts();
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
  p.layout.result = keepOnly(p, R, R.tables.map((_, k) => k !== i));
  E.shade = null;   // the shade belongs to the tables as they were; the yield calculation that follows brings it back
  draw(p.layout.result.tables);
  drawGhosts(); remember(); bump();
  onFieldChange('layout.removed');
  onFieldChange('layout.result');
}
export function restoreTables() {
  setPlacing(null);
  P().layout.removed = [];
  remember();
  onFieldChange('layout.removed');
  if (hasSites()) run();
  bump();
}
// Each save is a snapshot of the items and the removed tables; layout parameters are not part of it.
const snapshot = () => JSON.stringify({ polygons: P().layout.polygons || [], removed: P().layout.removed || [] });
function remember() {
  if (restoring) return;
  const s = snapshot();
  if (history[history.length - 1] === s) return;
  history.push(s);
  const keep = Math.max(11, Math.min(101, Math.floor(5e7 / Math.max(1, s.length))));   // 100 steps, fewer when snapshots are large (about 50 MB in all)
  while (history.length > keep) history.shift();
  future = [];
  updateUndo();
}
function updateUndo() {
  lay.canUndo = history.length > 1;
  lay.canRedo = future.length > 0;
  lay.removed = (P().layout.removed || []).length;
}
export function undo() { if (history.length < 2) return; future.push(history.pop()); applyState(history[history.length - 1]); }
export function redo() { if (!future.length) return; const s = future.pop(); history.push(s); applyState(s); }
function applyState(s) {
  const st = JSON.parse(s);
  restoring = true;
  if (M.map.pm.globalDrawModeEnabled()) M.map.pm.disableDraw();   // a polygon being drawn belongs to the state left behind
  setPlacing(null);
  items.forEach((l) => M.map.removeLayer(l)); items = [];
  P().layout.removed = cleanRemoved(st.removed);
  st.polygons.map(cleanItem).filter(Boolean).forEach(addItem);
  savePolys();
  restoring = false;
  clearTimeout(relayoutTimer);
  if (hasSites()) run();
  else { M.tables.clearLayers(); P().layout.result = null; E.shade = null; sunPath(); }
  updateUndo();
  bump();
}

// ---------------------------------------------------------------- near shading
// Shade from the last yield calculation (its shade: the share of each table's beam the objects hide over the year, and the
// near horizon they form), for the layout result R it was made with. Tables shaded over the chosen limit are then left out;
// the yield is calculated again for the tables that remain.
export function setShade(s, R) {
  const p = P();
  if (R !== p.layout.result) return;   // the layout changed since: its own calculation follows
  E.shade = s || null;
  const lim = p.layout.max_table_shade, T = (R && R.tables) || [], shade = E.shade;
  if (shade && lim > 0 && shade.tables.length === T.length && shade.tables.some((x) => x > lim)) {
    const keep = shade.tables.map((x) => x <= lim);
    p.layout.result = { ...keepOnly(p, R, keep), dropped: (R.dropped || 0) + keep.filter((k) => !k).length };
    E.shade = { ...shade, tables: shade.tables.filter((_, i) => keep[i]) };
    onFieldChange('layout.result');
  }
  if (p.layout.result) draw(p.layout.result.tables || []);
  sunPath();
  bump();
}
// The sun path chart (ui/src/screens/results/SunPath.svelte) draws the near horizon of the objects from the shade
const sunPath = () => setSunShade(E.shade);
