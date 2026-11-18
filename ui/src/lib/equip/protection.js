// The time-current chart of the protection study the engine computes (engine/src/electrical/protection.rs): every device's
// curve, log-log, as SVG text (every text through `esc`), shown on the page and in the report, and the curve table of the workbook.
import { fmtNum } from '../format.js';
import { esc } from './sld.js';

export const CURVES = {
  SI: { label: 'IEC standard inverse', k: 0.14, a: 0.02 }, VI: { label: 'IEC very inverse', k: 13.5, a: 1 },
  EI: { label: 'IEC extremely inverse', k: 80, a: 2 }, LTI: { label: 'IEC long-time inverse', k: 120, a: 1 },
};
const T_INST = 0.05;                                      // s: the instantaneous element
const M_MAX = 20;                                         // the curves are flat beyond 20 × pickup (IEC 60255-151)
// the devices in switchboard order
const ORDER = ['load', 'grid', 'mv_pv', 'lv_pv', 'mv_bess', 'lv_bess', 'mv_gen', 'lv_gen'];
// The devices of a protection study in switchboard order (the engine's JSON keeps its objects sorted by key)
export const devicesOf = (PR) => ORDER.map((k) => PR.dev[k]).filter(Boolean);

// The relay operating time (s) of device settings d at current I (A), Infinity when it does not operate
export function tripTime(d, I) {
  if (!(I > d.pickup)) return Infinity;
  if (d.inst > 0 && I >= d.inst) return T_INST;
  const c = CURVES[d.curve] || CURVES.SI, M = Math.min(I / d.pickup, M_MAX);
  return d.tms * c.k / (Math.pow(M, c.a) - 1);
}

// ---------------------------------------------------------------- time-current chart
export const TCC_W = 1000, TCC_H = 540;
const COLORS = ['#1f5fbf', '#c0392b', '#1e8449', '#b9770e', '#7d3c98', '#117a8b', '#6e2c00', '#566573'];

// The points of a device's curve: [I (A at the device voltage), t (s)] from just above pickup to Imax
export function curvePoints(s, Imax) {
  const pts = [], top = Math.max(Imax, s.pickup * 1.2);
  for (let i = 0; i <= 80; i++) {
    const I = s.pickup * Math.pow(top / s.pickup, i / 80) * (i ? 1 : 1.02);
    if (s.inst > 0 && I >= s.inst) { pts.push([s.inst, tripTime({ ...s, inst: null }, s.inst)], [s.inst, T_INST], [top, T_INST]); break; }
    pts.push([I, tripTime(s, I)]);
  }
  return pts;
}

