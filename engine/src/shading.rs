//! Shading by the buildings, trees and other objects of the layout map (near shading), and the orientations of an array whose
//! layout areas have their own tilt and azimuth (src/shading.{hpp,cpp}).
use crate::json::Error;
use crate::layout::{layout_used, validate_layout};
use crate::model::{Obstacle, PlanPoint, Project};
use crate::pv::{horizon_at, sky_cells, SkyCells};
use crate::solar::sin_cos;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex, OnceLock};

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

/// The near horizon of a point in two layers: solid objects (buildings, trees without transmission) and the crowns that pass
/// light, with at each azimuth the highest crown (`id`: its index in `layer`, the translucent crowns of fp)
struct Layers {
    solid: [f32; NEAR_BINS],
    tree: [f32; NEAR_BINS],
    id: [u16; NEAR_BINS],
}

fn horizon_layers(x: f64, y: f64, z: f64, fp: &[Footprint], layer: &[Option<u16>]) -> Layers {
    let mut l = Layers { solid: [0f32; NEAR_BINS], tree: [0f32; NEAR_BINS], id: [0u16; NEAR_BINS] };
    let tan_min = (2.0 * D2R).tan();
    for (f, lay) in fp.iter().zip(layer) {
        let o = f.o;
        let dh = o.height - z;
        if dh <= 0.0 { continue; }
        let ox = max(max(f.b.x0 - x, 0.0), x - f.b.x1);
        let oy = max(max(f.b.y0 - y, 0.0), y - f.b.y1);
        let dmin = ox.hypot(oy);
        if dmin * tan_min >= dh { continue; }
        let mut put = |j: usize, v: f32| match lay {
            None => { if l.solid[j] < v { l.solid[j] = v; } }
            Some(t) => { if l.tree[j] < v { l.tree[j] = v; l.id[j] = *t; } }
        };
        if dmin == 0.0 && inside(x, y, &o.pts) {   // under a roof or a crown
            for j in 0..NEAR_BINS { put(j, 90.0); }
            continue;
        }
        let mut cast = |az: f64| {
            let (s, c) = sin_cos(az * D2R);
            let t = ray_hit(x, y, s, c, &o.pts);
            if t > 0.0 { put(near_bin(az), (dh.atan2(t) * R2D) as f32); }
        };
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
    l
}

/// The electrical effect of a partial shadow of the objects on a string of modules
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NearModel {
    /// the beam lost on the shaded share of the points
    Linear,
    /// bypass diodes per module substring: the inverter picks the string current, substrings that cannot carry it are bypassed
    Bypass,
    /// no bypass diode conducts: the string current follows its most shaded substring
    String,
    /// linear plus a share of the difference to the string model
    Factor(f64),
}

/// The tables of a set of points for the electrical model: of each table its strings, of each string its substrings (blocks
/// behind one bypass diode) with the points on each (a block without a point of its own takes the nearest), and the points
/// on each string
#[derive(Debug, Clone, Default)]
pub struct StringLayout {
    pub tables: Vec<TableStrings>,
    /// the table (index in `tables`) of each point
    pub table_of: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct TableStrings {
    pub blocks: Vec<Vec<Vec<u32>>>,
    pub points: Vec<Vec<u32>>,
}

/// Elevation (deg) of the highest object edge above a point's horizontal at each NEAR_BINS azimuth: the largest over rays
/// every 0.5 deg within 1 deg of it and to the objects' corners. Inside a footprint: 90 deg. Objects below 2 deg are left out.
pub fn near_horizon(x: f64, y: f64, z: f64, obstacles: &[Obstacle]) -> [f32; NEAR_BINS] { horizon_of(x, y, z, &footprints(obstacles)) }

/// Near horizons of a non-empty set of points: the share that sees the sun behind an object, and the sky left in view by
/// the objects and the terrain horizon `far` (empty for none), averaged over up to 48 points. With crowns that pass light
/// (leaf transmission by month) or an electrical model of the strings, the light the points get comes from a table by sun
/// position (2 deg of azimuth, 1 deg of elevation) and month, filled as the sun reaches each cell.
#[derive(Debug, Clone)]
pub struct NearShading {
    pts: Vec<ShadePoint>,
    /// near horizon of point k at h[k * NEAR_BINS + j]
    h: Vec<f32>,
    sorted: Vec<Vec<f32>>,
    sky: SkyCells,
    /// with translucent crowns: the solid layer, the crown layer and its crown at each point and azimuth, and the
    /// transmission of each crown by month
    solid: Vec<f32>,
    tree: Vec<f32>,
    tree_id: Vec<u16>,
    trans: Vec<[f64; 12]>,
    strings: Option<(StringLayout, NearModel)>,
    /// light by (month, azimuth bin), then by elevation degree, each row made when the sun first reaches it; empty: the share
    /// behind the objects from `sorted`
    memo: Vec<OnceLock<Vec<OnceLock<f32>>>>,
    months: usize,
}

impl NearShading {
    pub fn new(pts: Vec<ShadePoint>, obstacles: &[Obstacle], far: &[f64]) -> NearShading { Self::with_options(pts, obstacles, far, &[], None) }

    /// transmission: per object, empty for a solid one or 12 monthly shares of the beam its crown passes; strings: the
    /// points' tables and the electrical model
    pub fn with_options(pts: Vec<ShadePoint>, obstacles: &[Obstacle], far: &[f64], transmission: &[Vec<f64>],
                        strings: Option<(StringLayout, NearModel)>) -> NearShading {
        let n = pts.len();
        let mut h = vec![0f32; n * NEAR_BINS];
        let fp = footprints(obstacles);
        // the translucent crowns among the footprints, numbered
        let mut trans: Vec<[f64; 12]> = Vec::new();
        let layer: Vec<Option<u16>> = obstacles.iter().enumerate().filter(|(_, o)| o.pts.len() >= 3 && o.height > 0.0).map(|(k, _)| {
            let t = transmission.get(k).filter(|t| t.len() == 12 && t.iter().any(|&x| x > 0.0))?;
            if trans.len() >= u16::MAX as usize { return None; }
            let mut m = [0.0; 12];
            m.copy_from_slice(t);
            trans.push(m);
            Some((trans.len() - 1) as u16)
        }).collect();
        let layered = !trans.is_empty();
        let (mut solid, mut tree, mut tree_id) = if layered { (vec![0f32; n * NEAR_BINS], vec![0f32; n * NEAR_BINS], vec![0u16; n * NEAR_BINS]) } else { (vec![], vec![], vec![]) };
        const CHUNK: usize = 256;
        let threads = std::thread::available_parallelism().map_or(1, |x| x.get());
        let per = n.div_ceil(CHUNK).div_ceil(threads).max(1) * CHUNK;
        std::thread::scope(|sc| {
            if !layered {
                for (c, out) in h.chunks_mut(per * NEAR_BINS).enumerate() {
                    let (pts, fp) = (&pts, &fp);
                    sc.spawn(move || {
                        for (r, dst) in out.chunks_mut(NEAR_BINS).enumerate() {
                            let p = pts[c * per + r];
                            dst.copy_from_slice(&horizon_of(p.x, p.y, p.z, fp));
                        }
                    });
                }
            } else {
                let parts = solid.chunks_mut(per * NEAR_BINS).zip(tree.chunks_mut(per * NEAR_BINS)).zip(tree_id.chunks_mut(per * NEAR_BINS));
                for (c, ((so, tr), id)) in parts.enumerate() {
                    let (pts, fp, layer) = (&pts, &fp, &layer);
                    sc.spawn(move || {
                        for r in 0..so.len() / NEAR_BINS {
                            let p = pts[c * per + r];
                            let l = horizon_layers(p.x, p.y, p.z, fp, layer);
                            so[r * NEAR_BINS..(r + 1) * NEAR_BINS].copy_from_slice(&l.solid);
                            tr[r * NEAR_BINS..(r + 1) * NEAR_BINS].copy_from_slice(&l.tree);
                            id[r * NEAR_BINS..(r + 1) * NEAR_BINS].copy_from_slice(&l.id);
                        }
                    });
                }
            }
        });
        if layered { for q in 0..h.len() { h[q] = solid[q].max(tree[q]); } }   // the highest edge of either layer
        let mut sorted = vec![vec![0f32; n]; NEAR_BINS];
        for (j, s) in sorted.iter_mut().enumerate() {
            for k in 0..n { s[k] = h[k * NEAR_BINS + j]; }
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        }
        // Sky cells over the objects and the terrain, averaged over up to 48 points spread through the set; a crown that
        // passes light leaves its mean transmission of the cells behind it
        let m = n.min(48);
        let mut far_at = vec![0.0; NEAR_BINS];
        if !far.is_empty() { for j in 0..NEAR_BINS { far_at[j] = horizon_at(far, 2.0 * j as f64); } }
        let mut sky = SkyCells::default();
        let mut prof = vec![0.0; NEAR_BINS];
        let t_mean: Vec<f64> = trans.iter().map(|t| t.iter().sum::<f64>() / 12.0).collect();
        for i in 0..m {
            let k = i * n / m;
            let hk = &h[k * NEAR_BINS..(k + 1) * NEAR_BINS];
            for j in 0..NEAR_BINS { prof[j] = max(f64::from(hk[j]), far_at[j]); }
            let mut c = sky_cells(&prof);
            if layered {
                for j in 0..NEAR_BINS { prof[j] = max(f64::from(solid[k * NEAR_BINS + j]), far_at[j]); }
                let below = sky_cells(&prof);   // the sky above the solid layer and the terrain
                for jj in 0..c.band.len() {
                    let j = (jj * NEAR_BINS / c.band.len()).min(NEAR_BINS - 1);
                    let t = if tree[k * NEAR_BINS + j] > 0.0 { t_mean[tree_id[k * NEAR_BINS + j] as usize] } else { 0.0 };
                    c.band[jj] += t * (below.band[jj] - c.band[jj]);
                    for e in 0..90 { let q = jj * 90 + e; c.sky[q] += t * (below.sky[q] - c.sky[q]); }
                }
            }
            if sky.sky.is_empty() { sky = SkyCells { sky: vec![0.0; c.sky.len()], band: vec![0.0; c.band.len()] }; }
            for k in 0..c.sky.len() { sky.sky[k] += c.sky[k] / m as f64; }
            for k in 0..c.band.len() { sky.band[k] += c.band[k] / m as f64; }
        }
        let months = if trans.iter().any(|t| t.iter().any(|&x| x != t[0])) { 12 } else { 1 };
        let elec = strings.as_ref().is_some_and(|s| s.1 != NearModel::Linear && !s.0.tables.is_empty());
        let memo = if layered || elec { (0..months * NEAR_BINS).map(|_| OnceLock::new()).collect() } else { Vec::new() };
        NearShading { pts, h, sorted, sky, solid, tree, tree_id, trans, strings: if elec { strings } else { None }, memo, months }
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

    /// Share of the beam the points turn into power with the sun at (azimuth, elevation) in a local month (0-11): 1 minus the
    /// share behind an object, or with translucent crowns and the electrical model as the table by sun position gives it
    pub fn lit(&self, azimuth: f64, elevation: f64, month: usize) -> f64 {
        if self.memo.is_empty() { return 1.0 - self.shaded(azimuth, elevation); }
        // linear between the cells, which hold the light at the middle of each degree of elevation
        let (j, m) = (near_bin(azimuth), if self.months > 1 { month.min(11) } else { 0 });
        let x = (elevation - 0.5).clamp(0.0, 89.0);
        let (e0, f) = (x.floor() as usize, x - x.floor());
        let row = self.memo[m * NEAR_BINS + j].get_or_init(|| (0..90).map(|_| OnceLock::new()).collect());
        let cell = |e: usize| f64::from(*row[e].get_or_init(|| self.lit_cell(j, e as f32 + 0.5, m) as f32));
        if f > 0.0 { (1.0 - f) * cell(e0) + f * cell(e0 + 1) } else { cell(e0) }
    }

    /// The beam each point gets (0-1) with the sun at azimuth bin j and elevation e
    fn point_light(&self, j: usize, e: f32, m: usize) -> Vec<f64> {
        (0..self.pts.len()).map(|k| {
            let q = k * NEAR_BINS + j;
            if self.solid.is_empty() { return if e < self.h[q] { 0.0 } else { 1.0 }; }
            if e < self.solid[q] { 0.0 } else if e < self.tree[q] { self.trans[self.tree_id[q] as usize][m] } else { 1.0 }
        }).collect()
    }

    fn lit_cell(&self, j: usize, e: f32, m: usize) -> f64 {
        let l = self.point_light(j, e, m);
        let Some((lay, model)) = &self.strings else { return l.iter().sum::<f64>() / l.len() as f64 };
        // only the tables with a point short of the full beam need their strings worked out
        let mut touched = vec![false; lay.tables.len()];
        for (k, &x) in l.iter().enumerate() {
            if x < 1.0 { if let Some(t) = lay.table_of.get(k) { if let Some(f) = touched.get_mut(*t as usize) { *f = true; } } }
        }
        let mut total = touched.iter().filter(|&&f| !f).count() as f64;
        for (table, _) in lay.tables.iter().zip(&touched).filter(|x| *x.1) {
            let mut t = 0.0;
            for (string, own) in table.blocks.iter().zip(&table.points) {
                // each substring carries the current of its most shaded point
                let mut b: Vec<f64> = string.iter().map(|blk| blk.iter().fold(1.0f64, |a, &k| a.min(l[k as usize]))).collect();
                let worst = b.iter().fold(1.0f64, |a, &x| a.min(x));
                t += match model {
                    NearModel::String => worst,
                    NearModel::Bypass => {
                        // the inverter takes the current that gives most power: substrings below it are bypassed
                        b.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
                        b.iter().enumerate().fold(0.0f64, |best, (i, &x)| best.max(x * (i + 1) as f64)) / b.len() as f64
                    }
                    NearModel::Factor(f) => {
                        let lin = if own.is_empty() { b.iter().sum::<f64>() / b.len() as f64 } else { own.iter().map(|&k| l[k as usize]).sum::<f64>() / own.len() as f64 };
                        lin + f * (worst - lin)
                    }
                    NearModel::Linear => b.iter().sum::<f64>() / b.len() as f64,
                };
            }
            total += t / table.blocks.len().max(1) as f64;
        }
        total / lay.tables.len() as f64
    }

    /// With translucent crowns: the solid layer, the crown layer and its crowns' mean transmission at point k
    pub fn crown_layers(&self, k: usize) -> Option<(&[f32], &[f32], Vec<f64>)> {
        if self.solid.is_empty() { return None; }
        let r = k * NEAR_BINS..(k + 1) * NEAR_BINS;
        let t = self.tree_id[r.clone()].iter().map(|&i| self.trans[i as usize].iter().sum::<f64>() / 12.0).collect();
        Some((&self.solid[r.clone()], &self.tree[r], t))
    }
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
    /// a canopy's width up its plane (m), from its tables or its areas
    pub canopy_width: Option<f64>,
    /// ground slope of its areas (deg) and the azimuth it falls towards (None: the PV parameters')
    pub slope: Option<[f64; 2]>,
    /// with edge rows: the shares of its tables with no table in front of them and with none behind them (None: from the
    /// number of rows of the PV parameters)
    pub edge: Option<[f64; 2]>,
}

impl ArrayGroup {
    pub fn new(tilt: f64, azimuth: f64) -> ArrayGroup {
        ArrayGroup { tilt, azimuth, east_west: false, own_tilt: false, share: 1.0, canopy: false, tables: vec![], near: None, canopy_width: None, slope: None, edge: None }
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
    k.push(l.transmission.len() as u64);
    for t in &l.transmission { k.push(t.len() as u64); for &x in t { num(&mut k, x); } }
    text(&mut k, &pv.near_model);
    for v in [pv.near_factor, f64::from(pv.modules_along), f64::from(pv.modules_up), flag(pv.portrait), f64::from(pv.bypass_blocks)] { num(&mut k, v); }
    k.push(l.tables.len() as u64);
    for t in &l.tables { for q in t { num(&mut k, q[0]); num(&mut k, q[1]); } }
    k.push(l.table_area.len() as u64);
    for &a in &l.table_area { num(&mut k, f64::from(a)); }
    k
}

/// The strings of one table whose points start at `first`, n[0] along by n[1] up the slant (along outer): one string per
/// module up the table along the row, the substrings of a module side by side along it in portrait and stacked up it in
/// landscape (three per module), or the typed number of bypass-diode blocks up the table. A substring without a point of its
/// own takes the point nearest its centre.
/// `budget`: the most substrings the table may have, so the whole layout keeps a bounded number of them.
fn table_strings(n: [usize; 2], first: usize, pv: &crate::model::PVParams, budget: usize) -> TableStrings {
    let up = pv.modules_up.max(1) as usize;
    let bu = if pv.bypass_blocks > 0 { pv.bypass_blocks as usize } else { up * if pv.portrait { 1 } else { 3 } };
    let bu = bu.min(budget.max(1));
    let strings = up.min(bu);
    let ba = (pv.modules_along.max(1) as usize * if pv.portrait { 3 } else { 1 }).min(300).min((budget / bu).max(1));
    let mut blk = vec![vec![Vec::<u32>::new(); ba]; bu];
    let mut points = vec![Vec::new(); strings];
    let at = |i: usize, j: usize| (first + i * n[1] + j) as u32;
    for i in 0..n[0] {
        for j in 0..n[1] {
            let (u, v) = ((i as f64 + 0.5) / n[0] as f64, (j as f64 + 0.5) / n[1] as f64);
            let r = ((v * bu as f64) as usize).min(bu - 1);
            blk[r][((u * ba as f64) as usize).min(ba - 1)].push(at(i, j));
            points[r * strings / bu].push(at(i, j));
        }
    }
    for (r, row) in blk.iter_mut().enumerate() {
        for (c, b) in row.iter_mut().enumerate() {
            if b.is_empty() {
                let (u, v) = ((c as f64 + 0.5) / ba as f64, (r as f64 + 0.5) / bu as f64);
                b.push(at(((u * n[0] as f64) as usize).min(n[0] - 1), ((v * n[1] as f64) as usize).min(n[1] - 1)));
            }
        }
    }
    let mut blocks = vec![Vec::new(); strings];
    for (r, row) in blk.into_iter().enumerate() { blocks[r * strings / bu].extend(row); }
    TableStrings { blocks, points }
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
    // The width of each canopy up its plane: the extent of its tables (or of its areas) across the way they face
    for (gi, g) in groups.iter_mut().enumerate() {
        if !g.canopy { continue; }
        let (sf, cf) = sin_cos(g.azimuth * D2R);
        let ahead = |q: &PlanPoint| q[0] * sf + q[1] * cf;
        let pts: Vec<PlanPoint> = if g.tables.is_empty() {
            l.areas.iter().enumerate().filter(|(a, _)| area_group[*a] == gi).flat_map(|(_, a)| a.pts.clone()).collect()
        } else {
            g.tables.iter().flat_map(|&t| l.tables[t as usize].to_vec()).collect()
        };
        if pts.is_empty() { continue; }
        let (lo, hi) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (min(lo, ahead(q)), max(hi, ahead(q))));
        let c = (g.tilt * D2R).cos();
        if hi > lo && c > 0.05 { g.canopy_width = Some((hi - lo) / c); }
    }
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
        let model = match pv.near_model.as_str() {
            "bypass" => NearModel::Bypass,
            "string" => NearModel::String,
            "factor" => NearModel::Factor(pv.near_factor.clamp(0.0, 1.0)),
            _ => NearModel::Linear,
        };
        let mut lays: Vec<StringLayout> = vec![StringLayout::default(); groups.len()];
        if !l.tables.is_empty() {
            // Points spread over each table, up the slant from its upper edge [0]-[1] towards the lower edge [3]-[2], at a
            // spacing for about 20 000 points; at least one per table, so many tables raise the spacing until the count fits
            let plan = l.tables.iter().fold(0.0, |s, c| s + plan_area(c));
            let count = |s: f64| l.tables.iter().map(|c| { let g = grid(c, s); g[0] * g[1] }).sum::<usize>();
            let mut s = max(1.0, (plan / 20000.0).sqrt());
            while count(s) > 22000 && s < 2e5 { s *= 1.25; }   // thin tables have little plan area; past 200 km each gets one point
            for ((g, gp), lay) in groups.iter().zip(pts.iter_mut()).zip(lays.iter_mut()) {
                for &t in &g.tables {
                    let c = &l.tables[t as usize];
                    let n = grid(c, s);
                    if model != NearModel::Linear {
                        lay.table_of.resize(gp.len(), u32::MAX);
                        lay.table_of.extend(std::iter::repeat_n(lay.tables.len() as u32, n[0] * n[1]));
                        lay.tables.push(table_strings(n, gp.len(), pv, 2_000_000 / l.tables.len().max(1)));
                    }
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
        for ((g, gp), lay) in groups.iter_mut().zip(pts).zip(lays) {
            if gp.is_empty() { continue; }
            let strings = if lay.tables.is_empty() { None } else { Some((lay, model)) };
            g.near = Some(Arc::new(NearShading::with_options(gp, &l.obstacles, far, &l.transmission, strings)));
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
