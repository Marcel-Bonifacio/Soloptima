//! Samples to one year of hourly means with gap filling and a report (`to_hours`, `fill_load` in src/series.cpp).
use super::csv::DAY;
use super::opts::{Opt, KEYS, NW, VARS};
use super::samples::Sample;
use super::{fail, fmt_hour, fmt_min, R};
use crate::calendar::{civil_from_days, days_from_civil, fill_gaps, floor_div};
use crate::json::Value;
use crate::model::{month_of_day, HOURS, MONTH_START};
use std::collections::BTreeMap;

const NONE: f64 = f64::NAN;

/// Load gaps: runs of up to 3 h are interpolated linearly; longer runs take the same hour a week earlier (a week later at the
/// start of the series). Zeros are data, never gaps.
fn fill_load(v: &mut [f64], filled: &mut [bool]) {
    let n = v.len();
    let mut a = 0;
    while a < n {
        if !v[a].is_nan() { a += 1; continue; }
        let mut b = a;
        while b < n && v[b].is_nan() { b += 1; }
        for i in a..b {
            filled[i] = true;
            if b - a <= 3 && a > 0 && b < n {
                v[i] = v[a - 1] + (v[b] - v[a - 1]) * (i - a + 1) as f64 / (b - a + 1) as f64;
            } else if i >= 168 {
                v[i] = v[i - 168];
            } else {
                let mut j = i + 168;
                while j < n && v[j].is_nan() { j += 168; }
                v[i] = if j < n { v[j] } else { NONE };
            }
        }
        a = b;
    }
}

/// Runs of missing hours: (start, length) pairs.
fn missing_runs(miss: &[bool]) -> Vec<(usize, usize)> {
    let mut r = Vec::new();
    let mut a = 0;
    while a < HOURS {
        if !miss[a] { a += 1; continue; }
        let mut b = a;
        while b < HOURS && miss[b] { b += 1; }
        r.push((a, b - a));
        a = b;
    }
    r
}

