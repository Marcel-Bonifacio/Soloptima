// Moving, turning and resizing a layout item as saved (P.layout.polygons) from the 3D view: plan moves in metres east and
// north, height moves, turns about the vertical (and, for a PV area on the ground, the ground slope as turns about the east
// and north axes) and sizes along the item's own axes. Each returns a new item; cleanItem (items.js) checks it after.
import { localProjector, stripOf, norm360 as wrap, centroid } from './geometry.js';
import { LIMITS, clampTo, orientationOf, alignedAzimuth } from './items.js';

const R = Math.PI / 180;
const norm360 = (a) => +wrap(a).toFixed(2);
const fix = (ll) => ll.map((v) => +v.toFixed(7));

// The local frame of an item: its projector, centre (vertex mean, or a tree's centre) and the azimuth of its long axis (deg)
export function frameOf(g) {
  const pts = g.center ? [g.center] : g.latlngs, pr = localProjector(pts);
  if (g.center) return { pr, c: [0, 0], axis: 0, m: [[0, 0]] };
  const m = pts.map(pr.fwd);
  let axis = 0, len = -1;
  m.forEach((p, i) => { const q = m[(i + 1) % m.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]); if (l > len) { len = l; axis = Math.atan2(q[0] - p[0], q[1] - p[1]) / R; } });
  if (g.roof && g.ridge_az != null && g.roof !== 'shed') axis = g.ridge_az;
  return { pr, c: centroid(m), axis: norm360(axis) % 180, m };
}
// The item's extent along its long axis, across it and up (m)
export function sizeOf(g, P) {
  if (g.center) return [+g.diameter, +g.diameter, +g.height];
  const { m, axis } = frameOf(g), u = [Math.sin(axis * R), Math.cos(axis * R)], v = [u[1], -u[0]];
  const span = (d) => { const s = m.map((p) => p[0] * d[0] + p[1] * d[1]); return Math.max(...s) - Math.min(...s); };
  const up = g.type === 'site' ? (g.h0 != null ? g.h0 : +P.pv.mount_height || 1.5) : +g.height || 0;
  return [span(u), span(v), up];
}
const mapPts = (g, f) => {   // every plan point of the item through f (local metres about the item's centre)
  const { pr } = frameOf(g), q = { ...g };
  if (g.center) q.center = fix(pr.inv(f(pr.fwd(g.center))));
  else q.latlngs = g.latlngs.map((p) => fix(pr.inv(f(pr.fwd(p)))));
  if (g.kind === 'path' && g.path) { q.path = g.path.map((p) => fix(pr.inv(f(pr.fwd(p))))); q.latlngs = stripOf(q.path, g.width); }
  return q;
};

// Moved dx east, dy north (m) and dz up: a PV area's surface (a carport's canopy), nothing else leaves the ground
export function moveItem(g, P, dx, dy, dz = 0) {
  const q = dx || dy ? mapPts(g, ([x, y]) => [x + dx, y + dy]) : { ...g };
  if (dz && g.type === 'site') {
    if (g.carport) q.h0 = clampTo((g.h0 != null ? g.h0 : +P.pv.mount_height || 1.5) + dz, LIMITS.h0);
    else q.base = clampTo((+g.base || 0) + dz, LIMITS.base);
  }
  return q;
}

// Turned by deg about the vertical through its centre (clockwise seen from above, as azimuths run): the outline, a roof's
// ridge, a PV area's tables (they take their own azimuth) and its ground slope turn with it
export function turnItem(g, P, deg) {
  const { c } = frameOf(g), a = deg * R, cs = Math.cos(a), sn = Math.sin(a);
  const q = mapPts(g, ([x, y]) => { const u = x - c[0], v = y - c[1]; return [c[0] + u * cs + v * sn, c[1] - u * sn + v * cs]; });
  if (g.roof && g.ridge_az != null) q.ridge_az = norm360(g.ridge_az + deg);
  if (g.type === 'site' && P.pv.mount !== 'tracker') {
    const o = orientationOf(P, g);
    q.azimuth = norm360(o.azimuth + deg);
    if (q.tilt == null) q.tilt = o.tilt;
    if (g.slope > 0 && g.slope_azimuth != null) q.slope_azimuth = norm360(g.slope_azimuth + deg);
  }
  return q;
}

// The ground slope of a PV area as turns about the east (rx) and north (ry) axes, deg: the plane z = y tan rx - x tan ry
export function slopeTurns(g, P) {
  if (!(g.slope > 0)) return [0, 0];
  const down = (g.slope_azimuth != null ? g.slope_azimuth : orientationOf(P, g).azimuth) * R, t = Math.tan(g.slope * R);
  const dx = t * Math.sin(down), dy = t * Math.cos(down);   // downhill
  return [Math.atan(-dy) / R, Math.atan(dx) / R];
}
// A PV area on the ground with the slope of turns rx, ry (deg); level drops the slope. Not for trackers, roofs or carports.
export function withSlope(g, rx, ry) {
  const dx = Math.tan(ry * R), dy = -Math.tan(rx * R), t = Math.hypot(dx, dy), q = { ...g };
  delete q.slope; delete q.slope_azimuth;
  const s = Math.atan(t) / R;
  if (s >= 0.05) { q.slope = +clampTo(s, LIMITS.slope).toFixed(2); q.slope_azimuth = norm360(Math.atan2(dx, dy) / R); }
  return q;
}
export const canSlope = (g, P) => g.type === 'site' && !g.rooftop && !g.carport && P.pv.mount !== 'tracker';

// Resized to `size` metres along axis k (0: its long axis, 1: across, 2: up), about its centre
export function resizeItem(g, P, k, size) {
  if (!(size > 0)) return g;
  if (k === 2) {
    if (g.type === 'site') return { ...g, h0: clampTo(size, LIMITS.h0) };
    return { ...g, height: clampTo(size, g.kind === 'tree' ? LIMITS.treeHeight : LIMITS.height) };
  }
  if (g.center) return { ...g, diameter: +clampTo(size, LIMITS.crown).toFixed(2) };
  const now = sizeOf(g, P)[k];
  if (!(now > 0.01)) return g;
  const { c, axis } = frameOf(g), f = Math.min(1e3, Math.max(1e-3, Math.max(0.5, size) / now));
  const u = [Math.sin(axis * R), Math.cos(axis * R)], v = [u[1], -u[0]], d = k === 0 ? u : v;
  return mapPts(g, ([x, y]) => { const s = (x - c[0]) * d[0] + (y - c[1]) * d[1]; return [x + (f - 1) * s * d[0], y + (f - 1) * s * d[1]]; });
}

// The ridge (gable, hip) along the long side, or a shed falling towards the equator: the azimuth ridge_az takes
export function defaultRidge(g, roof, lat) {
  return roof === 'shed' ? alignedAzimuth(g.latlngs, false, lat) : norm360(frameOf({ ...g, roof: undefined }).axis) % 180;
}
