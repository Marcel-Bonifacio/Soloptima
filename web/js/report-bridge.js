// What the Svelte report (ui/src/lib/report, docs/ui.md) needs from the screens not ported yet: the results and their summaries,
// the electrical design, the equipment library and the chart drawing. Each session that ports one of those screens replaces
// the entry that reads it; when the object is empty, this file goes.
'use strict';

window.SoloptimaLegacy.report = {
  inputs: () => ({ P, SIM, OPT, OPTIONS, TORNADO, PVR, PVREF, design: Electrical.design, sld: SLD.svg, forecast: ForecastLab.result, tornadoMetrics: TORNADO_METRICS }),
  // are the simulation inputs different from the last run, and which (for the note in the report and the workbook)
  stale: () => ({ stale: simStale(), changes: simChanges(12), predictive: P.diesel.strategy === 'predictive' }),
  // the charts the report takes its pictures from, drawn for the open project (hidden ones as well)
  prepare() {
    try { drawWeather(); drawLoad(); } catch (e) { /* charts are optional */ }
    Electrical.render();
    drawPvBalance();
    if (SIM) { drawFlow(); const K = calibration(); if (K && K.monthly) drawCalibration(); }
  },
  electrical: () => Electrical.render(),
  drawLowWeek: (hour, socTarget) => dispatchChart('chDispatchRep', SIM.result.hourly, hour, 168, { socTarget }),
  purgeLowWeek: () => Plotly.purge('chDispatchRep'),
  helpers: () => ({
    MONTHS, HOURS, flatten, monthlySum, dateOfHour, weatherAtSite, fmtPower, fmtArea, fmtOffset,
    calibration, calFmt, calPct, energyFlow, monthBalance, optionsSummary, tornadoSummary, tornadoFmt, tornadoSwing, tornadoUnit, tornadoPct,
    bessHealth, bessThreshold, pvBalance, pvRefText, weekPicks, yearList,
    selected: (t) => Equipment.selected(t), eqTypes: EQ_TYPES,
    quality: (kind) => TsImport.quality(kind), tsRows: () => TsImport.sheetRows(), finRows: (host) => Finance.ROWS(host),
  }),
};
