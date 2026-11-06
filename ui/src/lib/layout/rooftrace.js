// Roof outline from an image on the layout map (the user's own orthophoto, Ortho) around a clicked point. A region grows from the
// click over pixels close to the roof's colour (CIELAB distance to the colour at the click, plus half the colour change across
// about a metre, so edges cost more to cross), on an image smoothed over about half a metre so the ribs of sheeting and gravel
// do not stop it. The colour threshold is the one at which the region is most stable; when the region reaches the edge of the
// window first, the window steps out one zoom level; when it reaches the edge of the image, the roof is reported as running
// off the image. Gaps of about half a metre close and necks of about 2 m are cut; the edge is then set where the colour changes,
// each pixel near it going to the side whose local mean colour is nearer its own. Openings of a few square metres or more stay
// as holes (rooftop units, skylights). The outline is simplified (Douglas-Peucker), then taken as its smallest rectangle when
// it nearly fills it, or else has its edges near the roof's two main directions squared to them. The user reviews the result.
import { polyArea } from './geometry.js';

const MAX_T = 40, MIN_ROOF_M2 = 8, MIN_HOLE_M2 = 4, MAX_HOLES = 15;
const WINDOW = 768;   // pixels a side of the window round the click

// ---------------------------------------------------------------- image
// Box blur of radius r (a 2r + 1 wide running mean), along the rows then the columns, edges repeated.
function boxBlur(ch, n, r) {
  const t = new Float32Array(ch.length), w = 2 * r + 1, at = (i) => Math.min(n - 1, Math.max(0, i));
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let s = 0;
    for (let k = -r; k <= r; k++) s += ch[row + at(k)];
    for (let x = 0; x < n; x++) { t[row + x] = s / w; s += ch[row + at(x + r + 1)] - ch[row + at(x - r)]; }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += t[at(k) * n + x];
    for (let y = 0; y < n; y++) { ch[y * n + x] = s / w; s += t[at(y + r + 1) * n + x] - t[at(y - r) * n + x]; }
  }
}
// CIELAB (D65) of sRGB pixels, smoothed by two box blurs of radius r.
function lab(rgba, n, r) {
  const L = new Float32Array(n * n), A = new Float32Array(n * n), B = new Float32Array(n * n);
  const table = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let p = 0; p < n * n; p++) {
    const red = table[rgba[4 * p]], g = table[rgba[4 * p + 1]], b = table[rgba[4 * p + 2]];
    const fx = f((0.4124 * red + 0.3576 * g + 0.1805 * b) / 0.95047), fy = f(0.2126 * red + 0.7152 * g + 0.0722 * b);
    const fz = f((0.0193 * red + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[p] = 116 * fy - 16; A[p] = 500 * (fx - fy); B[p] = 200 * (fy - fz);
  }
  for (const ch of [L, A, B]) { boxBlur(ch, n, r); boxBlur(ch, n, r); }
  return [L, A, B];
}

// Level at which each pixel joins the region grown from the seed: the lowest threshold T for which a path from the seed has
// every pixel's cost at most T (a bucket-queue flood in steps of 0.5); pixels marked in `outside` never join. Cost: the colour
// distance to the mean round the seed plus half the colour change across 2r pixels.
function joinLevels(lab3, n, seed, r, outside) {
  const [L, A, B] = lab3, N = n * n, len = (a, b, c) => Math.sqrt(a * a + b * b + c * c);
  let sl = 0, sa = 0, sb = 0, c = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) { const p = seed + dy * n + dx; sl += L[p]; sa += A[p]; sb += B[p]; c++; }
  sl /= c; sa /= c; sb /= c;
  const cost = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const x = p % n, y = (p - x) / n;
    const xl = p - Math.min(r, x), xr = p + Math.min(r, n - 1 - x), yu = p - Math.min(r, y) * n, yd = p + Math.min(r, n - 1 - y) * n;
    const g = len(L[xr] - L[xl], A[xr] - A[xl], B[xr] - B[xl]) + len(L[yd] - L[yu], A[yd] - A[yu], B[yd] - B[yu]);
    cost[p] = len(L[p] - sl, A[p] - sa, B[p] - sb) + 0.5 * g;
  }
  const STEPS = 2 * MAX_T + 1, level = new Float32Array(N).fill(Infinity), buckets = Array.from({ length: STEPS }, () => []);
  const nb = new Int32Array(4);
  level[seed] = 0;
  buckets[0].push(seed);
  for (let k = 0; k < STEPS; k++) {
    const q = buckets[k], T = k / 2;
    for (let i = 0; i < q.length; i++) {
      const p = q[i];
      if (level[p] !== T) continue;
      const x = p % n;
      nb[0] = x > 0 ? p - 1 : -1; nb[1] = x < n - 1 ? p + 1 : -1; nb[2] = p - n; nb[3] = p + n;
      for (let j = 0; j < 4; j++) {
        const s = nb[j];
        if (s < 0 || s >= N || outside[s] || level[s] <= T) continue;
        const lv = Math.max(T, Math.ceil(cost[s] * 2) / 2);
        if (lv < level[s] && lv <= MAX_T) { level[s] = lv; buckets[lv * 2].push(s); }
      }
    }
  }
  return level;
}

