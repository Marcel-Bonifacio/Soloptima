//! PVGIS: typical year, hourly series, PV yield (PVcalc) and the terrain horizon (src/weather.cpp, /api/horizon of src/main.cpp).
use super::{fail, fmt, max0, parallel_map, Pack, WeatherService, R};
use crate::json::Value;
use crate::model::HOURS;
use std::collections::BTreeMap;

fn series_url(lat: f64, lon: f64, y0: i32, y1: i32) -> String {
    format!("https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?lat={}&lon={}&startyear={y0}&endyear={y1}&angle=0&aspect=0&components=1&outputformat=json",
            fmt(lat), fmt(lon))
}

/// A PVGIS seriescalc response (one or several years, horizontal plane) as one weather JSON per calendar year. Rows are grouped
/// by the year in "time" (YYYYMMDD:HHMM); beam normal = Gb(i) / sin(sun height) when the sun is above 2 deg. 29 Feb of leap years
/// is dropped; incomplete years are left out. `now` stamps "retrieved_utc".
pub fn pvgis_split_years(svc: &WeatherService, d: &Value, lat: f64, lon: f64) -> Value {
    let rows = d.at("outputs").at("hourly").arr();
    let loc = d.at("inputs").at("location");
    let db = d.at("inputs").at("meteo_data").gets("radiation_db", "PVGIS");
    let mut out = Value::array();
    let time = |i: usize| rows[i].gets("time", "");
    let mut i = 0;
    while i < rows.len() {
        let ts = time(i);
        let y = ts.get(..4).unwrap_or(&ts).to_string();
        let offset = if ts.len() >= 13 { ts.get(11..13).map_or(0, |s| s.parse::<i32>().unwrap_or(0)) as f64 / 60.0 } else { 0.5 };
        let mut s: [Vec<f64>; 5] = Default::default();   // ghi, dni, dhi, t, w
        let mut j = i;
        while j < rows.len() && { let t = time(j); t.get(..4).unwrap_or(&t) == y } {
            let r = &rows[j];
            let (gb, gd, hs) = (r.at("Gb(i)").num(0.0), r.at("Gd(i)").num(0.0), r.at("H_sun").num(0.0));
            s[0].push(gb + gd);
            s[2].push(gd);
            s[1].push(if hs > 2.0 { gb / (hs * 3.14159265358979 / 180.0).sin() } else { 0.0 });
            s[3].push(r.at("T2m").num(0.0));
            s[4].push(r.at("WS10m").num(0.0));
            j += 1;
        }
        if j == i { j += 1; }   // a row without a time: skip it
        if y.len() == 4 && s[0].len() >= HOURS {
            out.push(svc.pack(Pack { source: format!("PVGIS {y} ({db})"), lat, lon, elev: loc.get("elevation", 0.0), offset, series: s,
                note: format!("Hourly series for {y} from {db}, JRC European Commission."), years: y, api: "PVGIS 5.3 seriescalc", n_filled: 0, max_gap_h: 0 }));
        }
        i = j;
    }
    out
}

impl WeatherService {
    pub(crate) fn pvgis_tmy(&self, lat: f64, lon: f64) -> R<Value> {
        let url = format!("https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat={}&lon={}&outputformat=json", fmt(lat), fmt(lon));
        let d = Value::parse(&self.get(&url)?)?;
        let rows = d.at("outputs").at("tmy_hourly").arr();
        if rows.len() < HOURS { return fail("PVGIS returned no TMY data for this location (outside coverage?)."); }
        let col = |k: &str| rows.iter().map(|r| r.at(k).num(0.0)).collect::<Vec<f64>>();
        let series = [col("G(h)"), col("Gb(n)"), col("Gd(h)"), col("T2m"), col("WS10m")];
        let loc = d.at("inputs").at("location");
        let md = d.at("inputs").at("meteo_data");
        let db = md.gets("radiation_db", "PVGIS");
        let (y0, y1) = (md.get("year_min", 0.0) as i32, md.get("year_max", 0.0) as i32);
        Ok(self.pack(Pack { source: format!("PVGIS TMY ({db})"), lat, lon, elev: loc.get("elevation", 0.0), offset: loc.get("irradiance_time_offset", 0.5),
            series, note: format!("Typical meteorological year assembled from {db}, JRC European Commission."),
            years: if y0 > 0 && y1 > 0 { format!("{y0}-{y1}") } else { String::new() }, api: "PVGIS 5.3 tmy", n_filled: 0, max_gap_h: 0 }))
    }

    pub(crate) fn pvgis_year(&self, lat: f64, lon: f64, year: i32) -> R<Value> {
        let d = Value::parse(&self.get(&series_url(lat, lon, year, year))?)?;
        match pvgis_split_years(self, &d, lat, lon) {
            Value::Arr(mut ys) if !ys.is_empty() => Ok(ys.swap_remove(0)),
            _ => fail("PVGIS returned no hourly data for that year/location."),
        }
    }

