// Project finance page store: the ownership model, presets, the tariff component table, the run button and the cash-flow export.
// The project is not Svelte state (lib/ws/state.js); `fin.rev` tells the page that the finance block changed.
import { W } from './ws/state.js';
import { autosave } from './ws/core.js';
import { showTab } from './ws/tabs.svelte.js';
import { onFieldChange } from './ws/project.js';
import { refreshForms } from './state.svelte.js';
import { runSim, data } from './results.svelte.js';
import { saveFile } from './ipc.js';
import { toast } from './toast.js';
import { presetValues, depFollow, editComponent, newComponent, cashflowCsv, finRows as rows } from './finance-view.js';

export const fin = $state({ rev: 0 });
const bump = () => { fin.rev++; };

export const reset = () => bump();

export function setModel(v) {
  W.P.finance.model = v;
  onFieldChange('finance.model');
  refreshForms(); bump();
}

export function applyPreset(id, label) {
  const v = presetValues(id, W.P.econ.currency);
  if (!v) return;
  Object.assign(W.P.finance, v);
  refreshForms(); bump(); autosave();
  toast(`Applied "${label}" terms. These are starting values; check them against the term sheet.`);
}

// Called by the workspace after a project value changed (keys that start with 'finance.')
export function onFinanceKey(key) {
  const F = W.P.finance, patch = depFollow(key, F, W.P.econ.lifetime);
  if (patch) { Object.assign(F, patch); refreshForms(); }
  bump();
}

export function editComp(i, field, raw) {
  const F = W.P.finance, c = F.components[i];
  if (!c) return;
  editComponent(c, field, raw, F.stage2_year > 0);
  autosave(); bump();
}
export function addComp() { W.P.finance.components.push(newComponent()); autosave(); bump(); }
export function delComp(i) { W.P.finance.components.splice(i, 1); autosave(); bump(); }

export async function runFin() {
  await runSim();
  showTab('fin');
}

export const finRows = (host) => rows(host);

export function finCsv() {
  const R = data.sim && data.sim.finance, text = cashflowCsv(R);
  if (text == null) return;
  saveFile((W.P.name || 'project') + '_cashflow.csv', text, 'text/csv');
}
