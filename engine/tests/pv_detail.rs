//! The PV and layout options added after the C++ engine: edge rows, rows on sloped ground, snowfall and humidity in the
//! weather, the electrical effect of near shading on strings, leaf transmission of trees. Off by default, where they change
//! nothing (the parity tests keep their fixtures).
use soloptima_engine::pv::*;
use soloptima_engine::shading::array_groups;
use soloptima_engine::*;

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
    p.load_kw = vec![1000.0; HOURS];
    p.pv.azimuth = if lat >= 0.0 { 180.0 } else { 0.0 };
    p.pv.dc_ac_ratio = 1.0;
    p
}
fn prof(p: &Project) -> PVProfile { compute_pv_profile(p).unwrap() }
fn yield_of(p: &Project) -> f64 { prof(p).specific_yield }

/// Dense bifacial rows with diffuse row shading, at 25 deg tilt
fn rows_project() -> Project {
    let mut p = make_project(35.0, 10.0);
    p.pv.tilt = 25.0;
    p.pv.gcr = 0.5;
    p.pv.transposition = "perez".into();
    p.pv.diffuse_shading = true;
    p.pv.bifaciality = 0.7;
    p.pv.mount_height = 1.5;
    p
}

/// A block of `rows` rows of `per_row` tables facing south at the project's pitch (plan corners, upper edge first)
fn table_block(p: &mut Project, rows: usize, per_row: usize) {
    let pitch = p.pv.row_width / p.pv.gcr;
    let depth = p.pv.row_width * (p.pv.tilt.to_radians()).cos();
    p.layout.areas.push(LayoutArea { pts: vec![[-200.0, -200.0], [200.0, -200.0], [200.0, 200.0], [-200.0, 200.0]], ..Default::default() });
    for r in 0..rows {
        let y = -(r as f64) * pitch;   // row 0 is the front (southern) row
        for k in 0..per_row {
            let x = k as f64 * 21.0;
            p.layout.tables.push([[x, y + depth], [x + 20.0, y + depth], [x + 20.0, y], [x, y]]);
        }
    }
}

#[test]
fn edge_ground_views() {
    // The open face of an edge row sees all of its share of the ground, the far ground almost the whole sky; under a clear
    // midday sky the open ground in front of a front-edge row reflects more than the ground between interior rows.
    for &(tilt, gcr, h) in &[(10.0, 0.4, 0.33), (25.0, 0.5, 0.5), (40.0, 0.7, 0.8)] {
        let (f, b) = (edge_ground(tilt, gcr, h, true), edge_ground(tilt, gcr, h, false));
        let ct = (tilt as f64).to_radians().cos();
        let sum = |g: &EdgeGround| g.view.iter().sum::<f64>() + g.far;
        assert!((sum(&f) - (1.0 - ct) / 2.0).abs() < 1e-9 && (sum(&b) - (1.0 + ct) / 2.0).abs() < 1e-9, "view totals at {tilt}");
        assert!(f.far_sky > 0.97 && b.far_sky > 0.97 && f.sky.iter().all(|&s| (0.0..=1.0 + 1e-9).contains(&s)), "far sky {} {}", f.far_sky, b.far_sky);
        let g = ground_view(tilt, gcr, h);
        let inner = g.reflected(-0.2, 800.0, 100.0);
        assert!(f.reflected(-0.2, 800.0, 100.0) > inner[0] && b.reflected(-0.2, 800.0, 100.0) > inner[1] * 1.05, "open ground reflects more at {tilt}");
    }
}

#[test]
fn edge_rows_from_the_row_count() {
    // Off, or on with many rows, nothing changes; one row alone sees the most, two rows lie between
    let base = rows_project();
    let y0 = yield_of(&base);
    let mut many = base.clone();
    many.pv.edge_rows = true;
    assert_eq!(yield_of(&many), y0, "edge rows without a row count");
    let at = |n: f64| { let mut q = many.clone(); q.pv.row_count = n; yield_of(&q) };
    let (y1, y2, y10) = (at(1.0), at(2.0), at(10.0));
    assert!(y1 > y2 && y2 > y10 && y10 > y0, "one {y1}, two {y2}, ten {y10} rows, interior {y0}");
    assert!(y1 / y0 > 1.02 && y10 / y0 < 1.01, "the edge gain: {} one row, {} ten rows", y1 / y0, y10 / y0);
    // the rear side gains most: monofacial modules gain only on the front (beam and sky of the front row)
    let mut mono = many.clone();
    mono.pv.bifaciality = 0.0;
    let ym = yield_of(&mono);
    mono.pv.row_count = 1.0;
    assert!(yield_of(&mono) > ym && yield_of(&mono) / ym < y1 / y0, "monofacial edge gain");
}

