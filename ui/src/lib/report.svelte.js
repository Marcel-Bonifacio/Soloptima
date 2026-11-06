// The report and export page: the preview, the HTML report, printing and the Excel workbook (rows 3.7-3.8). The text of the
// report is the Svelte document of screens/report; the workbook is made by lib/report/sheets-*.js.
import { call, saveFile } from './ipc.js';
import { legacy } from './legacy.js';
import { runSim } from './results.svelte.js';
import { reportData, reportInputs } from './report/data.js';
import { renderReport } from './report/render.js';
import { sheetsA } from './report/sheets-a.js';
import { sheetsB } from './report/sheets-b.js';
import { xlsx } from './report/xlsx.js';

export const rep = $state({ html: '', building: false, busy: false, rev: 0 });
let seq = 0, timer;

const stem = () => (legacy.project().name || 'project').replace(/[^\w\- ]+/g, '_');

// A simulation from other inputs is run again before an export when that is quick (rule-based dispatch, about a second); a
// predictive run takes much longer, so its report and workbook say which inputs changed instead.
async function freshSim() {
  const st = legacy.report().stale();
  if (!st.stale || st.predictive) return;
  legacy.toast('The inputs changed after the last simulation: simulating again…');
  await runSim(true);
}
const build = async () => renderReport(await reportData());

// The preview is built again after the latest change only; a slow build (the satellite image takes seconds) never replaces a newer one
export async function preview() {
  const n = ++seq;
  rep.building = true;
  try {
    const html = await build();
    if (n === seq) rep.html = html;
  } catch (e) {
    if (n === seq) { rep.html = ''; legacy.toast('The report could not be built: ' + e.message, true); }
  }
  if (n === seq) rep.building = false;
}
export function previewLater(ms) { clearTimeout(timer); timer = setTimeout(preview, ms); }
// the page opens: the figures list and the preview are made again for the open project
export function shown() { rep.rev++; preview(); }

async function task(fn) {
  if (rep.busy) return;
  rep.busy = true;
  try { await fn(); } catch (e) { legacy.toast(e.message || 'Export failed.', true); }
  rep.busy = false;
}
export const exportHtml = () => task(async () => {
  await freshSim();
  legacy.toast('Building report…');
  await saveFile(stem() + '_report.html', await build(), 'text/html');
});
// printed by the shell from a window of its own with no app access and no scripts
export const printPdf = () => task(async () => {
  await freshSim();
  legacy.toast('Building report…');
  const html = await build();
  try { await call('print_report', { html }); } catch (e) { legacy.toast(e.message || 'Printing failed.', true); }
});
export function workbook() {
  const D = reportInputs();
  return xlsx([...sheetsA(D), ...sheetsB(D)]);
}
export const exportXlsx = () => task(async () => {
  await freshSim();
  const blob = workbook();
  await saveFile(stem() + '_results.xlsx', blob, blob.type);
});
