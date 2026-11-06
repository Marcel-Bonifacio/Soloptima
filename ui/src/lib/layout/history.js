// The undo snapshots of the layout map: the drawn items, the tables taken out and the plant's stations as one text, and its way
// back into cleaned values. No map here, so ui/tests/siteplan.test.js runs this under Node.
import { cleanItem, cleanRemoved } from './items.js';
import { cleanStations } from './stations.js';

export const snapshotOf = (L) => JSON.stringify({ polygons: L.polygons || [], removed: L.removed || [], stations: L.stations || [] });

// { items, removed, stations } of a snapshot, cleaned as a project file is
export function parseSnapshot(text) {
  const st = JSON.parse(text);
  return { items: (Array.isArray(st.polygons) ? st.polygons : []).map(cleanItem).filter(Boolean), removed: cleanRemoved(st.removed), stations: cleanStations(st.stations) };
}
