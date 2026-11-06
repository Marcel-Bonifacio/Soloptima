// The geometry of the layout map: projections, polygon tests, keepout strips, and the fill of a PV area with tables. It
// needs neither the page nor the project, so tests/layout_geometry.test.js runs it under Node. Lengths are metres in a local
// frame (x east, y north) unless a function says [lat, lon].
const pathLength = (pts) => { const pr = localProjector(pts), m = pts.map(pr.fwd); return m.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - m[i][0], p[1] - m[i][1]), 0); };

function projector(lat0, lon0) {
  const ky = 110574, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  return { fwd: ([la, lo]) => [(lo - lon0) * kx, (la - lat0) * ky], inv: ([x, y]) => [lat0 + y / ky, lon0 + x / kx] };
}
function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToEdges(pt, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2)) : 0;
    d = Math.min(d, Math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy)));
  }
  return d;
}
const segX = ([ax, ay], [bx, by], [cx, cy], [dx, dy]) => { const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (!d) return false; const s = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, t = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d; return s > 0 && s < 1 && t > 0 && t < 1; };
const edgesCross = (a, b) => a.some((p, i) => b.some((q, j) => segX(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
// Projector centred on the mean of a set of [lat, lon] points.
const localProjector = (pts) => projector(pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length);

const boxOf = (poly) => poly.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
// Footprint of a saved item as [lat, lon] corners (a tree's crown as a 16-sided polygon, as the engine takes it).
function footprint(g) {
  if (!g.center) return g.latlngs;
  const pr = projector(g.center[0], g.center[1]), r = g.diameter / 2;
  return Array.from({ length: 16 }, (_, k) => pr.inv([r * Math.sin(k * Math.PI / 8), r * Math.cos(k * Math.PI / 8)]));
}

// A keepout line as a polygon: the centre line [lat, lon] pairs with square ends, widened to `width` metres by offsetting
// each side, with mitred joins (a sharp bend stops at twice the half width).
function stripOf(path, width) {
  const pr = localProjector(path), h = width / 2, pts = path.map(pr.fwd), n = pts.length;
  const dir = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
  const d0 = dir(pts[0], pts[1]), d1 = dir(pts[n - 2], pts[n - 1]);
  pts[0] = [pts[0][0] - d0[0] * h, pts[0][1] - d0[1] * h];   // square ends reach half a width past the first and last point
  pts[n - 1] = [pts[n - 1][0] + d1[0] * h, pts[n - 1][1] + d1[1] * h];
  const side = (s) => pts.map((p, i) => {
    const a = i > 0 ? dir(pts[i - 1], p) : dir(p, pts[1]), b = i < n - 1 ? dir(p, pts[i + 1]) : a;
    let mx = -a[1] - b[1], my = a[0] + b[0];   // the two left normals added
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) { mx = -b[1]; my = b[0]; } else { mx /= ml; my /= ml; }
    const k = h / Math.max(0.5, mx * -b[1] + my * b[0]);
    return [p[0] + s * mx * k, p[1] + s * my * k];
  });
  return side(1).concat(side(-1).reverse()).map(pr.inv).map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)]);
}
// The polygons (local metres, fwd) tables must keep off for one item: its footprint, or for a keepout line a rectangle for
// each segment with square ends, so a self-overlapping bend cannot open a hole.
function blockedOf(g, fwd) {
  if (g.kind !== 'path') return [footprint(g).map(fwd)];
  const h = g.width / 2, pts = g.path.map(fwd);
  return pts.slice(1).map((b, i) => {
    const a = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
    const p = [a[0] - ux * h, a[1] - uy * h], q = [b[0] + ux * h, b[1] + uy * h];
    return [[p[0] - uy * h, p[1] + ux * h], [q[0] - uy * h, q[1] + ux * h], [q[0] + uy * h, q[1] - ux * h], [p[0] + uy * h, p[1] - ux * h]];
  });
}
// Whether polygons a and b come closer than d (when they do not touch): a corner of one nearer than d to an edge of the other.
const closerThan = (a, b, d) => a.some((p) => distToEdges(p, b) < d) || b.some((p) => distToEdges(p, a) < d);


