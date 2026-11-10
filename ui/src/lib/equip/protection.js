// Protection coordination of the plant network: the overcurrent devices of the main breakers with inverse-time curves (IEC 60255-151),
// settings suggested from the load and fault currents, the grading margin between upstream and downstream devices, and the
// short-circuit duty of the breakers and the cables. Plain functions, no browser; the fault currents come from fault.js. The
// time-current chart is SVG text built here (every text through `esc`), shown on the page and in the report.
import { fmtNum } from '../format.js';
import { findIn } from './library.js';
import { faultStudy, mFactor } from './fault.js';
import { esc } from './sld.js';

const SQ3 = Math.sqrt(3);
export const CURVES = {
  SI: { label: 'IEC standard inverse', k: 0.14, a: 0.02 }, VI: { label: 'IEC very inverse', k: 13.5, a: 1 },
  EI: { label: 'IEC extremely inverse', k: 80, a: 2 }, LTI: { label: 'IEC long-time inverse', k: 120, a: 1 },
};
export const T_BREAKER = 0.05, T_INST = 0.05;            // s: breaker opening, instantaneous element
export const TMS_MIN = 0.05, TMS_STEP = 0.025, TMS_MAX = 1.2;
const M_MAX = 20;                                         // the curves are flat beyond 20 × pickup (IEC 60255-151)
const K_ADIABATIC = { Cu: 143, Al: 94 };                  // A·√s/mm², XLPE 90 → 250 °C (IEC 60949)

// The devices: the feeder breakers of the MV switchboard and the LV breakers of the stations. `bus`: where the breaker sits (its
// duty), `zone`: the far end of what it protects (its sensitivity), `circuit`: the cable it protects.
export const DEVICES = [
  { key: 'load', name: 'Load feeder', bus: ['mv'], zone: 'load_end', circuit: 'load' },
  { key: 'grid', name: 'Utility incomer', bus: ['mv'], zone: 'mv' },
  { key: 'mv_pv', name: 'PV feeder', bus: ['mv'], zone: 'pv_end', circuit: 'mv_pv' },
  { key: 'lv_pv', name: 'PV transformer LV incomer', bus: ['pv_lv'], zone: 'pv_inv' },
  { key: 'mv_bess', name: 'BESS feeder', bus: ['mv'], zone: 'bess_mv', circuit: 'mv_bess' },
  { key: 'lv_bess', name: 'BESS PCS breaker', bus: ['bess_lv', 'bess_pcs'], zone: 'bess_pcs', circuit: 'lv_bess' },
  { key: 'mv_gen', name: 'Genset feeder', bus: ['mv'], zone: 'gen_mv', circuit: 'mv_gen' },
  { key: 'lv_gen', name: 'Genset breaker', bus: ['gen_lv', 'gen_term'], zone: 'gen_lv', circuit: 'lv_gen' },
];
// [downstream, upstream, fault bus, case]: the downstream device must clear the fault before the upstream one. Bus 'head': a fault
// on the downstream MV feeder just past its breaker (fed by every other branch of the MV bus)
export const PAIRS = [
  ['load', 'mv_gen', 'head', 'Fault on the load feeder'], ['load', 'mv_bess', 'head', 'Fault on the load feeder'],
  ['load', 'mv_pv', 'head', 'Fault on the load feeder'], ['load', 'grid', 'head', 'Fault on the load feeder'],
  ['mv_gen', 'lv_gen', 'mv', 'Fault on the MV bus'], ['lv_pv', 'mv_pv', 'pv_inv', 'Fault on an inverter cable'],
  ['lv_bess', 'mv_bess', 'bess_pcs', 'Fault on a PCS cable'],
];
// the cables checked for their short-time withstand: the buses at both ends and the device that clears them
const CABLES = { lv_pv: ['pv_lv', 'pv_inv', 'lv_pv'], mv_pv: ['mv', 'pv_end', 'mv_pv'], lv_bess: ['bess_lv', 'bess_pcs', 'lv_bess'],
  mv_bess: ['mv', 'bess_mv', 'mv_bess'], lv_gen: ['gen_lv', 'gen_term', 'lv_gen'], mv_gen: ['mv', 'gen_mv', 'mv_gen'], load: ['mv', 'load_end', 'load'] };

