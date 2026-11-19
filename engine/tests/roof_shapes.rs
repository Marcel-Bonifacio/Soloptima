//! The roof shapes past gable, hip and shed in the near shading: parapet, mansard, gambrel, pyramid, butterfly, sawtooth,
//! barrel vault, cone and dome. Each is checked against the elevation worked out by hand at a point next to it, against a
//! brute-force scan of its height, and through the layout fields and their checks.
use soloptima_engine::layout::parse_layout;
use soloptima_engine::shading::{cap_profile, ellipse_fit, near_bin, near_horizon, object_height, NearShading, ShadePoint};
use soloptima_engine::*;

const D2R: f64 = std::f64::consts::PI / 180.0;
const R2D: f64 = 180.0 / std::f64::consts::PI;

fn square() -> Vec<PlanPoint> { vec![[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]] }
/// 20 m along x, 10 m along y, centred on the origin
fn oblong() -> Vec<PlanPoint> { vec![[-10.0, -5.0], [10.0, -5.0], [10.0, 5.0], [-10.0, 5.0]] }
fn round(r: f64, n: usize) -> Vec<PlanPoint> { (0..n).map(|k| { let a = k as f64 * 2.0 * std::f64::consts::PI / n as f64; [r * a.sin(), r * a.cos()] }).collect() }
#[allow(clippy::too_many_arguments)]
fn shaped(pts: Vec<PlanPoint>, h: f64, kind: Shaped, pitch: f64, pitch2: f64, rise: f64, width: f64, az: f64) -> Obstacle {
    Obstacle { pts, height: h, shape: Shape::Shaped { kind, pitch, pitch2, rise, width, az } }
}
fn at(x: f64, y: f64, z: f64, o: &Obstacle, az: f64) -> f64 { f64::from(near_horizon(x, y, z, std::slice::from_ref(o))[near_bin(az)]) }
fn deg(x: f64) -> f64 { x.atan() * R2D }
fn close(a: f64, b: f64, tol: f64, what: &str) { assert!((a - b).abs() <= tol, "{what}: {a} vs {b}"); }

#[test]
fn parapet_shades_its_own_roof() {
    // a 20 m square roof 6 m up with a 1 m parapet
    let o = shaped(square(), 6.0, Shaped::Parapet, 0.0, 0.0, 1.0, 0.0, 0.0);
    // a module 0.5 m over the middle of the roof: the parapet 10 m north, 0.5 m above it
    close(at(0.0, 0.0, 6.5, &o, 0.0), deg(0.5 / 10.0), 1e-4, "middle of the roof");
    // 1 m in from the north parapet: 0.5 m up, 1 m off
    close(at(0.0, 9.0, 6.5, &o, 0.0), deg(0.5), 1e-4, "next to the parapet");
    // above the parapet: nothing; below the roof: under it
    assert!(near_horizon(0.0, 0.0, 7.1, std::slice::from_ref(&o)).iter().all(|&e| e == 0.0), "above the parapet");
    assert!(near_horizon(0.0, 0.0, 5.9, std::slice::from_ref(&o)).iter().all(|&e| e == 90.0), "under the roof");
    // from the ground 5 m off the north wall the parapet's top, 7 m up
    close(at(0.0, 15.0, 0.0, &o, 180.0), deg(7.0 / 5.0), 1e-4, "from outside");
    // the same roof without a parapet leaves a module on it unshaded
    let flat = Obstacle { pts: square(), height: 6.0, ..Default::default() };
    assert!(near_horizon(0.0, 9.0, 6.5, std::slice::from_ref(&flat)).iter().all(|&e| e == 0.0));
    assert_eq!(object_height(&o, 0.0, 0.0), Some(6.0), "the roof is at the walls' height");
}

