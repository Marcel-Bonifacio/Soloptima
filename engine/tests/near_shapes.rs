//! Pitched roofs, shaped tree crowns, per-area table heights and sloped ground in the near shading: horizons against values
//! worked out by hand, the shade points of a sloped area, the layout fields and their checks, and random layouts that must
//! never give a NaN or an elevation outside 0 to 90 deg.
use soloptima_engine::layout::parse_layout;
use soloptima_engine::shading::{array_groups, near_bin, near_horizon, NearShading, ShadePoint, NEAR_BINS};
use soloptima_engine::*;

const D2R: f64 = std::f64::consts::PI / 180.0;
const R2D: f64 = 180.0 / std::f64::consts::PI;

/// 20 m along x, 10 m deep, 5 to 15 m south of the origin
fn block() -> Vec<PlanPoint> { vec![[-10.0, -15.0], [10.0, -15.0], [10.0, -5.0], [-10.0, -5.0]] }
fn roof(kind: Roof, pitch: f64, ridge_az: f64) -> Obstacle { Obstacle { pts: block(), height: 4.0, shape: Shape::Roof { kind, pitch, ridge_az } } }
fn tree(kind: Option<Crown>, c: PlanPoint, r: f64, h: f64) -> Obstacle {
    let pts = (0..16).map(|k| { let a = f64::from(k) * std::f64::consts::PI / 8.0; [c[0] + r * a.sin(), c[1] + r * a.cos()] }).collect();
    Obstacle { pts, height: h, shape: kind.map_or(Shape::Flat, |kind| Shape::Crown { kind, center: c, r }) }
}
fn at(x: f64, y: f64, z: f64, o: &Obstacle, az: f64) -> f64 { f64::from(near_horizon(x, y, z, std::slice::from_ref(o))[near_bin(az)]) }
fn deg(x: f64) -> f64 { x.atan() * R2D }
fn close(a: f64, b: f64, tol: f64, what: &str) { assert!((a - b).abs() <= tol, "{what}: {a} vs {b}"); }

#[test]
fn flat_building_as_before() {
    // a 6 m building 10 m south of a point 1 m up: atan(5/10) due south
    let o = Obstacle { pts: vec![[-10.0, -30.0], [10.0, -30.0], [10.0, -10.0], [-10.0, -10.0]], height: 6.0, ..Default::default() };
    close(at(0.0, 0.0, 1.0, &o, 180.0), deg(0.5), 1e-4, "flat building");
}

#[test]
fn gable_hip_and_shed_roofs() {
    let k = (30.0 * D2R).tan();
    // Gable along x, eaves 4 m, pitch 30 deg: from 5 m in front of the long side at z = 1 the eave (3 m up, 5 m off) or the
    // ridge (4 + 5 tan 30 - 1 up, 10 m off)
    let gable = roof(Roof::Gable, 30.0, 90.0);
    let front = deg(3.0 / 5.0).max(deg((4.0 + 5.0 * k - 1.0) / 10.0));
    close(at(0.0, 0.0, 1.0, &gable, 180.0), front, 1e-4, "gable from the front");
    // from 10 m off its gable end, looking along the ridge: the gable wall up to the ridge 10 m off
    close(at(20.0, -10.0, 1.0, &gable, 270.0), deg((4.0 + 5.0 * k - 1.0) / 10.0), 1e-4, "gable end");
    // A hip roof has the same front, but from the end the hip ends the ridge 5 m in from the eave: 15 m off
    let hip = roof(Roof::Hip, 30.0, 90.0);
    close(at(0.0, 0.0, 1.0, &hip, 180.0), front, 1e-4, "hip from the front");
    close(at(20.0, -10.0, 1.0, &hip, 270.0), deg(3.0 / 10.0).max(deg((4.0 + 5.0 * k - 1.0) / 15.0)), 1e-4, "hip end");
    // off the axis the ray crosses a hip face: still the highest point on the ray, here the ridge end seen obliquely
    let oblique = at(20.0, -4.0, 1.0, &hip, 225.0);
    assert!(oblique > 0.0 && oblique < 30.0, "hip seen obliquely: {oblique}");
    // A shed falling south: its high eave (4 + 10 tan 30) is the near one; falling north it is 15 m off
    let south = roof(Roof::Shed, 30.0, 180.0);
    close(at(0.0, 0.0, 1.0, &south, 180.0), deg((4.0 + 10.0 * k - 1.0) / 5.0), 1e-4, "shed falling away from the point");
    let north = roof(Roof::Shed, 30.0, 0.0);
    close(at(0.0, 0.0, 1.0, &north, 180.0), deg(3.0 / 5.0).max(deg((4.0 + 10.0 * k - 1.0) / 15.0)), 1e-4, "shed falling towards the point");
    // A pitched roof stands higher than a flat one at the eaves, so it shades a point the flat top would not
    let flat = Obstacle { pts: block(), height: 4.0, ..Default::default() };
    assert!(at(0.0, 30.0, 1.0, &gable, 180.0) > at(0.0, 30.0, 1.0, &flat, 180.0), "the ridge over the eaves");
}

