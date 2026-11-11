// The stations of the plant as the layout map keeps them (P.layout.stations): where the PV transformer stations, the battery,
// the genset hall, the MV substation and the plant load stand. The electrical design measures its cable lengths from them
// (lib/equip/siteplan.js). No map here, so ui/tests/siteplan.test.js runs this under Node. Positions are [lat, lon].
import { num } from './items.js';

// [kind, name, letters on the pin, what it is for]; the pin colours are in web/style.css (.st-<kind>)
export const STATION_KINDS = [
  ['pv', 'PV station', 'PV', 'A PV transformer station: with central inverters it takes a block of tables; string inverters send their AC cables to it'],
  ['inv', 'Inverter', 'I', 'A string inverter in the field (String inverters in the electrical design basis): it takes a block of tables'],
  ['bess', 'BESS station', 'B', 'The battery station'],
  ['gen', 'Genset hall', 'G', 'The genset hall'],
  ['substation', 'MV substation', 'S', "The plant's MV substation, where the feeders end (one only: placing it again moves it)"],
  ['load', 'Plant load', 'L', 'Where the plant load is connected'],
];
const kindRow = (k) => STATION_KINDS.find(([v]) => v === k) || [];
export const kindName = (k) => kindRow(k)[1] || k;
export const kindMark = (k) => kindRow(k)[2];
export const MAX_STATIONS = 1000;   // string inverters of a large plant
// The kind a placing mode of the map stands for ('station:pv' places a PV station), or null
export const stationMode = (m) => (typeof m === 'string' && m.startsWith('station:') && STATION_KINDS.some(([k]) => k === m.slice(8)) ? m.slice(8) : null);
export const stationHint = (kind) => `${kindName(kind)}: click the map to place it${kind === 'substation' ? ' (placing it again moves it)' : ', again for more'} · Esc to stop`;

// A coordinate typed as a number or as a number in text; not blank text, null or a boolean, which num() would read as 0 or 1
const coord = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? num(v) : null);

// The stations of a project file or an undo snapshot: a known kind and a position on the globe; names cut to 40 characters.
// The plant has one MV substation, the first one found.
export function cleanStations(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_STATIONS) break;
    if (!s || !STATION_KINDS.some(([k]) => k === s.kind) || !Array.isArray(s.latlng) || s.latlng.length !== 2) continue;
    const la = coord(s.latlng[0]), lo = coord(s.latlng[1]);
    if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (s.kind === 'substation' && out.some((q) => q.kind === 'substation')) continue;
    const q = { kind: s.kind, latlng: [la, lo] };
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 40) : '';
    if (name) q.name = name;
    out.push(q);
  }
  return out;
}
