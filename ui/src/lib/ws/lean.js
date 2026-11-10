// Inputs added to the project since earlier versions go to the engine only when they are used, so a project that does not use
// them keeps the engine inputs, and the fingerprints of its saved results, it had (plain functions; ui/tests/fleet.test.js).
import { isMixed, engineGroups } from '../fleet-view.js';

// The diesel inputs: the further genset groups only for a mixed fleet
export function leanDiesel(d) {
  if (!d || !('more_groups' in d)) return d;
  const { more_groups, ...rest } = d;
  return isMixed(d) ? { ...rest, more_groups: engineGroups(d) } : rest;
}
// The EMS inputs: reserve_energy only when on
export function leanEms(e) {
  if (!e || !('reserve_energy' in e) || e.reserve_energy) return e;
  const { reserve_energy, ...rest } = e;
  return rest;
}
