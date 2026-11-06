// The fill of the PV areas with module tables, of a project P, without the map: the rows of each area, the result the project
// keeps (P.layout.result), the tables taken out by hand, the grid aligned to a click and the GCR for shade-free rows.
// ui/tests/layout.test.js runs it under Node.
import { localProjector, blockedOf, gridOf, fillArea, polyArea } from './geometry.js';
import { orientationOf, projectAz } from './items.js';
import { MAX_LAYOUT_TABLES } from '../report/layout-geom.js';
import { fmtNum } from '../format.js';
import { sunAt } from '../sun.js';

export { MAX_LAYOUT_TABLES };

// Shade classes of the tables on the map: [upper limit of the beam lost, colour, legend]
export const SHADE_CLASSES = [[0.01, '#3987e5', 'under 1 %'], [0.05, '#e2b93b', '1-5 %'], [0.1, '#f08c2e', '5-10 %'], [0.2, '#e0561b', '10-20 %'], [Infinity, '#b4232a', 'over 20 %']];

// Size of a table: across the rows (slant, up the module plane) and along them, from the modules it holds.
export function tableSize(P) {
  const pv = P.pv, lay = P.layout, portrait = lay.orientation === 'portrait';
  return { slant: lay.modules_across * (portrait ? pv.module_length : pv.module_width),
           along: lay.modules_per_table * (portrait ? pv.module_width : pv.module_length) + 0.02 * lay.modules_per_table };
}
// Rows of a PV area s: along r, facing f (unit vectors in local metres), table depth across the row, row pitch, east-west pairs;
// its own tilt and azimuth or the project's (trackers always the project's).
export function rowsOf(P, s, slant, along) {
  const pv = P.pv, tracker = pv.mount === 'tracker', o = orientationOf(P, s);
  const a = (tracker ? pv.tracker_axis_azimuth : o.azimuth) * Math.PI / 180;
  const r = tracker ? [Math.sin(a), Math.cos(a)] : [Math.cos(a), -Math.sin(a)];
  const depth = tracker ? slant : slant * Math.cos(o.tilt * Math.PI / 180);
  return { r, f: [-r[1], r[0]], along, ew: o.ew, depth, pitch: o.canopy ? Math.max(depth, 0.1) : (o.ew ? 2 : 1) * slant / Math.max(0.05, pv.gcr),   // a canopy's rows touch (a near-vertical one keeps a 0.1 m pitch)
           label: o.own ? `${o.canopy ? 'canopy ' : o.ew ? 'east-west ' : ''}${fmtNum(o.tilt, 1)}° / ${fmtNum(o.azimuth, 1)}°` : 'project' };
}
export const countGroups = (labels) => [...labels.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map())].map(([label, n]) => ({ label, n }));

// Fills every PV area, trying the first row at 8 offsets across the pitch and keeping the one with the most tables (a typed
// first-row shift is the only try). Tables keep clear of exclusion zones and of the footprints of buildings and trees, and
// stay out where the user took one out. Returns the layout result and the tables in [lat, lon] (all of them, also when the
// result keeps none for being too many), or null without a PV area.
export function fillLayout(P) {
  const all = P.layout.polygons || [], sites = all.filter((p) => p.type === 'site');
  if (!sites.length) return null;
  const excl = all.filter((p) => p.type === 'exclusion'), blocks = all.filter((p) => p.type === 'exclusion' || p.type === 'obstacle');
  const pr = localProjector(sites.flatMap((s) => s.latlngs));
  const S = sites.map((s) => s.latlngs.map(pr.fwd)), X = [], C = [];   // blocked polygons and the clearance kept around each
  blocks.forEach((g) => blockedOf(g, pr.fwd).forEach((poly) => { X.push(poly); C.push(g.clearance || 0); }));

  const pv = P.pv, lay = P.layout, { slant, along } = tableSize(P);
  const tables = [], labels = [], areas = [];
  const centre = (c) => [c.reduce((a, p) => a + p[0], 0) / c.length, c.reduce((a, p) => a + p[1], 0) / c.length];
  const gone = (lay.removed || []).map((t) => centre(t.map(pr.fwd)));
  S.forEach((site, i) => {
    const g = rowsOf(P, sites[i], slant, along), shift = sites[i].shift_u || 0, rowShift = sites[i].shift_v;
    let best = null;
    for (let k = 0; k < (rowShift != null ? 1 : 8); k++) {
      const t = fillArea(lay, site, X, C, g, rowShift != null ? rowShift / g.pitch : k / 8, shift);
      if (!best || t.length > best.length) best = t;
    }
    if (gone.length) {   // tables taken out by hand stay out: a new table whose centre is within half a table of one is dropped
      const rad = 0.45 * Math.min(along, g.depth);
      best = best.filter((t) => { const [cx, cy] = centre(t); return !gone.some(([x, y]) => Math.hypot(cx - x, cy - y) < rad); });
    }
    best.forEach((t) => { tables.push(t.map(pr.inv)); labels.push(g.label); areas.push(i); });
  });
  const modules = tables.length * lay.modules_across * lay.modules_per_table;
  const siteArea = S.reduce((a, s) => a + polyArea(s), 0), exclArea = excl.reduce((a, g) => a + blockedOf(g, pr.fwd).reduce((t, p) => t + polyArea(p), 0), 0);
  const g0 = rowsOf(P, {}, slant, along);
  const result = { tables: tables.length <= MAX_LAYOUT_TABLES ? tables.map((t) => t.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)])) : [],
                   n_tables: tables.length, modules, kwp: modules * pv.module_wp / 1000, site_m2: siteArea, excl_m2: exclArea,
                   pitch: g0.pitch, slant, along, depth: g0.depth };
  if (result.tables.length) result.table_area = areas;
  const groups = countGroups(labels);
  if (groups.length > 1 || (groups.length && groups[0].label !== 'project')) result.groups = groups;
  return { result, tables, emptyAreas: S.length - new Set(areas).size };
}

