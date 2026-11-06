//! Civil dates as day counts (Howard Hinnant's algorithms, as src/weather.cpp), and the gap filling of hourly weather.

pub fn is_leap(y: i32) -> bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }

/// Days since 1970-01-01 of a proleptic Gregorian date
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(y) - i64::from(m <= 2);
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = i64::from((153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// (year, month 1-12, day) of a day count
pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((yoe + era * 400) as i32 + i32::from(m <= 2), m, d)
}

pub fn floor_div(a: i64, b: i64) -> i64 { a.div_euclid(b) }

/// Hourly series with missing values marked -999 (NASA POWER, imported weather files). Runs of up to 3 h are interpolated
/// linearly between the hours around them; longer runs take the same hour of the previous day (of the next valid day at the
/// start of the series). `filled` marks the hours changed, `max_gap` the longest run.
pub fn fill_gaps(mut v: Vec<f64>, filled: &mut Vec<bool>, max_gap: &mut i32) -> Vec<f64> {
    let missing = |x: f64| x <= -990.0;
    let n = v.len();
    if filled.len() < n { filled.resize(n, false); }
    let mut a = 0;
    while a < n {
        if !missing(v[a]) { a += 1; continue; }
        let mut b = a;
        while b < n && missing(v[b]) { b += 1; }
        *max_gap = (*max_gap).max((b - a) as i32);
        for i in a..b {
            filled[i] = true;
            if b - a <= 3 && a > 0 && b < n {
                v[i] = v[a - 1] + (v[b] - v[a - 1]) * (i - a + 1) as f64 / (b - a + 1) as f64;
            } else if i >= 24 {
                v[i] = v[i - 24];
            } else {
                let mut j = i + 24;
                while j < n && missing(v[j]) { j += 24; }
                v[i] = if j < n { v[j] } else { 0.0 };
            }
        }
        a = b;
    }
    v
}
