// The interface state: one object, read by the components and changed only by the functions of session.svelte.js,
// projects.svelte.js and update.svelte.js. The open project itself (large, edited in place by the old screens) is not
// kept here; `projectId` names it and legacy.project() returns it.
export const app = $state({
  screen: 'loading',   // loading | signin | home | workspace
  signin: { mode: 'choose', who: null },   // mode: choose | terms | new; who: the profile that must accept the terms
  users: [],           // the profiles of the data folder: {id, name, organisation, email, avatar, projects, terms_version, ...}
  user: null,          // the signed-in profile
  terms: { version: '', md: '' },   // TERMS.md; its "Version" line decides who must accept again
  projects: [],        // the signed-in profile's projects (meta, newest first)
  projectId: null,     // the open project
  save: { state: 'saved', at: '' },   // saved | dirty | saving | error
  dialog: null,        // null | 'settings' | 'update' | 'legal'
  legalDoc: 'terms',   // terms | license | notices
  menuOpen: false,     // the profile menu of the top bar
});

// The screen, and the body classes the old style sheet and screens rely on (home-mode hides the workspace)
export function show(screen) {
  app.screen = screen;
  document.body.classList.toggle('home-mode', screen !== 'workspace');
  document.body.classList.toggle('signin-mode', screen === 'signin');
}

export const accepted = (u) => !!(u && app.terms.version && u.terms_version === app.terms.version);

export function openDialog(name, doc) {
  app.menuOpen = false;
  if (name === 'legal') app.legalDoc = doc || 'terms';
  app.dialog = name;
}

// Bumped whenever the old screens change the open project (web/js/schema.js syncForms); the schema forms read it again
export const forms = $state({ rev: 0 });
export const refreshForms = () => { forms.rev++; };
