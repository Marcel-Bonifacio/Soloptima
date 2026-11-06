// The equipment library, the electrical design, the load flow and the single-line diagram (node --test ui/tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLibrary, checks, applyToModel, exportCsv, importCsv, importJson, parseCsv, selectedIn, EQ_TYPES } from '../src/lib/equip/library.js';
import { computeDesign, autoSize, applyLosses } from '../src/lib/equip/design.js';
import { runLoadFlow, busVoltages } from '../src/lib/equip/loadflow.js';
import { buildSld } from '../src/lib/equip/sld.js';
import { HOURS } from '../src/lib/series.js';

const project = () => ({
  name: 'Test <plant> & co', location: { lat: -8.5, lon: 115.2 }, econ: { currency: 'USD' }, weather: null,
  load: { kw: Array.from({ length: HOURS }, (_, h) => 800 + 300 * Math.sin(h / 24 * 2 * Math.PI)) },
  pv: { capacity_kwp: 3000, dc_ac_ratio: 1.3, inverter_eff: 0.98 },
  bess: { energy_kwh: 5000, power_kw: 2500, rte: 0.88 },
  diesel: { units: 2, unit_kw: 500, strategy: 'load_following', reserve_load: 0.1, reserve_pv: 0.2 },
  aux: {}, equipment: { lib: defaultLibrary(), sel: { pv: 'pv600', inverter: 'inv330', battery: 'bat5', genset: 'dg500' } },
  electrical: {
    mv_kv: 20, pf_load: 0.9, t_min: 15, t_cell_max: 70, modules_per_string: 0, derate: 0.8,
    trafo_pv: 'tr3150', trafo_bess: 'tr5000', trafo_gen: 'tr2500', gens_per_trafo: 1, gen_mv: false, trafo_load: '',
    pv_per_feeder: 4, dv_dc: 1.5, dv_lv: 1.5, dv_mv: 1.0,
    len: { dc: 60, lv_pv: 120, mv_pv: 800, lv_bess: 30, mv_bess: 400, lv_gen: 60, mv_gen: 250, load: 500 },
    cable: { dc: 'dc6', lv_pv: 'lv240al', mv_pv: 'mv240al', lv_bess: 'lv400al', mv_bess: 'mv240al', lv_gen: 'lv630cu', mv_gen: 'mv150al', load: 'mv400al' },
    runs: { dc: 1, lv_pv: 2, mv_pv: 1, lv_bess: 4, mv_bess: 1, lv_gen: 4, mv_gen: 1, load: 2 }, applied: null,
  },
});
const flat = (k) => new Array(HOURS).fill(k);
const pvr = () => ({ ac_per_kwp: Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin((h % 24 - 6) / 12 * Math.PI)) * 0.7), tcell: flat(40), poa: flat(500) });
const sim = () => ({ result: { hourly: { pv_avail: flat(900), pv_to_load: flat(500), pv_to_bess: flat(100), bess_dis: flat(200), gen_to_load: flat(100), gen_to_bess: flat(0), gen_dump: flat(0),
  gen_units: flat(1), load: flat(1000), aux: flat(20) }, years: [{ bess_dis: 1e6, bess_ch: 1.1e6, gen_kwh: 5e5 }] } });

test('the built-in library has every type and finds the selected datasheets', () => {
  const lib = defaultLibrary();
  for (const t of Object.keys(EQ_TYPES)) assert.ok(lib[t].length > 0, t);
  assert.equal(selectedIn(project(), 'pv').id, 'pv600');
  assert.equal(checks('pv', lib.pv[1]).warn.length, 0);
});

test('checks flag an implausible datasheet', () => {
  const e = { ...defaultLibrary().pv[1], vmp: 60, eff_rel_200: 3 };
  const w = checks('pv', e).warn.join(' ');
  assert.match(w, /Vmp × Imp/);
  assert.match(w, /Relative efficiency/);
  assert.match(checks('genset', { fuel_25: 100, fuel_50: 90, fuel_75: 120, fuel_100: 150 }).warn[0], /increase with load/);
});

