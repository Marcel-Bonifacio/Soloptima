// The time-current chart of the protection study (node --test ui/tests/). The short-circuit and protection calculations are the
// engine's (engine/src/electrical/fault.rs, protection.rs, tested there against hand calculations); the chart draws its fixture results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLibrary, migrateEquipment } from '../src/lib/equip/library.js';
import { tripTime, buildTcc, curveTable, devicesOf } from '../src/lib/equip/protection.js';
import { readFileSync } from 'node:fs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../engine/tests/fixtures/electrical/${name}.json`, import.meta.url), 'utf8'));
const near = (a, b, rel = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg} ${a} ≠ ${b}`);

test('inverse-time curves match IEC 60255-151 at ten times pickup', () => {
  const d = (curve) => ({ curve, pickup: 100, tms: 1, inst: null });
  near(tripTime(d('SI'), 1000), 0.14 / (10 ** 0.02 - 1), 1e-12); near(tripTime(d('SI'), 1000), 2.97, 0.005);
  near(tripTime(d('VI'), 1000), 1.5, 1e-12); near(tripTime(d('EI'), 1000), 80 / 99, 1e-12); near(tripTime(d('LTI'), 1000), 120 / 9, 1e-12);
  assert.equal(tripTime(d('SI'), 90), Infinity);
  assert.equal(tripTime({ ...d('SI'), inst: 800 }, 900), 0.05);
  near(tripTime(d('SI'), 5000), tripTime(d('SI'), 2000), 1e-12, 'flat beyond 20 × pickup');
});

test('the chart and the workbook table of every study the engine wrote', () => {
  for (const name of ['base', 'gen_mv', 'grid_strong', 'no_bess', 'settings_typed']) {
    const PR = fixture(name).protection, svg = buildTcc(PR, 20);
    assert.ok(svg.startsWith('<svg') && svg.includes('polyline') && !svg.includes('NaN'), name);
    assert.equal(curveTable(PR).length, devicesOf(PR).length * 7, name);
    assert.deepEqual(devicesOf(PR).map((d) => d.key).sort(), Object.keys(PR.dev).sort(), `${name}: every device in switchboard order`);
  }
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
