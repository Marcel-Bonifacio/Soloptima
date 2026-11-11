// Which page of the workspace is open (docs/ui.md). `showTab` also keeps what depends on it: the address, the pages that compute
// only while open, the report preview and the map size.
import { tabChanged } from '../projects.svelte.js';
import { fullScreen, invalidate } from '../layout/map.svelte.js';
import { shown as reportShown } from '../report.svelte.js';
import { setActive as eqActive } from '../equip/equipment.svelte.js';
import { setActive as elActive } from '../equip/electrical.svelte.js';
import { note } from '../reports/trail.js';

export const STEP_ORDER = ['site', 'resource', 'load', 'pv', 'bess', 'diesel', 'econ', 'equip', 'elec', 'sim', 'variants', 'opt', 'ems', 'fin', 'script', 'report'];
export const ws = $state({ tab: 'site', live: false });   // live: the "live" box of the simulation page (run again after every edit)

export function showTab(name) {
  fullScreen(false);   // a full-screen map would otherwise come back over the next page
  if (ws.tab !== name) note('page', name);
  ws.tab = name;
  tabChanged(name);
  if (name === 'site') setTimeout(invalidate, 50);
  if (name === 'report') reportShown();
  eqActive(name === 'equip'); elActive(name === 'elec');
  window.scrollTo({ top: 0 });
}
