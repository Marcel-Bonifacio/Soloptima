// Moving the site moves the layout with it: every point keeps its east and north offset (metres) from the site, so shapes,
// sizes and spacing stay as drawn. Items left far from the site stop the PV yield (the engine takes items within 50 km).
import { projector } from './geometry.js';
import { km } from './coords.js';

export const FAR_KM = 50;
const first = (g) => g.center || (g.latlngs || [])[0];
export const hasLayout = (L) => (L.polygons || []).length > 0 || (L.stations || []).length > 0;
// the items farther than FAR_KM from the site
export const farItems = (L, loc) => (L.polygons || []).filter((g) => { const p = first(g); return p && km({ lat: p[0], lon: p[1] }, loc) > FAR_KM; }).length;

// moves the layout L (in place) from site `from` to site `to`, both { lat, lon }
export function shiftLayout(L, from, to) {
  const a = projector(from.lat, from.lon), b = projector(to.lat, to.lon);
  const mv = (p) => { const [x, y] = a.fwd(p), q = b.inv([x, y]); return [+q[0].toFixed(7), +q[1].toFixed(7)]; }, ring = (r) => r.map(mv);
  for (const g of L.polygons || []) { if (g.center) g.center = mv(g.center); if (g.latlngs) g.latlngs = ring(g.latlngs); }
  for (const s of L.stations || []) if (s.latlng) s.latlng = mv(s.latlng);
  if (L.result && L.result.tables) L.result.tables = L.result.tables.map(ring);
  if (L.removed) L.removed = L.removed.map(ring);
}
