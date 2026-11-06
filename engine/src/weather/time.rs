//! ISO 8601 UTC times as whole hours since 1970-01-01T00:00 (proleptic Gregorian calendar, no OS time-zone calls).
use crate::calendar::{civil_from_days, days_from_civil};

/// A `sscanf` "%Nd": white space skipped, an optional sign, at most `width` characters in all, at least one digit
fn scan_int(b: &[u8], p: &mut usize, width: usize) -> Option<i64> {
    while *p < b.len() && matches!(b[*p], b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r') { *p += 1; }
    let start = *p;
    let mut neg = false;
    if *p < b.len() && (b[*p] == b'+' || b[*p] == b'-') { neg = b[*p] == b'-'; *p += 1; }
    let digits = *p;
    let mut v = 0i64;
    while *p < b.len() && *p - start < width && b[*p].is_ascii_digit() { v = v * 10 + i64::from(b[*p] - b'0'); *p += 1; }
    if *p == digits { *p = start; return None; }
    Some(if neg { -v } else { v })
}

/// Whole hours since 1970-01-01T00:00 UTC of "YYYY-MM-DDTHH[:MM[:SS]][Z]", i.e. the start of its hour; None for a malformed or
/// impossible date, for a time without the colon after the hour ("T0500") and for an offset from UTC.
pub fn iso_to_epoch_h(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    let mut p = 0;
    let y = scan_int(b, &mut p, 4)?;
    if b.get(p) != Some(&b'-') { return None; }
    p += 1;
    let mo = scan_int(b, &mut p, 2)?;
    if b.get(p) != Some(&b'-') { return None; }
    p += 1;
    let d = scan_int(b, &mut p, 2)?;
    if b.get(p) != Some(&b'T') { return None; }
    p += 1;
    let h = scan_int(b, &mut p, 2)?;
    if p < b.len() && b[p] != b':' && b[p] != b'Z' { return None; }   // e.g. T0500
    // minutes, seconds and a final Z may follow; an offset from UTC (+hh:mm, -hh:mm) may not
    if b[p..].iter().any(|&c| !c.is_ascii_digit() && c != b':' && c != b'.' && c != b'Z') { return None; }
    const MDAYS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    if y < 1 || !(1..=12).contains(&mo) || d < 1 || d > MDAYS[(mo - 1) as usize] + i64::from(mo == 2 && leap) || !(0..=23).contains(&h) { return None; }
    Some(days_from_civil(y as i32, mo as u32, d as u32) * 24 + h)
}

/// Inverse of `iso_to_epoch_h`: "YYYY-MM-DDTHH:00"
pub fn epoch_h_to_iso(h: i64) -> String {
    let days = h.div_euclid(24);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:00", h - days * 24)
}

/// "YYYY-MM-DDTHH:MM:SSZ" of Unix seconds
pub fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let r = secs - days * 86400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, r % 3600 / 60, r % 60)
}
