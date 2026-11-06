// A project file made ready for use (docs/ui.md): the input rules of the schema forms (migrate.js), then the rules for what a file
// from someone else may carry. Results saved in a file are drawn as engine output, so a file keeps them only with the engine's
// types; anything else is dropped and recomputed by the next run. Layout geometry is bounded and finite numbers only.
import { migrateForms } from './migrate.js';
import { defaultProject, mountStyleOf, LOAD_TEMPLATES } from './schema/index.js';
import { MONTHS } from './series.js';
import { migrateEquipment } from './equip/library.js';
import { cleanItem, cleanRemoved } from './layout/items.js';
import { MAX_LAYOUT_TABLES } from './layout/fill.js';
import { cleanReport } from './report/figures.js';
import { cleanVariants } from './variants.js';

const num = Number.isFinite, int = Number.isInteger;

// weather and load data checks (qc): the four lists the page reads, and a finite timing shift
export function cleanQc(D) {
  const Q = D && D.qc;
  if (Q && (typeof Q !== 'object' || !['flags', 'days', 'hours', 'set'].every((k) => Array.isArray(Q[k])) ||
      (Q.timing && Q.timing.shift_h != null && !num(Q.timing.shift_h)))) D.qc = null;
}

// the weather-year (P50/P90) result and the factor applied from it
export function cleanResourceYears(RY) {
  if (RY && RY.result && !(typeof RY.result === 'object' && Array.isArray(RY.result.years) && RY.result.range &&
      int(RY.result.range.from) && int(RY.result.range.to) && RY.result.stats && typeof RY.result.stats === 'object' &&
      Object.values(RY.result.stats).every((s) => s && typeof s === 'object' && int(s.worst_year)))) RY.result = null;
  if (RY && RY.applied && !num(RY.applied.p90_factor)) RY.applied = null;
}

// PV areas keep their surface height and own orientation, buildings and trees their sizes in range; the layout runs again from
// the areas when needed
export function cleanLayout(L) {
  const fin = (q) => Array.isArray(q) && q.length === 2 && num(+q[0]) && num(+q[1]);
  L.polygons = (Array.isArray(L.polygons) ? L.polygons : []).map(cleanItem).filter(Boolean).slice(0, 2000);
  L.removed = cleanRemoved(L.removed);
  if (!(L.aisle_every >= 1 && L.aisle_every <= 500)) L.aisle_every = null;
  if (!(L.aisle_width >= 0.5 && L.aisle_width <= 50)) L.aisle_width = 4;
  if (!(typeof L.max_table_shade === 'number' && L.max_table_shade >= 0 && L.max_table_shade <= 1)) L.max_table_shade = null;
  const LR = L.result;
  if (LR && typeof LR === 'object' && !(Array.isArray(LR.tables) && LR.tables.length <= MAX_LAYOUT_TABLES && LR.tables.every((t) => Array.isArray(t) && t.length === 4 && t.every(fin)))) LR.tables = [];
  // fields the layout writes back with its tables: the area of each table, the counts by orientation, the tables left out
  if (LR && typeof LR === 'object') {
    const sites = L.polygons.filter((g) => g.type === 'site').length;
    if (!(Array.isArray(LR.table_area) && LR.table_area.length === (LR.tables || []).length && LR.table_area.every((a) => int(a) && a >= 0 && a < sites))) delete LR.table_area;
    if (!(Array.isArray(LR.groups) && LR.groups.every((g) => g && typeof g.label === 'string' && num(g.n)))) delete LR.groups;
    if (!num(LR.dropped)) delete LR.dropped;
  }
}

// `siteZone(lat, lon)` is the offline time-zone lookup
export function migrateProject(p, siteZone) {
  migrateForms(p, { defaults: defaultProject, siteZone, mountStyleOf, loadTemplates: LOAD_TEMPLATES, months: MONTHS });
  cleanQc(p.weather); cleanQc(p.load);
  cleanResourceYears(p.resource_years);
  migrateEquipment(p);   // datasheets copied from an older built-in library
  cleanLayout(p.layout);
  cleanReport(p);
  p.variants = cleanVariants(p.variants);
}
