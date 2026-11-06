// Small helpers of the workspace.
import { HOURS, MONTHS, MDAYS } from '../series.js';
import { zoneOffsets } from '../zone.js';

export const clone = (o) => JSON.parse(JSON.stringify(o));
export const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };
export const optionLabel = (list, v) => (list.find(([k]) => k === v) || [v, v])[1];   // label of value v in [value, label] options

export const MONTH_OF_HOUR = (() => {
  const m = new Uint8Array(HOURS); let h = 0;
  MDAYS.forEach((d, i) => { for (let k = 0; k < d * 24; k++) m[h++] = i; });
  return m;
})();

// 24 x 365 matrix for heatmaps (rows = hour, cols = day)
export function dayHourMatrix(arr, scale = 1) {
  const z = Array.from({ length: 24 }, () => new Array(365));
  for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) z[h][d] = arr[d * 24 + h] * scale;
  return z;
}

// The site's zone from the bundled offline lookup (vendor/tz-lookup.js; nothing leaves the computer) with its offsets, or null
export function siteZone(lat, lon) {
  try {
    const tz = typeof tzlookup === 'function' ? tzlookup(+lat, +lon) : '';
    return tz ? { tz, ...zoneOffsets(tz) } : null;
  } catch (e) { return null; }
}
// The site's zone (location.tz) against its UTC offset; warn when it needs checking: no zone found, an offset kept from an older
// project that differs, or a zone with more than two offsets in the year. A typed offset that differs does not warn.
export function zoneCheck(loc) {
  let z = null;
  try { if (loc.tz) z = { tz: loc.tz, ...zoneOffsets(loc.tz) }; } catch (e) { /* unknown zone name */ }
  const differs = !!z && Math.abs(+loc.utc_offset - z.std) > 1e-9;
  return { z, differs, warn: !z || z.irregular || (differs && loc.utc_offset_src !== 'typed') };
}
// Were the weather data fetched for this site (within 0.05°)? Only then is their elevation the site's.
export function weatherAtSite(P) {
  const W = P && P.weather, L = P && P.location;
  return !!(W && L && W.elevation != null && Math.abs(W.lat - +L.lat) < 0.05 && Math.abs(W.lon - +L.lon) < 0.05);
}
export { MONTHS };
