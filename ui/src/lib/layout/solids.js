// The solid shapes of the layout items, in local metres, as the engine's near shading takes them (engine/src/shading.rs):
// pitched roofs as the lowest of a few planes over the footprint, tree crowns by shape, the ground under a sloped PV area, and
// the PV areas on the roof planes of a building. The 3D view draws exactly these, so its shadows and the yield agree.

import { area2, azOff, norm360, centroid } from './geometry.js';

const R = Math.PI / 180;
export const ROOFS = ['flat', 'gable', 'hip', 'shed'];
export const TREE_SHAPES = ['column', 'round', 'cone', 'palm'];
export const ROOF_PITCH = 25;

// The roof of a building on its plan corners m ([x, y] metres), eave height H: { H, top, planes: [[a, b, c]], h(p) } with
// h(p) = H + tan(pitch) * min_j (a_j + b_j x + c_j y). A flat roof has no planes and h = H. As engine/src/shading.rs.
export function roofOf(g, m) {
  const H = +g.height || 6, kind = ROOFS.includes(g.roof) ? g.roof : 'flat';
  if (kind === 'flat' || m.length < 3) return { kind: 'flat', H, top: H, planes: [], h: () => H };
  const k = Math.tan((g.pitch > 0 ? Math.min(75, Math.max(1, g.pitch)) : ROOF_PITCH) * R), az = (+g.ridge_az || 0) * R;
  const r = [Math.sin(az), Math.cos(az)], n = [Math.cos(az), -Math.sin(az)];
  const span = (d) => { const s = m.map((p) => p[0] * d[0] + p[1] * d[1]); return [Math.min(...s), Math.max(...s)]; };
  const [u0, u1] = span(r), [v0, v1] = span(n), uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, A = (u1 - u0) / 2, B = (v1 - v0) / 2;
  // a + b x + c y for "c0 + s * (d . p)"
  const lin = (c0, s, d) => [c0, s * d[0], s * d[1]];
  let planes, top;
  if (kind === 'shed') { planes = [lin(u1, -1, r)]; top = H + k * (u1 - u0); }
  else {
    planes = [lin(B + vc, -1, n), lin(B - vc, 1, n)];
    if (kind === 'hip') planes.push(lin(A + uc, -1, r), lin(A - uc, 1, r));
    top = H + k * (kind === 'hip' ? Math.min(A, B) : B);
  }
  const at = (p) => Math.min(...planes.map(([a, b, c]) => a + b * p[0] + c * p[1]));
  return { kind, H, k, top, planes, h: (p) => H + k * Math.max(0, at(p)) };
}

// The part of polygon pts where a + b x + c y <= 0 (Sutherland-Hodgman against one half-plane)
function clipHalf(pts, [a, b, c]) {
  const f = (p) => a + b * p[0] + c * p[1], out = [];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  });
  return out;
}
// The roof planes as plan polygons: plane j over the part of the footprint where it is the lowest
export function roofPieces(roof, m) {
  if (!roof.planes.length) return [{ poly: m, j: -1 }];
  return roof.planes.map((pj, j) => {
    let poly = m;
    roof.planes.forEach((pk, i) => { if (i !== j && poly.length >= 3) poly = clipHalf(poly, [pj[0] - pk[0], pj[1] - pk[1], pj[2] - pk[2]]); });
    return { poly, j };
  }).filter((x) => x.poly.length >= 3 && Math.abs(area2(x.poly)) > 1e-6);
}

// The points of edge a-b where the roof bends (two planes meet), as fractions 0-1, in order
export function edgeBreaks(roof, a, b) {
  const t = [];
  const P = roof.planes, at = (p) => Math.min(...P.map(([x, y, z]) => x + y * p[0] + z * p[1]));
  for (let j = 0; j < P.length; j++) for (let i = j + 1; i < P.length; i++) {
    const f = (p) => (P[j][0] - P[i][0]) + (P[j][1] - P[i][1]) * p[0] + (P[j][2] - P[i][2]) * p[1], fa = f(a), fb = f(b);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const s = fa / (fa - fb), p = [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])], v = P[j][0] + P[j][1] * p[0] + P[j][2] * p[1];
      if (Math.abs(v - at(p)) < 1e-9) t.push(s);
    }
  }
  return t.sort((x, y) => x - y);
}

// Downhill azimuth (deg) of roof plane j
export function planeAzimuth([, b, c]) { return norm360(Math.atan2(-b, -c) / R); }

// Height of a tree's crown top over plan distance r from its centre (H height, D crown diameter), as the engine shades it
export function crownTop(shape, H, D, r) {
  const Rc = D / 2;
  if (r > Rc) return 0;
  if (shape === 'round') { const rv = Math.min(Rc, H / 2); return H - rv + rv * Math.sqrt(Math.max(0, 1 - (r / Rc) ** 2)); }
  if (shape === 'cone') return H - 0.84 * H * (r / Rc);
  if (shape === 'palm') return Math.max(0, H - 0.5 * r);
  return H;
}

// A polygon moved in by `inset` metres (each edge offset along its inward normal, corners met again); null when it vanishes
export function insetPoly(m, inset) {
  if (!(inset > 0)) return m;
  const s = Math.sign(area2(m)) || 1, n = m.length;
  const lines = m.map((p, i) => {
    const q = m[(i + 1) % n], d = [q[0] - p[0], q[1] - p[1]], l = Math.hypot(d[0], d[1]) || 1, nn = [-d[1] / l * s, d[0] / l * s];
    return [[p[0] + nn[0] * inset, p[1] + nn[1] * inset], d];
  });
  const out = lines.map(([p1, d1], i) => {
    const [p0, d0] = lines[(i - 1 + n) % n], den = d0[0] * d1[1] - d0[1] * d1[0];
    if (Math.abs(den) < 1e-9) return p1;
    const t = ((p1[0] - p0[0]) * d1[1] - (p1[1] - p0[1]) * d1[0]) / den;
    return [p0[0] + t * d0[0], p0[1] + t * d0[1]];
  });
  return Math.sign(area2(out)) === s && Math.abs(area2(out)) > 1 ? out : null;
}

// The PV areas on a building's roof (pr: its local projector, g: the building as saved): on a flat roof one area at the roof
// height with the project's rows; on a pitched roof one area per plane facing within 100 deg of the equator, flush with the
// plane (tilt and ground slope the pitch, the table centre `standoff` above it). Corners kept `setback` from the roof edges.
export function roofArrays(g, pr, lat, { setback = 0.5, standoff = 0.15 } = {}) {
  const m = g.latlngs.map(pr.fwd), roof = roofOf(g, m), eq = lat >= 0 ? 180 : 0, out = [];
  for (const { poly, j } of roofPieces(roof, m)) {
    const inner = insetPoly(poly, setback);
    if (!inner) continue;
    const latlngs = inner.map((p) => pr.inv(p).map((v) => +v.toFixed(7)));
    if (j < 0) { out.push({ type: 'site', latlngs, base: +roof.H.toFixed(2) }); continue; }
    const az = planeAzimuth(roof.planes[j]);
    if (azOff(az, eq) > 100) continue;
    const pitch = Math.atan(roof.k) / R, c = centroid(inner);
    out.push({ type: 'site', latlngs, base: +roof.h(c).toFixed(2), tilt: +pitch.toFixed(1), azimuth: +az.toFixed(1), canopy: true,
               slope: +Math.min(45, pitch).toFixed(1), slope_azimuth: +az.toFixed(1), h0: standoff, rooftop: true });
  }
  return out;
}