// The relay operating time (s) of device settings d at current I (A), Infinity when it does not operate
export function tripTime(d, I) {
  if (!(I > d.pickup)) return Infinity;
  if (d.inst > 0 && I >= d.inst) return T_INST;
  const c = CURVES[d.curve] || CURVES.SI, M = Math.min(I / d.pickup, M_MAX);
  return d.tms * c.k / (Math.pow(M, c.a) - 1);
}
// the smallest time multiplier that gives time t at current I
export const tmsFor = (d, I, t) => { const c = CURVES[d.curve] || CURVES.SI, M = Math.min(I / d.pickup, M_MAX); return t * (Math.pow(M, c.a) - 1) / c.k; };
const ceilStep = (x, s) => Math.ceil(x / s - 1e-9) * s;
// a pickup rounded up to a step a relay or trip unit offers
export const roundPickup = (I) => { const s = I < 50 ? 1 : I < 200 ? 5 : I < 1000 ? 10 : 50; return ceilStep(I, s); };

// The breaker of a device: the chosen datasheet, or the smallest of the library for the voltage that carries the current and meets
// the fault duty
export function pickBreaker(lib, kv, In, duty) {
  const mv = kv > 1;
  const ok = (lib || []).filter((b) => b.ur_kv >= kv - 1e-9 && (mv ? b.ur_kv > 1 : b.ur_kv <= 1.000001));
  const fits = ok.filter((b) => b.ir >= In).sort((a, b) => a.ir - b.ir || a.icu_ka - b.icu_ka);
  const strong = fits.find((b) => b.icu_ka >= (mv ? duty.ib : duty.ik3) && (!(b.icm_ka > 0) || b.icm_ka >= duty.ip));
  return strong || fits[fits.length - 1] || ok.sort((a, b) => b.ir - a.ir)[0] || null;
}