// Where the tables of a PV area start: the corner of its bounding box in row coordinates, moved in by the setback.
function gridOf(site, g, setback) {
  const { r, f } = g, toUV = ([x, y]) => [x * r[0] + y * r[1], x * f[0] + y * f[1]], box = boxOf(site.map(toUV)), sb = setback || 0;
  return { toUV, box, u0: box[0] + sb, v0: box[1] + sb };
}
// One PV area filled with tables: rows at the pitch from the setback inward, the first a fraction dv of a pitch further in
// and the first table of each row `shift` metres along it; after every `aisle_every` rows a strip of `aisle_width` is left.
// Along a row a table goes in where it fits clear of the blocked polygons X (each kept C[i] metres away), else the next try
// is an eighth of a table on. East-west tables stand in pairs, ridge to ridge. Corners: the upper edge first.
function fillArea(lay, site, X, C, g, dv, shift = 0) {
  const { r, f, along, depth, pitch, ew } = g, setback = lay.setback || 0, unit = ew ? 2 * depth : depth;
  const every = lay.aisle_every > 0 ? Math.floor(lay.aisle_every) : 0, aisle = every ? Math.max(0, lay.aisle_width || 0) : 0;
  const { toUV, box: [umin, vmin, umax, vmax] } = gridOf(site, g, lay.setback);
  const toXY = ([u, v]) => [u * r[0] + v * f[0], u * r[1] + v * f[1]];
  // boxes of the blocked polygons in row coordinates, grown by their clearance
  const xb = X.map((x, i) => { const b = boxOf(x.map(toUV)); return [b[0] - C[i], b[1] - C[i], b[2] + C[i], b[3] + C[i]]; });
  const out = [];
  for (let row = 0, v = vmin + setback + dv * pitch; v + unit <= vmax - setback + 1e-6; v += pitch + (every && ++row % every === 0 ? aisle : 0)) {
    const inRow = X.map((_, i) => i).filter((i) => xb[i][1] <= v + unit && xb[i][3] >= v);   // blocked polygons reaching this row
    for (let u = umin + setback + shift; u + along <= umax - setback + 1e-6;) {
      const corners = [[u, v], [u + along, v], [u + along, v + unit], [u, v + unit]].map(toXY);
      const probes = corners.concat([toXY([u + along / 2, v + unit / 2]), toXY([u + along / 2, v]), toXY([u + along / 2, v + unit])]);
      const ok = probes.every((p) => inPoly(p, site)) && !edgesCross(corners, site) && (setback <= 0 || corners.every((p) => distToEdges(p, site) >= setback - 1e-6)) &&
                 !inRow.some((i) => xb[i][0] <= u + along && xb[i][2] >= u &&
                                    (probes.some((p) => inPoly(p, X[i])) || X[i].some((q) => inPoly(q, corners)) || edgesCross(corners, X[i]) ||
                                     (C[i] > 0 && closerThan(corners, X[i], C[i]))));
      if (ok) {
        if (!ew) out.push(corners);
        else out.push([[u, v + depth], [u + along, v + depth], [u + along, v], [u, v]].map(toXY),
                      [[u, v + depth], [u + along, v + depth], [u + along, v + unit], [u, v + unit]].map(toXY));
        u += along + (lay.table_gap || 0);
      } else u += Math.max(0.5, along / 8);
    }
  }
  return out;
}
// Area of a polygon of [x, y] corners (shoelace)
function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
// Plan area (m²) of a polygon of [lat, lon] corners
const areaLatLng = (pts) => polyArea(pts.map(localProjector(pts).fwd));

export { polyArea, areaLatLng, projector, inPoly, distToEdges, edgesCross, localProjector, boxOf, footprint, stripOf, blockedOf, closerThan, pathLength, gridOf, fillArea };
