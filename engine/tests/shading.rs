//! The near-shading and layout cases of tests/test_engine.cpp (case 25) with the same assertions: the near horizon of a point,
//! the share of a set of points behind a wall, the sky left over objects and terrain, the shade on each table, east-west,
//! canopy and per-area orientations under one inverter, and bounded work on layouts built to be expensive.
use soloptima_engine::pv::*;
use soloptima_engine::shading::{array_groups, near_bin, near_horizon, NearShading, ShadePoint, NEAR_BINS};
use soloptima_engine::*;

const D2R: f64 = std::f64::consts::PI / 180.0;

/// make_project of test_engine.cpp
fn make_project(lat: f64, lon: f64) -> Project {
    let mut p = Project::default();
    p.loc.lat = lat;
    p.loc.lon = lon;
    p.loc.utc_offset = (lon / 15.0).round();
    p.wx.time_offset = 0.5;
    p.wx.ghi = clearsky_ghi(&p).unwrap();
    for i in 0..HOURS { p.wx.ghi[i] *= 0.6 + 0.35 * (((i / 24) as f64) * 1.7).sin(); }
    p.wx.tamb = vec![27.0; HOURS];
    p.wx.wind = vec![1.5; HOURS];
    p.load_kw = (0..HOURS).map(|i| 1000.0 + 200.0 * (((i % 24) as f64) / 24.0 * 6.283).sin()).collect();
    p.dg.unit_kw = 400.0;
    p.dg.units = 5;
    p.pv.capacity_kwp = 1500.0;
    p.pv.azimuth = if lat >= 0.0 { 180.0 } else { 0.0 };
    p.bess.energy_kwh = 2000.0;
    p.bess.power_kw = 1000.0;
    p.econ.lifetime = 20;
    p
}
fn prof(p: &Project) -> PVProfile { compute_pv_profile(p).unwrap() }
fn yield_of(p: &Project) -> f64 { prof(p).specific_yield }
fn area(pts: &[PlanPoint]) -> LayoutArea { LayoutArea { pts: pts.to_vec(), ..Default::default() } }
fn pt(x: f64, y: f64) -> ShadePoint { ShadePoint { x, y, z: 0.0, table: -1 } }
fn wall() -> Obstacle { Obstacle { height: 10.0, pts: vec![[-10.0, -10.0], [10.0, -10.0], [10.0, -11.0], [-10.0, -11.0]] } }

#[test]
fn near_horizon_of_a_wall_and_share_behind_it() {
    // A 10 m high wall 20 m long, 10 m south of a point on the ground: 45 deg due south, lower off the axis (the 200 deg
    // azimuth takes the highest edge within 199-201 deg), nothing beyond its ends; a point inside the footprint sees 90 deg
    // all round, a point above the wall nothing.
    let w = vec![wall()];
    let hw = near_horizon(0.0, 0.0, 0.0, &w);
    assert!((f64::from(hw[near_bin(180.0)]) - 45.0).abs() < 1e-4 && (f64::from(hw[near_bin(200.0)]) - (19.0 * D2R).cos().atan() / D2R).abs() < 1e-4
            && hw[near_bin(240.0)] == 0.0 && hw[near_bin(0.0)] == 0.0, "near horizon of a wall");
    assert!(near_horizon(0.0, -10.5, 0.0, &w)[near_bin(0.0)] == 90.0 && near_horizon(0.0, 0.0, 11.0, &w)[near_bin(180.0)] == 0.0, "under and above the wall");
    // One point 10 m and one 110 m north of the wall (5.2 deg): the sun at 30 deg in the south is hidden from one of them
    let two = NearShading::new(vec![pt(0.0, 0.0), pt(0.0, 100.0)], &w, &[]);
    assert!(two.shaded(180.0, 30.0) == 0.5 && two.shaded(180.0, 3.0) == 1.0 && two.shaded(180.0, 50.0) == 0.0 && two.shaded(0.0, 10.0) == 0.0, "share behind the wall");
    // Sky view: with no object in view it is the terrain's; the wall takes part of it
    let ten = [10.0; 36];
    let open = NearShading::new(vec![pt(0.0, 5000.0)], &w, &ten);
    let walled = NearShading::new(vec![pt(0.0, 0.0)], &w, &ten);
    assert!(sky_view(open.sky(), 20.0, 180.0) == horizon_view(&ten, 20.0, 180.0)
            && sky_view(walled.sky(), 20.0, 180.0)[0] < horizon_view(&ten, 20.0, 180.0)[0] - 0.02, "sky view over the wall");
}

