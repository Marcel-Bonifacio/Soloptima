// The plant's stations on the map: PV transformer stations, the battery, the genset hall, the MV substation and the plant load,
// as markers the user places and drags. P.layout.stations holds them (stations.js); the electrical design measures its cable
// lengths from their positions (lib/equip/siteplan.js). A marker keeps its station object in _st, the same object the
// project holds, so editing one changes the other. Every change is one step of undo (remember, in edit.svelte.js).
import { lay, M, P, popup, closePopup, bump, toast, pmBusy } from './map.svelte.js';
import { remember, mapClicked, draw } from './edit.svelte.js';
import { autoPlace as placeAuto } from '../equip/blocks.js';
import { design } from '../equip/electrical.svelte.js';
import { MAX_STATIONS, kindName, kindMark, stationMode } from './stations.js';
import { onFieldChange } from '../ws/project.js';
import StationEditor from '../../screens/layout/StationEditor.svelte';

let markers = [];

const span = (cls, txt) => { const e = document.createElement('span'); e.className = cls; e.textContent = txt; return e; };
const labelOf = (s) => kindName(s.kind) + (s.name ? ': ' + s.name : '');
const iconOf = (s) => window.L.divIcon({ html: span('st-pin st-' + s.kind, kindMark(s.kind)), className: 'st-icon', iconSize: [26, 26], iconAnchor: [13, 13] });
const round = (x) => +x.toFixed(7);

function saved() {
  P().layout.stations = markers.map((m) => m._st);
  remember();
  onFieldChange('layout.stations');
  if (lay.showBlocks) draw((P().layout.result && P().layout.result.tables) || []);   // the blocks follow the pins
  bump();
}
function makeMarker(s) {
  // pmIgnore: Geoman's edit and removal modes leave the markers to this file, which keeps the project in step
  const m = window.L.marker(s.latlng, { draggable: true, bubblingMouseEvents: false, pmIgnore: true, icon: iconOf(s) }).addTo(M.map);
  m._st = s;
  m.bindTooltip(span('', labelOf(s)), { direction: 'top', offset: [0, -12] });
  m.on('dragend', () => { const p = m.getLatLng(); s.latlng = [round(p.lat), round(p.lng)]; saved(); });
  // a click opens the editor; while something is being placed the click is the map's, as over a drawn item
  m.on('click', (e) => {
    if (pmBusy()) return;
    if (lay.placing) { if (lay.placing !== 'move' && lay.placing !== 'drag' && !stationMode(lay.placing)) mapClicked(e); return; }
    popup(m.getLatLng(), StationEditor, { station: s, apply: () => edited(m), remove: () => removeMarker(m) }, { maxWidth: 300 });
  });
  return m;
}
function edited(m) {
  m.setIcon(iconOf(m._st));
  m.setTooltipContent(span('', labelOf(m._st)));
  saved();
}
function removeMarker(m) {
  closePopup();
  M.map.removeLayer(m);
  markers = markers.filter((x) => x !== m);
  saved();
}

// A click while a station is being placed. The plant has one MV substation: placing it again moves it.
export function addStation(kind, ll) {
  const at = [round(ll.lat), round(ll.lng)];
  const sub = kind === 'substation' && markers.find((m) => m._st.kind === 'substation');
  if (sub) { sub._st.latlng = at; sub.setLatLng(at); saved(); toast('The plant has one MV substation: it moved here.'); return; }
  if (markers.length >= MAX_STATIONS) { toast(`At most ${MAX_STATIONS} stations.`, true); return; }
  markers.push(makeMarker({ kind, latlng: at }));
  saved();
}
// The markers go from the map (a project closes or opens); the stations stay in the project
function clearStations() {
  closePopup();   // an editor open on a marker that goes would change a station the project no longer holds
  markers.forEach((m) => M.map.removeLayer(m));
  markers = [];
}
// The open project's stations on the map, in place of those shown before
export function restoreStations() {
  clearStations();
  markers = (P().layout.stations || []).map(makeMarker);
}
// Undo and redo: these stations (cleaned, history.js) replace the project's
export function setStations(list) {
  P().layout.stations = list;
  restoreStations();
}

// Auto-place: the inverters (string inverters) or PV stations (central inverters) the electrical design counts, spread over the
// tables in blocks of about equal size. Replaces the pins of that kind; one step of undo.
export function autoPlace() {
  const D = design(), nInv = D.str ? D.str.nInv : 0, nSt = D.nTrPV || 0;
  if (!nInv || !nSt) { toast('Select a PV module, an inverter and a PV transformer in the electrical design first.', true); return; }
  const r = placeAuto(P(), nInv, nSt);
  if (!r) { toast('Fill the PV areas with tables first.', true); return; }
  if (r.stations.length > MAX_STATIONS) { toast(`The design needs more than ${MAX_STATIONS} pins: use larger inverters.`, true); return; }
  setStations(r.stations);
  P().layout.stations = markers.map((m) => m._st);
  remember();
  onFieldChange('layout.stations');
  lay.showBlocks = true;
  draw((P().layout.result && P().layout.result.tables) || []);
  bump();
  const n = r.kind === 'inv' ? nInv : nSt;
  toast(`Placed ${n} ${r.kind === 'inv' ? 'inverters' : 'PV stations'}${r.stationsAdded ? ` and ${r.stationsAdded} PV stations` : ''}, each with a block of tables. Drag them to adjust; Ctrl+Z undoes.`);
}
