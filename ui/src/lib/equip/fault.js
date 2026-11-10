// Short-circuit currents of the plant network by the IEC 60909-0 method (equivalent voltage source at the fault). Plain functions,
// no browser. The radial network of the design is built per unit (S_base = 1 MVA) twice: for the maximum currents (all sources,
// c_max, correction factors K_T and K_G, conductors at 20 °C) and for the minimum ones (the gensets always online and the battery,
// no PV, c_min, conductors at 80 °C). Gensets and the grid are voltage sources behind their impedance; PV inverters and battery
// PCS are current sources limited to a multiple of their rated current, added by magnitude (IEC 60909-0:2016, full converters).
// For every fault bus the tree is re-rooted at the fault: each node's admittance towards the sources gives the fault current, the
// current of every branch (for the protection) and each source's share. Earth faults use the zero-sequence network from the
// transformer vector groups and the MV earthing; node --test ui/tests/fault.test.js checks it against hand calculations.
import { findIn, selectedIn } from './library.js';
import { rAt } from './design.js';
import { maxOf } from '../ws/util.js';
import { cx } from './loadflow.js';

export const SB = 1;                                     // MVA
const SQ3 = Math.sqrt(3), F_HZ = 50;
export const C_FACTOR = { max: { mv: 1.1, lv: 1.05 }, min: { mv: 1.0, lv: 0.95 } };
export const TYPICAL = { xd2: 15, ifault: 1.2, xr: 8 };   // used when a datasheet leaves the value blank

// complex numbers as [re, im] (the load flow's)
const { add, sub, mul, div, abs } = cx, sc = (a, k) => [a[0] * k, a[1] * k];
const ONE = [1, 0], ZERO = [0, 0], TINY = 1e-12;
const inv = (a) => div(ONE, a);
const isZero = (a) => abs(a) < TINY;
const EPS_Z = [0, 1e-9];                                 // a branch without impedance (the grid supply point)

// IEC 60909-0 factors: peak (κ, method B with 1.15 for a meshed or multi-source network), the decay of a near generator for the
// breaking current (μ at a minimum time delay of 0.1 s) and the thermal effect of the DC component (m)
export const kappa = (rx) => 1.02 + 0.98 * Math.exp(-3 * rx);
export const kappaB = (rx, lv) => { const k = kappa(rx); return Math.max(k, Math.min(1.15 * k, lv ? 1.8 : 2.0)); };
export const mu = (r) => (r <= 2 ? 1 : Math.min(1, 0.62 + 0.72 * Math.exp(-0.32 * r)));
export function mFactor(k, Tk) {
  if (k <= 1 || !(Tk > 0)) return 0;
  const L = Math.log(k - 1);
  return Math.abs(L) < 1e-9 ? 2 : (Math.exp(4 * F_HZ * Tk * L) - 1) / (2 * F_HZ * Tk * L);
}

// The earthing of a transformer's windings from its vector group (Dyn11: HV delta, LV star earthed). Unknown text: an earthed LV star.
export function windings(vector) {
  const m = /^\s*(yn|y|d|zn|z)(yn|y|d|zn|z)/i.exec(vector || '');
  if (!m) return { hv: false, lv: true, guessed: true };
  return { hv: /n$/i.test(m[1]), lv: /n$/i.test(m[2]), guessed: false };
}

const lvl = (kv) => (kv > 1 ? 'mv' : 'lv');