#[test]
fn edge_rows_from_the_layout_tables() {
    // Five rows of four tables: a fifth of them at each edge, as five rows by the row count
    let mut a = rows_project();
    a.pv.edge_rows = true;
    table_block(&mut a, 5, 4);
    let g = array_groups(&a).unwrap();
    assert_eq!(g.len(), 1);
    let e = g[0].edge_share(&a.pv);
    assert!((e[0] - 0.2).abs() < 1e-12 && (e[1] - 0.2).abs() < 1e-12, "edge shares {e:?}");
    let mut counted = rows_project();
    counted.pv.edge_rows = true;
    counted.pv.row_count = 5.0;
    assert!((yield_of(&a) / yield_of(&counted) - 1.0).abs() < 1e-12, "five rows from the tables and from the row count");
    // A table missing in the middle row opens the row behind it to the front and the row in front to the back
    let mut gap = a.clone();
    gap.layout.tables.remove(2 * 4 + 1);
    let e = array_groups(&gap).unwrap()[0].edge_share(&gap.pv);
    assert!((e[0] - 5.0 / 19.0).abs() < 1e-12 && (e[1] - 5.0 / 19.0).abs() < 1e-12, "edge shares with a gap {e:?}");
    // Trackers take the mean of both edges; east-west pairs and canopies none
    let mut tr = a.clone();
    tr.pv.mount = "tracker".into();
    tr.pv.tracker_axis_azimuth = 90.0;   // axes along the rows of the block
    let e = array_groups(&tr).unwrap()[0].edge_share(&tr.pv);
    assert!((e[0] - 0.2).abs() < 1e-12 && e[0] == e[1], "tracker edge shares {e:?}");
    let mut ew = a.clone();
    ew.layout.areas[0].east_west = true;
    ew.layout.areas[0].azimuth = 90.0;
    assert_eq!(array_groups(&ew).unwrap()[0].edge_share(&ew.pv), [0.0, 0.0]);
}

#[test]
fn rows_on_sloped_ground() {
    // A slope falling towards the front lowers the row in front, one falling away raises it; a slope along the rows leaves the
    // beam shading alone. Monofacial, beam shading only, so the slope acts on the row shading alone.
    let mut p = rows_project();
    p.pv.bifaciality = 0.0;
    p.pv.diffuse_shading = false;
    p.pv.gcr = 0.6;
    let flat = yield_of(&p);
    let at = |deg: f64, down: f64| { let mut q = p.clone(); q.pv.ground_slope = deg; q.pv.ground_slope_azimuth = down; yield_of(&q) };
    let (front, back, side) = (at(10.0, 180.0), at(10.0, 0.0), at(10.0, 90.0));
    assert!(front > flat && back < flat && side == flat, "towards the front {front}, away {back}, along the rows {side}, level {flat}");
    assert_eq!(at(0.0, 0.0), flat, "no slope");
    let mut q = p.clone();
    q.pv.ground_slope = 10.0;
    assert_eq!(yield_of(&q), front, "the slope falls the way the modules face by default");
    // With diffuse row shading and the rear side the slope also moves the ground and sky the rows see
    let mut d = rows_project();
    let flat_bif = yield_of(&d);
    d.pv.ground_slope = 10.0;
    let towards = yield_of(&d);
    d.pv.ground_slope_azimuth = 0.0;
    assert!(towards > flat_bif && yield_of(&d) < flat_bif, "bifacial rows on a slope: {towards} towards, {} away, {flat_bif} level", yield_of(&d));
    // A PV area's slope gives its tables the same result as the project's
    let mut a = rows_project();
    table_block(&mut a, 3, 2);
    a.layout.areas[0].slope = 10.0;
    a.layout.areas[0].slope_azimuth = 0.0;
    let g = array_groups(&a).unwrap();
    assert!(g.len() == 1 && g[0].slope == Some([10.0, 0.0]), "a group of its own slope");
    assert!((yield_of(&a) / yield_of(&d) - 1.0).abs() < 1e-12, "area slope as the project's");
}

