//! The weather services on saved responses, against the C++ engine: tests/gen_weather_fixtures.cpp ran each service in
//! src/weather.cpp on the synthetic responses built below and wrote the answer's hash and head, the requests made and the
//! hash of every response (so a difference in a response is told from one in the service). No network.
use soloptima_engine::weather::{epoch_h_to_iso, iso_to_epoch_h, MockHttp, WeatherService};
use soloptima_engine::{Error, Value};
use std::path::PathBuf;
use std::sync::Arc;

const LAT: f64 = 7.0;
const LON: f64 = -1.0;

fn fnv(s: &str) -> String {
    let mut h: u64 = 1469598103934665603;
    for b in s.bytes() { h ^= u64::from(b); h = h.wrapping_mul(1099511628211); }
    format!("{h:016x}")
}
fn fu(v: f64) -> String { format!("{v:.5}") }
fn ymd(d: i32) -> (i32, i32) {
    const CUM: [i32; 13] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 366];
    let mut m = 1;
    while m < 12 && d >= CUM[m] { m += 1; }
    (m as i32, d - CUM[m - 1] + 1)
}
fn sun(i: i32) -> f64 { (800.0 * (f64::from(i % 24 - 6) / 12.0 * 3.14159265).sin()).max(0.0) * (0.6 + 0.3 * (f64::from(i / 24) * 0.1).sin()) }
fn temp(i: i32) -> f64 { 20.0 + 8.0 * (f64::from(i % 24 - 9) / 24.0 * 6.2831853).sin() }
fn ws(i: i32) -> f64 { 2.0 + f64::from(i % 7) * 0.5 }