/// The year (or the last 365 days), the time-weighted mean of the samples overlapping each hour, 29 February dropped, gaps
/// filled. `fixed_year` is the year of a file without time column (0 otherwise).
pub fn to_hours(o: &Opt, samples: &[Sample], rep: &mut Value, fixed_year: i32) -> R<Value> {
    let nv = if o.load { 1 } else { NW };
    // minutes covered per calendar year of the output time base (by the primary value)
    let mut per_year: BTreeMap<i32, f64> = BTreeMap::new();
    let mut last_b = -1e300f64;
    for s in samples {
        if s.v[0].is_nan() { continue; }
        *per_year.entry(civil_from_days(floor_div(s.a.floor() as i64, DAY)).0).or_default() += s.b - s.a;
        last_b = last_b.max(s.b);
    }
    if per_year.is_empty() { return fail(if o.load { "No load values in the chosen columns." } else { "No GHI values in the chosen column." }); }
    let mut years = Value::array();
    let mut year = fixed_year;
    let mut most = -1.0;
    for (&y, &m) in &per_year {
        if fixed_year == 0 { years.push(vec![Value::from(y), Value::from((m / 60.0).round())]); }
        if fixed_year == 0 && o.year == 0 && m >= most { most = m; year = y; }
    }
    if o.year != 0 && fixed_year == 0 {
        if !per_year.contains_key(&o.year) { return fail(format!("The file has no data in {}: choose another year.", o.year)); }
        year = o.year;
    }
    // window of days (output time base) and the date of each calendar position
    let last12 = o.last12 && fixed_year == 0;
    let (day_a, day_b);
    let (mut y_last, mut m_last, mut d_last) = (year, 12u32, 31u32);
    if last12 {
        let last_day = floor_div(last_b.ceil() as i64 - 1, DAY);
        (y_last, m_last, d_last) = civil_from_days(last_day);
        day_b = last_day + 1;
        day_a = day_b - 366;
    } else {
        day_a = days_from_civil(year, 1, 1);
        day_b = days_from_civil(year + 1, 1, 1);
    }
    let nh = (day_b - day_a) as usize * 24;
    let w0 = (day_a * DAY) as f64;
    let w1 = w0 + nh as f64 * 60.0;
    let mut sw = vec![vec![0.0f64; nh]; nv];
    let mut swv = sw.clone();
    for s in samples {
        let (a, b) = (s.a.max(w0), s.b.min(w1));
        if b <= a { continue; }
        let k1 = nh.min(((b - w0) / 60.0).ceil() as usize);
        for k in ((a - w0) / 60.0).floor() as usize..k1 {
            let ov = b.min(w0 + (k + 1) as f64 * 60.0) - a.max(w0 + k as f64 * 60.0);
            if ov <= 0.0 { continue; }
            for v in 0..nv {
                if !s.v[v].is_nan() { sw[v][k] += ov; swv[v][k] += ov * s.v[v]; }
            }
        }
    }
    let mut out = vec![vec![NONE; HOURS]; nv];
    let mut miss = vec![vec![false; HOURS]; nv];
    let mut cover = 0.0;
    let (mut used_a, mut used_b) = (i64::MAX, i64::MIN);   // first and last day used
    for p in 0..365usize {
        let m = month_of_day(p as i32) as usize + 1;
        let dd = p as i32 - MONTH_START[m - 1] + 1;
        let y = if last12 && (m as u32 > m_last || (m as u32 == m_last && dd as u32 > d_last)) { y_last - 1 } else if last12 { y_last } else { year };
        let day = days_from_civil(y, m as u32, dd as u32);
        let k0 = ((day - day_a) * 24) as usize;
        used_a = used_a.min(day);
        used_b = used_b.max(day);
        for h in 0..24 {
            let (i, k) = (p * 24 + h, k0 + h);
            cover += (sw[0][k] / 60.0).min(1.0);
            for v in 0..nv {
                if sw[v][k] >= 30.0 { out[v][i] = swv[v][k] / sw[v][k]; } else { miss[v][i] = true; }
            }
        }
    }
    // the last 12 months skip 29 February, so with one in the window they start 366 days before their end
    let period = if last12 { format!("{} to {}", &fmt_min(used_a * DAY)[..10], &fmt_min(used_b * DAY)[..10]) } else { year.to_string() };
    // gaps
    let mut missing = Value::object();
    let mut max_gap = 0i32;
    let mut filled = vec![false; HOURS];
    let runs0 = missing_runs(&miss[0]);
    if o.load {
        for r in &runs0 { max_gap = max_gap.max(r.1 as i32); }
        if max_gap > 72 && !o.fill_long {
            if let Some(r) = runs0.iter().find(|r| r.1 as i32 == max_gap) {
                let mut g = Value::object();
                g.set("hours", max_gap);
                g.set("from", fmt_hour(r.0));
                rep.set("long_gap", g);
            }
        } else {
            fill_load(&mut out[0], &mut filled);
            if out[0].iter().any(|x| x.is_nan()) { return fail(format!("Too few load values to fill the gaps: the file covers too little of {period}.")); }
            // the model needs the site's consumption: export (negative load) is refused, as the positional upload did
            if let Some(first) = out[0].iter().position(|&x| x < 0.0) {
                let n = out[0].iter().filter(|&&x| x < 0.0).count();
                return fail(format!("The load is negative in {n} h, the first at {}: Soloptima needs the site's consumption, without export.", fmt_hour(first)));
            }
        }
    } else {
        let split = o.wcol[1] >= 0 && o.wcol[2] >= 0;
        for v in 0..NW {
            if o.wcol[v] < 0 || ((v == 1 || v == 2) && !split) { continue; }   // DNI and DHI are used only together
            let rv = if v > 0 { missing_runs(&miss[v]) } else { runs0.clone() };
            let (mut n_miss, mut gap, mut at) = (0usize, 0usize, 0usize);
            for r in &rv { n_miss += r.1; if r.1 > gap { gap = r.1; at = r.0; } }
            if n_miss == HOURS { return fail(format!("The {} column has no numbers in {period}: choose another column, or none.", VARS[v])); }
            if gap > 72 {
                return fail(format!("No {} for {gap} h in a row from {} in {period} (at most 72 h can be filled): choose another year or fill the gap in the file.", VARS[v], fmt_hour(at)));
            }
            missing.set(KEYS[v], n_miss);
            for x in &mut out[v] { if x.is_nan() { *x = -999.0; } }
            out[v] = fill_gaps(std::mem::take(&mut out[v]), &mut filled, &mut max_gap);
        }
    }
    let mut runs = Value::array();
    let mut n_miss0 = 0;
    for r in &runs0 { n_miss0 += r.1; if runs.len() < 50 { runs.push(vec![Value::from(r.0), Value::from(r.1)]); } }
    rep.set("year", if last12 { Value::from("last12") } else if fixed_year != 0 { Value::Null } else { Value::from(year) });
    rep.set("period", if fixed_year != 0 { "one year, row by row".to_string() } else { period });
    rep.set("years", years);
    rep.set("base", if o.load || o.basis != "utc" { "local standard time" } else { "UTC" });
    rep.set("coverage", cover / HOURS as f64);
    rep.set("missing_h", n_miss0);
    rep.set("filled_h", filled.iter().filter(|&&f| f).count());
    rep.set("max_gap_h", max_gap);
    rep.set("runs", runs);
    let mut notes = Value::array();
    let mut res = Value::object();
    if o.load {
        if !rep.has("long_gap") { res.set("kw", std::mem::take(&mut out[0])); }
    } else {
        rep.set("missing", missing);
        let split = o.wcol[1] >= 0 && o.wcol[2] >= 0;
        if (o.wcol[1] >= 0) != (o.wcol[2] >= 0) { notes.push("DNI and DHI are used only together, so the one given was left out."); }
        if o.wcol[3] < 0 { notes.push("No temperature column: 25 °C is assumed in every hour."); }
        if o.wcol[4] < 0 { notes.push("No wind speed column: the module temperature assumes 1 m/s and wind turbines produce nothing."); }
        res.set("ghi", std::mem::take(&mut out[0]));
        res.set("dni", if split { Value::from(std::mem::take(&mut out[1])) } else { Value::array() });
        res.set("dhi", if split { Value::from(std::mem::take(&mut out[2])) } else { Value::array() });
        res.set("tamb", if o.wcol[3] >= 0 { Value::from(std::mem::take(&mut out[3])) } else { Value::from(vec![25.0; HOURS]) });
        res.set("wind", if o.wcol[4] >= 0 { Value::from(std::mem::take(&mut out[4])) } else { Value::array() });
        // snowfall and humidity only when chosen, so a file without them keeps the weather it had
        // a year without snowfall leaves the monthly snow model in place, as the weather download does
        if o.wcol[5] >= 0 {
            if out[5].iter().any(|&x| x > 0.0) { res.set("snow", out[5].iter().map(|&x| x.max(0.0)).collect::<Vec<f64>>()); }
            else { notes.push("The snowfall column has no snow in this year, so it was left out (the monthly snow loss stays)."); }
        }
        if o.wcol[6] >= 0 { res.set("rh", out[6].iter().map(|&x| x.clamp(0.0, 100.0)).collect::<Vec<f64>>()); }
        res.set("is_utc", o.basis == "utc");
        res.set("time_offset", 0.5);
    }
    rep.set("notes", notes);
    if let Some(g) = rep.at("long_gap").clone().into_some() { res.set("long_gap", g); }
    res.set("report", rep.clone());
    Ok(res)
}

trait IntoSome { fn into_some(self) -> Option<Value>; }
impl IntoSome for Value { fn into_some(self) -> Option<Value> { if self.is_null() { None } else { Some(self) } } }
