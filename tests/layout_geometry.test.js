// Tests of the layout map's geometry (ui/src/lib/layout/geometry.js) under Node: the table fill with its clearances, keepout strips,
// access aisles, grid shifts and the frame Align to click uses. Run by `make test` when Node is installed, or by hand:
//   node tests/layout_geometry.test.js
// The numbers are those of a 400 x 300 m PV area with tables 37.04 m along the rows and 4.696 m deep at a pitch of 10.6 m,
// a 10 m setback and 0.5 m between tables, the case checked by hand in the application before these tests existed.
'use strict';
const assert = require('assert');
const G = require('../ui/src/lib/layout/geometry.js');

let checks = 0;
const check = (cond, msg) => { checks++; assert.ok(cond, msg); };
const near = (a, b, tol, msg) => check(Math.abs(a - b) <= tol, `${msg}: ${a} is not within ${tol} of ${b}`);

const site = [[-200, -150], [200, -150], [200, 150], [-200, 150]];
const lay = (extra = {}) => ({ setback: 10, table_gap: 0.5, aisle_every: null, aisle_width: 4, ...extra });
const grid = { r: [-1, 0], f: [0, -1], along: 37.04, depth: 4.696, pitch: 10.6, ew: false };   // rows run east-west, facing south
// What the layout does for a PV area: the best of 8 first-row offsets, or the typed first-row shift as the only try
const fill = (X, C, l, shift = 0, rowShift = null) => {
  let best = [];
  for (let k = 0; k < (rowShift != null ? 1 : 8); k++) {
    const t = G.fillArea(l, site, X, C, grid, rowShift != null ? rowShift / grid.pitch : k / 8, shift);
    if (t.length > best.length) best = t;
  }
  return best;
};
const square = (cx, cy, w, h) => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
const rowsOf = (tables) => [...new Set(tables.map((t) => Math.round(t[0][1] * 10) / 10))].sort((a, b) => a - b);
const gaps = (v) => v.slice(1).map((y, i) => +(y - v[i]).toFixed(1));

// the fill of a free area: 10 tables a row, 26 rows
const base = fill([], [], lay());
check(base.length === 260, `a free area holds ${base.length} tables, not 260`);
check(base.every((t) => t.length === 4 && t.every((p) => G.inPoly(p, site))), 'every table corner lies inside the area');
check(base.every((t) => t.every((p) => G.distToEdges(p, site) >= 10 - 1e-6)), 'every table keeps the 10 m setback');
near(gaps(rowsOf(base))[0], 10.6, 0.05, 'row pitch');

// an exclusion zone and the clearance around it
const zone = square(0, 0, 60, 60);
const gapTo = (tables, poly) => Math.min(...tables.map((t) => Math.min(...t.map((p) => (G.inPoly(p, poly) ? -1 : G.distToEdges(p, poly))), ...poly.map((q) => G.distToEdges(q, t)))));
const plain = fill([zone], [0], lay()), clear = fill([zone], [15], lay());
check(plain.length === 248 && clear.length === 228, `zone: ${plain.length} tables without clearance, ${clear.length} with 15 m`);
check(gapTo(plain, zone) >= 0, 'no table overlaps the zone');
check(gapTo(clear, zone) >= 15 - 1e-6, `tables stay 15 m from the zone (nearest ${gapTo(clear, zone).toFixed(2)} m)`);
check(G.closerThan(square(0, 0, 10, 10), square(15, 0, 10, 10), 6) && !G.closerThan(square(0, 0, 10, 10), square(15, 0, 10, 10), 4), 'closerThan');

// a keepout path: a strip of its width with square ends, blocked as one rectangle per segment
const pr = G.projector(7, -1);
const path = [[0, -200], [0, 200]].map(pr.inv);
const strip = G.stripOf(path, 8).map(pr.fwd), xs = strip.map((p) => p[0]), ys = strip.map((p) => p[1]);
near(Math.max(...xs) - Math.min(...xs), 8, 0.01, 'strip width');
near(Math.max(...ys) - Math.min(...ys), 408, 0.01, 'strip length with its square ends');
const rects = G.blockedOf({ kind: 'path', path, width: 8 }, pr.fwd);
check(rects.length === 1 && rects[0].length === 4, 'one rectangle for a one-segment path');
const bent = G.blockedOf({ kind: 'path', path: [[0, 0], [100, 0], [100, 100]].map(pr.inv), width: 6 }, pr.fwd);
check(bent.length === 2, 'one rectangle for each segment of a bent path');
near(G.pathLength(path), 400, 0.01, 'path length');
const walled = fill(rects, [0], lay());
check(walled.length === 208 && gapTo(walled, rects[0]) >= 0, `path: ${walled.length} tables, none on the strip`);
const building = G.footprint({ latlngs: square(0, 0, 20, 20).map(pr.inv) }).map(pr.fwd);
near(Math.max(...building.map((p) => p[0])), 10, 1e-6, 'footprint of a building is its outline');
const crown = G.footprint({ center: pr.inv([0, 0]), diameter: 6 }).map(pr.fwd);
check(crown.length === 16 && crown.every((p) => Math.abs(Math.hypot(p[0], p[1]) - 3) < 1e-6), 'a tree is a 16-sided crown');

// access aisles: a strip after every 4th row
const aisle = fill([], [], lay({ aisle_every: 4, aisle_width: 5 }));
const g = gaps(rowsOf(aisle));
check(aisle.length === 240, `with aisles ${aisle.length} tables, not 240`);
check(g.slice(0, 7).join() === '10.6,10.6,10.6,15.6,10.6,10.6,10.6', `row gaps with an aisle every 4 rows: ${g.slice(0, 7)}`);
check(fill([], [], lay({ aisle_every: 1, aisle_width: 5 })).length < base.length, 'an aisle after every row leaves fewer tables');

// grid shift: along the rows and of the first row
const shifted = fill([], [], lay(), 7, 3);
check(shifted.length === 234, `shifted grid ${shifted.length} tables, not 234`);
near(Math.min(...base.map((t) => t[0][1])) - Math.min(...shifted.map((t) => t[0][1])), 3, 0.05, 'the first row moves by the 3 m shift');

// the frame Align to click uses: the grid starts at the bounding box corner moved in by the setback
const f = G.gridOf(site, grid, 10);
check(f.u0 === -190 && f.v0 === -140 && f.box.join() === '-200,-150,200,150', `grid origin ${f.u0}, ${f.v0}`);
near(f.toUV([200, 150])[0], -200, 1e-9, 'east-west rows run towards the west');

console.log(`layout geometry: ${checks} checks passed (free area ${base.length} tables, zone clearance ${plain.length} -> ${clear.length}, path ${walled.length}, aisles ${aisle.length}, shifted ${shifted.length})`);