// The threshold of the most stable region (Matas et al. 2002): of the thresholds T whose region covers at least a small roof
// and stays off the window's edge and the image's edge (the pixels marked in `band`) up to T + 2, the one where the region's
// size changes least from T - 2 to T + 2 relative to its size. { T }; or, when the region reaches an edge before it is
// stable, the edge it reached first: { edge: 'window' } (a roof larger than the window) or { edge: 'image' }; or null.
function pickThreshold(level, n, minPx, band) {
  const K = 2 * MAX_T, D = 4, WIN = 1, IMG = 2, hist = new Float64Array(K + 1), edge = new Uint8Array(K + 1);
  for (let p = 0; p < level.length; p++) {
    if (!isFinite(level[p])) continue;
    const k = level[p] * 2, x = p % n, y = (p - x) / n;
    hist[k]++;
    if (band[p]) edge[k] |= IMG;
    else if (x === 0 || y === 0 || x === n - 1 || y === n - 1) edge[k] |= WIN;
  }
  const size = new Float64Array(K + 1), touched = new Uint8Array(K + 1);
  for (let k = 0; k <= K; k++) { size[k] = (k ? size[k - 1] : 0) + hist[k]; touched[k] = (k ? touched[k - 1] : 0) | edge[k]; }
  let best = -1, q = Infinity;
  for (let k = D; k + D <= K; k++) {
    if (size[k] < minPx || touched[k + D]) continue;
    const change = (size[k + D] - size[k - D]) / size[k];
    if (change < q) { q = change; best = k; }
  }
  if (best >= 0) return { T: best / 2 };
  const first = touched.find((t) => t !== 0);
  return first ? { edge: first & IMG ? 'image' : 'window' } : null;
}

// ---------------------------------------------------------------- mask
// Sum over the square of side 2r + 1 round each pixel, outside the window counting as zero: running sums along the rows,
// then the columns.
function boxSum(src, n, r) {
  const t = new Float32Array(src.length), out = new Float32Array(src.length);
  const run = (from, to, a, b) => {   // element k of line i is at i * a + k * b
    for (let i = 0; i < n; i++) {
      const o = i * a;
      let s = 0;
      for (let k = 0; k < r && k < n; k++) s += from[o + k * b];
      for (let k = 0; k < n; k++) {
        if (k + r < n) s += from[o + (k + r) * b];
        if (k > r) s -= from[o + (k - r - 1) * b];
        to[o + k * b] = s;
      }
    }
  };
  run(src, t, n, 1);
  run(t, out, 1, n);
  return out;
}
// Dilation (grow) or erosion of a mask by a square of side 2r + 1.
function morph(mask, n, r, grow) {
  const s = boxSum(mask, n, r), full = (2 * r + 1) ** 2, out = new Uint8Array(mask.length);
  for (let p = 0; p < out.length; p++) out[p] = grow ? (s[p] > 0 ? 1 : 0) : (s[p] === full ? 1 : 0);
  return out;
}
// The region's edge set where the colour changes. The smoothing and the colour-change term stop the region short of a roof's
// edge, by more the stronger the edge's contrast. Each pixel from r inside the region's boundary to 2r outside it goes to the
// side whose mean colour within 4r of it is nearer its own colour (smoothed over 5 x 5 pixels): inside, the region less a
// margin of r; outside, the surroundings beyond a margin of 2r. Pixels with no reference on either side stay as they are.
function refine(mask, rgba, n, r, outside) {
  const N = n * n, R = 4 * r, inner = morph(mask, n, r, false), outer = morph(mask, n, 2 * r, true);
  const beyond = new Uint8Array(N);
  for (let p = 0; p < N; p++) beyond[p] = outer[p] || outside[p] ? 0 : 1;
  const colour = lab(rgba, n, 1);
  const sums = (sel) => [boxSum(sel, n, R)].concat(colour.map((ch) => boxSum(ch.map((v, p) => (sel[p] ? v : 0)), n, R)));
  const I = sums(inner), O = sums(beyond), out = mask.slice();
  const d2 = (S, p) => {   // squared distance of pixel p's colour from the mean S gives round it
    let d = 0;
    for (let k = 0; k < 3; k++) { const e = colour[k][p] - S[k + 1][p] / S[0][p]; d += e * e; }
    return d;
  };
  for (let p = 0; p < N; p++)
    if (outer[p] && !inner[p] && !outside[p] && I[0][p] && O[0][p]) out[p] = d2(I, p) < d2(O, p) ? 1 : 0;
  return out;
}
// Components of the pixels where mask equals `value`, 4-connected: label per pixel (0 none) and the pixel count of each.
function components(mask, n, value) {
  const N = mask.length, lab = new Int32Array(N), sizes = [0], stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (mask[s] !== value || lab[s]) continue;
    const id = sizes.length;
    let count = 0, top = 0;
    lab[s] = id;
    stack[top++] = s;
    const visit = (q) => { if (mask[q] === value && !lab[q]) { lab[q] = id; stack[top++] = q; } };
    while (top) {
      const p = stack[--top], x = p % n;
      count++;
      if (x > 0) visit(p - 1);
      if (x < n - 1) visit(p + 1);
      if (p >= n) visit(p - n);
      if (p < N - n) visit(p + n);
    }
    sizes.push(count);
  }
  return { lab, sizes };
}

