// The PV loss diagram as SVG text, in the usual engineering-report form: a framed box, a trunk from the horizontal irradiation
// down to the energy available, the totals in bold on the right with their value on the trunk, and each loss as a hook arrow
// off the trunk with its share of the step before (a large loss as a wide lobe, a gain arrowed in). The steps are the yield
// model's loss chain (engine/src/pv/profile.rs): irradiance in kWh/m², then energy in kWh/kWp, shown in MWh for the plant.
// Every text goes through `esc`; the page and the report show it as parsed elements (report/svg-node.js).
import { esc } from './equip/sld.js';

// the label of each step of the chain, and its role: a total (bold, its value on the trunk), the head of the irradiance losses
// (bold, with its loss), or the soiling step that ends the irradiance
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
  [/^After mismatch/, 'Module quality, LID, mismatch and wiring loss'],
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

// losses: [{ name, value, irradiance }] as the engine gives them; pv: the project's PV inputs (capacity, module size and power)
export function lossDiagram(losses, pv = {}) {
  if (!Array.isArray(losses) || losses.length < 2) return '';
  const kwp = +pv.capacity_kwp || 0, wp = +pv.module_wp || 0, a1 = (+pv.module_length || 0) * (+pv.module_width || 0);
  const area = wp > 0 && a1 > 0 ? kwp * 1000 / wp * a1 : 0, eff = a1 > 0 && wp > 0 ? wp / (a1 * 1000) : 0;
  const W = 560, xa = 80, xb = 225, cx = (xa + xb) / 2, xv = xa + 42, xp = 238, xl = 312, row = 16.5;
  const mpp = losses.some((s) => /^After MPP tracking/.test(s.name));
  const T = (x, y, t, o = '') => `<text x="${x}" y="${y}" ${o}>${esc(t)}</text>`;
  const B = 'font-weight="700"', MID = 'text-anchor="middle"', mwh = (s) => `${num(s.value * kwp / 1000, 1)} MWh`;
  let y = 48, g = '', top = 30;
  const sections = [];   // [top, bottom] of each section of the trunk
  // a loss leaves the trunk's right edge as a hook (a wide lobe when it is large); a gain comes in
  const hook = (yy, d) => {
    if (d > 5e-5) return `<path d="M${xb + 16} ${yy - 7} q-11 0 -14 8" fill="none" stroke="#000" stroke-width=".8"/><path d="M${xb + 2} ${yy + 4} l-1.5 -5 l4 2z"/>`;
    const k = Math.min(1, Math.abs(d) / 0.15), w = 5 + 26 * k, h = 5 + 20 * k;
    return `<path d="M${xb} ${yy - h} c${w * 0.15} 0 ${w} ${h * 0.35} ${w} ${h + 1}" fill="none" stroke="#000" stroke-width=".8"/><path d="M${xb + w - 2.5} ${yy + 1} l2.5 4 l2.5 -4z"/>`;
  };
  const total = (s, label) => { g += T(s.irradiance ? cx : xv, y, s.irradiance ? `${num(s.value, 0)} kWh/m²` : mwh(s), MID) + T(xl, y, label, B); y += row + 4; };
  losses.forEach((s, i) => {
    const [, label, kind] = stepOf(s.name), prev = losses[i - 1];
    if (prev && prev.irradiance && !s.irradiance) {   // irradiance becomes energy: close the first section, the conversion between
      y += 2;
      g += T(cx, y, `${num(prev.value, 0)} kWh/m²${area ? ` * ${num(area, 0)} m² coll.` : ''}`, MID) + T(xl, y, 'Effective irradiation on collectors', B);
      sections.push([top, y + 7]);
      y += 24;
      if (eff) g += T(xa - 6, y, `efficiency at STC = ${num(eff * 100, 2)}%`);
      g += T(xl, y, 'PV conversion');
      y += 30; top = y - 22;
    }
    if (kind === 'total') { total(s, label); return; }
    const d = prev && prev.irradiance === s.irradiance && prev.value ? s.value / prev.value - 1 : 0, big = Math.abs(d) >= 0.05 ? 16 : 0;
    y += big;
    g += hook(y - 3, d) + T(xp + (d < 0 ? 4 + 26 * Math.min(1, Math.abs(d) / 0.15) : 0) - 4, y, pct(d)) + T(xl, y, label, kind === 'head' ? B : '');
    y += row;
    // the totals inside the energy steps: the energy at the MPP and at the inverter output
    if (/^After MPP tracking/.test(s.name) || (!mpp && /^After mismatch/.test(s.name))) total(s, 'Array virtual energy at MPP');
    if (/^After inverter clipping/.test(s.name)) total(s, 'Available energy at inverter output');
  });
  const last = losses[losses.length - 1];
  if (!last.irradiance) { y += 2; total(last, 'Energy available at the plant bus'); }
  sections.push([top, y - 8]);
  // the trunk: each section a box with a notched top; the last ends in an arrowhead
  const trunk = sections.map(([t, b], k) => `<path d="M${xa} ${t} L${cx} ${t + 9} L${xb} ${t} L${xb} ${b}${k === sections.length - 1 ? ` L${cx} ${b + 14}` : ''} L${xa} ${b} Z" fill="#fff" stroke="#000" stroke-width=".9"/>`).join('');
  const H = y + 30;
  const frame = `<rect x="6" y="12" width="${W - 12}" height="${H - 20}" fill="none" stroke="#555" stroke-width=".8"/><rect x="${W / 2 - 60}" y="4" width="120" height="16" fill="#fff"/>` +
    T(W / 2, 16, 'Loss diagram', `${MID} font-size="12" ${B}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif" font-size="9.5" fill="#000">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${frame}${trunk}${g}</svg>`;
}
