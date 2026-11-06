// The numeric library of the script console: vectors are plain arrays, operations broadcast over a scalar or an array of the same
// length (ui/tests/console.test.js).
import { sum, monthlySum, MDAYS } from '../series.js';

const isArr = Array.isArray;
const bc = (a, b, f) => {   // broadcasting element-wise op
  if (isArr(a) && isArr(b)) { if (a.length !== b.length) throw new Error(`Size mismatch: ${a.length} vs ${b.length}`); return a.map((x, i) => f(x, b[i])); }
  if (isArr(a)) return a.map((x) => f(x, b));
  if (isArr(b)) return b.map((y) => f(a, y));
  return f(a, b);
};
const map1 = (f) => (a) => (isArr(a) ? a.map(f) : f(a));
export const M = {
  linspace: (a, b, n = 100) => Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (b - a) * i / (n - 1))),
  colon: (a, step, b) => { if (b === undefined) { b = step; step = 1; } if (!step) return []; const o = []; for (let x = a; step > 0 ? x <= b + 1e-12 : x >= b - 1e-12; x += step) o.push(+x.toFixed(12)); return o; },
  zeros: (n) => new Array(n).fill(0), ones: (n) => new Array(n).fill(1),
  rand: (n) => Array.from({ length: n }, Math.random),
  randn: (n) => Array.from({ length: n }, () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }),
  sum,
  mean: (a) => M.sum(a) / a.length,
  median: (a) => M.prctile(a, 50),
  std: (a) => Math.sqrt(M.variance(a)),
  variance: (a) => { const m = M.mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1); },
  min: (a, b) => (b === undefined ? a.reduce((m, x) => Math.min(m, x), Infinity) : bc(a, b, Math.min)), max: (a, b) => (b === undefined ? a.reduce((m, x) => Math.max(m, x), -Infinity) : bc(a, b, Math.max)),
  cumsum: (a) => { let s = 0; return a.map((x) => (s += x)); },
  diff: (a) => a.slice(1).map((x, i) => x - a[i]),
  sort: (a, dir = 'ascend') => [...a].sort((x, y) => (dir === 'descend' ? y - x : x - y)),
  prctile: (a, p) => { const s = [...a].sort((x, y) => x - y), k = (s.length - 1) * p / 100, lo = Math.floor(k), hi = Math.ceil(k); return s[lo] + (s[hi] - s[lo]) * (k - lo); },
  abs: map1(Math.abs), sqrt: map1(Math.sqrt), exp: map1(Math.exp), log: map1(Math.log), log10: map1(Math.log10), round: (a, d = 0) => map1((x) => +x.toFixed(d))(a),
  floor: map1(Math.floor), ceil: map1(Math.ceil),
  add: (a, b) => bc(a, b, (x, y) => x + y), sub: (a, b) => bc(a, b, (x, y) => x - y), mul: (a, b) => bc(a, b, (x, y) => x * y), div: (a, b) => bc(a, b, (x, y) => x / y), pow: (a, b) => bc(a, b, Math.pow),
  dot: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
  find: (a, f) => a.reduce((o, x, i) => (f(x, i) ? (o.push(i), o) : o), []),
  reshape: (a, r, c) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => a[j * r + i])),   // column-major order
  transpose: (A) => A[0].map((_, j) => A.map((r) => r[j])),
  mtimes: (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, x, k) => s + x * B[k][j], 0))),
  eye: (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j))),
  mldivide: (A, b) => {   // Gaussian elimination with partial pivoting: solves A x = b
    const n = A.length, Mx = A.map((r, i) => [...r, isArr(b[i]) ? b[i][0] : b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r;
      [Mx[c], Mx[p]] = [Mx[p], Mx[c]];
      if (Math.abs(Mx[c][c]) < 1e-14) throw new Error('Matrix is singular');
      for (let r = 0; r < n; r++) if (r !== c) { const f = Mx[r][c] / Mx[c][c]; for (let k = c; k <= n; k++) Mx[r][k] -= f * Mx[c][k]; }
    }
    return Mx.map((r, i) => r[n] / r[i]);
  },
  inv: (A) => { const n = A.length, I = M.eye(n); return M.transpose(I.map((col) => M.mldivide(A, col))); },
  polyfit: (x, y, n) => {   // least squares, coefficients highest power first
    const V = x.map((xi) => Array.from({ length: n + 1 }, (_, k) => xi ** (n - k)));
    const Vt = M.transpose(V);
    return M.mldivide(M.mtimes(Vt, V), M.mtimes(Vt, y.map((v) => [v])).map((r) => r[0]));
  },
  polyval: (p, x) => map1((xi) => p.reduce((s, c) => s * xi + c, 0))(x),
  interp1: (x, y, xi) => map1((v) => { if (v <= x[0]) return y[0]; if (v >= x[x.length - 1]) return y[y.length - 1]; let j = 1; while (x[j] < v) j++; return y[j - 1] + (y[j] - y[j - 1]) * (v - x[j - 1]) / (x[j] - x[j - 1]); })(xi),
  trapz: (x, y) => { if (!y) { y = x; x = y.map((_, i) => i); } let s = 0; for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2; return s; },
  corrcoef: (a, b) => { const ma = M.mean(a), mb = M.mean(b); let n = 0, da = 0, db = 0; a.forEach((x, i) => { n += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; }); return n / Math.sqrt(da * db); },
  movmean: (a, w) => a.map((_, i) => { const lo = Math.max(0, i - Math.floor(w / 2)), hi = Math.min(a.length, lo + w); return M.mean(a.slice(lo, hi)); }),
  histcounts: (a, edges) => { const c = new Array(edges.length - 1).fill(0); a.forEach((v) => { for (let i = 0; i < edges.length - 1; i++) if (v >= edges[i] && (v < edges[i + 1] || (i === edges.length - 2 && v === edges[i + 1]))) { c[i]++; break; } }); return c; },
  monthly: (a, how = 'sum') => { const m = monthlySum(a); return how === 'mean' ? m.map((x, i) => x / (MDAYS[i] * 24)) : m; },
  daily: (a) => Array.from({ length: 365 }, (_, d) => M.sum(a.slice(d * 24, d * 24 + 24))),
  duration: (a) => M.sort(a, 'descend'),
  weibull: (n, c, k) => Array.from({ length: n }, () => c * Math.pow(-Math.log(1 - Math.random()), 1 / k)),         // inverse-CDF sampling
  lognormal: (n, mu, sigma) => M.randn(n).map((z) => Math.exp(mu + sigma * z)),
};