/// Four tables 20 m x 4 m in two columns facing north (corners: upper edge first)
fn four_tables() -> Project {
    let mut a = make_project(-2.5, 115.5);
    a.pv.dc_ac_ratio = 1.0;
    a.layout.areas.push(area(&[[-30.0, -30.0], [30.0, -30.0], [30.0, 30.0], [-30.0, 30.0]]));
    for y in [-20.0, 10.0] {
        for x in [-30.0, 10.0] { a.layout.tables.push([[x, y], [x + 20.0, y], [x + 20.0, y + 4.0], [x, y + 4.0]]); }
    }
    a
}
fn with_tower(a: &Project) -> Project {
    let mut ob = a.clone();
    ob.layout.obstacles = vec![Obstacle { height: 20.0, pts: vec![[40.0, -30.0], [60.0, -30.0], [60.0, 30.0], [40.0, 30.0]] }];
    ob
}
fn yield_az(az: f64, tilt: f64, ratio: f64) -> f64 {
    let mut b = make_project(-2.5, 115.5);
    b.pv.azimuth = az;
    b.pv.tilt = tilt;
    b.pv.dc_ac_ratio = ratio;
    yield_of(&b)
}

#[test]
fn objects_shade_the_tables() {
    let a = four_tables();
    let open_pv = prof(&a);
    let mut plain = make_project(-2.5, 115.5);
    plain.pv.dc_ac_ratio = 1.0;
    assert_eq!(open_pv.specific_yield, yield_of(&plain), "a layout without objects or own orientations changes nothing");
    // a 20 m building 10 m east of the area
    let ob = with_tower(&a);
    let sh = compute_pv_profile_groups(&ob, &array_groups(&ob).unwrap(), true).unwrap();
    let (near_step, hor_ref) = (sh.step("After shading by nearby objects").unwrap_or(0.0), sh.step("Global incident in collector plane").unwrap_or(0.0));
    assert!(sh.specific_yield < open_pv.specific_yield && near_step > 0.0 && near_step < hor_ref, "near shading loss");
    let ts = &sh.table_shade;
    assert!(ts.len() == 4 && ts[1] > ts[0] && ts[3] > ts[2] && ts[0] > 0.0, "shade per table {ts:?}");
    assert!(sh.near_max.len() == NEAR_BINS && sh.near_max[near_bin(90.0)] > 20.0 && sh.near_max[near_bin(270.0)] == 0.0, "near horizon envelope");
    let mut off = ob.clone();
    off.pv.near_shading = false;
    let mut low = ob.clone();
    low.layout.obstacles[0].height = 1.0;   // below the tables
    assert!(yield_of(&off) == open_pv.specific_yield && (yield_of(&low) / open_pv.specific_yield - 1.0).abs() < 1e-9, "objects switched off or out of the way");
}

