// The 3D view of the Site & layout page as plain logic: the layout as faces in local metres (tables, buildings, trees, PV
// areas on their sloped ground), the sun at a chosen day and solar hour, the shadows on the ground, and a camera that turns
// it all into shaded polygons on a canvas, farthest first. No DOM, so ui/tests/layout.test.js runs it under Node.
import { localProjector } from './geometry.js';
import { orientationOf } from './items.js';
import { tableSize } from './fill.js';
import { sunAt } from '../sun.js';

const R = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centre2 = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

// Colours of the kinds of faces
export const SCENE_COLOURS = { ground: '#c9c3a6', area: '#d8c48a', table: '#2f4f86', building: '#a38c74', roof: '#8a7560', trunk: '#6b4e2e', crown: '#4f9a3c', shadow: '#8f8a72' };

// Height of the ground of a PV area at a plan point: 0 on level ground, falling by its slope towards its downhill azimuth
// (the way its tables face by default) from its centre
export function groundOf(P, site, pts) {
  const s = +site.slope || 0;
  if (!(s > 0) || P.pv.mount === 'tracker') return () => 0;
  const down = site.slope_azimuth != null ? +site.slope_azimuth : orientationOf(P, site).azimuth, c = centre2(pts), t = Math.tan(s * R);
  const d = [Math.sin(down * R), Math.cos(down * R)];
  return ([x, y]) => -t * ((x - c[0]) * d[0] + (y - c[1]) * d[1]);
}

// The faces of the layout: {pts: [[x, y, z], ...], kind}, in metres east, north and up of the centre of the drawn items.
// Tables tilt up from their lower edge at the project's table centre height (trackers lie flat at the axis height); a tree is
// a trunk and a crown of 8 sides from a third of its height up. Returns {faces, size} or null with nothing drawn.
export function sceneOf(P) {
  const items = (P.layout && P.layout.polygons) || [], R0 = (P.layout && P.layout.result) || {}, tables = R0.tables || [];
  const ll = items.flatMap((g) => (g.center ? [g.center] : g.latlngs || [])).concat(tables.flat());
  if (!ll.length) return null;
  const pr = localProjector(ll), faces = [], pv = P.pv, sites = items.filter((g) => g.type === 'site');
  const prism = (base, z0, z1, side, top) => {
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      faces.push({ pts: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], kind: side });
    }
    faces.push({ pts: base.map(([x, y]) => [x, y, z1]), kind: top });
  };
  const ground = sites.map((s) => { const m = s.latlngs.map(pr.fwd); return { m, z: groundOf(P, s, m), base: +s.base || 0 }; });
  ground.forEach((g) => faces.push({ pts: g.m.map((p) => [p[0], p[1], g.base + g.z(p)]), kind: 'area' }));
  for (const g of items) {
    if (g.type !== 'obstacle') continue;
    if (g.kind === 'tree') {
      const c = pr.fwd(g.center), h = +g.height || 8, r = (+g.diameter || 4) / 2, ring = (rr) => Array.from({ length: 8 }, (_, k) => [c[0] + rr * Math.sin(k * Math.PI / 4), c[1] + rr * Math.cos(k * Math.PI / 4)]);
      prism(ring(Math.max(0.15, r / 8)), 0, h / 3, 'trunk', 'trunk');
      prism(ring(r), h / 3, h, 'crown', 'crown');
    } else if (g.latlngs) prism(g.latlngs.map(pr.fwd), 0, +g.height || 6, 'building', 'roof');
  }
  const { slant } = tableSize(P), tracker = pv.mount === 'tracker', h0 = +pv.mount_height || 1.5, area = R0.table_area || [];
  tables.forEach((t, i) => {
    const c = t.map(pr.fwd), s = sites[area[i]], g = s ? ground[area[i]] : null, o = s ? orientationOf(P, s) : orientationOf(P, {});
    const z0 = (g ? g.base + g.z(centre2(c)) : 0) + h0, rise = tracker ? 0 : (slant / 2) * Math.sin((o.tilt || 0) * R);
    faces.push({ pts: [[...c[0], z0 + rise], [...c[1], z0 + rise], [...c[2], z0 - rise], [...c[3], z0 - rise]], kind: 'table' });
  });
  const all = faces.flatMap((f) => f.pts), span = Math.max(20, ...all.map((p) => Math.hypot(p[0], p[1])));
  return { faces, size: span };
}

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

// The polygons to draw, farthest first: the ground, the PV areas, the shadows, then the other faces, each {pts: [[x, y]], fill}
export function drawList(scene, sun, cam) {
  const tint = (hex, k) => '#' + [1, 3, 5].map((i) => Math.round(Math.min(255, parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('');
  const s = scene.size * 1.3, flat = (pts, fill) => ({ pts: pts.map((p) => cam.to2d(p)), fill });
  const out = [flat([[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0]], SCENE_COLOURS.ground)];
  const solid = scene.faces.filter((f) => f.kind !== 'area');
  for (const f of scene.faces) if (f.kind === 'area') out.push(flat(f.pts, SCENE_COLOURS.area));
  for (const f of solid) { const sh = shadowOf(f, sun); if (sh) out.push(flat(sh, SCENE_COLOURS.shadow)); }
  const faces = solid.map((f) => {
    const q = f.pts.map((p) => cam.to2d(p));
    return { pts: q, depth: q.reduce((a, p) => a + p[2], 0) / q.length, fill: tint(SCENE_COLOURS[f.kind], lightOf(f, sun, cam.eye)) };
  });
  faces.sort((a, b) => b.depth - a.depth);
  return out.concat(faces).map(({ pts, fill }) => ({ pts: pts.map((p) => [p[0], p[1]]), fill }));
}
