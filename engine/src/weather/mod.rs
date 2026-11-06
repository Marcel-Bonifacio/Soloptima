//! Open-access meteorological data: PVGIS, NASA POWER, and short-term forecasts (Open-Meteo, MET Norway), ported from src/weather.cpp.
//! `WeatherService` owns the HTTP client (a trait: `UreqHttp`, or `MockHttp` for saved responses) and the clock, so tests run offline.
mod forecast;
mod http;
mod nasa;
mod pvgis;
mod time;

pub use http::{http_error, Http, MockHttp, UreqHttp, USER_AGENT};
pub use pvgis::pvgis_split_years;
pub use time::{epoch_h_to_iso, iso_from_unix, iso_to_epoch_h};

use crate::json::{Error, Value};
use crate::model::HOURS;
use std::collections::BTreeMap;
use std::sync::Mutex;

pub type R<T> = Result<T, Error>;
pub(crate) fn fail<T>(m: impl Into<String>) -> R<T> { Err(Error(m.into())) }

pub(crate) fn fmt(v: f64) -> String { format!("{v:.5}") }

pub(crate) fn max0(x: f64) -> f64 { if 0.0 < x { x } else { 0.0 } }

/// Drops 29 February, then cuts or pads (with the value 24 h earlier) to one year
pub(crate) fn to8760(mut v: Vec<f64>) -> Vec<f64> {
    if v.len() == 8784 { v.drain(59 * 24..60 * 24); }
    v.truncate(HOURS);
    while v.len() < HOURS { let x = if v.len() >= 24 { v[v.len() - 24] } else { 0.0 }; v.push(x); }
    v
}

pub struct WeatherService {
    http: Box<dyn Http>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    yield_cache: Mutex<BTreeMap<String, Value>>,
}

/// A weather set of the C++ engine's shape (8760 h, UTC): the arrays are cut or padded to a year
pub(crate) struct Pack<'a> {
    pub source: String,
    pub lat: f64,
    pub lon: f64,
    pub elev: f64,
    pub offset: f64,
    pub series: [Vec<f64>; 5],
    pub note: String,
    pub years: String,
    pub api: &'a str,
    pub n_filled: i32,
    pub max_gap_h: i32,
}

impl WeatherService {
    pub fn new(http: Box<dyn Http>) -> Self {
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        WeatherService { http, now: Box::new(now), yield_cache: Mutex::new(BTreeMap::new()) }
    }
    pub fn online() -> Self { Self::new(Box::new(UreqHttp::default())) }
    /// A fixed clock (Unix seconds), for tests
    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self { self.now = Box::new(now); self }

    pub(crate) fn get(&self, url: &str) -> R<String> { self.http.get(url, USER_AGENT) }
    pub(crate) fn get_as(&self, url: &str, agent: &str) -> R<String> { self.http.get(url, agent) }
    /// GET with one retry: a multi-year download makes many requests, and one may fail on a busy server
    pub(crate) fn get_retry(&self, url: &str) -> R<String> { self.get(url).or_else(|_| self.get(url)) }
    pub(crate) fn now_iso(&self) -> String { iso_from_unix((self.now)()) }
    pub(crate) fn now_year_month(&self) -> (i32, u32) {
        let (y, m, _) = crate::calendar::civil_from_days((self.now)().div_euclid(86400));
        (y, m)
    }

    pub(crate) fn pack(&self, p: Pack) -> Value {
        let mut o = Value::object();
        o.set("source", p.source);
        o.set("years", p.years);
        o.set("is_utc", true);
        o.set("time_offset", p.offset);
        o.set("lat", p.lat);
        o.set("lon", p.lon);
        o.set("elevation", p.elev);
        o.set("note", p.note);
        o.set("api", p.api);
        o.set("retrieved_utc", self.now_iso());
        o.set("n_filled", p.n_filled);
        o.set("max_gap_h", p.max_gap_h);
        let [ghi, dni, dhi, t, ws] = p.series;
        o.set("ghi", to8760(ghi));
        o.set("dni", to8760(dni));
        o.set("dhi", to8760(dhi));
        o.set("tamb", to8760(t));
        o.set("wind", to8760(ws));
        o
    }

    /// Typical/historical year. source: pvgis_tmy | pvgis_year | nasa_power. Weather JSON (8760 h, UTC) with the data period in "years",
    /// the service in "api", "retrieved_utc", and the filled hours (n_filled; NASA POWER only) with the longest gap (max_gap_h).
    pub fn fetch_weather(&self, source: &str, lat: f64, lon: f64, year: i32) -> R<Value> {
        match source {
            "pvgis_tmy" => self.pvgis_tmy(lat, lon),
            "pvgis_year" => self.pvgis_year(lat, lon, year),
            "nasa_power" => self.nasa_power(lat, lon, year),
            _ => fail(format!("Unknown weather source: {source}")),
        }
    }

    /// Every historical year from y0 to y1 for the inter-annual variability run. source: pvgis (2005-2023, PVGIS 5.3) |
    /// nasa_power (2001 to the last complete year). The range is clamped to the database. Returns {from, to, database, years}.
    pub fn fetch_weather_years(&self, source: &str, lat: f64, lon: f64, y0: i32, y1: i32) -> R<Value> {
        let (y0, y1) = if y0 > y1 { (y1, y0) } else { (y0, y1) };
        match source {
            "pvgis" => self.pvgis_years(lat, lon, y0, y1),
            "nasa_power" => self.nasa_power_years(lat, lon, y0, y1),
            _ => fail(format!("Unknown weather source: {source}")),
        }
    }

    /// Short-term forecast. provider: open_meteo | met_norway
    pub fn fetch_forecast(&self, provider: &str, lat: f64, lon: f64, days: i32, api_key: &str) -> R<Value> {
        if provider == "met_norway" { self.met_norway(lat, lon, days) } else { self.open_meteo(lat, lon, days, api_key) }
    }
}

/// Runs f(i) for every i < n on at most `threads` threads and returns the results in order; the first error stops the rest
pub(crate) fn parallel_map<T: Send>(n: usize, threads: usize, f: impl Fn(usize) -> R<T> + Sync) -> R<Vec<T>> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<R<T>>>> = Mutex::new((0..n).map(|_| None).collect());
    std::thread::scope(|s| {
        for _ in 0..n.min(threads) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= n { break; }
                let r = f(i);
                let failed = r.is_err();
                out.lock().unwrap()[i] = Some(r);
                if failed { next.store(n, Ordering::SeqCst); }
            });
        }
    });
    let mut res = Vec::with_capacity(n);
    for r in out.into_inner().unwrap() {
        match r { Some(Ok(v)) => res.push(v), Some(Err(e)) => return Err(e), None => {} }
    }
    Ok(res)
}
