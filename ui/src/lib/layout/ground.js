// The satellite image under the 3D view. A square of Esri World Imagery round the scene in degrees, its corners in the scene's
// metres, and the body the shell takes (screens/layout/Layout3D.svelte; src-tauri/src/view3d.rs, view3d_ground). The square
// snaps to a grid, so a small edit keeps the same image and nothing is fetched again. No DOM but in fetchGround and
// drawGround, so ui/tests/layout.test.js runs the rest under Node.
import { esriExport } from '../report/layout-geom.js';

const KY = 110574, KX = 111320;
export const GROUND_MAX_PX = 2048;   // MAX_GROUND in view3d.rs
export const GROUND_CREDIT = 'Imagery © Esri, Maxar, Earthstar Geographics';
const HALF = [100, 200, 400, 800, 1600, 3200];   // half sides of the square, m
const w180 = (lo) => ((((lo + 180) % 360) + 360) % 360) - 180;

// The square of imagery under a scene (sceneOf): {la0, la1, lo0, lo1 (degrees, longitudes in [-180, 180]), wrap (degrees to add
// to them to reach the scene's longitudes), w, h (pixels), key}, or null (no scene, near a pole, across ±180°). It holds the
// ground the view draws (scene.size * 1.3 each way from the centre) with a margin, at most 6.4 km a side; its centre steps by
// a quarter of its half side. Pixels are about 0.3 m, at most 2048 along a side, square in degrees as the export answers them.
export function groundBox(scene) {
  if (!scene || !scene.pr || !(scene.size > 0)) return null;
  const need = scene.size * 1.3 * 1.1 + 20, half = HALF.find((x) => 0.75 * x >= need) || HALF[HALF.length - 1], step = half / 4;
  const [lat, lon] = scene.pr.inv([0, 0]);
  if (!(Math.abs(lat) < 80) || !Number.isFinite(lon)) return null;
  const la = Math.round(lat * KY / step) * step / KY, kx = KX * Math.cos(la * Math.PI / 180), lo = Math.round(lon * kx / step) * step / kx;
  const dla = half / KY, dlo = half / kx, lw = w180(lo);
  if (lw - dlo < -180 || lw + dlo > 180) return null;
  const long = Math.min(GROUND_MAX_PX, Math.max(256, Math.round(2 * half / 0.3))), r = dla / dlo;
  const w = r <= 1 ? long : Math.max(64, Math.round(long / r)), h = r <= 1 ? Math.max(64, Math.round(long * r)) : long;
  const f = (x) => +x.toFixed(7);
  const box = { la0: f(la - dla), la1: f(la + dla), lo0: f(lw - dlo), lo1: f(lw + dlo), wrap: Math.round((lo - lw) / 360) * 360, w, h, key: '' };
  box.key = `${box.lo0},${box.la0},${box.lo1},${box.la1},${w}x${h}`;
  return box;
}

// The image's corners in the scene's metres at height z: south-west, south-east, north-east, north-west (the image's bottom
// left, bottom right, top right, top left). Just under the plain ground's top, so the areas and faces at 0 draw over it.
export function groundCorners(box, pr, z = -0.02) {
  return [[box.la0, box.lo0], [box.la0, box.lo1], [box.la1, box.lo1], [box.la1, box.lo0]].map(([a, o]) => [...pr.fwd([a, o + box.wrap]), z]);
}

// The body of view3d_ground: u32 width and height, the four corners as x, y, z f32, then the RGBA pixels. Without an image,
// width and height are 0: the shell moves the quad and keeps the image it has.
export function groundBody(corners, img = null) {
  const n = img ? img.w * img.h * 4 : 0, buf = new ArrayBuffer(56 + n), dv = new DataView(buf);
  dv.setUint32(0, img ? img.w : 0, true);
  dv.setUint32(4, img ? img.h : 0, true);
  corners.flat().forEach((x, i) => dv.setFloat32(8 + 4 * i, x, true));
  const u8 = new Uint8Array(buf);
  if (img) u8.set(img.rgba, 56);
  return u8;
}

// The image of a box, decoded here to RGBA so the shell needs no image decoder: {w, h, rgba, bitmap (for the canvas
// fallback)}, or null. Kept for the session, the last three boxes; a failed fetch (offline) is not kept, so a later look
// tries again.
const cache = new Map();
export function fetchGround(box) {
  let p = cache.get(box.key);
  if (!p) {
    p = loadGround(box).then((img) => { if (!img) cache.delete(box.key); return img || null; });
    cache.set(box.key, p);
    while (cache.size > 3) cache.delete(cache.keys().next().value);
  }
  return p;
}
async function loadGround(box) {
  const got = await esriExport(box.lo0, box.la0, box.lo1, box.la1, box.w, box.h);
  if (!got || got.buf.byteLength > 16e6) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([got.buf], { type: got.type }));
    const w = Math.min(bitmap.width, GROUND_MAX_PX), h = Math.min(bitmap.height, GROUND_MAX_PX);
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { w, h, rgba: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), bitmap };
  } catch (e) { return null; }
}

// The 2D transform [a, b, c, d, e, f] (as ctx.transform takes it) that takes image points t0, t1, t2 to canvas points s0, s1,
// s2; null when the image points lie on a line
export function affineOf(t0, t1, t2, s0, s1, s2) {
  const [u0, v0] = t0, du1 = t1[0] - u0, dv1 = t1[1] - v0, du2 = t2[0] - u0, dv2 = t2[1] - v0, det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return null;
  const by = (k) => { const d1 = s1[k] - s0[k], d2 = s2[k] - s0[k]; return [(d1 * dv2 - d2 * dv1) / det, (d2 * du1 - d1 * du2) / det]; };
  const [a, c] = by(0), [b, d] = by(1);
  return [a, b, c, d, s0[0] - a * u0 - c * v0, s0[1] - b * u0 - d * v0];
}

// The image on the fallback canvas under the camera cam (cameraOf): an n x n grid of cells, each two triangles drawn with the
// affine transform from the image onto the projected triangle. A fallback only: inside each cell the perspective is not
// exact, and cells reaching behind the camera are left out.
export function drawGround(ctx, img, corners, cam, n = 6) {
  const W = img.width, H = img.height, [sw, se, ne, nw] = corners;
  const at = (u, v) => [0, 1, 2].map((i) => (1 - v) * (sw[i] + (se[i] - sw[i]) * u) + v * (nw[i] + (ne[i] - nw[i]) * u));
  const grid = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => ({ s: cam.to2d(at(i / n, j / n)), t: [i / n * W, (1 - j / n) * H] })));
  const tri = (p, q, r) => {
    if ([p, q, r].some((x) => x.s[2] <= 0.1001)) return;
    const m = affineOf(p.t, q.t, r.t, p.s, q.s, r.s);
    if (!m) return;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(p.s[0], p.s[1]); ctx.lineTo(q.s[0], q.s[1]); ctx.lineTo(r.s[0], r.s[1]); ctx.closePath();
    ctx.clip();
    ctx.transform(...m);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    tri(a, b, c); tri(a, c, d);
  }
}
