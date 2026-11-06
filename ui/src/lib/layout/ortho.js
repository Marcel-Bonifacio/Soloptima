// Own imagery on the layout map: a drone or survey orthophoto (PNG, JPEG or WebP) placed by its world file, with coordinates in
// UTM (WGS 84), Web Mercator or longitude and latitude, shown under the drawn items and used by roof tracing. The image is
// resampled onto the map's Web Mercator pixel grid at the zoom level nearest its own ground resolution (at most 4096 pixels a
// side), so it lines up with the map and the tracer reads it like map tiles. It stays in this session; projects do not store it.

const MAX_SIDE = 4096, MAX_FILE = 200 << 20, MAX_PIXELS = 250e6;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const MAP = L.CRS.EPSG3857, MERC = L.Projection.SphericalMercator;

// ---------------------------------------------------------------- coordinates
// WGS 84 transverse Mercator by the Krueger series to the fourth order in n (Karney 2011, J. Geodesy 85, 475-485).
const n = (1 / 298.257223563) / (2 - 1 / 298.257223563), n2 = n * n, n3 = n2 * n, n4 = n3 * n, K0 = 0.9996;
const AK = 6378137 / (1 + n) * (1 + n2 / 4 + n4 / 64);
const ALPHA = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440, 61 * n3 / 240 - 103 * n4 / 140, 49561 * n4 / 161280];
const BETA = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360, n2 / 48 + n3 / 15 - 437 * n4 / 1440, 17 * n3 / 480 - 37 * n4 / 840, 4397 * n4 / 161280];
const DELTA = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45, 56 * n3 / 15 - 136 * n4 / 35, 4279 * n4 / 630];
const meridian = (zone) => (zone * 6 - 183) * D2R;
function utmFromLatLon(lat, lon, zone, south) {
  const phi = lat * D2R, dl = lon * D2R - meridian(zone), e = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 4; j++) {
    x += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + K0 * AK * x, (south ? 1e7 : 0) + K0 * AK * y];
}
function latLonFromUtm(east, north, zone, south) {
  const xi = (north - (south ? 1e7 : 0)) / (K0 * AK), eta = (east - 500000) / (K0 * AK);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 4; j++) {
    xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  return [phi * R2D, (meridian(zone) + Math.atan2(Math.sinh(ep), Math.cos(xp))) * R2D];
}
// A coordinate system of a world file: kind 'utm' (zone, south), 'mercator' (Web Mercator metres) or 'degrees'.
function frame(crs) {
  if (crs.kind === 'utm') return { toLL: (x, y) => latLonFromUtm(x, y, crs.zone, crs.south), fromLL: (la, lo) => utmFromLatLon(la, lo, crs.zone, crs.south) };
  if (crs.kind === 'mercator')
    return { toLL: (x, y) => { const q = MERC.unproject(L.point(x, y)); return [q.lat, q.lng]; },
             fromLL: (la, lo) => { const p = MERC.project(L.latLng(la, lo)); return [p.x, p.y]; } };
  return { toLL: (x, y) => [y, x], fromLL: (la, lo) => [lo, la] };
}
const crsLabel = (crs) => (crs.kind === 'utm' ? `UTM ${crs.zone} ${crs.south ? 'S' : 'N'}` : crs.kind === 'mercator' ? 'Web Mercator' : 'longitude and latitude');
// Every system a world file without a .prj may be in; at most one of them places an image within 50 km of a site.
const SYSTEMS = [{ kind: 'mercator' }, { kind: 'degrees' }].concat(Array.from({ length: 120 }, (_, i) => ({ kind: 'utm', zone: i % 60 + 1, south: i >= 60 })));

// Coordinate system named by a .prj file (WKT): WGS 84 UTM, Web Mercator or geographic; { unknown: name } for any other.
function fromPrj(text) {
  const t = String(text).slice(0, 20000);
  let m = /UTM[ _]zone[ _]?(\d{1,2})\s*([NS])/i.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 60) return { kind: 'utm', zone: +m[1], south: m[2].toUpperCase() === 'S' };
  if ((m = /\b32([67])(\d{2})\b/.exec(t)) && +m[2] >= 1 && +m[2] <= 60) return { kind: 'utm', zone: +m[2], south: m[1] === '7' };
  if (/Pseudo[-_ ]Mercator|Web[-_ ]Mercator|Popular[ _]Visualisation|\b(3857|900913|3785)\b/i.test(t)) return { kind: 'mercator' };
  if (/^\s*GEOGCR?S/i.test(t)) return { kind: 'degrees' };
  return { unknown: (/"([^"]{1,80})"/.exec(t) || [, 'a coordinate system'])[1] };
}
// World file: six numbers A D B E C F; a pixel's centre (col, row) lies at x = A col + B row + C, y = D col + E row + F.
function parseWorld(text) {
  const v = String(text).trim().split(/\s+/).slice(0, 6).map(Number);
  if (v.length !== 6 || !v.every(Number.isFinite)) return null;
  const [A, D, B, E, C, F] = v, det = A * E - B * D;
  return det ? { A, B, C, D, E, F, det } : null;
}
// Width and height of an image file from its header, before its pixels are decoded.
function imageSize(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); res([img.naturalWidth, img.naturalHeight]); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`${file.name} could not be read as an image`)); };
    img.src = url;
  });
}

