// Entry of the Svelte interface (docs/ui.md). Runs before the old screens' DOMContentLoaded handler (web/js/app.js), so the
// top bar it renders is in place when they wire its buttons, and `Home` is ready for their calls.
import { mount } from 'svelte';
import App from './App.svelte';
import SchemaForm from './lib/SchemaForm.svelte';
import { app, openDialog, refreshForms } from './lib/state.svelte.js';
import { boot } from './lib/session.svelte.js';
import { migrateForms } from './lib/migrate.js';
import { queueSave, flush, tabChanged } from './lib/projects.svelte.js';
import { runSim, reset as resetResults, setStale, gotoWeek } from './lib/results.svelte.js';
import { resetRy } from './lib/resource-years.svelte.js';
import SimBar from './screens/results/SimBar.svelte';
import Stale from './screens/results/Stale.svelte';
import SimKpis from './screens/results/SimKpis.svelte';
import SimMetrics from './screens/results/SimMetrics.svelte';
import SimMix from './screens/results/SimMix.svelte';
import SimMonthly from './screens/results/SimMonthly.svelte';
import SimDispatch from './screens/results/SimDispatch.svelte';
import SimCash from './screens/results/SimCash.svelte';
import SimYears from './screens/results/SimYears.svelte';
import OptBar from './screens/results/OptBar.svelte';
import OptResults from './screens/results/OptResults.svelte';
import FinResults from './screens/results/FinResults.svelte';
import ResourceYears from './screens/results/ResourceYears.svelte';
import PvLoss from './screens/results/PvLoss.svelte';
import SunPath from './screens/results/SunPath.svelte';
import { setPvLosses, setSunShade } from './lib/plant.svelte.js';
import ReportPage from './screens/report/ReportPage.svelte';
import { shown as reportShown } from './lib/report.svelte.js';
import { cleanReport } from './lib/report/figures.js';
import { clearImageryCache } from './lib/report/layout-geom.js';
import { xlsx } from './lib/report/xlsx.js';
import { legacy } from './lib/legacy.js';
import ForecastLab from './screens/forecast/ForecastLab.svelte';
import { resetForecast, result as forecastResult } from './lib/forecast.svelte.js';
import ConsolePage from './screens/console/ConsolePage.svelte';
import TsImportDialog from './screens/tsimport/TsImportDialog.svelte';
import QcBlock from './screens/tsimport/QcBlock.svelte';
import { openImport, runQc, qcLater, qcRefresh } from './lib/tsimport.svelte.js';
import { quality as tsQuality, sheetRows as tsSheetRows } from './lib/tsimport/texts.js';
import EquipPage from './screens/equip/EquipPage.svelte';
import ElecPage from './screens/equip/ElecPage.svelte';
import { setActive as eqActive, resetEquipment } from './lib/equip/equipment.svelte.js';
import { setActive as elActive, resetElectrical, pvChanged, design, sldText } from './lib/equip/electrical.svelte.js';
import { defaultLibrary, migrateEquipment, selectedIn, EQ_TYPES } from './lib/equip/library.js';

mount(App, { target: document.getElementById('ui-root') });

// schema forms placed in the old workspace: <div class="form" data-ui-form="name">
for (const el of document.querySelectorAll('[data-ui-form]')) mount(SchemaForm, { target: el, props: { name: el.dataset.uiForm } });

// the results screens (rows 3.4): <div data-ui-view="name"> places one in the old workspace
const VIEWS = { 'sim-bar': SimBar, stale: Stale, 'sim-kpis': SimKpis, 'sim-metrics': SimMetrics, 'sim-mix': SimMix, 'sim-monthly': SimMonthly,
  'sim-dispatch': SimDispatch, 'sim-cash': SimCash, 'sim-years': SimYears, 'opt-bar': OptBar, 'opt-results': OptResults, 'fin-results': FinResults,
  'resource-years': ResourceYears, 'pv-loss': PvLoss, 'sun-path': SunPath, report: ReportPage, equip: EquipPage, elec: ElecPage, 'forecast-lab': ForecastLab, console: ConsolePage, 'ts-import': TsImportDialog };
for (const el of document.querySelectorAll('[data-ui-view]')) mount(VIEWS[el.dataset.uiView], { target: el });

// the data checks under the annual weather summary and the load statistics
for (const [id, kind] of [['wxQc', 'weather'], ['loadQc', 'load']]) mount(QcBlock, { target: document.getElementById(id), props: { kind } });

// what the PV page and the layout hand over, and what the old scripts call for the report (rows 3.7-3.8)
const reset = () => { resetResults(); resetRy(); resetEquipment(); resetElectrical(); resetForecast(); };
window.SoloptimaUI = { refresh: refreshForms, migrate: migrateForms, runSim, reset, setStale, gotoWeek, setPvLosses, setSunShade,
  cleanReport, clearReportCache: clearImageryCache, reportShown, xlsx,
  // the equipment library and the electrical design (rows 3.9-3.10)
  defaultLibrary, migrateEquipment, pvChanged, design: () => design(true), sldText,
  equipment: { selected: selectedIn, types: EQ_TYPES },
  forecast: forecastResult,
  // the CSV import and the data checks (row 3.11)
  tsOpen: openImport, runQc, qcLater, qcRefresh, tsQuality: (kind) => tsQuality(kind, legacy.project()), tsRows: () => tsSheetRows(legacy.project()),
  tabShown: (name) => { eqActive(name === 'equip'); elActive(name === 'elec'); } };

// What the old screens call (web/js/app.js, reports.js)
window.Home = {
  boot,
  queueSave,
  flush,
  tabChanged,
  current: () => (app.user ? { ...app.user } : null),
  showLegal: (doc) => openDialog('legal', doc),
  openSettings: () => openDialog('settings'),
};
