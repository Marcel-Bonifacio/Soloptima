// Moving the site moves the layout with it: every point keeps its east and north offset (metres) from the site, so shapes,
// sizes and spacing stay as drawn. Items left far from the site stop the PV yield (the engine takes items within 50 km).
import { projector } from './geometry.js';
import { km } from './coords.js';

export const FAR_KM = 50;
const first = (g) => g.center || (g.latlngs || [])[0] || g.latlng;
const pointsOf = (g) => (g.center ? [g.center] : g.latlngs || (g.latlng ? [g.latlng] : []));
export const hasLayout = (L) => (L.polygons || []).length > 0 || (L.stations || []).length > 0;
// as the engine: an item is far when a point of it lies over FAR_KM east, west, north or south of the site, on the site's projection
export function farTest(loc) {
  const pr = projector(+loc.lat, +loc.lon), lim = FAR_KM * 1000;
  const farPt = (p) => { const [x, y] = pr.fwd(p); return !(Math.abs(x) <= lim && Math.abs(y) <= lim); };
  return { farPt, far: (g) => pointsOf(g).some(farPt) };
}
// the items farther than FAR_KM from the site
export const farItems = (L, loc) => { const { far } = farTest(loc); return (L.polygons || []).filter(far).length; };

// moves the layout L (in place) from site `from` to site `to`, both { lat, lon }
export function shiftLayout(L, from, to) {
  const a = projector(from.lat, from.lon), b = projector(to.lat, to.lon);
  const mv = (p) => { const [x, y] = a.fwd(p), q = b.inv([x, y]); return [+q[0].toFixed(7), +q[1].toFixed(7)]; }, ring = (r) => r.map(mv);
  for (const g of L.polygons || []) { if (g.center) g.center = mv(g.center); if (g.latlngs) g.latlngs = ring(g.latlngs); }
  for (const s of L.stations || []) if (s.latlng) s.latlng = mv(s.latlng);
  if (L.result && L.result.tables) L.result.tables = L.result.tables.map(ring);
  if (L.removed) L.removed = L.removed.map(ring);
}

// The items and stations far from the site, in groups of those within FAR_KM of each other: { idx, st (station indexes), at: [lat, lon], km }
export function farGroups(L, loc) {
  const { far } = farTest(loc), groups = [];
  const add = (g, i, key) => {
    const p = first(g);
    if (!p || !far(g)) return;
    let x = groups.find((x) => km({ lat: x.at[0], lon: x.at[1] }, { lat: p[0], lon: p[1] }) <= FAR_KM);
    if (!x) groups.push((x = { idx: [], st: [], at: p }));
    x[key].push(i);
  };
  (L.polygons || []).forEach((g, i) => add(g, i, 'idx'));
  (L.stations || []).forEach((s, i) => add(s, i, 'st'));
  return groups.map((g) => ({ ...g, km: km({ lat: g.at[0], lon: g.at[1] }, loc) }));
}
// moves the items idx and stations st of L so that `at` lands on the site, keeping their shapes and their places relative to each other
export function bringItems(L, idx, at, loc, st = []) {
  const sub = { polygons: idx.map((i) => L.polygons[i]), stations: st.map((i) => L.stations[i]) };
  shiftLayout(sub, { lat: at[0], lon: at[1] }, loc);
  idx.forEach((i, j) => { L.polygons[i] = sub.polygons[j]; });
  st.forEach((i, j) => { L.stations[i] = sub.stations[j]; });
}
