// The genset fleet as plain functions: the further groups of a mixed fleet (P.diesel.more_groups) and their editor, the fleet's
// size and label, and the rating and least output of u units online as the engine commits them (in merit order, result.fleet).
import { fmtNum, fmtPct } from './format.js';

export const MAX_GROUPS = 8;
// Fuel efficiency (kWh/L) is entered at these loadings; blank takes the main group's curve
export const FUEL_POINTS = [0.25, 0.5, 0.75, 1];

/** @typedef {{name: string, units: number, unit_kw: number, min_load: number, fuel_curve: number[][]|null, capex_kw: number|null, om_kwh: number|null, om_unit_hour: number|null}} Group */

// The columns of the editor: [key, label, unit, kind] (kind: text | int | num | pct | eff (a point of the fuel curve) | cost (blank: main group's))
export const GROUP_COLUMNS = [
  ['name', 'Name', '', 'text'], ['units', 'Units', '', 'int'], ['unit_kw', 'Rating', 'kW', 'num'], ['min_load', 'Min. loading', '%', 'pct'],
  ...FUEL_POINTS.map((lf) => [`eff${lf}`, `kWh/L at ${lf * 100} %`, 'kWh/L', 'eff']),
  ['capex_kw', 'Capex', '/kW', 'cost'], ['om_kwh', 'O&M', '/kWh', 'cost'], ['om_unit_hour', 'O&M', '/unit·h', 'cost'],
];

export const groupsOf = (D) => (Array.isArray(D.more_groups) ? D.more_groups : []);
export const isMixed = (D) => groupsOf(D).length > 0;
export const fleetUnits = (D) => (+D.units || 0) + groupsOf(D).reduce((a, g) => a + (+g.units || 0), 0);
export const fleetKw = (D) => (+D.units || 0) * (+D.unit_kw || 0) + groupsOf(D).reduce((a, g) => a + (+g.units || 0) * (+g.unit_kw || 0), 0);
// "4 × 500 kW" or "4 × 500 kW + 2 × 1,000 kW (standby)"
export function fleetLabel(D) {
  const one = (n, kw, name) => `${fmtNum(+n || 0)} × ${fmtNum(+kw || 0)} kW${name ? ` (${name})` : ''}`;
  return [one(D.units, D.unit_kw, isMixed(D) ? 'main' : ''), ...groupsOf(D).map((g, i) => one(g.units, g.unit_kw, g.name || `group ${i + 2}`))].join(' + ');
}
// The name of group `index` of the project's list (0 = the main group)
export const groupName = (D, index) => (index === 0 ? 'Main group' : groupsOf(D)[index - 1]?.name || `Group ${index + 1}`);

export function newGroup(D) {
  return { name: '', units: 1, unit_kw: +D.unit_kw || 500, min_load: +D.min_load || 0.3, fuel_curve: null, capex_kw: null, om_kwh: null, om_unit_hour: null };
}
export function addGroup(D) {
  if (!Array.isArray(D.more_groups)) D.more_groups = [];
  if (D.more_groups.length >= MAX_GROUPS) return { changed: false, error: `A fleet has at most ${MAX_GROUPS + 1} groups.` };
  D.more_groups.push(newGroup(D));
  return { changed: true };
}
export function removeGroup(D, i) {
  if (!groupsOf(D)[i]) return { changed: false };
  D.more_groups.splice(i, 1);
  return { changed: true };
}

// What a cell shows
export function cellValue(g, key) {
  if (key.startsWith('eff')) { const p = (g.fuel_curve || []).find(([lf]) => Math.abs(lf - +key.slice(3)) < 1e-9); return p ? String(p[1]) : ''; }
  const v = g[key];
  if (v == null) return '';
  return key === 'min_load' ? String(+(v * 100).toFixed(6)) : String(v);
}