// The network of design D for scenario 'max' or 'min': { nodes, notes }. A node holds its branch to the parent (z, zero sequence
// z0 or null for an open path), its source admittance (y, zero sequence y0), a current source J (pu), the gensets it holds, the bus
// id it is reported under (explicit items only) and the device on its branch.
export function faultNetwork(P, D, scen) {
  const max = scen === 'max', E = P.electrical, lib = P.equipment.lib, mvKv = E.mv_kv;
  const cOf = (kv) => C_FACTOR[scen][lvl(kv)], cmaxOf = (kv) => C_FACTOR.max[lvl(kv)];
  const theta = max ? 20 : 80;
  const nodes = [], notes = new Set();
  const addNode = (o) => { nodes.push({ z: ZERO, z0: null, y: ZERO, y0: ZERO, J: 0, gen: null, id: null, dev: null, ...o }); return nodes.length - 1; };
  // n identical branches under `parent`: the first on its own (its buses are reported), the other n − 1 as one equivalent
  const group = (parent, n, build) => { if (n >= 1) build(parent, 1, true); if (n > 1) build(parent, n - 1, false); };

  const cable = (key, kv, k = 1) => {
    const c = D.circuits.find((x) => x.key === key);
    if (!c || !c.cab || !(c.L > 0)) return { z: EPS_Z, z0: EPS_Z };
    const zb = kv * kv / SB;
    const z = [rAt(c.cab, theta) * c.L / c.runs / zb / k, (c.cab.x || 0) / 1000 * c.L / c.runs / zb / k];
    return { z: add(z, EPS_Z), z0: add(sc(z, 3), EPS_Z) };   // cable zero sequence taken as 3 × positive sequence
  };
  const trafo = (t, kvL) => {
    const zt = t.z / 100;
    const r = t.xr > 0 ? zt / Math.sqrt(1 + t.xr * t.xr) : t.pk > 0 ? t.pk / t.kva : zt / Math.sqrt(1 + TYPICAL.xr * TYPICAL.xr);
    const x = Math.sqrt(Math.max(0, zt * zt - r * r));
    const KT = max ? 0.95 * cmaxOf(kvL) / (1 + 0.6 * x) : 1;
    const w = windings(t.vector);
    if (w.guessed) notes.add(`Vector group of ${t.name} not recognised: an earthed LV star is assumed.`);
    return { z: sc([r, x], KT * SB * 1000 / t.kva), w };
  };
  // a transformer under `parent`, k in parallel: the zero sequence passes YNyn, an earthed star facing a delta earths its own side
  const addTrafo = (parent, T, k, o) => {
    const z = sc(T.z, 1 / k);
    const i = addNode({ ...o, parent, z, z0: T.w.hv && T.w.lv ? z : null });
    if (T.w.lv && !T.w.hv) nodes[i].y0 = add(nodes[i].y0, inv(z));
    if (T.w.hv && !T.w.lv) nodes[parent].y0 = add(nodes[parent].y0, inv(z));
    return i;
  };
  const genY = (g, kv, n) => {
    if (!(g.xd2 > 0)) notes.add(`Subtransient reactance X″d of ${g.name || 'the genset'} not given: ${TYPICAL.xd2} % assumed.`);
    const xd = (g.xd2 > 0 ? g.xd2 : TYPICAL.xd2) / 100, rg = (kv > 1 ? 0.07 : 0.15) * xd;
    const pf = Math.min(1, g.pf > 0 ? g.pf : 0.8), KG = max ? cmaxOf(kv) / (1 + xd * Math.sqrt(1 - pf * pf)) : 1;
    return sc(inv(sc([rg, xd], KG * SB * 1000 / g.kva)), n);
  };
  const ifault = (e, what) => {
    if (!(e && e.ifault > 0)) notes.add(`Fault current of the ${what} not given: ${TYPICAL.ifault} × rated assumed.`);
    return e && e.ifault > 0 ? e.ifault : TYPICAL.ifault;
  };

  const bus = addNode({ id: 'mv', name: 'MV main bus', kv: mvKv, parent: -1 });
  if (E.grid_mva > 0) {
    const xr = E.grid_xr > 0 ? E.grid_xr : 10, zq = cOf(mvKv) * SB / E.grid_mva;
    addNode({ id: 'grid', name: 'Utility supply point', kv: mvKv, parent: bus, z: EPS_Z, y: inv([zq / Math.sqrt(1 + xr * xr), zq * xr / Math.sqrt(1 + xr * xr)]), dev: 'grid' });
  }

  // PV: the feeders as chains of transformers; inverters are current sources (none at night, so none in the minimum case)
  const s = D.str, trPV = findIn(lib, 'transformer', E.trafo_pv);
  if (s && trPV && D.nTrPV) {
    const pvF = D.circuits.find((c) => c.key === 'mv_pv'), nFeed = pvF ? pvF.count : 1;
    const per = Math.max(1, Math.round(D.nTrPV / nFeed)), nI = Math.max(1, s.nInv / D.nTrPV), kvL = s.inv.vac / 1000;   // inverters per transformer
    const J = max ? ifault(s.inv, 'PV inverter') * s.inv.pac_kw / 1000 / SB : 0;
    const T = trafo(trPV, kvL);
    group(bus, nFeed, (parent, k, ex) => {
      let prev = parent;
      for (let i = 0; i < per; i++) {
        const fc = cable('mv_pv', mvKv, per * k);
        const mv = addNode({ parent: prev, kv: mvKv, z: fc.z, z0: fc.z0, id: ex && i === per - 1 ? 'pv_end' : null, name: 'PV feeder end', dev: ex && i === 0 ? 'mv_pv' : null });
        const first = ex && i === 0;
        const lv = addTrafo(mv, T, k, { kv: kvL, id: first ? 'pv_lv' : null, name: 'PV transformer LV (first on the feeder)', dev: first ? 'lv_pv' : null });
        const one = cable('lv_pv', kvL), rest = cable('lv_pv', kvL, first ? nI - 1 : nI * k);
        if (first) addNode({ parent: lv, kv: kvL, ...one, J, id: 'pv_inv', name: 'PV inverter terminals' });
        if (!first || nI > 1) addNode({ parent: lv, kv: kvL, ...rest, J: J * (first ? nI - 1 : nI * k) });
        prev = mv;
      }
    });
  }

  // battery: one MV feeder to its station, nTrB transformers there, the PCS on their LV sides (online in both cases)
  const bat = selectedIn(P, 'battery'), trB = findIn(lib, 'transformer', E.trafo_bess);
  if (P.bess.energy_kwh > 0 && P.bess.power_kw > 0 && trB && D.nTrB) {
    const kvL = (bat ? bat.vac : 690) / 1000, nB = Math.max(1, D.nB), per = Math.max(1, Math.round(nB / D.nTrB));
    const J = ifault(bat, 'battery PCS') * P.bess.power_kw / nB / 1000 / SB, T = trafo(trB, kvL);
    const mc = cable('mv_bess', mvKv);
    const mvb = addNode({ parent: bus, kv: mvKv, ...mc, id: 'bess_mv', name: 'BESS MV node', dev: 'mv_bess' });
    group(mvb, D.nTrB, (parent, k, ex) => {
      const lv = addTrafo(parent, T, k, { kv: kvL, id: ex ? 'bess_lv' : null, name: 'BESS transformer LV' });
      if (ex) addNode({ parent: lv, kv: kvL, ...cable('lv_bess', kvL), J, id: 'bess_pcs', name: 'BESS PCS terminals', dev: 'lv_bess' });
      if (!ex || per > 1) { const n = ex ? per - 1 : per * k; addNode({ parent: lv, kv: kvL, ...cable('lv_bess', kvL, n), J: J * n }); }
    });
  }

  // gensets: voltage sources behind X″d; all units in the maximum case, the units always online in the minimum one
  const nG = D.nG || 0, dg = selectedIn(P, 'genset'), trG = findIn(lib, 'transformer', E.trafo_gen);
  if (nG > 0) {
    const g = { ...(dg || {}), name: dg ? dg.name : 'the genset', kva: D.gKva };
    const atMv = E.gen_mv || !trG, kvG = atMv ? mvKv : (dg ? dg.voltage : 400) / 1000, gpt = atMv ? 1 : Math.max(1, D.gpt);
    const online = max ? nG : Math.min(nG, Math.max(1, P.diesel.min_units_online || 1));
    const T = atMv ? null : trafo(trG, kvG);
    // kT groups (transformers, or MV feeders) holding `units` gensets
    const genGroup = (kT, units, ex) => {
      const mc = cable('mv_gen', mvKv, kT);
      if (atMv) {
        const mv = addNode({ parent: bus, kv: mvKv, ...mc, y: genY(g, kvG, units), gen: { n: units, kva: g.kva }, id: ex ? 'gen_mv' : null, name: 'Genset terminals (MV)', dev: ex ? 'mv_gen' : null });
        return mv;
      }
      const mv = addNode({ parent: bus, kv: mvKv, ...mc, id: ex ? 'gen_mv' : null, name: 'Genset MV node', dev: ex ? 'mv_gen' : null });
      const lv = addTrafo(mv, T, kT, { kv: kvG, id: ex ? 'gen_lv' : null, name: 'Genset transformer LV' });
      if (ex) addNode({ parent: lv, kv: kvG, ...cable('lv_gen', kvG), y: genY(g, kvG, 1), gen: { n: 1, kva: g.kva }, id: 'gen_term', name: 'Genset terminals', dev: 'lv_gen' });
      const n = ex ? units - 1 : units;
      if (n > 0) addNode({ parent: lv, kv: kvG, ...cable('lv_gen', kvG, n), y: genY(g, kvG, n), gen: { n, kva: g.kva } });
      return mv;
    };
    const first = Math.min(online, gpt), rest = online - first;
    genGroup(1, first, true);
    if (rest > 0) genGroup(Math.ceil(rest / gpt), rest, false);
    notes.add('Genset neutrals are taken as not earthed; an earthed star on the genset side of its transformer earths that LV bus.');
  }

  // the plant load: a passive feeder (motor contribution not included)
  const peak = P.load.kw ? maxOf(P.load.kw) : 0, trL = findIn(lib, 'transformer', E.trafo_load);
  if (peak > 0) {
    const le = addNode({ parent: bus, kv: mvKv, ...cable('load', mvKv), id: 'load_end', name: 'Load feeder end', dev: 'load' });
    if (trL) addTrafo(le, trafo(trL, trL.lv_kv), 1, { kv: trL.lv_kv, id: 'load_lv', name: 'Load LV bus' });
  }

  // MV earthing: a neutral resistor (its current limit), solid (Z0 = Z1 at the bus, set by the study), or isolated
  if (E.mv_earthing === 'resistance' && E.mv_earth_a > 0) {
    const rn = mvKv * 1000 / SQ3 / E.mv_earth_a / (mvKv * mvKv / SB);
    nodes[bus].y0 = add(nodes[bus].y0, inv([3 * rn, 0]));
  }
  return { nodes, notes: [...notes] };
}

