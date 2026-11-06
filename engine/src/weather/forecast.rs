//! Short-term forecasts for the day-ahead schedule: Open-Meteo and MET Norway (src/weather.cpp).
use super::{fail, fmt, iso_to_epoch_h, WeatherService, R};
use crate::json::Value;
use crate::solar::{haurwitz_ghi, sun_position};

/// ISO "YYYY-MM-DDTHH:MM" (UTC) to the hour of a non-leap year (0..8759); -1 when it cannot be read
fn hour_of_year(iso: &str) -> i32 {
    const CUM: [i32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let f: Vec<i32> = iso.split(|c: char| c == '-' || c == 'T' || c == ':').take(4).filter_map(|s| s.trim().parse().ok()).collect();
    if f.len() != 4 { return -1; }
    let (mo, mut d, h) = (f[1], f[2], f[3]);
    if mo == 2 && d == 29 { d = 28; }
    (CUM[(mo.clamp(1, 12) - 1) as usize] + d - 1) * 24 + h
}

impl WeatherService {
    pub(crate) fn open_meteo(&self, lat: f64, lon: f64, days: i32, key: &str) -> R<Value> {
        let host = if key.is_empty() { "https://api.open-meteo.com" } else { "https://customer-api.open-meteo.com" };
        // the forecast starts at 00:00 UTC today, so one day more still leaves `days` days after the current hour
        let mut url = format!("{host}/v1/forecast?latitude={}&longitude={}&hourly=shortwave_radiation,diffuse_radiation,direct_normal_irradiance,temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=GMT&forecast_days={}",
                              fmt(lat), fmt(lon), (days.clamp(1, 16) + 1).min(16));
        if !key.is_empty() {
            if key.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') { return fail("Invalid API key characters."); }
            url += &format!("&apikey={key}");
        }
        let d = Value::parse(&self.get(&url)?)?;
        let issued = self.now_iso();
        let h = d.at("hourly");
        // every series ends at the first hour without irradiance or temperature (null at the end of the model's range), so a
        // missing value is never read as zero PV
        let mut n = h.at("time").len();
        for k in ["shortwave_radiation", "diffuse_radiation", "direct_normal_irradiance", "temperature_2m"] {
            if let Some(i) = (0..n).find(|&i| h.at(k).idx(i).is_null()) { n = i; }
        }
        let head = |k: &str| Value::Arr((0..n).map(|i| h.at(k).idx(i).clone()).collect());
        let mut o = Value::object();
        o.set("provider", "Open-Meteo");
        o.set("time_offset", -0.5);   // radiation is the mean of the preceding hour
        o.set("issued_utc", issued);
        o.set("times", head("time"));
        o.set("ghi", head("shortwave_radiation"));
        o.set("dhi", head("diffuse_radiation"));
        o.set("dni", head("direct_normal_irradiance"));
        o.set("tamb", head("temperature_2m"));
        o.set("wind", head("wind_speed_10m"));
        let base = if key.is_empty() { "Open-Meteo free tier (noncommercial use only)." } else { "Open-Meteo (API key)." };
        let tail = if n < h.at("time").len() { format!(" No data from {} UTC.", h.at("time").idx(n).str()) } else { String::new() };
        o.set("note", format!("{base}{tail}"));
        Ok(o)
    }

    pub(crate) fn met_norway(&self, lat: f64, lon: f64, days: i32) -> R<Value> {
        let url = format!("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={}&lon={}", fmt(lat), fmt(lon));
        let d = Value::parse(&self.get_as(&url, "Soloptima/1.0 local-energy-model")?)?;
        let issued = self.now_iso();
        // hourly instants, exactly 1 h apart (also across 29 February), up to where the series turns 6-hourly; one instant more
        // than the hours wanted, for the end of the last hour
        struct Instant { t: String, cloud: f64, temp: f64, wind: f64 }
        let mut inst: Vec<Instant> = Vec::new();
        let want = days.clamp(1, 16) as usize * 24;
        let mut prev: Option<i64> = None;
        for ts in d.at("properties").at("timeseries").arr() {
            let t = ts.gets("time", "");
            let Some(h) = iso_to_epoch_h(&t) else { break };
            if prev.is_some_and(|p| h != p + 1) { break; }
            prev = Some(h);
            let det = ts.at("data").at("instant").at("details");
            inst.push(Instant { t: t.chars().take(16).collect(), cloud: det.get("cloud_area_fraction", 50.0), temp: det.get("air_temperature", 25.0), wind: det.get("wind_speed", 1.0) });
            if inst.len() > want { break; }
        }
        // hour [h, h + 1) takes the mean of the instants at h and h + 1; the last hour its own instant
        let (mut times, mut ghi, mut tamb, mut wind) = (Value::array(), Value::array(), Value::array(), Value::array());
        for i in 0..inst.len().min(want) {
            let (a, b) = (&inst[i], &inst[(i + 1).min(inst.len() - 1)]);
            let cloud = (a.cloud + b.cloud) / 2.0 / 100.0;
            let h = hour_of_year(&a.t);
            let s = sun_position(lat, lon, h / 24 + 1, f64::from(h % 24) + 0.5);
            let cs = haurwitz_ghi(s.cos_zenith);
            times.push(a.t.clone());
            ghi.push(cs * (1.0 - 0.75 * cloud.powf(3.4)));   // Kasten-Czeplak cloud-cover model
            tamb.push((a.temp + b.temp) / 2.0);
            wind.push((a.wind + b.wind) / 2.0);
        }
        let mut o = Value::object();
        o.set("provider", "MET Norway");
        o.set("time_offset", 0.5);
        o.set("issued_utc", issued);
        o.set("model_updated_utc", d.at("properties").at("meta").gets("updated_at", ""));
        o.set("times", times);
        o.set("ghi", ghi);
        o.set("tamb", tamb);
        o.set("wind", wind);
        o.set("note", "MET Norway Locationforecast (CC BY 4.0); irradiance derived from cloud cover (Kasten-Czeplak).");
        Ok(o)
    }
}
