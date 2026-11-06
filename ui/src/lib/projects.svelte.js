// The signed-in profile's projects: list, create, import, open, duplicate, delete, and the autosave of the open project
import { app, show } from './state.svelte.js';
import { call } from './ipc.js';
import { invalidate } from './layout/map.svelte.js';
import { defaultProject } from './schema/index.js';
import { STORE_KEY, storeGet, storeSet } from './storage.js';
import { toast } from './toast.js';
import { W } from './ws/state.js';
import { exportProject as exportFile } from './ws/project.js';
import { meta } from './ws/project.js';
import { prepare } from './ws/project.js';
import { saveCopy } from './ws/project.js';
import { open as openInWorkspace } from './ws/project.js';
import { ask } from './ask.js';

export const TEMPLATES = {
  blank: { name: 'Blank project', desc: '1 MWp PV, 1 MWh battery, 4 × 500 kW gensets. Set your own site and load.' },
  example: { name: 'Example study', desc: 'Off-grid industrial site: 30 MWp PV, 6.6 MWh battery, 20 × 1.8 MW gensets, PVGIS data included.' },
  industrial: { name: 'Industrial 24/7', desc: 'Continuous process load, 5 MW average, 6 × 1.5 MW gensets.' },
  village: { name: 'Village mini-grid', desc: 'Evening-peaking residential load, 250 kW average, 3 × 200 kW gensets.' },
};
export const EXAMPLE_NAME = 'Example study: off-grid industrial site';

export async function loadProjects() {
  const u = app.user;
  app.projects = u ? await call('projects', { user: u.id }).catch(() => []) : [];
  if (u) u.projects = app.projects.length;
}

const saveProject = (p, id) => call('project_save', { user: app.user.id, id, body: { project: p, meta: meta(p) } });

async function buildTemplate(kind) {
  if (kind === 'example') return (await fetch('examples/example_study.json')).json();
  const p = defaultProject();
  if (kind === 'industrial') {
    Object.assign(p.load, { template: 'continuous', target_avg: 5000 });
    Object.assign(p.diesel, { unit_kw: 1500, units: 6 });
    Object.assign(p.pv, { capacity_kwp: 5000 });
    Object.assign(p.bess, { energy_kwh: 5000, power_kw: 2500 });
    p.equipment.sel.genset = null;
  }
  if (kind === 'village') {
    Object.assign(p.load, { template: 'residential', target_avg: 250, var_day: 0.08, var_hour: 0.05 });
    Object.assign(p.diesel, { unit_kw: 200, units: 3, min_units_online: 0 });
    Object.assign(p.pv, { capacity_kwp: 600 });
    Object.assign(p.bess, { energy_kwh: 1500, power_kw: 500 });
    p.equipment.sel.genset = null;
  }
  return p;
}

// Throws with the message to show
export async function createProject(kind, name) {
  if (!app.user) throw new Error('Create a profile first.');
  const p = await buildTemplate(kind);
  p.name = name;
  delete p.id;
  const meta = await saveProject(prepare(p));
  await loadProjects();
  await openProject(meta.id, 'site');
}

export async function importProject(file) {
  if (!app.user) { toast('Create a profile first.', true); return; }
  try {
    const p = JSON.parse(await file.text());
    if (!p || !p.location || !p.pv) throw new Error('This file is not a Soloptima project.');
    delete p.id;
    const meta = await saveProject(prepare(p));
    await loadProjects();
    await openProject(meta.id);
    toast('Imported ' + file.name);
  } catch (e) { toast('Could not import: ' + e.message, true); }
}

export async function openProject(id, tab) {
  try {
    const p = await call('project_load', { user: app.user.id, id });
    app.projectId = p.id || id;
    const t = openInWorkspace(p, tab);   // the workspace takes the project
    show('workspace');
    setTimeout(invalidate, 60);   // the map takes its size now that the workspace shows
    setSaveState('saved');
    history.replaceState(null, '', `#p=${id}&t=${t}`);
  } catch (e) { toast(e.message, true); show('home'); }
}

export async function duplicateProject(id) {
  try {
    await call('project_duplicate', { user: app.user.id, id, body: {} });
    await loadProjects();
    toast('Project duplicated');
  } catch (e) { toast(e.message, true); }
}

export async function deleteProject(p) {
  if (!(await ask(`Delete "${p.name || 'this project'}" from this computer? This cannot be undone. Export it first if you may need it again.`, 'Delete'))) return;
  try {
    await call('project_delete', { user: app.user.id, id: p.id, body: {} });
    await loadProjects();
  } catch (e) { toast(e.message, true); }
}

export async function exportProject(id) {
  try { exportFile(await call('project_load', { user: app.user.id, id })); } catch (e) { toast(e.message, true); }
}

// Projects edited before profiles existed live in browser storage: moved into the first profile once
export async function migrateLocal() {
  const s = storeGet(STORE_KEY);
  if (!s || storeGet('soloptima.migrated')) return;
  try {
    const p = JSON.parse(s);
    if (!p.id) {   // projects opened from disk carry an id; only pre-profile browser projects lack one
      await saveProject(prepare(p));
      toast('Moved the project from this browser into your saved projects.');
    }
    storeSet('soloptima.migrated', '1');
  } catch (e) { /* kept in browser storage */ }
}

// ---------------------------------------------------------------- autosave of the open project
let timer = null, saving = false, pending = false;

function setSaveState(state) {
  app.save = { state, at: state === 'saved' ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : app.save.at };
}

// Every edit of the open project calls this (autosave in ws/core.js)
export function queueSave() {
  const p = W.P;
  if (!app.user || !p || !p.id || app.screen !== 'workspace') return false;
  pending = true;
  setSaveState('dirty');
  clearTimeout(timer);
  timer = setTimeout(flush, 1200);
  return true;
}

// Saves the open project now; false when the save failed (the edits are still unsaved)
export async function flush() {
  clearTimeout(timer);
  while (saving) await new Promise((r) => setTimeout(r, 100));
  const p = W.P;
  if (!pending || !app.user || !p || !p.id) return true;
  saving = true;
  pending = false;
  setSaveState('saving');
  try {
    await call('project_save', { user: app.user.id, id: p.id, body: { project: saveCopy(), meta: meta(p) } });
    setSaveState('saved');
  } catch (e) {
    setSaveState('error');
    pending = true;
    toast('Could not save: ' + e.message, true);
  }
  saving = false;
  return !pending;
}

// Before Soloptima closes: true when the work is saved, or when the user closes anyway after a failed save
export async function readyToClose() {
  let saved = false;
  try { saved = await flush(); } catch (e) { /* treated as not saved */ }
  return saved || ask('Your latest changes could not be saved. Close Soloptima anyway?', 'Close anyway');
}

export function tabChanged(t) {
  const p = W.P;
  if (!p || !p.id) return;
  p.ui = { ...(p.ui || {}), tab: t };
  history.replaceState(null, '', `#p=${p.id}&t=${t}`);
}