// Outer boundary of the pixels with lab === id, as the pixel corners met walking along the pixel edges with the region on the
// right (4-connected, so pixels touching only at a corner are apart). The walk starts right along the top edge of the
// region's first pixel and ends back there.
function trace(lab, n, id) {
  const first = lab.indexOf(id);
  if (first < 0) return [];
  const inside = (x, y) => x >= 0 && y >= 0 && x < n && y < n && lab[y * n + x] === id;
  const sx = first % n, sy = (first - sx) / n;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];                 // right, down, left, up
  const AL = [[0, -1], [0, 0], [-1, 0], [-1, -1]], AR = [[0, 0], [-1, 0], [-1, -1], [0, -1]];   // pixels ahead-left / -right of a corner
  const pts = [];
  let x = sx, y = sy, d = 0;
  for (let step = 0; step <= 4 * lab.length; step++) {
    x += DX[d]; y += DY[d];
    const right = inside(x + AR[d][0], y + AR[d][1]), left = inside(x + AL[d][0], y + AL[d][1]);
    const next = !right ? (d + 1) % 4 : left ? (d + 3) % 4 : d;
    if (next !== d) pts.push([x, y]);
    d = next;
    if (x === sx && y === sy && d === 0) break;
  }
  return pts;
}

// ---------------------------------------------------------------- polygon
// Distance of p from the line through a and b.
const offLine = (p, a, b) => Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9);
// Douglas-Peucker on a closed path: split at the corner farthest from the first, each half kept by the usual rule.
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length + 1);
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const at = (i) => pts[i % pts.length];
  keep[0] = keep[far] = keep[pts.length] = 1;
  const stack = [[0, far], [far, pts.length]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let k = -1, dm = eps;
    for (let m = i + 1; m < j; m++) {
      const d = offLine(at(m), at(i), at(j));
      if (d > dm) { dm = d; k = m; }
    }
    if (k >= 0) { keep[k] = 1; stack.push([i, k], [k, j]); }
  }
  // the first corner is kept by the split only: drop it, and any other, within eps of the line through its neighbours
  const out = pts.filter((_, i) => keep[i]);
  for (let i = 0; out.length > 3 && i < out.length;) {
    if (offLine(out[i], out[(i + out.length - 1) % out.length], out[(i + 1) % out.length]) < eps) out.splice(i, 1); else i++;
  }
  return out;
}

