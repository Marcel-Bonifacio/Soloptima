// Open-access meteorological data: PVGIS (EU JRC), NASA POWER, and short-term forecasts
// (Open-Meteo, MET Norway) for the operational day-ahead schedule.
#pragma once
#include "json.hpp"
#include <limits>
#include <string>
#include <vector>

// Typical/historical year. source: pvgis_tmy | pvgis_year | nasa_power. Returns weather JSON (8760 h, UTC) with the period
// the data comes from in "years", the service in "api", the download time in "retrieved_utc", and the hours with a missing
// value filled in (n_filled; NASA POWER only) with the longest gap (max_gap_h).
json::Value fetch_weather(const std::string& source, double lat, double lon, int year);

// Every historical year from y0 to y1 for the inter-annual variability run. source: pvgis (2005-2023, PVGIS 5.3) |
// nasa_power (2001 to the last complete year). The range is clamped to the database. Returns {from, to, database, years: [weather JSON
// per year as fetch_weather returns it]}. Several years take one to three minutes to download.
json::Value fetch_weather_years(const std::string& source, double lat, double lon, int y0, int y1);

// One PVGIS seriescalc JSON response of one or several years split into one weather JSON per calendar year (29 Feb dropped).
json::Value pvgis_split_years(const json::Value& d, double lat, double lon);

// Short-term forecast. provider: open_meteo | met_norway. Returns hourly UTC series with ISO timestamps, the download time
// (issued_utc) and, from MET Norway, the time its model run was updated (model_updated_utc). The series end at the first
// hour without irradiance or temperature, and MET Norway averages each hour from the instants at its start and end.
json::Value fetch_forecast(const std::string& provider, double lat, double lon, int days, const std::string& api_key);

// Whole hours since 1970-01-01T00:00 UTC of an ISO 8601 UTC time "YYYY-MM-DDTHH[:MM[:SS]][Z]", i.e. the start of its hour
// (proleptic Gregorian calendar, no OS time-zone calls). NO_TIME_H for a malformed or impossible date.
constexpr long NO_TIME_H = std::numeric_limits<long>::min();
long iso_to_epoch_h(const std::string& iso);
// Inverse of iso_to_epoch_h: "YYYY-MM-DDTHH:00".
std::string epoch_h_to_iso(long h);
// Days since 1970-01-01 of a proleptic Gregorian date and back (Howard Hinnant's algorithms; no OS time-zone calls).
long days_from_civil(int y, unsigned m, unsigned d);
void civil_from_days(long z, int& y, unsigned& m, unsigned& d);

// Hourly series with missing values marked -999 (NASA POWER, imported weather files). Runs of up to 3 h are interpolated
// linearly between the hours around them; longer runs take the same hour of the previous day (of the next valid day at the
// start of the series). filled marks the hours changed, max_gap the longest run.
std::vector<double> fill_gaps(std::vector<double> v, std::vector<char>& filled, int& max_gap);

// PVGIS PVcalc reference yield of 1 kWp of free-standing crystalline silicon over the long-term average of the PVGIS
// radiation database: {ey, em[12]} in kWh/kWp, hi_y (in-plane irradiation, kWh/m2), radiation_db, year_min, year_max.
// loss_pct: system losses PVGIS applies as a plain factor. angle: tilt. aspect: azimuth in PVGIS terms (0 = south,
// -90 = east, 90 = west). tracker: horizontal north-south single axis (PVGIS inclined axis at 0 deg; angle and aspect unused).
json::Value pvgis_pvcalc(double lat, double lon, double loss_pct, double angle, double aspect, bool tracker);
int clear_yield_cache();   // the PVcalc answers kept in memory; returns how many were dropped

// HTTP(S) GET via libcurl (WinHTTP on Windows). Throws std::runtime_error on transport errors or non-2xx status.
std::string http_get(const std::string& url, const std::string& user_agent = "Soloptima/1.0");
