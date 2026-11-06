// The CSV import's guesses and the data checks' words (plain modules)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { someLines, openSession, engineOpt, clockOf } from '../src/lib/tsimport/guess.js';
import { timing, setNotes, applyFix, quality, sheetRows, reportRows, pageView, unitHints } from '../src/lib/tsimport/texts.js';
import { HOURS } from '../src/lib/series.js';

const ctx = { tz: 'Europe/Berlin', utcOffset: 1, isUtc: false, prev: undefined };

test('preview lines skip blank lines and the byte order mark', () => {
  assert.deepEqual(someLines('﻿a\n\nb\r\nc\n', 2), ['a', 'b']);
  assert.deepEqual(someLines('a\nb\nc\n\n', 2, true), ['b', 'c']);
});

test('weather file: columns, units and basis guessed from the header', () => {
  const text = 'Date,GHI (W/m2),Temp (K),Wind km/h\n2020-01-01 00:00,0,290,12\n2020-01-01 01:00,10,291,13\n';
  const S = openSession('weather', 'w.csv', text, ctx);
  assert.equal(S.hdr, 1);
  assert.deepEqual([S.opt.time_col, S.opt.ghi, S.opt.tamb, S.opt.wind], [0, 1, 2, 3]);
  assert.equal(S.opt.temp_units, 'k');
  assert.equal(S.opt.wind_units, 'km_h');
  assert.equal(S.opt.basis, 'local_standard');
  assert.equal(S.nlines, 3);
});

test('load file in a semicolon file with decimal commas; the previous time basis is kept', () => {
  const text = 'time;load kWh\n01.01.2020 00:00;12,5\n01.01.2020 01:00;13,5\n';
  const S = openSession('load', 'l.csv', text, { ...ctx, prev: { basis: 'local_clock' } });
  assert.equal(S.delim, ';');
  assert.equal(S.opt.time_col, 0);
  assert.deepEqual(S.opt.cols, [1]);
  assert.equal(S.opt.units, 'kwh_interval');
  assert.equal(S.opt.basis, 'local_clock');   // Berlin has a clock change in 2020
  const e = engineOpt(S, ctx);
  assert.equal(e.clock.changes.length, 2);
  assert.equal(e.time_col, 0);
  assert.equal(e.year, 'auto');
});

test('a zone without a clock change refuses local clock time', () => {
  const text = 'time,load\n2020-01-01 00:00,1\n2020-01-01 01:00,2\n';
  const S = openSession('load', 'l.csv', text, { ...ctx, tz: 'Asia/Jakarta', prev: { basis: 'local_clock' } });
  assert.equal(S.opt.basis, 'local_standard');
  assert.deepEqual(clockOf('Asia/Jakarta', 2020, 2020).changes, []);
  assert.throws(() => openSession('load', 'e.csv', '\n\n', ctx), /empty/);
});

test('timing verdicts as text with their fixes', () => {
  const T = { n_days: 40, median_min: 62, iqr_min: 8, verdict: 'hours', shift_h: 1 };
  const r = timing(T, { is_utc: false });
  assert.match(r.text, /40 clear days.*62 min later/);
  assert.deepEqual(r.fix, [['Shift 1 h earlier', 'shift', 1]]);
  assert.deepEqual(timing({ n_days: 3, verdict: 'none' }).fix, []);
  assert.equal(timing({ n_days: 40, median_min: 1, iqr_min: 5, verdict: 'ok' }).ok, true);
});

test('notes keep markup characters as text', () => {
  const n = setNotes({ set: [{ id: 'level_shift', shifts: [{ day: 0, before_kw: 100, after_kw: 150 }] }, { id: '<img src=x>' }] });
  assert.match(n[0], /\+50 %/);
  assert.equal(n[1], '<img src=x>');
});

test('timing fixes: shift, instant samples, UTC flag', () => {
  const W = { ghi: Array.from({ length: HOURS }, (_, i) => i), is_utc: false, qc: {} };
  assert.match(applyFix(W, 'shift', 1), /shifted 1 h earlier/);
  assert.equal(W.ghi[0], 1);
  assert.equal(W.ghi[HOURS - 1], 0);
  assert.equal(W.qc, null);
  applyFix(W, 'instant', 1);
  assert.equal(W.ghi[0], 1.5);
  assert.match(applyFix(W, 'utc', 0), /UTC/);
  assert.equal(W.is_utc, true);
  assert.match(W.note, /After the data checks/);
});

test('report rows, quality summary and workbook rows', () => {
  const R = { parsed: 8760, rows: 8760, header_lines: 1, interval_min: 60, label: 'start', date_order: 'ymd', base: 'UTC', first: 'a', last: 'b', period: '2020', coverage: 1, missing_h: 0, filled_h: 0, max_gap_h: 0 };
  assert.equal(reportRows(R)[0][0], 'Rows read');
  const Q = { flags: [{ id: 'night', label: 'Irradiance at night', hours: 3, days: 2, ghi_share: 0.01 }], hours: [{ h: 30, flag: 'night', v: 5 }], n_list: 1, n_flagged: 3, days: [1, 2], score: 0.99, set: [], timing: null };
  const P = { weather: { ghi: [1], import: { file: 'w.csv', label: 'start', basis: 'utc', report: R }, qc: Q }, load: { source: 'synthetic', kw: [1] } };
  const q = quality('weather', P);
  assert.equal(q.rows[0][1], 'w.csv');
  assert.deepEqual(q.flags[0].slice(0, 3), ['Irradiance at night', '3', '2']);
  assert.equal(quality('load', P), null);
  const rows = sheetRows(P);
  assert.equal(rows[1][2], '2 Jan 06:00');
  assert.equal(pageView('load', P), null);
  assert.equal(pageView('weather', P).flags.length, 1);
});

test('unit hints compare the peak with the genset fleet', () => {
  const diesel = { units: 2, unit_kw: 1000 };
  assert.match(unitHints('load', { kw: [50000] }, diesel)[0], /above the genset fleet/);
  assert.match(unitHints('load', { kw: [50] }, diesel)[0], /below a fifth/);
  assert.deepEqual(unitHints('load', { kw: [1500] }, diesel), []);
});
