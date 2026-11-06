// Coordinates typed or pasted into the place search, and the site in degrees, minutes and seconds.

// [lat, lon] from "lat, lon", a Google Maps link or degrees-minutes-seconds such as 2°30'15"S 115°30'E; null for anything else
// (a place name to look up).
export function parseCoords(q) {
  q = String(q).trim();
  let m = q.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/) || q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (m) return [+m[1], +m[2]];
  m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return [+m[1], +m[2]];
  // DMS, e.g. 2°30'15"S 115°30'E  or  2 30 15 S, 115 30 0 E
  const dms = [...q.matchAll(/(\d+(?:\.\d+)?)\s*[°d\s]\s*(?:(\d+(?:\.\d+)?)\s*['′m\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?([NSEW])/gi)];
  if (dms.length === 2) {
    const val = (g) => { let v = +g[1] + (+g[2] || 0) / 60 + (+g[3] || 0) / 3600; if (/[SW]/i.test(g[4])) v = -v; return { v, ns: /[NS]/i.test(g[4]) }; };
    const a = val(dms[0]), b = val(dms[1]);
    return a.ns ? [a.v, b.v] : [b.v, a.v];
  }
  return null;
}

// Rounded to 0.1″ before the split, so 106.85 prints 106°51′00.0″. Also used by the report.
export function toDMS(lat, lon) {
  const f = (v, pos, neg) => { const t = Math.round(Math.abs(v) * 36000), d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`; };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

// Great-circle distance (km) between two places { lat, lon }
export function km(a, b) {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

// Longitude brought into [-180, 180] (the map repeats round the globe)
export const wrapLon = (lon) => (Math.abs(lon) > 180 ? ((+lon + 180) % 360 + 360) % 360 - 180 : +lon);