#[test]
fn mansard_and_gambrel() {
    // 20 m square, eaves 4 m: 60 deg up to 3 m over the eaves (1.732 m in), then 20 deg
    let (k1, k2) = ((60.0 * D2R).tan(), (20.0 * D2R).tan());
    let brk = 3.0 / k1;
    let top = 7.0 + k2 * (10.0 - brk);
    let mansard = shaped(square(), 4.0, Shaped::Mansard, 60.0, 20.0, 3.0, 0.0, 0.0);
    close(object_height(&mansard, 0.0, 0.0).unwrap(), top, 1e-9, "mansard top");
    close(object_height(&mansard, 0.0, -10.0 + brk).unwrap(), 7.0, 1e-9, "at the break");
    // from 10 m south of the wall on the ground: the break, 7 m up and 10 + 1.732 m off, is the steepest
    close(at(0.0, -20.0, 0.0, &mansard, 0.0), deg(7.0 / (10.0 + brk)), 1e-4, "mansard from the side");
    close(at(-20.0, 0.0, 0.0, &mansard, 90.0), deg(7.0 / (10.0 + brk)), 1e-4, "mansard from the end");
    // a gambrel along x: the same from the side, but its end wall stands up to the ridge
    let gambrel = shaped(square(), 4.0, Shaped::Gambrel, 60.0, 20.0, 3.0, 0.0, 90.0);
    close(at(0.0, -20.0, 0.0, &gambrel, 0.0), deg(7.0 / (10.0 + brk)), 1e-4, "gambrel from the side");
    close(at(-20.0, 0.0, 0.0, &gambrel, 90.0), deg(top / 10.0), 1e-4, "gambrel end wall");
}

#[test]
fn pyramid_and_hip() {
    // 20 x 10 m, eaves 4 m, 30 deg on the long sides: a pyramid meets at the centre, a hip has a ridge 10 m long
    let k = (30.0 * D2R).tan();
    let pyr = shaped(oblong(), 4.0, Shaped::Pyramid, 30.0, 0.0, 0.0, 0.0, 90.0);
    close(object_height(&pyr, 0.0, 0.0).unwrap(), 4.0 + 5.0 * k, 1e-9, "apex");
    close(object_height(&pyr, 5.0, 0.0).unwrap(), 4.0 + 2.5 * k, 1e-9, "the end plane at half the pitch");
    close(at(0.0, -20.0, 0.0, &pyr, 0.0), deg((4.0 + 5.0 * k) / 20.0), 1e-4, "pyramid from the side: the apex");
    close(at(-20.0, 0.0, 0.0, &pyr, 90.0), deg(4.0 / 10.0), 1e-4, "pyramid from the end: the eave");
    let hip = Obstacle { pts: oblong(), height: 4.0, shape: Shape::Roof { kind: Roof::Hip, pitch: 30.0, ridge_az: 90.0 } };
    close(at(-20.0, 0.0, 0.0, &hip, 90.0), deg((4.0 + 5.0 * k) / 15.0), 1e-4, "hip from the end: the ridge end");
    // on a square the pyramid is the hip
    let sq = |kind| shaped(square(), 4.0, kind, 30.0, 0.0, 0.0, 0.0, 90.0);
    let hsq = Obstacle { pts: square(), height: 4.0, shape: Shape::Roof { kind: Roof::Hip, pitch: 30.0, ridge_az: 90.0 } };
    for i in 0..21 { for j in 0..21 { let (x, y) = (f64::from(i) - 10.0, f64::from(j) - 10.0); assert_eq!(object_height(&sq(Shaped::Pyramid), x, y), object_height(&hsq, x, y)); } }
    // the same horizon, the pyramid's looked at on the ends of each bin too
    let (p, h) = (near_horizon(-3.0, -25.0, 1.0, &[sq(Shaped::Pyramid)]), near_horizon(-3.0, -25.0, 1.0, &[hsq]));
    assert!(p.iter().zip(&h).all(|(a, b)| a >= b && *a <= b + 0.5), "pyramid on a square as a hip");
}

