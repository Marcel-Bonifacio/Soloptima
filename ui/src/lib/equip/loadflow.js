// Radial AC load flow (backward/forward sweep) of the electrical design over the hourly dispatch of year 1. Plain functions, no
// browser. The network is built per unit (S_base = 1 MVA) from the design; identical parallel items are lumped (Z / n).
import { HOURS, sum, dateOfHour } from '../series.js';
import { findIn, selectedIn } from './library.js';
import { rHot } from './design.js';
import { maxOf } from '../ws/util.js';

// complex numbers as [re, im]
export const cx = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]], sub: (a, b) => [a[0] - b[0], a[1] - b[1]], mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; },
  conj: (a) => [a[0], -a[1]], abs: (a) => Math.hypot(a[0], a[1]),
};

// depth-first order so that parents come before children
function topo(nodes) {
  const children = nodes.map(() => []);
  nodes.forEach((nd, i) => { if (nd.parent >= 0) children[nd.parent].push(i); });
  const order = [], st = [0];
  while (st.length) { const i = st.pop(); order.push(i); children[i].forEach((c) => st.push(c)); }
  return order;
}

// The per-unit network of the design D of project P: { nodes, nFeed, Sb, order }
export function network(P, D) {
  const E = P.electrical, Sb = 1000, lib = P.equipment.lib;   // kVA
  const nodes = [{ name: 'MV main bus', parent: -1, z: [0, 0], kind: 'mv' }];
  const add = (name, parent, z, kind, inj) => { nodes.push({ name, parent, z, kind, inj }); return nodes.length - 1; };
  const cabZ = (key, Vll) => {
    const c = D.circuits.find((k) => k.key === key);
    if (!c || !c.cab) return [0, 0];
    const zb = (Vll * Vll) / (Sb * 1000);
    const R = rHot(c.cab) * c.L / c.runs, X = (c.cab.x || 0) / 1000 * c.L / c.runs;
    return [R / zb, X / zb];
  };
  const trZ = (t, n) => {
    const r = t.pk / t.kva, zt = t.z / 100, x = Math.sqrt(Math.max(0, zt * zt - r * r));
    return [r * Sb / t.kva / n, x * Sb / t.kva / n];
  };
  const scale = (z, k) => [z[0] * k, z[1] * k];
  const Vmv = E.mv_kv * 1000;
  // PV: one representative feeder with its transformers along it; results scaled by the number of feeders
  const pvF = D.circuits.find((c) => c.key === 'mv_pv');
  const nFeed = pvF ? pvF.count : 1;
  const trPV = findIn(lib, 'transformer', E.trafo_pv);
  if (D.str && trPV && D.nTrPV) {
    const per = Math.max(1, Math.round(D.nTrPV / nFeed));
    const zFeed = cabZ('mv_pv', Vmv);
    const zLv = scale(cabZ('lv_pv', D.str.inv.vac), 1 / D.invPerTr);
    let prev = 0;
    for (let k = 0; k < per; k++) {
      const mv = add(`PV feeder node ${k + 1}`, prev, scale(zFeed, 1 / per), 'mv');
      const lv = add(`PV transformer ${k + 1} LV`, mv, trZ(trPV, 1), 'lv');
      add(`PV inverters ${k + 1} (×${D.invPerTr})`, lv, zLv, 'lv', { type: 'pv', share: 1 / (per * nFeed) });
      prev = mv;
    }
  }
  const trB = findIn(lib, 'transformer', E.trafo_bess);
  if (P.bess.energy_kwh > 0 && trB && D.nTrB) {
    const mv = add('BESS MV node', 0, cabZ('mv_bess', Vmv), 'mv');
    const lv = add('BESS transformer LV', mv, trZ(trB, D.nTrB), 'lv');
    const bat = selectedIn(P, 'battery');
    add(`BESS PCS (×${D.nB})`, lv, scale(cabZ('lv_bess', bat ? bat.vac : 690), 1 / D.nB), 'lv', { type: 'bess' });
  }
  const trG = findIn(lib, 'transformer', E.trafo_gen), dg = selectedIn(P, 'genset');
  if (D.nG > 0) {
    const nGrp = E.gen_mv ? D.nG : D.nTrG;
    const mv = add('Genset MV node', 0, scale(cabZ('mv_gen', Vmv), 1 / Math.max(1, nGrp)), 'mv');
    if (!E.gen_mv && trG) {
      const lv = add('Genset transformer LV', mv, trZ(trG, D.nTrG), 'lv');
      add(`Genset terminals (×${D.nG})`, lv, scale(cabZ('lv_gen', dg ? dg.voltage : 400), 1 / D.nG), 'lv', { type: 'gen' });
    } else nodes[mv].inj = { type: 'gen' };
  }
  const trL = findIn(lib, 'transformer', E.trafo_load);
  const lm = add('Load feeder end', 0, cabZ('load', Vmv), 'mv', trL ? null : { type: 'load' });
  if (trL) { const n = Math.ceil(maxOf(P.load.kw) / E.pf_load / trL.kva); add('Load LV bus', lm, trZ(trL, n), 'lv', { type: 'load' }); }
  return { nodes, nFeed, Sb, order: topo(nodes) };
}

