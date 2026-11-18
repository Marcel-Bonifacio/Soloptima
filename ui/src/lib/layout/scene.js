// The 3D view of the Site & layout page as plain logic: the layout as faces in local metres (tables, buildings, trees, PV
// areas on their sloped ground), the sun at a chosen day and solar hour, the shadows on the ground, and a camera that turns
// it all into shaded polygons on a canvas, farthest first. No DOM, so ui/tests/layout.test.js runs it under Node.
import { localProjector, area2, inPoly, centroid } from './geometry.js';
import { orientationOf } from './items.js';
import { tableSize } from './fill.js';
import { sunAt } from '../sun.js';
import { roofOf, roofPieces, edgeBreaks } from './solids.js';

const R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Colours of the kinds of faces
export const SCENE_COLOURS = { ground: '#c9c3a6', area: '#d8c48a', table: '#2f4f86', building: '#d3d1c7', roof: '#993c1d', trunk: '#6b4e2e', crown: '#4f9a3c', shadow: '#8f8a72',
  leaf: '#3b6d11', glass: '#0c447c', door: '#633806', steel: '#5f5e5a', car: '#b4b2a9',
  pv: '#1f5fbf', inv: '#e08a1e', bess: '#1a7330', gen: '#6d4c9f', substation: '#b3261e', load: '#555555', dc: '#d9822b', ac: '#2b6fd9', mv: '#b3261e' };
// The stations as boxes: [width, depth, height] in metres
const STATION_BOX = { pv: [6, 2.5, 2.8], inv: [1, 0.6, 1.1], bess: [12, 2.5, 2.9], gen: [12, 3, 3.5], substation: [10, 6, 4], load: [4, 4, 3] };

// Height of the ground of a PV area at a plan point: 0 on level ground, falling by its slope towards its downhill azimuth
// (the way its tables face by default) from its centre
export function groundOf(P, site, pts) {
  const s = +site.slope || 0;
  if (!(s > 0) || P.pv.mount === 'tracker') return () => 0;
  const down = site.slope_azimuth != null ? +site.slope_azimuth : orientationOf(P, site).azimuth, c = centroid(pts), t = Math.tan(s * R);
  const d = [Math.sin(down * R), Math.cos(down * R)];
  return ([x, y]) => -t * ((x - c[0]) * d[0] + (y - c[1]) * d[1]);
}

