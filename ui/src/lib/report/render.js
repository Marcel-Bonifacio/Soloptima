// The report document: ReportDoc.svelte mounted on a detached element, copied into a new HTML document (its title, character set
// and style sheet set as elements, never as text), numbered, and serialised. No HTML is put together from strings.
import { mount, unmount, flushSync } from 'svelte';
import ReportDoc from '../../screens/report/ReportDoc.svelte';

const CSS = `body{font:11pt/1.5 Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:1000px;margin:24px auto;padding:0 28px}
.cover{border-bottom:3px solid #1a1a1a;padding:40px 0 24px;margin-bottom:24px}.cover .logo svg{display:block;height:30px;width:auto;margin-bottom:22px}.cover .tag{letter-spacing:.15em;font-size:9pt;color:#555}.cover h1{font-size:26pt;margin:8px 0}.sub{color:#444;font-size:12pt}
h2{font-size:15pt;border-bottom:1px solid #bbb;padding-bottom:4px;margin-top:32px;page-break-after:avoid}h3{font-size:11.5pt;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:9.5pt;page-break-inside:avoid}th,td{border:1px solid #ccc;padding:4px 7px;text-align:left}th{background:#f1f1f1}td.n{text-align:right;font-variant-numeric:tabular-nums}
table.meta td{border:none;padding:2px 12px 2px 0}figure{margin:12px 0 20px;page-break-inside:avoid}figure img,figure svg{width:100%;height:auto;border:1px solid #ddd}figure.layout svg{max-height:900px}figure.user img{width:auto;max-width:100%;max-height:850px;display:block;margin:0 auto}figcaption{font-size:9pt;color:#555;margin-top:4px}
.warn{border:1px solid #c98500;background:#fff8e6;padding:8px 12px;font-size:9.5pt}@media print{body{margin:0;max-width:none}h2{page-break-before:auto}figure.sld{page-break-before:always}}`;

// D: the data of data.js. Returns the whole document as text.
export function renderReport(D) {
  const host = document.createElement('div');
  const app = mount(ReportDoc, { target: host, props: { D } });
  flushSync();
  const doc = document.implementation.createHTMLDocument('Soloptima report: ' + (D.P.name || 'project'));
  doc.documentElement.lang = 'en';
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const style = doc.createElement('style');
  style.textContent = CSS;
  doc.head.append(style);
  for (const n of host.childNodes) doc.body.append(doc.importNode(n, true));
  unmount(app);
  // sections and figures are numbered in document order
  doc.querySelectorAll('h2').forEach((e, i) => e.prepend(`${i + 1}. `));
  doc.querySelectorAll('figcaption').forEach((e, i) => e.prepend(`Figure ${i + 1}. `));
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
