//! The options of an import (src/series.hpp: `import_series`), checked as the C++ engine checks them.
use super::{fail, R, MAX_COL};
use crate::json::Value;

/// weather variables of an import: GHI, DNI, DHI, temperature, wind speed, snowfall, relative humidity
pub const NW: usize = 7;
pub const KEYS: [&str; NW] = ["ghi", "dni", "dhi", "tamb", "wind", "snow", "rh"];
pub const VARS: [&str; NW] = ["GHI", "DNI", "DHI", "temperature", "wind speed", "snowfall", "relative humidity"];

pub struct Opt {
    pub load: bool,
    pub time_col: i32,
    pub time2_col: i32,
    /// load columns, summed
    pub cols: Vec<i32>,
    /// weather columns: ghi, dni, dhi, tamb, wind, snow, rh
    pub wcol: [i32; NW],
    /// date order: 'a'(uto), 'y'(md), 'd'(my), 'm'(dy)
    pub order: u8,
    pub basis: String,
    pub label: String,
    pub u_load: String,
    pub u_irr: String,
    pub u_temp: String,
    pub u_wind: String,
    pub u_snow: String,
    pub u_rh: String,
    /// 0: the year with most data
    pub year: i32,
    pub last12: bool,
    pub fill_long: bool,
    /// a load logged every 15 or 30 min also comes back at that resolution (`kw_sub`)
    pub keep_sub: bool,
    /// standard UTC offset of the site, minutes
    pub off: i64,
    /// local_clock: UTC minutes of each change, and the offsets in minutes (clk[k] before at[k])
    pub at: Vec<i64>,
    pub clk: Vec<i64>,
}

fn opt_int(o: &Value, k: &str, def: i32, lo: i32, hi: i32, what: &str) -> R<i32> {
    let v = o.at(k);
    if v.is_null() { return Ok(def); }
    let x = v.num(f64::NAN);
    if !(x >= f64::from(lo) && x <= f64::from(hi)) || x != x.floor() {
        return fail(format!("{what} must be a whole number from {lo} to {hi}."));
    }
    Ok(x as i32)
}

fn opt_enum(o: &Value, k: &str, def: &str, allowed: &[&str], what: &str) -> R<String> {
    let s = o.gets(k, def);
    if allowed.contains(&s.as_str()) { return Ok(s); }
    fail(format!("Unknown {what}: \"{}\".", s.chars().take(40).collect::<String>()))
}

pub fn parse_opt(j: &Value) -> R<Opt> {
    if !j.is_object() { return fail("The import options are missing."); }
    let top = MAX_COL as i32 - 1;
    let load = opt_enum(j, "kind", "load", &["load", "weather"], "kind of data")? == "load";
    let time_col = opt_int(j, "time_col", -1, -1, top, "The time column")?;
    let time2_col = if time_col < 0 { -1 } else { opt_int(j, "time2_col", -1, -1, top, "The time-of-day column")? };
    let mut o = Opt {
        load, time_col, time2_col, cols: vec![], wcol: [-1; NW], order: b'a', basis: String::new(), label: String::new(), u_load: "kw".into(),
        u_irr: "w_m2".into(), u_temp: "c".into(), u_wind: "m_s".into(), u_snow: "cm".into(), u_rh: "pct".into(), year: 0, last12: false, fill_long: false, keep_sub: false, off: 0, at: vec![], clk: vec![],
    };
    if load {
        let c = j.at("cols").arr();
        if c.is_empty() || c.len() > 32 { return fail("Choose from 1 to 32 load columns."); }
        for x in c {
            let v = x.num(f64::NAN);
            if !(v >= 0.0 && v <= f64::from(top)) || v != v.floor() {
                return fail(format!("Load columns must be column numbers from 1 to {MAX_COL}."));
            }
            if o.cols.contains(&(v as i32)) { return fail("Each load column can be chosen only once."); }
            o.cols.push(v as i32);
        }
    } else {
        for k in 0..NW { o.wcol[k] = opt_int(j, KEYS[k], -1, -1, top, &format!("The {} column", VARS[k]))?; }
        if o.wcol[0] < 0 { return fail("Choose the GHI column."); }
    }
    let value_cols: Vec<i32> = if load { o.cols.clone() } else { o.wcol.to_vec() };
    if value_cols.iter().any(|&c| c >= 0 && (c == o.time_col || c == o.time2_col)) { return fail("A value column cannot also be the time column."); }
    let ord = opt_enum(j, "date_order", "auto", &["auto", "ymd", "dmy", "mdy"], "date order")?;
    o.order = if ord == "auto" { b'a' } else { ord.as_bytes()[0] };
    o.basis = opt_enum(j, "time_basis", "local_standard", &["utc", "local_standard", "local_clock"], "time basis")?;
    o.label = opt_enum(j, "label", "auto", &["auto", "start", "end", "instant"], "timestamp label")?;
    if load {
        o.u_load = opt_enum(j, "units", "kw", &["kw", "w", "mw", "kwh_interval", "mwh_interval"], "load unit")?;
    } else {
        o.u_irr = opt_enum(j, "irr_units", "w_m2", &["w_m2", "wh_m2_interval", "kwh_m2_interval", "mj_m2_interval"], "irradiance unit")?;
        o.u_temp = opt_enum(j, "temp_units", "c", &["c", "k"], "temperature unit")?;
        o.u_wind = opt_enum(j, "wind_units", "m_s", &["m_s", "km_h"], "wind speed unit")?;
        o.u_snow = opt_enum(j, "snow_units", "cm", &["cm", "mm", "mm_water"], "snowfall unit")?;
        o.u_rh = opt_enum(j, "rh_units", "pct", &["pct", "fraction"], "relative humidity unit")?;
    }
    let y = j.at("year");
    if y.is_string() && y.str() == "last12" {
        if !load { return fail("The last 12 months can be taken only from a load file."); }
        o.last12 = true;
    } else if !y.is_null() && !(y.is_string() && (y.str() == "auto" || y.str().is_empty())) {
        o.year = opt_int(j, "year", 0, 1900, 2200, "The year")?;
    }
    o.fill_long = j.getb("fill_long", false);
    o.keep_sub = j.getb("keep_sub", false);
    let off = j.get("utc_offset", 0.0);
    if !(off.abs() <= 14.0) { return fail("UTC offset must be between -14 h and +14 h."); }
    o.off = (off * 60.0).round() as i64;
    if o.basis == "local_clock" {
        if o.time_col < 0 { return fail("Clock time with daylight saving needs a time column."); }
        let c = j.at("clock");
        let s = c.get("start", f64::NAN);
        let ch = c.at("changes").arr();
        if !(s.abs() <= 14.0) || ch.len() > 4000 { return fail("The daylight-saving calendar of the time zone is missing or invalid."); }
        o.clk.push((s * 60.0).round() as i64);
        for x in ch {
            let (t, h) = (x.idx(0).num(f64::NAN), x.idx(1).num(f64::NAN));
            if !(t.abs() < 1e11) || !(h.abs() <= 14.0) || o.at.last().is_some_and(|&l| t.round() as i64 <= l) {
                return fail("The clock changes of the time zone must be in time order, with offsets within 14 h of UTC.");
            }
            o.at.push(t.round() as i64);
            o.clk.push((h * 60.0).round() as i64);
        }
    }
    Ok(o)
}
