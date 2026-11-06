// Cable lengths measured on the layout map. With the plant's stations placed (P.layout.stations) and the box "Cable lengths from
// the layout" ticked, the DC string cables and the MV feeders take their lengths from the positions of the PV tables and
// stations instead of typed values; the short LV runs inside a station stay typed. Straight-line distances times the route
// factor (trenches follow tracks, not the straight line). No map or page here, so ui/tests/siteplan.test.js runs it under Node.
import { projector } from '../layout/geometry.js';

export const ROUTE_LIMITS = [1, 3];
export const routeFactor = (E) => Math.min(ROUTE_LIMITS[1], Math.max(ROUTE_LIMITS[0], Number.isFinite(+E.route_factor) && +E.route_factor > 0 ? +E.route_factor : 1.25));

// { dc, mv_pv, mv_bess, mv_gen, load }: for each circuit that can be measured { len (the length the design uses), max (the
// longest run, for the voltage drop), n (what was measured), from (what the length is) }; null when nothing can be measured:
// the box is off, there is no MV substation, or no station of a circuit's kind is placed.
export function plantLengths(P) {
  const E = P.electrical || {}, L = P.layout || {}, st = L.stations || [];
  const sub = st.find((s) => s.kind === 'substation');
  if (!E.len_from_layout || !sub) return null;
  const f = routeFactor(E), pr = projector(sub.latlng[0], sub.latlng[1]);   // local metres east and north of the substation
  const xy = (ll) => pr.fwd(ll), dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), r1 = (x) => Math.round(x * 10) / 10;
  const at = (k) => st.filter((s) => s.kind === k).map((s) => xy(s.latlng));
  const out = {};
  const pv = at('pv'), tables = (L.result && L.result.tables) || [];
  if (pv.length && tables.length) {
    let sum = 0, max = 0;
    for (const t of tables) {
      const c = xy([t.reduce((a, p) => a + p[0], 0) / t.length, t.reduce((a, p) => a + p[1], 0) / t.length]);
      const d = Math.min(...pv.map((p) => dist(c, p)));
      sum += d;
      if (d > max) max = d;
    }
    out.dc = { len: r1(f * sum / tables.length), max: r1(f * max), n: tables.length, from: 'the tables to their nearest PV station' };
  }
  // a feeder reaches its farthest station: the length, and the longest run, of every circuit that runs to the substation
  const far = (key, k, from) => {
    const list = at(k);
    if (!list.length) return;
    const d = r1(f * Math.max(...list.map((p) => dist(p, [0, 0]))));
    out[key] = { len: d, max: d, n: list.length, from };
  };
  far('mv_pv', 'pv', 'the farthest PV station to the substation');
  far('mv_bess', 'bess', 'the BESS station to the substation');
  far('mv_gen', 'gen', 'the genset hall to the substation');
  far('load', 'load', 'the plant load to the substation');
  return Object.keys(out).length ? out : null;
}
