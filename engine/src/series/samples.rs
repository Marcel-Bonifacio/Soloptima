//! Rows of a file as samples in the output time base, with a time column (stamps, labels, intervals) or without (one row per interval
//! from 1 January). See `positional` and `timestamped` in src/series.cpp.
use super::csv::*;
use super::opts::{Opt, NW};
use super::{fail, fmt_min, R};
use crate::calendar::{civil_from_days, days_from_civil, floor_div};
use crate::json::Value;
use std::collections::BTreeMap;

const MAX_ROWS: usize = 1_500_000;   // rows with data, about three years of 1-minute values
const YEAR: i64 = 365 * DAY;
const NONE: f64 = f64::NAN;

/// One sample in the output time base: it covers [a, b) minutes with mean values in kW, or W/m2, degC, m/s, cm/h of snow and %
/// relative humidity (NaN = none).
#[derive(Clone, Copy)]
pub struct Sample {
    pub a: f64,
    pub b: f64,
    pub v: [f64; NW],
}

fn energy_factor(u: &str, len: f64) -> f64 {
    match u {
        "kwh_interval" | "wh_m2_interval" => 60.0 / len,
        "mwh_interval" | "kwh_m2_interval" => 60000.0 / len,
        "mj_m2_interval" => 1e6 / (60.0 * len),
        "w" => 1e-3,
        "mw" => 1e3,
        _ => 1.0,
    }
}

fn convert(o: &Opt, s: &mut Sample) {
    let len = s.b - s.a;
    if o.load { s.v[0] *= energy_factor(&o.u_load, len); return; }
    for k in 0..3 { s.v[k] *= energy_factor(&o.u_irr, len); }
    if o.u_temp == "k" { s.v[3] -= 273.15; }
    if o.u_wind == "km_h" { s.v[4] /= 3.6; }
    // snowfall: the depth of snow that fell in the interval as cm per hour (water equivalent at a tenth of the snow's density)
    s.v[5] *= 60.0 / len * if o.u_snow == "mm" { 0.1 } else { 1.0 };
    if o.u_rh == "fraction" { s.v[6] *= 100.0; }
}

/// Values of a row: load columns summed (None when one is not a number); weather columns or NaN (None when none is a number).
fn row_values(c: &[String], o: &Opt, comma: bool) -> Option<[f64; NW]> {
    let mut v = [NONE; NW];
    if o.load {
        let mut s = 0.0;
        for &col in &o.cols { s += cell_num(c, col, comma)?; }
        v[0] = s;
        return Some(v);
    }
    let mut any = false;
    for k in 0..NW {
        if let Some(x) = cell_num(c, o.wcol[k], comma) { v[k] = x; any = true; }
    }
    any.then_some(v)
}

fn col_list(o: &Opt) -> String { o.cols.iter().map(|c| (c + 1).to_string()).collect::<Vec<_>>().join(", ") }

/// One row per interval in file order from 1 January 00:00. A first row without a load or GHI value is a header; later load rows
/// without a number are an error naming the line, for weather a gap. The year is wrapped so a shift keeps every hour.
pub fn positional(text: &str, delim: u8, o: &Opt, shift: i64, rep: &mut Value) -> R<Vec<Sample>> {
    let comma = delim == b';';
    let mut vals: Vec<[f64; NW]> = Vec::new();
    let mut first = true;
    let mut lines = 0;
    let mut err = None;
    for_rows(text, delim, |no, c| {
        let r = row_values(c, o, comma);
        let v = r.unwrap_or([NONE; NW]);
        if first {
            first = false;
            if if o.load { r.is_none() } else { v[0].is_nan() } { return true; }
        }
        lines += 1;
        if o.load && r.is_none() {
            err = Some(format!("Line {no} has no number in column {}: without a time column every row must hold one interval.", col_list(o)));
            return false;
        }
        if vals.len() >= 35136 { err = Some("More rows than one year of quarter-hourly values (35,136): choose the time column.".into()); return false; }
        vals.push(v);
        true
    });
    if let Some(e) = err { return fail(e); }
    let n = vals.len();
    let per_h = match n { 8760 | 8784 => 1, 17520 | 17568 => 2, 35040 | 35136 => 4, _ => 0 };
    if per_h == 0 {
        return fail(format!("Without a time column the file must hold one year: 8760 hourly, 17520 half-hourly or 35040 quarter-hourly rows (one day more in a leap year). It has {n}."));
    }
    if n == 366 * 24 * per_h { vals.drain(59 * 24 * per_h..60 * 24 * per_h); }
    let dt = 60 / per_h as i64;
    let base = days_from_civil(2001, 1, 1) * DAY;
    let mut out = Vec::with_capacity(vals.len() * 3);
    for (i, v) in vals.iter().enumerate() {
        let wall = base + i as i64 * dt;
        let t = (if o.basis == "utc" { wall } else { wall - o.off }) + shift;
        let mut s = Sample { a: t as f64, b: (t + dt) as f64, v: *v };
        convert(o, &mut s);
        for w in [-YEAR, 0, YEAR] { out.push(Sample { a: s.a + w as f64, b: s.b + w as f64, v: s.v }); }
    }
    rep.set("positional", true);
    rep.set("rows", lines);
    rep.set("parsed", n as i64);
    rep.set("interval_min", dt);
    rep.set("label", "start");
    Ok(out)
}