    /// Every year from y0 to y1 within the PVGIS 5.3 database (2005-2023): blocks of 4 years, 3 at a time
    pub(crate) fn pvgis_years(&self, lat: f64, lon: f64, y0: i32, y1: i32) -> R<Value> {
        let y0 = y0.clamp(2005, 2023);
        let y1 = y1.clamp(y0, 2023);
        if y1 == y0 { return fail("PVGIS hourly data covers 2005-2023: choose at least two years in that range."); }
        let blocks: Vec<(i32, i32)> = (y0..=y1).step_by(4).map(|y| (y, (y + 3).min(y1))).collect();
        let parts = parallel_map(blocks.len(), 3, |k| {
            let d = Value::parse(&self.get_retry(&series_url(lat, lon, blocks[k].0, blocks[k].1))?)?;
            Ok((pvgis_split_years(self, &d, lat, lon), d.at("inputs").at("meteo_data").gets("radiation_db", "PVGIS")))
        })?;
        let db = parts.first().map(|p| p.1.clone()).unwrap_or_default();
        let mut years = Value::array();
        for (part, _) in &parts { for y in part.arr() { years.push(y.clone()); } }
        if years.is_empty() { return fail("PVGIS returned no hourly data for this location (outside coverage?)."); }
        let mut o = Value::object();
        o.set("from", y0);
        o.set("to", y1);
        o.set("database", db);
        o.set("years", years);
        Ok(o)
    }

    /// PVGIS PVcalc reference yield of 1 kWp of free-standing crystalline silicon over the long-term average of the PVGIS radiation
    /// database: {ey, em[12], hi_y, radiation_db, year_min, year_max}. loss_pct: system losses PVGIS applies as a plain factor.
    /// angle: tilt. aspect: azimuth in PVGIS terms (0 = south, -90 = east, 90 = west). tracker: horizontal north-south single axis.
    pub fn pvgis_pvcalc(&self, lat: f64, lon: f64, loss_pct: f64, angle: f64, aspect: f64, tracker: bool) -> R<Value> {
        let mount = if tracker { "&fixed=0&inclined_axis=1&inclinedaxisangle=0".to_string() } else { format!("&angle={}&aspect={}", fmt(angle), fmt(aspect)) };
        let url = format!("https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat={}&lon={}&peakpower=1&loss={}{mount}&mountingplace=free&pvtechchoice=crystSi&outputformat=json",
                          fmt(lat), fmt(lon), fmt(loss_pct));
        // the yield is recalculated after every PV edit; PVGIS is asked again only when the request changes
        if let Some(v) = self.yield_cache.lock().unwrap().get(&url) { return Ok(v.clone()); }
        let d = Value::parse(&self.get(&url)?)?;
        let kind = if tracker { "inclined_axis" } else { "fixed" };
        let tot = d.at("outputs").at("totals").at(kind);
        let mut em = vec![0.0; 12];
        let mut months = 0;
        for r in d.at("outputs").at("monthly").at(kind).arr() {
            let mo = r.get("month", 0.0) as i32;
            if (1..=12).contains(&mo) { em[(mo - 1) as usize] = r.get("E_m", 0.0); months += 1; }
        }
        if !tot.has("E_y") || months != 12 { return fail("PVGIS returned no PV yield for this location."); }
        let md = d.at("inputs").at("meteo_data");
        let mut o = Value::object();
        o.set("ey", tot.get("E_y", 0.0));
        o.set("em", em);
        o.set("hi_y", tot.get("H(i)_y", 0.0));
        o.set("radiation_db", md.gets("radiation_db", "PVGIS"));
        o.set("year_min", md.get("year_min", 0.0));
        o.set("year_max", md.get("year_max", 0.0));
        let mut cache = self.yield_cache.lock().unwrap();
        if cache.len() >= 64 { cache.clear(); }
        cache.insert(url, o.clone());
        Ok(o)
    }

    /// The PVcalc answers kept in memory are dropped; returns how many
    pub fn clear_yield_cache(&self) -> usize {
        let mut c = self.yield_cache.lock().unwrap();
        let n = c.len();
        c.clear();
        n
    }

    /// PVGIS terrain horizon (printhorizon, from its elevation model): heights at equal azimuth steps from north, clockwise.
    /// PVGIS counts the azimuth from south, so it is turned by 180 deg. Returns {horizon, source}.
    pub fn fetch_horizon(&self, lat: f64, lon: f64) -> R<Value> {
        if !(lat.abs() <= 90.0 && lon.abs() <= 180.0) { return fail("Location latitude/longitude out of range."); }
        let url = format!("https://re.jrc.ec.europa.eu/api/v5_3/printhorizon?lat={lat:.5}&lon={lon:.5}&outputformat=json");
        let d = Value::parse(&self.get(&url)?)?;
        let mut by_az: BTreeMap<i64, f64> = BTreeMap::new();   // 0.1 deg from north
        for h in d.at("outputs").at("horizon_profile").arr() {
            by_az.insert(((h.get("A", 0.0) + 540.0) % 360.0 * 10.0).round() as i64 % 3600, max0(h.get("H_hor", 0.0)));
        }
        if by_az.len() < 4 { return fail("PVGIS returned no horizon for this location."); }
        let mut heights = Value::array();
        let step = 3600.0 / by_az.len() as f64;
        for k in 0..by_az.len() {
            match by_az.get(&((k as f64 * step).round() as i64)) {
                Some(&h) => heights.push(h),
                None => return fail("PVGIS returned a horizon at uneven azimuth steps."),
            }
        }
        let mut o = Value::object();
        o.set("horizon", heights);
        o.set("source", format!("PVGIS {}", d.at("inputs").gets("horizon_db", "DEM-calculated")));
        Ok(o)
    }
}