// Edges within 12 deg of the main direction (length-weighted, modulo 90 deg) or square to it are turned onto it through
// their midpoints; neighbouring edges of the same direction merge; the corners are the crossings of consecutive edges.
// Edges shorter than minLen (cut corners left by the pixel grid) drop out first.
function square(pts, minLen = 0) {
  const n = pts.length;
  let edges = pts.map((p, i) => { const q = pts[(i + 1) % n]; return { p, q, len: Math.hypot(q[0] - p[0], q[1] - p[1]), ang: Math.atan2(q[1] - p[1], q[0] - p[0]) }; });
  const long = edges.filter((e) => e.len >= minLen);
  if (long.length >= 3) edges = long;
  let sx = 0, sy = 0;
  for (const e of edges) { sx += e.len * Math.cos(4 * e.ang); sy += e.len * Math.sin(4 * e.ang); }
  const main = Math.atan2(sy, sx) / 4, tol = 12 * Math.PI / 180;
  const same = (a, b) => Math.abs(Math.sin(a - b)) < 1e-6 && Math.cos(a - b) > 0;
  const join = (a, b) => {   // b into a: the length-weighted line of the two
    const w = a.len + b.len;
    a.m = [(a.m[0] * a.len + b.m[0] * b.len) / w, (a.m[1] * a.len + b.m[1] * b.len) / w];
    a.len = w;
  };
  const lines = [];
  for (const e of edges) {
    let dir = e.ang;
    const k = Math.round((e.ang - main) / (Math.PI / 2));
    if (Math.abs(e.ang - main - k * Math.PI / 2) < tol) dir = main + k * Math.PI / 2;
    const line = { dir, m: [(e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2], len: e.len }, prev = lines[lines.length - 1];
    if (prev && same(prev.dir, dir)) join(prev, line); else lines.push(line);
  }
  if (lines.length > 2 && same(lines[0].dir, lines[lines.length - 1].dir)) join(lines[0], lines.pop());
  // Lines shorter than minLen (steps and notches of a few pixels) go, the shortest first; their neighbours then meet, or
  // merge when they run the same way.
  while (lines.length > 4) {
    let i = -1, shortest = minLen;
    lines.forEach((l, k) => { if (l.len < shortest) { shortest = l.len; i = k; } });
    if (i < 0) break;
    lines.splice(i, 1);
    const a = (i + lines.length - 1) % lines.length, b = i % lines.length;
    if (same(lines[a].dir, lines[b].dir)) { join(lines[a], lines[b]); lines.splice(b, 1); }
    else if (Math.cos(lines[a].dir - lines[b].dir) < -0.999) lines.splice(lines[a].len < lines[b].len ? a : b, 1);   // a spike
  }
  if (lines.length < 3) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[(i + lines.length - 1) % lines.length], b = lines[i];
    const da = [Math.cos(a.dir), Math.sin(a.dir)], db = [Math.cos(b.dir), Math.sin(b.dir)], den = da[0] * db[1] - da[1] * db[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((b.m[0] - a.m[0]) * db[1] - (b.m[1] - a.m[1]) * db[0]) / den;
    out.push([a.m[0] + t * da[0], a.m[1] + t * da[1]]);
  }
  return out;
}

// Smallest rectangle round a polygon: one side lies along an edge of its convex hull (monotone chain).
function minRect(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const h = []; for (const q of list) { while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); } h.pop(); return h; };
  const hull = half(p).concat(half(p.slice().reverse()));
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!L) continue;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const s = q[0] * u[0] + q[1] * u[1], t = q[0] * v[0] + q[1] * v[1];
      u0 = Math.min(u0, s); u1 = Math.max(u1, s); v0 = Math.min(v0, t); v1 = Math.max(v1, t);
    }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, pts: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([s, t]) => [s * u[0] + t * v[0], s * u[1] + t * v[1]]) };
  }
  return best;
}
// Polygon of a component: traced and simplified; its smallest rectangle when it fills at least 90 % of it, else squared when
// that keeps its area within 15 %.
function outline(lab, n, id, eps) {
  const raw = simplify(trace(lab, n, id), eps);
  if (raw.length < 3) return null;
  const rect = minRect(raw);
  if (rect && rect.A > 0 && polyArea(raw) / rect.A >= 0.9) return rect.pts;
  const sq = square(raw, 3 * eps);
  return sq && Math.abs(polyArea(sq) / polyArea(raw) - 1) < 0.15 ? sq : raw;
}

