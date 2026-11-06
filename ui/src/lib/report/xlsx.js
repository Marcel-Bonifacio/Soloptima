// A minimal .xlsx writer: sheets of rows (numbers, booleans, text) in a stored ZIP. Text goes in as inline strings, never as
// formulas, and every value is escaped for XML.
import { zip } from './zip.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export const xesc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
export const colName = (i) => {
  let s = ''; i++;
  while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

export function sheetXml(rows) {
  const out = [`${XML}<worksheet xmlns="${SS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>`], refs = [];
  rows.forEach((r, ri) => {
    out.push(`<row r="${ri + 1}">`);
    r.forEach((v, ci) => {
      if (v == null || v === '') return;
      const ref = (refs[ci] || (refs[ci] = colName(ci))) + (ri + 1), s = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && isFinite(v)) out.push(`<c r="${ref}"${s}><v>${+v.toPrecision(12)}</v></c>`);
      else if (typeof v === 'boolean') out.push(`<c r="${ref}" t="b"${s}><v>${v ? 1 : 0}</v></c>`);
      else out.push(`<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`);
    });
    out.push('</row>');
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const STYLES = `${XML}<styleSheet xmlns="${SS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// sheets: [{name, rows: [[...]]}] -> Blob
export function xlsx(sheets) {
  const enc = new TextEncoder(), f = (name, s) => ({ name, data: enc.encode(s) });
  const names = sheets.map((s, i) => (String(s.name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)) || 'Sheet' + (i + 1));
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  return zip([
    f('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${ct}.worksheet+xml"/>`).join('')}</Types>`),
    f('_rels/.rels', `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    f('xl/workbook.xml', `${XML}<workbook xmlns="${SS}" xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    f('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
    f('xl/styles.xml', STYLES),
    ...sheets.map((s, i) => f(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows))),
  ], XLSX_TYPE);
}
