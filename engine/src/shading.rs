//! Shading by the buildings, trees and other objects of the layout map (near shading), and the orientations of an array whose
//! layout areas have their own tilt and azimuth (src/shading.{hpp,cpp}).
use crate::json::Error;
use crate::layout::{layout_used, validate_layout};
use crate::model::{Obstacle, PlanPoint, Project};
use crate::pv::{horizon_at, sky_cells, SkyCells};
use crate::solar::sin_cos;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex};

const D2R: f64 = PI / 180.0;
const R2D: f64 = 180.0 / PI;
use crate::pv::{max, min};

/// Near horizon azimuths 0, 2, ... 358 deg from north
pub const NEAR_BINS: usize = 180;
/// Near horizon azimuth of any azimuth (deg): the nearest of 0, 2, ... 358, so each one stands for [az - 1, az + 1)
pub fn near_bin(azimuth: f64) -> usize {
    let a = azimuth % 360.0;
    ((if a < 0.0 { a + 360.0 } else { a }) / 2.0 + 0.5).floor() as usize % NEAR_BINS
}

/// A point on the tables (or on a PV area without tables), m; table: index in SiteLayout::tables, -1 for a point of an area
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub table: i32,
}

#[derive(Clone, Copy)]
struct Bounds {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn bounds(v: &[PlanPoint]) -> Bounds {
    let mut b = Bounds { x0: v[0][0], y0: v[0][1], x1: v[0][0], y1: v[0][1] };
    for q in v {
        b.x0 = min(b.x0, q[0]);
        b.x1 = max(b.x1, q[0]);
        b.y0 = min(b.y0, q[1]);
        b.y1 = max(b.y1, q[1]);
    }
    b
}

fn inside(x: f64, y: f64, poly: &[PlanPoint]) -> bool {
    let mut is_in = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] { is_in = !is_in; }
        j = i;
    }
    is_in
}

fn plan_area(poly: &[PlanPoint]) -> f64 {
    let mut s = 0.0;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
        j = i;
    }
    (s / 2.0).abs()
}

fn wrap180(a: f64) -> f64 {
    let a = (a + 180.0) % 360.0;
    (if a < 0.0 { a + 360.0 } else { a }) - 180.0
}

/// Distance from (x, y) along the unit direction (dx, dy) to the nearest edge of the polygon, or -1 when the ray misses it
fn ray_hit(x: f64, y: f64, dx: f64, dy: f64, poly: &[PlanPoint]) -> f64 {
    let mut best = -1.0;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (ax, ay) = (poly[j][0] - x, poly[j][1] - y);
        let (ex, ey) = (poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
        let den = dx * ey - dy * ex;
        if den.abs() >= 1e-12 {
            let t = (ax * ey - ay * ex) / den;
            let u = (ax * dy - ay * dx) / den;
            if t > 0.0 && u >= -1e-9 && u <= 1.0 + 1e-9 && (best < 0.0 || t < best) { best = t; }
        }
        j = i;
    }
    best
}

struct Footprint<'a> {
    o: &'a Obstacle,
    b: Bounds,
}

fn footprints(obstacles: &[Obstacle]) -> Vec<Footprint<'_>> {
    obstacles.iter().filter(|o| o.pts.len() >= 3 && o.height > 0.0).map(|o| Footprint { o, b: bounds(&o.pts) }).collect()
}

