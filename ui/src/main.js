// Entry of the Svelte interface (docs/ui.md). Runs before the old screens' DOMContentLoaded handler (web/js/app.js), so the
// top bar it renders is in place when they wire its buttons, and `Home` is ready for their calls.
import { mount } from 'svelte';
import App from './App.svelte';
import SchemaForm from './lib/SchemaForm.svelte';
import { app, openDialog, refreshForms } from './lib/state.svelte.js';
import { boot } from './lib/session.svelte.js';
import { queueSave, flush, tabChanged } from './lib/projects.svelte.js';

mount(App, { target: document.getElementById('ui-root') });

// schema forms placed in the old workspace: <div class="form" data-ui-form="name">
for (const el of document.querySelectorAll('[data-ui-form]')) mount(SchemaForm, { target: el, props: { name: el.dataset.uiForm } });

window.SoloptimaUI = { refresh: refreshForms };

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
