// Calendar helpers for the hourly series of a year
export const HOURS = 8760;
// First hour of week w (the last week is the final 168 hours).
export const weekStart = (w) => Math.min(w * 168, HOURS - 168);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const MONTH_OF_HOUR = (() => {
  const a = new Uint8Array(HOURS);
  let h = 0;
  MDAYS.forEach((d, m) => { for (let i = 0; i < d * 24; i++) a[h++] = m; });
  return a;
})();

export const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

// 12 monthly sums of an hourly series
export function monthlySum(arr) {
  const m = new Array(12).fill(0);
  for (let i = 0; i < HOURS; i++) m[MONTH_OF_HOUR[i]] += arr[i];
  return m;
}

// "12 Mar" for an hour of the year
export function dateOfHour(h) {
  let d = Math.floor(h / 24), m = 0;
  while (m < 11 && d >= MDAYS[m]) { d -= MDAYS[m]; m++; }
  return `${d + 1} ${MONTHS[m]}`;
}