#[test]
fn points_on_a_roof() {
    let k = (30.0 * D2R).tan();
    // 0.2 m above the middle of a shed falling south: nothing downhill; uphill the high eave rises above the point's level
    // (5 m off, 5 tan 30 - 0.2 m up), still below the roof's own pitch, so it hides nothing a module on the roof sees
    let shed = roof(Roof::Shed, 30.0, 180.0);
    let z = 4.0 + 5.0 * k + 0.2;
    let h = near_horizon(0.0, -10.0, z, std::slice::from_ref(&shed));
    assert!(h[near_bin(180.0)] == 0.0 && h[near_bin(90.0)] == 0.0 && h[near_bin(270.0)] == 0.0, "nothing downhill or along the slope");
    let up = f64::from(h[near_bin(0.0)]);
    close(up, deg((5.0 * k - 0.2) / 5.0), 1e-4, "uphill: the high eave");
    assert!(up < 30.0, "below the roof's pitch");
    // below the roof plane: under the roof
    assert!(near_horizon(0.0, -10.0, z - 0.4, std::slice::from_ref(&shed)).iter().all(|&e| e == 90.0), "under the shed");
    // 0.2 m above the north slope of a gable, 2 m in from its north eave: the ridge 3 m south, 3 tan 30 - 0.2 m up
    let gable = roof(Roof::Gable, 30.0, 90.0);
    let g = near_horizon(0.0, -7.0, 4.0 + 2.0 * k + 0.2, std::slice::from_ref(&gable));
    close(f64::from(g[near_bin(180.0)]), deg((3.0 * k - 0.2) / 3.0), 1e-4, "north slope towards the ridge");
    assert!(g[near_bin(0.0)] == 0.0, "nothing downhill");
    // on the south slope the same point sees nothing to the south
    assert!(near_horizon(0.0, -13.0, 4.0 + 2.0 * k + 0.2, std::slice::from_ref(&gable))[near_bin(180.0)] == 0.0, "south slope");
}

#[test]
fn tree_crowns() {
    let (h, r, z) = (10.0, 3.0, 1.0);
    // A cone's apex 10 m off
    let cone = tree(Some(Crown::Cone), [0.0, -10.0], r, h);
    close(at(0.0, 0.0, z, &cone, 180.0), deg((h - z) / 10.0), 0.05, "cone apex");
    // A palm's crown is highest at its near rim: max of (h - 0.5 |t - 10| - z) / t
    let palm = tree(Some(Crown::Palm), [0.0, -10.0], r, h);
    close(at(0.0, 0.0, z, &palm, 180.0), deg((h - 0.5 * r - z) / (10.0 - r)), 0.05, "palm rim");
    // A round crown: the ellipsoid cap h - rv + rv sqrt(1 - (d/r)^2), rv = min(r, h/2), at its steepest
    let round = tree(Some(Crown::Round), [0.0, -10.0], r, h);
    let rv = r.min(h / 2.0);
    let best = (0..=100000).map(|i| {
        let t = 10.0 - r + 2.0 * r * f64::from(i) / 100000.0;
        let d = (t - 10.0).abs().min(r);
        deg((h - rv + rv * (1.0 - (d / r).powi(2)).max(0.0).sqrt() - z) / t)
    }).fold(0.0, f64::max);
    close(at(0.0, 0.0, z, &round, 180.0), best, 0.5, "round crown");
    // every shaped crown is lower than the legacy cylinder of the same size
    let cyl = tree(None, [0.0, -10.0], r, h);
    for t in [&cone, &palm, &round] { assert!(at(0.0, 0.0, z, t, 180.0) < at(0.0, 0.0, z, &cyl, 180.0), "below the cylinder"); }
    // In the crown's circle but above it: not under it; below its surface: under it
    let hd = h - rv + rv * (1.0 - (2.5f64 / r).powi(2)).sqrt();
    let above = near_horizon(0.0, -7.5, hd + 0.3, std::slice::from_ref(&round));
    assert!(above[near_bin(180.0)] > 0.0 && above[near_bin(180.0)] < 90.0 && above[near_bin(0.0)] == 0.0, "above the crown: {}", above[near_bin(180.0)]);
    assert!(near_horizon(0.0, -7.5, hd - 0.3, std::slice::from_ref(&round)).iter().all(|&e| e == 90.0), "in the crown");
    // the 16-gon cylinder keeps its old rule: anywhere inside is under it
    assert!(near_horizon(0.0, -7.5, h - 0.1, std::slice::from_ref(&cyl)).iter().all(|&e| e == 90.0), "in the cylinder");
}

