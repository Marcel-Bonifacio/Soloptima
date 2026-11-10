// The items of the layout map as the project keeps them (P.layout.polygons): PV areas, exclusion zones (with keepout paths)
// and the buildings and trees that shade the tables. Their checks, sizes, orientations and labels, without the map, so
// ui/tests/layout.test.js runs them under Node. Corners are [lat, lon].
import { localProjector, stripOf, pathLength, areaLatLng } from './geometry.js';
import { fmtNum, fmtArea } from '../format.js';

// Map styles of the item kinds and of the previews
export const STYLE = {
  site: { color: '#eda100', weight: 2, fillOpacity: 0.06 },
  exclusion: { color: '#e34948', weight: 2, fillOpacity: 0.25, dashArray: '6 4' },
  building: { color: '#5d4a3a', weight: 1.5, fillColor: '#8a7560', fillOpacity: 0.55 },
  tree: { color: '#0f3d12', weight: 1.5, fillColor: '#5fbf4a', fillOpacity: 0.6 },
  preview: { color: '#0b84d8', weight: 2, fillOpacity: 0.15, dashArray: '5 4' },
  osm: { color: '#6b6b6b', weight: 1, fillOpacity: 0.08, dashArray: '3 3' },
};
// Ranges of the fields of layout items, for the editor, saved projects and imported files
export const LIMITS = { height: [0.1, 1000], treeHeight: [0.1, 100], crown: [0.5, 60], base: [0, 500], tilt: [0, 90], azimuth: [0, 360], slope: [0, 45], transmission: [0, 0.95], clearance: [0, 100], width: [0.5, 100], shift: [0, 200] };
export const num = (v) => (v != null && v !== '' && Number.isFinite(+v) ? +v : null);
/** @type {(v: number, lim: number[]) => number} */
export const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const fin = (q) => Array.isArray(q) && q.length === 2 && num(q[0]) != null && num(q[1]) != null;

// The kind shown for an item: site, exclusion, building or tree
export const kindOf = (g) => (g.type === 'obstacle' ? g.kind : g.type);

// A layout item as P.layout.polygons keeps it, from a project file or an imported shape: numbers from text (KML), sizes
// brought into range, angles out of range dropped; null when it cannot be used.
export function cleanItem(g) {
  if (!g || !['site', 'exclusion', 'obstacle'].includes(g.type)) return null;
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
    if (num(g.transmission) > 0) q.transmission = clampTo(num(g.transmission), LIMITS.transmission);   // light through the crown with leaves
    if (g.leaves === 'deciduous') q.leaves = 'deciduous';
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
    const slope = num(g.slope), down = num(g.slope_azimuth);   // ground slope under fixed rows and the azimuth it falls towards
    if (slope > 0) { q.slope = clampTo(slope, LIMITS.slope); if (down != null && down >= 0 && down <= 360) q.slope_azimuth = down; }
    for (const k of ['shift_u', 'shift_v']) if (num(g[k]) != null && num(g[k]) >= 0) q[k] = clampTo(num(g[k]), LIMITS.shift);   // grid shift of the tables
  } else if (num(g.clearance) > 0) q.clearance = clampTo(num(g.clearance), LIMITS.clearance);   // distance tables keep from the item
  if (['osm', 'traced', 'import'].includes(g.source)) q.source = g.source;
  return q;
}

// The tables the user took out, as saved: four [lat, lon] corners each. A new fill drops the tables that sit where one was.
export function cleanRemoved(list) {
  return (Array.isArray(list) ? list : []).filter((t) => Array.isArray(t) && t.length === 4 && t.every(fin)).slice(0, 5000).map((t) => t.map(([a, b]) => [+a, +b]));
}

// The project's azimuth: the equator-facing one when it is automatic
export const projectAz = (P) => (P.pv.azimuth_auto ? (P.location.lat >= 0 ? 180 : 0) : P.pv.azimuth);
// Orientation of a PV area's tables: its own tilt and azimuth (or east-west pairs, or a canopy) on fixed mounts, else the project's.
export function orientationOf(P, g) {
  const own = P.pv.mount !== 'tracker' && (g.tilt != null || g.azimuth != null || !!g.east_west || !!g.canopy);
  return { own, ew: own && !!g.east_west, canopy: own && !!g.canopy && !g.east_west, tilt: own && g.tilt != null ? g.tilt : P.pv.tilt || 0, azimuth: own && g.azimuth != null ? g.azimuth : projectAz(P) };
}
// Slope of the ground across the fixed rows of a PV area (deg, positive where it falls the way its tables face), null on level
// ground or under trackers (as cross_slope in engine/src/pv/rows.rs)
export function crossSlope(P, g) {
  if (P.pv.mount === 'tracker' || !(num(g.slope) > 0)) return null;
  const az = orientationOf(P, g).azimuth, down = num(g.slope_azimuth) != null ? num(g.slope_azimuth) : az, r = Math.PI / 180;
  return Math.atan(Math.tan(num(g.slope) * r) * Math.cos((down - az) * r)) / r;
}
// Whether the engine uses the layout: for the shade of its objects, for areas with their own orientation or for the tables at
// the edges of the array (as layout_used).
export function layoutUsed(P) {
  const g = (P.layout && P.layout.polygons) || [], tables = P.layout && P.layout.result && (P.layout.result.tables || []).length;
  return (P.pv.near_shading !== false && g.some((x) => x.type === 'obstacle')) || g.some((x) => x.type === 'site' && (orientationOf(P, x).own || crossSlope(P, x) != null))
    || (!!P.pv.edge_rows && !!tables);
}

