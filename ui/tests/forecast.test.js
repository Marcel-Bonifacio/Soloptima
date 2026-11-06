// Forecast Lab: values, chart traces and the method table from a benchmark response
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueOf, leadChart, valueChart, tableRows, seriesChart, weekStart, weekLabel } from '../src/lib/forecast-view.js';
import { HOURS } from '../src/lib/series.js';

const col = new Proxy({}, { get: () => '#123456' });
const lead = (k) => Array.from({ length: 48 }, (_, i) => k * (1 + i / 100));
const method = (id, name, k) => ({ id, name, description: 'about ' + id, nmae: lead(k), nrmse: lead(k * 2), skill: lead(0.1), bias: lead(0), da: new Array(HOURS).fill(k), h1: new Array(HOURS).fill(k) });
const B = {
  pv: { actual: new Array(HOURS).fill(5), methods: [method('perfect', 'Perfect', 0.01), method('ets', 'ETS', 0.2), method('persistence', 'Persistence', 0.3), method('noisy', 'Noisy', 0.1)] },
  load: { actual: new Array(HOURS).fill(5), methods: [method('ets', 'ETS', 0.2)] },
  value: [{ kind: 'reference', fuel_l: 1000, unit_hours: 100, npc: 500 }, { kind: 'pv', id: 'ets', fuel_l: 800, unit_hours: 90, npc: 450 }],
};

test('value of a method against the reference', () => {
  assert.deepEqual(valueOf(B, 'pv', 'ets'), { fuel: 200, hours: 10, npc: 50 });
  assert.equal(valueOf(B, 'pv', 'persistence'), null);
  assert.equal(valueOf({ pv: B.pv }, 'pv', 'ets'), null);
});

test('lead chart: perfect left out, skill leaves out persistence, percent scale', () => {
  const nm = leadChart(B, 'pv', 'nmae', 'ets', col);
  assert.deepEqual(nm.traces.map((t) => t.name), ['ETS', 'Persistence', 'Noisy']);
  assert.equal(nm.traces[0].y[0], 20);
  assert.equal(nm.traces[0].line.width, 3.5);
  const sk = leadChart(B, 'pv', 'skill', 'ets', col);
  assert.deepEqual(sk.traces.map((t) => t.name), ['ETS', 'Noisy']);
  assert.ok(sk.traces[1].line.dash === 'dot');
});

test('value chart only with value runs', () => {
  assert.deepEqual(valueChart(B, 'pv', col).traces[0].y, ['ETS']);
  assert.equal(valueChart(B, 'load', col), null);
});

test('table rows: tags, button rules, best day-ahead', () => {
  const rows = tableRows(B, 'pv', 'ets', 'USD', col);
  assert.equal(rows.length, 4);
  const ets = rows.find((r) => r.id === 'ets');
  assert.ok(ets.inUse && ets.best && !ets.usable);
  assert.equal(rows.find((r) => r.id === 'persistence').usable, true);
  assert.equal(rows.find((r) => r.id === 'perfect').usable, false);
  assert.equal(ets.cells[4], '0.2');
  assert.equal(rows.find((r) => r.id === 'persistence').cells[4], '–');
});

test('week series', () => {
  assert.equal(weekStart(51), 8568);
  assert.equal(weekStart(60), HOURS - 168);
  assert.equal(weekLabel(0), '1 Jan to 7 Jan');
  const c = seriesChart(B, 'pv', 'da', 0, ['ets'], col);
  assert.deepEqual(c.traces.map((t) => t.name), ['Actual', 'ETS']);
  assert.equal(c.traces[0].x.length, 168);
});
