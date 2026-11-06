//! The layout map of a project: PV areas, objects and tables from lat/lon polygons to metres around the site, and the
//! checks the engine makes before it uses them (src/model.cpp: parse_layout, validate_layout, layout_used).
use crate::json::{Error, Value};
use crate::validate::need;
use crate::model::{LayoutArea, Location, Obstacle, PlanPoint, Project, SiteLayout};
use std::f64::consts::PI;

/// Polygons of lat/lon pairs in metres east and north of the site, on the layout tool's projection. A tree is a centre and
/// a crown diameter, kept as a 16-sided polygon.
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
            }),
            "obstacle" => {
                let mut o = Obstacle { pts: vec![], height: g.get("height", f64::NAN) };
                if g.has("center") {
                    let c = plan(g.at("center"));
                    let r = g.get("diameter", f64::NAN) / 2.0;
                    if r > 0.0 {
                        for k in 0..16 {
                            let a = f64::from(k) * PI / 8.0;
                            o.pts.push([c[0] + r * a.sin(), c[1] + r * a.cos()]);
                        }
                    }
                } else {
                    o.pts = ring(g.at("latlngs"));
                }
                s.obstacles.push(o);
            }
            _ => {}
        }
    }
    let result = ly.at("result");
    for t in result.at("tables").arr() {
        s.tables.push([plan(t.idx(0)), plan(t.idx(1)), plan(t.idx(2)), plan(t.idx(3))]);
    }
    for a in result.at("table_area").arr() {
        s.table_area.push(a.num(-2.0).clamp(-2.0, 1e6) as i32);
    }
    s
}

/// The engine uses the layout only for its objects (near shading on) and for areas with their own orientation (fixed
/// tables); otherwise it is left alone, unchecked.
pub fn layout_used(p: &Project) -> bool {
    let objects = p.pv.near_shading && !p.layout.obstacles.is_empty();
    let own = p.pv.mount != "tracker"
        && p.layout.areas.iter().any(|a| a.tilt.is_finite() || a.azimuth.is_finite() || a.east_west || a.canopy);
    objects || own
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
    }
    for o in &ly.obstacles {
        need(o.pts.len() >= 3 && o.pts.len() <= 5000 && near_site(&o.pts) && o.height > 0.0 && o.height <= 1000.0,
             "Every building or tree needs a footprint within 50 km of the site (a tree a crown diameter above 0) and a height of up to 1000 m.")?;
    }
    for t in &ly.tables {
        need(near_site(t), "A table of the layout lies more than 50 km from the site.")?;
    }
    need(ly.table_area.is_empty()
             || (ly.table_area.len() == ly.tables.len() && ly.table_area.iter().all(|&a| a >= -1 && (a as i64) < ly.areas.len() as i64)),
         "The layout's list of table areas does not match its tables: fill the areas with tables again.")
}