test('applying the datasheets writes the model inputs and leaves out implausible values', () => {
  const P = project();
  P.econ = {}; P.pv.noct = null; P.diesel.fuel_curve = null;
  P.equipment.lib.pv.find((e) => e.id === 'pv600').noct = 90;
  const r = applyToModel(P);
  assert.equal(P.pv.module_wp, 600);
  assert.ok(Math.abs(P.pv.inverter_eff - 0.985) < 1e-9);
  assert.equal(P.diesel.fuel_curve.length, 4);
  assert.deepEqual(r.skipped, ['NOCT']);
  assert.equal(P.pv.noct, null);
});

test('CSV export guards a formula and import reads it back', () => {
  const lib = defaultLibrary();
  lib.pv[0].name = '=HYPERLINK("http://x","y")';
  lib.pv[1].name = 'Plain, with comma';
  const csv = exportCsv(lib, 'pv');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""y"")"`));
  const back = importCsv(csv, 'pv');
  assert.equal(back.length, lib.pv.length);
  assert.equal(back[1].name, 'Plain, with comma');
  assert.equal(back[0].pmax, 665);
  assert.throws(() => importCsv('1,2,3', 'pv'), /header/);
  assert.equal(parseCsv('a;b\n1;2').rows[0][1], '2');
});

test('JSON import keeps unused ids and gives a new one to a clash', () => {
  const lib = defaultLibrary(), n0 = lib.pv.length;
  const n = importJson(lib, JSON.stringify({ pv: [{ id: 'pv600', name: 'dup' }, { id: 'mine', name: 'own' }, null], cable: 'no' }));
  assert.equal(n, 2);
  assert.equal(lib.pv.length, n0 + 2);
  assert.ok(lib.pv.some((e) => e.id === 'mine'));
  assert.equal(new Set(lib.pv.map((e) => e.id)).size, lib.pv.length);
  assert.throws(() => importJson(lib, 'null'), /equipment library/);
});

test('the design sizes strings, transformers and cables and integrates the losses', () => {
  const P = project(), D = computeDesign(P, { PVR: pvr(), SIM: sim() });
  assert.ok(D.str.ns >= D.str.nMin && D.str.ns <= D.str.nMax);
  assert.ok(Math.abs(D.str.kwp - 3000) < D.str.ns * 0.6 + 1);
  assert.ok(D.trafos.length >= 3);
  assert.ok(D.circuits.find((c) => c.key === 'dc').annual > 0);
  assert.ok(D.hasProfiles && D.loss.pvAc > 0 && D.loss.bess_ll > 0 && D.cost > 0);
  const none = computeDesign(P, { PVR: null, SIM: null });
  assert.equal(none.hasProfiles, false);
});

test('auto-size picks cables that meet the limits, and apply feeds the losses back once', () => {
  const P = project(), ctx = { PVR: pvr(), SIM: sim() };
  autoSize(P, ctx);
  const D = computeDesign(P, ctx);
  assert.ok(D.circuits.every((c) => c.util <= 1 && c.dv * 100 <= c.lim), D.warn.join(' | '));
  const base = applyLosses(P, D, null);
  const rte1 = P.bess.rte;
  assert.ok(rte1 < 0.88 && P.pv.ac_losses > 0 && P.electrical.applied.ac_losses === P.pv.ac_losses);
  applyLosses(P, computeDesign(P, ctx), base);
  assert.equal(P.bess.rte, rte1, 'a second apply does not compound the battery efficiency');
  assert.throws(() => applyLosses(P, computeDesign(P, { PVR: null, SIM: null }), null), /PV yield/);
});

test('the load flow keeps the voltages near 1 pu and reports losses', () => {
  const P = project(), ctx = { PVR: pvr(), SIM: sim() }, D = computeDesign(P, ctx);
  const LF = runLoadFlow(P, D, ctx.SIM);
  assert.equal(LF.hours.length, 4);
  assert.ok(LF.lossTot > 0);
  assert.ok(Math.min(...LF.vmin) > 0.9 && Math.max(...LF.vmax) < 1.1);
  const B = busVoltages(LF, ctx.SIM, LF.hours[0].h);
  assert.equal(B.names.length, LF.net.nodes.length);
});

test('the diagram is well-formed SVG and escapes project text', () => {
  const P = project(), D = computeDesign(P, { PVR: pvr(), SIM: sim() });
  const svg = buildSld(D, P, true);
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('Test &lt;plant&gt; &amp; co'));
  assert.ok(!svg.includes('<plant>'));
  assert.ok(buildSld(D, P, false).length < svg.length);
});
