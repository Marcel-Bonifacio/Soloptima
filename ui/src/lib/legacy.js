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
  // the results screens (3.4): what a run needs from the open project, and the hand-over of its result
  ryKey: () => L().ryKey(),
  ryRequest: () => L().ryRequest(),
  simRequest: () => L().simRequest(),
  setSim: (sim, prev) => L().setSim(sim, prev),
  simShown: () => L().simShown(),
  afterRerun: () => L().afterRerun(),
  optRequest: () => L().optRequest(),
  setOpt: (opt) => L().setOpt(opt),
  changedText: (a, b) => L().changedText(a, b),
  monthBalance: (R) => L().monthBalance(R),
  weekPicks: (R) => L().weekPicks(R),
  sensLabel: (v) => L().sensLabel(v),
  applySize: (r) => L().applySize(r),
  exportCsv: () => L().exportCsv(),
  finRows: (host) => L().finRows(host),
  finCsv: () => L().finCsv(),
  // the report (3.7): what the old screens still hold for it (`SoloptimaLegacy.report` in web/js/app.js)
  report: () => L().report,
  apiError: (cmd, msg, status, unexpected) => { if (L()) L().apiError(cmd, msg, status, unexpected); },
};