#[test]
fn butterfly_and_sawtooth() {
    // butterfly: valley along x at the eaves (4 m), planes rising 20 deg to the long edges 10 m off it
    let k = (20.0 * D2R).tan();
    let bf = shaped(square(), 4.0, Shaped::Butterfly, 20.0, 0.0, 0.0, 0.0, 90.0);
    close(object_height(&bf, 3.0, 0.0).unwrap(), 4.0, 1e-9, "valley");
    close(at(0.0, -20.0, 0.0, &bf, 0.0), deg((4.0 + 10.0 * k) / 10.0), 1e-4, "butterfly: the near edge");
    // sawtooth: teeth 5 m wide rising 30 deg to the north (planes falling south), each with a vertical face at its north end
    let k = (30.0 * D2R).tan();
    let st = shaped(square(), 4.0, Shaped::Sawtooth, 30.0, 0.0, 0.0, 5.0, 180.0);
    close(object_height(&st, 0.0, -7.5).unwrap(), 4.0 + 2.5 * k, 1e-9, "half way up the first tooth");
    // from the south the first vertical face, 4 + 5 tan 30 up and 15 m off, is steeper than the eave 10 m off
    close(at(0.0, -20.0, 0.0, &st, 0.0), deg((4.0 + 5.0 * k) / 15.0), 1e-4, "sawtooth from the south");
    // from the north the last tooth's top stands on the wall
    close(at(0.0, 20.0, 0.0, &st, 180.0), deg((4.0 + 5.0 * k) / 10.0), 1e-4, "sawtooth from the north");
    // a module 0.3 m over the middle of a tooth sees the next face north of it: 2.5 m off, 2.5 tan 30 - 0.3 up
    close(at(0.0, -2.5, 4.0 + 2.5 * k + 0.3, &st, 0.0), deg((2.5 * k - 0.3) / 2.5), 1e-4, "on a tooth");
}

#[test]
fn barrel_vault() {
    // 20 x 10 m, eaves 4 m, a half cylinder along x rising 5 m (its radius)
    let bv = shaped(oblong(), 4.0, Shaped::Barrel, 0.0, 0.0, 5.0, 0.0, 90.0);
    close(object_height(&bv, 0.0, 3.0).unwrap(), 4.0 + 4.0, 1e-9, "on the circle");
    // from the eave height 20 m south of its axis: the tangent to the circle, asin(5 / 20)
    close(at(0.0, -20.0, 4.0, &bv, 0.0), (5.0f64 / 20.0).asin() * R2D, 1e-3, "tangent to the vault");
    // from the ground 10 m off its end: the end wall up to the crown
    close(at(-20.0, 0.0, 0.0, &bv, 90.0), deg(9.0 / 10.0), 1e-4, "end wall");
    // its default rise: half the half span
    let auto = shaped(oblong(), 4.0, Shaped::Barrel, 0.0, 0.0, f64::NAN, 0.0, 90.0);
    close(object_height(&auto, 0.0, 0.0).unwrap(), 6.5, 1e-9, "default rise 2.5 m");
}