// The faces of the layout: {pts: [[x, y, z], ...], kind, it (the item's index in P.layout.polygons), i (a table's index), st (a
// station's index), col (an own colour), uv (module coordinates of a table's corners)}, in metres east, north and up of the
// centre of the drawn items. Tables tilt up from their lower edge at their area's table centre height (h0, else the project's;
// trackers lie flat at the axis height) over its ground; buildings have their roof (lib/layout/solids.js) and windows; a tree is
// its trunk and crown by shape, inside the crown the engine shades with; stations are boxes. Struts (structure of the tables,
// carports) and the cable routes of the inverter blocks `B` (equip/blocks.js; tables to their inverter or station, up to 4000
// tables, string inverters to their PV station, stations to the MV substation) are lines {a, b, kind}. Returns {faces, lines,
// struts, size, centres (of the tables), pr (the projector)} or null with nothing drawn. While an item is dragged the 3D view
// draws the rest (`skip`: its index) and the item alone (`only`, on the rest's projector `pr`) apart.
export function sceneOf(P, B = null, { skip = -1, only = -1, pr: pr0 = null } = {}) {
  const items = (P.layout && P.layout.polygons) || [], R0 = (P.layout && P.layout.result) || {}, tables = R0.tables || [];
  const ll = items.flatMap((g) => (g.center ? [g.center] : g.latlngs || [])).concat(tables.flat());
  if (!ll.length) return null;
  const pr = pr0 || localProjector(ll), faces = [], struts = [], pv = P.pv, siteIdx = [], drawn = (k) => k !== skip && (only < 0 || k === only);
  items.forEach((g, k) => { if (g.type === 'site') siteIdx.push(k); });
  const sites = siteIdx.map((k) => items[k]), detail = items.filter((g) => g.type === 'obstacle').length <= 400 && tables.length <= 6000;
  const face = (pts, kind, it, more) => faces.push({ pts, kind, it, ...more });
  const strut = (a, b) => struts.push({ a, b, kind: 'steel' });
  const prism = (base, z0, z1, side, top, it, more) => {
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      face([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], side, it, more);
    }
    if (top) face(base.map(([x, y]) => [x, y, z1]), top, it, more);
  };
  const ring = (c, r, n, z = 0, jit = 0, seed = 0) => Array.from({ length: n }, (_, k) => { const a = k * 2 * Math.PI / n, rr = r * (1 - jit * hash(seed, k)); return [c[0] + rr * Math.sin(a), c[1] + rr * Math.cos(a), z]; });
  const ground = sites.map((s) => { const m = s.latlngs.map(pr.fwd); return { m, z: groundOf(P, s, m), base: +s.base || 0 }; });
  ground.forEach((g, a) => { const s = sites[a]; if (drawn(siteIdx[a]) && !s.rooftop && !s.carport) face(g.m.map((p) => [p[0], p[1], g.base + g.z(p)]), 'area', siteIdx[a]); });
  items.forEach((g, it) => {
    if (g.type !== 'obstacle' || !drawn(it)) return;
    if (g.kind === 'tree') tree(g, pr.fwd(g.center), it);
    else if (g.latlngs) building(g, g.latlngs.map(pr.fwd), it);
  });
  function tree(g, c, it) {
    const H = +g.height || 8, D = +g.diameter || 4, Rc = D / 2, shape = g.shape || 'column', seed = Math.round(c[0] * 7 + c[1] * 13);
    if (shape === 'column') {
      prism(ring(c, Math.max(0.15, Rc / 8), 8), 0, H / 3, 'trunk', 'trunk', it);
      prism(ring(c, Rc, 8), H / 3, H, 'crown', 'crown', it);
      return;
    }
    const trunk = (top, r0) => prism(ring(c, r0, 7), 0, top, 'trunk', 'trunk', it);
    if (shape === 'round') {
      const rv = Math.min(Rc, H / 2);
      trunk(H - rv, 0.05 * H + 0.08);
      blob([c[0], c[1], H - rv], Rc * 0.97, rv * 0.97, '#3b6d11', seed, it);
      /** @type {[number, number, string][]} */ ([[0.45, 0, '#27500a'], [-0.25, 0.4, '#639922'], [-0.2, -0.4, '#3b6d11']]).forEach(([u, v, col], k) =>
        blob([c[0] + u * Rc, c[1] + v * Rc, H - 1.25 * rv], Rc * 0.5, rv * 0.5, col, seed + k + 1, it));
    } else if (shape === 'cone') {
      trunk(0.3 * H, 0.04 * H + 0.05);
      for (let k = 0; k < 3; k++) {
        const z0 = H * (0.16 + 0.22 * k), r = Rc * (H - z0) / (0.84 * H), apex = k === 2 ? H : z0 + 0.4 * H, rim = ring(c, r, 11, z0, 0.12, seed + k);
        rim.forEach((p, i) => face([p, rim[(i + 1) % rim.length], [c[0], c[1], apex]], 'leaf', it, { col: ['#27500a', '#3b6d11', '#173404'][k] }));
        face(rim.slice().reverse(), 'leaf', it, { col: '#173404' });
      }
    } else {
      trunk(H, 0.16);
      const T = [c[0], c[1], H];
      for (let k = 0; k < 10; k++) {
        const a = k * 2 * Math.PI / 10 + hash(seed, k), d = [Math.sin(a), Math.cos(a)], n = [-d[1], d[0]], r = Rc * (0.85 + 0.15 * hash(k, seed));
        const mid = [c[0] + d[0] * r / 2, c[1] + d[1] * r / 2, H - 0.25 * r], tip = [c[0] + d[0] * r, c[1] + d[1] * r, H - 0.5 * r], w = 0.22 * r, col = k % 2 ? '#3b6d11' : '#639922';
        face([T, [mid[0] + n[0] * w, mid[1] + n[1] * w, mid[2] - 0.15], tip], 'leaf', it, { col });
        face([T, tip, [mid[0] - n[0] * w, mid[1] - n[1] * w, mid[2] - 0.15]], 'leaf', it, { col });
      }
    }
  }
  function blob(c, rh, rv, col, seed, it) {
    const la = 5, lo = 9, v = [];
    for (let i = 0; i <= la; i++) v.push(Array.from({ length: lo }, (_, j) => { const th = i / la * Math.PI, ph = j / lo * 2 * Math.PI, k = 1 - 0.1 * hash(seed + i, j); return [c[0] + rh * k * Math.sin(th) * Math.cos(ph), c[1] + rh * k * Math.sin(th) * Math.sin(ph), c[2] + rv * Math.cos(th)]; }));
    for (let i = 0; i < la; i++) for (let j = 0; j < lo; j++) face([v[i][j], v[i][(j + 1) % lo], v[i + 1][(j + 1) % lo], v[i + 1][j]], 'leaf', it, { col });
  }
  function building(g, m, it) {
    if (m.length < 3) return;
    const roof = roofOf(g, m), ccw = area2(m) > 0;
    m.forEach((a, i) => {
      const b = m[(i + 1) % m.length], ts = [0, ...edgeBreaks(roof, a, b), 1], at = (t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      face([[a[0], a[1], 0], [b[0], b[1], 0], ...ts.slice().reverse().map((t) => { const p = at(t); return [p[0], p[1], roof.h(p)]; })], 'building', it);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), out = ccw ? [(b[1] - a[1]) / L, -(b[0] - a[0]) / L] : [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      if (!detail || L < 3) return;
      const floors = Math.max(1, Math.floor((roof.H - 0.4) / 3)), door = i === longest(m) ? 0.5 : -1;
      for (let f = 0; f < floors; f++) for (let x = 1.4; x + 1.2 <= L - 1.2; x += 3) {
        const t0 = x / L, t1 = (x + 1.2) / L, z = 1 + f * 3, p0 = at(t0), p1 = at(t1), o = 0.04;
        if (f === 0 && door >= 0 && Math.abs((t0 + t1) / 2 - door) * L < 1.6) continue;
        face([[p0[0] + out[0] * o, p0[1] + out[1] * o, z], [p1[0] + out[0] * o, p1[1] + out[1] * o, z], [p1[0] + out[0] * o, p1[1] + out[1] * o, z + 1.4], [p0[0] + out[0] * o, p0[1] + out[1] * o, z + 1.4]], 'glass', it);
      }
      if (door >= 0) { const p0 = at(0.5 - 0.6 / L), p1 = at(0.5 + 0.6 / L), o = 0.05; face([[p0[0] + out[0] * o, p0[1] + out[1] * o, 0], [p1[0] + out[0] * o, p1[1] + out[1] * o, 0], [p1[0] + out[0] * o, p1[1] + out[1] * o, 2.2], [p0[0] + out[0] * o, p0[1] + out[1] * o, 2.2]], 'door', it); }
    });
    for (const { poly } of roofPieces(roof, m)) face(poly.map((p) => [p[0], p[1], roof.h(p)]), 'roof', it, roof.kind === 'flat' ? { col: '#8a8780' } : undefined);
  }
  const { slant, along } = tableSize(P), tracker = pv.mount === 'tracker', h0 = +pv.mount_height || 1.5, area = R0.table_area || [];
  const nAlong = +P.layout.modules_per_table || 1, nUp = +P.layout.modules_across || 1, struts1 = tables.length <= 6000;
  // the table centres for the cable routes and the shade colours: of every table, none for an item drawn alone
  const centres = [], orient = sites.map((s) => orientationOf(P, s)), flat = orientationOf(P, {});
  tables.forEach((t, i) => {
    const a = area[i], s = sites[a], on = drawn(s ? siteIdx[a] : -1);
    if (!on && only >= 0) return;
    const c = t.map(pr.fwd), mid = centroid(c);
    if (only < 0) centres.push(mid);
    if (!on) return;
    const g = s ? ground[a] : null, o = s ? orient[a] : flat;
    const hh = s && s.h0 != null ? +s.h0 : h0, gz = (p) => (g ? g.base + g.z(p) : 0);
    const z0 = gz(mid) + hh, rise = tracker ? 0 : (slant / 2) * Math.sin((o.tilt || 0) * R);
    faces.push({ pts: [[...c[0], z0 + rise], [...c[1], z0 + rise], [...c[2], z0 - rise], [...c[3], z0 - rise]], kind: 'table', it: s ? siteIdx[a] : -1,
                 uv: [[0, nUp], [nAlong, nUp], [nAlong, 0], [0, 0]], i });
    if (s && (s.rooftop || s.carport)) return;
    // the structure: posts from the ground up to the frame under the modules, every 3.5 m (only the ends on large plants)
    const n = struts1 ? Math.max(1, Math.round(along / 3.5)) : 1, under = 0.08;
    const P3 = (u, v) => { const lo = [c[3][0] + u * (c[2][0] - c[3][0]), c[3][1] + u * (c[2][1] - c[3][1])], up = [c[0][0] + u * (c[1][0] - c[0][0]), c[0][1] + u * (c[1][1] - c[0][1])], p = [lo[0] + v * (up[0] - lo[0]), lo[1] + v * (up[1] - lo[1])]; return [p[0], p[1], z0 - rise + v * 2 * rise - under]; };
    for (let k = 0; k <= n; k++) {
      const u = 0.04 + 0.92 * k / n;
      if (tracker) { const q = P3(u, 0.5); strut([q[0], q[1], gz(q)], q); continue; }
      const f = P3(u, 0.15), r = P3(u, 0.85);
      strut([f[0], f[1], gz(f)], f); strut([r[0], r[1], gz(r)], r); strut(f, r);
    }
    for (const v of tracker ? [0.5] : struts1 ? [0.15, 0.85] : []) strut(P3(0, v), P3(1, v));
  });
  // carports: posts down the middle of the canopy and the beams under it; with detail, cars parked under
  sites.forEach((s, a) => {
    if (!s.carport || !drawn(siteIdx[a])) return;
    const it = siteIdx[a], m = ground[a].m, o = orient[a], az = o.azimuth * R, d = [Math.sin(az), Math.cos(az)], r = [Math.cos(az), -Math.sin(az)];
    const hh = s.h0 != null ? +s.h0 : h0, c = centroid(m), span = (v) => { const q = m.map((p) => (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]); return [Math.min(...q), Math.max(...q)]; };
    const [u0, u1] = span(r), [w0, w1] = span(d), top = (w) => ground[a].base + hh - w * Math.tan((o.tilt || 0) * R), n = Math.max(1, Math.round((u1 - u0) / 5));
    for (let k = 0; k <= n; k++) {
      const u = u0 + 0.3 + (u1 - u0 - 0.6) * k / n, p = [c[0] + u * r[0], c[1] + u * r[1]], z = top(0) - 0.15;
      prism(ring(p, 0.13, 6), 0, z, 'steel', null, it);
      const e0 = [p[0] + w0 * d[0], p[1] + w0 * d[1], top(w0) - 0.12], e1 = [p[0] + w1 * d[0], p[1] + w1 * d[1], top(w1) - 0.12];
      strut(e0, e1);
    }
    strut([c[0] + u0 * r[0], c[1] + u0 * r[1], top(0) - 0.15], [c[0] + u1 * r[0], c[1] + u1 * r[1], top(0) - 0.15]);
    if (!detail) return;
    const COL = ['#b4b2a9', '#a32d2d', '#185fa5', '#f1efe8'];
    for (let k = 0, u = u0 + 1.5; u + 1 < u1; u += 2.5, k++) {
      if (hash(k, a) < 0.35) continue;
      for (const side of [-1, 1]) {
        const w = side * (w1 - w0) / 4, ctr = [c[0] + u * r[0] + w * d[0], c[1] + u * r[1] + w * d[1]];
        const box = (hl, hw, z0, z1, kind, col) => prism([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([x, y]) => [ctr[0] + x * r[0] + y * d[0], ctr[1] + x * r[1] + y * d[1]]), z0, z1, kind, kind, it, col ? { col } : undefined);
        box(0.9, 2.2, 0.25, 1.0, 'car', COL[(k + side + 2) % 4]); box(0.8, 1.1, 1.0, 1.5, 'car', '#2c2c2a');
      }
    }
  });
  const st = only < 0 && P.layout && P.layout.stations || [], sxy = st.map((s) => pr.fwd(s.latlng));
  // boxes at least a 150th of the scene, so a 1 m inverter still shows on a plant of hundreds of metres
  const reach = faces.reduce((m, f) => f.pts.reduce((a, p) => Math.max(a, Math.hypot(p[0], p[1])), m), 20), k = Math.max(1, reach / 150 / 1.2), nBefore = faces.length;
  st.forEach((s, j) => {
    const [w, d, h] = (STATION_BOX[s.kind] || [3, 3, 3]).map((v) => (s.kind === 'inv' ? v * k : v)), [x, y] = sxy[j], n = faces.length;
    prism([[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]], 0, h, s.kind, s.kind, -1);
    for (let k = n; k < faces.length; k++) faces[k].st = j;
  });
  const lines = [], z = 0.05, line = (a, b, kind) => lines.push({ a: [a[0], a[1], z], b: [b[0], b[1], z], kind });
  if (B && only < 0) {
    const node = B.nodes.map((s) => sxy[st.indexOf(s)] || pr.fwd(s.latlng));
    if (tables.length <= 4000) centres.forEach((c, i) => { const j = B.tableNode[i]; if (j >= 0) line(c, node[j], 'dc'); });
    const pvs = st.map((s, j) => [s, j]).filter(([s]) => s.kind === 'pv');
    B.blocks.forEach((b, j) => { if (b.station >= 0 && pvs[b.station]) line(node[j], sxy[pvs[b.station][1]], 'ac'); });
  }
  const sub = sxy[st.findIndex((s) => s.kind === 'substation')];
  if (sub) st.forEach((s, j) => { if (s.kind !== 'substation' && s.kind !== 'inv') line(sxy[j], sub, 'mv'); });
  const span = faces.slice(nBefore).reduce((m, f) => f.pts.reduce((a, p) => Math.max(a, Math.hypot(p[0], p[1])), m), reach);
  return { faces, lines, struts, size: span, centres, pr };
}
const hash = (a, b) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };
const longest = (m) => m.reduce((b, p, i) => { const q = m[(i + 1) % m.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]); return l > b[0] ? [l, i] : b; }, [-1, 0])[1];

