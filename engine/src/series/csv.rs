//! CSV reading and timestamps of an import: delimiter, rows, numbers with decimal commas, and the many ways a logger writes a
//! time (src/series.cpp).
use super::opts::Opt;
use super::MAX_COL;
use crate::calendar::{days_from_civil, is_leap};
use crate::json::strtod_bytes;
use std::collections::BTreeMap;

pub const DAY: i64 = 1440;
const MDAYS: [i32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

fn is_space(c: u8) -> bool { matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r') }
fn trim(s: &[u8]) -> String {
    let a = s.iter().position(|&c| !is_space(c)).unwrap_or(s.len());
    let b = s.iter().rposition(|&c| !is_space(c)).map_or(a, |i| i + 1);
    String::from_utf8_lossy(&s[a..b.max(a)]).into_owned()
}

/// Delimiter of a CSV file, as csvDelimOf in web/js/util.js chooses it (so column numbers match its preview): of ';', tab and
/// ',', the one that splits most of the first 20 non-blank lines evenly (the same count on the most lines; ties in that order).
pub fn detect_delim(lines: &[&str]) -> u8 {
    let (mut best, mut top) = (b',', 0usize);
    for d in [b';', b'\t', b','] {
        let mut n: BTreeMap<usize, usize> = BTreeMap::new();
        for l in lines {
            let c = l.bytes().filter(|&b| b == d).count();
            if c > 0 { *n.entry(c).or_default() += 1; }
        }
        for &v in n.values() { if v > top { top = v; best = d; } }
    }
    best
}

/// The first 20 non-blank lines, as the import dialog previews them
pub fn head_lines(text: &str) -> Vec<&str> {
    let mut head = Vec::new();
    let mut p = if text.as_bytes().starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
    while p < text.len() && head.len() < 20 {
        let q = text[p..].find('\n').map_or(text.len(), |i| p + i);
        let l = &text[p..q];
        if l.bytes().any(|c| !is_space(c)) { head.push(l); }
        p = q + 1;
    }
    head
}

/// Calls f(line number, cells) for every non-blank line, split as parseCSV splits it: quoted fields may hold the delimiter,
/// "" is a literal quote, cells are trimmed. f returns false to stop.
pub fn for_rows(text: &str, delim: u8, mut f: impl FnMut(usize, &[String]) -> bool) {
    let t = text.as_bytes();
    let mut cells: Vec<String> = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut p = if t.starts_with(b"\xEF\xBB\xBF") { 3 } else { 0 };
    let mut no = 1;
    while p < t.len() {
        let q = t[p..].iter().position(|&c| c == b'\n').map_or(t.len(), |i| p + i);
        let e = if q > p && t[q - 1] == b'\r' { q - 1 } else { q };
        if t[p..e].iter().any(|&c| !is_space(c)) {
            cells.clear();
            cur.clear();
            let mut quoted = false;
            let mut i = p;
            while i < e {
                let ch = t[i];
                if quoted {
                    if ch == b'"' && i + 1 < e && t[i + 1] == b'"' { cur.push(b'"'); i += 1; }
                    else if ch == b'"' { quoted = false; }
                    else { cur.push(ch); }
                } else if ch == b'"' { quoted = true; }
                else if ch == delim { cells.push(trim(&cur)); cur.clear(); }
                else { cur.push(ch); }
                if cells.len() >= MAX_COL { break; }
                i += 1;
            }
            if cells.len() < MAX_COL { cells.push(trim(&cur)); }
            if !f(no, &cells) { return; }
        }
        p = q + 1;
        no += 1;
    }
}

/// A number filling the whole cell; with ';' as delimiter a decimal comma is read too ("12,5").
pub fn to_num(s: &str, comma: bool) -> Option<f64> {
    if s.is_empty() { return None; }
    let t = if comma && s.contains(',') && !s.contains('.') { s.replace(',', ".") } else { s.to_string() };
    let (v, n) = strtod_bytes(t.as_bytes())?;
    (n == t.len() && v.is_finite()).then_some(v)
}
pub fn cell_num(c: &[String], col: i32, comma: bool) -> Option<f64> {
    if col < 0 { return None; }
    c.get(col as usize).and_then(|s| to_num(s, comma))
}

/// A time cell split into its parts before the date order is known.
#[derive(Default, Clone)]
pub struct RawTime {
    /// Excel serial day number (1900 date system)
    pub serial: bool,
    pub days: f64,
    /// date fields in file order, and their digit counts
    pub f: [i32; 3],
    pub n: [usize; 3],
    /// minute of the day (1440 for 24:00)
    pub mod_: i32,
    /// explicit offset from UTC (Z, UTC, +hh:mm)
    pub tz: bool,
    pub tz_min: i32,
}

fn read_int(b: &[u8], p: &mut usize, maxd: usize) -> Option<(i32, usize)> {
    let (mut v, mut n) = (0i32, 0usize);
    while *p < b.len() && n < maxd && b[*p].is_ascii_digit() { v = v * 10 + i32::from(b[*p] - b'0'); *p += 1; n += 1; }
    (n > 0).then_some((v, n))
}
fn skip_sp(b: &[u8], p: &mut usize) { while *p < b.len() && b[*p] == b' ' { *p += 1; } }
fn upper_is(b: &[u8], p: usize, w: &str) -> bool { b.len() >= p + w.len() && b[p..p + w.len()].eq_ignore_ascii_case(w.as_bytes()) }

/// "H:MM", "HH:MM:SS(.fff)" or compact "HHMM", with an optional AM/PM, rounded to the minute.
pub fn parse_clock(b: &[u8], p: &mut usize, compact: bool) -> Option<i32> {
    let (mut h, nh);
    let m;
    let mut s = 0.0;
    if compact {
        (h, nh) = read_int(b, p, 2)?;
        if nh != 2 { return None; }
        let (mm, nm) = read_int(b, p, 2)?;
        if nm != 2 { return None; }
        m = mm;
    } else {
        (h, _) = read_int(b, p, 2)?;
        if *p >= b.len() || b[*p] != b':' { return None; }
        *p += 1;
        let (mm, nm) = read_int(b, p, 2)?;
        if nm != 2 { return None; }
        m = mm;
        if *p < b.len() && b[*p] == b':' {
            *p += 1;
            let (si, ns) = read_int(b, p, 2)?;
            if ns != 2 { return None; }
            s = f64::from(si);
            if *p < b.len() && b[*p] == b'.' {
                let mut f = 0.1;
                *p += 1;
                while *p < b.len() && b[*p].is_ascii_digit() { s += f64::from(b[*p] - b'0') * f; f /= 10.0; *p += 1; }
            }
        }
    }
    let mut q = *p;
    skip_sp(b, &mut q);
    if (upper_is(b, q, "AM") || upper_is(b, q, "PM")) && (q + 2 == b.len() || !b[q + 2].is_ascii_alphabetic()) {
        if !(1..=12).contains(&h) { return None; }
        h = h % 12 + if b[q].to_ascii_uppercase() == b'P' { 12 } else { 0 };
        *p = q + 2;
    }
    if m > 59 || s >= 61.0 || h > 24 || (h == 24 && (m > 0 || s > 0.0)) { return None; }
    Some((f64::from(h * 60 + m) + s / 60.0).round() as i32)
}

/// Optional offset after the time: Z, UTC or GMT, and/or +hh[:mm] / -hhmm; nothing may follow.
pub fn parse_tz(b: &[u8], p: &mut usize, r: &mut RawTime) -> bool {
    skip_sp(b, p);
    if *p < b.len() && (b[*p] == b'Z' || b[*p] == b'z') { r.tz = true; *p += 1; }
    else if upper_is(b, *p, "UTC") || upper_is(b, *p, "GMT") { r.tz = true; *p += 3; }
    if *p < b.len() && (b[*p] == b'+' || b[*p] == b'-') {
        let sign = if b[*p] == b'-' { -1 } else { 1 };
        *p += 1;
        let Some((h, nh)) = read_int(b, p, 2) else { return false };
        if nh != 2 { return false; }
        if *p < b.len() && b[*p] == b':' { *p += 1; }
        let mut m = 0;
        if *p < b.len() && b[*p].is_ascii_digit() {
            match read_int(b, p, 2) { Some((v, 2)) => m = v, _ => return false }
        }
        if h > 14 || m > 59 { return false; }
        r.tz = true;
        r.tz_min = sign * (h * 60 + m);
    }
    skip_sp(b, p);
    *p == b.len()
}

/// Splits a time cell: Excel serial days, "2025-01-13T00:15:00+08:00", "2025/1/13 0:15", "13.01.2025 00:15",
/// "1/13/2025 12:15 AM", PVGIS "20250113:0010" or a date alone.
pub fn split_time(s: &str, comma: bool) -> Option<RawTime> {
    let b = s.as_bytes();
    let e = b.len();
    let mut r = RawTime::default();
    let mut p = 0;
    let compact = e >= 8 && b[..8].iter().all(u8::is_ascii_digit);
    if compact && (e == 8 || !b[8].is_ascii_digit() || e == 12) {
        let num = |a: usize, n: usize| s[a..a + n].parse::<i32>().unwrap_or(0);
        r.f = [num(0, 4), num(4, 2), num(6, 2)];
        r.n = [4, 2, 2];
        p = 8;
        if p < e && matches!(b[p], b':' | b'T' | b' ') { p += 1; }
        if p < e && b[p].is_ascii_digit() {
            let colon = e - p >= 3 && b[p + 2] == b':';
            r.mod_ = parse_clock(b, &mut p, !colon)?;
        }
        return parse_tz(b, &mut p, &mut r).then_some(r);
    }
    if let Some(x) = to_num(s, comma) {
        if !(20000.0..=80000.0).contains(&x) { return None; }
        r.serial = true;
        r.days = x;
        return Some(r);
    }
    let mut sep = 0u8;
    for k in 0..3 {
        let (v, n) = read_int(b, &mut p, 4)?;
        r.f[k] = v;
        r.n[k] = n;
        if k == 2 { break; }
        if p >= e || !matches!(b[p], b'-' | b'/' | b'.') || (sep != 0 && b[p] != sep) { return None; }
        sep = b[p];
        p += 1;
    }
    if p < e && matches!(b[p], b'T' | b' ' | b',') { p += 1; skip_sp(b, &mut p); }
    if p < e && b[p].is_ascii_digit() { r.mod_ = parse_clock(b, &mut p, false)?; }
    parse_tz(b, &mut p, &mut r).then_some(r)
}

/// Wall-clock minutes since 1970 of a split time with the date order resolved (y, d or m); None for an impossible date.
pub fn wall_minutes(r: &RawTime, order: u8) -> Option<i64> {
    if r.serial {   // days since 1899-12-30, which absorbs Excel's phantom 29 February 1900
        let whole = r.days.floor();
        return Some((days_from_civil(1899, 12, 30) + whole as i64) * DAY + ((r.days - whole) * DAY as f64).round() as i64);
    }
    let (mut y, m, d, ny) = if r.n[0] >= 3 || order == b'y' { (r.f[0], r.f[1], r.f[2], r.n[0]) }
        else if order == b'd' { (r.f[2], r.f[1], r.f[0], r.n[2]) }
        else { (r.f[2], r.f[0], r.f[1], r.n[2]) };
    if ny <= 2 { y += if y < 70 { 2000 } else { 1900 }; }
    if !(1900..=2200).contains(&y) || !(1..=12).contains(&m) || d < 1 || d > MDAYS[(m - 1) as usize] + i32::from(m == 2 && is_leap(y)) { return None; }
    Some(days_from_civil(y, m as u32, d as u32) * DAY + i64::from(r.mod_))
}

/// The time of a row: the time cell, plus the time-of-day cell when the time is in its own column ("HH:MM" or an Excel day fraction).
pub fn row_time(c: &[String], o: &Opt, comma: bool) -> Option<RawTime> {
    let mut r = split_time(c.get(o.time_col as usize)?, comma)?;
    if o.time2_col < 0 { return Some(r); }
    let s = c.get(o.time2_col as usize)?;
    let b = s.as_bytes();
    let m = match to_num(s, comma) {
        Some(x) if (0.0..1.0).contains(&x) => (x * DAY as f64).round() as i32,
        _ => {
            let mut p = 0;
            let m = parse_clock(b, &mut p, false)?;
            if !parse_tz(b, &mut p, &mut r) { return None; }
            m
        }
    };
    if r.serial { r.days += f64::from(m) / DAY as f64; } else { r.mod_ += m; }
    Some(r)
}