// A typed cell into the group: {changed} or {error}
export function setCell(D, i, key, raw) {
  const g = groupsOf(D)[i], col = GROUP_COLUMNS.find((c) => c[0] === key);
  if (!g || !col) return { changed: false };
  const kind = col[3], txt = String(raw).trim(), x = Number(txt.replace(',', '.'));
  const bad = (m) => ({ changed: false, error: `${g.name || `Group ${i + 2}`}: ${m}` });
  if (kind === 'text') { g.name = txt.replace(/[<>&"']/g, '').slice(0, 40); return { changed: true }; }
  if (kind === 'cost') {
    if (txt === '') { g[key] = null; return { changed: true }; }
    if (!isFinite(x) || x < 0) return bad(`${col[1]} must be a non-negative number, or blank for the main group's.`);
    g[key] = x; return { changed: true };
  }
  if (kind === 'eff') {
    const lf = +key.slice(3), pts = (g.fuel_curve || []).filter(([l]) => Math.abs(l - lf) > 1e-9);
    if (txt !== '') {
      if (!isFinite(x) || x <= 0 || x > 10) return bad('fuel efficiency must be above 0 and at most 10 kWh/L.');
      pts.push([lf, x]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    g.fuel_curve = pts.length ? pts : null;
    return { changed: true };
  }
  if (!isFinite(x) || txt === '') return bad(`${col[1]} needs a number.`);
  if (kind === 'int') { if (x < 0 || x > 1000) return bad('units must be 0 to 1000.'); g.units = Math.round(x); return { changed: true }; }
  if (kind === 'pct') { if (x < 0 || x >= 100) return bad('minimum loading must be at least 0 % and below 100 %.'); g.min_load = x / 100; return { changed: true }; }
  if (x <= 0) return bad('the rating must be above 0 kW.');
  g.unit_kw = x;
  return { changed: true };
}
// A group whose fuel curve has a single point (the engine needs 2 or none): the warning under the table
export const curveWarnings = (D) => groupsOf(D).map((g, i) => (g.fuel_curve && g.fuel_curve.length === 1 ? `${g.name || `Group ${i + 2}`}: enter at least two fuel efficiencies, or none for the main group's curve.` : '')).filter(Boolean);

// The groups as the engine takes them: a curve of their own as a table; without one the engine takes the main group's fuel model
export function engineGroups(D) {
  return groupsOf(D).map((g) => {
    const { fuel_curve, ...rest } = g;
    return fuel_curve && fuel_curve.length >= 2 ? { ...rest, fuel_model: 'table', fuel_curve } : rest;
  });
}

// Rating and least output of u units online: the merit order of the result (R.fleet) for a mixed fleet, else u identical units
export function unitCap(R, D, u) {
  if (!R || !R.fleet) return u * D.unit_kw;
  let left = u, cap = 0;
  for (const g of R.fleet) { const n = Math.min(left, g.units); cap += n * g.unit_kw; left -= n; if (left <= 0) break; }
  return cap;
}
export function unitMin(R, D, u) {
  if (!R || !R.fleet) return u * D.unit_kw * D.min_load;
  let left = u, m = 0;
  for (const g of R.fleet) { const n = Math.min(left, g.units); m += n * g.unit_kw * g.min_load; left -= n; if (left <= 0) break; }
  return m;
}

// The genset groups of year 1 as table rows (null for one group): name, units, run hours, energy, loading, fuel, specific fuel, starts
export function groupTable(S, D) {
  const R = S.result, y = R.years[0];
  if (!R.fleet || !y.groups) return null;
  return {
    heads: ['Group (merit order)', 'Units', 'Run hours', 'Energy MWh', 'Avg loading', 'Fuel kL', 'L/kWh', 'Starts'],
    rows: y.groups.map((g, k) => {
      const f = R.fleet[k];
      return [groupName(D, g.index), `${fmtNum(f.units)} × ${fmtNum(f.unit_kw)} kW`, fmtNum(g.unit_hours), fmtNum(g.gen_kwh / 1000),
        g.unit_hours > 0 ? fmtPct(g.gen_kwh / (g.unit_hours * f.unit_kw)) : '–', fmtNum(g.fuel_l / 1000, 1), g.gen_kwh > 0 ? fmtNum(g.fuel_l / g.gen_kwh, 3) : '–', fmtNum(g.starts)];
    }),
  };
}