fn horizon_of(x: f64, y: f64, z: f64, fp: &[Footprint]) -> [f32; NEAR_BINS] {
    let mut h = [0f32; NEAR_BINS];
    let tan_min = (2.0 * D2R).tan();
    for f in fp {
        let o = f.o;
        let dh = o.height - z;
        if dh <= 0.0 { continue; }
        let ox = max(max(f.b.x0 - x, 0.0), x - f.b.x1);
        let oy = max(max(f.b.y0 - y, 0.0), y - f.b.y1);
        let dmin = ox.hypot(oy);
        if dmin * tan_min >= dh { continue; }
        if dmin == 0.0 && inside(x, y, &o.pts) { return [90.0; NEAR_BINS]; }
        let mut cast = |az: f64| {
            let (s, c) = sin_cos(az * D2R);   // as the compiled C++ takes them
            let t = ray_hit(x, y, s, c, &o.pts);
            if t <= 0.0 { return; }
            let e = &mut h[near_bin(az)];
            let v = (dh.atan2(t) * R2D) as f32;
            if *e < v { *e = v; }
        };
        // The footprint lies outside the point, so the bearings of its corners unwrap to a span of less than a full turn
        let b0 = (o.pts[0][0] - x).atan2(o.pts[0][1] - y) * R2D;
        let (mut prev, mut rel, mut lo, mut hi) = (b0, 0.0, 0.0, 0.0);
        for q in &o.pts {
            let b = (q[0] - x).atan2(q[1] - y) * R2D;
            rel += wrap180(b - prev);
            prev = b;
            lo = min(lo, rel);
            hi = max(hi, rel);
            cast(b);
        }
        let mut a = ((b0 + lo) * 2.0).floor() / 2.0;
        while a <= b0 + hi {
            cast(a);
            a += 0.5;
        }
    }
    h
}

/// Elevation (deg) of the highest object edge above a point's horizontal at each NEAR_BINS azimuth: the largest over rays
/// every 0.5 deg within 1 deg of it and to the objects' corners. Inside a footprint: 90 deg. Objects below 2 deg are left out.
pub fn near_horizon(x: f64, y: f64, z: f64, obstacles: &[Obstacle]) -> [f32; NEAR_BINS] { horizon_of(x, y, z, &footprints(obstacles)) }

/// Near horizons of a non-empty set of points: the share that sees the sun behind an object, and the sky left in view by
/// the objects and the terrain horizon `far` (empty for none), averaged over up to 48 points
#[derive(Debug, Clone)]
pub struct NearShading {
    pts: Vec<ShadePoint>,
    /// near horizon of point k at h[k * NEAR_BINS + j]
    h: Vec<f32>,
    sorted: Vec<Vec<f32>>,
    sky: SkyCells,
}

impl NearShading {
    pub fn new(pts: Vec<ShadePoint>, obstacles: &[Obstacle], far: &[f64]) -> NearShading {
        let n = pts.len();
        let mut h = vec![0f32; n * NEAR_BINS];
        let fp = footprints(obstacles);
        const CHUNK: usize = 256;
        let threads = std::thread::available_parallelism().map_or(1, |x| x.get());
        let per = n.div_ceil(CHUNK).div_ceil(threads).max(1) * CHUNK;
        std::thread::scope(|sc| {
            for (c, out) in h.chunks_mut(per * NEAR_BINS).enumerate() {
                let (pts, fp) = (&pts, &fp);
                sc.spawn(move || {
                    for (r, dst) in out.chunks_mut(NEAR_BINS).enumerate() {
                        let p = pts[c * per + r];
                        dst.copy_from_slice(&horizon_of(p.x, p.y, p.z, fp));
                    }
                });
            }
        });
        let mut sorted = vec![vec![0f32; n]; NEAR_BINS];
        for (j, s) in sorted.iter_mut().enumerate() {
            for k in 0..n { s[k] = h[k * NEAR_BINS + j]; }
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        }
        // Sky cells over the objects and the terrain, averaged over up to 48 points spread through the set
        let m = n.min(48);
        let mut far_at = vec![0.0; NEAR_BINS];
        if !far.is_empty() { for j in 0..NEAR_BINS { far_at[j] = horizon_at(far, 2.0 * j as f64); } }
        let mut sky = SkyCells::default();
        let mut prof = vec![0.0; NEAR_BINS];
        for i in 0..m {
            let k = i * n / m;
            let hk = &h[k * NEAR_BINS..(k + 1) * NEAR_BINS];
            for j in 0..NEAR_BINS { prof[j] = max(f64::from(hk[j]), far_at[j]); }
            let c = sky_cells(&prof);
            if sky.sky.is_empty() { sky = SkyCells { sky: vec![0.0; c.sky.len()], band: vec![0.0; c.band.len()] }; }
            for k in 0..c.sky.len() { sky.sky[k] += c.sky[k] / m as f64; }
            for k in 0..c.band.len() { sky.band[k] += c.band[k] / m as f64; }
        }
        NearShading { pts, h, sorted, sky }
    }
    pub fn points(&self) -> &[ShadePoint] { &self.pts }
    pub fn horizon(&self, k: usize) -> &[f32] { &self.h[k * NEAR_BINS..(k + 1) * NEAR_BINS] }
    /// Share of the points with the sun (azimuth from north, elevation, deg) behind an object
    pub fn shaded(&self, azimuth: f64, elevation: f64) -> f64 {
        let v = &self.sorted[near_bin(azimuth)];
        let e = elevation as f32;
        (v.len() - v.partition_point(|&x| !(e < x))) as f64 / v.len() as f64
    }
    pub fn sky(&self) -> &SkyCells { &self.sky }
    /// The elevations of all points at near horizon azimuth j, in ascending order
    pub fn sorted(&self, j: usize) -> &[f32] { &self.sorted[j] }
}