#[test]
fn shaped_crowns_pass_light() {
    // A crown that passes light gives the same edge in its layer as the solid crown gives
    let mut house = roof(Roof::Hip, 35.0, 30.0);
    for q in house.pts.iter_mut() { q[0] += 30.0; }
    let objs = vec![tree(Some(Crown::Round), [0.0, -10.0], 3.0, 10.0), house];
    let pts = vec![ShadePoint { x: 0.0, y: 0.0, z: 1.0, table: -1 }, ShadePoint { x: 15.0, y: 5.0, z: 0.5, table: -1 }];
    let solid = NearShading::new(pts.clone(), &objs, &[]);
    let lit = NearShading::with_options(pts, &objs, &[], &[vec![0.4; 12], vec![]], None);
    for k in 0..2 { assert_eq!(solid.horizon(k), lit.horizon(k), "same edges"); }
    let (s, t, tr) = lit.crown_layers(0).unwrap();
    let j = near_bin(180.0);
    assert!(t[j] > 0.0 && s[j] == 0.0 && (tr[j] - 0.4).abs() < 1e-12 && s[near_bin(110.0)] > 0.0, "the crown in its layer, the house in the solid one");
}

/// lat/lon of a point x m east, y m north of the site at (lat, lon)
fn ll(x: f64, y: f64, loc: &Location) -> Value {
    let kx = 111320.0 * (loc.lat * D2R).cos();
    let mut a = Value::array();
    a.push(y / 110574.0 + loc.lat);
    a.push(x / kx + loc.lon);
    a
}