// Length, width and rotation (deg from north, 0-180, of the first side) of a four-cornered footprint with square corners
// (within 3 deg); null for any other shape.
export function rectOf(pts) {
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
export function rectCorners(pts, r) {
  const pr = localProjector(pts);
  const a = r.rotation * Math.PI / 180, u = [Math.sin(a), Math.cos(a)], v = [Math.cos(a), -Math.sin(a)], hl = r.length / 2, hw = r.width / 2;
  return [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([s, t]) => pr.inv([s * u[0] + t * v[0], s * u[1] + t * v[1]]));
}
// Azimuth square to the area's longest side: the one facing the equator (at latitude lat), or for east-west tables the one
// between 0 and 180.
export function alignedAzimuth(pts, eastWest, lat) {
  const c = pts.map(localProjector(pts).fwd);
  let side = 0, len = -1;
  c.forEach((p, i) => {
    const q = c[(i + 1) % c.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l > len) { len = l; side = Math.atan2(q[0] - p[0], q[1] - p[1]) * 180 / Math.PI; }
  });
  const n1 = ((side + 90) % 360 + 360) % 360, n2 = (n1 + 180) % 360, eq = lat >= 0 ? 180 : 0;
  const off = (x) => Math.abs(((x - eq + 540) % 360) - 180);
  return Math.round((eastWest ? (n1 < 180 ? n1 : n2) : off(n1) <= off(n2) ? n1 : n2) * 10) / 10;
}

// The label of an item on the map (g as saved, with its corners or its centre and diameter)
export function itemLabel(P, g) {
  const k = kindOf(g);
  let txt;
  if (k === 'tree') txt = `Tree · ${fmtNum(g.height, 1)} m high · crown ${fmtNum(g.diameter, 1)} m`;
  else if (k === 'building') {
    const r = rectOf(g.latlngs);
    txt = `Building · ${fmtNum(g.height, 1)} m high · ` + (r ? `${fmtNum(r.length, 1)} × ${fmtNum(r.width, 1)} m` : `${fmtNum(areaLatLng(g.latlngs))} m²`);
  } else if (g.kind === 'path') {
    txt = `Path · ${fmtNum(g.width, 1)} m wide · ${fmtNum(pathLength(g.path))} m long`;
  } else {
    txt = `${k === 'site' ? 'PV area' : 'Exclusion'} · ${fmtArea(areaLatLng(g.latlngs))}`;
    const o = orientationOf(P, g);
    if (k === 'site' && o.own) txt += ` · ${o.canopy ? 'canopy ' : o.ew ? 'east-west ' : ''}${fmtNum(o.tilt)}° / ${fmtNum(o.azimuth)}°`;
    if (k === 'site' && g.base) txt += ` · ${fmtNum(g.base, 1)} m up`;
  }
  if (g.clearance) txt += ` · ${fmtNum(g.clearance, 1)} m clear`;
  return txt;
}

// A keepout path (q, the fields of an exclusion zone) after its strip was edited: moved with the strip when the strip was only
// dragged (was and now are the strip's corners before and after), else dropped, leaving an ordinary exclusion zone with the
// strip's outline. Changes q in place.
export function followPath(q, was, now) {
  if (q.kind !== 'path') return;
  const d = [now[0][0] - was[0][0], now[0][1] - was[0][1]];
  if (now.length === was.length && now.every((p, i) => Math.abs(p[0] - was[i][0] - d[0]) < 1e-9 && Math.abs(p[1] - was[i][1] - d[1]) < 1e-9))
    q.path = q.path.map(([a, b]) => [+(a + d[0]).toFixed(7), +(b + d[1]).toFixed(7)]);
  else { delete q.kind; delete q.path; delete q.width; }
}

// The items imported from a file (GeoData.read): those written by the layout export keep their kind and fields; other shapes
// become `as` (site, exclusion or building; holes of a polygon exclusion zones), points become trees. Tables are not taken.
export function importedItems(items, as) {
  const out = [];
  for (const it of items) {
    const p = it.props || {}, kind = p.soloptima || (it.kind === 'point' ? 'tree' : it.kind === 'hole' ? 'exclusion' : as);
    if ((it.kind === 'point') !== (kind === 'tree')) continue;   // tables are filled again from the areas
    const g = cleanItem({ ...p, type: kind === 'building' || kind === 'tree' ? 'obstacle' : kind, kind, latlngs: it.latlngs, center: it.latlng,
                          diameter: p.diameter != null ? p.diameter : 6, source: 'import' });
    if (g) out.push(g);
  }
  return out;
}