// ---------------------------------------------------------------- loading
// Image and world file (and .prj) from the files chosen together. The coordinate system is the .prj's, or else the one that
// places the image within 50 km of the site. Resolves to { canvas, bounds: [[s, w], [n, e]], z, x0, y0, mpp, crs, name }.
async function load(files, site) {
  const list = Array.from(files), byExt = (re) => list.find((f) => re.test(f.name));
  const imgFile = byExt(/\.(png|jpe?g|webp)$/i), worldFile = byExt(/\.(pgw|pngw|jgw|jpgw|jpegw|wld|tfw|wpw)$/i), prjFile = byExt(/\.prj$/i);
  if (!imgFile) throw new Error('choose a PNG, JPEG or WebP image together with its world file (.pgw, .jgw, .wld)');
  if (!worldFile) throw new Error(`${imgFile.name}: the world file is missing (choose it together with the image)`);
  if (imgFile.size > MAX_FILE) throw new Error(`${imgFile.name} is over 200 MB`);
  const W = parseWorld(await worldFile.slice(0, 4096).text());
  if (!W) throw new Error(`${worldFile.name} is not a world file (six numbers)`);
  const [w, h] = await imageSize(imgFile);
  if (!(w > 0 && h > 0)) throw new Error(`${imgFile.name} has no pixels`);
  if (w * h > MAX_PIXELS) throw new Error(`${imgFile.name} has over 250 million pixels: export it at a coarser resolution`);
  const pixelToXY = (c, r) => [W.A * c + W.B * r + W.C, W.D * c + W.E * r + W.F];
  const atSite = L.latLng(+site.lat, +site.lon);
  const centreOf = (crs) => {
    const ll = frame(crs).toLL(...pixelToXY((w - 1) / 2, (h - 1) / 2));
    return Number.isFinite(ll[0]) && Number.isFinite(ll[1]) && Math.abs(ll[0]) <= 90 ? L.latLng(ll[0], ll[1]) : null;
  };
  const near = (crs) => { const c = centreOf(crs); return !!c && c.distanceTo(atSite) < 50000; };
  let crs;
  if (prjFile) {
    crs = fromPrj(await prjFile.slice(0, 20000).text());
    if (crs.unknown) throw new Error(`${prjFile.name} names ${crs.unknown}, which this program does not read: export the image in UTM (WGS 84), Web Mercator or longitude and latitude`);
    if (!near(crs)) throw new Error(`in ${crsLabel(crs)}, as ${prjFile.name} says, the image lies more than 50 km from the site`);
  } else {
    crs = SYSTEMS.find(near);
    if (!crs) throw new Error('the world file places the image more than 50 km from the site in any UTM zone, in Web Mercator and in longitude and latitude: check the site location');
  }
  const fr = frame(crs);

  // Source pixels, scaled down to at most MAX_SIDE x MAX_SIDE pixels in area while decoding where the browser can; the bitmap
  // and the scaling canvas go as soon as the pixels are read
  const k = Math.min(1, Math.sqrt(MAX_SIDE * MAX_SIDE / (w * h))), sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  const bmp = await createImageBitmap(imgFile, { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' });
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0, sw, sh);
  bmp.close();
  const sData = sctx.getImageData(0, 0, sw, sh).data;
  sc.width = sc.height = 0;

  // Target zoom: map pixels no larger than the image's own ground pixels, at most MAX_SIDE pixels a side
  const corners = [[-0.5, -0.5], [w - 0.5, -0.5], [w - 0.5, h - 0.5], [-0.5, h - 0.5]].map(([c, r]) => fr.toLL(...pixelToXY(c, r)));
  if (!corners.every(([la, lo]) => Math.abs(la) <= 85 && Number.isFinite(lo))) throw new Error(`${worldFile.name} places the image's corners off the map`);
  const cll = corners.map(([la, lo]) => L.latLng(la, lo));
  const ground = Math.sqrt(cll[0].distanceTo(cll[1]) * cll[1].distanceTo(cll[2]) / (w * h)) / k;   // m per source pixel
  if (!(ground * k >= 0.001 && ground * k <= 30)) throw new Error(`${worldFile.name} gives ${(ground * k).toPrecision(2)} m per pixel: an orthophoto between 1 mm and 30 m per pixel is expected`);
  const cosLat = Math.cos(centreOf(crs).lat * D2R);
  let z = Math.max(12, Math.min(23, Math.ceil(Math.log2(156543.03392 * cosLat / ground)))), box;
  for (;; z--) {
    const b = L.bounds(cll.map((ll) => MAP.latLngToPoint(ll, z)));
    box = [Math.floor(b.min.x), Math.floor(b.min.y), Math.ceil(b.max.x), Math.ceil(b.max.y)];
    if ((box[2] - box[0] <= MAX_SIDE && box[3] - box[1] <= MAX_SIDE) || z <= 12) break;
  }
  const tw = Math.min(MAX_SIDE, box[2] - box[0]), th = Math.min(MAX_SIDE, box[3] - box[1]);

  // Resample: the exact source pixel at every 16th target pixel, linear in between, nearest source pixel
  const G = 16, gw = Math.ceil(tw / G) + 1, gh = Math.ceil(th / G) + 1, gc = new Float64Array(gw * gh), gr = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const ll = MAP.pointToLatLng(L.point(box[0] + Math.min(i * G, tw) + 0.5, box[1] + Math.min(j * G, th) + 0.5), z);
      const [x, y] = fr.fromLL(ll.lat, ll.lng), dx = x - W.C, dy = y - W.F;
      gc[j * gw + i] = ((W.E * dx - W.B * dy) / W.det + 0.5) * k - 0.5;
      gr[j * gw + i] = ((W.A * dy - W.D * dx) / W.det + 0.5) * k - 0.5;
    }
  const out = new ImageData(tw, th), o = out.data, rowC = new Float64Array(gw), rowR = new Float64Array(gw);
  for (let y = 0; y < th; y++) {
    const j = Math.min(gh - 2, Math.floor(y / G)), v = (y - j * G) / Math.max(1, Math.min(G, th - j * G));
    for (let i = 0; i < gw; i++) {   // the grid blended down to this row
      const a = j * gw + i;
      rowC[i] = gc[a] + v * (gc[a + gw] - gc[a]);
      rowR[i] = gr[a] + v * (gr[a + gw] - gr[a]);
    }
    for (let x = 0; x < tw; x++) {
      const i = Math.min(gw - 2, Math.floor(x / G)), u = (x - i * G) / Math.max(1, Math.min(G, tw - i * G));
      const c = Math.round(rowC[i] + u * (rowC[i + 1] - rowC[i])), r = Math.round(rowR[i] + u * (rowR[i + 1] - rowR[i]));
      if (!(c >= 0 && r >= 0 && c < sw && r < sh)) continue;
      const s = 4 * (r * sw + c), t = 4 * (y * tw + x);
      o[t] = sData[s]; o[t + 1] = sData[s + 1]; o[t + 2] = sData[s + 2]; o[t + 3] = sData[s + 3];
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(out, 0, 0);
  const sw0 = MAP.pointToLatLng(L.point(box[0], box[1] + th), z), ne0 = MAP.pointToLatLng(L.point(box[0] + tw, box[1]), z);
  return { canvas, bounds: [[sw0.lat, sw0.lng], [ne0.lat, ne0.lng]], z, x0: box[0], y0: box[1], mpp: ground, crs, name: imgFile.name };
}

// Map layer of the resampled image: an image overlay whose element is the canvas itself, so its pixels are neither encoded
// nor decoded again (as Leaflet's SVG overlay takes its element).
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const el = this._image = this._url;
    L.DomUtil.addClass(el, 'leaflet-image-layer');
    if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
    if (this.options.className) L.DomUtil.addClass(el, this.options.className);
    el.onselectstart = L.Util.falseFn;
    el.onmousemove = L.Util.falseFn;
  },
});
const layer = (im, options) => new CanvasOverlay(im.canvas, im.bounds, options);