#[test]
fn layout_fields() {
    let loc = Location { lat: -8.0, lon: 115.0, ..Default::default() };
    let ring = |pts: &[PlanPoint]| { let mut a = Value::array(); for q in pts { a.push(ll(q[0], q[1], &loc)); } a };
    let text = r#"{"polygons": [
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "gable", "pitch": 30, "ridge_az": 90},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "hip"},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "shed", "pitch": 80, "ridge_az": "x"},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "dome", "pitch": 30},
        {"type": "obstacle", "kind": "building", "height": 4},
        {"type": "obstacle", "kind": "tree", "diameter": 6, "height": 10, "shape": "cone"},
        {"type": "obstacle", "kind": "tree", "diameter": 6, "height": 10, "shape": "willow"},
        {"type": "obstacle", "kind": "tree", "diameter": 6, "height": 10, "shape": 3},
        {"type": "site", "h0": 2.5, "carport": true},
        {"type": "site"}]}"#;
    let mut v = Value::parse(text).unwrap();
    if let Value::Obj(o) = &mut v {
        if let Some(Value::Arr(items)) = o.get_mut("polygons") {
            for g in items.iter_mut() {
                match g.gets("kind", "").as_str() {
                    "tree" => g.set("center", ll(0.0, -10.0, &loc)),
                    _ => g.set("latlngs", ring(&[[-10.0, -15.0], [10.0, -15.0], [10.0, -5.0], [-10.0, -5.0]])),
                }
            }
        }
    }
    let ly = parse_layout(&v, &loc);
    let s: Vec<Shape> = ly.obstacles.iter().map(|o| o.shape).collect();
    assert_eq!(s[0], Shape::Roof { kind: Roof::Gable, pitch: 30.0, ridge_az: 90.0 });
    assert_eq!(s[1], Shape::Roof { kind: Roof::Hip, pitch: 25.0, ridge_az: 0.0 }, "pitch 25 and ridge 0 by default");
    assert_eq!(s[2], Shape::Roof { kind: Roof::Shed, pitch: 75.0, ridge_az: 0.0 }, "too steep a pitch: 75 deg, as the layout map keeps it; a ridge not a number: 0");
    assert!(s[3] == Shape::Flat && s[4] == Shape::Flat && s[6] == Shape::Flat && s[7] == Shape::Flat, "unknown names: flat");
    assert!(matches!(s[5], Shape::Crown { kind: Crown::Cone, r, .. } if (r - 3.0).abs() < 1e-12) && ly.obstacles[5].pts.len() == 16, "a cone keeps its 16-gon");
    assert!(ly.areas[0].h0 == 2.5 && ly.areas[1].h0.is_nan(), "table height of an area");
    assert!(validate_layout(&SiteLayout { areas: vec![], ..ly.clone() }).is_ok(), "valid objects");
    // out of range when made in code
    let bad = |f: &dyn Fn(&mut SiteLayout)| { let mut l = ly.clone(); l.areas.clear(); f(&mut l); validate_layout(&l).is_err() };
    assert!(bad(&|l| l.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: 80.0, ridge_az: 0.0 }), "pitch 80");
    assert!(bad(&|l| l.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: 30.0, ridge_az: 400.0 }), "ridge 400");
    assert!(bad(&|l| l.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: f64::NAN, ridge_az: 0.0 }), "pitch NaN");
    let mut a = ly.clone();
    a.obstacles.clear();
    a.transmission.clear();
    for p in a.areas.iter_mut() { p.pts = block(); }
    a.areas[0].h0 = 31.0;
    assert!(validate_layout(&a).is_err(), "h0 31");
    a.areas[0].h0 = 0.0;
    assert!(validate_layout(&a).is_ok(), "h0 0");
    // Nothing panics on items of the wrong shape
    let junk = r#"{"polygons": [{"type": "obstacle", "kind": "tree", "center": "x", "diameter": [1], "shape": "round"},
        {"type": "obstacle", "kind": "tree", "center": [1], "diameter": 4, "height": 5, "shape": "palm"},
        {"type": "obstacle", "roof": "hip", "pitch": null, "ridge_az": {}, "latlngs": [[1, 2], "y", []]},
        {"type": "obstacle", "roof": "gable"}, {"type": "site", "h0": "high", "latlngs": 5}, {"type": "obstacle", "kind": "tree"}]}"#;
    let ly = parse_layout(&Value::parse(junk).unwrap(), &loc);
    let _ = validate_layout(&ly);
    let pts: Vec<ShadePoint> = (0..20).map(|i| ShadePoint { x: f64::from(i), y: 0.0, z: 1.0, table: -1 }).collect();
    let n = NearShading::with_options(pts, &ly.obstacles, &[], &ly.transmission, None);
    assert!((0..20).all(|k| n.horizon(k).iter().all(|&e| e.is_nan() || (0.0..=90.0).contains(&e))), "junk in, no panic");
}

/// A fixed array facing north on an area 100 m square around the origin, near shading on, with the tables given
fn sloped_project(tables: &[[f64; 2]]) -> Project {
    let mut p = Project::default();
    p.loc.lat = -8.0;
    p.loc.lon = 115.0;
    p.pv.azimuth = 0.0;
    p.pv.tilt = 10.0;
    p.layout.areas.push(LayoutArea { pts: vec![[-50.0, -50.0], [50.0, -50.0], [50.0, 50.0], [30.0, 50.0], [-50.0, 50.0]], ..Default::default() });
    for c in tables { p.layout.tables.push([[c[0] - 1.0, c[1] + 1.0], [c[0] + 1.0, c[1] + 1.0], [c[0] + 1.0, c[1] - 1.0], [c[0] - 1.0, c[1] - 1.0]]); }
    p.layout.obstacles.push(Obstacle { pts: vec![[-2.0, -2.0], [2.0, -2.0], [2.0, 2.0], [-2.0, 2.0]], height: 6.0, ..Default::default() });
    p
}