// The sun on the 21st of a month (0-11) at a solar hour: {el, az, dir} with dir the unit vector towards it
export function sunOf(lat, month, hour) {
  const day = [20, 51, 79, 110, 140, 171, 201, 232, 263, 293, 324, 354][month] + 1;
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365);
  const s = sunAt(lat, decl, 15 * (hour - 12));
  return { ...s, dir: [Math.cos(s.el * R) * Math.sin(s.az * R), Math.cos(s.el * R) * Math.cos(s.az * R), Math.sin(s.el * R)] };
}

// The shadow of a face on level ground (z = 0) with the sun above the horizon, or null
export function shadowOf(face, sun) {
  if (!(sun.el > 0.5)) return null;
  const k = 1 / Math.tan(sun.el * R), ux = sun.dir[0] / Math.cos(sun.el * R), uy = sun.dir[1] / Math.cos(sun.el * R);
  return face.pts.map(([x, y, z]) => [x - Math.max(0, z) * k * ux, y - Math.max(0, z) * k * uy, 0]);
}

// A camera turned to azimuth `az` (deg, the way it looks from), `el` above the horizon, at `dist` from the target, with a
// perspective of the canvas w x h: to2d gives [x, y, depth] on the canvas
export function cameraOf(az, el, dist, w, h, target = [0, 0, 0]) {
  const eye = [target[0] + dist * Math.cos(el * R) * Math.sin(az * R), target[1] + dist * Math.cos(el * R) * Math.cos(az * R), target[2] + dist * Math.sin(el * R)];
  const fwd = unit(sub(target, eye)), right = unit(cross(fwd, [0, 0, 1])), up = cross(right, fwd), f = 0.9 * Math.min(w, h);
  return {
    eye,
    to2d(p) {
      const d = sub(p, eye), z = Math.max(0.1, dot(d, fwd));
      return [w / 2 + (f * dot(d, right)) / z, h / 2 - (f * dot(d, up)) / z, z];
    },
  };
}

