// Inverter blocks: which PV tables feed which inverter, measured on the layout map. With central inverters the inverters stand in
// the PV stations, so a block is the tables of one PV station; with string inverters each inverter pin on the map takes a block of
// tables, and its AC cable runs to a PV station. Blocks are balanced (each node takes about the same number of tables), so a node
// does not collect twice the power of its neighbour. No map here, so ui/tests/blocks.test.js runs it under Node.
import { localProjector } from '../layout/geometry.js';

export const INVERTER_LAYOUTS = [['central', 'Central inverters in the PV stations'], ['string', 'String inverters in the field']];
export const inverterLayout = (P) => ((P.electrical || {}).inverter_layout === 'string' ? 'string' : 'central');

/** @type {(t: number[][]) => [number, number]} */
const centre = (t) => [t.reduce((a, p) => a + p[0], 0) / t.length, t.reduce((a, p) => a + p[1], 0) / t.length];
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Each point to a node, nearest first, with every node taking floor(n / k) or one more point (`cap`, when given, is the most a
// node takes instead). Points with the most to lose by not getting their nearest node (the gap to their second nearest) go first:
// the usual greedy for an assignment with capacities. Returns the node of each point.
export function assign(pts, nodes, cap = 0) {
  const n = pts.length, k = nodes.length, out = new Int32Array(n).fill(-1);
  if (!k) return out;
  const base = cap > 0 ? cap : Math.floor(n / k), room = new Array(k).fill(base);
  let extra = cap > 0 ? 0 : n - base * k;   // nodes that may take one more
  const order = pts.map((p, i) => {
    let a = Infinity, b = Infinity;
    for (const q of nodes) { const d = d2(p, q); if (d < a) { b = a; a = d; } else if (d < b) b = d; }
    return [i, (b === Infinity ? 0 : b - a)];
  }).sort((x, y) => y[1] - x[1]);
  for (const [i] of order) {
    let best = -1, bd = Infinity;
    for (let j = 0; j < k; j++) if (room[j] > 0 || (extra > 0 && room[j] === 0)) { const d = d2(pts[i], nodes[j]); if (d < bd) { bd = d; best = j; } }
    if (best < 0) for (let j = 0; j < k; j++) { const d = d2(pts[i], nodes[j]); if (d < bd) { bd = d; best = j; } }   // all full: nearest
    if (room[best] === 0 && extra > 0) { extra--; room[best] = -1; } else room[best]--;
    out[i] = best;
  }
  return out;
}

// `pts` split into k compact groups of about equal size: the set is cut across its longer side in the ratio of the groups each side
// gets, and each side again (recursive bisection). Returns the indices of each group.
export function split(pts, k) {
  const go = (idx, k) => {
    if (k <= 1 || idx.length <= 1) return [idx];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of idx) { const [x, y] = pts[i]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const ax = x1 - x0 >= y1 - y0 ? 0 : 1, ka = Math.floor(k / 2);
    const s = [...idx].sort((a, b) => pts[a][ax] - pts[b][ax] || pts[a][1 - ax] - pts[b][1 - ax]), m = Math.round(s.length * ka / k);
    return go(s.slice(0, m), ka).concat(go(s.slice(m), k - ka));
  };
  return go(pts.map((_, i) => i), Math.max(1, Math.min(k, pts.length))).filter((g) => g.length);
}

// Where k nodes go for the points `pts`: the middle of each group, or (snap) the point nearest it, so an inverter stands at a table
export function autoNodes(pts, k, snap = true) {
  return split(pts, k).map((g) => {
    const c = centre(g.map((i) => pts[i]));
    if (!snap) return c;
    let best = g[0], bd = Infinity;
    for (const i of g) { const d = d2(pts[i], c); if (d < bd) { bd = d; best = i; } }
    return pts[best];
  });
}

// The blocks of the open layout, or null without tables or without the nodes of the layout chosen (PV stations for central
// inverters, inverter pins for string inverters). In local metres; `route` multiplies the straight lines. Returns
// { mode, nodes: [{ kind, latlng, name }], tableNode (the node of each table), blocks: [{ node, n, dcSum, dcMax, ac, station }] }
// with `ac` the AC run of a string inverter to its PV station (null for central inverters or without a PV station).
let memo = { key: '', tables: null, val: null };
export function inverterBlocks(P, route = 1) {
  const L = P.layout || {}, tables = (L.result && L.result.tables) || [], st = L.stations || [], mode = inverterLayout(P);
  const nodes = st.filter((s) => s.kind === (mode === 'string' ? 'inv' : 'pv'));
  if (!tables.length || !nodes.length) return null;
  const pvs = st.filter((s) => s.kind === 'pv');
  const key = mode + route + JSON.stringify(nodes.map((s) => s.latlng)) + JSON.stringify(pvs.map((s) => s.latlng));
  if (memo.tables === tables && memo.key === key) return memo.val;
  const pr = localProjector(tables.flat()), at = tables.map((t) => pr.fwd(centre(t))), nxy = nodes.map((s) => pr.fwd(s.latlng));
  const tableNode = assign(at, nxy);
  const blocks = nodes.map((s, j) => ({ node: j, n: 0, dcSum: 0, dcMax: 0, ac: null, station: -1 }));
  at.forEach((p, i) => { const b = blocks[tableNode[i]], d = route * d2(p, nxy[tableNode[i]]); b.n++; b.dcSum += d; if (d > b.dcMax) b.dcMax = d; });
  if (mode === 'string' && pvs.length) {
    const sxy = pvs.map((s) => pr.fwd(s.latlng)), to = assign(nxy, sxy);
    blocks.forEach((b, j) => { b.station = to[j]; b.ac = route * d2(nxy[j], sxy[to[j]]); });
  }
  memo = { key, tables, val: { mode, nodes, tableNode, blocks } };
  return memo.val;
}

// The pins Auto-place puts on the map for the open layout: `nInv` string inverters on their tables (and `nSt` PV stations among
// them when none is placed), or `nSt` PV stations for central inverters. Returns { kind, stations } with every station of that kind
// (and, for string inverters, the PV stations) replaced, or null without tables.
export function autoPlace(P, nInv, nSt) {
  const L = P.layout || {}, tables = (L.result && L.result.tables) || [], st = L.stations || [], mode = inverterLayout(P);
  if (!tables.length) return null;
  const pr = localProjector(tables.flat()), at = tables.map((t) => pr.fwd(centre(t))), pin = (kind) => (p) => ({ kind, latlng: pr.inv(p).map((x) => +x.toFixed(7)) });
  if (mode === 'central') return { kind: 'pv', stations: st.filter((s) => s.kind !== 'pv').concat(autoNodes(at, Math.max(1, nSt), false).map(pin('pv'))) };
  const inv = autoNodes(at, Math.max(1, nInv)), keepPv = st.some((s) => s.kind === 'pv');
  const pv = keepPv ? [] : autoNodes(inv, Math.max(1, nSt), false).map(pin('pv'));
  return { kind: 'inv', stations: st.filter((s) => s.kind !== 'inv').concat(inv.map(pin('inv')), pv), stationsAdded: pv.length };
}

// A colour of 8 for each block, neighbours different where 8 allow: each block takes the first colour none of its 4 nearest has
export const BLOCK_COLOURS = ['#2f6fd0', '#e08a1e', '#2e9b5a', '#c2417a', '#7a5bd1', '#1a9fae', '#b5a11f', '#d4563a'];
export function blockColours(nodesXY) {
  const col = new Array(nodesXY.length).fill(-1);
  nodesXY.forEach((p, j) => {
    const near = nodesXY.map((q, i) => [i, d2(p, q)]).filter(([i]) => i !== j && col[i] >= 0).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([i]) => col[i]);
    col[j] = BLOCK_COLOURS.findIndex((_, c) => !near.includes(c));
    if (col[j] < 0) col[j] = j % BLOCK_COLOURS.length;
  });
  return col.map((c) => BLOCK_COLOURS[c]);
}
