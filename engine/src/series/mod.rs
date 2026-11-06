//! Timestamped load and weather files as 8760 hourly values with an import report (src/series.cpp, `import_series`; the
//! options are documented in src/series.hpp). Session 2.2 holds the import (`import_series`), 2.3 the data checks (`data_qc`).
mod csv;
mod hours;
mod opts;
mod qc;
mod samples;

pub use qc::data_qc;

use crate::calendar::{civil_from_days, floor_div};
use crate::json::{Error, Value};
use crate::model::{month_of_day, MONTH_START};
use csv::DAY;

pub(crate) type R<T> = Result<T, Error>;
pub(crate) const MAX_COL: usize = 256;   // cells read per row
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

pub(crate) fn fail<T>(m: impl Into<String>) -> R<T> { Err(Error(m.into())) }

/// "2025-01-13 00:15" for minutes since 1970-01-01 00:00
pub(crate) fn fmt_min(t: i64) -> String {
    let day = floor_div(t, DAY);
    let r = t - day * DAY;
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", r / 60, r % 60)
}

/// "3 Mar 14:00" for hour h of a 365-day year
pub(crate) fn fmt_hour(h: usize) -> String {
    let d = (h / 24) as i32;
    let m = month_of_day(d) as usize;
    format!("{} {} {:02}:00", d - MONTH_START[m] + 1, MONTHS[m], h % 24)
}

/// CSV text of a logger or weather station as one year of hourly means; `opt` as documented in src/series.hpp. Returns
/// {kw} or {ghi, dni, dhi, tamb, wind, is_utc, time_offset} with a report, or {long_gap, report} for a load with a gap over 72 h.
pub fn import_series(text: &str, opt: &Value) -> R<Value> {
    let o = opts::parse_opt(opt)?;
    let head = csv::head_lines(text);   // as the import dialog previews them
    if head.is_empty() { return fail("The file is empty."); }
    let delim = csv::detect_delim(&head);
    let mut rep = Value::object();
    // output time base: load in local standard time, weather as imported (UTC for the utc basis, else local standard time)
    let shift = if o.load || o.basis != "utc" { o.off } else { 0 };
    let positional = o.time_col < 0;
    let s = if positional { samples::positional(text, delim, &o, shift, &mut rep)? } else { samples::timestamped(text, delim, &o, shift, &mut rep)? };
    rep.set("delimiter", (delim as char).to_string());
    hours::to_hours(&o, &s, &mut rep, if positional { 2001 } else { 0 })
}
