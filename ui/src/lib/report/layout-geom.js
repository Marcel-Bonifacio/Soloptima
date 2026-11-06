// The site and PV layout of the report: the drawn areas in a local metric frame, the workbook's Layout sheet, and the satellite
// image of the frame. Pure functions of the project (`P`) and the layout helpers handed over by the old Site & layout page.
import { fmtNum } from '../format.js';

export const MAX_LAYOUT_TABLES = 30000;   // the layout keeps and draws at most this many PV tables
export const w180 = (lo) => ((((lo + 180) % 360) + 360) % 360) - 180;   // longitude in [-180, 180)
export const coord = (lat, lon) => `${(+lat).toFixed(6)}, ${w180(+lon).toFixed(6)}`;
const finite = (q) => Array.isArray(q) && q.length === 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1]);
export const kmBetween = (a1, o1, a2, o2) => Math.hypot(w180(o2 - o1) * 111.32 * Math.cos(((a1 + a2) / 2) * Math.PI / 180), (a2 - a1) * 110.574);
export const layoutResult = (P) => (P.layout && P.layout.result && typeof P.layout.result === 'object' ? P.layout.result : null);

// null when no PV area or exclusion zone is drawn
export function layoutGeom(P, footprint) {
  const raw = ((P.layout && P.layout.polygons) || []).map((p) => (p && p.type === 'obstacle' && p.kind === 'tree' && finite(p.center) && +p.diameter > 0 ? { ...p, latlngs: footprint(p) } : p))
    .filter((p) => p && Array.isArray(p.latlngs) && p.latlngs.length >= 3 && p.latlngs.length <= 5000 && p.latlngs.every(finite)).slice(0, 2000);
  if (!raw.some((p) => p.type === 'site' || p.type === 'exclusion')) return null;
  const R = layoutResult(P);
  const rt = R && Array.isArray(R.tables) && R.tables.length <= MAX_LAYOUT_TABLES ? R.tables.filter((t) => Array.isArray(t) && t.length === 4 && t.every(finite)) : [];
  // longitudes unwrapped around the first PV-area corner, so an area across ±180° stays in one piece
  const ref = +(raw.find((p) => p.type !== 'exclusion') || raw[0]).latlngs[0][1];
  const uw = (lo) => ref + ((((+lo - ref) % 360) + 540) % 360) - 180;
  const U = (ll) => ll.map(([x, y]) => [+x, uw(y)]);
  const kindOf = (p) => (p.type === 'obstacle' ? (p.kind === 'tree' ? 'tree' : 'building') : p.type === 'exclusion' ? 'exclusion' : 'site');
  const polys = raw.map((p) => ({ ...p, type: kindOf(p), latlngs: U(p.latlngs) })), tables = rt.map(U);
  const sites = polys.filter((p) => p.type === 'site'), excls = polys.filter((p) => p.type === 'exclusion');
  const buildings = polys.filter((p) => p.type === 'building'), trees = polys.filter((p) => p.type === 'tree');
  const osm = raw.some((p) => p.source === 'osm');
  const site = [+P.location.lat, uw(+P.location.lon)], ky = 110574;
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  const grow = (/** @type {number[]} */ [x, y]) => { la0 = Math.min(la0, x); la1 = Math.max(la1, x); lo0 = Math.min(lo0, y); lo1 = Math.max(lo1, y); };
  polys.forEach((p) => p.latlngs.forEach(grow)); tables.forEach((t) => t.forEach(grow));
  // the site marker joins the frame unless it lies far outside the drawn areas
  const k0 = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180), diag = Math.hypot((lo1 - lo0) * k0, (la1 - la0) * ky);
  const away = Math.hypot(Math.max(lo0 - site[1], 0, site[1] - lo1) * k0, Math.max(la0 - site[0], 0, site[0] - la1) * ky) > Math.max(0.5 * diag, 200);
  if (!away) grow(site);
  const kx = 111320 * Math.cos(((la0 + la1) / 2) * Math.PI / 180);
  // 8 % margin, at least 40 m, so the areas do not touch the frame
  const padLat = Math.max((la1 - la0) * 0.08, 40 / ky), padLon = Math.max((lo1 - lo0) * 0.08, 40 / kx);
  la0 -= padLat; la1 += padLat; lo0 -= padLon; lo1 += padLon;
  // a frame no flatter than 1:3, so the north arrow, scale bar and corner labels fit
  let widthM = (lo1 - lo0) * kx, heightM = (la1 - la0) * ky;
  if (heightM < widthM / 3) { const e = (widthM / 3 - heightM) / 2 / ky; la0 -= e; la1 += e; heightM = widthM / 3; }
  if (widthM < heightM / 3) { const e = (heightM / 3 - widthM) / 2 / kx; lo0 -= e; lo1 += e; widthM = heightM / 3; }
  const m = (x, y) => [(y - lo0) * kx, (x - la0) * ky];   // metres east and north of the south-west corner
  const area = (ll) => {
    let s2 = 0; const q = ll.map(([x, y]) => m(x, y));
    q.forEach(([x, y], i) => { const [x2, y2] = q[(i + 1) % q.length]; s2 += x * y2 - x2 * y; });
    return Math.abs(s2) / 2;
  };
  // area centroid (shoelace); on an L- or U-shaped area it can lie outside the area
  const centroid = (ll) => {
    const q = ll.map(([x, y]) => m(x, y));
    let A2 = 0, cx = 0, cy = 0;
    q.forEach(([x, y], i) => { const [x2, y2] = q[(i + 1) % q.length], cr = x * y2 - x2 * y; A2 += cr; cx += (x + x2) * cr; cy += (y + y2) * cr; });
    if (Math.abs(A2) < 1e-6) return [ll.reduce((t, p) => t + p[0], 0) / ll.length, ll.reduce((t, p) => t + p[1], 0) / ll.length];
    return [la0 + cy / (3 * A2) / ky, lo0 + cx / (3 * A2) / kx];
  };
  let siteNote = '';
  if (away) {
    const ex = (site[1] - (lo0 + lo1) / 2) * kx, ny = (site[0] - (la0 + la1) / 2) * ky;
    siteNote = ` The site coordinates lie ${fmtNum(Math.hypot(ex, ny) / 1000, 1)} km from the centre of the drawing, bearing ${Math.round((Math.atan2(ex, ny) * 180 / Math.PI + 360) % 360)}°, outside the frame.`;
  }
  return { polys, sites, excls, buildings, trees, osm, R, tables, site, away, siteNote, la0, la1, lo0, lo1, kx, ky, widthM, heightM, area, centroid };
}