/// One orientation of the array: tilt and azimuth (east_west: half the tables face azimuth + 180; own_tilt: the tilt of its
/// areas, not the project's), its share of the modules, its tables and their near shading
#[derive(Debug, Clone)]
pub struct ArrayGroup {
    pub tilt: f64,
    pub azimuth: f64,
    pub east_west: bool,
    pub own_tilt: bool,
    pub share: f64,
    /// one plane of tables: the hourly model runs without row shading
    pub canopy: bool,
    pub tables: Vec<i32>,
    /// None without objects
    pub near: Option<Arc<NearShading>>,
    /// ground slope of its areas (deg) and the azimuth it falls towards (None: the PV parameters')
    pub slope: Option<[f64; 2]>,
    /// with edge rows: the shares of its tables with no table in front of them and with none behind them (None: from the
    /// number of rows of the PV parameters)
    pub edge: Option<[f64; 2]>,
}

impl ArrayGroup {
    pub fn new(tilt: f64, azimuth: f64) -> ArrayGroup {
        ArrayGroup { tilt, azimuth, east_west: false, own_tilt: false, share: 1.0, canopy: false, tables: vec![], near: None, slope: None, edge: None }
    }

    /// Shares of the tables at the front and at the back edge of the array: as the layout's tables stand, or one row of
    /// row_count at each edge; none for east-west pairs and canopies
    pub fn edge_share(&self, pv: &crate::model::PVParams) -> [f64; 2] {
        if !pv.edge_rows || self.east_west || self.canopy { return [0.0, 0.0]; }
        if let Some(e) = self.edge { return e; }
        if pv.row_count >= 1.0 { let w = 1.0 / pv.row_count.floor(); [w, w] } else { [0.0, 0.0] }
    }
}

