// The solid shapes of the layout items, in local metres, as the engine's near shading takes them (engine/src/shading.rs):
// pitched roofs as the lowest of a few planes over the footprint (a butterfly the highest of two), the other roof shapes by
// their height at each point, tree crowns by shape, the ground under a sloped PV area, and the PV areas on the roof planes of
// a building. The 3D view draws exactly these, so its shadows and the yield agree.

import { area2, azOff, norm360, centroid, inPoly } from './geometry.js';

const R = Math.PI / 180;
export const ROOFS = ['flat', 'parapet', 'gable', 'hip', 'pyramid', 'shed', 'mansard', 'gambrel', 'butterfly', 'sawtooth', 'barrel', 'cone', 'dome'];
export const TREE_SHAPES = ['column', 'round', 'cone', 'palm'];
export const ROOF_PITCH = 25;
// The fields each roof shape uses and their defaults (rise null: from the footprint), as shaped_defaults in engine/src/layout.rs
export const ROOF_FIELDS = {
  flat: [], parapet: ['rise'], gable: ['pitch', 'ridge_az'], hip: ['pitch', 'ridge_az'], pyramid: ['pitch', 'ridge_az'], shed: ['pitch', 'ridge_az'],
  mansard: ['pitch', 'pitch2', 'rise', 'ridge_az'], gambrel: ['pitch', 'pitch2', 'rise', 'ridge_az'], butterfly: ['pitch', 'ridge_az'],
  sawtooth: ['pitch', 'width', 'ridge_az'], barrel: ['rise', 'ridge_az'], cone: ['rise'], dome: ['rise'],
};
export const ROOF_DEFAULTS = {
  parapet: { rise: 1 }, gable: { pitch: ROOF_PITCH }, hip: { pitch: ROOF_PITCH }, pyramid: { pitch: ROOF_PITCH }, shed: { pitch: ROOF_PITCH },
  mansard: { pitch: 70, pitch2: 20, rise: 2.5 }, gambrel: { pitch: 60, pitch2: 25, rise: 2.5 }, butterfly: { pitch: 10 }, sawtooth: { pitch: 25, width: 6 },
  barrel: { rise: null }, cone: { rise: null }, dome: { rise: null },
};
// Roofs PV is not laid on by "Panels on this roof": the curved ones and the sawtooth
export const NO_PANELS = ['sawtooth', 'barrel', 'cone', 'dome'];

// A dome's profile over rho (0 at its top, 1 at its rim) for a height e times its half width: a spherical cap up to a
// hemisphere (e = 1), a half ellipsoid stretched upward past it (cap_profile)
export function capProfile(rho, e) {
  if (!(rho < 1)) return 0;
  if (e >= 1) return Math.sqrt(1 - rho * rho);
  const s = (1 + e * e) / (2 * e);
  return (Math.sqrt(s * s - rho * rho) - (s - e)) / e;
}

// The largest ellipse of the outline's own proportions inside it: { c, u (unit long axis), a, b (half axes, a >= b) } from the
// second moments of its area, centred on its centroid; null when the centroid lies outside it (ellipse_fit)
export function ellipseFit(m) {
  const n = m.length;
  if (n < 3) return null;
  const [mx, my] = centroid(m);
  let a2 = 0, sx = 0, sy = 0, ixx = 0, iyy = 0, ixy = 0;
  for (let i = 0; i < n; i++) {
    const p = m[i], q = m[(i + 1) % n], x0 = p[0] - mx, y0 = p[1] - my, x1 = q[0] - mx, y1 = q[1] - my, cr = x0 * y1 - x1 * y0;
    a2 += cr; sx += (x0 + x1) * cr; sy += (y0 + y1) * cr;
    ixx += (x0 * x0 + x0 * x1 + x1 * x1) * cr; iyy += (y0 * y0 + y0 * y1 + y1 * y1) * cr; ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr;
  }
  if (!(Math.abs(a2) > 1e-9)) return null;
  const cx = sx / (3 * a2), cy = sy / (3 * a2), sxx = ixx / (6 * a2) - cx * cx, syy = iyy / (6 * a2) - cy * cy, sxy = ixy / (12 * a2) - cx * cy;
  const mid = (sxx + syy) / 2, dev = Math.hypot((sxx - syy) / 2, sxy), l1 = mid + dev, l2 = mid - dev;
  if (!(l2 > 0)) return null;
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), u = [Math.cos(th), Math.sin(th)], q = Math.sqrt(l1 / l2), c = [cx + mx, cy + my];
  if (!inPoly(c, m)) return null;
  const loc = (p) => { const dx = p[0] - c[0], dy = p[1] - c[1]; return [(dx * u[0] + dy * u[1]) / q, -dx * u[1] + dy * u[0]]; };
  let t = Infinity;
  for (let i = 0; i < n; i++) {
    const p = loc(m[i]), r = loc(m[(i + 1) % n]), ex = r[0] - p[0], ey = r[1] - p[1], l = ex * ex + ey * ey;
    const s = l > 0 ? Math.min(1, Math.max(0, -(p[0] * ex + p[1] * ey) / l)) : 0;
    t = Math.min(t, Math.hypot(p[0] + s * ex, p[1] + s * ey));
  }
  return t > 0.01 ? { c, u, a: q * t, b: t } : null;
}