// S: complex power drawn at each node (pu, load convention). Returns the voltages and the branch losses.
export function sweep(nodes, order, S) {
  const n = nodes.length;
  const V = nodes.map(() => [1, 0]);
  let Ib;
  for (let it = 0; it < 30; it++) {
    const Ii = S.map((s, i) => cx.conj(cx.div(s, V[i])));
    Ib = nodes.map(() => [0, 0]);
    for (let k = order.length - 1; k >= 0; k--) {        // backward: accumulate branch currents
      const i = order[k];
      Ib[i] = cx.add(Ib[i], Ii[i]);
      if (nodes[i].parent > 0) Ib[nodes[i].parent] = cx.add(Ib[nodes[i].parent], Ib[i]);
    }
    let dmax = 0;
    for (const i of order) {                              // forward: voltage drops from the slack
      if (i === 0) continue;
      const nv = cx.sub(V[nodes[i].parent], cx.mul(nodes[i].z, Ib[i]));
      dmax = Math.max(dmax, cx.abs(cx.sub(nv, V[i])));
      V[i] = nv;
    }
    if (dmax < 1e-7) break;
  }
  let loss = 0;
  for (let i = 1; i < n; i++) loss += nodes[i].z[0] * (Ib[i][0] ** 2 + Ib[i][1] ** 2);
  return { V, loss };
}

// What each node draws (load) or feeds (negative) in hour t
function inject(nodes, H, t, tanL, Sb) {
  const pvKw = H.pv_to_load[t] + H.pv_to_bess[t] + (H.wind_to_load ? H.wind_to_load[t] + H.wind_to_bess[t] : 0);
  const bessKw = H.bess_dis[t] - H.pv_to_bess[t] - H.gen_to_bess[t] - (H.wind_to_bess ? H.wind_to_bess[t] : 0);
  const genKw = H.gen_to_load[t] + H.gen_to_bess[t];
  const siteKw = H.load[t] - (H.aux ? H.aux[t] : 0);   // the load feeder carries the site load; plant auxiliaries are drawn at the plant
  return nodes.map((nd) => (!nd.inj ? [0, 0] : nd.inj.type === 'load' ? [siteKw / Sb, siteKw * tanL / Sb] : nd.inj.type === 'pv' ? [-pvKw * nd.inj.share / Sb, 0]
    : nd.inj.type === 'bess' ? [-bessKw / Sb, 0] : [-genKw / Sb, 0]));
}

const argmax = (a) => a.reduce((b, x, i) => (x > a[b] ? i : b), 0);

// The load flow of the whole year. Returns the numbers the screen shows: network losses, bus voltage range, violations, the hours
// worth looking at, and what the charts need.
export function runLoadFlow(P, D, SIM) {
  const H = SIM.result.hourly, net = network(P, D), nodes = net.nodes, Sb = net.Sb;
  const tanL = Math.tan(Math.acos(Math.min(1, P.electrical.pf_load)));
  const nh = H.load.length, vmin = new Array(nodes.length).fill(9), vmax = new Array(nodes.length).fill(0);
  const lossH = new Array(nh), vdH = new Array(nh), vEnd = new Array(nh);
  let viol = 0, lossTot = 0;
  const pvIdx = nodes.map((nd, i) => (nd.inj && nd.inj.type === 'pv' ? i : -1)).filter((i) => i >= 0);
  const endPV = pvIdx.length ? pvIdx[pvIdx.length - 1] : -1;
  const lims = nodes.map((nd) => (nd.kind === 'mv' ? [0.95, 1.05] : [0.9, 1.1]));
  for (let t = 0; t < nh; t++) {
    const S = inject(nodes, H, t, tanL, Sb);
    const r = sweep(nodes, net.order, S);
    // the PV feeder is modelled once: scale its losses by the number of identical feeders
    let lossKw = r.loss * Sb;
    if (net.nFeed > 1) {
      const pvOnly = sweep(nodes, net.order, S.map((s, i) => (nodes[i].inj && nodes[i].inj.type === 'pv' ? s : [0, 0])));
      lossKw += pvOnly.loss * Sb * (net.nFeed - 1);
    }
    lossH[t] = lossKw; lossTot += lossKw;
    let vd = 0;
    r.V.forEach((v, i) => {
      const m = cx.abs(v);
      vmin[i] = Math.min(vmin[i], m); vmax[i] = Math.max(vmax[i], m);
      vd += Math.abs(m - 1);
      if (m < lims[i][0] || m > lims[i][1]) viol++;
    });
    vdH[t] = vd;
    vEnd[t] = endPV >= 0 ? cx.abs(r.V[endPV]) : 1;
  }
  // the hour selector: the worst-case hours
  const hours = [['Peak PV hour', argmax(H.pv_avail)], ['Peak load hour', argmax(H.load)], ['Highest voltage deviation', argmax(vdH)], ['Highest network loss', argmax(lossH)]]
    .map(([k, h]) => ({ h, label: `${k}: ${dateOfHour(h)} ${String(h % 24).padStart(2, '0')}:00` }));
  const simple = D.loss ? D.loss.pv_ac + D.loss.bess + D.loss.gen + D.loss.load : null;
  return { net, tanL, vEnd, vmin, vmax, lims, viol, lossTot, hours, simple, loadTotal: sum(H.load), vdMean: sum(vdH) / nh, nh };
}

// The voltages of every bus in hour t: { names, kinds, vm }
export function busVoltages(LF, SIM, t) {
  const net = LF.net, r = sweep(net.nodes, net.order, inject(net.nodes, SIM.result.hourly, t, LF.tanL, net.Sb));
  return { names: net.nodes.map((n) => n.name), kinds: net.nodes.map((n) => n.kind), vm: r.V.map((v) => cx.abs(v)) };
}

// The week around hour t shown in the time chart: the first hour and the hour numbers
export function weekAround(t) {
  const s0 = Math.max(0, Math.min(t - 84, HOURS - 168));
  return Array.from({ length: 168 }, (_, i) => s0 + i);
}