#[test]
fn shade_points_on_sloped_ground() {
    let tables = [[12.0, 0.0], [-12.0, 0.0], [0.0, 30.0], [25.0, -40.0]];
    let level = sloped_project(&tables);
    let mut slope = level.clone();
    slope.layout.areas[0].slope = 10.0;
    slope.layout.areas[0].slope_azimuth = 90.0;   // falls east
    let points = |p: &Project| array_groups(p).unwrap()[0].near.clone().unwrap();
    let (a, b) = (points(&level), points(&slope));
    // the mean of the corners (not the centroid): (30 / 5, 50 / 5)
    let (cx, cy) = (30.0 / 5.0, 50.0 / 5.0);
    let t = (10.0 * D2R).tan();
    assert_eq!(a.points().len(), b.points().len());
    // a table is rigid: every point of it rises by the ground height at the table's centre
    let centre = |k: i32| tables[k as usize];
    for (p, q) in a.points().iter().zip(b.points()) {
        let c = centre(q.table);
        let zg = -t * ((c[0] - cx) * (90.0 * D2R).sin() + (c[1] - cy) * (90.0 * D2R).cos());
        assert!(p.x == q.x && p.y == q.y && (q.z - p.z - zg).abs() < 1e-9, "z on the slope: {} vs {} + {zg}", q.z, p.z);
    }
    // without a slope azimuth the ground falls the way the tables face (north here)
    let mut facing = level.clone();
    facing.layout.areas[0].slope = 10.0;
    let f = points(&facing);
    for (p, q) in a.points().iter().zip(f.points()) { assert!((q.z - p.z + t * (centre(q.table)[1] - cy)).abs() < 1e-9, "falls north"); }
    // The building's shade: the table downhill (east) sits lower and sees it higher than the one uphill (west), which on
    // level ground see it alike
    let east = |n: &NearShading| n.points().iter().enumerate().filter(|(_, p)| p.table == 0).map(|(k, _)| n.horizon(k)[near_bin(270.0)]).fold(0f32, f32::max);
    let west = |n: &NearShading| n.points().iter().enumerate().filter(|(_, p)| p.table == 1).map(|(k, _)| n.horizon(k)[near_bin(90.0)]).fold(0f32, f32::max);
    assert!((east(&a) - west(&a)).abs() < 1e-4, "level: {} vs {}", east(&a), west(&a));
    assert!(east(&b) > west(&b) + 1.0, "downhill {} vs uphill {}", east(&b), west(&b));
    // Trackers stand on level ground whatever the slope
    let (mut tl, mut ts) = (level.clone(), slope.clone());
    tl.pv.mount = "tracker".into();
    ts.pv.mount = "tracker".into();
    assert!(points(&tl).points().iter().zip(points(&ts).points()).all(|(p, q)| p.z == q.z), "trackers level");
}

#[test]
fn table_height_of_an_area() {
    let level = sloped_project(&[[12.0, 0.0], [-12.0, 0.0]]);
    let mut high = level.clone();
    high.layout.areas[0].h0 = 4.0;
    let a = array_groups(&level).unwrap()[0].near.clone().unwrap();
    let b = array_groups(&high).unwrap()[0].near.clone().unwrap();
    for (p, q) in a.points().iter().zip(b.points()) { assert!((q.z - p.z - (4.0 - level.pv.mount_height)).abs() < 1e-12, "h0 over the mount height"); }
    assert!(b.horizon(0)[near_bin(270.0)] < a.horizon(0)[near_bin(270.0)], "higher tables, lower building");
    // without tables: the grid over the area at its own height
    let (mut ga, mut gb) = (level.clone(), high.clone());
    ga.layout.tables.clear();
    gb.layout.tables.clear();
    let (a, b) = (array_groups(&ga).unwrap()[0].near.clone().unwrap(), array_groups(&gb).unwrap()[0].near.clone().unwrap());
    assert!(a.points().iter().zip(b.points()).all(|(p, q)| (q.z - p.z - 2.5).abs() < 1e-12), "area grid at h0");
}

