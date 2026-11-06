// The screens not ported yet (web/js), reached only through window.SoloptimaLegacy (web/js/app.js). Each later session
// that ports a screen removes what it no longer needs from both sides.
const L = () => window.SoloptimaLegacy;

export const legacy = {
  project: () => L().project(),
  storeKey: () => L().storeKey,
  forms: (name) => L().forms(name),
  onFieldChange: (key) => L().onFieldChange(key),
  hasHelp: (key) => L().hasHelp(key),
  prepare: (p) => L().prepare(p),
  defaultProject: () => L().defaultProject(),
  meta: (p) => L().meta(p),
  saveCopy: () => L().saveCopy(),
  open: (p, tab) => L().open(p, tab),
  shown: () => L().shown(),
  showTab: (t) => L().showTab(t),
  exportProject: (p) => L().exportProject(p),
  clearReportCache: () => L().clearReportCache(),
  toast: (msg, err) => (L() ? L().toast(msg, err) : console.error(msg)),
  reports: (kind) => L().reports(kind),
  apiError: (cmd, msg, status, unexpected) => { if (L()) L().apiError(cmd, msg, status, unexpected); },
};
