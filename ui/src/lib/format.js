// Number and time formats shared by the screens (the same output as web/js/util.js)
const NUM = [];
export function fmtNum(x, d = 0) {
  if (x == null || !isFinite(x)) return '–';
  return (NUM[d] || (NUM[d] = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))).format(Number(x));
}
export const fmtPct = (x, d = 1) => (x == null || !isFinite(x) ? '–' : (x * 100).toFixed(d) + ' %');
export const plural = (n, one, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function relTime(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// A small stable hash of a string (colours and covers)
export const hash = (s) => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
