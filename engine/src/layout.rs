//! The layout map of a project: PV areas, objects and tables from lat/lon polygons to metres around the site, and the
//! checks the engine makes before it uses them (src/model.cpp: parse_layout, validate_layout, layout_used).
use crate::json::{Error, Value};
use crate::validate::need;
use crate::model::{Crown, LayoutArea, Location, Obstacle, PlanPoint, Project, Roof, Shape, Shaped, SiteLayout};
use std::f64::consts::PI;

/// Leaf cover of a deciduous crown by month in the northern hemisphere (leaves out in April, fall in October)
const LEAVES_NORTH: [f64; 12] = [0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.0, 0.0];
/// Share of the beam bare branches pass
pub const BARE_TRANSMISSION: f64 = 0.6;

/// The share of the beam a crown passes in each local month: its leaf transmission all year (evergreen), or between that and
/// bare branches by the leaf cover of the month (deciduous; the southern hemisphere six months on). Empty for a solid crown.
pub fn crown_transmission(t: f64, deciduous: bool, lat: f64) -> Vec<f64> {
    let t = if t.is_finite() { t.clamp(0.0, 0.95) } else { 0.0 };
    if !deciduous { return if t > 0.0 { vec![t; 12] } else { vec![] }; }
    let bare = BARE_TRANSMISSION.max(t);
    (0..12).map(|m| { let c = LEAVES_NORTH[if lat >= 0.0 { m } else { (m + 6) % 12 }]; t + (1.0 - c) * (bare - t) }).collect()
}

/// Polygons of lat/lon pairs in metres east and north of the site, on the layout tool's projection. A tree is a centre and
/// a crown diameter, kept as a 16-sided polygon, with the light its crown passes by month and its crown shape; a building may
/// have a pitched or other shaped roof above its walls (`height`). Unknown roof and crown names leave a flat top.
pub fn parse_layout(ly: &Value, loc: &Location) -> SiteLayout {
    let mut s = SiteLayout::default();
    let ky = 110574.0;
    let kx = 111320.0 * (loc.lat * PI / 180.0).cos();
    let plan = |ll: &Value| -> PlanPoint { [(ll.idx(1).num(f64::NAN) - loc.lon) * kx, (ll.idx(0).num(f64::NAN) - loc.lat) * ky] };
    let ring = |lls: &Value| -> Vec<PlanPoint> { lls.arr().iter().map(plan).collect() };
    for g in ly.at("polygons").arr() {
        match g.gets("type", "").as_str() {
            "site" => s.areas.push(LayoutArea {
                pts: ring(g.at("latlngs")),
                base: g.get("base", 0.0),
                tilt: g.get("tilt", f64::NAN),
                azimuth: g.get("azimuth", f64::NAN),
                east_west: g.getb("east_west", false),
                canopy: g.getb("canopy", false),
                slope: g.get("slope", 0.0),
                slope_azimuth: g.get("slope_azimuth", f64::NAN),
                h0: g.get("h0", f64::NAN),
            }),
            "obstacle" => {
                let mut o = Obstacle { pts: vec![], height: g.get("height", f64::NAN), shape: Shape::Flat };
                let tree = g.gets("kind", "") == "tree";
                s.transmission.push(if tree { crown_transmission(g.get("transmission", 0.0), g.gets("leaves", "") == "deciduous", loc.lat) } else { vec![] });
                if g.has("center") {
                    let c = plan(g.at("center"));
                    let r = g.get("diameter", f64::NAN) / 2.0;
                    if r > 0.0 {
                        for k in 0..16 {
                            let a = f64::from(k) * PI / 8.0;
                            o.pts.push([c[0] + r * a.sin(), c[1] + r * a.cos()]);
                        }
                        let kind = match g.gets("shape", "").as_str() { "round" => Some(Crown::Round), "cone" => Some(Crown::Cone), "palm" => Some(Crown::Palm), _ => None };
                        if let Some(kind) = kind.filter(|_| tree) { o.shape = Shape::Crown { kind, center: c, r }; }
                    }
                } else {
                    o.pts = ring(g.at("latlngs"));
                    let kind = match g.gets("roof", "").as_str() { "gable" => Some(Roof::Gable), "hip" => Some(Roof::Hip), "shed" => Some(Roof::Shed), _ => None };
                    if let Some(kind) = kind.filter(|_| !tree) {
                        let pitch = g.get("pitch", f64::NAN);
                        o.shape = Shape::Roof { kind, pitch: if pitch > 0.0 { pitch.clamp(1.0, 75.0) } else { 25.0 }, ridge_az: g.get("ridge_az", 0.0) };   // as cleanItem (ui/src/lib/layout/items.js)
                    } else if let Some(kind) = shaped_kind(&g.gets("roof", "")).filter(|_| !tree) {
                        o.shape = shaped(g, kind);
                    }
                }
                s.obstacles.push(o);
            }
            _ => {}
        }
    }
    if s.transmission.iter().all(Vec::is_empty) { s.transmission.clear(); }
    let result = ly.at("result");
    for t in result.at("tables").arr() {
        s.tables.push([plan(t.idx(0)), plan(t.idx(1)), plan(t.idx(2)), plan(t.idx(3))]);
    }
    for a in result.at("table_area").arr() {
        s.table_area.push(a.num(-2.0).clamp(-2.0, 1e6) as i32);
    }
    s
}

