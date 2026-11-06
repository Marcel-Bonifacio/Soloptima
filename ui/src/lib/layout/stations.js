// The stations of the plant as the layout map keeps them (P.layout.stations): where the PV transformer stations, the battery,
// the genset hall, the MV substation and the plant load stand. The electrical design measures its cable lengths from them
// (lib/equip/siteplan.js). No map here, so ui/tests/siteplan.test.js runs this under Node. Positions are [lat, lon].
import { num } from './items.js';

export const STATION_KINDS = [['pv', 'PV station'], ['bess', 'BESS station'], ['gen', 'Genset hall'], ['substation', 'MV substation'], ['load', 'Plant load']];
export const kindName = (k) => (STATION_KINDS.find(([v]) => v === k) || [, k])[1];
export const MAX_STATIONS = 200;
// The kind a placing mode of the map stands for ('station:pv' places a PV station), or null
export const stationMode = (m) => (typeof m === 'string' && m.startsWith('station:') && STATION_KINDS.some(([k]) => k === m.slice(8)) ? m.slice(8) : null);
export const stationHint = (kind) => `${kindName(kind)}: click the map to place it${kind === 'substation' ? ' (placing it again moves it)' : ', again for more'} · Esc to stop`;

// The stations of a project file or an undo snapshot: a known kind and a position on the globe; names cut to 40 characters.
// The plant has one MV substation, the first one found.
export function cleanStations(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_STATIONS) break;
    if (!s || !STATION_KINDS.some(([k]) => k === s.kind) || !Array.isArray(s.latlng) || s.latlng.length !== 2) continue;
    const la = num(s.latlng[0]), lo = num(s.latlng[1]);
    if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (s.kind === 'substation' && out.some((q) => q.kind === 'substation')) continue;
    const q = { kind: s.kind, latlng: [la, lo] };
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 40) : '';
    if (name) q.name = name;
    out.push(q);
  }
  return out;
}
