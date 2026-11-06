// Profiles, terms of use, sign-in and the hash route (#p=<project>&t=<tab>)
import { app, show, accepted } from './state.svelte.js';
import { call, listen } from './ipc.js';
import { storeGet, storeSet } from './storage.js';
import { loadProjects, openProject, flush, readyToClose, migrateLocal } from './projects.svelte.js';
import { autoCheck } from './update.svelte.js';
import { toast } from './toast.js';
import { showTab } from './ws/tabs.svelte.js';
import { ask } from './ask.js';

const KEY_USER = 'soloptima.user';

export async function boot() {
  listen('quit-request', async () => {   // the window asks before it closes: save, then let it go
    call('quit_ack').catch(() => {});
    call((await readyToClose()) ? 'quit_ready' : 'quit_cancel').catch(() => {});
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (app.save.state !== 'saved') { flush(); e.preventDefault(); } });
  await loadTerms();
  await refreshUsers();
  const last = app.users.find((u) => u.id === storeGet(KEY_USER));
  if (last && accepted(last)) await signIn(last.id);
  else toSignIn(last ? 'terms' : 'choose', last);
}

async function loadTerms() {
  try {
    const md = await call('legal', { doc: 'terms' });
    app.terms = { md, version: (md.match(/^Version\s+([\w.]+)/m) || [])[1] || '' };
  } catch (e) { /* the sign-in page says the terms are missing */ }
}

export async function refreshUsers() {
  try { app.users = await call('users'); } catch (e) { app.users = []; toast(e.message, true); }
}

// Profiles are local and have no password: projects are plain files in the data folder, so a password would protect
// nothing. A profile must accept the current terms of use before it can open the app.
export function toSignIn(mode, who = null) {
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (mode === 'choose' && !app.users.length) mode = 'new';
  app.signin = { mode, who: who ? { ...who } : null };
  app.menuOpen = false;
  show('signin');
}

export async function signIn(id) {
  const u = app.users.find((x) => x.id === id);
  if (!u) { toSignIn('choose'); return; }
  app.user = u;
  storeSet(KEY_USER, u.id);
  await migrateLocal();
  await loadProjects();
  await route();
  autoCheck();   // after sign-in: no service is contacted before the terms are accepted
}

export async function createProfile({ name, organisation, email }) {
  const r = await call('user_create', { body: { name, organisation, email, terms_version: app.terms.version } });
  await refreshUsers();
  await signIn(r.id);
}

export async function acceptTerms(who) {
  await call('users_terms', { id: who.id, body: { version: app.terms.version } });
  await refreshUsers();
  await signIn(who.id);
}

export function chooseProfile(u) {
  if (accepted(u)) signIn(u.id);
  else toSignIn('terms', u);
}

export async function switchUser(id) {
  await flush();
  const u = app.users.find((x) => x.id === id);
  if (!accepted(u)) { app.user = null; toSignIn('terms', u); return; }
  app.user = u;
  storeSet(KEY_USER, u.id);
  if (location.hash) history.pushState(null, '', location.pathname);
  await loadProjects();
  show('home');
  app.menuOpen = false;
}

export async function signOut() {
  await flush();
  app.user = null;
  storeSet(KEY_USER, '');
  toSignIn('choose');
}

export async function removeProfile() {
  const u = app.user;
  if (!(await ask(`Remove the profile "${u.name}" and all ${u.projects} of its saved projects from this computer? This cannot be undone.`, 'Remove'))) return;
  try {
    await call('users_delete', { id: u.id, body: {} });
    await refreshUsers();
    app.user = null;
    storeSet(KEY_USER, '');
    toSignIn('choose');
  } catch (e) { toast(e.message, true); }
}

// The profile's own fields; `avatar` is a data URL or ''
export async function updateProfile(fields) {
  const u = await call('users_update', { id: app.user.id, body: fields });
  app.user = { ...u, projects: app.user.projects };
  app.users = app.users.map((x) => (x.id === u.id ? app.user : x));
}

// After the data folder changed: the same profile carries on (its data was copied), otherwise choose one from the new folder.
// True when the profile carried on.
export async function folderChanged() {
  await refreshUsers();
  const same = app.users.find((u) => u.id === app.user.id);
  if (!same) {
    app.user = null;
    storeSet(KEY_USER, '');
    app.dialog = null;
    toSignIn('choose');
    return false;
  }
  app.user = same;
  await loadProjects();
  if (app.screen === 'workspace' && !app.projects.some((p) => p.id === app.projectId)) await goHome();
  return true;
}

export async function goHome() {
  await flush();
  if (!app.user) { toSignIn('choose'); return; }
  if (location.hash) history.pushState(null, '', location.pathname);
  await loadProjects();
  show('home');
}

export async function route() {
  if (!app.user) { toSignIn('choose'); return; }
  const m = (location.hash || '').match(/p=([\w-]+)(?:&t=(\w+))?/);
  if (!m) { show('home'); return; }
  if (app.projectId !== m[1] || app.screen !== 'workspace') await openProject(m[1], m[2]);
  else if (m[2]) showTab(m[2]);
}
