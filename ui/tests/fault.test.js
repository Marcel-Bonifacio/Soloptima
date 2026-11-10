// Short-circuit currents (IEC 60909-0) and protection coordination against hand calculations (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLibrary, migrateEquipment } from '../src/lib/equip/library.js';
import { computeDesign } from '../src/lib/equip/design.js';
import { faultStudy, solveAt, kappa, kappaB, mu, mFactor, windings } from '../src/lib/equip/fault.js';
import { protectionStudy, tripTime, tmsFor, pickBreaker, roundPickup, buildTcc, curveTable } from '../src/lib/equip/protection.js';
import { buildSld } from '../src/lib/equip/sld.js';
import { HOURS } from '../src/lib/series.js';

const near = (a, b, rel = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg} ${a} ≠ ${b}`);
const cabs = (o) => Object.fromEntries(['dc', 'lv_pv', 'mv_pv', 'lv_bess', 'mv_bess', 'lv_gen', 'mv_gen', 'load'].map((k) => [k, o]));

// a project with only what a case needs: no PV unless given, no battery, gensets and load as asked
function project(o = {}) {
  const lib = defaultLibrary();
  lib.transformer.push({ id: 'tr1000', name: 'Test 1000 kVA 20/0.4 kV', kva: 1000, hv_kv: 20, lv_kv: 0.4, z: 6, p0: 1.1, pk: 10.5, vector: 'Dyn11' });
  return {
    name: 'Test', location: { lat: 0, lon: 0 }, econ: { currency: 'USD' }, weather: null,
    load: { kw: new Array(HOURS).fill(o.load ?? 0) }, pv: { capacity_kwp: 0, dc_ac_ratio: 1.2, inverter_eff: 0.98 },
    bess: { energy_kwh: 0, power_kw: 0, rte: 0.9 }, diesel: { units: o.units ?? 0, unit_kw: 500, min_units_online: 1 }, aux: {},
    equipment: { lib, sel: { pv: o.pv ?? '', inverter: o.pv ? 'inv330' : '', battery: 'bat5', genset: 'dg500' } },
    electrical: {
      mv_kv: o.mv_kv ?? 20, pf_load: 0.9, t_min: 15, t_cell_max: 70, modules_per_string: 0, derate: 0.8,
      trafo_pv: 'tr3150', trafo_bess: 'tr5000', trafo_gen: 'tr2500', gens_per_trafo: 1, gen_mv: o.gen_mv ?? false, trafo_load: o.trafo_load ?? '',
      pv_per_feeder: 4, dv_dc: 1.5, dv_lv: 1.5, dv_mv: 1.0, len: cabs(0), cable: { dc: 'dc6', lv_pv: 'lv240al', mv_pv: 'mv240al', lv_bess: 'lv400al', mv_bess: 'mv240al', lv_gen: 'lv630cu', mv_gen: 'mv150al', load: 'mv400al' },
      runs: cabs(1), grid_mva: o.grid_mva ?? 0, grid_xr: 10, mv_earthing: o.earthing ?? 'resistance', mv_earth_a: 300, grading_s: 0.3, sc_t_max: 1, breaker: {}, prot: {},
    },
  };
}
const study = (P) => faultStudy(P, computeDesign(P, {}));

test('a 1000 kVA Dyn11 transformer on a 500 MVA network: LV fault by hand (ohms at 0.4 kV)', () => {
  const P = project({ load: 500, trafo_load: 'tr1000', grid_mva: 500 });
  const F = study(P), lv = F.buses.find((b) => b.id === 'load_lv'), mv = F.buses.find((b) => b.id === 'mv');
  // network feeder: Z_Q = c_Q U_nQ² / S″kQ, referred to 0.4 kV, X/R 10
  const zq = 1.1 * 20 * 20 / 500 * (0.4 / 20) ** 2, rq = zq / Math.sqrt(101), xq = 10 * rq;
  // transformer: Z_T = u_k U² / S, R_T = P_k U² / S², K_T = 0.95 c_max / (1 + 0.6 x_T)
  const zt = 0.06 * 0.16 / 1, rt = 10500 * 0.16e6 / 1e12, xt = Math.sqrt(zt * zt - rt * rt), KT = 0.95 * 1.05 / (1 + 0.6 * xt / 0.16);
  const R = rq + KT * rt, X = xq + KT * xt, Z = Math.hypot(R, X);
  const ik = 1.05 * 400 / (Math.sqrt(3) * Z) / 1000;                       // kA
  near(lv.max.ik3, ik, 1e-6, 'Ik″');
  assert.ok(ik > 25 && ik < 27, 'about c / (K_T u_k) × In = 1.05 × 24.1 kA / K_T');
  const k = 1.02 + 0.98 * Math.exp(-3 * R / X);
  near(lv.max.ip, Math.min(1.15 * k, 1.8) * Math.SQRT2 * ik, 1e-6, 'ip');
  assert.equal(lv.max.ib, lv.max.ik3, 'far from generators: Ib = Ik″');
  // line to earth: the network's zero sequence stops at the delta, Z0 = Z_T on the earthed star
  const Zs = Math.hypot(2 * R + KT * rt, 2 * X + KT * xt);
  near(lv.max.ik1, Math.sqrt(3) * 1.05 * 400 / Zs / 1000, 1e-6, 'Ik1');
  // MV bus: the network alone, c = 1.1: S″k / (√3 Un)
  near(mv.max.ik3, 500 / (Math.sqrt(3) * 20), 1e-6, 'MV Ik″');
  // resistance earthed at 300 A: Ik1 ≈ c × 300 A (3 R_N dominates)
  assert.ok(mv.max.ik1 > 0.29 && mv.max.ik1 < 0.331, `MV Ik1 ${mv.max.ik1}`);
  assert.equal(mv.max.earth, 'resistance');
});

test('two 625 kVA gensets on a 0.4 kV bus: Ik″, peak and breaking current by hand', () => {
  const P = project({ units: 2, gen_mv: true, mv_kv: 0.4, earthing: 'isolated' });
  const b = study(P).buses.find((x) => x.id === 'mv');
  // Z_G = (R_G + jX″d) U²/S with R_G = 0.15 X″d (LV), K_G = c_max / (1 + x″d sin φ); 13 % and PF 0.8 from the datasheet
  const xd = 0.13, zb = 0.4 * 0.4 / 0.625, KG = 1.05 / (1 + xd * 0.6);
  const Zg = KG * zb * Math.hypot(0.15 * xd, xd);
  const ik = 2 * 1.05 * 400 / (Math.sqrt(3) * Zg) / 1000;
  near(b.max.ik3, ik, 1e-6, 'Ik″');
  near(b.max.ip, Math.min(1.15 * kappa(0.15), 1.8) * Math.SQRT2 * ik, 1e-6, 'ip');
  const Ir = 625 / (Math.sqrt(3) * 0.4) / 1000, r = ik / 2 / Ir;
  near(b.max.ib, mu(r) * ik, 1e-6, 'Ib = μ Ik″');
  // minimum: one genset online, c_min = 0.95 and no K_G
  near(b.min.ik3, 0.95 * 400 / (Math.sqrt(3) * zb * Math.hypot(0.15 * xd, xd)) / 1000, 1e-6, 'Ik″ min');
  assert.equal(b.max.earth, 'IT', 'genset neutrals not earthed, no transformer: an IT bus');
});

test('current sources: all of an inverter reaches a fault with no other path; a shunt source takes its share', () => {
  const z = [0.01, 0.05];
  const lone = [{ parent: -1, z: [0, 0], z0: null, y: [0, 0], y0: [0, 0], J: 0 }, { parent: 0, z, z0: null, y: [0, 0], y0: [0, 0], J: 2 }];
  near(solveAt(lone, 0, 1).Jsum, 2, 1e-12);
  // a genset admittance ys at the inverter's node: the share to the fault is (1/z) / (ys + 1/z)
  const ys = [0.5, -4], net = [lone[0], { ...lone[1], y: ys }];
  const yz = [z[0] / (z[0] ** 2 + z[1] ** 2), -z[1] / (z[0] ** 2 + z[1] ** 2)], tot = [ys[0] + yz[0], ys[1] + yz[1]];
  near(solveAt(net, 0, 1).Jsum, 2 * Math.hypot(...yz) / Math.hypot(...tot), 1e-12);
});

test('IEC factors and vector groups', () => {
  near(kappa(0), 2.0, 1e-12); near(kappaB(0.15, true), 1.8, 1e-12); near(kappaB(0.15, false), 1.15 * kappa(0.15), 1e-12);
  assert.equal(mu(2), 1); near(mu(5), 0.62 + 0.72 * Math.exp(-1.6), 1e-12);
  near(mFactor(1.8, 0.1), 0.443, 0.01, 'IEC 60909-0 figure: m ≈ 0.44 at κ = 1.8, Tk = 0.1 s');
  assert.equal(mFactor(1.0, 1), 0);
  assert.deepEqual(windings('Dyn11'), { hv: false, lv: true, guessed: false });
  assert.deepEqual(windings('YNd11'), { hv: true, lv: false, guessed: false });
  assert.equal(windings('Dy11').lv, false);
  assert.equal(windings('').guessed, true);
});

test('inverse-time curves match IEC 60255-151 at ten times pickup', () => {
  const d = (curve) => ({ curve, pickup: 100, tms: 1, inst: null });
  near(tripTime(d('SI'), 1000), 0.14 / (10 ** 0.02 - 1), 1e-12); near(tripTime(d('SI'), 1000), 2.97, 0.005);
  near(tripTime(d('VI'), 1000), 1.5, 1e-12); near(tripTime(d('EI'), 1000), 80 / 99, 1e-12); near(tripTime(d('LTI'), 1000), 120 / 9, 1e-12);
  assert.equal(tripTime(d('SI'), 90), Infinity);
  assert.equal(tripTime({ ...d('SI'), inst: 800 }, 900), 0.05);
  near(tripTime(d('SI'), 5000), tripTime(d('SI'), 2000), 1e-12, 'flat beyond 20 × pickup');
  near(tmsFor(d('SI'), 1000, 0.594), 0.2, 0.002);
  assert.equal(roundPickup(22.4), 23); assert.equal(roundPickup(1127), 1150);
});

test('breakers are picked by voltage, current and duty', () => {
  const lib = defaultLibrary().breaker;
  assert.equal(pickBreaker(lib, 0.8, 2273, { ik3: 10, ip: 20, ib: 10 }).id, 'acb2500');
  assert.equal(pickBreaker(lib, 0.4, 902, { ik3: 70, ip: 150, ib: 60 }).id, 'acb4000', 'the 1600 A breaker breaks only 50 kA');
  assert.equal(pickBreaker(lib, 20, 40, { ik3: 20, ip: 50, ib: 18 }).id, 'vcb1250');
});

// the hybrid plant of the electrical design tests
function plant() {
  const P = project({ load: 1100, units: 2, pv: 'pv600' });
  Object.assign(P.pv, { capacity_kwp: 3000, dc_ac_ratio: 1.3 });
  Object.assign(P.bess, { energy_kwh: 5000, power_kw: 2500 });
  Object.assign(P.electrical.len, { dc: 60, lv_pv: 120, mv_pv: 800, lv_bess: 30, mv_bess: 400, lv_gen: 60, mv_gen: 250, load: 500 });
  Object.assign(P.electrical.runs, { lv_pv: 2, lv_bess: 4, lv_gen: 4, load: 2 });
  return P;
}

test('the hybrid plant: fault levels, graded settings, checks and the chart', () => {
  const P = plant(), D = computeDesign(P, {}), PR = protectionStudy(P, D);
  const ids = PR.F.buses.map((b) => b.id);
  for (const id of ['mv', 'pv_lv', 'pv_inv', 'bess_lv', 'bess_pcs', 'gen_lv', 'gen_term', 'load_end']) assert.ok(ids.includes(id), id);
  const mv = PR.F.buses.find((b) => b.id === 'mv');
  // 2 gensets of 625 kVA at 13 % through their transformers, plus the converters at 1.2 × rated
  assert.ok(mv.max.ik3 > 0.3 && mv.max.ik3 < 0.6, `MV Ik″ ${mv.max.ik3}`);
  assert.ok(mv.min.ik3 < mv.max.ik3);
  assert.equal(PR.F.buses.find((b) => b.id === 'pv_lv').max.earth, 'IT', 'Dy11 PV transformer: unearthed LV');
  assert.ok(PR.F.buses.find((b) => b.id === 'gen_lv').max.ik1 > 0, 'Dyn11 genset transformer: earthed LV');
  // every grading check met with the suggested settings, the upstream devices slower by the margin
  for (const r of PR.grading) assert.ok(r.ok, `${r.down} → ${r.up}: ${r.margin}`);
  const g = PR.grading.find((r) => r.down === 'load' && r.up === 'mv_gen');
  assert.ok(g.tu - g.td >= 0.3 - 1e-9);
  assert.ok(PR.dev.lv_gen.set.tms >= PR.dev.mv_gen.set.tms, 'the genset breaker backs up its feeder');
  assert.equal(PR.dev.load.set.pickup, roundPickup(1.25 * PR.dev.load.In));
  // a typed setting replaces the suggestion and the grading check follows it
  P.electrical.prot = { mv_gen: { tms: 0.05 } };
  const PR2 = protectionStudy(P, D);
  assert.equal(PR2.dev.mv_gen.set.tms, 0.05);
  assert.ok(!PR2.grading.find((r) => r.down === 'load' && r.up === 'mv_gen').ok);
  assert.match(PR2.warn.join(' '), /grading margin/);
  // a breaker too weak for its bus is flagged
  P.electrical.prot = {}; P.electrical.breaker = { lv_gen: 'mccb630' };
  const PR3 = protectionStudy(P, D);
  assert.ok(PR3.dev.lv_gen.chk.length > 0);
  assert.match(PR3.warn.join(' '), /630 A moulded-case breaker/);
  // cables: adiabatic withstand k·S·runs/√t
  const c = PR.cables.find((x) => x.key === 'lv_gen');
  near(c.adm, 143 * 630 * 4 / Math.sqrt(c.t) / 1000, 1e-9);
  // the chart and the workbook table
  const svg = buildTcc(PR, 20);
  assert.ok(svg.startsWith('<svg') && svg.includes('polyline') && !svg.includes('NaN'));
  assert.equal(curveTable(PR).length, Object.keys(PR.dev).length * 7);
  // the single-line diagram carries the fault levels
  assert.match(buildSld(D, P, true, PR.F), /Ik″ [\d.]+ kA/);
});

test('an older project gets the breakers and the short-circuit values of the built-in datasheets', () => {
  const lib = defaultLibrary();
  delete lib.breaker; delete lib.genset[2].xd2; delete lib.inverter[0].ifault;
  const p = { equipment: { lib } };
  migrateEquipment(p);
  assert.ok(lib.breaker.length > 0);
  assert.equal(lib.genset[2].xd2, 13);
  assert.equal(lib.inverter[0].ifault, 1.2);
});