// ---------------------------------------------------------------- segmentation
// The roof holding pixel (sx, sy) of an n x n RGBA image at mpp metres per pixel, in pixel coordinates: { outline, holes };
// { edge: 'window' | 'image' } when it reaches that edge before it is stable; null when nothing stands out there.
// Transparent pixels lie outside the image: they never join, and the band within 3r + 1 pixels of them, where the smoothing
// and the colour change mix them in, counts as the image's edge.
function segment(rgba, n, sx, sy, mpp) {
  const r = Math.max(1, Math.round(0.5 / mpp)), seed = sy * n + sx;
  if (sx < 2 * r || sy < 2 * r || sx > n - 1 - 2 * r || sy > n - 1 - 2 * r) return null;
  const outside = new Uint8Array(n * n);
  for (let p = 0; p < outside.length; p++) outside[p] = rgba[4 * p + 3] ? 0 : 1;
  if (outside[seed]) return null;
  const band = outside.includes(1) ? morph(outside, n, 3 * r + 1, true) : outside;
  const level = joinLevels(lab(rgba, n, r), n, seed, r, outside);
  const pick = pickThreshold(level, n, MIN_ROOF_M2 / (mpp * mpp), band);
  if (!pick || pick.edge) return pick;
  let mask = new Uint8Array(n * n);
  for (let p = 0; p < mask.length; p++) mask[p] = level[p] <= pick.T ? 1 : 0;
  mask = morph(morph(mask, n, r, true), n, r, false);   // close gaps up to about half a metre
  // cut necks narrower than about 2 m through which the region spilled into its surroundings, unless that cuts off the click
  const cut = morph(morph(mask, n, 2 * r, false), n, 2 * r, true);
  if (cut[seed]) mask = cut;
  mask = refine(mask, rgba, n, r, outside);
  const roof = components(mask, n, 1), id = roof.lab[seed];
  if (!id || roof.sizes[id] * mpp * mpp < MIN_ROOF_M2) return null;
  const one = new Uint8Array(n * n);
  for (let p = 0; p < one.length; p++) one[p] = roof.lab[p] === id ? 1 : 0;
  // Openings: background components that do not reach the window's edge. Small or ragged ones close; the larger compact
  // ones (at least 40 % of their bounding box) are kept, up to MAX_HOLES.
  const bg = components(one, n, 0), open = new Set();
  for (let i = 0; i < n; i++) for (const p of [i, (n - 1) * n + i, i * n, i * n + n - 1]) open.add(bg.lab[p]);
  const box = bg.sizes.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  for (let p = 0; p < bg.lab.length; p++) {
    const h = bg.lab[p];
    if (!h) continue;
    const x = p % n, y = (p - x) / n, b = box[h];
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  const keep = [], fill = new Uint8Array(bg.sizes.length);
  for (let h = 1; h < bg.sizes.length; h++) {
    if (open.has(h)) continue;
    const b = box[h], compact = bg.sizes[h] / ((b[2] - b[0] + 1) * (b[3] - b[1] + 1));
    if (bg.sizes[h] * mpp * mpp >= MIN_HOLE_M2 && compact >= 0.4) keep.push(h); else fill[h] = 1;
  }
  keep.sort((a, b) => bg.sizes[b] - bg.sizes[a]).slice(MAX_HOLES).forEach((h) => (fill[h] = 1));
  for (let p = 0; p < one.length; p++) if (fill[bg.lab[p]]) one[p] = 1;
  const eps = Math.max(1, 0.8 / mpp);
  const holes = keep.slice(0, MAX_HOLES).map((h) => outline(bg.lab, n, h, eps)).filter(Boolean);
  const filled = components(one, n, 1), shape = outline(filled.lab, n, filled.lab[seed], eps);
  return shape ? { outline: shape, holes } : null;
}

// The roof at (lat, lon) in an image source (Ortho.source: maxZoom, and window(lat, lon, z, n) giving the pixels, the click's
// place in them, the metres per pixel and toLatLon): { outline: [[lat, lon], ...], holes: [[[lat, lon], ...], ...], zoom };
// { offEdge: true } when the roof runs off the image; null when no roof stands out from its surroundings there. Starts at the
// image's own resolution and steps out while the region reaches the window's edge.
function traceRoof(lat, lon, src) {
  for (let z = src.maxZoom; z >= Math.max(10, src.maxZoom - 7); z--) {
    const win = src.window(lat, lon, z, WINDOW);
    const s = segment(win.data, win.n, Math.round(win.sx), Math.round(win.sy), win.mpp);
    if (!s) return null;
    if (s.edge === 'window') continue;
    if (s.edge) return { offEdge: true };
    const toLatLon = (pts) => pts.map(([x, y]) => win.toLatLon(x, y).map((v) => +v.toFixed(7)));
    return { outline: toLatLon(s.outline), holes: s.holes.map(toLatLon), zoom: z };
  }
  return { offEdge: true };
}

export { traceRoof };