#[test]
fn cached_groups_follow_the_new_fields() {
    // Each new field changes the near shading the cache gives back
    let base = sloped_project(&[[0.0, -10.0], [8.0, 6.0]]);
    let mut variants = vec![base.clone()];
    let mut v = base.clone();
    v.layout.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: 30.0, ridge_az: 0.0 };
    variants.push(v.clone());
    v.layout.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: 40.0, ridge_az: 0.0 };
    variants.push(v.clone());
    v.layout.obstacles[0].shape = Shape::Roof { kind: Roof::Gable, pitch: 40.0, ridge_az: 90.0 };
    variants.push(v.clone());
    v.layout.obstacles[0].shape = Shape::Roof { kind: Roof::Hip, pitch: 40.0, ridge_az: 90.0 };
    variants.push(v.clone());
    let mut t = base.clone();
    t.layout.obstacles[0] = tree(Some(Crown::Round), [0.0, 0.0], 3.0, 9.0);
    variants.push(t.clone());
    t.layout.obstacles[0] = tree(Some(Crown::Cone), [0.0, 0.0], 3.0, 9.0);
    variants.push(t);
    let mut h = base.clone();
    h.layout.areas[0].h0 = 3.0;
    variants.push(h);
    let hz = |p: &Project| array_groups(p).unwrap()[0].near.as_ref().unwrap().horizon(0).to_vec();
    let first: Vec<Vec<f32>> = variants.iter().map(hz).collect();
    for i in 0..first.len() { for j in 0..i { assert_ne!(first[i], first[j], "variants {i} and {j}"); } }
    // asked again in turn (the cache keeps the last two layouts), each gives its own
    for (p, f) in variants.iter().zip(&first) { assert_eq!(&hz(p), f); }
}

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[test]
fn random_objects_never_break() {
    // Thousands of objects of every kind (non-convex outlines among them) in clusters, and points around and on them: every
    // elevation a number from 0 to 90 deg
    let mut r = Rng(12345);
    let mut objs = Vec::new();
    for i in 0..3000 {
        let (cx, cy) = (r.f() * 400.0 - 200.0, r.f() * 400.0 - 200.0);
        let h = 0.5 + r.f() * 30.0;
        let o = if i % 7 < 4 {
            let n = 3 + (r.f() * 9.0) as usize;
            let size = 1.0 + r.f() * 30.0;
            let pts = (0..n).map(|k| { let a = k as f64 * 2.0 * std::f64::consts::PI / n as f64; let rr = size * (0.3 + 0.7 * r.f()); [cx + rr * a.sin(), cy + rr * a.cos()] }).collect();
            let shape = match i % 7 {
                0 => Shape::Flat,
                1 => Shape::Roof { kind: Roof::Gable, pitch: 1.0 + r.f() * 74.0, ridge_az: r.f() * 360.0 },
                2 => Shape::Roof { kind: Roof::Hip, pitch: 1.0 + r.f() * 74.0, ridge_az: r.f() * 360.0 },
                _ => Shape::Roof { kind: Roof::Shed, pitch: 1.0 + r.f() * 74.0, ridge_az: r.f() * 360.0 },
            };
            Obstacle { pts, height: h, shape }
        } else {
            tree([Some(Crown::Round), Some(Crown::Cone), Some(Crown::Palm)].get(i % 7 - 4).copied().flatten(), [cx, cy], 0.2 + r.f() * 8.0, h)
        };
        objs.push(o);
    }
    let mut pts = Vec::new();
    for k in 0..400 {
        // half the points on an object, at its top give or take a few metres
        let (x, y, z) = if k % 2 == 0 {
            let o = &objs[(r.f() * objs.len() as f64) as usize % objs.len()];
            let q = o.pts[0];
            let (cx, cy) = o.pts.iter().fold((0.0, 0.0), |s, p| (s.0 + p[0] / o.pts.len() as f64, s.1 + p[1] / o.pts.len() as f64));
            let w = r.f();
            (cx + w * (q[0] - cx), cy + w * (q[1] - cy), o.height + r.f() * 15.0 - 3.0)
        } else {
            (r.f() * 400.0 - 200.0, r.f() * 400.0 - 200.0, r.f() * 5.0)
        };
        pts.push(ShadePoint { x, y, z, table: -1 });
    }
    let trans: Vec<Vec<f64>> = (0..objs.len()).map(|i| if i % 3 == 0 { vec![0.3; 12] } else { vec![] }).collect();
    for t in [&[][..], &trans[..]] {
        let n = NearShading::with_options(pts.clone(), &objs, &[], t, None);
        for k in 0..pts.len() {
            assert!(n.horizon(k).iter().all(|&e| (0.0..=90.0).contains(&e)), "point {k}: {:?}", &n.horizon(k)[..8]);
        }
        assert!(n.sky().sky.iter().all(|x| x.is_finite()), "sky");
    }
    // and a few on their own, exactly on a corner, a ridge end or a crown's rim
    for o in objs.iter().take(200) {
        for q in o.pts.iter().take(3) {
            for z in [0.0, o.height, o.height + 1.0] {
                let h = near_horizon(q[0], q[1], z, &objs[..200]);
                assert!(h.iter().all(|&e| (0.0..=90.0).contains(&e)) && h.len() == NEAR_BINS, "on a corner");
            }
        }
    }
}