// The roof of a building on its plan corners m ([x, y] metres), walls H high: { kind, H, top, planes: [[a, b, c]], max, h(p),
// rise } with planes absolute heights a + b x + c y, the roof the lowest of them (the highest with max: a butterfly) and never
// below H. A flat roof, a parapet's, a sawtooth, a vault, a cone and a dome have no planes and a height of their own. As
// engine/src/shading.rs.
export function roofOf(g, m) {
  const H = +g.height || 6, kind = ROOFS.includes(g.roof) ? g.roof : 'flat', d = ROOF_DEFAULTS[kind] || {};
  const flat = { kind: 'flat', H, top: H, planes: [], h: () => H };
  if (kind === 'flat' || m.length < 3) return flat;
  const pitch = (v, def) => (v > 0 ? Math.min(75, Math.max(1, v)) : def);
  const p1 = pitch(+g.pitch, d.pitch), k = Math.tan(p1 * R), az = (+g.ridge_az || 0) * R, sa = Math.sin(az), ca = Math.cos(az);
  const lim = kind === 'parapet' ? 10 : 200, given = +g.rise > 0 ? Math.min(lim, Math.max(0.1, +g.rise)) : null;
  const r = [sa, ca], n = [ca, -sa];
  const span = (dd) => { const s = m.map((p) => p[0] * dd[0] + p[1] * dd[1]); return [Math.min(...s), Math.max(...s)]; };
  const [u0, u1] = span(r), [v0, v1] = span(n), uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, A = (u1 - u0) / 2, B = (v1 - v0) / 2;
  // z0 + kk (s0 + s * (dd . p))
  const lin = (z0, kk, s0, s, dd) => [z0 + kk * s0, kk * s * dd[0], kk * s * dd[1]];
  const planar = (planes, top, max = false) => {
    const at = (p) => planes.reduce((acc, [a, b, c]) => (max ? Math.max : Math.min)(acc, a + b * p[0] + c * p[1]), max ? -Infinity : Infinity);
    return { kind, H, k, top, planes, max, h: (p) => Math.max(H, at(p)) };
  };
  const sides = [[B + vc, -1, n], [B - vc, 1, n]], ends = [[A + uc, -1, r], [A - uc, 1, r]];
  if (kind === 'parapet') {
    const rise = given || d.rise;
    return { kind, H, top: H + rise, rise, planes: [], h: () => H };
  }
  if (kind === 'shed') return planar([lin(H, k, u1, -1, r)], H + k * (u1 - u0));
  if (kind === 'gable') return planar(sides.map(([s0, s, dd]) => lin(H, k, s0, s, dd)), H + k * B);
  if (kind === 'hip') return planar([...sides, ...ends].map(([s0, s, dd]) => lin(H, k, s0, s, dd)), H + k * Math.min(A, B));
  if (kind === 'pyramid') return planar([...sides.map(([s0, s, dd]) => lin(H, k, s0, s, dd)), ...ends.map(([s0, s, dd]) => lin(H, k * B / A, s0, s, dd))], H + k * B);
  if (kind === 'butterfly') return planar([lin(H, k, -vc, 1, n), lin(H, k, vc, -1, n)], H + k * B, true);
  if (kind === 'mansard' || kind === 'gambrel') {
    const k2 = Math.tan(Math.min(p1, pitch(+g.pitch2, d.pitch2)) * R), rise = given || d.rise, planes = [];
    for (const [s0, s, dd] of kind === 'mansard' ? [...sides, ...ends] : sides) planes.push(lin(H, k, s0, s, dd), lin(H + rise - k2 * rise / k, k2, s0, s, dd));
    const dm = kind === 'mansard' ? Math.min(A, B) : B;
    return { ...planar(planes, H + Math.min(k * dm, rise + k2 * (dm - rise / k))), rise };
  }
  if (kind === 'sawtooth') {
    // teeth w wide along t = -(r . p) from t0: each rises at k to H + k w, then a vertical face down to H
    const w = +g.width > 0 ? Math.min(100, Math.max(1, +g.width)) : d.width, t0 = -u1, t1 = -u0;
    const tooth = (dt) => (dt <= 1e-9 ? 0 : dt - w * (Math.ceil(dt / w - 1e-9) - 1));
    const tOf = (p) => -(p[0] * sa + p[1] * ca);
    const steps = [];
    for (let s = t0 + w; s < t1 - 1e-9; s += w) steps.push(s);
    return { kind, H, k, w, t0, t1, steps, top: H + k * Math.min(w, t1 - t0), planes: [], h: (p) => H + k * tooth(tOf(p) - t0), tOf,
             // the height on the tooth holding plan point `mid` (either side of a step)
             zOn: (p, mid) => { const j = Math.max(0, Math.ceil((tOf(mid) - t0) / w) - 1); return H + k * Math.min(w, Math.max(0, tOf(p) - t0 - j * w)); } };
  }
  if (kind === 'barrel') {
    if (!(B > 0)) return flat;
    const rise = given || B / 2;
    return { kind, H, top: H + rise, rise, vc, B, n, planes: [], h: (p) => H + rise * capProfile(Math.abs(p[0] * n[0] + p[1] * n[1] - vc) / B, rise / B) };
  }
  // cone and dome over the ellipse that fits the footprint
  const fit = ellipseFit(m);
  if (!fit) return flat;
  const cone = kind === 'cone', rise = given || (cone ? fit.b : fit.b / 2), { c, u, a, b } = fit;
  const rho = (p) => { const dx = p[0] - c[0], dy = p[1] - c[1]; return Math.hypot((dx * u[0] + dy * u[1]) / a, (-dx * u[1] + dy * u[0]) / b); };
  return { kind, H, top: H + rise, rise, fit, rho, planes: [],
           h: (p) => H + rise * (cone ? Math.max(0, 1 - rho(p)) : capProfile(rho(p), rise / b)) };
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
const solidPiece = (poly) => poly.length >= 3 && Math.abs(area2(poly)) > 1e-6;
// The roof planes as plan polygons: plane j over the part of the footprint where it is the roof (the lowest, or the highest
// of a butterfly)
export function roofPieces(roof, m) {
  if (!roof.planes.length) return [{ poly: m, j: -1 }];
  const sg = roof.max ? -1 : 1;
  return roof.planes.map((pj, j) => {
    let poly = m;
    roof.planes.forEach((pk, i) => { if (i !== j && poly.length >= 3) poly = clipHalf(poly, [sg * (pj[0] - pk[0]), sg * (pj[1] - pk[1]), sg * (pj[2] - pk[2])]); });
    return { poly, j };
  }).filter((x) => solidPiece(x.poly));
}

// The points of edge a-b where the roof bends (two planes meet), as fractions 0-1, in order
export function edgeBreaks(roof, a, b) {
  const t = [];
  const P = roof.planes, at = (p) => P.reduce((acc, [x, y, z]) => (roof.max ? Math.max : Math.min)(acc, x + y * p[0] + z * p[1]), roof.max ? -Infinity : Infinity);
  for (let j = 0; j < P.length; j++) for (let i = j + 1; i < P.length; i++) {
    const f = (p) => (P[j][0] - P[i][0]) + (P[j][1] - P[i][1]) * p[0] + (P[j][2] - P[i][2]) * p[1], fa = f(a), fb = f(b);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const s = fa / (fa - fb), p = [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])], v = P[j][0] + P[j][1] * p[0] + P[j][2] * p[1];
      if (Math.abs(v - at(p)) < 1e-9 * (1 + Math.abs(v))) t.push(s);
    }
  }
  return t.sort((x, y) => x - y);
}

