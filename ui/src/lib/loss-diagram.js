// The PV loss diagram as SVG text: a funnel from the horizontal irradiation down to the energy available, the main totals on
// the trunk in bold, and each loss or gain as a branch with its share of the step before. The steps are the yield model's loss
// chain (engine/src/pv/profile.rs): irradiance in kWh/m², then energy in kWh/kWp, shown here in MWh for the plant's kWp. Every
// text goes through `esc`; the page and the report show it as parsed elements (report/svg-node.js).
import { esc } from './equip/sld.js';
import { fmtNum } from './format.js';

// the totals drawn on the trunk, with the name they get there
const TOTALS = [
  [/^Global horizontal/, 'Global horizontal irradiation'], [/^Global incident/, 'Global incident in the collector plane'],
  [/^Effective/, 'Effective irradiation on the collectors'], [/^Array nominal energy/, 'Array nominal energy (at STC efficiency)'],
  [/^After MPP tracking$/, 'Array energy at the MPP'], [/^After inverter clipping$/, 'Energy at the inverter output'],
  [/^After availability/, 'Energy available'],
];
// a loss step's name on its branch: "After temperature loss" reads "Temperature loss"
const RENAME = { 'Global incident in collector plane': 'Transposition to the collector plane', 'Effective irradiation (after soiling)': 'Soiling',
  'Effective incl. bifacial rear side': 'Bifacial rear side', 'After availability (energy available)': 'Availability' };
const lossName = (n) => { if (RENAME[n]) return RENAME[n]; const s = n.replace(/^After /, '').replace(/ \(.*\)$/, ''); return s[0].toUpperCase() + s.slice(1); };

// losses: [{ name, value, irradiance }] as the engine gives them; kwp: the plant's DC capacity
export function lossDiagram(losses, kwp) {
  if (!Array.isArray(losses) || losses.length < 2) return '';
  const mpp = losses.some((s) => s.name === 'After MPP tracking');
  const total = (s) => { const t = TOTALS.find(([re]) => /** @type {RegExp} */ (re).test(s.name)); return t ? String(t[1]) : !mpp && /^After mismatch/.test(s.name) ? 'Array energy at the MPP' : null; };
  const W = 660, x0 = 60, x1 = 220, xp = 330, xl = 345, row = 21, top = 34, first = losses.find((s) => !s.irradiance);
  const irr0 = losses[0].value || 1, en0 = first ? first.value || 1 : 1;
  const width = (s) => Math.max(0.25, Math.min(1, s.value / (s.irradiance ? irr0 : en0))) * (x1 - x0);   // the trunk narrows with the energy left
  const val = (s) => (s.irradiance ? `${fmtNum(s.value, 0)} kWh/m²` : `${fmtNum(s.value * kwp / 1000, 1)} MWh`);
  let y = top, g = '', trunk = [];
  const text = (x, yy, t, o = '') => `<text x="${x}" y="${yy}" ${o}>${esc(t)}</text>`;
  losses.forEach((s, i) => {
    const prev = losses[i - 1], name = total(s), cw = width(s), cx = (x0 + x1) / 2;
    if (prev && prev.irradiance && !s.irradiance) {   // irradiance becomes energy: the module efficiency at STC
      trunk.push([y, cw]); g += text(xl, y + 4, 'PV conversion at the module STC efficiency', 'font-size="11.5" fill="#333"'); y += row;
    }
    if (prev && prev.irradiance === s.irradiance) {   // the loss (or gain) of this step on its own row
      const d = prev.value ? s.value / prev.value - 1 : 0, bx = cx + cw / 2, yy = y - 4, col = Math.abs(d) < 5e-5 ? '#8a8a8a' : d > 0 ? '#1e8449' : '#c0392b';
      trunk.push([y, cw]);
      g += d > 5e-5 ? `<path d="M${bx + 34} ${yy - 6} Q${bx + 6} ${yy - 6} ${bx + 2} ${yy + 4}" fill="none" stroke="${col}" stroke-width="1.4" marker-end="url(#ahG)"/>`
                 : `<path d="M${bx} ${yy - 6} Q${bx + 6} ${yy + 4} ${bx + 34} ${yy + 4}" fill="none" stroke="${col}" stroke-width="1.4" marker-end="url(#${Math.abs(d) < 5e-5 ? 'ahN' : 'ahR'})"/>`;
      g += text(xp, yy + 8, `${d > 0 ? '+' : ''}${(d * 100).toFixed(2)} %`, `font-size="11" text-anchor="end" fill="${col}"`);
      g += text(xl, yy + 8, lossName(s.name), 'font-size="11.5" fill="#333"');
      y += row;
    }
    if (name) {
      trunk.push([y, cw]);
      g += text(cx, y + 4, val(s), 'font-size="12" text-anchor="middle" font-weight="600" fill="#111"');
      g += text(xl, y + 4, name, 'font-size="12" font-weight="700" fill="#111"');
      y += row + 6;
    }
  });
  // the trunk: its sides follow the energy left, ending in an arrow
  const cx = (x0 + x1) / 2, left = trunk.map(([yy, w]) => `${(cx - w / 2).toFixed(1)},${yy - 14}`), right = trunk.slice().reverse().map(([yy, w]) => `${(cx + w / 2).toFixed(1)},${yy - 14}`);
  const [ly, lw] = trunk[trunk.length - 1], tip = `${(cx - lw / 2).toFixed(1)},${ly + 6} ${cx},${ly + 20} ${(cx + lw / 2).toFixed(1)},${ly + 6}`;
  const body = `<polygon points="${left.join(' ')} ${tip} ${right.join(' ')}" fill="#eef4fb" stroke="#1f5fbf" stroke-width="1.2"/>`;
  const H = y + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">` +
    `<defs>${[['ahR', '#c0392b'], ['ahG', '#1e8449'], ['ahN', '#8a8a8a']].map(([id, c]) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('')}</defs>` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${text(W / 2, 20, 'Loss diagram (year 1)', 'font-size="14" font-weight="700" text-anchor="middle" fill="#111"')}${body}${g}</svg>`;
}