struct Row {
    t: i64,
    wall: i64,
    v: [f64; NW],
}

/// Rows with a time column: headers skipped, stamps to UTC and the output base, sorted, duplicates averaged, interval found, then each
/// sample's span from its label and neighbours.
pub fn timestamped(text: &str, delim: u8, o: &Opt, shift: i64, rep: &mut Value) -> R<Vec<Sample>> {
    let comma = delim == b';';
    let (mut header, mut started, mut any_short, mut first_big, mut second_big, mut excel) = (0, false, false, false, false, false);
    for_rows(text, delim, |_, c| {
        let Some(r) = row_time(c, o, comma) else { if !started { header += 1; } return true; };
        started = true;
        excel = excel || r.serial;
        if !r.serial && r.n[0] <= 2 { any_short = true; first_big = first_big || r.f[0] > 12; second_big = second_big || r.f[1] > 12; }
        true
    });
    if !started { return fail(format!("No line of the file has a time in column {} that can be read.", o.time_col + 1)); }
    let mut order = o.order;
    if !any_short { order = b'y'; }
    else if order == b'a' {
        if first_big && second_big { return fail("Some dates have a first field above 12 and others a second field above 12: check the time column."); }
        if !first_big && !second_big {
            return fail("The dates are ambiguous: no day number above 12, so they read as day/month/year and as month/day/year. Choose the date order.");
        }
        order = if first_big { b'd' } else { b'm' };
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut bad = Value::array();
    let (mut idx, mut lines, mut n_bad, mut skipped, mut out_of_order) = (0, 0, 0, 0i64, 0i64);
    let mut seen: BTreeMap<i64, i32> = BTreeMap::new();
    let mut err = None;
    for_rows(text, delim, |no, c| {
        idx += 1;
        if idx <= header { return true; }
        lines += 1;
        let parsed = row_time(c, o, comma).and_then(|r| wall_minutes(&r, order).map(|w| (r, w))).and_then(|(r, w)| row_values(c, o, comma).map(|v| (r, w, v)));
        let Some((r, wall, v)) = parsed else {
            n_bad += 1;
            if n_bad <= 5 { bad.push(no); }
            return true;
        };
        if rows.len() >= MAX_ROWS { err = Some("The file has more than 1,500,000 rows with data: split it by year.".to_string()); return false; }
        let utc = if r.tz { wall - i64::from(r.tz_min) } else if o.basis == "utc" { wall } else if o.basis == "local_standard" { wall - o.off }
            else { clock_utc(o, wall, &mut seen, &mut skipped) };
        let t = utc + shift;
        if rows.last().is_some_and(|l| t < l.t) { out_of_order += 1; }
        rows.push(Row { t, wall, v });
        true
    });
    if let Some(e) = err { return fail(e); }
    if rows.len() < 2 { return fail("Fewer than two rows with a time and a value: check the columns."); }
    rows.sort_by_key(|r| r.t);   // stable
    // duplicate stamps: each variable averaged over the rows that have it
    let mut u: Vec<Row> = Vec::new();
    let mut dup_at: Vec<i64> = Vec::new();
    let mut dups = 0i64;
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        let (mut s, mut n) = ([0.0f64; NW], [0.0f64; NW]);
        while j < rows.len() && rows[j].t == rows[i].t {
            for k in 0..NW { if !rows[j].v[k].is_nan() { s[k] += rows[j].v[k]; n[k] += 1.0; } }
            j += 1;
        }
        let mut m = Row { t: rows[i].t, wall: rows[i].wall, v: [NONE; NW] };
        for k in 0..NW { m.v[k] = if n[k] > 0.0 { s[k] / n[k] } else { NONE }; }
        if j - i > 1 { dups += (j - i - 1) as i64; dup_at.push(rows[i].t); }
        u.push(m);
        i = j;
    }
    if u.len() < 2 { return fail("Every row has the same time: check the time column."); }
    // interval: the most common step, rounded to the minute; other steps covering over 5 % of the rows are reported with the
    // runs (3 steps or more) in which they occur
    let nd = u.len() - 1;
    let d: Vec<i64> = (0..nd).map(|j| u[j + 1].t - u[j].t).collect();
    let mut count: BTreeMap<i64, i64> = BTreeMap::new();
    for &x in &d { *count.entry(x).or_default() += 1; }
    let (mut dt, mut best) = (0i64, 0i64);
    for (&k, &v) in &count { if v > best { best = v; dt = k; } }
    if dt > 60 { return fail(format!("The most common step between timestamps is {dt} min: the import needs hourly or shorter intervals.")); }
    let mut run = vec![1usize; nd];   // length of the run of equal steps each step belongs to
    let mut a = 0;
    while a < nd {
        let mut b = a + 1;
        while b < nd && d[b] == d[a] { b += 1; }
        for r in &mut run[a..b] { *r = b - a; }
        a = b;
    }
    let rate: Vec<bool> = (0..nd).map(|j| d[j] == dt || (d[j] <= 60 && run[j] >= 3)).collect();
    let mut changes = Value::array();
    for (&step, &rows_n) in &count {
        if step == dt || rows_n * 20 <= u.len() as i64 { continue; }
        let mut ranges = Value::array();
        let mut a = 0;
        while a < nd && ranges.len() < 5 {
            if d[a] != step || run[a] < 3 { a += 1; continue; }
            ranges.push(vec![Value::from(fmt_min(u[a].t)), Value::from(fmt_min(u[a + run[a]].t))]);
            a += run[a];
        }
        let mut c = Value::object();
        c.set("interval_min", step);
        c.set("rows", rows_n);
        c.set("ranges", ranges);
        changes.push(c);
    }
    // daylight saving read as standard time: one hour missing in spring and one doubled in autumn (either hemisphere)
    let mut dst = false;
    if o.basis == "local_standard" {
        let month = |t: i64| civil_from_days(floor_div(t, DAY)).1;
        let (mut gap_ma, mut gap_so, mut dup_ma, mut dup_so) = (false, false, false, false);
        for j in 0..nd {
            if d[j] == dt + 60 { let m = month(u[j].t); gap_ma = gap_ma || m == 3 || m == 4; gap_so = gap_so || (9..=11).contains(&m); }
        }
        for &t in &dup_at { let m = month(t); dup_ma = dup_ma || m == 3 || m == 4; dup_so = dup_so || (9..=11).contains(&m); }
        dst = (gap_ma && dup_so) || (gap_so && dup_ma);
    }
    let mut label = o.label.clone();
    if label == "auto" {
        let (f, l) = (u[0].wall.rem_euclid(DAY), u[u.len() - 1].wall.rem_euclid(DAY));
        label = if f == dt && l == 0 { "end" } else { "start" }.to_string();
    }
    let mut s_out = Vec::with_capacity(u.len());
    for j in 0..u.len() {
        let rp = j > 0 && rate[j - 1];
        let rn = j < nd && rate[j];
        let dp = if j > 0 { d[j - 1] as f64 } else { 0.0 };
        let dn = if j < nd { d[j] as f64 } else { 0.0 };
        let t = u[j].t as f64;
        let before = if rp { dp } else if rn { dn } else { dt as f64 };
        let after = if rn { dn } else if rp { dp } else { dt as f64 };
        let (a, b) = match label.as_str() { "start" => (t, t + after), "end" => (t - before, t), _ => (t - before / 2.0, t + after / 2.0) };
        let mut s = Sample { a, b, v: u[j].v };
        convert(o, &mut s);
        s_out.push(s);
    }
    rep.set("rows", lines);
    rep.set("parsed", rows.len());
    rep.set("header_lines", header);
    rep.set("bad_rows", bad);
    rep.set("n_bad", n_bad);
    rep.set("duplicates", dups);
    rep.set("out_of_order", out_of_order);
    rep.set("interval_min", dt);
    rep.set("rate_changes", changes);
    rep.set("first", fmt_min(u[0].t));
    rep.set("last", fmt_min(u[u.len() - 1].t));
    rep.set("label", label);
    rep.set("date_order", if any_short { match order { b'd' => "dmy", b'm' => "mdy", _ => "ymd" } } else { "ymd" });
    rep.set("excel", excel);
    rep.set("dst_suspect", dst);
    rep.set("clock_skipped", skipped);
    Ok(s_out)
}

/// Local clock time to UTC with the zone's offsets. In the hour repeated at the end of daylight saving a stamp takes the
/// earlier period on its first occurrence and the later one on the next; a clock time skipped at the start of daylight saving
/// takes the offset before the change (counted in `skipped`).
fn clock_utc(o: &Opt, wall: i64, seen: &mut BTreeMap<i64, i32>, skipped: &mut i64) -> i64 {
    let k_n = o.at.len();
    let g = o.at.partition_point(|&x| x <= wall - o.off);
    let mut cand = [0i64; 3];
    let mut nc = 0;
    for k in g.saturating_sub(1)..=k_n.min(g + 1) {
        let u = wall - o.clk[k];
        if (k == 0 || u >= o.at[k - 1]) && (k == k_n || u < o.at[k]) { cand[nc] = u; nc += 1; }
    }
    if nc == 0 { *skipped += 1; return wall - o.clk[g.saturating_sub(1)]; }
    if nc == 1 { return cand[0]; }
    let c = seen.entry(wall).or_insert(0);
    let first = *c == 0;
    *c += 1;
    if first { cand[0] } else { cand[nc - 1] }
}