// The protection study of design D: fault levels, device settings, grading, breaker and cable duty, warnings.
export function protectionStudy(P, D) {
  const E = P.electrical, lib = P.equipment.lib, F = faultStudy(P, D), warn = [];
  const margin = E.grading_s > 0 ? E.grading_s : 0.3, tMax = E.sc_t_max > 0 ? E.sc_t_max : 1;
  const bus = Object.fromEntries(F.buses.map((b) => [b.id, b]));
  const circ = (k) => D.circuits.find((c) => c.key === k);
  // the current through device k for a fault at bus id. 'head': a fault on an MV feeder just past its breaker, which carries what
  // every other branch feeds into the MV bus (the bus current less the feeder's own share); for any other device the bus fault
  const own = (k, id, s) => { const d = F.dev[k], c = d && d.cur[id]; return c ? c[s] : 0; };
  const cur = (k, id, s = 'max') => {
    if (id !== 'head') return own(k, id, s);
    const mvAll = bus.mv && bus.mv[s] ? bus.mv[s].ik3 * 1000 : 0;
    return F.dev[k] && F.dev[k].kv > 1 ? Math.max(0, mvAll - own(k, 'mv', s)) : own(k, 'mv', s);
  };
  const faults = ['head', ...F.buses.map((b) => b.id)];
  const upAt = (b) => (b === 'head' ? 'mv' : b);   // the upstream device of a feeder fault carries its own branch's share
  const trPV = findIn(lib, 'transformer', E.trafo_pv);
  const ov = E.prot || {};
  /** @type {Record<string, any>} */
  const dev = {};
  for (const x of DEVICES) {
    if (!F.dev[x.key] || (x.key === 'grid' && !(E.grid_mva > 0))) continue;
    const c = x.circuit ? circ(x.circuit) : null, kv = F.dev[x.key].kv;
    // the utility incomer carries the larger of the import to the load and the export of the plant's feeders
    const exportI = ['mv_pv', 'mv_bess', 'mv_gen'].reduce((a, k) => a + (circ(k) ? circ(k).I * circ(k).count : 0), 0);
    const In = x.key === 'lv_pv' ? (trPV ? trPV.kva / (SQ3 * kv) : 0) : x.key === 'grid' ? Math.max(circ('load') ? circ('load').I : 0, exportI) : c ? c.I : 0;
    if (!(In > 0)) continue;   // nothing to carry, nothing to set
    const duty = { ik3: 0, ip: 0, ib: 0, kappa: 1 };
    for (const b of x.bus) if (bus[b] && bus[b].max) for (const k of ['ik3', 'ip', 'ib', 'kappa']) duty[k] = Math.max(duty[k], bus[b].max[k]);
    const o = ov[x.key] || {};
    const sug = { curve: 'SI', pickup: roundPickup(1.25 * In), tms: TMS_MIN, inst: null };
    dev[x.key] = { ...x, kv, In, Iz: c && c.amp ? c.amp : null, duty, sug, o };
  }
  // instantaneous elements of the transformer feeders: above the LV through-fault (× 1.3), and only if below the MV-end fault
  const instOf = (k, lvBus, mvBus) => {
    const d = dev[k];
    if (!d) return;
    const through = cur(k, lvBus, 'max'), mvMin = cur(k, mvBus, 'min') * SQ3 / 2;
    const i = roundPickup(1.3 * through);
    if (through > 0 && i < 0.8 * mvMin) d.sug.inst = i;
  };
  instOf('mv_pv', 'pv_lv', 'pv_end'); instOf('mv_bess', 'bess_lv', 'bess_mv');
  if (findIn(lib, 'transformer', E.trafo_load)) instOf('load', 'load_lv', 'load_end');
  const num = (v) => typeof v === 'number' && isFinite(v);
  const eff = (d) => ({ curve: CURVES[d.o.curve] ? d.o.curve : d.sug.curve, pickup: num(d.o.pickup) && d.o.pickup > 0 ? d.o.pickup : d.sug.pickup,
    tms: num(d.o.tms) && d.o.tms > 0 ? d.o.tms : d.sug.tms, inst: num(d.o.inst) ? (d.o.inst > 0 ? d.o.inst : null) : d.sug.inst });

  // time multipliers: from the downstream devices up, the smallest step that keeps the grading margin
  const short = new Set();
  for (let pass = 0, changed = true; changed && pass < 20; pass++) {
    changed = false;
    for (const [dk, uk, b] of PAIRS) {
      const d = dev[dk], u = dev[uk];
      if (!d || !u) continue;
      const td = tripTime(eff(d), cur(dk, b)), Iu = cur(uk, upAt(b)), su = eff(u);
      if (!isFinite(td) || !(Iu > su.pickup)) continue;
      const need = tmsFor(su, Iu, td + margin);
      if (need > TMS_MAX) short.add(uk);
      const t = Math.min(TMS_MAX, Math.max(TMS_MIN, ceilStep(need, TMS_STEP)));
      if (t > u.sug.tms + 1e-9) { u.sug.tms = +t.toFixed(3); changed = true; }
    }
  }
  for (const d of Object.values(dev)) {
    d.set = eff(d);
    // a trip unit is set at most to its breaker's rating: the breaker carries the pickup as well as the load
    d.brk = (E.breaker && findIn(lib, 'breaker', E.breaker[d.key])) || pickBreaker(lib.breaker, d.kv, Math.max(d.In, d.set.pickup), d.duty);
    d.auto = !(E.breaker && findIn(lib, 'breaker', E.breaker[d.key]));
  }
  const name = (k) => dev[k].name;

  // grading
  const grading = [];
  for (const [dk, uk, b, label] of PAIRS) {
    const d = dev[dk], u = dev[uk];
    if (!d || !u || !bus[upAt(b)]) continue;
    const Id = cur(dk, b), Iu = cur(uk, upAt(b)), td = tripTime(d.set, Id), tu = tripTime(u.set, Iu);
    const ok = isFinite(td) && (!isFinite(tu) || tu - td >= margin - 1e-6);
    const r = { down: dk, up: uk, bus: b, label, Id, Iu, td, tu, margin: isFinite(tu) && isFinite(td) ? tu - td : null, ok };
    grading.push(r);
    if (!isFinite(td) && !isFinite(tu)) warn.push(`${label}: neither the ${name(dk).toLowerCase()} nor the ${name(uk).toLowerCase()} sees the fault; no overcurrent device clears it.`);
    else if (!isFinite(td)) warn.push(`${label}: the ${name(dk).toLowerCase()} does not see ${fmtNum(Id, 0)} A, so the ${name(uk).toLowerCase()} trips first.`);
    else if (!ok) warn.push(`${label}: grading margin ${fmtNum(tu - td, 2)} s between the ${name(dk).toLowerCase()} and the ${name(uk).toLowerCase()} is below ${margin} s.`);
  }
  for (const k of short) if (dev[k]) warn.push(`${name(k)}: the time multiplier needed for grading exceeds ${TMS_MAX}. Use a lower pickup, another curve or a definite-time stage.`);

  // device checks: setting against load and cable, sensitivity, breaker duty
  for (const d of Object.values(dev)) {
    const s = d.set, nm = d.name;
    d.minFault = cur(d.key, d.zone, 'min') * SQ3 / 2;                 // two-phase fault at the end of the zone, fewest sources
    d.maxFault = Math.max(0, ...faults.map((b) => cur(d.key, b, 'max')));   // the largest current it carries for any fault
    if (s.pickup < 1.05 * d.In) warn.push(`${nm}: pickup ${fmtNum(s.pickup, 0)} A is below 1.05 × the full-load current ${fmtNum(d.In, 0)} A; it would trip on load.`);
    if (d.brk && s.pickup > d.brk.ir) warn.push(`${nm}: pickup ${fmtNum(s.pickup, 0)} A is above the rated current ${fmtNum(d.brk.ir)} A of ${d.brk.name}.`);
    if (d.Iz && s.pickup > d.Iz) warn.push(`${nm}: pickup ${fmtNum(s.pickup, 0)} A is above the cable rating ${fmtNum(d.Iz, 0)} A, so the cable has no overload protection.`);
    if (d.minFault > 0 && d.minFault < 1.5 * s.pickup)
      warn.push(`${nm}: the smallest fault at the end of its zone (${fmtNum(d.minFault, 0)} A, two-phase, ${F.online || 0} genset(s) online) is below 1.5 × pickup. ${/gen/.test(d.key) ? 'Use voltage-restrained overcurrent (51V) for the gensets.' : 'Lower the pickup or add undervoltage protection.'}`);
    const b = d.brk, du = d.duty, mv = d.kv > 1;
    d.chk = [];
    if (!b) { warn.push(`${nm}: no circuit breaker in the library for ${fmtNum(d.kv * 1000, 0)} V.`); continue; }
    const clear = (I) => { const tr = tripTime(s, I); return (isFinite(tr) ? tr : tMax) + T_BREAKER; };
    d.tClear = clear(d.maxFault);
    // the heaviest I²t the breaker carries: every fault, its current through the device for the time the device takes to clear it
    let i2t = 0;
    for (const f of faults) {
      const I = cur(d.key, f), t = clear(I), ith = I / 1000 * Math.sqrt(mFactor(du.kappa, t) + 1);
      if (I > 0 && ith * ith * t > i2t) { i2t = ith * ith * t; d.ith = ith; d.tI2t = t; }
    }
    const fail = (what) => { d.chk.push(what); warn.push(`${nm}: ${b.name} ${what}.`); };
    if (b.ir < d.In) fail(`is rated ${fmtNum(b.ir)} A, below the full-load current ${fmtNum(d.In, 0)} A`);
    if (b.ur_kv < d.kv) fail(`is rated ${b.ur_kv} kV, below the system voltage`);
    if (b.icu_ka < (mv ? du.ib : du.ik3)) fail(`breaks ${b.icu_ka} kA, below the ${mv ? 'breaking current Ib' : 'prospective current Ik″'} ${fmtNum(mv ? du.ib : du.ik3, 1)} kA`);
    if (b.icm_ka > 0 && b.icm_ka < du.ip) fail(`makes ${b.icm_ka} kA peak, below the peak current ip ${fmtNum(du.ip, 1)} kA`);
    if (b.icw_ka > 0 && b.tk > 0 && b.icw_ka * b.icw_ka * b.tk < i2t) fail(`withstands ${b.icw_ka} kA for ${b.tk} s, less than ${fmtNum(d.ith, 1)} kA for ${fmtNum(d.tI2t, 2)} s`);
  }

  // cable short-time withstand (adiabatic, XLPE): the fault level at either end for the clearing time of its device
  const cables = [];
  for (const [key, [a, z, dk]] of Object.entries(CABLES)) {
    const c = circ(key), d = dev[dk];
    if (!c || !c.cab || !bus[a] || !bus[z]) continue;
    const ends = [bus[a].max, bus[z].max].filter(Boolean), worst = ends.reduce((m, x) => (x.ik3 > m.ik3 ? x : m));
    const tr = d ? tripTime(d.set, cur(dk, z)) : Infinity;
    const t = (isFinite(tr) ? tr : tMax) + T_BREAKER;
    const ith = worst.ik3 * Math.sqrt(mFactor(worst.kappa, t) + 1);
    const k = /al/i.test(c.cab.material || '') ? K_ADIABATIC.Al : K_ADIABATIC.Cu;
    const adm = k * c.cab.csa * c.runs / Math.sqrt(t) / 1000;            // kA
    const r = { key, name: c.name, cab: c.cab, runs: c.runs, ik: worst.ik3, ith, t, adm, sMin: ith * 1000 * Math.sqrt(t) / k / c.runs, ok: ith <= adm, cleared: isFinite(tr) };
    cables.push(r);
    if (!r.ok) warn.push(`${c.name}: ${fmtNum(ith, 1)} kA for ${fmtNum(t, 2)} s exceeds the short-time withstand of ${c.runs > 1 ? c.runs + ' × ' : ''}${c.cab.csa} mm² (${fmtNum(adm, 1)} kA); at least ${fmtNum(r.sMin, 0)} mm² per run is needed.`);
  }
  return { F, dev, grading, cables, warn, margin, tMax, notes: F.notes };
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
  const devs = Object.values(PR.dev);
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
  for (const d of Object.values(PR.dev)) for (const m of [1.1, 1.5, 2, 3, 5, 10, 20]) rows.push([d.name, m, d.set.pickup * m, tripTime(d.set, d.set.pickup * m)]);
  return rows;
}
