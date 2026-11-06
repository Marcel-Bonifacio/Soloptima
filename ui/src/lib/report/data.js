// What the report and the workbook are made of: the open project, the results, the weather-year summary, the layout geometry and
// the summaries of the cards (report/inputs.js), gathered once per export.
import { inputs, stale, helpers } from './inputs.js';
import { ryKey } from '../data.svelte.js';
import { dispatchChart } from '../sim-view.js';
import { colours, baseLayout, PLOT_CFG } from '../chart.js';
import { summary as ryStats } from '../ry-view.js';
import { layoutGeom, layoutRows, layoutImagery } from './layout-geom.js';
import { userFigures } from './figures.js';
import { footprint } from '../layout/geometry.js';
// The charts of the old and new result screens the report takes its pictures from: [element id, width, height]
/** @type {[string, number?, number?][]} */
const CHARTS = [['chWxMonthly'], ['chRy'], ['chLoadDaily'], ['chPvLoss', 1000, 520], ['chPvMonthly'], ['chPvNorm'], ['chCal'], ['chFlow', 1000, 520], ['chOptFall'],
  ['chMonthly'], ['chDispatch', 1100, 620], ['chGenLoad'], ['chUnitsDur'], ['chSoh'], ['chSohLoss'], ['chCash'], ['chFinCash'], ['chFinCum'], ['chFinDscr'], ['chFinHost'],
  ['chOptHeat', 900, 520], ['chPareto', 900, 520], ['chSens'], ['chBenchLead']];

// A chart's picture as a PNG data URL on a white page ('' when it is not drawn)
async function chartImg(id, w = 1000, h = 420) {
  const el = /** @type {any} */ (document.getElementById(id));
  if (!el || !el.data || !el.layout || !window.Plotly) return '';
  const lay = JSON.parse(JSON.stringify(el.layout));
  lay.paper_bgcolor = '#ffffff'; lay.plot_bgcolor = '#ffffff';
  for (const k of Object.keys(lay)) if (/^[xy]axis/.test(k)) Object.assign(lay[k], { gridcolor: '#e6e6e6', linecolor: '#999' });
  try { return await window.Plotly.toImage({ data: el.data, layout: lay }, { format: 'png', width: w, height: h, scale: 1.5 }); } catch (e) { return ''; }
}

// The week with the lowest renewable share, drawn off screen for the report
function drawLowWeek(H, hour, socTarget) {
  const c = colours(), { traces, layout } = dispatchChart(H, hour, 168, socTarget, c);
  window.Plotly.react('chDispatchRep', traces, baseLayout(c, layout), PLOT_CFG);
}

// The data every part of the workbook and report reads (no pictures)
export function reportInputs() {
  const I = inputs(), h = helpers(), { P } = I;
  const st = stale();
  const note = st.stale ? `These results were computed before ${st.changes ? 'the following inputs changed: ' + st.changes : 'the inputs changed'}. Run the simulation again before issuing this report.` : '';
  const R = P.resource_years;
  const ry = R && R.result ? ryStats(R.result, R.applied, P.finance.p90_factor, ryKey()) : null;
  const G = layoutGeom(P, footprint);
  return { ...I, h, ry, G, layoutRows: layoutRows(P, G), cur: P.econ.currency, stale: { ...st, note } };
}

// Everything the report document needs, with its pictures
export async function reportData() {
  const D = reportInputs(), { P, SIM } = D;
  const IMG = {};
  for (const [id, w, hh] of CHARTS) IMG[id] = await chartImg(id, w, hh);
  if (D.TORNADO) { const n = D.h.tornadoSummary(P.tornado.metric).rows.filter((x) => !x.err).length; IMG.chTornado = await chartImg('chTornado', 1000, Math.max(300, 100 + 30 * n)); }
  if (SIM) {
    const low = D.h.weekPicks(SIM.result).re;
    if (low != null) { drawLowWeek(SIM.result.hourly, low, P.diesel.strategy === 'predictive'); IMG.chDispatchRep = await chartImg('chDispatchRep', 1100, 620); window.Plotly.purge('chDispatchRep'); }
  }
  const logo = await fetch('img/logo.svg').then((r) => (r.ok ? r.text() : '')).catch(() => '');
  const places = new Set(['site', 'pv']);
  if (D.design) places.add('electrical');
  if (SIM) places.add('simulation');
  return { ...D, IMG, logo, places, userFigs: userFigures(P), date: new Date().toISOString().slice(0, 10), img: D.G ? await layoutImagery(P, D.G) : '' };
}