// The coordination chart of study PR as SVG text: every device's curve with currents referred to the MV voltage, log-log, the MV bus
// fault level and the operating points of the grading checks
export function buildTcc(PR, mvKv) {
  const devs = devicesOf(PR);
  const W = TCC_W, H = TCC_H, x0 = 70, x1 = 650, y0 = 20, y1 = H - 50;
  const ref = (d) => d.kv / mvKv;                                   // A at the device → A at MV
  const mvBus = PR.F.buses.find((b) => b.id === 'mv');
  const hiI = Math.max(10, ...devs.map((d) => Math.max(d.maxFault, d.set.pickup * 20) * ref(d)), mvBus && mvBus.max ? mvBus.max.ik3 * 1000 * 1.5 : 0);
  const loI = Math.min(...devs.map((d) => d.set.pickup * ref(d)), hiI / 10);
  const dx0 = Math.floor(Math.log10(loI * 0.8)), dx1 = Math.ceil(Math.log10(hiI)), dy0 = -2, dy1 = 3;
  const X = (I) => x0 + (Math.log10(I) - dx0) / (dx1 - dx0) * (x1 - x0), Y = (t) => y1 - (Math.log10(t) - dy0) / (dy1 - dy0) * (y1 - y0);
  const clipT = (t) => Math.min(Math.max(t, 10 ** dy0), 10 ** dy1);
  let g = `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  // grid: decades and the 2 and 5 in between
  for (let d = dx0; d <= dx1; d++) for (const m of d < dx1 ? [1, 2, 5] : [1]) {
    const x = X(m * 10 ** d);
    g += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${m === 1 ? '#bbb' : '#e3e3e3'}" stroke-width="1"/>`;
    if (m === 1) g += `<text x="${x}" y="${y1 + 16}" font-size="11" text-anchor="middle" fill="#333">${esc(fmtNum(10 ** d, d < 0 ? -d : 0))}</text>`;
  }
  for (let d = dy0; d <= dy1; d++) for (const m of d < dy1 ? [1, 2, 5] : [1]) {
    const y = Y(m * 10 ** d);
    g += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${m === 1 ? '#bbb' : '#e3e3e3'}" stroke-width="1"/>`;
    if (m === 1) g += `<text x="${x0 - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="#333">${esc(fmtNum(10 ** d, d < 0 ? -d : 0))}</text>`;
  }
  g += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#333" stroke-width="1.2"/>`;
  g += `<text x="${(x0 + x1) / 2}" y="${H - 12}" font-size="12" text-anchor="middle" fill="#111">${esc(`Current (A referred to ${mvKv} kV)`)}</text>`;
  g += `<text x="18" y="${(y0 + y1) / 2}" font-size="12" text-anchor="middle" fill="#111" transform="rotate(-90 18 ${(y0 + y1) / 2})">Time (s)</text>`;
  if (mvBus && mvBus.max) {
    const x = X(mvBus.max.ik3 * 1000);
    g += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="#111" stroke-width="1.2" stroke-dasharray="6 4"/>`;
    g += `<text x="${x - 4}" y="${y0 + 14}" font-size="10" text-anchor="end" fill="#111">${esc(`Ik″ MV bus ${fmtNum(mvBus.max.ik3, 2)} kA`)}</text>`;
  }
  devs.forEach((d, i) => {
    const col = COLORS[i % COLORS.length], k = ref(d), hi = 10 ** dx1 / k;
    const pts = curvePoints(d.set, hi).filter(([, t]) => isFinite(t)).map(([I, t]) => `${X(I * k).toFixed(1)},${Y(clipT(t)).toFixed(1)}`);
    g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
    const ly = y0 + 10 + i * 34;
    g += `<line x1="${x1 + 18}" y1="${ly}" x2="${x1 + 40}" y2="${ly}" stroke="${col}" stroke-width="3"/>`;
    g += `<text x="${x1 + 46}" y="${ly + 4}" font-size="11" fill="#111">${esc(d.name)}</text>`;
    g += `<text x="${x1 + 46}" y="${ly + 18}" font-size="10" fill="#444">${esc(`${d.set.curve} Is ${fmtNum(d.set.pickup, 0)} A TMS ${d.set.tms}${d.set.inst ? ` I>> ${fmtNum(d.set.inst, 0)} A` : ''} @ ${fmtNum(d.kv * 1000, 0)} V`)}</text>`;
  });
  // the operating points of the grading checks
  for (const r of PR.grading) for (const [k, I, t] of [[r.down, r.Id, r.td], [r.up, r.Iu, r.tu]]) {
    if (!isFinite(t) || !(I > 0)) continue;
    const d = PR.dev[k];
    g += `<circle cx="${X(I * ref(d)).toFixed(1)}" cy="${Y(clipT(t)).toFixed(1)}" r="3.5" fill="#fff" stroke="${r.ok ? '#111' : '#c0392b'}" stroke-width="1.6"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif">${g}</svg>`;
}

// The curve of every device at fixed multiples of its pickup, for the workbook: rows of [device, multiple, I A, t s]
export function curveTable(PR) {
  const rows = [];
  for (const d of devicesOf(PR)) for (const m of [1.1, 1.5, 2, 3, 5, 10, 20]) rows.push([d.name, m, d.set.pickup * m, tripTime(d.set, d.set.pickup * m)]);
  return rows;
}