#[test]
fn cone_and_dome() {
    let n = 720;
    let ri = 10.0 * (std::f64::consts::PI / n as f64).cos();   // the circle the 720-gon holds
    // a cone 10 m over walls 4 m high: from 30 m off its axis at the eaves' height its tip, 10 m up
    let cone = shaped(round(10.0, n), 4.0, Shaped::Cone, 0.0, 0.0, 10.0, 0.0, 0.0);
    close(at(0.0, -30.0, 4.0, &cone, 0.0), deg(10.0 / 30.0), 1e-3, "cone tip");
    close(object_height(&cone, 0.0, ri / 2.0).unwrap(), 9.0, 1e-6, "half way out");
    // a hemisphere of radius 10 on walls 5 m high: from 20 m off its centre at the walls' height, asin(10 / 20) = 30 deg
    let dome = shaped(round(10.0, n), 5.0, Shaped::Dome, 0.0, 0.0, 10.0, 0.0, 0.0);
    close(at(0.0, -20.0, 5.0, &dome, 0.0), 30.0, 2e-3, "hemisphere at the walls' height");
    // from the ground: the tangent from (0, 0) to the circle round (20, 5)
    let from_ground = (5.0f64 / 20.0).atan() + (10.0 / 425.0f64.sqrt()).asin();
    close(at(0.0, -20.0, 0.0, &dome, 0.0), from_ground * R2D, 2e-3, "hemisphere from the ground");
    // a point inside it is under it; on its top, nothing
    assert!(near_horizon(0.0, 0.0, 14.0, std::slice::from_ref(&dome)).iter().all(|&e| e == 90.0));
    assert!(near_horizon(0.0, 0.0, 15.1, std::slice::from_ref(&dome)).iter().all(|&e| e == 0.0));
    // a default dome on a round building rises half its radius
    let auto = shaped(round(10.0, n), 5.0, Shaped::Dome, 0.0, 0.0, f64::NAN, 0.0, 0.0);
    close(object_height(&auto, 0.0, 0.0).unwrap(), 5.0 + ri / 2.0, 1e-6, "default dome");
    // on a 20 x 10 m footprint the ellipse fills it (half axes 10 and 5) and the default dome rises 2.5 m, a spherical cap
    // across the short side: 1.97822 m up half way along the long axis (the same point as in ui/tests/layout.test.js)
    let (c, u, a, b) = ellipse_fit(&oblong()).unwrap();
    assert!(c[0].abs() < 1e-9 && c[1].abs() < 1e-9 && (a - 10.0).abs() < 1e-9 && (b - 5.0).abs() < 1e-9 && u[0].abs() > 0.999999);
    let oval = shaped(oblong(), 4.0, Shaped::Dome, 0.0, 0.0, f64::NAN, 0.0, 0.0);
    close(object_height(&oval, 5.0, 0.0).unwrap(), 4.0 + 2.5 * cap_profile(0.5, 0.5), 1e-12, "cap");
    close(object_height(&oval, 5.0, 0.0).unwrap(), 5.978_22, 1e-5, "by hand");
    close(object_height(&oval, 9.9, 4.9).unwrap(), 4.0, 1e-12, "a corner outside the ellipse stays at the walls' height");
    // an outline whose centroid lies outside it (a C) has no dome: a flat top
    let c_shape = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 2.0], [2.0, 2.0], [2.0, 8.0], [10.0, 8.0], [10.0, 10.0], [0.0, 10.0]];
    assert!(ellipse_fit(&c_shape).is_none());
}

#[test]
fn shapes_match_a_brute_force_scan() {
    // Random shapes on random outlines and points around and on them: each bin as the steepest of rays every 0.05 deg across
    // it, each sampled every 2 cm
    let mut seed = 99u64;
    let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 11) as f64 / (1u64 << 53) as f64 };
    let kinds = [Shaped::Mansard, Shaped::Gambrel, Shaped::Pyramid, Shaped::Butterfly, Shaped::Sawtooth, Shaped::Barrel, Shaped::Cone, Shaped::Dome];
    for case in 0..24 {
        let n = 3 + (rnd() * 6.0) as usize;
        let pts: Vec<PlanPoint> = (0..n).map(|k| { let a = k as f64 * 2.0 * std::f64::consts::PI / n as f64; let rr = 6.0 + 6.0 * rnd(); [rr * a.sin(), rr * a.cos()] }).collect();
        let kind = kinds[case % kinds.len()];
        let pitch = 15.0 + 50.0 * rnd();
        let o = shaped(pts, 3.0 + 3.0 * rnd(), kind, pitch, pitch * rnd().max(0.2), 1.0 + 3.0 * rnd(), 2.0 + 3.0 * rnd(), rnd() * 360.0);
        let (x, y, z) = if case % 4 == 3 {
            let (x, y) = (rnd() * 4.0 - 2.0, rnd() * 4.0 - 2.0);
            (x, y, object_height(&o, x, y).unwrap() + 0.3)
        } else {
            let a = rnd() * 360.0 * D2R;
            (20.0 * a.sin(), 20.0 * a.cos(), rnd() * 3.0)
        };
        let h = near_horizon(x, y, z, std::slice::from_ref(&o));
        for j in (0..180).step_by(9) {
            let mut best = 0.0f64;
            for i in 0..40 {
                let az = (2.0 * j as f64 - 1.0 + 0.05 * f64::from(i)) * D2R;
                for s in 1..2000 {
                    let t = 0.02 * f64::from(s);
                    if let Some(hh) = object_height(&o, x + t * az.sin(), y + t * az.cos()) { best = best.max(((hh - z) / t).atan() * R2D); }
                }
            }
            let e = f64::from(h[j]);
            assert!(e <= best + 0.3 && e >= best - 1.0, "case {case} {kind:?} bin {j}: {e} vs scan {best}");
        }
    }
}