// Where a line (value f(p) = a + b x + c y crossing 0) cuts edge a-b, as a fraction, or null
const crossAt = (f, a, b) => { const fa = f(a), fb = f(b); return (fa < 0 && fb > 0) || (fa > 0 && fb < 0) ? fa / (fa - fb) : null; };
// Strips of a barrel vault across its axis: their bounding lines v = const
const barrelCuts = (roof, detail) => { const N = detail ? 16 : 8; return Array.from({ length: N + 1 }, (_, i) => roof.vc - roof.B + 2 * roof.B * i / N); };

// The top of the wall on edge a-b: [x, y, z] corners from a to b, where the roof bends or steps on it too
export function wallTop(roof, a, b, detail = true) {
  const at = (t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  if (roof.kind === 'parapet') return [[...a, roof.top], [...b, roof.top]];
  let ts = [], zOn = (p, _mid) => roof.h(p);
  if (roof.planes.length) ts = edgeBreaks(roof, a, b);
  else if (roof.kind === 'sawtooth') { ts = roof.steps.map((s) => crossAt((p) => roof.tOf(p) - s, a, b)); zOn = roof.zOn; }
  else if (roof.kind === 'barrel') ts = barrelCuts(roof, detail).map((v) => crossAt((p) => p[0] * roof.n[0] + p[1] * roof.n[1] - v, a, b));
  ts = [0, ...ts.filter((t) => t != null).sort((x, y) => x - y), 1];
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const mid = at((ts[i] + ts[i + 1]) / 2);
    for (const t of [ts[i], ts[i + 1]]) {
      const p = at(t), z = zOn(p, mid), last = out[out.length - 1];
      if (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) + Math.abs(last[2] - z) > 1e-9) out.push([p[0], p[1], z]);
    }
  }
  return out;
}

