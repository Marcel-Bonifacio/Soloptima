// The seasonal load from an appliance list (Load page): rows of appliance, power, quantity, hours a day in each season and the
// hour it starts, times the number of households. It gives an average day for each month, which the synthetic load
// (data-view.js synthLoad) uses in place of the daily shape and monthly scaling; plain functions (ui/tests/appliances.test.js).
import { SEASONS, SEASON_OF_MONTH } from './series.js';

export const MAX_APPLIANCES = 60;
export const newAppliance = () => ({ name: '', w: 0, qty: 1, h: [0, 0, 0, 0], start: 18 });
const num = (v, lo, hi) => { const x = +v; return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; };

// The list as the project keeps it, from whatever a file holds: {households, items}, every number in range
export function cleanAppliances(A) {
  const items = A && Array.isArray(A.items) ? A.items.slice(0, MAX_APPLIANCES) : [];
  return {
    households: num(A && A.households != null ? A.households : 1, 0, 1e6),
    items: items.filter((x) => x && typeof x === 'object').map((x) => ({
      name: String(x.name ?? '').slice(0, 60), w: num(x.w, 0, 1e7), qty: num(x.qty, 0, 1e6),
      h: SEASONS.map((_, s) => num(Array.isArray(x.h) ? x.h[s] : 0, 0, 24)), start: Math.round(num(x.start, 0, 23)),
    })),
  };
}

// kW of one row in each hour of a day of season s: on for h hours from the start hour (the last one in part), past midnight
// into the early hours
function rowDay(x, s, kw) {
  const day = new Array(24).fill(0), hrs = num(x.h[s], 0, 24), p = (num(x.w, 0, 1e7) * num(x.qty, 0, 1e6)) / 1000 * kw;
  for (let k = 0; k < Math.ceil(hrs); k++) day[(x.start + k) % 24] += p * Math.min(1, hrs - k);
  return day;
}

// The average day (24 kW values) of each season, all households
export function seasonDays(A) {
  const L = cleanAppliances(A);
  return SEASONS.map((_, s) => L.items.reduce((d, x) => { rowDay(x, s, L.households).forEach((v, h) => { d[h] += v; }); return d; }, new Array(24).fill(0)));
}

// The average day of each month (12 x 24 kW), or null while the list has no energy
export function applianceShapes(A) {
  const days = seasonDays(A);
  return days.some((d) => d.some((v) => v > 0)) ? SEASON_OF_MONTH.map((s) => days[s]) : null;
}

// Energy a day (kWh) and the highest hour of the average day (kW) in each season
export const seasonEnergy = (A) => seasonDays(A).map((d) => ({ kwh: d.reduce((a, v) => a + v, 0), peak: Math.max(...d) }));

// One edit of the list: a cell (`key` name, w, qty, start, or h0 to h3 for the hours of a season), a row added or removed, or the
// households. Returns the list kept in the project.
export function editAppliances(A, op) {
  const L = cleanAppliances(A);
  if (op.add && L.items.length < MAX_APPLIANCES) L.items.push(newAppliance());
  if (op.remove != null) L.items.splice(op.remove, 1);
  if (op.households != null) L.households = num(op.households, 0, 1e6);
  if (op.row != null && L.items[op.row]) {
    const x = L.items[op.row], k = op.key;
    if (k === 'name') x.name = String(op.value).slice(0, 60);
    else if (/^h[0-3]$/.test(k)) x.h[+k[1]] = num(op.value, 0, 24);
    else if (k === 'start') x.start = Math.round(num(op.value, 0, 23));
    else if (k === 'w' || k === 'qty') x[k] = num(op.value, 0, k === 'w' ? 1e7 : 1e6);
  }
  return L;
}
