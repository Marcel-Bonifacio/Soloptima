// Fingerprints of the engine inputs: they tell when a stored result no longer matches the project.
// Stringifying the engine project takes a few ms (about 0.6 MB): call these on render, tab change, report build and project save,
// never per keystroke.
import { W } from './state.js';
import { engineProject } from './core.js';
import { projectKey as keyOf, inputDiff, inputSnapshot, diffList } from './diff.js';

// Fingerprint of an engine project (default: the open one)
export const projectKey = (p = engineProject()) => keyOf(p);
// Engine inputs of a simulation: without the name (engineProject already leaves out the zone name and where the offset came from;
// the site elevation sets the air pressure of the clear-sky, decomposition and spectral models).
export const simInputs = (p) => ({ ...p, name: '' });
// Fingerprint of the engine inputs of a simulation.
export const simKey = (p) => projectKey(simInputs(p));
// The result on show is from other inputs.
export const simStale = () => !!W.SIM && W.SIM.key !== simKey(engineProject());
// Inputs changed after the run on show, as a list of the first n ('' when none can be named).
export const simChanges = (n) => (W.SIM ? diffList(inputDiff(W.SIM.snap, inputSnapshot(simInputs(engineProject()))), n) : '');
// Fingerprint of the inputs the option rows depend on: every battery row sets its own strategy (and setpoint), rows without a
// battery ignore them, and the name is not an engine input.
export const optionsKey = () => projectKey(engineProject({ name: '', diesel: { ...W.P.diesel, strategy: '', cc_setpoint: 0 } }));
// Inputs the NPC of a design without a battery depends on: everything but the sizes the optimiser varies, the dispatch
// (every strategy reduces to load following without a battery) and the financing (not part of the NPC).
export function sizingKey() {
  const P = W.P;
  return projectKey(engineProject({ name: '', pv: { ...P.pv, capacity_kwp: 0 }, bess: { ...P.bess, energy_kwh: 0, power_kw: 0 },
    wind: { ...P.wind, units: 0 }, diesel: { ...P.diesel, strategy: '', cc_setpoint: 0 }, finance: null }));
}