// Rows of the workbook's Layout sheet: every area corner and the layout result
export function layoutRows(P, G) {
  const R = layoutResult(P);
  if (!G && !R) return null;
  const rows = [['Item', 'Corner', 'Latitude', 'Longitude'], ['Site coordinates', '', +P.location.lat, w180(+P.location.lon)]];
  const k = { site: 0, exclusion: 0, building: 0, tree: 0 }, names = { site: 'PV area', exclusion: 'Exclusion zone', building: 'Building', tree: 'Tree' };
  if (G) G.polys.forEach((p) => {
    const name = `${names[p.type]} ${++k[p.type]}` + (p.type === 'building' || p.type === 'tree' ? ` (${fmtNum(+p.height, 1)} m high${p.type === 'tree' ? `, crown ${fmtNum(+p.diameter, 1)} m` : ''})` : '');
    if (p.type === 'tree') rows.push([name, 'centre', +p.center[0], w180(+p.center[1])]);
    else p.latlngs.forEach(([a, b], j) => rows.push([name, j + 1, a, w180(b)]));
  });
  if (R) rows.push([], ['Layout result (area filled)', 'Value'], ['PV tables', +R.n_tables], ['Modules', +R.modules], ['DC capacity, the most the area holds (kWp)', +R.kwp],
    ['PV area (m²)', +R.site_m2], ['Exclusion area (m²)', +R.excl_m2], ['Row pitch (m)', +R.pitch]);
  return rows;
}

// Satellite image of the frame from Esri World Imagery as a data URL: '' when turned off, null when it could not be fetched.
// Requested in geographic coordinates with square degree pixels, so it lines up with the frame once stretched to it. The data
// URL type is set here and the result checked, never taken from the response. Kept for the session per area.
const imgCache = new Map(), IMG_DATA = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
export function clearImageryCache() { const n = [...imgCache.values()].filter(Boolean).length; imgCache.clear(); return n; }
export async function layoutImagery(P, G) {
  if (!(P.report && P.report.imagery)) return '';
  let lo0 = G.lo0, lo1 = G.lo1;
  if (lo1 > 180) { lo0 -= 360; lo1 -= 360; } else if (lo0 < -180) { lo0 += 360; lo1 += 360; }
  if (lo0 < -180 || lo1 > 180) return null;   // the frame still crosses ±180°
  const key = `${lo0},${G.la0},${lo1},${G.la1}`;
  if (imgCache.has(key)) return imgCache.get(key);
  let w0 = 1600, h0 = Math.round(w0 * (G.la1 - G.la0) / (lo1 - lo0));
  if (h0 > 1600) { w0 = Math.round(w0 * 1600 / h0); h0 = 1600; }
  let out = null;
  // where the imagery is coarse (remote areas) the service refuses large images: halve the size until it answers
  for (let k = 1; ; k *= 2) {
    const w = Math.round(w0 / k), h = Math.round(h0 / k);
    if (w < 64 || h < 64) break;
    let r;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
      r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lo0},${G.la0},${lo1},${G.la1}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&f=image`, { signal: ctl.signal });
      clearTimeout(t);
    } catch (e) { return null; }   // offline: not cached, so a later preview tries again
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (r.ok && (type === 'image/jpeg' || type === 'image/png')) {
      const buf = await r.arrayBuffer();
      if (buf.byteLength <= 8e6) {
        const src = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(''); fr.readAsDataURL(new Blob([buf], { type })); });
        if (IMG_DATA.test(src)) out = src;
      }
      break;
    }
    if (!r.ok && r.status < 500) break;   // a 4xx answer does not change with the size
  }
  imgCache.set(key, out);
  return out;
}

// What the SVG drawing needs: size, projection, path data and the scale bar, as plain numbers and strings
export function layoutFrame(G) {
  let W = 1000, H = Math.round(W * G.heightM / G.widthM);
  if (H > 1300) { H = 1300; W = Math.round(H * G.widthM / G.heightM); }
  const X = (lon) => ((lon - G.lo0) / (G.lo1 - G.lo0)) * W, Y = (lat) => ((G.la1 - lat) / (G.la1 - G.la0)) * H;
  const path = (ll) => 'M' + ll.map(([a, b]) => `${X(b).toFixed(1)},${Y(a).toFixed(1)}`).join('L') + 'Z';
  const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000], target = G.widthM / 5;
  const Lm = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), nice[0]);
  return { W, H, path, siteX: X(G.site[1]), siteY: Y(G.site[0]), Lpx: Lm * W / G.widthM, label: Lm >= 1000 ? `${Lm / 1000} km` : `${Lm} m` };
}