/// The roof height of the geometry contract, written out on its own: None off the footprint
fn roof_at(o: &Obstacle, x: f64, y: f64) -> Option<f64> {
    let p = &o.pts;
    let mut is_in = false;
    let mut j = p.len() - 1;
    for i in 0..p.len() {
        if (p[i][1] > y) != (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0] { is_in = !is_in; }
        j = i;
    }
    if !is_in { return None; }
    let Shape::Roof { kind, pitch, ridge_az } = o.shape else { return Some(o.height) };
    let (az, k) = (ridge_az * D2R, (pitch * D2R).tan());
    let u = |q: [f64; 2]| q[0] * az.sin() + q[1] * az.cos();
    let v = |q: [f64; 2]| q[0] * az.cos() - q[1] * az.sin();
    let span = |f: &dyn Fn([f64; 2]) -> f64| p.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(f(*q)), hi.max(f(*q))));
    let ((u0, u1), (v0, v1)) = (span(&u), span(&v));
    let (uc, vc, a, b) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0, (u1 - u0) / 2.0, (v1 - v0) / 2.0);
    let (pu, pv) = (u([x, y]), v([x, y]));
    let l = match kind {
        Roof::Gable => (b - (pv - vc)).min(b + (pv - vc)),
        Roof::Hip => (b - (pv - vc)).min(b + (pv - vc)).min(a - (pu - uc)).min(a + (pu - uc)),
        Roof::Shed => u1 - pu,
    };
    Some(o.height + k * l)
}

#[test]
fn roofs_match_a_brute_force_scan() {
    // Random roofs on random outlines and points around and on them: each bin as the steepest of rays every 0.05 deg across it,
    // each sampled every 2 cm
    let mut r = Rng(777);
    for case in 0..16 {
        let n = 3 + (r.f() * 6.0) as usize;
        let pts: Vec<PlanPoint> = (0..n).map(|k| { let a = k as f64 * 2.0 * std::f64::consts::PI / n as f64; let rr = 6.0 + 6.0 * r.f(); [rr * a.sin(), rr * a.cos()] }).collect();
        let kind = [Roof::Gable, Roof::Hip, Roof::Shed][case % 3];
        let o = Obstacle { pts, height: 3.0 + 3.0 * r.f(), shape: Shape::Roof { kind, pitch: 10.0 + 40.0 * r.f(), ridge_az: r.f() * 360.0 } };
        let (x, y, z) = if case % 4 == 3 {
            let (x, y) = (r.f() * 4.0 - 2.0, r.f() * 4.0 - 2.0);
            (x, y, roof_at(&o, x, y).unwrap() + 0.3)
        } else {
            let a = r.f() * 360.0 * D2R;
            (20.0 * a.sin(), 20.0 * a.cos(), r.f() * 3.0)
        };
        let h = near_horizon(x, y, z, std::slice::from_ref(&o));
        for j in (0..NEAR_BINS).step_by(9) {
            let mut best = 0.0f64;
            for i in 0..40 {
                let az = (2.0 * j as f64 - 1.0 + 0.05 * f64::from(i)) * D2R;
                for s in 1..2000 {
                    let t = 0.02 * f64::from(s);
                    if let Some(hh) = roof_at(&o, x + t * az.sin(), y + t * az.cos()) { best = best.max(((hh - z) / t).atan() * R2D); }
                }
            }
            let e = f64::from(h[j]);
            assert!(e <= best + 0.3 && e >= best - 1.0, "case {case} {kind:?} bin {j}: {e} vs scan {best}");
        }
    }
}