// The network re-rooted at fault node F: admittances towards the sources (Y, positive or zero sequence), the source-side voltages
// (U = E − V), the current of every branch from the voltage sources (Iv, by the node that owns the branch) and from the current
// sources (Ij, magnitudes), and the current-source total reaching the fault (Jsum).
export function solveAt(nodes, F, E, zero = false) {
  const n = nodes.length, adj = nodes.map(() => []);
  nodes.forEach((nd, i) => { if (nd.parent >= 0) { adj[i].push([nd.parent, i]); adj[nd.parent].push([i, i]); } });
  const zOf = (e) => (zero ? nodes[e].z0 : nodes[e].z), shunt = (i) => (zero ? nodes[i].y0 : nodes[i].y);
  const order = [], rpar = new Array(n).fill(-1), redge = new Array(n).fill(-1), seen = new Array(n).fill(false), kids = nodes.map(() => []);
  const st = [F]; seen[F] = true;
  while (st.length) {
    const i = st.pop(); order.push(i);
    for (const [j, e] of adj[i]) if (!seen[j]) { seen[j] = true; rpar[j] = i; redge[j] = e; kids[i].push(j); st.push(j); }
  }
  const Y = nodes.map(() => ZERO), Ybr = nodes.map(() => ZERO);
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    let y = shunt(i);
    for (const c of kids[i]) {
      const z = zOf(redge[c]);
      Ybr[c] = z ? div(Y[c], add(ONE, mul(z, Y[c]))) : ZERO;
      y = add(y, Ybr[c]);
    }
    Y[i] = y;
  }
  if (zero) return { Y };
  const U = nodes.map(() => ZERO), Iv = nodes.map(() => ZERO), Ij = new Array(n).fill(0), Yup = nodes.map(() => ZERO);
  U[F] = [E, 0];
  for (const i of order) for (const c of kids[i]) {
    const z = zOf(redge[c]);
    U[c] = z ? div(U[i], add(ONE, mul(z, Y[c]))) : ZERO;
    Iv[redge[c]] = mul(U[c], Y[c]);
    if (!z) Yup[c] = ZERO;
    else if (i === F) Yup[c] = inv(z);
    else { const A = add(sub(Y[i], Ybr[c]), Yup[i]); Yup[c] = div(A, add(ONE, mul(z, A))); }
  }
  // each current source: the share that reaches the fault, branch by branch (current divider at every node on the way)
  let Jsum = 0;
  nodes.forEach((nd, j) => {
    if (!(nd.J > 0) || !seen[j]) return;
    let m = j, f = ONE, loc = Y[j];
    while (m !== F) {
      const tot = add(loc, Yup[m]);
      f = isZero(Yup[m]) ? ZERO : isZero(tot) ? f : mul(f, div(Yup[m], tot));
      if (isZero(f)) break;
      Ij[redge[m]] += nd.J * abs(f);
      const p = rpar[m];
      loc = sub(Y[p], Ybr[m]);
      m = p;
    }
    if (m === F) Jsum += nd.J * abs(f);
  });
  return { Y, U, Iv, Ij, Jsum };
}