/// Shares of the tables with no table in front of them and with none behind them. Across the rows the tables face the
/// azimuth (fixed) or lie across the axis (trackers, whose front turns from east to west over the day, so both shares are
/// their mean). A table counts as covered when another stands 0.25 to 1.5 pitches ahead of it (behind it) with centres less
/// than half a table apart along the row.
fn edge_shares(tables: &[[PlanPoint; 4]], ids: &[i32], facing: f64, pitch: f64, tracker: bool) -> [f64; 2] {
    let (sf, cf) = sin_cos(facing * D2R);
    let pos: Vec<[f64; 3]> = ids.iter().map(|&t| {
        let c = &tables[t as usize];
        let (x, y) = ((c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4.0);
        [x * cf - y * sf, x * sf + y * cf, max(0.1, (c[1][0] - c[0][0]).hypot(c[1][1] - c[0][1]))]   // along, across (ahead), length
    }).collect();
    if pos.is_empty() || !(pitch > 0.0) { return [0.0, 0.0]; }
    let cell = pos.iter().fold(0.0, |m, q| max(m, q[2]));
    let key = |q: &[f64; 3]| ((q[0] / cell).floor() as i64, (q[1] / pitch).floor() as i64);
    let mut grid: std::collections::HashMap<(i64, i64), Vec<usize>> = std::collections::HashMap::new();
    for (i, q) in pos.iter().enumerate() { grid.entry(key(q)).or_default().push(i); }
    let covered = |i: usize, dir: f64| {
        let q = pos[i];
        let (ku, kv) = key(&q);
        for du in -1..=1 {
            for dv in -2..=2 {
                let Some(v) = grid.get(&(ku + du, kv + dv)) else { continue };
                for &j in v {
                    let d = (pos[j][1] - q[1]) * dir;
                    if d > 0.25 * pitch && d < 1.5 * pitch && (pos[j][0] - q[0]).abs() < 0.5 * q[2] { return true; }
                }
            }
        }
        false
    };
    let n = pos.len() as f64;
    let front = (0..pos.len()).filter(|&i| !covered(i, 1.0)).count() as f64 / n;
    let back = (0..pos.len()).filter(|&i| !covered(i, -1.0)).count() as f64 / n;
    if tracker { let m = (front + back) / 2.0; [m, m] } else { [front, back] }
}

/// Points along and down a table at spacing s, at least one each way
fn grid(c: &[PlanPoint; 4], s: f64) -> [usize; 2] {
    [(((c[1][0] - c[0][0]).hypot(c[1][1] - c[0][1]) / s).round() as i64).max(1) as usize,
     (((c[3][0] - c[0][0]).hypot(c[3][1] - c[0][1]) / s).round() as i64).max(1) as usize]
}

/// The bits of every number that sets the orientations and near shading, each list preceded by its length, so keys are equal
/// only for equal inputs (a hash would let a forged project match another's layout)
fn layout_key(p: &Project) -> Vec<u64> {
    let (pv, l) = (&p.pv, &p.layout);
    let mut k: Vec<u64> = Vec::new();
    let num = |k: &mut Vec<u64>, v: f64| k.push(v.to_bits());
    let text = |k: &mut Vec<u64>, s: &str| { k.push(s.len() as u64); k.extend(s.bytes().map(u64::from)); };
    let pts = |k: &mut Vec<u64>, v: &[PlanPoint]| { k.push(v.len() as u64); for q in v { k.push(q[0].to_bits()); k.push(q[1].to_bits()); } };
    let flag = |b: bool| if b { 1.0 } else { 0.0 };
    text(&mut k, &pv.mount);
    for v in [pv.tilt, pv.azimuth, pv.mount_height, pv.row_width, flag(pv.near_shading)] { num(&mut k, v); }
    for v in [flag(pv.edge_rows), pv.gcr, pv.tracker_axis_azimuth] { num(&mut k, v); }
    text(&mut k, &pv.horizon_beam);
    k.push(pv.horizon.len() as u64);
    for &x in &pv.horizon { num(&mut k, x); }
    k.push(l.areas.len() as u64);
    for a in &l.areas {
        pts(&mut k, &a.pts);
        for v in [a.base, a.tilt, a.azimuth, flag(a.east_west), flag(a.canopy), a.slope, a.slope_azimuth] { num(&mut k, v); }
    }
    k.push(l.obstacles.len() as u64);
    for o in &l.obstacles { pts(&mut k, &o.pts); num(&mut k, o.height); }
    k.push(l.tables.len() as u64);
    for t in &l.tables { for q in t { num(&mut k, q[0]); num(&mut k, q[1]); } }
    k.push(l.table_area.len() as u64);
    for &a in &l.table_area { num(&mut k, f64::from(a)); }
    k
}

fn build_groups(p: &Project) -> Result<Vec<ArrayGroup>, Error> {
    let (pv, l) = (&p.pv, &p.layout);
    let fixed = pv.mount != "tracker";
    let mut groups: Vec<ArrayGroup> = Vec::new();
    let group_for = |groups: &mut Vec<ArrayGroup>, a: i32| -> usize {
        let mut g = ArrayGroup { share: 0.0, ..ArrayGroup::new(pv.tilt, pv.azimuth) };
        if a >= 0 && fixed {
            let ar = &l.areas[a as usize];
            if ar.tilt.is_finite() { g.tilt = ar.tilt; g.own_tilt = true; }
            if ar.azimuth.is_finite() { g.azimuth = ar.azimuth; }
            g.east_west = ar.east_west;
            g.canopy = ar.canopy && !ar.east_west;
            if ar.slope > 0.0 { g.slope = Some([ar.slope, ar.slope_azimuth]); }
        }
        let same = |x: &ArrayGroup| x.slope.map(|s| [s[0].to_bits(), s[1].to_bits()]) == g.slope.map(|s| [s[0].to_bits(), s[1].to_bits()]);
        if let Some(k) = groups.iter().position(|x| x.tilt == g.tilt && x.azimuth == g.azimuth && x.east_west == g.east_west && x.canopy == g.canopy && same(x)) {
            return k;
        }
        groups.push(g);
        groups.len() - 1
    };
    let area_group: Vec<usize> = (0..l.areas.len()).map(|a| group_for(&mut groups, a as i32)).collect();
    // The area of each table as the layout map filled it, or else the first area that holds its centre
    let mut table_area = l.table_area.clone();
    if table_area.len() != l.tables.len() {
        let bx: Vec<Bounds> = l.areas.iter().map(|a| bounds(&a.pts)).collect();
        table_area = vec![-1; l.tables.len()];
        for (t, c) in l.tables.iter().enumerate() {
            let cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4.0;
            let cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4.0;
            for a in 0..l.areas.len() {
                if table_area[t] >= 0 { break; }
                let b = bx[a];
                if cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1 && inside(cx, cy, &l.areas[a].pts) { table_area[t] = a as i32; }
            }
        }
    }
    for t in 0..l.tables.len() {
        let g = if table_area[t] >= 0 { area_group[table_area[t] as usize] } else { group_for(&mut groups, -1) };
        groups[g].tables.push(t as i32);
    }
    if groups.is_empty() { group_for(&mut groups, -1); }
    if pv.edge_rows && !l.tables.is_empty() && pv.gcr > 0.0 {
        let pitch = pv.row_width / pv.gcr;   // across the rows on the plan
        for g in &mut groups {
            if g.tables.is_empty() || g.east_west || g.canopy { continue; }
            let facing = if fixed { g.azimuth } else { pv.tracker_axis_azimuth + 90.0 };
            g.edge = Some(edge_shares(&l.tables, &g.tables, facing, pitch, !fixed));
        }
    }
    if !l.tables.is_empty() {
        for g in &mut groups { g.share = g.tables.len() as f64 / l.tables.len() as f64; }
    } else {
        let mut area = vec![0.0; groups.len()];
        for a in 0..l.areas.len() { area[area_group[a]] += plan_area(&l.areas[a].pts); }
        let total = area.iter().fold(0.0, |s, x| s + x);
        let n = groups.len() as f64;
        for (g, x) in groups.iter_mut().zip(&area) { g.share = if total > 0.0 { x / total } else { 1.0 / n }; }
    }

    if pv.near_shading && !l.obstacles.is_empty() {
        let mut pts: Vec<Vec<ShadePoint>> = vec![Vec::new(); groups.len()];
        if !l.tables.is_empty() {
            // Points spread over each table, up the slant from its upper edge [0]-[1] towards the lower edge [3]-[2], at a
            // spacing for about 20 000 points; at least one per table, so many tables raise the spacing until the count fits
            let plan = l.tables.iter().fold(0.0, |s, c| s + plan_area(c));
            let count = |s: f64| l.tables.iter().map(|c| { let g = grid(c, s); g[0] * g[1] }).sum::<usize>();
            let mut s = max(1.0, (plan / 20000.0).sqrt());
            while count(s) > 22000 && s < 2e5 { s *= 1.25; }   // thin tables have little plan area; past 200 km each gets one point
            for (g, gp) in groups.iter().zip(pts.iter_mut()) {
                for &t in &g.tables {
                    let c = &l.tables[t as usize];
                    let n = grid(c, s);
                    let (ax, ay, dx, dy) = (c[1][0] - c[0][0], c[1][1] - c[0][1], c[3][0] - c[0][0], c[3][1] - c[0][1]);
                    let ta = table_area[t as usize];
                    let base = (if ta >= 0 { l.areas[ta as usize].base } else { 0.0 }) + pv.mount_height;
                    let rise = if fixed { pv.row_width * (g.tilt * D2R).sin() } else { 0.0 };
                    for i in 0..n[0] {
                        for j in 0..n[1] {
                            let (u, v) = ((i as f64 + 0.5) / n[0] as f64, (j as f64 + 0.5) / n[1] as f64);
                            gp.push(ShadePoint { x: c[0][0] + u * ax + v * dx, y: c[0][1] + u * ay + v * dy, z: base + (0.5 - v) * rise, table: t });
                        }
                    }
                }
            }
        } else {
            // No tables: a grid over the areas at the table centre height
            let total = l.areas.iter().fold(0.0, |s, a| s + plan_area(&a.pts));
            let s0 = max(1.0, (total / 5000.0).sqrt());
            for (a, ar) in l.areas.iter().enumerate() {
                let b = bounds(&ar.pts);
                let s = max(s0, ((b.x1 - b.x0) * (b.y1 - b.y0) / 20000.0).sqrt());   // at most about 20 000 tries per area
                let z = ar.base + pv.mount_height;
                let gp = &mut pts[area_group[a]];
                let before = gp.len();
                let mut y = b.y0 + s / 2.0;
                while y < b.y1 {
                    let mut x = b.x0 + s / 2.0;
                    while x < b.x1 {
                        if inside(x, y, &ar.pts) { gp.push(ShadePoint { x, y, z, table: -1 }); }
                        x += s;
                    }
                    y += s;
                }
                if gp.len() == before { gp.push(ShadePoint { x: (b.x0 + b.x1) / 2.0, y: (b.y0 + b.y1) / 2.0, z, table: -1 }); }
            }
        }
        // The near horizons cost about (points x object corners); refuse a layout that would take minutes
        let n_pts: usize = pts.iter().map(Vec::len).sum();
        let corners: usize = l.obstacles.iter().map(|o| o.pts.len()).sum();
        if n_pts as f64 * corners as f64 > 1e9 {
            return Err(Error("Too many building and tree corners for the size of the layout: simplify the outlines or remove distant objects.".into()));
        }
        let far: &[f64] = if !pv.horizon.is_empty() && pv.horizon_beam != "data" { &pv.horizon } else { &[] };
        for (g, gp) in groups.iter_mut().zip(pts) {
            if !gp.is_empty() { g.near = Some(Arc::new(NearShading::new(gp, &l.obstacles, far))); }
        }
    }
    groups.retain(|g| !(g.share <= 0.0));
    Ok(groups)
}

type Kept = Vec<(Vec<u64>, Vec<ArrayGroup>)>;
static KEPT: Mutex<Kept> = Mutex::new(Vec::new());

/// The orientations of the array: one from the PV parameters, or one per layout area orientation (fixed tables only), each
/// with its share of the tables (of the areas' plan area without tables). Near shading samples about 20 000 points in all (at
/// least one per table), or over the areas without tables. The last two layouts' results are kept.
pub fn array_groups(p: &Project) -> Result<Vec<ArrayGroup>, Error> {
    if !layout_used(p) { return Ok(vec![ArrayGroup::new(p.pv.tilt, p.pv.azimuth)]); }
    // The lock is held while one is built, so parallel runs on the same layout wait for it rather than each building it
    let key = layout_key(p);
    let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = kept.iter().position(|k| k.0 == key) {
        let item = kept.remove(i);   // most recent last
        let groups = item.1.clone();
        kept.push(item);
        return Ok(groups);
    }
    validate_layout(&p.layout)?;   // a layout seen before was checked then
    let mut groups = build_groups(p)?;
    if groups.is_empty() { groups = vec![ArrayGroup::new(p.pv.tilt, p.pv.azimuth)]; }   // areas without plan area: the PV parameters
    if kept.len() >= 2 { kept.remove(0); }
    kept.push((key, groups.clone()));
    Ok(groups)
}