fn tmy(rows: i32) -> String {
    let mut s = String::from(r#"{"inputs":{"location":{"latitude":7,"longitude":-1,"elevation":109.5,"irradiance_time_offset":0.1138},"meteo_data":{"radiation_db":"PVGIS-SARAH3","year_min":2005,"year_max":2023}},"outputs":{"tmy_hourly":["#);
    for i in 0..rows {
        if i > 0 { s += ","; }
        s += &format!(r#"{{"time(UTC)":"20050101:0010","T2m":{:.1},"G(h)":{:.2},"Gb(n)":{:.2},"Gd(h)":{:.2},"WS10m":{:.1}}}"#, temp(i), sun(i), sun(i) * 0.7, sun(i) * 0.3, ws(i));
    }
    s + "]}}"
}
fn series(years: &[i32], last_rows: i32) -> String {
    let mut s = String::from(r#"{"inputs":{"location":{"latitude":7,"longitude":-1,"elevation":109.5},"meteo_data":{"radiation_db":"PVGIS-SARAH3"}},"outputs":{"hourly":["#);
    let mut first = true;
    for (yi, &y) in years.iter().enumerate() {
        let n = if y % 4 == 0 { 8784 } else { 8760 };
        let rows = if yi + 1 == years.len() && last_rows >= 0 { last_rows } else { n };
        for i in 0..rows {
            let hs = (60.0 * (f64::from(i % 24 - 6) / 12.0 * 3.14159265).sin()).max(-10.0);
            let (mo, dd) = ymd(i / 24);
            if !first { s += ","; }
            first = false;
            s += &format!(r#"{{"time":"{y:04}{mo:02}{dd:02}:{:02}10","Gb(i)":{:.2},"Gd(i)":{:.2},"H_sun":{hs:.1},"T2m":{:.1},"WS10m":{:.1}}}"#, i % 24, sun(i) * 0.7, sun(i) * 0.3, temp(i), ws(i));
        }
    }
    s + "]}}"
}
fn series_url(y0: i32, y1: i32) -> String {
    format!("https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat={}&lon={}&startyear={y0}&endyear={y1}&angle=0&aspect=0&components=1&outputformat=json", fu(LAT), fu(LON))
}
fn nasa_url(y: i32) -> String {
    format!("https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M&community=RE&longitude={}&latitude={}&start={y}0101&end={y}1231&format=JSON&time-standard=UTC", fu(LON), fu(LAT))
}
fn nasa(y: i32, gap0: i32, gap1: i32, drop_rows: i32, no_param: bool) -> String {
    if no_param { return r#"{"properties":{"parameter":{}},"messages":["no data"]}"#.into(); }
    let obj = |name: &str, val: &dyn Fn(i32) -> f64, cut: i32| {
        let mut s = format!("\"{name}\":{{");
        for i in 0..8760 - cut {
            let (mo, dd) = ymd(i / 24);
            if i > 0 { s += ","; }
            s += &format!("\"{y}{mo:02}{dd:02}{:02}\":{}", i % 24, if i >= gap0 && i < gap1 { "-999".to_string() } else { format!("{:.2}", val(i)) });
        }
        s + "}"
    };
    format!(r#"{{"geometry":{{"coordinates":[-1,7,111.2]}},"properties":{{"parameter":{{{},{},{},{},{}}}}}}}"#,
            obj("ALLSKY_SFC_SW_DWN", &sun, 0), obj("ALLSKY_SFC_SW_DNI", &|i| sun(i) * 0.7, 0),
            obj("ALLSKY_SFC_SW_DIFF", &|i| sun(i) * 0.3 + if i % 5 == 0 { 5.0 } else { 0.0 }, 0), obj("T2M", &temp, drop_rows), obj("WS10M", &ws, 0))
}
fn om_url(days: i32, key: &str) -> String {
    let host = if key.is_empty() { "https://api.open-meteo.com" } else { "https://customer-api.open-meteo.com" };
    format!("{host}/v1/forecast?latitude={}&longitude={}&hourly=shortwave_radiation,diffuse_radiation,direct_normal_irradiance,temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=GMT&forecast_days={}{}",
            fu(LAT), fu(LON), (days.clamp(1, 16) + 1).min(16), if key.is_empty() { String::new() } else { format!("&apikey={key}") })
}
fn om(n: i32, null_at: i32) -> String {
    let (mut t, mut g, mut d, mut b, mut tt, mut w) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    for i in 0..n {
        t.push(format!("\"2025-03-{:02}T{:02}:00\"", 1 + i / 24, i % 24));
        g.push(if i >= null_at { "null".to_string() } else { format!("{:.1}", sun(i)) });
        d.push(format!("{:.1}", sun(i) * 0.3));
        b.push(format!("{:.1}", sun(i) * 0.7));
        tt.push(format!("{:.1}", temp(i)));
        w.push(format!("{:.1}", 3.0 + f64::from(i % 4)));
    }
    format!(r#"{{"hourly":{{"time":[{}],"shortwave_radiation":[{}],"diffuse_radiation":[{}],"direct_normal_irradiance":[{}],"temperature_2m":[{}],"wind_speed_10m":[{}]}}}}"#,
            t.join(","), g.join(","), d.join(","), b.join(","), tt.join(","), w.join(","))
}
fn met_url() -> String { format!("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={}&lon={}", fu(LAT), fu(LON)) }
fn met(hourly: i32, six: i32, leap_gap: bool) -> String {
    let mut s = String::from(r#"{"properties":{"meta":{"updated_at":"2025-03-01T06:00:00Z"},"timeseries":["#);
    let mut h: i64 = 0;
    for i in 0..hourly + six {
        if i == hourly - 3 && leap_gap { h += 2; }
        if i > 0 { s += ","; }
        s += &format!(r#"{{"time":"2025-03-{:02}T{:02}:00:00Z","data":{{"instant":{{"details":{{"air_temperature":{:.1},"cloud_area_fraction":{:.1},"wind_speed":{:.1}}}}}}}}}"#,
                      1 + h / 24, h % 24, temp(h as i32), f64::from(30 + (i * 7) % 60), 1.5 + f64::from(i % 5) * 0.4);
        h += if i + 1 < hourly { 1 } else { 6 };
    }
    s + "]}}"
}
fn pvcalc_url(tracker: bool, angle: f64, aspect: f64, loss: f64) -> String {
    format!("https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat={}&lon={}&peakpower=1&loss={}{}&mountingplace=free&pvtechchoice=crystSi&outputformat=json", fu(LAT), fu(LON), fu(loss),
            if tracker { "&fixed=0&inclined_axis=1&inclinedaxisangle=0".to_string() } else { format!("&angle={}&aspect={}", fu(angle), fu(aspect)) })
}
fn pvcalc(kind: &str, months: i32) -> String {
    let mo: Vec<String> = (1..=months).map(|i| format!(r#"{{"month":{i},"E_m":{:.2}}}"#, 100.0 + 5.5 * f64::from(i))).collect();
    format!(r#"{{"inputs":{{"meteo_data":{{"radiation_db":"PVGIS-SARAH3","year_min":2005,"year_max":2023}}}},"outputs":{{"monthly":{{"{kind}":[{}]}},"totals":{{"{kind}":{{"E_y":1450.25,"H(i)_y":1820.5}}}}}}}}"#, mo.join(","))
}

fn strip(v: &mut Value) {
    for k in ["retrieved_utc", "issued_utc"] { if v.has(k) { v.set(k, ""); } }
    if let Value::Arr(ys) = v.at("years").clone() {
        if ys.first().is_some_and(Value::is_object) {
            v.set("years", ys.into_iter().map(|mut y| { strip(&mut y); y }).collect::<Vec<_>>());
        }
    }
}
fn head(v: &Value) -> Value {
    match v {
        Value::Arr(a) => Value::Arr(a.iter().take(3).map(head).collect()),
        Value::Obj(o) => Value::Obj(o.iter().map(|(k, x)| (k.clone(), head(x))).collect()),
        x => x.clone(),
    }
}

type Action = Box<dyn Fn(&WeatherService) -> Result<Value, Error>>;
struct Case { name: &'static str, resp: Vec<(String, String)>, act: Action }
fn case(name: &'static str, resp: Vec<(String, String)>, act: impl Fn(&WeatherService) -> Result<Value, Error> + 'static) -> Case { Case { name, resp, act: Box::new(act) } }
fn r(url: String, body: String) -> (String, String) { (url, body) }

fn cases() -> Vec<Case> {
    let tmy_url = format!("https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat={}&lon={}&outputformat=json", fu(LAT), fu(LON));
    let fw = |s: &'static str, y: i32| move |w: &WeatherService| w.fetch_weather(s, LAT, LON, y);
    let fy = |s: &'static str, a: i32, b: i32| move |w: &WeatherService| w.fetch_weather_years(s, LAT, LON, a, b);
    let fc = |p: &'static str, d: i32, k: &'static str| move |w: &WeatherService| w.fetch_forecast(p, LAT, LON, d, k);
    let (y1, y2) = (vec![2005, 2006, 2007, 2008], vec![2009, 2010]);
    vec![
        case("pvgis tmy", vec![r(tmy_url.clone(), tmy(8760))], fw("pvgis_tmy", 0)),
        case("pvgis tmy 8784", vec![r(tmy_url.clone(), tmy(8784))], fw("pvgis_tmy", 0)),
        case("pvgis tmy short", vec![r(tmy_url.clone(), tmy(100))], fw("pvgis_tmy", 0)),
        case("pvgis tmy http error", vec![r(tmy_url, "ERR Data service returned HTTP 500: busy".into())], fw("pvgis_tmy", 0)),
        case("pvgis year", vec![r(series_url(2019, 2019), series(&[2019], -1))], fw("pvgis_year", 2019)),
        case("pvgis year leap", vec![r(series_url(2020, 2020), series(&[2020], -1))], fw("pvgis_year", 2020)),
        case("pvgis year incomplete", vec![r(series_url(2021, 2021), series(&[2021], 100))], fw("pvgis_year", 2021)),
        case("pvgis years", vec![r(series_url(2005, 2008), series(&y1, -1)), r(series_url(2009, 2010), series(&y2, 5000))], fy("pvgis", 2010, 2005)),
        case("pvgis years single", vec![], fy("pvgis", 2010, 2010)),
        case("pvgis years clamp", vec![r(series_url(2005, 2008), series(&y1, -1)), r(series_url(2009, 2010), series(&y2, -1))], fy("pvgis", 1990, 2010)),
        case("nasa year", vec![r(nasa_url(2019), nasa(2019, 0, 0, 0, false))], fw("nasa_power", 2019)),
        case("nasa gaps", vec![r(nasa_url(2019), nasa(2019, 100, 103, 0, false))], fw("nasa_power", 2019)),
        case("nasa gap 5 and 0", vec![r(nasa_url(2019), nasa(2019, 0, 5, 0, false))], fw("nasa_power", 2019)),
        case("nasa gap 80", vec![r(nasa_url(2019), nasa(2019, 3000, 3080, 0, false))], fw("nasa_power", 2019)),
        case("nasa lengths", vec![r(nasa_url(2019), nasa(2019, 0, 0, 24, false))], fw("nasa_power", 2019)),
        case("nasa no data", vec![r(nasa_url(2019), nasa(2019, 0, 0, 0, true))], fw("nasa_power", 2019)),
        case("nasa years", vec![r(nasa_url(2016), nasa(2016, 0, 0, 0, false)), r(nasa_url(2017), nasa(2017, 50, 52, 0, false)), r(nasa_url(2018), nasa(2018, 0, 0, 0, false))], fy("nasa_power", 2016, 2018)),
        case("nasa years one fails", vec![r(nasa_url(2016), nasa(2016, 0, 0, 0, false)), r(nasa_url(2017), "ERR boom".into())], fy("nasa_power", 2016, 2017)),
        case("unknown source", vec![], fw("magic", 0)),
        case("unknown years source", vec![], fy("magic", 2000, 2001)),
        case("open-meteo", vec![r(om_url(3, ""), om(96, 1000))], fc("open_meteo", 3, "")),
        case("open-meteo nulls", vec![r(om_url(2, ""), om(72, 50))], fc("open_meteo", 2, "")),
        case("open-meteo days clamp", vec![r(om_url(40, ""), om(24, 1000))], fc("open_meteo", 40, "")),
        case("open-meteo days zero", vec![r(om_url(0, ""), om(24, 1000))], fc("open_meteo", 0, "")),
        case("open-meteo key", vec![r(om_url(2, "ab-C_9"), om(48, 1000))], fc("open_meteo", 2, "ab-C_9")),
        case("open-meteo bad key", vec![], fc("open_meteo", 2, "a&b")),
        case("open-meteo empty", vec![r(om_url(2, ""), r#"{"hourly":{"time":[]}}"#.into())], fc("open_meteo", 2, "")),
        case("met norway", vec![r(met_url(), met(60, 20, false))], fc("met_norway", 2, "")),
        case("met norway gap", vec![r(met_url(), met(40, 10, true))], fc("met_norway", 3, "")),
        case("met norway short", vec![r(met_url(), met(10, 0, false))], fc("met_norway", 1, "")),
        case("pvcalc fixed", vec![r(pvcalc_url(false, 10.0, 0.0, 14.0), pvcalc("fixed", 12))], |w| w.pvgis_pvcalc(LAT, LON, 14.0, 10.0, 0.0, false)),
        case("pvcalc tracker", vec![r(pvcalc_url(true, 0.0, 0.0, 14.0), pvcalc("inclined_axis", 12))], |w| w.pvgis_pvcalc(LAT, LON, 14.0, 0.0, 0.0, true)),
        case("pvcalc 11 months", vec![r(pvcalc_url(false, 10.0, 0.0, 14.0), pvcalc("fixed", 11))], |w| w.pvgis_pvcalc(LAT, LON, 14.0, 10.0, 0.0, false)),
        case("pvcalc cached", vec![r(pvcalc_url(false, 10.0, 0.0, 14.0), pvcalc("fixed", 12))], |w| {
            w.clear_yield_cache();
            w.pvgis_pvcalc(LAT, LON, 14.0, 10.0, 0.0, false)?;
            let mut b = w.pvgis_pvcalc(LAT, LON, 14.0, 10.0, 0.0, false)?;
            b.set("dropped", w.clear_yield_cache());
            Ok(b)
        }),
    ]
}

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/weather.json");
    Value::parse(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn every_service_gives_what_the_cpp_one_gives_on_the_same_responses() {
    let want = fixture();
    let cs = cases();
    assert_eq!(cs.len() + 1, want.len());
    for (c, w) in cs.iter().zip(want.arr()) {
        assert_eq!(c.name, w.at("name").str());
        let mock = Arc::new(MockHttp::default());
        for (url, body) in &c.resp {
            match body.strip_prefix("ERR ") { Some(m) => mock.fail(url, m), None => mock.ok(url, body.clone()) }
            assert_eq!(fnv(body), w.at("responses").at(url).str(), "{}: the response for {url} differs from the C++ one", c.name);
        }
        struct Shared(Arc<MockHttp>);
        impl soloptima_engine::weather::Http for Shared { fn get(&self, u: &str, a: &str) -> Result<String, Error> { self.0.get(u, a) } }
        use soloptima_engine::weather::Http;
        let svc = WeatherService::new(Box::new(Shared(mock.clone()))).with_clock(|| 1_793_000_000);
        match (c.act)(&svc) {
            Err(e) => assert_eq!(format!("ERR {e}"), w.at("status").str(), "{}", c.name),
            Ok(mut v) => {
                assert_eq!(w.at("status").str(), "OK", "{} answered, C++ refused", c.name);
                strip(&mut v);
                assert_eq!(head(&v).dump(), w.at("head").str(), "head of {}", c.name);
                assert_eq!(fnv(&v.dump()), w.at("hash").str(), "result of {}", c.name);
            }
        }
        let mut urls: Vec<String> = mock.requests.lock().unwrap().iter().map(|(u, a)| if a == "Soloptima/1.0" { u.clone() } else { format!("{u} [{a}]") }).collect();
        urls.sort();
        let want_urls: Vec<String> = w.at("urls").arr().iter().map(|u| u.str().to_string()).collect();
        assert_eq!(urls, want_urls, "requests of {}", c.name);
    }
}

#[test]
fn iso_times_and_epoch_hours_match_the_cpp_functions() {
    let want = fixture();
    let t = want.arr().last().unwrap().at("times");
    assert_eq!(t.len(), 28);
    for x in t.arr() {
        if x.has("iso") {
            let got = iso_to_epoch_h(x.at("iso").str());
            assert_eq!(got.map(|h| h as f64), if x.at("h").is_null() { None } else { Some(x.get("h", 0.0)) }, "{}", x.at("iso").str());
            assert_eq!(got.map(epoch_h_to_iso).unwrap_or_default(), x.at("back").str(), "{}", x.at("iso").str());
        } else {
            assert_eq!(epoch_h_to_iso(x.get("epoch", 0.0) as i64), x.at("back").str());
        }
    }
}

#[test]
fn the_cases_of_test_engine_cpp() {
    let e0 = iso_to_epoch_h("2028-02-28T00:00").unwrap();
    assert!(iso_to_epoch_h("1970-01-01T00:00Z") == Some(0) && iso_to_epoch_h("2028-02-29T00:00:00Z").unwrap() - e0 == 24
        && iso_to_epoch_h("2028-03-01T00:00").unwrap() - e0 == 48 && iso_to_epoch_h("2028-02-28T05:59").unwrap() - e0 == 5
        && iso_to_epoch_h("2027-02-29T00:00").is_none() && iso_to_epoch_h("2028-02-28T05:20+08:00").is_none()
        && iso_to_epoch_h("2028-02-28T24:00").is_none() && iso_to_epoch_h("").is_none());
    assert!(iso_to_epoch_h("2024-01-01T0500").is_none() && iso_to_epoch_h("2024-01-01T05:00").is_some()
        && iso_to_epoch_h("2024-01-01T05:00") == iso_to_epoch_h("2024-01-01T05Z"));
}

#[test]
fn the_horizon_is_turned_to_north_and_checked() {
    // PVGIS counts the azimuth from south: A = 0 is south, so the first value (north) is the one at A = -180 / 180
    let rows: Vec<String> = (0..36).map(|k| format!(r#"{{"A":{},"H_hor":{}}}"#, -180 + 10 * k, if k == 0 { -2.0 } else { f64::from(k) })).collect();
    let body = format!(r#"{{"inputs":{{"horizon_db":"DEM-calculated"}},"outputs":{{"horizon_profile":[{}]}}}}"#, rows.join(","));
    let url = "https://re.jrc.ec.europa.eu/api/v5_3/printhorizon?lat=7.00000&lon=-1.00000&outputformat=json";
    let mock = MockHttp::default();
    mock.ok(url, body);
    struct Shared(MockHttp);
    impl soloptima_engine::weather::Http for Shared { fn get(&self, u: &str, a: &str) -> Result<String, Error> { soloptima_engine::weather::Http::get(&self.0, u, a) } }
    let svc = WeatherService::new(Box::new(Shared(mock)));
    let h = svc.fetch_horizon(7.0, -1.0).unwrap();
    assert_eq!(h.at("source").str(), "PVGIS DEM-calculated");
    let v = h.at("horizon").arr();
    assert_eq!(v.len(), 36);
    // A = -180 -> (A + 540) % 360 = 0 deg from north: index 0 holds max(0, -2) = 0; A = -170 -> 10 deg: 1
    assert_eq!((v[0].num(9.0), v[1].num(9.0), v[35].num(9.0)), (0.0, 1.0, 35.0));
    assert!(svc.fetch_horizon(95.0, 0.0).unwrap_err().0.contains("out of range"));
    let few = WeatherService::new(Box::new(Shared({ let m = MockHttp::default(); m.ok(url, r#"{"outputs":{"horizon_profile":[{"A":0,"H_hor":1}]}}"#); m })));
    assert_eq!(few.fetch_horizon(7.0, -1.0).unwrap_err().0, "PVGIS returned no horizon for this location.");
}

#[test]
fn http_errors_carry_the_services_message() {
    use soloptima_engine::weather::http_error;
    assert_eq!(http_error(400, r#"{"message":"Location over the sea"}"#), "Data service returned HTTP 400: Location over the sea");
    assert_eq!(http_error(503, "busy"), "Data service returned HTTP 503: busy");
    assert_eq!(http_error(500, &"é".repeat(400)).chars().count(), "Data service returned HTTP 500: ".len() + 150);
}

// the network client, against a server on this computer
#[test]
fn the_network_client_reads_follows_redirects_and_reports_status() {
    use soloptima_engine::weather::{Http, UreqHttp};
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let mut s = stream.unwrap();
            let mut buf = [0u8; 2048];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (status, extra, body) = match path.as_str() {
                "/start" => ("302 Found", "Location: /final\r\n", ""),
                "/final" => ("200 OK", "", "hello"),
                "/missing" => ("404 Not Found", "", r#"{"message":"No such place"}"#),
                _ => ("200 OK", "", if req.contains("User-Agent: Soloptima/1.0") { "agent" } else { "no agent" }),
            };
            write!(s, "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let http = UreqHttp::default();
    let base = format!("http://127.0.0.1:{port}");
    assert_eq!(http.get(&format!("{base}/start"), "Soloptima/1.0").unwrap(), "hello");
    assert_eq!(http.get(&format!("{base}/missing"), "Soloptima/1.0").unwrap_err().0, "Data service returned HTTP 404: No such place");
    assert_eq!(http.get(&format!("{base}/x"), "Soloptima/1.0").unwrap(), "agent");
    assert!(http.get("http://127.0.0.1:1/", "Soloptima/1.0").unwrap_err().0.starts_with("Download failed"));
}