fn shaped_kind(name: &str) -> Option<Shaped> {
    Some(match name {
        "parapet" => Shaped::Parapet, "mansard" => Shaped::Mansard, "gambrel" => Shaped::Gambrel, "pyramid" => Shaped::Pyramid,
        "butterfly" => Shaped::Butterfly, "sawtooth" => Shaped::Sawtooth, "barrel" => Shaped::Barrel, "cone" => Shaped::Cone, "dome" => Shaped::Dome,
        _ => return None,
    })
}

/// Defaults of the fields a roof shape uses (pitch, pitch2, rise, width; NaN: rise from the footprint), as ROOF_DEFAULTS in
/// ui/src/lib/layout/solids.js; a field it does not use is 0
pub fn shaped_defaults(kind: Shaped) -> [f64; 4] {
    match kind {
        Shaped::Parapet => [0.0, 0.0, 1.0, 0.0],
        Shaped::Mansard => [70.0, 20.0, 2.5, 0.0],
        Shaped::Gambrel => [60.0, 25.0, 2.5, 0.0],
        Shaped::Pyramid => [25.0, 0.0, 0.0, 0.0],
        Shaped::Butterfly => [10.0, 0.0, 0.0, 0.0],
        Shaped::Sawtooth => [25.0, 0.0, 0.0, 6.0],
        Shaped::Barrel | Shaped::Cone | Shaped::Dome => [0.0, 0.0, f64::NAN, 0.0],
    }
}

/// Ranges of rise: a parapet up to 10 m, a break, vault, cone or dome up to 200 m (RISE in items.js)
pub fn rise_range(kind: Shaped) -> (f64, f64) { if kind == Shaped::Parapet { (0.1, 10.0) } else { (0.1, 200.0) } }

/// A roof shape from the fields of a building, brought into range as cleanItem does: a missing or non-positive field takes its
/// default, the upper pitch is at most the lower one
fn shaped(g: &Value, kind: Shaped) -> Shape {
    let d = shaped_defaults(kind);
    let take = |key: &str, def: f64, lo: f64, hi: f64| if def == 0.0 { 0.0 } else { let v = g.get(key, f64::NAN); if v > 0.0 { v.clamp(lo, hi) } else { def } };
    let pitch = take("pitch", d[0], 1.0, 75.0);
    let (lo, hi) = rise_range(kind);
    let rise = if d[2] == 0.0 { 0.0 } else { let v = g.get("rise", f64::NAN); if v > 0.0 { v.clamp(lo, hi) } else { d[2] } };
    let az = g.get("ridge_az", 0.0);
    Shape::Shaped { kind, pitch, pitch2: take("pitch2", d[1], 1.0, 75.0).min(pitch), rise, width: take("width", d[3], 1.0, 100.0), az: if az.is_finite() { az.rem_euclid(360.0) } else { 0.0 } }
}

/// The engine uses the layout only for its objects (near shading on), for areas with their own orientation (fixed tables)
/// and for the tables at the edges of the array (edge rows on); otherwise it is left alone, unchecked.
pub fn layout_used(p: &Project) -> bool {
    let objects = p.pv.near_shading && !p.layout.obstacles.is_empty();
    let own = p.pv.mount != "tracker"
        && p.layout.areas.iter().any(|a| a.tilt.is_finite() || a.azimuth.is_finite() || a.east_west || a.canopy || a.slope > 0.0);
    let edges = p.pv.edge_rows && !p.layout.tables.is_empty();
    objects || own || edges
}

