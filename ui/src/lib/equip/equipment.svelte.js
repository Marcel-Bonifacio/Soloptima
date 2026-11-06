// The equipment datasheet library of the open project (project.equipment): which type is shown, which datasheet is open in the
// editor, and every change to the library. The library belongs to the project (the open project's object, saved with it), so
// this store holds only what the screen needs; `rev` is bumped after each change and the components read it again.
import { saveFile } from '../ipc.js';
import { EQ_TYPES, defaultLibrary, findIn, newId, applyToModel, exportCsv, importCsv, importJson } from './library.js';
import { toast } from '../toast.js';
import { W } from '../ws/state.js';
import { onFieldChange } from '../ws/project.js';
import { refreshForms } from '../state.svelte.js';

export const eq = $state({ type: 'pv', editId: null, rev: 0, active: false });

const P = () => W.P;
const lib = () => P().equipment.lib;

function changed(key = 'equipment') {
  onFieldChange(key);
  eq.rev++;
}

export const setActive = (on) => { eq.active = on; if (on) eq.rev++; };
export const resetEquipment = () => { eq.editId = null; eq.rev++; };

export function setType(t) { eq.type = t; eq.editId = null; }
export const edit = (id) => { eq.editId = id; };

export function add() {
  const e = { id: newId(eq.type), name: 'New datasheet', manufacturer: '' };
  lib()[eq.type].push(e);
  eq.editId = e.id;
  changed();
}

export function duplicate(id) {
  const src = findIn(lib(), eq.type, id);
  if (!src) return;
  const c = { ...src, id: newId(eq.type) };
  c.name = (c.name || '') + ' (copy)';
  lib()[eq.type].push(c);
  eq.editId = c.id;
  changed();
}

export function remove(id) {
  if (!confirm('Delete this datasheet?')) return;
  lib()[eq.type] = lib()[eq.type].filter((e) => e.id !== id);
  if (eq.editId === id) eq.editId = null;
  changed();
}

export function use(id) {
  P().equipment.sel[eq.type] = id;
  changed();
}

// a value typed in the editor: numbers become numbers, a blank number is null
export function setField(id, key, raw) {
  const e = findIn(lib(), eq.type, id), f = EQ_TYPES[eq.type].fields.find((x) => x[0] === key);
  if (!e || !f) return;
  e[key] = f[2] === 'num' ? (raw === '' ? null : +raw) : raw;
  changed();
}

export function restoreGeneric() {
  if (!confirm('Restore the built-in generic library? Your own entries in this project are removed.')) return;
  P().equipment.lib = defaultLibrary();
  eq.editId = null;
  changed();
}

export function apply() {
  const p = P(), { msg, skipped } = applyToModel(p);
  refreshForms();
  onFieldChange('equipment.apply');
  eq.rev++;
  toast(msg.length ? 'Applied to model: ' + msg.join(', ') + (skipped.length ? `. Not applied, outside the plausible range: ${skipped.join(', ')}.` : '')
    : 'Select datasheets first (radio button "Use").', skipped.length > 0);
}

export async function importFile(file) {
  if (!file) return;
  try {
    const txt = await file.text();
    if (/\.json$/i.test(file.name)) {
      toast(`Imported ${importJson(lib(), txt)} datasheets`);
    } else {
      const rows = importCsv(txt, eq.type);
      lib()[eq.type].push(...rows);
      toast(`Imported ${rows.length} ${EQ_TYPES[eq.type].label.toLowerCase()}`);
    }
    changed();
  } catch (e) { toast('Import failed: ' + e.message, true); }
}

export const exportJson = () => saveFile('equipment_library.json', JSON.stringify(lib(), null, 1), 'application/json');
export const exportCsvFile = () => saveFile(`datasheets_${eq.type}.csv`, exportCsv(lib(), eq.type), 'text/csv');
