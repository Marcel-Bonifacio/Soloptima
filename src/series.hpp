// Timestamped load and weather files as 8760 hourly values (time-weighted averaging, units, gap filling with a report), and
// data checks of the project's weather and load: timing against the sun, physical limits, stuck or copied values, outages,
// spikes, level shifts and units.
#pragma once
#include "json.hpp"
#include "model.hpp"
#include <string>

// CSV text of a logger or weather station as one year of hourly means. opt:
//   kind: load | weather
//   time_col: column of the timestamps; -1 = none: one row per interval in file order (8760/8784 hourly, 17520/17568
//     half-hourly, 35040/35136 quarter-hourly), starting on 1 January at 00:00. time2_col: column of the time of day when the
//     date and the time are in two columns (-1 = none).
//   load: cols[] (summed); weather: ghi, dni, dhi, tamb, wind (-1 = absent; ghi required)
//   date_order: auto | ymd | dmy | mdy. Excel serial days (1900 system) are read when the time column holds numbers from
//     20000 to 80000.
//   time_basis: utc | local_standard (utc_offset) | local_clock (clock: {start, changes: [[UTC minute, offset h], ...]}, the
//     zone's offsets; the repeated hour at the end of daylight saving takes the later offset on its second occurrence). Stamps
//     with Z or +hh:mm use their own offset whatever the basis.
//   label: auto | start | end | instant. A sample covers [t, t + dt), [t - dt, t) or [t - dt/2, t + dt/2); auto takes end when
//     the first stamp is one interval after midnight and the last at midnight, else start.
//   units (load): kw | w | mw | kwh_interval | mwh_interval; irradiance: w_m2 | wh_m2_interval | kwh_m2_interval |
//     mj_m2_interval; temperature: c | k; wind: m_s | km_h
//   year: auto (the year with most data) | a calendar year | last12 (load only: the last 365 days, each at its calendar
//     position). 29 February is dropped.
//   fill_long: load only, fill gaps over 72 h from adjacent weeks.
// Each hour is the time-weighted mean of the samples overlapping it, in the output time base: weather in UTC (utc basis) or
// local standard time (as imported), load always in local standard time. An hour covered less than half is missing. Weather
// gaps are filled by fill_gaps (a gap over 72 h is an error); load gaps of up to 3 h are interpolated, longer ones take the same
// hour a week earlier (a week later at the start). Returns {kw} or {ghi, dni, dhi, tamb, wind, is_utc, time_offset} with a
// report; a load gap over 72 h without fill_long returns {long_gap: {hours, from}, report} instead of the series. Throws
// std::runtime_error with a readable message for options, files or gaps it cannot use, and for a negative load (export).
json::Value import_series(const std::string& text, const json::Value& opt);

// Data checks of the project's weather and load (only: weather, load or empty for both). Weather hours are checked in the
// file's own time base with the sun at the start, middle and end of each hour; load hours in local standard time. Returns
// {weather, load}, each null without data, else {flags: [{id, label, hours, days, ghi_share}], set: [data-set notes],
// hours: the first 200 flagged hours [{i, h (local hour), flag, v}], n_flagged, days (local day indices), score (share of
// days without a flag)}, with timing (weather) and level shifts (load).
json::Value data_qc(const Project& p, const std::string& only = "");
