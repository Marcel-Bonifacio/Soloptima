//! Operational side of the forecast-based EMS (src/ems.cpp after the planner in sim/planner.rs): the day-ahead schedule on a live
//! weather forecast, and the Forecast Lab benchmark of every PV and load method with the fuel and cost each gives.
mod bench;
mod schedule;

pub use bench::forecast_benchmark;
pub use schedule::day_ahead_schedule;

use crate::{Error, Project};

/// Hour of the year (0-8759) of "YYYY-MM-DDTHH...", read like sscanf("%d-%d-%dT%d"); 29 February counts as the 28th. -1 when
/// the text does not scan or the day or hour is out of range. The month is clamped to 1-12.
pub fn hour_of_year_iso(iso: &str) -> i32 {
    let b = iso.as_bytes();
    let mut p = 0;
    let mut fields = [0i64; 4];
    for (k, sep) in [Some(b'-'), Some(b'-'), Some(b'T'), None].into_iter().enumerate() {
        match scan_d(b, &mut p) { Some(v) => fields[k] = v, None => return -1 }
        if let Some(c) = sep {
            if b.get(p) != Some(&c) { return -1; }
            p += 1;
        }
    }
    let [_, mo, mut d, h] = fields;
    if !(1..=31).contains(&d) || !(0..=23).contains(&h) { return -1; }
    if mo == 2 && d == 29 { d = 28; }
    let m = crate::sim::clamp(mo, 1, 12) as usize;
    ((i64::from(crate::MONTH_START[m - 1]) + d - 1) * 24 + h) as i32
}

/// A sscanf "%d": white space skipped, an optional sign, at least one digit (saturating instead of overflowing)
fn scan_d(b: &[u8], p: &mut usize) -> Option<i64> {
    while *p < b.len() && matches!(b[*p], b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r') { *p += 1; }
    let mut neg = false;
    if *p < b.len() && (b[*p] == b'+' || b[*p] == b'-') { neg = b[*p] == b'-'; *p += 1; }
    let digits = *p;
    let mut v = 0i64;
    while *p < b.len() && b[*p].is_ascii_digit() { v = v.saturating_mul(10).saturating_add(i64::from(b[*p] - b'0')); *p += 1; }
    if *p == digits { return None; }
    Some(if neg { -v } else { v })
}

/// The first 40 bytes of a text, for messages (shortened to the last whole character, where C++ may cut one in two)
pub(crate) fn clip(t: &str) -> &str {
    let mut n = t.len().min(40);
    while !t.is_char_boundary(n) { n -= 1; }
    &t[..n]
}

/// The checks the /api/ems/schedule route makes before it plans (src/main.cpp): the schedule indexes the load profile and
/// commits genset units, and the planner divides by the reserve duration.
pub fn schedule_checks(p: &Project) -> Result<(), Error> {
    let fail = |m: &str| Err(Error(m.into()));
    if p.load_kw.len() != crate::HOURS { return fail("Define the load profile first."); }
    if !(p.dg.unit_kw > 0.0 && p.dg.unit_kw.is_finite()) || p.dg.units < 0 {
        return fail("Genset unit rating must be above 0 kW and the number of units non-negative.");
    }
    if !(p.bess.reserve_duration_h > 0.0) { return fail("Battery reserve duration must be above 0 h."); }
    let w = &p.wind;
    if w.units > 0 && !(w.v_in < w.v_rated && w.v_rated < w.v_out) { return fail("Wind turbine speeds must satisfy cut-in < rated < cut-out."); }
    Ok(())
}

/// f(0..n) on up to `threads` threads, in index order; the first error (by index) wins
pub(crate) fn par_map<T: Send>(n: usize, threads: usize, f: impl Fn(usize) -> Result<T, Error> + Sync) -> Result<Vec<T>, Error> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut slots: Vec<Option<Result<T, Error>>> = (0..n).map(|_| None).collect();
    let done = std::sync::Mutex::new(&mut slots);
    std::thread::scope(|s| {
        for _ in 0..threads.clamp(1, n.max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= n { break; }
                let r = f(i);
                done.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
            });
        }
    });
    slots.into_iter().map(|r| r.expect("every index is run")).collect()
}