#[test]
fn snowfall_and_humidity_from_a_csv_file() {
    // One row per hour: GHI, temperature, snowfall (mm of water per hour) and humidity (a fraction)
    let mut text = String::from("ghi,t2m,snow_we,rh\n");
    for i in 0..HOURS { text += &format!("{},{},{},{}\n", if i % 24 >= 8 && i % 24 < 16 { 400 } else { 0 }, -2.0, if i < 48 { 2.0 } else { 0.0 }, 0.7); }
    let opt = |extra: &str| Value::parse(&format!(r#"{{"kind":"weather","time_col":-1,"ghi":0,"tamb":1{extra}}}"#)).unwrap();
    let plain = import_series(&text, &opt("")).unwrap();
    assert!(!plain.has("snow") && !plain.has("rh"), "no snowfall or humidity unless chosen");
    let r = import_series(&text, &opt(r#","snow":2,"snow_units":"mm_water","rh":3,"rh_units":"fraction""#)).unwrap();
    let (snow, rh) = (r.getv("snow"), r.getv("rh"));
    assert!(snow.len() == HOURS && (snow[0] - 2.0).abs() < 1e-9 && snow[100] == 0.0, "snowfall in cm/h");
    assert!(rh.len() == HOURS && rh.iter().all(|&x| (x - 70.0).abs() < 1e-9), "humidity in %");
    let mm = import_series(&text, &opt(r#","snow":2,"snow_units":"mm""#)).unwrap();
    assert!((mm.getv("snow")[0] - 0.2).abs() < 1e-9, "mm of snow");
    assert!(import_series(&text, &opt(r#","snow":2,"snow_units":"inch""#)).is_err(), "unknown unit");
}

#[test]
fn humidity_sets_the_monthly_snow_loss() {
    let mut p = make_project(46.5, 8.0);
    p.wx.tamb = vec![-3.0; HOURS];
    p.pv.snow_monthly = vec![40.0, 30.0, 20.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 20.0, 35.0];
    p.pv.snow_events = vec![4.0, 3.0, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 2.0, 4.0];
    let typed = yield_of(&p);   // 80 % humidity every month
    let mut same = p.clone();
    same.wx.rh = vec![80.0; HOURS];
    assert!((yield_of(&same) / typed - 1.0).abs() < 1e-12, "the weather's humidity at the typed value");
    let mut dry = p.clone();
    dry.wx.rh = vec![40.0; HOURS];
    assert!(yield_of(&dry) > typed, "drier air, less snow loss: {} vs {typed}", yield_of(&dry));
}

#[test]
fn snowfall_and_humidity_downloads() {
    use soloptima_engine::weather::{MockHttp, WeatherService};
    let series = |name: &str, v: f64| {
        let body: Vec<String> = (0..HOURS).map(|i| format!("\"2019{i:06}\":{v}")).collect();
        format!("\"{name}\":{{{}}}", body.join(","))
    };
    let base = "https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M";
    let tail = "&community=RE&longitude=8.00000&latitude=46.50000&start=20190101&end=20191231&format=JSON&time-standard=UTC";
    let body = |extra: &str| format!(r#"{{"geometry":{{"coordinates":[8,46.5,500]}},"properties":{{"parameter":{{{},{},{},{},{}{extra}}}}}}}"#,
        series("ALLSKY_SFC_SW_DWN", 100.0), series("ALLSKY_SFC_SW_DNI", 50.0), series("ALLSKY_SFC_SW_DIFF", 40.0), series("T2M", 1.0), series("WS10M", 2.0));
    let m = MockHttp::default();
    m.ok(&format!("{base}{tail}"), body(""));
    m.ok(&format!("{base},PRECSNOLAND,RH2M{tail}"), body(&format!(",{},{}", series("PRECSNOLAND", 0.5), series("RH2M", 85.0))));
    let svc = WeatherService::new(Box::new(m)).with_clock(|| 1_750_000_000);
    let plain = svc.fetch_weather("nasa_power", 46.5, 8.0, 2019).unwrap();
    assert!(!plain.has("snow") && !plain.has("rh"), "nothing more unless asked");
    let w = svc.fetch_weather_with("nasa_power", 46.5, 8.0, 2019, true).unwrap();
    assert!(w.getv("snow").iter().all(|&x| x == 0.5) && w.getv("rh").iter().all(|&x| x == 85.0), "snowfall and humidity");
    assert_eq!(parse_weather(&w).rh.len(), HOURS);
}
