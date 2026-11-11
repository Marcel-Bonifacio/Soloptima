// The diagnostic log of the bug reports (lib/reports/trail.js) and its section of the report document (lib/reports/doc.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { trail, note, short, noteInput, noteCall, outline, diagnostics, environment } from '../src/lib/reports/trail.js';
import { toMarkdown } from '../src/lib/reports/doc.js';
import { W } from '../src/lib/ws/state.js';

const P = {
  name: 'Mine site', location: { lat: -2.5, lon: 115.5, utc_offset: 8 }, weather: { source: 'PVGIS', ghi: new Array(8760).fill(0) },
  load: { source: 'measured', kw: [100, 250, 180] }, pv: { capacity_kwp: 30000, mount: 'fixed', dc_ac_ratio: 1.2 },
  bess: { energy_kwh: 6600, power_kw: 2320 }, wind: { units: 0 }, diesel: { units: 20, unit_kw: 1800, strategy: 'predictive', more_groups: [{}] },
  grid: { enabled: false }, sim: { all_years: true }, ems: { openmeteo_api_key: 'abc123' },
};

test('the log keeps the last 300 entries, short values and no secrets', () => {
  for (let i = 0; i < 320; i++) note('click', `button ${i}`);
  assert.equal(trail.length, 300);
  assert.equal(trail[0].text, 'button 20');
  assert.equal(short([1, 2, 3]), '[3 values]');
  assert.equal(short('x'.repeat(80)).length, 58);
  W.P = P;
  noteInput('pv.capacity_kwp');
  assert.equal(trail.at(-1).text, 'pv.capacity_kwp = 30000');
  noteInput('ems.openmeteo_api_key');
  assert.equal(trail.at(-1).text, 'ems.openmeteo_api_key changed');
  noteCall('simulate', 812.4);
  assert.equal(trail.at(-1).text, 'simulate 812 ms');
  noteCall('optimize', 30, 'PV range is empty.');
  assert.match(trail.at(-1).text, /optimize failed after 30 ms: PV range is empty/);
  const n = trail.length;
  noteCall('report_save', 5);
  assert.equal(trail.length, n, 'the reporter is not logged');
});

test('outline: sizes, data lengths and results, no series', () => {
  W.SIM = {}; W.PVR = null; W.OPT = null;
  const o = outline(P, { stale: true, changes: 'pv.tilt' });
  assert.equal(o.weather, 'PVGIS, 8760 h');
  assert.equal(o.load, 'measured, 3 h, peak 250 kW');
  assert.equal(o.gensets, '20 × 1800 kW + 1 more groups, predictive');
  assert.equal(o.results, 'simulation (from other inputs: pv.tilt)');
  assert.doesNotMatch(JSON.stringify(o), /abc123/);
  assert.equal(outline(null), null);
  assert.equal(environment({ version: '2.1.0', os: 'macos', arch: 'aarch64' }).os, 'macos aarch64');
});

test('report document: the full copy has the log and the project; the public one hides values, folder and project', () => {
  W.P = P;
  noteInput('bess.energy_kwh');
  const d = diagnostics({ version: '2.1.0', data_dir: '/Users/ann/Soloptima' }, {});
  const r = { id: 'SOL-0002', kind: 'bug', status: 'new', severity: 'medium', title: 't', diag: d, history: [] };
  const full = toMarkdown(r, false);
  assert.match(full, /## Diagnostic log/);
  assert.match(full, /bess\.energy_kwh = 6600/);
  assert.match(full, /\| battery \| 6600 kWh \/ 2320 kW \|/);
  assert.match(full, /Data folder/);
  assert.equal((full.match(/^```/gm) || []).length % 2, 0);
  const pub = toMarkdown(r, true);
  assert.match(pub, /bess\.energy_kwh changed/);
  assert.doesNotMatch(pub, /6600|Data folder|Mine site/);
});