/// No more items than the near-shading geometry handles in reasonable time, every point within 50 km of the site
pub fn validate_layout(ly: &SiteLayout) -> Result<(), Error> {
    let near_site = |v: &[PlanPoint]| v.iter().all(|q| q[0].abs() <= 5e4 && q[1].abs() <= 5e4);
    need(ly.areas.len() <= 1000 && ly.obstacles.len() <= 5000 && ly.tables.len() <= 30000,
         "The layout has too many items: at most 1000 PV areas, 5000 objects and 30000 tables.")?;
    let area_corners: usize = ly.areas.iter().map(|a| a.pts.len()).sum();
    let object_corners: usize = ly.obstacles.iter().map(|o| o.pts.len()).sum();
    need(area_corners <= 100000 && object_corners <= 100000,
         "The layout has too many corners: at most 100000 for the PV areas and 100000 for the objects.")?;
    for a in &ly.areas {
        need(a.pts.len() >= 3 && a.pts.len() <= 10000 && near_site(&a.pts), "Every PV area needs 3 to 10000 corners within 50 km of the site.")?;
        need(a.base >= 0.0 && a.base <= 500.0, "The surface height of a PV area must be 0 to 500 m.")?;
        need(a.tilt.is_nan() || (a.tilt >= 0.0 && a.tilt <= 90.0), "The tilt of a PV area must be 0 to 90 deg.")?;
        need(a.azimuth.is_nan() || (a.azimuth >= 0.0 && a.azimuth <= 360.0), "The azimuth of a PV area must be 0 to 360 deg.")?;
        need(a.slope >= 0.0 && a.slope <= 45.0 && (a.slope_azimuth.is_nan() || (a.slope_azimuth >= 0.0 && a.slope_azimuth <= 360.0)),
             "The ground slope of a PV area must be 0 to 45 deg, falling towards an azimuth of 0 to 360 deg.")?;
        need(a.h0.is_nan() || (a.h0 >= 0.0 && a.h0 <= 30.0), "The table height of a PV area must be 0 to 30 m.")?;
    }
    for o in &ly.obstacles {
        need(o.pts.len() >= 3 && o.pts.len() <= 5000 && near_site(&o.pts) && o.height > 0.0 && o.height <= 1000.0,
             "Every building or tree needs a footprint within 50 km of the site (a tree a crown diameter above 0) and a height of up to 1000 m.")?;
        match o.shape {
            Shape::Flat => {}
            Shape::Roof { pitch, ridge_az, .. } => need((1.0..=75.0).contains(&pitch) && (0.0..=360.0).contains(&ridge_az),
                                                       "A pitched roof needs a pitch of 1 to 75 deg and a ridge azimuth of 0 to 360 deg.")?,
            Shape::Crown { center, r, .. } => need(r > 0.0 && r <= 5e4 && near_site(&[center]), "A tree crown needs a diameter above 0 within 50 km of the site.")?,
            Shape::Shaped { kind, pitch, pitch2, rise, width, az } => {
                let d = shaped_defaults(kind);
                let (lo, hi) = rise_range(kind);
                let ok = |v: f64, def: f64, r: std::ops::RangeInclusive<f64>| if def == 0.0 { v == 0.0 } else { r.contains(&v) };
                need(ok(pitch, d[0], 1.0..=75.0) && ok(pitch2, d[1], 1.0..=pitch.max(1.0)) && ok(width, d[3], 1.0..=100.0)
                         && (if d[2] == 0.0 { rise == 0.0 } else { (d[2].is_nan() && rise.is_nan()) || (lo..=hi).contains(&rise) })
                         && (0.0..=360.0).contains(&az),
                     "A roof shape needs pitches of 1 to 75 deg (the upper one at most the lower), a rise of 0.1 to 200 m (a parapet up to 10 m), a tooth width of 1 to 100 m and an azimuth of 0 to 360 deg.")?
            }
        }
    }
    need((ly.transmission.is_empty() || ly.transmission.len() == ly.obstacles.len())
             && ly.transmission.iter().all(|t| t.is_empty() || (t.len() == 12 && t.iter().all(|&x| (0.0..=0.95).contains(&x)))),
         "The light through a tree crown must be 0 to 95 % in each of 12 months.")?;
    for t in &ly.tables {
        need(near_site(t), "A table of the layout lies more than 50 km from the site.")?;
    }
    need(ly.table_area.is_empty()
             || (ly.table_area.len() == ly.tables.len() && ly.table_area.iter().all(|&a| a >= -1 && (a as i64) < ly.areas.len() as i64)),
         "The layout's list of table areas does not match its tables: fill the areas with tables again.")
}
