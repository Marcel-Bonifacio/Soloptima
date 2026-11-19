// The PV loss diagram as SVG text, in the usual engineering-report form: a framed box, a trunk per section, the totals in bold on
// the right with their value on the trunk, and each loss as a hook arrow off the trunk with its share of the step before (a large
// loss as a wide lobe, a gain arrowed in). The PV part follows the yield model's loss chain (engine/src/pv/profile.rs, irradiance
// in kWh/m², energy in kWh/kWp shown in MWh for the plant); with a simulation, two more sections follow year 1 of the dispatch:
// the PV energy in the plant (outages, curtailment, the battery's share) and the battery itself. Every text goes through `esc`;
// the page and the report show it as parsed elements (report/svg-node.js).
import { esc } from './equip/sld.js';

// the label of each step of the chain, and its role: a total (bold, its value on the trunk) or the head of the irradiance losses
const STEPS = [
  [/^Global horizontal/, 'Global horizontal irradiation', 'total'],
  [/^Global incident/, 'Global incident in coll. plane', 'head'],
  [/^After terrain horizon/, 'Far shadings: horizon'],
  [/^After shading by nearby objects/, 'Near shadings: buildings and trees'],
  [/^After near\/row shading/, 'Near shadings: irradiance loss'],
  [/^After IAM/, 'IAM factor on global'],
  [/^Effective irradiation/, 'Soiling loss factor'],
  [/^Effective incl\. bifacial/, 'Bifacial: rear side gain'],
  [/^After spectral/, 'Spectral correction'],
  [/^Array nominal energy/, 'Array nominal energy (at STC effic.)', 'total'],
  [/^After low-irradiance/, 'PV loss due to irradiance level'],
  [/^After temperature/, 'PV loss due to temperature'],
  [/^After snow/, 'Snow cover loss'],
  [/^After mismatch/, 'Module quality, LID, mismatch and wiring loss', 'dc'],
  [/^After MPP tracking/, 'MPP tracking loss'],
  [/^After inverter efficiency/, 'Inverter loss during operation (efficiency)'],
  [/^After inverter clipping/, 'Inverter loss over nominal inv. power'],
  [/^After AC/, 'AC ohmic and transformer loss'],
  [/^After availability/, 'System unavailability'],
];
/** @returns {[RegExp|null, string, string|undefined]} */
const stepOf = (n) => /** @type {any} */ (STEPS.find(([re]) => /** @type {RegExp} */ (re).test(n)) || [null, n.replace(/^After /, ''), undefined]);
const pct = (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(2)}%`;
const num = (x, d) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const frac = (x) => Math.min(0.99, Math.max(0, +x || 0));

// The rows of the diagram: { t: 'total', value, label } | { t: 'loss', d, label, head } | { t: 'note', left, label } |
// { t: 'break', title } between sections
function rowsOf(losses, pv, y1) {
  const kwp = +pv.capacity_kwp || 0, wp = +pv.module_wp || 0, a1 = (+pv.module_length || 0) * (+pv.module_width || 0);
  const area = wp > 0 && a1 > 0 ? kwp * 1000 / wp * a1 : 0, eff = a1 > 0 && wp > 0 ? wp / (a1 * 1000) : 0;
  const mwh = (kwh) => `${num(kwh / 1000, 1)} MWh`, mpp = losses.some((s) => /^After MPP tracking/.test(s.name));
  /** @type {any[]} */
  const R = [];
  losses.forEach((s, i) => {
    const [, label, kind] = stepOf(s.name), prev = losses[i - 1];
    if (prev && prev.irradiance && !s.irradiance) {
      R.push({ t: 'total', value: `${num(prev.value, 0)} kWh/m²${area ? ` * ${num(area, 0)} m² coll.` : ''}`, label: 'Effective irradiation on collectors', irr: true });
      R.push({ t: 'break', note: eff ? `efficiency at STC = ${num(eff * 100, 2)}%` : '', label: 'PV conversion' });
    }
    if (kind === 'total') { R.push({ t: 'total', value: s.irradiance ? `${num(s.value, 0)} kWh/m²` : mwh(s.value * kwp), label, irr: s.irradiance }); return; }
    const r = prev && prev.irradiance === s.irradiance && prev.value ? s.value / prev.value : 1;
    if (kind === 'dc') {
      // the factors of this step, as the yield model applies them (engine/src/pv/pass.rs): module quality, LID, mismatch, and
      // the ohmic wiring loss as the rest (it varies hour by hour when it is given at STC)
      const q = 1 - frac(pv.module_quality), l = 1 - frac(pv.lid), m = 1 - frac(pv.mismatch), w = q * l * m > 0 ? r / (q * l * m) : 1;
      [{ f: q, lab: 'Module quality loss' }, { f: l, lab: 'LID: light induced degradation' }, { f: m, lab: 'Mismatch loss, modules and strings' }, { f: w, lab: 'Ohmic wiring loss' }]
        .forEach(({ f, lab }) => R.push({ t: 'loss', d: f - 1, label: lab }));
    } else R.push({ t: 'loss', d: r - 1, label, head: kind === 'head' });
    if (/^After MPP tracking/.test(s.name) || (!mpp && /^After mismatch/.test(s.name))) R.push({ t: 'total', value: mwh(s.value * kwp), label: 'Array virtual energy at MPP' });
    if (/^After inverter clipping/.test(s.name)) R.push({ t: 'total', value: mwh(s.value * kwp), label: 'Available energy at inverter output' });
  });
  const last = losses[losses.length - 1];
  if (!last.irradiance) R.push({ t: 'total', value: mwh(last.value * kwp), label: 'PV energy available (yield model)' });
  if (!y1 || !(y1.pv_avail > 0)) return R;

  // year 1 of the dispatch: the PV energy in the plant
  const out = +y1.inverter_outage_kwh || 0, avail = +y1.pv_avail, start = avail + out, curt = +y1.pv_curtailed || 0;
  const ch = +y1.bess_ch || 0, dis = +y1.bess_dis || 0, toB = +y1.pv_to_bess || 0, pvRt = ch > 0 ? toB * (1 - dis / ch) : 0;
  R.push({ t: 'break', label: 'Plant operation, year 1 (simulation)' });
  R.push({ t: 'total', value: mwh(start), label: 'PV energy available to the plant' });
  if (out > 0) R.push({ t: 'loss', d: -out / start, label: 'PV inverter outages' });
  let e = avail;
  if (curt > 0) { R.push({ t: 'loss', d: -curt / e, label: 'Curtailed: load served and battery full' }); e -= curt; }
  if (pvRt > 0) { R.push({ t: 'loss', d: -pvRt / e, label: 'Battery round trip, on the PV energy stored' }); e -= pvRt; }
  R.push({ t: 'total', value: mwh(e), label: (+y1.pv_to_grid || 0) > 0 ? 'PV energy delivered to the load and the grid' : 'PV energy delivered to the load' });
  if (+y1.aux > 0) R.push({ t: 'note', left: mwh(+y1.aux), label: 'Plant auxiliaries consumed (from all sources)' });
  if (!(ch > 0)) return R;

  // the battery over year 1: what went in, what was lost and what came out
  const sd = +y1.self_discharge || 0, dE = (+y1.e_end || 0) - (+y1.e_start || 0), conv = Math.max(0, ch - dis - sd - dE);
  R.push({ t: 'break', label: 'Battery, year 1 (simulation)' });
  R.push({ t: 'total', value: mwh(ch), label: 'Energy charged into the battery' });
  let b = ch;
  if (conv > 0) { R.push({ t: 'loss', d: -conv / b, label: 'Charge and discharge conversion losses' }); b -= conv; }
  if (sd > 0) { R.push({ t: 'loss', d: -sd / b, label: 'Self-discharge' }); b -= sd; }
  if (Math.abs(dE) > 1e-6 * ch) { R.push({ t: 'loss', d: -dE / b, label: dE > 0 ? 'Kept in the battery at the end of the year' : 'Taken from the energy stored at the start' }); }
  R.push({ t: 'total', value: mwh(dis), label: 'Energy discharged from the battery' });
  return R;
}

// losses: [{ name, value, irradiance }] as the engine gives them; pv: the project's PV inputs; y1: year 1 of a simulation (optional)
export function lossDiagram(losses, pv = {}, y1 = null) {
  if (!Array.isArray(losses) || losses.length < 2) return '';
  const R = rowsOf(losses, pv, y1);
  const W = 560, xa = 80, xb = 225, cx = (xa + xb) / 2, xv = xa + 42, xp = 238, xl = 312, row = 16.5;
  const T = (x, y, t, o = '') => `<text x="${x}" y="${y}" ${o}>${esc(t)}</text>`, B = 'font-weight="700"', MID = 'text-anchor="middle"';
  // a loss leaves the trunk's right edge as a hook (a wide lobe when it is large); a gain comes in
  const hook = (yy, d) => {
    if (d > 5e-5) return `<path d="M${xb + 16} ${yy - 7} q-11 0 -14 8" fill="none" stroke="#000" stroke-width=".8"/><path d="M${xb + 2} ${yy + 4} l-1.5 -5 l4 2z"/>`;
    const k = Math.min(1, Math.abs(d) / 0.15), w = 5 + 26 * k, h = 5 + 20 * k;
    return `<path d="M${xb} ${yy - h} c${w * 0.15} 0 ${w} ${h * 0.35} ${w} ${h + 1}" fill="none" stroke="#000" stroke-width=".8"/><path d="M${xb + w - 2.5} ${yy + 1} l2.5 4 l2.5 -4z"/>`;
  };
  let y = 48, g = '', top = 30;
  const sections = [];
  for (const r of R) {
    if (r.t === 'break') {
      sections.push([top, y - 8]);
      y += 14;
      if (r.note) g += T(xa - 6, y, r.note);
      g += T(xl, y, r.label, r.note ? '' : B);
      y += 30; top = y - 22;
    } else if (r.t === 'total') {
      g += T(r.irr ? cx : xv, y, r.value, MID) + T(xl, y, r.label, B); y += row + 4;
    } else if (r.t === 'note') {
      g += T(xv, y, r.left, MID) + T(xl, y, r.label); y += row + 4;
    } else {
      const big = Math.abs(r.d) >= 0.05 ? 16 : 0;
      y += big;
      g += hook(y - 3, r.d) + T(xp + (r.d < 0 ? 26 * Math.min(1, Math.abs(r.d) / 0.15) : 0), y, pct(r.d)) + T(xl, y, r.label, r.head ? B : '');
      y += row;
    }
  }
  sections.push([top, y - 8]);
  // the trunk: each section a box with a notched top; the last ends in an arrowhead
  const trunk = sections.map(([t, b], k) => `<path d="M${xa} ${t} L${cx} ${t + 9} L${xb} ${t} L${xb} ${b}${k === sections.length - 1 ? ` L${cx} ${b + 14}` : ''} L${xa} ${b} Z" fill="#fff" stroke="#000" stroke-width=".9"/>`).join('');
  const H = y + 30;
  const frame = `<rect x="6" y="12" width="${W - 12}" height="${H - 20}" fill="none" stroke="#555" stroke-width=".8"/><rect x="${W / 2 - 60}" y="4" width="120" height="16" fill="#fff"/>` +
    T(W / 2, 16, 'Loss diagram', `${MID} font-size="12" ${B}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="#000">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${frame}${trunk}${g}</svg>`;
}
