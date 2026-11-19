// What the report reads from the open project and the pages: the results, the summaries of the cards and their helpers
//.
import { W } from '../ws/state.js';
import { flatten } from '../ws/diff.js';
import { weatherAtSite } from '../ws/util.js';
import { simStale, simChanges } from '../ws/keys.js';
import { HOURS, MONTHS, monthlySum, dateOfHour } from '../series.js';
import { fmtPower, fmtArea, fmtOffset } from '../format.js';
import { design, sldText, protection, tccText } from '../equip/electrical.svelte.js';
import { selectedIn, EQ_TYPES } from '../equip/library.js';
import { result as forecastResult } from '../forecast.svelte.js';
import { sheetRows } from '../tsimport/texts.js';
import { calibration, calFmt, calPct, energyFlow, monthBalance, bessHealth, bessThreshold, weekPicks, yearList } from '../sim.svelte.js';
import { optionsSummary } from '../options.svelte.js';
import { tornadoSummary, tornadoFmt, tornadoSwing, tornadoUnit, tornadoPct, TORNADO_METRICS } from '../tornado.svelte.js';
import { pvBalance, pvRefText } from '../pv.svelte.js';
import { resilStale } from '../resilience.svelte.js';
import { finRows } from '../finance.svelte.js';
import { meterResult } from '../pvmeter.svelte.js';

export const inputs = () => ({ P: W.P, SIM: W.SIM, OPT: W.OPT, OPTIONS: W.OPTIONS, TORNADO: W.TORNADO, RESIL: W.RESIL, PVR: W.PVR, PVREF: W.PVREF,
  design: design(), prot: protection(), sld: sldText(true), tcc: tccText(), forecast: forecastResult(), tornadoMetrics: TORNADO_METRICS });

// are the simulation inputs different from the last run, and which (for the note in the report and the workbook)
export const stale = () => ({ stale: simStale(), changes: simChanges(12), predictive: W.P.diesel.strategy === 'predictive' });

export const helpers = () => ({
  MONTHS, HOURS, flatten, monthlySum, dateOfHour, weatherAtSite: () => weatherAtSite(W.P), fmtPower, fmtArea, fmtOffset,
  calibration, calFmt, calPct, energyFlow, monthBalance, optionsSummary, tornadoSummary, tornadoFmt, tornadoSwing, tornadoUnit, tornadoPct,
  bessHealth, bessThreshold, pvBalance, pvRefText, weekPicks, yearList, resilStale,
  selected: (t) => selectedIn(W.P, t), eqTypes: EQ_TYPES,
  tsRows: () => sheetRows(W.P), finRows, pvMeter: meterResult,
});