// One fault at bus F of network `net` in scenario scen: kA values at the bus and the current through every branch (pu)
function faultAt(P, net, F, scen) {
  const nodes = net.nodes, nd = nodes[F], kv = nd.kv, lv = kv <= 1, c = C_FACTOR[scen][lvl(kv)], kA = SB / (SQ3 * kv);
  const r = solveAt(nodes, F, c);
  const Iv = mul([c, 0], r.Y[F]), Ikv = abs(Iv), ik3 = Ikv + r.Jsum;
  const Z1 = isZero(r.Y[F]) ? null : inv(r.Y[F]);
  const rx = Z1 && Z1[1] > 0 ? Z1[0] / Z1[1] : null;
  const kB = rx != null ? kappaB(rx, lv) : 1;
  const ip = kB * Math.SQRT2 * Ikv + Math.SQRT2 * r.Jsum;
  // breaking current: each genset's share decays with μ (its share over its rated current)
  let decay = 0, gen = 0, grid = 0;
  nodes.forEach((x, i) => {
    if (x.gen) {
      const IG = abs(mul(r.U[i], x.y)); gen += IG;
      decay += (1 - mu((IG / x.gen.n) / (x.gen.kva / 1000 / SB))) * IG;
    } else if (!isZero(x.y)) grid += abs(mul(r.U[i], x.y));
  });
  // earth fault: sequence networks in series, Z2 = Z1; the inverters drive the positive sequence only
  const Y0 = solveAt(nodes, F, c, true).Y[F];
  let ik1 = 0;
  if (!isZero(Y0)) {
    const Z0 = inv(Y0);
    ik1 = Z1 ? 3 * (c + abs(Z1) * r.Jsum) / abs(add(sc(Z1, 2), Z0)) : r.Jsum;
  }
  const earth = isZero(Y0) ? (lv ? 'IT' : 'isolated') : lv ? 'earthed' : P.electrical.mv_earthing === 'resistance' ? 'resistance' : 'solid';
  const branch = nodes.map((_, i) => abs(r.Iv[i]) + r.Ij[i]);
  return { ik3: ik3 * kA, ip: ip * kA, ib: (ik3 - decay) * kA, ik1: ik1 * kA, rx, kappa: kB, earth, z1: Z1, branch,
    src: { gen: gen * kA, grid: grid * kA, conv: r.Jsum * kA } };
}