#[test]
fn random_shapes_never_break() {
    let mut seed = 4242u64;
    let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 11) as f64 / (1u64 << 53) as f64 };
    let kinds = [Shaped::Parapet, Shaped::Mansard, Shaped::Gambrel, Shaped::Pyramid, Shaped::Butterfly, Shaped::Sawtooth, Shaped::Barrel, Shaped::Cone, Shaped::Dome];
    let mut objs = Vec::new();
    for i in 0..900 {
        let (cx, cy) = (rnd() * 300.0 - 150.0, rnd() * 300.0 - 150.0);
        let n = 3 + (rnd() * 9.0) as usize;
        let size = 1.0 + rnd() * 30.0;
        let pts = (0..n).map(|k| { let a = k as f64 * 2.0 * std::f64::consts::PI / n as f64; let rr = size * (0.3 + 0.7 * rnd()); [cx + rr * a.sin(), cy + rr * a.cos()] }).collect();
        let pitch = 1.0 + rnd() * 74.0;
        objs.push(shaped(pts, 0.5 + rnd() * 30.0, kinds[i % kinds.len()], pitch, pitch * rnd().max(0.02), if i % 5 == 0 { f64::NAN } else { 0.1 + rnd() * 10.0 }, 1.0 + rnd() * 10.0, rnd() * 360.0));
    }
    let mut pts = Vec::new();
    for k in 0..300 {
        let (x, y, z) = if k % 2 == 0 {
            let o = &objs[(rnd() * objs.len() as f64) as usize % objs.len()];
            (o.pts[0][0] * 0.7 + o.pts[1][0] * 0.3, o.pts[0][1] * 0.7 + o.pts[1][1] * 0.3, o.height + rnd() * 12.0 - 2.0)
        } else {
            (rnd() * 300.0 - 150.0, rnd() * 300.0 - 150.0, rnd() * 5.0)
        };
        pts.push(ShadePoint { x, y, z, table: -1 });
    }
    let ns = NearShading::with_options(pts.clone(), &objs, &[], &[], None);
    for k in 0..pts.len() { assert!(ns.horizon(k).iter().all(|&e| (0.0..=90.0).contains(&e)), "point {k}"); }
    for o in objs.iter().take(100) {
        for q in o.pts.iter().take(2) {
            for z in [0.0, o.height, o.height + 1.0] {
                assert!(near_horizon(q[0], q[1], z, &objs[..100]).iter().all(|&e| (0.0..=90.0).contains(&e)), "on a corner");
            }
        }
    }
}

