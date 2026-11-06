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

// Three significant figures for a value of any size
export function fmtSig(x) {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  return fmtNum(x, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}
export function fmtEnergy(kwh) {
  if (kwh == null || !isFinite(kwh)) return '–';
  const a = Math.abs(kwh);
  if (a >= 1e6) return fmtSig(kwh / 1e6) + ' GWh';
  if (a >= 1e3) return fmtSig(kwh / 1e3) + ' MWh';
  return fmtSig(kwh) + ' kWh';
}
export function fmtMoney(x, cur) {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x), c = cur || '';
  if (a >= 1e9) return c + ' ' + fmtSig(x / 1e9) + ' B';
  if (a >= 1e6) return c + ' ' + fmtSig(x / 1e6) + ' M';
  if (a >= 1e3) return c + ' ' + fmtSig(x / 1e3) + ' k';
  return c + ' ' + fmtSig(x);
}

export function fmtPower(kw) {
  if (kw == null || !isFinite(kw)) return '–';
  return Math.abs(kw) >= 1000 ? fmtSig(kw / 1000) + ' MW' : fmtSig(kw) + ' kW';
}
// Plan area: square metres below 1000 m², hectares above.
export const fmtArea = (m2) => (m2 < 1000 ? `${fmtNum(m2)} m²` : `${fmtNum(m2 / 1e4, 2)} ha`);
export function fmtOffset(h) {
  h = +h;
  if (!isFinite(h)) return 'UTC offset not set';
  const m = Math.round(Math.abs(h) * 60), hh = Math.floor(m / 60), mm = m % 60;   // total minutes first, so 5.995 is UTC+6, not 5:60
  return `UTC${h < 0 ? '-' : '+'}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
}