export const BUS_ORDER = ['mv', 'grid', 'pv_end', 'pv_lv', 'pv_inv', 'bess_mv', 'bess_lv', 'bess_pcs', 'gen_mv', 'gen_lv', 'gen_term', 'load_end', 'load_lv'];

// The short-circuit study of design D: { buses: [{ id, name, kv, max, min }], dev: { key: { kv, cur: { busId: { max, min } } } }, notes }.
// Currents in kA at the buses and in A through the devices.
export function faultStudy(P, D) {
  const nets = { max: faultNetwork(P, D, 'max'), min: faultNetwork(P, D, 'min') };
  const E = P.electrical;
  // solid MV earthing: zero sequence at the bus equal to the positive sequence of each case
  if (E.mv_earthing === 'solid') for (const s of ['max', 'min']) {
    const nodes = nets[s].nodes, Y1 = solveAt(nodes, 0, 1).Y[0];
    nodes[0].y0 = add(nodes[0].y0, Y1);
  }
  const idx = (s, id) => nets[s].nodes.findIndex((n) => n.id === id);
  const buses = [], dev = {};
  for (const s of ['max', 'min']) nets[s].nodes.forEach((n) => { if (n.dev) dev[n.dev] = dev[n.dev] || { kv: n.kv, cur: {} }; });
  for (const id of BUS_ORDER) {
    const iMax = idx('max', id);
    if (iMax < 0 || id === 'grid') continue;
    const nd = nets.max.nodes[iMax], b = { id, name: nd.name, kv: nd.kv, max: null, min: null };
    for (const s of ['max', 'min']) {
      const i = idx(s, id);
      if (i < 0) continue;
      const f = faultAt(P, nets[s], i, s);
      b[s] = { ...f, ik2: f.ik3 * SQ3 / 2 };
      nets[s].nodes.forEach((n, j) => {
        if (!n.dev) return;
        const d = dev[n.dev], cur = d.cur[id] || (d.cur[id] = { max: 0, min: 0 });
        cur[s] = f.branch[j] * SB * 1000 / (SQ3 * n.kv);   // A
      });
      delete b[s].branch;
    }
    buses.push(b);
  }
  const notes = [...new Set([...nets.max.notes, ...nets.min.notes])];
  return { buses, dev, notes, online: nets.min.nodes.filter((n) => n.gen).reduce((a, n) => a + n.gen.n, 0) };
}