#[test]
fn shape_fields() {
    let loc = Location { lat: -8.0, lon: 115.0, ..Default::default() };
    let kx = 111320.0 * (loc.lat * D2R).cos();
    let ring = || {
        let mut a = Value::array();
        for q in square() { let mut p = Value::array(); p.push(q[1] / 110574.0 + loc.lat); p.push(q[0] / kx + loc.lon); a.push(p); }
        a
    };
    let text = r#"{"polygons": [
        {"type": "obstacle", "kind": "building", "height": 6, "roof": "parapet"},
        {"type": "obstacle", "kind": "building", "height": 6, "roof": "parapet", "rise": 40},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "mansard", "pitch": 50, "pitch2": 70, "rise": 2, "ridge_az": 370},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "gambrel"},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "pyramid", "pitch": 30, "ridge_az": 45},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "butterfly", "rise": 3},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "sawtooth", "width": 0.2},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "barrel", "rise": 3},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "cone"},
        {"type": "obstacle", "kind": "building", "height": 4, "roof": "dome", "rise": "x"},
        {"type": "obstacle", "kind": "tree", "height": 4, "roof": "dome", "diameter": 4}]}"#;
    let mut v = Value::parse(text).unwrap();
    if let Value::Obj(o) = &mut v {
        if let Some(Value::Arr(items)) = o.get_mut("polygons") {
            for g in items.iter_mut() {
                if g.gets("kind", "") == "tree" { let mut c = Value::array(); c.push(loc.lat); c.push(loc.lon); g.set("center", c); } else { g.set("latlngs", ring()); }
            }
        }
    }
    let ly = parse_layout(&v, &loc);
    let s: Vec<Shape> = ly.obstacles.iter().map(|o| o.shape).collect();
    let sh = |kind, pitch, pitch2, rise, width, az| Shape::Shaped { kind, pitch, pitch2, rise, width, az };
    assert_eq!(s[0], sh(Shaped::Parapet, 0.0, 0.0, 1.0, 0.0, 0.0), "a 1 m parapet by default");
    assert_eq!(s[1], sh(Shaped::Parapet, 0.0, 0.0, 10.0, 0.0, 0.0), "at most 10 m");
    assert_eq!(s[2], sh(Shaped::Mansard, 50.0, 50.0, 2.0, 0.0, 10.0), "the upper pitch at most the lower; the azimuth within a turn");
    assert_eq!(s[3], sh(Shaped::Gambrel, 60.0, 25.0, 2.5, 0.0, 0.0));
    assert_eq!(s[4], sh(Shaped::Pyramid, 30.0, 0.0, 0.0, 0.0, 45.0));
    assert_eq!(s[5], sh(Shaped::Butterfly, 10.0, 0.0, 0.0, 0.0, 0.0), "a field it does not use is 0");
    assert_eq!(s[6], sh(Shaped::Sawtooth, 25.0, 0.0, 0.0, 1.0, 0.0), "teeth at least 1 m wide");
    assert_eq!(s[7], sh(Shaped::Barrel, 0.0, 0.0, 3.0, 0.0, 0.0));
    assert!(matches!(s[8], Shape::Shaped { kind: Shaped::Cone, rise, .. } if rise.is_nan()), "a cone's height from its footprint");
    assert!(matches!(s[9], Shape::Shaped { kind: Shaped::Dome, rise, .. } if rise.is_nan()));
    assert!(!matches!(s[10], Shape::Shaped { .. }), "a tree takes no roof");
    let objects = SiteLayout { areas: vec![], ..ly.clone() };
    assert!(validate_layout(&objects).is_ok(), "valid shapes");
    let bad = |shape: Shape| { let mut l = objects.clone(); l.obstacles[0].shape = shape; validate_layout(&l).is_err() };
    assert!(bad(sh(Shaped::Parapet, 0.0, 0.0, 11.0, 0.0, 0.0)), "parapet 11 m");
    assert!(bad(sh(Shaped::Mansard, 50.0, 60.0, 2.0, 0.0, 0.0)), "upper pitch over the lower");
    assert!(bad(sh(Shaped::Sawtooth, 25.0, 0.0, 0.0, 0.5, 0.0)), "teeth 0.5 m");
    assert!(bad(sh(Shaped::Dome, 0.0, 0.0, 300.0, 0.0, 0.0)), "dome 300 m");
    assert!(bad(sh(Shaped::Butterfly, 10.0, 0.0, 0.0, 0.0, 400.0)), "azimuth 400");
    assert!(!bad(sh(Shaped::Dome, 0.0, 0.0, f64::NAN, 0.0, 0.0)), "a dome's default height");
    assert!(bad(sh(Shaped::Parapet, 0.0, 0.0, f64::NAN, 0.0, 0.0)), "a parapet needs its height");
}