// Shading of a face by the sun: 0.55 to 1 of its colour by the cosine of incidence on whichever side faces the camera
export function lightOf(face, sun, eye) {
  const p = face.pts;
  if (p.length < 3) return 1;
  let n = unit(cross(sub(p[1], p[0]), sub(p[2], p[0])));
  if (dot(n, sub(eye, p[0])) < 0) n = n.map((x) => -x);
  return sun.el > 0 ? 0.55 + 0.45 * Math.max(0, dot(n, sun.dir)) : 0.5;
}

// The polygons to draw, farthest first: the ground, the PV areas, the shadows, the cable routes, then the other faces, each
// {pts: [[x, y]], fill, line (a cable: stroke it), face (the scene face, for picking)}. `colourOf(face)` may give a table its own
// colour (its inverter block or its shade).
export function drawList(scene, sun, cam, colourOf = null) {
  const tint = (hex, k) => '#' + [1, 3, 5].map((i) => Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('');
  const s = scene.size * 1.3, flat = (pts, fill) => ({ pts: pts.map((p) => cam.to2d(p)), fill });
  const out = [flat([[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0]], SCENE_COLOURS.ground)];
  const solid = scene.faces.filter((f) => f.kind !== 'area');
  for (const f of scene.faces) if (f.kind === 'area') out.push(flat(f.pts, SCENE_COLOURS.area));
  for (const f of solid) { const sh = shadowOf(f, sun); if (sh) out.push(flat(sh, SCENE_COLOURS.shadow)); }
  for (const l of scene.lines || []) out.push({ ...flat([l.a, l.b], SCENE_COLOURS[l.kind]), line: l.kind });
  const faces = solid.map((f) => {
    const q = f.pts.map((p) => cam.to2d(p)), own = colourOf && f.kind === 'table' ? colourOf(f) : null;
    return { pts: q, depth: q.reduce((a, p) => a + p[2], 0) / q.length, fill: tint(own || f.col || SCENE_COLOURS[f.kind], lightOf(f, sun, cam.eye)), face: f };
  });
  faces.sort((a, b) => b.depth - a.depth);
  return out.concat(faces).map(({ pts, fill, line, face }) => ({ pts: pts.map((p) => [p[0], p[1]]), fill, line, face }));
}

// Triangles of a simple polygon by its plan ([x, y, ...] corners, either way round): index triples, ears cut in turn; what no
// ear can be cut from (a polygon that crosses itself) closes as a fan. shortcut: O(n²), about 0.1 s at 5000 corners.
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  const ccw = area2(pts) >= 0, idx = Array.from({ length: n }, (_, i) => (ccw ? i : n - 1 - i)), out = [];
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0;
  for (let k = 0, miss = 0; idx.length > 3 && miss < idx.length; ) {
    const m = idx.length, i0 = idx[(k + m - 1) % m], i1 = idx[k % m], i2 = idx[(k + 1) % m], [a, b, c] = [pts[i0], pts[i1], pts[i2]];
    if (cr(a, b, c) > 0 && !idx.some((q) => q !== i0 && q !== i1 && q !== i2 && inside(pts[q], a, b, c))) {
      out.push([i0, i1, i2]);
      idx.splice(k % m, 1);
      miss = 0;
    } else { k = (k % m) + 1; miss++; }
  }
  for (let k = 1; k + 1 < idx.length; k++) out.push([idx[0], idx[k], idx[k + 1]]);
  return out;
}

