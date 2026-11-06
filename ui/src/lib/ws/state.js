// The open project and the last results of the workspace (docs/ui.md). Plain object, not Svelte state: the project is edited in
// place and a proxy around it would slow the engine code. Components read it again when `forms.rev` or `res.rev` changes.
//   P        the project (inputs)           PVR     last PV yield result      PVREF  last PVGIS reference yield
//   SIM      last simulation response       SIM_PREV the run before it        OPT    last optimisation result
//   SCHED    last day-ahead schedule        OPTIONS last operating-options comparison    TORNADO last tornado run
export const W = { P: null, PVR: null, PVREF: null, SIM: null, SIM_PREV: null, OPT: null, SCHED: null, OPTIONS: null, TORNADO: null };
export const project = () => W.P;
