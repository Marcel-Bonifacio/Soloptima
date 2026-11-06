//! NASA POWER hourly data (src/weather.cpp).
use super::{fail, fmt, max0, parallel_map, Pack, WeatherService, R};
use crate::calendar::fill_gaps;
use crate::json::Value;

impl WeatherService {
    /// Last year with complete NASA POWER hourly data: its irradiance is published about three months late
    fn nasa_last_year(&self) -> i32 {
        let (y, m) = self.now_year_month();
        y - if m >= 5 { 1 } else { 2 }
    }

    pub(crate) fn nasa_power(&self, lat: f64, lon: f64, year: i32) -> R<Value> {
        let url = format!("https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M&community=RE&longitude={}&latitude={}&start={year}0101&end={year}1231&format=JSON&time-standard=UTC",
                          fmt(lon), fmt(lat));
        let d = Value::parse(&self.get(&url)?)?;
        let p = d.at("properties").at("parameter");
        if !p.has("ALLSKY_SFC_SW_DWN") {
            let dump = d.dump();
            let mut cut = dump.len().min(300);
            while !dump.is_char_boundary(cut) { cut -= 1; }
            return fail(format!("NASA POWER returned no data: {}", &dump[..cut]));
        }
        let mut filled: Vec<bool> = Vec::new();
        let mut max_gap = 0;
        let mut series = |k: &str| {
            // keys YYYYMMDDHH sort chronologically
            let v: Vec<f64> = p.at(k).obj().map(|o| o.values().map(|x| x.num(-999.0)).collect()).unwrap_or_default();
            fill_gaps(v, &mut filled, &mut max_gap)
        };
        let (mut g, b, mut f, t, w) = (series("ALLSKY_SFC_SW_DWN"), series("ALLSKY_SFC_SW_DNI"), series("ALLSKY_SFC_SW_DIFF"), series("T2M"), series("WS10M"));
        for v in [&b, &f, &t, &w] {
            if v.len() != g.len() { return fail(format!("NASA POWER returned hourly series of different lengths for {year}.")); }
        }
        for i in 0..g.len() {
            g[i] = max0(g[i]);
            f[i] = if f[i] < 0.0 { 0.0 } else if g[i] < f[i] { g[i] } else { f[i] };   // std::clamp(f, 0, g)
        }
        let n_filled = filled.iter().filter(|&&x| x).count() as i32;
        if max_gap > 72 {
            return fail(format!("NASA POWER has no data for {max_gap} h in a row in {year} (its hourly irradiance is published about three months late): choose an earlier year."));
        }
        let elev = d.at("geometry").at("coordinates").idx(2).num(0.0);
        let note = format!("NASA Langley Research Center POWER project, hourly all-sky irradiance (CERES/MERRA-2).{}",
                           if n_filled > 0 { format!(" {n_filled} h filled.") } else { String::new() });
        Ok(self.pack(Pack { source: format!("NASA POWER {year}"), lat, lon, elev, offset: 0.5, series: [g, b, f, t, w], note,
            years: year.to_string(), api: "NASA POWER temporal/hourly/point", n_filled, max_gap_h: max_gap }))
    }

    /// Every year from y0 to y1 from 2001 to the last complete year, one request per year, 3 at a time
    pub(crate) fn nasa_power_years(&self, lat: f64, lon: f64, y0: i32, y1: i32) -> R<Value> {
        let last = self.nasa_last_year();
        let y0 = y0.clamp(2001, last);
        let y1 = y1.clamp(y0, last);
        if y1 == y0 { return fail(format!("NASA POWER hourly data covers 2001-{last}: choose at least two years in that range.")); }
        let ys = parallel_map((y1 - y0 + 1) as usize, 3, |k| {
            let y = y0 + k as i32;
            self.nasa_power(lat, lon, y).or_else(|_| self.nasa_power(lat, lon, y).or_else(|e| fail(format!("NASA POWER {y}: {e}"))))
        })?;
        let mut o = Value::object();
        o.set("from", y0);
        o.set("to", y1);
        o.set("database", "NASA POWER");
        o.set("years", ys);
        Ok(o)
    }
}
