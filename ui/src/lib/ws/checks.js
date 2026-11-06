// The progress marks of the side navigation: which key steps are done.
import { zoneCheck } from './util.js';

export function checks(P, PVR, SIM) {
  const site = !!(P.location && isFinite(P.location.lat));
  const weather = !!(P.weather && P.weather.ghi && P.weather.ghi.length >= 8760);
  const load = !!(P.load.kw && P.load.kw.length === 8760);
  const tzWarn = !!(P.location && zoneCheck(P.location).warn);
  const steps = [site, !!(P.weather && P.weather.ghi), load, !!PVR, !!SIM, !!(SIM && SIM.finance)];
  const done = steps.filter(Boolean).length;
  return { ok: { site, resource: weather, load, pv: !!PVR }, tzWarn, done, total: steps.length };
}