// Distance from c along unit direction d to the outline m (the nearest crossing), or -1
function rayTo(c, d, m) {
  let best = -1;
  for (let i = 0, j = m.length - 1; i < m.length; j = i++) {
    const ax = m[j][0] - c[0], ay = m[j][1] - c[1], ex = m[i][0] - m[j][0], ey = m[i][1] - m[j][1], den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den, s = (ax * d[1] - ay * d[0]) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9 && (best < 0 || t < best)) best = t;
  }
  return best;
}

const GREY = '#8a8780';
// The roof's surfaces over plan corners m as faces { pts: [[x, y, z]], kind ('roof' or 'building'), col }: the planes of a
// pitched roof, a flat roof with its parapet, the teeth and vertical faces of a sawtooth, the strips of a vault, and a cone or
// dome as a grid of `detail ? 24 : 12` segments round (and the outline's corners) by `detail ? 8 : 4` up, the flat roof round
// it ring by ring when the outline holds its centre in view from every corner, else as one polygon under it.
export function roofFaces(roof, m, detail = true) {
  const out = [], face = (pts, kind = 'roof', col) => out.push({ pts, kind, col });
  const at = (poly, z) => poly.map((p) => [p[0], p[1], typeof z === 'function' ? z(p) : z]);
  if (roof.kind === 'flat') { face(at(m, roof.H), 'roof', GREY); return out; }
  if (roof.planes.length) { for (const { poly } of roofPieces(roof, m)) face(at(poly, roof.h)); return out; }
  if (roof.kind === 'parapet') {
    face(at(m, roof.H), 'roof', GREY);
    const inner = insetPoly(m, Math.min(0.25, roof.rise));
    if (inner) m.forEach((p, i) => {
      const q = m[(i + 1) % m.length], a = inner[i], b = inner[(i + 1) % m.length];
      face([[...a, roof.H], [...b, roof.H], [...b, roof.top], [...a, roof.top]], 'building');
      face([[...p, roof.top], [...q, roof.top], [...b, roof.top], [...a, roof.top]], 'building');
    });
    return out;
  }
  if (roof.kind === 'sawtooth') {
    const { t0, t1, w, k, H } = roof, g = [roof.tOf([1, 0]), roof.tOf([0, 1])];   // t = g . p
    for (let lo = t0; lo < t1 - 1e-9; lo += w) {
      let poly = clipHalf(m, [lo, -g[0], -g[1]]);   // t >= lo
      if (poly.length >= 3) poly = clipHalf(poly, [-(lo + w), g[0], g[1]]);   // t <= lo + w
      if (solidPiece(poly)) face(at(poly, (p) => H + k * Math.min(w, Math.max(0, roof.tOf(p) - lo))));
    }
    // the vertical faces: the footprint's chords on each step line
    for (const st of roof.steps) {
      const f = (p) => roof.tOf(p) - st, xs = [];
      m.forEach((a, i) => { const b = m[(i + 1) % m.length], t = crossAt(f, a, b); if (t != null) xs.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); });
      const dir = [g[1], -g[0]];
      xs.sort((p, q) => (p[0] - q[0]) * dir[0] + (p[1] - q[1]) * dir[1]);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const [p, q] = [xs[i], xs[i + 1]];
        face([[...p, H], [...q, H], [...q, H + k * w], [...p, H + k * w]], 'building');
      }
    }
    return out;
  }
  if (roof.kind === 'barrel') {
    const cuts = barrelCuts(roof, detail), n = roof.n;
    for (let i = 0; i + 1 < cuts.length; i++) {
      let poly = clipHalf(m, [cuts[i], -n[0], -n[1]]);   // v >= cuts[i]
      if (poly.length >= 3) poly = clipHalf(poly, [-cuts[i + 1], n[0], n[1]]);   // v <= cuts[i + 1]
      if (solidPiece(poly)) face(at(poly, roof.h));
    }
    return out;
  }
  // cone and dome
  const { c, u, a, b } = roof.fit, v = [-u[1], u[0]], sg = Math.sign(area2(m)) || 1;
  const star = m.every((p, i) => { const q = m[(i + 1) % m.length]; return sg * ((q[0] - p[0]) * (c[1] - p[1]) - (q[1] - p[1]) * (c[0] - p[0])) > 1e-9; });
  const nA = detail ? 24 : 12, nUp = roof.kind === 'cone' ? 1 : detail ? 8 : 4, phis = Array.from({ length: nA }, (_, i) => i * 2 * Math.PI / nA);
  if (star && m.length <= 400) for (const p of m) { const dx = p[0] - c[0], dy = p[1] - c[1]; phis.push(Math.atan2((dx * v[0] + dy * v[1]) / b, (dx * u[0] + dy * u[1]) / a)); }
  const ang = phis.map((x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((x, y) => x - y).filter((x, i, l) => i === 0 || x - l[i - 1] > 1e-9);
  const pt = (rho, phi) => { const x = c[0] + rho * (a * Math.cos(phi) * u[0] + b * Math.sin(phi) * v[0]), y = c[1] + rho * (a * Math.cos(phi) * u[1] + b * Math.sin(phi) * v[1]); return [x, y, roof.h([x, y])]; };
  const rhos = Array.from({ length: nUp + 1 }, (_, i) => (roof.kind === 'cone' ? i / nUp : Math.sin(i / nUp * Math.PI / 2)));
  const grid = rhos.map((rho, i) => ang.map((phi) => (i === 0 ? [c[0], c[1], roof.top] : pt(rho, phi))));
  grid.forEach((row, i) => i > 0 && ang.forEach((_, j) => {
    const k = (j + 1) % ang.length;
    face(i === 1 ? [grid[0][0], row[j], row[k]] : [grid[i - 1][j], row[j], row[k], grid[i - 1][k]]);
  }));
  if (star) {
    const rim = grid[nUp], edge = ang.map((phi, j) => { const p = rim[j], d = [p[0] - c[0], p[1] - c[1]], l = Math.hypot(d[0], d[1]) || 1, t = rayTo(c, [d[0] / l, d[1] / l], m); return [c[0] + d[0] / l * t, c[1] + d[1] / l * t, roof.H]; });
    ang.forEach((_, j) => { const k = (j + 1) % ang.length; face([[rim[j][0], rim[j][1], roof.H], edge[j], edge[k], [rim[k][0], rim[k][1], roof.H]], 'roof', GREY); });
  } else face(at(m, roof.H), 'roof', GREY);
  return out;
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
// height with the project's rows (behind a parapet, kept the parapet's height further in, where its shade is short); on a
// planar roof one area per plane facing within 100 deg of the equator, flush with the plane (tilt and ground slope the plane's
// pitch, the table centre `standoff` above it). Corners kept `setback` from the roof edges. None on a sawtooth, vault, cone or
// dome (NO_PANELS).
export function roofArrays(g, pr, lat, { setback = 0.5, standoff = 0.15 } = {}) {
  const m = g.latlngs.map(pr.fwd), roof = roofOf(g, m), eq = lat >= 0 ? 180 : 0, out = [];
  if (NO_PANELS.includes(roof.kind)) return out;
  if (roof.kind === 'parapet') setback += roof.rise;
  for (const { poly, j } of roofPieces(roof, m)) {
    const inner = insetPoly(poly, setback);
    if (!inner) continue;
    const latlngs = inner.map((p) => pr.inv(p).map((v) => +v.toFixed(7)));
    if (j < 0) { out.push({ type: 'site', latlngs, base: +roof.H.toFixed(2) }); continue; }
    const az = planeAzimuth(roof.planes[j]);
    if (azOff(az, eq) > 100) continue;
    const pitch = Math.atan(Math.hypot(roof.planes[j][1], roof.planes[j][2])) / R, c = centroid(inner);
    out.push({ type: 'site', latlngs, base: +roof.h(c).toFixed(2), tilt: +pitch.toFixed(1), azimuth: +az.toFixed(1), canopy: true,
               slope: +Math.min(45, pitch).toFixed(1), slope_azimuth: +az.toFixed(1), h0: standoff, rooftop: true });
  }
  return out;
}
