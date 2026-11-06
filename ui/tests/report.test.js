// The report's plain modules (node --test ui/tests/): the workbook writer, the layout frame and the figures a project may hold
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xlsx, sheetXml, colName, xesc } from '../src/lib/report/xlsx.js';
import { crc32 } from '../src/lib/report/zip.js';
import { layoutGeom, layoutFrame, layoutRows, w180, coord } from '../src/lib/report/layout-geom.js';
import { cleanReport, DATA_IMG } from '../src/lib/report/figures.js';
import { sheetsB } from '../src/lib/report/sheets-b.js';
import { cleanSvg } from '../src/lib/report/svg-node.js';

test('crc32 of the standard check string', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('sheet cells: numbers, booleans and text; text is escaped and never a formula', () => {
  assert.equal(colName(0), 'A'); assert.equal(colName(26), 'AA');
  const x = sheetXml([['Name', 'Value'], ['=1+1<x>"&', 2.5], ['b', true], ['skip', null, '']]);
  assert.match(x, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">=1\+1&lt;x&gt;&quot;&amp;<\/t><\/is><\/c>/);
  assert.match(x, /<c r="B2"><v>2\.5<\/v><\/c>/);
  assert.match(x, /<c r="B3" t="b"><v>1<\/v><\/c>/);
  assert.doesNotMatch(x, /<f>/);
  assert.equal(xesc('a\x01b'), 'ab');
});

test('workbook: a valid zip with every sheet, names cleaned', async () => {
  const blob = xlsx([{ name: 'Sum/mary', rows: [['A'], [1]] }, { name: 'x'.repeat(40), rows: [['B'], ['é<']] }]);
  const buf = Buffer.from(await blob.arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  try {
    const f = join(dir, 'w.xlsx');
    writeFileSync(f, buf);
    let ok = true;
    try { execFileSync('unzip', ['-tq', f], { stdio: 'pipe' }); } catch (e) { ok = e.code === 'ENOENT'; if (!ok) throw e; }
    assert.ok(ok);
    const text = buf.toString('latin1');
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) assert.ok(text.includes(part), part);
    assert.ok(text.includes('name="Sum mary"'));
    assert.ok(text.includes('name="' + 'x'.repeat(31) + '"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const P = { location: { lat: -8.5, lon: 125.5 }, layout: { polygons: [
  { type: 'site', latlngs: [[-8.5, 125.5], [-8.5, 125.51], [-8.51, 125.51], [-8.51, 125.5]] },
  { type: 'exclusion', latlngs: [[-8.502, 125.502], [-8.502, 125.504], [-8.504, 125.504]] },
  { type: 'obstacle', kind: 'tree', center: [-8.506, 125.506], diameter: 8, height: 6 }], result: { n_tables: 4, modules: 100, kwp: 55, site_m2: 1e4, excl_m2: 10, pitch: 5 } } };
const footprint = (p) => [[p.center[0] + 0.0001, p.center[1]], [p.center[0], p.center[1] + 0.0001], [p.center[0] - 0.0001, p.center[1]]];

test('layout geometry: the frame holds the areas and is no flatter than 1:3', () => {
  const G = layoutGeom(P, footprint);
  assert.equal(G.sites.length, 1); assert.equal(G.excls.length, 1); assert.equal(G.trees.length, 1);
  assert.ok(G.heightM >= G.widthM / 3 - 1e-6 && G.widthM >= G.heightM / 3 - 1e-6);
  const F = layoutFrame(G);
  assert.ok(F.W > 0 && F.H > 0 && /^M[\d.,L-]+Z$/.test(F.path(G.sites[0].latlngs)));
  assert.equal(layoutGeom({ ...P, layout: { polygons: [] } }, footprint), null);
  const rows = layoutRows(P, G);
  assert.equal(rows[0][0], 'Item'); assert.ok(rows.some((r) => r[0] === 'PV tables' && r[1] === 4));
  assert.equal(w180(190), -170); assert.equal(coord(1, 181), '1.000000, -179.000000');
});

test('figures of a project file: valid images, known places, unique ids, capped captions', () => {
  const img = 'data:image/png;base64,iVBORw0KGgo=';
  const p = { report: { imagery: 1, figures: [{ id: 'a', caption: 'x'.repeat(500), place: 'pv', src: img }, { id: 'a', src: img, place: 'nope' }, { src: 'javascript:alert(1)' }, { src: 'data:image/svg+xml;base64,AAAA' }, null] } };
  cleanReport(p);
  assert.equal(p.report.imagery, true);
  assert.equal(p.report.figures.length, 2);
  assert.equal(p.report.figures[0].caption.length, 300);
  assert.equal(p.report.figures[1].place, 'appendix');
  assert.notEqual(p.report.figures[0].id, p.report.figures[1].id);
  assert.ok(p.report.figures.every((f) => DATA_IMG.test(f.src)));
  const q = { report: [] }; cleanReport(q);
  assert.deepEqual(q.report, { imagery: true, figures: [] });
});

test('workbook sheets: the tornado and options sheets read what the pages hand over', () => {
  const h = { optionsSummary: () => ({ rows: [{ label: 'A', err: 'boom' }, { label: 'B', why: '', fuel: 1 }], best: null, fast: true, stale: true }),
    calibration: () => null, tornadoMetrics: { npv: ['NPV', () => 1] }, MONTHS: [], HOURS: 0 };
  const sheets = sheetsB({ P: { econ: { currency: 'USD' } }, SIM: null, OPT: null, OPTIONS: {}, TORNADO: null, forecast: null, h });
  assert.deepEqual(sheets.map((s) => s.name), ['Options']);
  const rows = sheets[0].rows;
  assert.equal(rows[1][18], 'boom');
  assert.ok(rows.some((r) => r[0] === 'Note'));
});

test('svg text from the pages: scripts, handlers and foreign links are removed (needs DOMParser)', { skip: typeof DOMParser === 'undefined' }, () => {
  const svg = cleanSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><a href="javascript:x()" onclick="x()"><rect/></a></svg>');
  assert.ok(svg && !svg.querySelector('script') && !svg.querySelector('[onclick]') && !svg.querySelector('[href]'));
});
