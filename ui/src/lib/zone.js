// Time zones from the browser's Intl data (nothing leaves the computer). The model works in local standard time.
export const zoneFormat = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });

// Hours between the zone's wall clock and UTC at the instant t (ms), from a formatter made by zoneFormat.
export function wallOffset(fmt, t) {
  const f = {};
  for (const x of fmt.formatToParts(t)) f[x.type] = +x.value;
  return (Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - t) / 3.6e6;
}

// Offsets of the zone over a year, read at 12:00 UTC on the 15th of every month: std is the lowest (local standard time), all the
// distinct values, dst when the clock changes during the year, irregular when it takes more than two values. Throws for an unknown zone.
const CACHE = new Map();
export function zoneOffsets(tz, year = new Date().getUTCFullYear()) {
  const key = tz + '|' + year;
  if (!CACHE.has(key)) {
    const fmt = zoneFormat(tz), all = [];
    for (let m = 0; m < 12; m++) { const o = wallOffset(fmt, Date.UTC(year, m, 15, 12)); if (!all.includes(o)) all.push(o); }
    all.sort((a, b) => a - b);
    CACHE.set(key, { std: all[0], all, dst: all.length > 1, irregular: all.length > 2 });
  }
  return CACHE.get(key);
}