// The scene as the GPU renderer takes it (src-tauri/src/view3d.rs): a u32 count of triangle corners and the f32 radius of a
// sphere holding it all (for the sun's shadow map), then corners of 24 bytes: x, y, z, u, v as f32 (u, v: module coordinates
// on a table) and r, g, b and how the sun lights it (MESH_FLAG), the triangles first, then the ends of the lines (cable routes,
// then the struts of the tables and carports). A ground square lies under it all.
export const MESH_FLAG = { solid: 255, panel: 200, glass: 150, leaf: 100, line: 0 };
export function meshOf(scene, colourOf = null, cables = true, struts = true, ground = true) {
  const s = scene.size * 1.3;
  let z0 = 0, top = 0;
  for (const f of scene.faces) for (const p of f.pts) { z0 = Math.min(z0, p[2]); top = Math.max(top, p[2]); }
  z0 -= 0.05;
  const cache = new Map(), rgb = (hex) => { let c = cache.get(hex); if (!c) cache.set(hex, (c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)))); return c; };
  const tri = [], line = [];
  const poly = (pts, col, flag, uv) => {
    let t;
    if (pts.length <= 4) t = pts.slice(2).map((_, k) => [0, k + 1, k + 2]);   // tables, walls and boxes are convex
    else {   // in the plane the polygon lies in most: a gable wall is upright
      const n = [0, 0, 0];
      pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]); });
      const drop = [0, 1, 2].reduce((b, k) => (Math.abs(n[k]) > Math.abs(n[b]) ? k : b), 2), [i0, i1] = [0, 1, 2].filter((k) => k !== drop);
      t = triangulate(pts.map((p) => [p[i0], p[i1]]));
    }
    for (const ix of t) for (const i of ix) tri.push([pts[i], uv ? uv[i] : null, col, flag]);
  };
  const FLAG = { table: MESH_FLAG.panel, glass: MESH_FLAG.glass, leaf: MESH_FLAG.leaf, crown: MESH_FLAG.leaf };
  if (ground) poly([[-s, -s, z0], [s, -s, z0], [s, s, z0], [-s, s, z0]], rgb(SCENE_COLOURS.ground), MESH_FLAG.solid);
  for (const f of scene.faces) poly(f.pts, rgb((colourOf && f.kind === 'table' && colourOf(f)) || f.col || SCENE_COLOURS[f.kind] || '#888888'), FLAG[f.kind] || MESH_FLAG.solid, f.uv);
  const lines = (cables ? scene.lines || [] : []).concat(struts ? scene.struts || [] : []);
  for (const l of lines) for (const p of [l.a, l.b]) line.push([p, null, rgb(SCENE_COLOURS[l.kind]), MESH_FLAG.line]);
  const buf = new ArrayBuffer(8 + (tri.length + line.length) * 24), f32 = new Float32Array(buf), u8 = new Uint8Array(buf);
  new Uint32Array(buf, 0, 1)[0] = tri.length;
  f32[1] = Math.hypot(s, s, top - z0) + 1;
  let k = 0;
  for (const list of [tri, line]) for (const [p, uv, c, flag] of list) {
    const o = 2 + 6 * k, b = 8 + 24 * k + 20;
    f32[o] = p[0]; f32[o + 1] = p[1]; f32[o + 2] = p[2];
    if (uv) { f32[o + 3] = uv[0]; f32[o + 4] = uv[1]; }
    u8[b] = c[0]; u8[b + 1] = c[1]; u8[b + 2] = c[2]; u8[b + 3] = flag;
    k++;
  }
  return u8;
}

// The face nearest the camera under canvas point [x, y]: its projected outline holds the point; null when none does
export function pickFace(scene, cam, x, y) {
  let best = null, bd = Infinity;
  for (const f of scene.faces) {
    const q = f.pts.map((p) => cam.to2d(p));
    if (!inPoly([x, y], q)) continue;
    const d = depthAt(q, x, y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
// Depth of a projected polygon at a canvas point: from the plane through its first three corners (their mean when degenerate)
function depthAt(q, x, y) {
  const [a, b, c] = q, det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(det) < 1e-9) return q.reduce((s, p) => s + p[2], 0) / q.length;
  const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / det, v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
  return a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]);
}
