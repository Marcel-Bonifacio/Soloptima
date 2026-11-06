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
import { summary as ryStats, fmt as ryFmt } from './lib/ry-view.js';
import { legacy } from './lib/legacy.js';

mount(App, { target: document.getElementById('ui-root') });

// schema forms placed in the old workspace: <div class="form" data-ui-form="name">
for (const el of document.querySelectorAll('[data-ui-form]')) mount(SchemaForm, { target: el, props: { name: el.dataset.uiForm } });

// the results screens (rows 3.4): <div data-ui-view="name"> places one in the old workspace
const VIEWS = { 'sim-bar': SimBar, stale: Stale, 'sim-kpis': SimKpis, 'sim-metrics': SimMetrics, 'sim-mix': SimMix, 'sim-monthly': SimMonthly,
  'sim-dispatch': SimDispatch, 'sim-cash': SimCash, 'sim-years': SimYears, 'opt-bar': OptBar, 'opt-results': OptResults, 'fin-results': FinResults,
  'resource-years': ResourceYears, 'pv-loss': PvLoss, 'sun-path': SunPath };
for (const el of document.querySelectorAll('[data-ui-view]')) mount(VIEWS[el.dataset.uiView], { target: el });

// the weather-year figures of the open project for the old report and workbook, and what the PV page and the layout hand over
const ry = {
  summary: () => { const P = legacy.project(), R = P.resource_years; return ryStats(R.result, R.applied, P.finance.p90_factor, legacy.ryKey()); },
  fmt: (k, v) => ryFmt(k, v, legacy.project().econ.currency),
};
const reset = () => { resetResults(); resetRy(); };
window.SoloptimaUI = { refresh: refreshForms, migrate: migrateForms, runSim, reset, setStale, gotoWeek, setPvLosses, setSunShade, ry };

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
