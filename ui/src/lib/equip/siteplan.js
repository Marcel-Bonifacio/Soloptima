// Cable lengths measured on the layout map. With the plant's stations placed (P.layout.stations) and the box "Cable lengths from
// the layout" ticked, the DC string cables and the MV feeders take their lengths from the positions of the PV tables and
// stations instead of typed values; the short LV runs inside a station stay typed. Straight-line distances times the route
// factor (trenches follow tracks, not the straight line). No map or page here, so ui/tests/siteplan.test.js runs it under Node.
import { projector } from '../layout/geometry.js';

export const ROUTE_LIMITS = [1, 3];
export const routeFactor = (E) => Math.min(ROUTE_LIMITS[1], Math.max(ROUTE_LIMITS[0], Number.isFinite(+E.route_factor) && +E.route_factor > 0 ? +E.route_factor : 1.25));

// The tables' distances to their nearest PV station: { sum, max } in metres, straight lines. Worth keeping: it is the one
// calculation that grows with the layout (tables x stations), and the design is computed again after every edit of the project.
let memo = { tables: null, key: '', val: null };
function nearest(tables, pv, key, xy) {
  if (memo.tables === tables && memo.key === key) return memo.val;
  let sum = 0, max = 0;
  for (const t of tables) {
    const c = xy([t.reduce((a, p) => a + p[0], 0) / t.length, t.reduce((a, p) => a + p[1], 0) / t.length]);
    let d = Infinity;
    for (const p of pv) { const e = Math.hypot(c[0] - p[0], c[1] - p[1]); if (e < d) d = e; }
    sum += d;
    if (d > max) max = d;
  }
  memo = { tables, key, val: { sum, max } };
  return memo.val;
}

// { dc, mv_pv, mv_bess, mv_gen, load }: for each circuit that can be measured { len (the length the design uses: the average run),
// max (the longest run, for the voltage drop), n (what was measured), from (what the length is) }; null when nothing can be
// measured: the box is off, there is no MV substation, or no station of a circuit's kind is placed.
export function plantLengths(P) {
  const E = P.electrical || {}, L = P.layout || {}, st = L.stations || [];
  const sub = st.find((s) => s.kind === 'substation');
  if (!E.len_from_layout || !sub) return null;
  const f = routeFactor(E), pr = projector(sub.latlng[0], sub.latlng[1]);   // local metres east and north of the substation
  const xy = (ll) => pr.fwd(ll), r1 = (x) => Math.round(x * 10) / 10;
  const at = (k) => st.filter((s) => s.kind === k).map((s) => xy(s.latlng));
  const out = {};
  const pv = at('pv'), tables = (L.result && L.result.tables) || [];
  if (pv.length && tables.length) {
    const { sum, max } = nearest(tables, pv, sub.latlng + ';' + st.filter((s) => s.kind === 'pv').map((s) => s.latlng).join(';'), xy);
    out.dc = { len: r1(f * sum / tables.length), max: r1(f * max), n: tables.length, from: 'the tables to their nearest PV station' };
  }
  // a feeder circuit stands for the stations of its kind: the average run is costed and loses energy, the longest one sets the drop
  const feeder = (key, k, from) => {
    const d = at(k).map((p) => Math.hypot(p[0], p[1]));
    if (!d.length) return;
    out[key] = { len: r1(f * d.reduce((a, b) => a + b, 0) / d.length), max: r1(f * Math.max(...d)), n: d.length, from };
  };
  feeder('mv_pv', 'pv', 'the PV stations to the substation');
  feeder('mv_bess', 'bess', 'the BESS station to the substation');
  feeder('mv_gen', 'gen', 'the genset hall to the substation');
  feeder('load', 'load', 'the plant load to the substation');
  return Object.keys(out).length ? out : null;
}

// What the layout cannot measure although the stations are placed, for the design basis to say
export function lengthNotes(P) {
  const E = P.electrical || {}, L = P.layout || {}, st = L.stations || [];
  if (!E.len_from_layout || !st.some((s) => s.kind === 'substation')) return [];
  const none = !((L.result && L.result.tables) || []).length;
  return st.some((s) => s.kind === 'pv') && none ? ['The layout holds no tables to measure from (no PV area is drawn, or it has more tables than are kept), so the string cables keep their typed length.'] : [];
}