#[test]
fn areas_with_their_own_orientation() {
    // The project's own values change nothing; east-west tables without clipping give the mean of the two orientations, with
    // clipping at least that (the inverter clips their sum); without tables the areas' plan areas set the shares.
    let a = four_tables();
    let open = yield_of(&a);
    let mut same = a.clone();
    same.layout.areas[0].tilt = a.pv.tilt;
    same.layout.areas[0].azimuth = a.pv.azimuth;
    assert_eq!(yield_of(&same), open, "own orientation equal to the project's");
    let mut ew = a.clone();
    ew.layout.areas[0].azimuth = 90.0;
    ew.layout.areas[0].east_west = true;
    let (y_ew, y_mean) = (yield_of(&ew), (yield_az(90.0, 10.0, 1.0) + yield_az(270.0, 10.0, 1.0)) / 2.0);
    ew.pv.dc_ac_ratio = 1.6;
    let (y_ew_clip, y_mean_clip) = (yield_of(&ew), (yield_az(90.0, 10.0, 1.6) + yield_az(270.0, 10.0, 1.6)) / 2.0);
    assert!((y_ew / y_mean - 1.0).abs() < 1e-9 && y_ew_clip >= y_mean_clip - 1e-9, "east-west {y_ew} vs {y_mean}, clipped {y_ew_clip} vs {y_mean_clip}");

    // A canopy area is one plane of tables: no row shading and no rear side. Where rows shade each other it yields more than
    // the same area as ground rows, bifacial modules add nothing on it, and it has a group of its own.
    let mut dense = a.clone();
    dense.pv.gcr = 0.5;
    dense.pv.tilt = 30.0;
    dense.pv.row_shading = true;
    dense.pv.transposition = "perez".into();
    dense.pv.diffuse_shading = true;
    dense.pv.mount_height = 1.5;
    let mut canopy = dense.clone();
    canopy.layout.areas[0].canopy = true;
    let (mut canopy_bif, mut rows_bif) = (canopy.clone(), dense.clone());
    canopy_bif.pv.bifaciality = 0.7;
    rows_bif.pv.bifaciality = 0.7;
    let (y_rows, y_canopy) = (yield_of(&dense), yield_of(&canopy));
    assert!(y_canopy > y_rows * 1.01 && yield_of(&canopy_bif) == y_canopy && yield_of(&rows_bif) > y_rows, "canopy {y_canopy} vs ground rows {y_rows}");
    let (mut own_rows, mut own_canopy) = (dense.clone(), dense.clone());
    own_rows.layout.areas[0].tilt = dense.pv.tilt;
    own_canopy.layout.areas[0].tilt = dense.pv.tilt;
    own_canopy.layout.areas[0].canopy = true;
    let c1 = array_groups(&own_rows).unwrap()[0].canopy;
    let c2 = array_groups(&own_canopy).unwrap()[0].canopy;
    let c3 = array_groups(&own_rows).unwrap()[0].canopy;
    assert!(!c1 && c2 && !c3 && (yield_of(&own_canopy) / y_canopy - 1.0).abs() < 1e-12 && yield_of(&own_rows) == y_rows, "canopy group flags");
    let mut mixed = dense.clone();
    mixed.layout.areas = vec![area(&[[-30.0, -30.0], [30.0, -30.0], [30.0, 0.0], [-30.0, 0.0]]), area(&[[-30.0, 0.0], [30.0, 0.0], [30.0, 30.0], [-30.0, 30.0]])];
    mixed.layout.areas[1].canopy = true;
    mixed.layout.tables.clear();
    let y_mixed = yield_of(&mixed);
    assert!(array_groups(&mixed).unwrap().len() == 2 && y_mixed > y_rows && y_mixed < y_canopy, "half canopy, half rows");
    let fc = project_from_text(r#"{"location":{"lat":-8.5,"lon":115.2},"layout":{"polygons":[
        {"type":"site","latlngs":[[-8.5,115.2],[-8.5,115.201],[-8.499,115.201],[-8.499,115.2]],"canopy":true}]}}"#).unwrap();
    assert!(fc.layout.areas.len() == 1 && fc.layout.areas[0].canopy && layout_used(&fc), "canopy flag of a project file");

    let mut two_areas = make_project(-2.5, 115.5);
    two_areas.pv.dc_ac_ratio = 1.0;
    two_areas.layout.areas = vec![area(&[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]), area(&[[20.0, 0.0], [50.0, 0.0], [50.0, 10.0], [20.0, 10.0]])];
    two_areas.layout.areas[0].tilt = 30.0;
    let (y_two, y_mix) = (yield_of(&two_areas), 0.25 * yield_az(0.0, 30.0, 1.0) + 0.75 * yield_az(0.0, 10.0, 1.0));
    assert!((y_two / y_mix - 1.0).abs() < 1e-9, "areas weighted by plan area {y_two} vs {y_mix}");

    // Tables carry the area the layout map filled them into: a roof area inside a ground area keeps its own tilt
    let mut nested = make_project(-2.5, 115.5);
    nested.pv.dc_ac_ratio = 1.0;
    nested.layout.areas = vec![area(&[[-50.0, -50.0], [50.0, -50.0], [50.0, 50.0], [-50.0, 50.0]]), area(&[[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]])];
    nested.layout.areas[1].tilt = 30.0;
    nested.layout.tables = vec![[[-8.0, 0.0], [8.0, 0.0], [8.0, 4.0], [-8.0, 4.0]]];
    nested.layout.table_area = vec![1];
    assert!((yield_of(&nested) / yield_az(0.0, 30.0, 1.0) - 1.0).abs() < 1e-9, "table in the roof area at its tilt");
}

