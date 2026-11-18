// The equipment library and the single-line diagram (node --test ui/tests/). The electrical calculations are the engine's
// (engine/src/electrical/, tested in engine/tests/electrical.rs); the diagram here draws one of its fixture results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultLibrary, checks, applyToModel, exportCsv, importCsv, importJson, parseCsv, selectedIn, EQ_TYPES } from '../src/lib/equip/library.js';
import { buildSld } from '../src/lib/equip/sld.js';

// a case the engine's electrical tests check: its project and the design and protection study of it
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../engine/tests/fixtures/electrical/${name}.json`, import.meta.url), 'utf8'));
// what the library tests need of a project
const project = () => ({
  pv: { capacity_kwp: 3000, dc_ac_ratio: 1.3, inverter_eff: 0.98 }, bess: { energy_kwh: 5000, power_kw: 2500, rte: 0.88 },
  diesel: { units: 2, unit_kw: 500 }, econ: { currency: 'USD' },
  equipment: { lib: defaultLibrary(), sel: { pv: 'pv600', inverter: 'inv330', battery: 'bat5', genset: 'dg500' } },
});

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
  // apparent power: blank is the kW rating, below it is an error
  assert.equal(checks('inverter', { pac_kw: 330 }).warn.length, 0);
  assert.equal(checks('inverter', { pac_kw: 330, kva: 360 }).warn.length, 0);
  assert.match(checks('battery', { power_kw: 2500, kva: 2000 }).warn[0], /Apparent power/);
  assert.match(checks('transformer', { inrush: 40 }).warn[0], /Inrush/);
});

test('the apparent power and the inrush go through CSV', () => {
  const lib = defaultLibrary();
  lib.inverter[0].kva = 363;
  lib.transformer[0].inrush = 9;
  assert.equal(importCsv(exportCsv(lib, 'inverter'), 'inverter')[0].kva, 363);
  assert.equal(importCsv(exportCsv(lib, 'inverter'), 'inverter')[1].kva, null);
  assert.equal(importCsv(exportCsv(lib, 'transformer'), 'transformer')[0].inrush, 9);
  assert.equal(importCsv('name,pac_kw,rated apparent power\nX,100,110', 'inverter')[0].kva, 110);
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

test('the diagram is well-formed SVG and escapes project text', () => {
  const f = fixture('base'), P = { ...f.request.project, name: 'Test <plant> & co' }, D = f.design;
  const svg = buildSld(D, P, true);
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('Test &lt;plant&gt; &amp; co'));
  assert.ok(!svg.includes('<plant>'));
  assert.ok(buildSld(D, P, false).length < svg.length);
  assert.match(buildSld(D, P, true, f.protection.F), /Ik″ [\d.]+ kA/, 'the diagram carries the fault levels');
});

test('a cycle life by depth of discharge: CSV round trip, checked under the editor, applied to the model', () => {
  const lib = defaultLibrary();
  lib.battery[0].cycle_curve = '10: 60000, 50: 9000, 100: 4000';
  assert.equal(importCsv(exportCsv(lib, 'battery'), 'battery')[0].cycle_curve, '10: 60000, 50: 9000, 100: 4000');
  assert.deepEqual(checks('battery', lib.battery[0]).warn, []);
  assert.equal(checks('battery', { ...lib.battery[0], cycle_curve: '50: 9000, 10: 60000' }).warn.length, 1);
  const P = project();
  P.econ = {};
  P.equipment.lib.battery.find((e) => e.id === P.equipment.sel.battery).cycle_curve = '10: 60000, 100: 4000';
  const r = applyToModel(P);
  assert.deepEqual(P.bess.cycle_curve, [[0.1, 60000], [1, 4000]]);
  assert.ok(r.msg.some((m) => m.includes('cycle life by depth of discharge')));
  P.equipment.lib.battery.find((e) => e.id === P.equipment.sel.battery).cycle_curve = '';
  applyToModel(P);
  assert.equal(P.bess.cycle_curve, null, 'a datasheet without a curve clears it');
});
