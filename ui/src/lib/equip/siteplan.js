// Cable lengths measured on the layout map. With the plant's stations placed (P.layout.stations) and the box "Cable lengths from
// the layout" ticked, the DC string cables, the AC cables of string inverters and the MV feeders take their lengths from the
// positions of the PV tables, inverters and stations instead of typed values; the short LV runs inside a station stay typed. Straight-line distances times the route
// factor (trenches follow tracks, not the straight line). No map or page here, so ui/tests/siteplan.test.js runs it under Node.
import { projector } from '../layout/geometry.js';
import { inverterBlocks, inverterLayout } from './blocks.js';

const ROUTE_LIMITS = [1, 3];
export const routeFactor = (E) => Math.min(ROUTE_LIMITS[1], Math.max(ROUTE_LIMITS[0], Number.isFinite(+E.route_factor) && +E.route_factor > 0 ? +E.route_factor : 1.25));

// { dc, lv_pv, mv_pv, mv_bess, mv_gen, load, blocks }: for each circuit that can be measured { len (the length the design uses: the
// average run), max (the longest run, for the voltage drop), n (what was measured), from (what the length is) }, and the inverter
// blocks (blocks.js) the string cables were measured in; null when nothing can be measured: the box is off, or no station is placed.
// The string cables run to the PV stations (central inverters) or to the inverter pins (string inverters), whose AC cables run on
// to the PV stations; the feeders need the MV substation.
export function plantLengths(P) {
  const E = P.electrical || {}, L = P.layout || {}, st = L.stations || [];
  if (!E.len_from_layout || !st.length) return null;
  const f = routeFactor(E), r1 = (x) => Math.round(x * 10) / 10, out = {};
  const B = inverterBlocks(P, f);
  if (B) {
    const n = B.blocks.reduce((a, b) => a + b.n, 0);
    out.dc = { len: r1(B.blocks.reduce((a, b) => a + b.dcSum, 0) / n), max: r1(Math.max(...B.blocks.map((b) => b.dcMax))), n,
      from: B.mode === 'string' ? 'the tables to their string inverter' : 'the tables to their PV station' };
    const ac = B.blocks.filter((b) => b.ac != null);
    if (ac.length) out.lv_pv = { len: r1(ac.reduce((a, b) => a + b.ac, 0) / ac.length), max: r1(Math.max(...ac.map((b) => b.ac))), n: ac.length, from: 'the string inverters to their PV station' };
    out.blocks = B;
  }
  const sub = st.find((s) => s.kind === 'substation');
  if (!sub) return Object.keys(out).length ? out : null;
  const pr = projector(sub.latlng[0], sub.latlng[1]);   // local metres east and north of the substation
  const xy = (ll) => pr.fwd(ll);
  const at = (k) => st.filter((s) => s.kind === k).map((s) => xy(s.latlng));
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
  if (!E.len_from_layout || !st.length) return [];
  const none = !((L.result && L.result.tables) || []).length, has = (k) => st.some((s) => s.kind === k), notes = [];
  if (none && (has('pv') || has('inv'))) notes.push('The layout holds no tables to measure from (no PV area is drawn, or it has more tables than are kept), so the string cables keep their typed length.');
  if (!none && inverterLayout(P) === 'string' && !has('inv')) notes.push('String inverters: place the inverters on the map (or use Auto-place) so the string cables and the inverter AC cables can be measured.');
  if (!none && inverterLayout(P) === 'string' && has('inv') && !has('pv')) notes.push('Place the PV stations too: the inverter AC cables run to them.');
  if (!has('substation')) notes.push('Place the MV substation to measure the MV feeders.');
  return notes;
}