#[test]
fn bounded_work_and_layout_checks() {
    let ob = with_tower(&four_tables());
    // tables without width get one point each, a sliver of an area a bounded grid; too many object corners is refused
    let mut thin = ob.clone();
    thin.layout.tables = vec![[[-20000.0, 0.0], [20000.0, 0.0], [20000.0, 0.0], [-20000.0, 0.0]]; 2000];
    thin.layout.table_area.clear();
    let thin_pts: usize = array_groups(&thin).unwrap().iter().map(|g| g.near.as_ref().map_or(0, |n| n.points().len())).sum();
    let mut sliver = ob.clone();
    sliver.layout.tables.clear();
    sliver.layout.areas[0].pts = vec![[-40000.0, -40000.0], [40000.0, 40000.0], [40000.0, 40000.5]];
    let sg = array_groups(&sliver).unwrap();
    let mut heavy = ob.clone();
    heavy.layout.obstacles = (0..4000)
        .map(|k| Obstacle {
            height: 10.0,
            pts: (0..24).map(|c| [100.0 + (k % 60) as f64 * 30.0 + (f64::from(c) * 0.2618).cos(), 100.0 + (k / 60) as f64 * 30.0 + (f64::from(c) * 0.2618).sin()]).collect(),
        })
        .collect();
    heavy.layout.tables = vec![ob.layout.tables[0]; 30000];
    let refused = array_groups(&heavy).is_err();
    let sliver_pts = sg.first().and_then(|g| g.near.as_ref()).map_or(0, |n| n.points().len());
    assert!(thin_pts <= 22000 && !sg.is_empty() && sliver_pts > 0 && sliver_pts <= 21000 && refused,
            "bounded near shading: {thin_pts} points on thin tables, {sliver_pts} on a sliver, heavy layout refused {refused}");

    let bad = |set: &dyn Fn(&mut Project)| { let mut x = ob.clone(); set(&mut x); validate_project(&x).is_err() };
    assert!(bad(&|x| x.layout.obstacles[0].height = 0.0) && bad(&|x| x.layout.areas[0].tilt = 95.0) && bad(&|x| x.layout.tables[0][2] = [6e4, 0.0])
            && bad(&|x| x.layout.obstacles[0].pts.truncate(2)) && bad(&|x| x.layout.obstacles[0].pts = vec![[50.0, 0.0]; 6000])
            && bad(&|x| x.layout.table_area = vec![0, 0, 0, 7]) && !bad(&|_| {}), "layout checks: invalid accepted or valid refused");
}