// Orientation label of each table of a layout result, from the PV area it stands in.
function labelsOf(P, R) {
  const { slant, along } = tableSize(P), by = (P.layout.polygons || []).filter((g) => g.type === 'site').map((s) => rowsOf(P, s, slant, along).label);
  return (R.table_area || []).map((i) => by[i] || 'project');
}
// A layout result without the tables where keep is false: counts, capacity, areas and orientation groups follow.
export function keepOnly(P, R, keep) {
  const pick = (a) => a.filter((_, i) => keep[i]), tables = pick(R.tables), per = P.layout.modules_across * P.layout.modules_per_table;
  const out = { ...R, tables, n_tables: tables.length, modules: tables.length * per, kwp: tables.length * per * P.pv.module_wp / 1000 };
  if (R.table_area) out.table_area = pick(R.table_area);
  if (R.groups) out.groups = countGroups(labelsOf(P, out));
  return out;
}

// The grid shifts of a PV area (item, as saved) that put a table corner at the point [lat, lon], in the frame the fill uses.
export function alignShift(P, item, at) {
  const sites = (P.layout.polygons || []).filter((g) => g.type === 'site');
  const pr = localProjector(sites.flatMap((s) => s.latlngs)), { slant, along } = tableSize(P), g = rowsOf(P, item, slant, along);
  const grid = gridOf(item.latlngs.map(pr.fwd), g, P.layout.setback), [u, v] = grid.toUV(pr.fwd(at));
  // a click on a corner of the grid as it stands is no shift, not a whole step (which would push the first table off the area)
  const mod = (x, m) => { const r = ((x % m) + m) % m; return +(m - r < 0.005 ? 0 : r).toFixed(2); };
  return { shift_u: mod(u - grid.u0, along + (P.layout.table_gap || 0)), shift_v: mod(v - grid.v0, g.pitch) };
}

// Ground coverage ratio for fixed rows that do not shade each other between the chosen solar hours on the winter solstice
// (the lowest sun of the year): the pitch keeps the shadow of a row's upper edge, cast along the sun's direction relative
// to the rows, off the row behind. Rounded down to 0.01. { gcr, slant } or { error }.
export function shadeFreeGcr(P) {
  const pv = P.pv, lay = P.layout;
  if (pv.mount === 'tracker') return { error: 'Trackers avoid row shading by backtracking.' };
  const from = lay.shade_free_from, to = lay.shade_free_to;
  if (!(from >= 6 && to <= 18 && from < to)) return { error: 'Shade-free hours: from 6 to 12 h and to 12 to 18 h.' };
  const lat = P.location.lat, decl = lat >= 0 ? -23.44 : 23.44, az = projectAz(P), r = Math.PI / 180;
  const slant = lay.modules_across * (lay.orientation === 'portrait' ? pv.module_length : pv.module_width), tilt = pv.tilt || 0;
  let pitch = slant * Math.cos(tilt * r);
  for (let h = from; h <= to + 1e-9; h += 0.25) {
    const s = sunAt(lat, decl, 15 * (h - 12));
    if (s.el < 2) return { error: `The sun is below 2° at ${fmtNum(h, 2)} h solar time on the winter solstice here: choose shorter hours.` };
    const cd = Math.cos((s.az - az) * r);
    if (cd > 0) pitch = Math.max(pitch, slant * Math.cos(tilt * r) + slant * Math.sin(tilt * r) * cd / Math.tan(s.el * r));
  }
  return { gcr: Math.min(0.95, Math.max(0.1, Math.floor(slant / pitch * 100) / 100)), slant };
}