// The image as a source for roof tracing: a window of n x n map pixels round (lat, lon) at zoom z (at most the image's own),
// with the click's position in it, the metres per pixel and the way back to lat/lon; pixels outside the image are transparent.
function source(im) {
  let cv = null;
  return {
    maxZoom: im.z,
    window(lat, lon, z, size) {
      const q = MAP.latLngToPoint(L.latLng(lat, lon), z), s = 2 ** (im.z - z);
      const x0 = Math.floor(q.x) - size / 2, y0 = Math.floor(q.y) - size / 2;
      let data;
      if (s === 1) data = im.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x0 - im.x0, y0 - im.y0, size, size).data;
      else {
        if (!cv) { cv = document.createElement('canvas'); cv.width = cv.height = size; }
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(im.canvas, x0 * s - im.x0, y0 * s - im.y0, size * s, size * s, 0, 0, size, size);
        data = ctx.getImageData(0, 0, size, size).data;
      }
      return { data, n: size, sx: q.x - x0, sy: q.y - y0, mpp: 156543.03392 * Math.cos(lat * D2R) / 2 ** z,
               toLatLon: (x, y) => { const p = MAP.pointToLatLng(L.point(x0 + x, y0 + y), z); return [p.lat, p.lng]; } };
    },
  };
}

export { load, layer, source, crsLabel };
