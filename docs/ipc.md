# Desktop shell and IPC contract

The desktop app is a Tauri 2 shell (`src-tauri/`) around the engine. This file is the contract: how the shell reaches the
engine, and one Tauri command per route of the version 1 engine (the `/api/*` names in the tables are only the old route names).

## How the engine is linked (since session 2.12)

The engine is the Rust crate `soloptima-engine` (`engine/`), a plain dependency of the shell. `engine::api::Engine` holds
the app's state (data folder, weather service and its caches, the job table) and has one method per command below, each
answering the command's JSON text. The shell keeps one `Arc<Engine>` (`src-tauri/src/engine.rs`); `commands.rs` runs each
method on a blocking thread and turns a panic into an internal error.

Version 1 had a C++ engine; it is gone. The
fixtures in `engine/tests/fixtures/` were written by it; the generators are in the git history before session 2.12
(`tests/gen_*_fixtures.cpp`, built against `src/`).

The command line is the engine's binary `soloptima` (`engine/src/bin/soloptima.rs`): `cargo build --release -p
soloptima-engine`, then `target/release/soloptima simulate|optimize project.json [out.json]`. Usage, messages, exit codes
and output are those of the C++ program; on web/examples/example_study.json both answers equal the C++ engine's to the byte
(main's C++ built with `-ffp-contract=off`; its default `make` build fuses multiply-adds on arm64 and differs in the last
digits of some figures, see the series section below).

## State after session 1.2

- The engine has no network port. The window loads `web/` from Tauri's own asset protocol (`frontendDist`) and reaches
  the engine only through Tauri commands, which are methods of `engine::api::Engine`.
- The interface calls them through `ui/src/lib/ipc.js` (`call(command, args)`). Without Tauri (a plain browser) every
  call fails with a message to start the app.
- The page's browser storage now lives under the Tauri origin, so values kept by session 1.1 builds (port 47817) are not
  carried over. Profiles and projects are in the data folder and are unaffected.
- One copy runs per user (`tauri-plugin-single-instance`), unless `--data DIR` is given (tests, a second profile).

## State after session 1.3

- Updates: `tauri-plugin-updater` reads `latest.json` of the latest GitHub release. `update.rs` holds `RELEASE_KEYS`
  (the two minisign keys), picks the key by the signature's key id, refuses unknown keys before downloading, and has the
  plugin require the signed `version:` in the trusted comment (`requireSignedVersion`). A build made with
  `SOLOPTIMA_TEST_RELEASE_KEY` set also trusts that key, reads `SOLOPTIMA_UPDATE_URL` and accepts plain http (tests only).
- The C++ updater, signature check, SHA-256 and Monocypher are gone from `src/`.
- Bundles: `packaging/bundle.sh` (dmg + app tarball, NSIS per-user, AppImage + deb) and `packaging/sign.sh` (signatures,
  `latest.json`, and the signed `SHA256SUMS.txt` that 1.x copies need to update to 2.x).

## State after session 3.1

- The top bar, sign-in, profiles, the landing page, settings, updates and the legal texts are Svelte (`ui/`, built into
  `web/ui/app.js` by `npm --prefix ui run build`). They call the commands below through `ui/src/lib/ipc.js`.
  How the two share the page, and the pattern for the next screens: `docs/ui.md`.

## Rules for the commands

- Name: the route path after `/api/`, with `/` and `-` as `_`: `/api/project/delete` is `project_delete`,
  `/api/forecast-weather` is `forecast_weather`. `GET /api/project` and `POST /api/project` become `project_load` and
  `project_save`; likewise `user_create`, `report_load`, `report_save`.
- Arguments: query parameters become named arguments (`user`, `id`, `doc`), all optional (a new project has no `id`); a
  JSON body is passed as one argument `body` (`serde_json::Value`). The interface keeps sending the bodies it sends today,
  so `users_terms`, `settings_data_dir` and the like take their fields from `body`, not from the query.
- Result: `Result<tauri::ipc::Response, ApiError>`: the engine's JSON text as it is, so large results are not parsed twice
  (`legal` answers a plain string).
- Errors: `ApiError { error: String, internal: bool }` (`engine::api`), serialised as `{"error": ..., "internal": true}`.
  `internal` marks defects (the interface files a bug report): a panic in the engine, a failure of the data folder itself
  ("Cannot use the data folder: ..."), a missing legal document. The C++ router marked filesystem and logic errors so.
- Bodies arrive as `serde_json::Value` (Tauri parses the invoke payload) and become the engine's `Value`. serde_json has
  `float_roundtrip` on, so every number is read correctly rounded, as the engine's own parser (and the command line) read it.
- Long runs stay jobs: the command answers `{"job": id}` at once; the page polls `job` and may call `job_cancel`.
  (A Tauri `Channel` for progress is a later improvement, not part of the port.)
- Commands are `async` and run the engine on a blocking thread (`tauri::async_runtime::spawn_blocking`), so a long call
  never blocks the window.
- The interface reaches them through `call(command, args)` in `ui/src/lib/ipc.js`. The engine commands are `src-tauri/src/commands.rs` (one macro line each, calling `engine::api`); the
  system's own features are in `src-tauri/src/native.rs`.
- Only the interface's own origin may invoke commands (capability `default`, local URLs only). No remote URL gets IPC.

## Commands

Query parameters in brackets. "body" is the request body as today. J = answers `{"job": id}`.

| Route | Command | Arguments | Notes |
|---|---|---|---|
| `GET /api/info` | `info` | | data and reports folders, version, os, arch, app |
| `GET /api/legal` | `legal` | `doc`: license, terms, notices | text, not JSON |
| `GET /api/users` | `users` | | |
| `POST /api/users` | `user_create` | body | |
| `POST /api/users/terms` | `users_terms` | `id`, `version` | |
| `POST /api/users/update` | `users_update` | `id`, body | |
| `POST /api/users/delete` | `users_delete` | `id` | |
| `GET /api/settings` | `settings` | | |
| `POST /api/settings/update` | `settings_update` | body: `auto`, `skip`, `checked`, `latest` | |
| `POST /api/settings/data-dir` | `settings_data_dir` | `path`, `mode` | |
| (was `POST /api/settings/pick-folder`) | `settings_pick_folder` | | Tauri dialog plugin; the engine has no route |
| `POST /api/cache/clear` | `cache_clear` | | |
| `GET /api/update/check` | `update_check` | | shell (`update.rs`, Tauri updater) since 1.3 |
| `POST /api/update/download` | `update_download` | | shell; resolves when downloaded and verified |
| `GET /api/update/progress` | `update_progress` | | shell; `{progress, total}` bytes of the running download |
| `POST /api/update/install` | `update_install` | | shell; `{mode: replaced}`, then restarts. On Windows the setup program takes over and the app exits inside the call, so the page says so before calling |
| `GET /api/projects` | `projects` | `user` | |
| `GET /api/project` | `project_load` | `user`, `id` | raw JSON text |
| `POST /api/project` | `project_save` | `user`, `id`, body: `project`, `meta` | |
| `POST /api/project/delete` | `project_delete` | `user`, `id` | |
| `POST /api/project/duplicate` | `project_duplicate` | `user`, `id` | |
| `GET /api/reports` | `reports` | | bug and feedback reports |
| `GET /api/report` | `report_load` | `id` | raw JSON text |
| `POST /api/report` | `report_save` | body: `report`, `markdown` | 24 MB limit stays |
| `POST /api/report/delete` | `report_delete` | `id` | |
| `POST /api/weather` | `weather` | body: `source`, `lat`, `lon`, `year` | |
| `POST /api/horizon` | `horizon` | body: `lat`, `lon` | |
| `POST /api/forecast-weather` | `forecast_weather` | body: `provider`, `lat`, `lon`, `days`, `api_key` | |
| `POST /api/import-series` | `import_series` | body: `text`, `options` | 64 MB limit stays |
| `POST /api/data-qc` | `data_qc` | body: `project`, `only` | |
| `POST /api/pv` | `pv` | body (project with weather) | |
| `POST /api/pv-reference` | `pv_reference` | body (project with weather) | |
| `POST /api/tilt-scan` | `tilt_scan` | body (project with weather) | |
| `POST /api/forecast/benchmark` | `forecast_benchmark` | body: `project`, `with_value` | |
| `GET /api/forecast/methods` | `forecast_methods` | | |
| `POST /api/batch` | `batch` | body: `project`, `cases` | one case per `{overrides: {dotted path: value}}`; used by the operating options, the tornado, the design variants and the script console |
| `POST /api/simulate` | `simulate` | body (project) | |
| `POST /api/ems/schedule` | `ems_schedule` | body: `project`, `forecast`, `soc_now`, `load_scale`, `now_utc`, `days` | |
| `POST /api/optimize` | `optimize` | body: `project`, `optimizer` | J |
| `POST /api/resource-years` | `resource_years` | body: `project`, `source`, `from`, `to`, `budget` | J |
| `GET /api/job` | `job` | `id` | `{done, progress, total}` or `{done, result}` / `{done, error}` |
| `POST /api/job/cancel` | `job_cancel` | `id` | |

Routes that ended with the HTTP server in session 1.2: `POST /api/shutdown` (now `quit_ready`), `GET /api/health` and
`POST /api/session` (no equivalent: there is no socket and no key).

## Native commands (`src-tauri/src/native.rs`)

Replace the message bridge of the three C++ windows (`Native.call` of v1).

| Command | Arguments | Notes |
|---|---|---|
| `save_file` | raw bytes as the request body, header `x-name` (URI-encoded file name) | system Save dialog, then the file; `{path}` or `{cancelled}` |
| `print_report` | `html` | shown in a window of its own with no app access and a no-script, no-network content policy, then the system print dialog |
| `open_url` | `url` | http, https or mailto only; the page also routes all external `<a>` clicks here, and the window refuses to navigate away from the app |
| `open_folder` | `which`: `data` or `reports` | file manager, only the two folders the engine reports |
| `settings_pick_folder` | | folder dialog, `{path}` (empty when cancelled) |
| `quit_ack`, `quit_ready`, `quit_cancel` | | quit protocol below |

Quit with save: closing the window or Quit (Cmd+Q) is intercepted; the shell emits the event `quit-request`. The page
answers `quit_ack` at once, saves, then `quit_ready` (the app exits) or `quit_cancel` (a save failed, the window stays).
A page that does not acknowledge within 5 s does not hold the window open; after the acknowledgement it has 120 s.

## The Rust engine (phase 2)

`engine/` is the workspace crate `soloptima-engine`. Session 2.1 holds the project model (`model.rs`), the JSON value with
the C++ engine's leniency and writer (`json.rs`), the document-to-model parse (`parse.rs`, `layout.rs`) and the checks
(`validate.rs`). Since session 2.12 the app uses only this engine.

- A document is saved as `Value::dump()`: compact, keys sorted, numbers as the C++ writer prints them. Loading and saving
  the example project gives the bytes the C++ engine writes (`engine/tests/model.rs`).
- `validate_project` returns the C++ messages. Expected results come from the C++ engine itself:
  `engine/tests/fixtures/*.json` are written by `tests/gen_model_fixtures.cpp`.
- Known differences: a lone surrogate escape in a string is read as U+FFFD (C++ keeps invalid bytes); hexadecimal floats
  are not read; `serde` output of a layout area with an unset (NaN) tilt is `null`, which does not read back, so the
  document, not the struct, is what is saved.

### Series import and data checks (sessions 2.2 and 2.3)

`series/` holds `import_series` (CSV, time stamps, intervals, hourly means, gap filling; `opts.rs`, `csv.rs`, `samples.rs`,
`hours.rs`) and `data_qc` (`qc.rs`). `solar.rs` has the sun position and Haurwitz clear sky they use; session 2.5 extends it.
`calendar.rs` has the civil-date and gap-fill helpers of `src/weather.cpp`.

- Tests: `engine/tests/series_import.rs` (45 files, built in the test, answered as the C++ engine answers) and
  `series_qc.rs` (16 projects). Expected results are `fixtures/import.json` and `fixtures/qc.json`, written by
  `tests/gen_series_fixtures.cpp` and `tests/gen_qc_fixtures.cpp`; the results match to the byte.
- Compile the generators with `-ffp-contract=off`. Clang on arm64 fuses `a*b + c` into one rounding; Rust never does.
  A fused sum differs in the last digit, so the C++ engine itself gives slightly different hourly means on arm64 and x86-64.
- Two Rust habits that change bytes, avoided in the port: an `f64` iterator `sum()` starts at -0.0 (the C++ sum starts at +0),
  and `f64::max(0.0, x)` may return -0.0 (`std::max(0.0, x)` returns +0). Later ports of sums and clamps need the same care.
- Differences: hexadecimal floats are not read in cells; a file must be valid UTF-8.

### Weather services (session 2.4)

`engine/src/weather/` ports src/weather.cpp: PVGIS (typical year, hourly series, PVcalc with its cache, terrain horizon), NASA
POWER, Open-Meteo and MET Norway forecasts, `iso_to_epoch_h` / `epoch_h_to_iso` (`Option` instead of `NO_TIME_H`), and the
validation of the responses. `WeatherService` owns an `Http` trait object and the clock: `UreqHttp` for the network (120 s,
64 MB, gzip, redirects followed by hand and never from https down to http), `MockHttp` for saved responses, so nothing in the
tests touches the network. `parallel_map` is the 3-thread download of several years.

- `engine/tests/weather.rs` builds 34 synthetic responses (the generator of `tests/gen_weather_fixtures.cpp` does the same) and
  compares the answer, the requests made and each response with what src/weather.cpp gives. The C++ run replaces `http_get`
  with a fake: the generator's header shows how.
- The one that cannot be compared with the C++ engine is `fetch_horizon`, which lives in the `/api/horizon` route of
  src/main.cpp; its test checks the turn to north by hand.

### Finance (session 2.9)

`engine/src/finance/` ports src/finance.cpp (`params.rs`, `compute.rs`, `report.rs`) and the cash-flow measures `npv`, `irr`,
`payback` of src/sim.cpp (`cashflow.rs`). NPC and the simulation's own LCOE belong to the simulation (sessions 2.7-2.8); the
levelised values of the finance (LCOE, LPPA, PLN tariff) are here.

- Beyond the port: `debt.rs` schedules a loan paid in semi-annual, quarterly or monthly periods or in another currency,
  `fx.rs` the exchange rate path and its sensitivity shocks, `flip.rs` the partnership flip (model `flip`). With their
  defaults the answer is the port's to the byte. When on, the answer adds: `periods` (one object per debt period: `period`,
  `year`, `month`, `cfads`, `interest`, `principal`, `debt_service`, `debt_balance`, `debt_balance_fx`, `dsra`, `dscr`),
  `metrics.debt_periods` and `metrics.dscr_min_period`; `fx_currency`, `fx_sensitivity` (per shock: `shock`, `fx_rate_y1`,
  `equity_irr`, `project_irr`, `equity_npv`, `dscr_min`, and for the flip `sponsor_irr`, `te_irr`), the year fields
  `fx_rate`, `fx_loss`, `debt_balance_fx` and `metrics.fx_rate_cod`, `fx_rate_end`, `debt_in_fx`, `tariff_y1_fx`; for the
  flip the year fields `tax_credits`, `distributable`, `te_cash`, `te_tax`, `te_cf`, `sponsor_cash`, `sponsor_tax`,
  `sponsor_cf`, `te_cash_share` and `metrics.te_irr`, `sponsor_irr`, `te_npv`, `sponsor_npv`, `te_investment`,
  `sponsor_investment`, `itc`, `tax_credits_total`, `flip_year` (null when not reached). `engine/tests/finance_ext.rs`
  checks them against values worked out by hand.
- The finance reads `FinSim` / `FinYear`: the year fields it uses and the capex of the new assets. `SimResult::fin_sim()`
  (sessions 2.7-2.8) converts a simulation into it.
- `engine/tests/finance.rs` runs 38 finance blocks (all structures, sizing and repayment modes, taxes, solver, parse limits) on
  a synthetic simulation and compares hash and metrics with the C++ engine; `tests/gen_finance_fixtures.cpp` makes the fixture.
- Found on the way: `std::pow(x, int)` is the libm `pow`, Rust `powi` is repeated multiplication and differs in the last digit.
  Use `powf` for every `std::pow`. `pv_degradation_factor` (model.rs) had `powi` and is fixed.

### Dispatch, battery and fuel (sessions 2.7-2.8)

`engine/src/sim/` ports src/sim.{hpp,cpp}, src/fuel.hpp and the planner of src/ems.cpp: the hourly dispatch over the project
years (`dispatch.rs`: genset commitment with spinning reserve and minimum loading, battery efficiency, self-discharge, SOH
calendar and cycle fade, replacement; strategies load_following, cycle_charging, predictive), the economics and `compare`
(`econ.rs`), `FuelTable` (`fuel.rs`), the DP `Planner` (`planner.rs`), `result_to_json` / `comparison_to_json` (`out.rs`).

- The simulation does not know the PV types: `SimInput` carries the hourly AC output per kWp and the output per wind turbine as
  plain series: `pv::compute_pv_profile(p)?.ac_per_kwp` and `pv::wind_per_turbine(p)?`. Auxiliary loads use the PV module's
  `local_shift` / `put_local`.
- Forecasts come in as a `Forecast` trait object (`SimInput::forecast`, shared across runs such as the optimiser's candidates).
  When it is None and the strategy is predictive or the hourly series are kept, `simulate` builds `forecast::Forecaster` from
  `p.ems` on `pv_cs_per_kwp` (the clear-sky reference), as the C++ engine does. `PerfectForecast` is a light stand-in for the
  "perfect" method.
- `engine/tests/sim_parity.rs` runs 14 cases (each strategy, fast mode, load growth, ageing and replacement, auxiliary loads at
  a half-hour UTC offset, linear fuel, battery reserve, wind, unmet load) on the example project with perfect forecasts. The
  Rust PV and wind profiles equal the C++ ones to the bit, and the simulation on them matches the C++ `result_to_json` (hourly
  series included) to the byte, as do `compare` and the project finance on the results. `tests/gen_sim_fixtures.cpp` makes the
  fixture. The C++ `json::Value` copies share their objects: copy by parsing again.
- `std::min`, `std::max`, `std::clamp` are ported as `mn`, `mx`, `clamp` in sim/mod.rs, which keep the C++ argument order
  (signed zeros, NaN); `f64::max` and `f64::clamp` do not, and `f64::clamp` panics when the bounds cross.

### Forecasting and EMS (session 2.11)

`engine/src/forecast/` ports src/forecast.{hpp,cpp}: `SeriesForecaster` (the 10 PV and 11 load methods, `series.rs`), the MLP
(`mlp.rs`), `Forecaster` (PV, load, wind; implements the sim's `Forecast`) and the method lists (`mod.rs`).

- The noisy and MLP methods draw random numbers. `rng.rs` reproduces libc++ exactly: `std::mt19937`, `normal_distribution`
  (Marsaglia polar, the second value kept), `uniform_int_distribution` (lowest bits of one draw, rejected until in range),
  `generate_canonical` (two draws) and `std::shuffle`. The fixtures come from libc++ (macOS); libstdc++ or MSVC would give
  other sequences.
- Optimised macOS builds merge sin and cos of one angle into `__sincos_stret`, which differs from separate calls in the last bit
  for some angles. The MLP inputs call it directly (`sin_cos` in mlp.rs), so debug and release builds both match the C++ engine.
- `engine/tests/forecast_parity.rs`: every method on the example project (forecasts at leads 0-47 h for every hour), the wind
  forecaster, an unknown method, and the predictive dispatch on six forecaster pairs (with wind, noise, firm commitment) match
  the C++ engine to the byte; `tests/gen_forecast_fixtures.cpp` makes the fixture.


`engine/src/ems/` ports the rest of src/ems.cpp: `day_ahead_schedule` (`schedule.rs`) and `forecast_benchmark` (`bench.rs`),
with `hour_of_year_iso` and the helpers in `mod.rs`. Both return `Result<Value, Error>` with the C++ messages.

- `day_ahead_schedule(p, s, forecast, soc_now, load_scale, now_utc, max_hours)` first runs `schedule_checks(p)`, the checks the
  `/api/ems/schedule` route of src/main.cpp makes before it calls the C++ function (load profile present, genset rating,
  reserve duration, turbine speeds). They sit in the function because the schedule indexes the load profile, which would
  panic in Rust. Reading the request (`soc_now`, `load_scale`, `now_utc`, `days` x 24 hours) stays with the route.
- `forecast_benchmark(p, with_value)` does not validate the project; the route calls `validate_project` first, as in C++. The
  value runs pass `wind_per_turbine(p)` and the clear-sky reference to `simulate`, which builds each run's `Forecaster`.
- `engine/tests/ems_parity.rs` compares with `fixtures/ems.json` (`tests/gen_ems_fixtures.cpp`): 15 schedules on the example
  project (Open-Meteo and MET Norway stamps, `issued_utc` for the current time, no current time, `max_hours`, 29 February, a
  null irradiance, irradiance shorter than the times, wind turbines and a null wind, split DHI/DNI, +5.5 h and -9.5 h UTC
  offsets, no battery, a fractional time offset, the year end) and 13 errors, all matching to the byte and to the message; and
  the benchmark without and with the value runs (also with turbines), matching to the byte. The two value cases take about
  20 s each in a debug build and run only in release (`cfg_attr(debug_assertions, ignore)`).
- `engine/tests/ems.rs` ports the predictive part of section 3 on the project's own forecasters, the auxiliary-load and
  schedule parts of section 19 and section 20 of tests/test_engine.cpp.
- Difference: messages show the first 40 bytes of a bad timestamp; where that would cut a UTF-8 character in two, Rust stops
  before it (C++ keeps the broken bytes).

### Optimiser (session 2.10)

`engine/src/optimizer/` ports src/optimizer.{hpp,cpp} and `run_batch` of src/main.cpp: `OptSettings` and `parse_opt_settings`,
`Progress` (atomic counters and the cancel flag) and `optimize` (`mod.rs`), the candidate check and score and the sensitivity
inputs (`eval.rs`), the baseline and the grid with Hooke-Jeeves pattern search (`search.rs`), PSO, MOPSO and SHO-QAO-GOA
(`meta.rs`), and `run_batch` with dotted override paths (`batch.rs`).

- Candidates are simulated in parallel with rayon (`OptSettings::threads`, 0 = all cores, in a pool of its own). Every result
  goes to the slot of its index and the reductions run in order afterwards, so the answer does not depend on the thread count.
- The metaheuristics draw from `forecast::rng::Mt19937::uniform` (libc++ `uniform_real_distribution<double>(0, 1)`), in the
  C++ order: the two random factors of a velocity update left to right, as clang evaluates them.
- `std::sort` is not stable. SHO-QAO-GOA ranks agents whose fitness ties (two agents of the same rounded size), and from 24
  elements libc++ partitions, so `cxxsort.rs` ports the libc++ introsort (LLVM 17+, the macOS SDK) and every `std::sort` of
  the optimiser uses it. Rust's own sort fails the 30-agent fixture. The heap-sort fallback after 2 log2(n) bad pivots is not
  ported (the port keeps sorting by insertion there).
- The output per wind turbine is computed once (when the project or the search can have turbines, or the EMS is predictive)
  and serves every candidate and sensitivity run; no sensitivity variable changes it.
- `engine/tests/optimizer_parity.rs` compares with `fixtures/opt.json` (`tests/gen_opt_fixtures.cpp`): 11 optimizer blocks
  through `parse_opt_settings` (defaults from the load and PV yield, limits, the sensitivity messages), 18 runs on the example
  project (grid with C-rates, constraints, objectives lcoe and re, an infeasible box, sensitivity in all-years and fast mode,
  predictive EMS, wind units; PSO over C-rates and turbine counts; SHO-QAO-GOA up to 30 agents and 20 iterations; MOPSO with
  re and SSSI), also on one thread, and a batch of 10 cases (sizes, finance, own PV, wind, predictive, a 9-part path, a
  validation error, a path ending in a dot, no overrides). All match to the byte and to the message, as does the progress
  count. `engine/tests/optimizer.rs` ports sections 6 and 8 of tests/test_engine.cpp.
- The command line `soloptima optimize` (`engine/src/bin/soloptima.rs` since 2.12): on web/examples/example_study.json its
  output equals the C++ engine's to the byte (1.4 MB) when the C++ engine is built with `-ffp-contract=off`. The `make` build
  (-O3, contraction on) differs in the last digits of some figures, with the same best system.

### Storage (session 2.12a)

`engine/src/storage/` ports src/storage.cpp and the data-folder code of src/main.cpp: `files.rs` (atomic exclusive 0600 writes,
reads with O_NOFOLLOW, `no_link`, `make_private_dirs` that stops at the root, `valid_id` with the Windows device names,
`iso_time`), `mod.rs` (profiles, projects and meta, terms, duplicate), `reports.rs` (reports, index, ids never reused),
`datadir.rs` (`find_data_dir`, `change_data_dir` move and use, settings and update preferences, `remove_temp_files` is in `Storage`).

- `engine/tests/storage.rs`: a data folder with bad entries is planted, and 53 scripted steps give what the C++ `Storage` gives
  (`tests/gen_storage_fixtures.cpp`; times and random ids are normalised, lists with equal times compared as sets). Planted links,
  device names, folder and file modes, temporary files, and the folder change (also its success path, with HOME in a temp folder)
  have their own tests.
- Opening the folder in the file manager is the shell's job (`open_folder` in src-tauri); there is nothing to port.

### Variability and the switch (session 2.12)

`engine/src/resource.rs` ports src/resource.{hpp,cpp} and the weather-year cache of src/main.cpp: `exceedance`, `sigma_sys`,
`resource_years` (the n + 3 runs in parallel with rayon, results by index, then the finance per year in order) and
`WeatherYearsCache` (4 sets at most, keyed by source, site rounded to 0.001 deg and range).

- `engine/tests/resource.rs` compares with `fixtures/resource.json` (`tests/gen_resource_fixtures.cpp`, now in the git
  history): 12 runs on the example project with synthetic weather years (irradiance scaled, temperature shifted, wind scaled):
  host, one simulated year, PPA with take-or-pay and shortfall penalty, a tariff solved for a target IRR, TPO with deemed
  energy, a zero budget (5 % step), two and three equal years, the predictive EMS, wind turbines, no battery, and the
  one-year error; plus `exceedance` on five inputs. All match to the byte, as does the progress count.
- `engine/src/api/` is the rest of src/main.cpp: the commands (`mod.rs`: info, legal, profiles, settings, projects, reports,
  cache; `compute.rs`: weather, horizon, forecasts, import, data checks, PV, PV reference, tilt scan, benchmark, batch,
  simulate (`run_simulation`), EMS schedule, optimise, variability) and the job table (`jobs.rs`: a thread per job, 8 kept,
  results of runs finished over 30 s ago dropped by `cache_clear`). `engine/tests/api.rs` checks the messages, the store, a
  simulation equal to the command line's and an optimisation job.
- `simulate` adds `result.summary` (`engine/src/sim/summary.rs`): `monthly` (year 1 by month plus the year: load, pv, wind,
  bess, gen, gch, unmet, curt, dump, fuel, re), `flow` (year-1 energy flow: d_e, loss, aux, thru, show_de, inp, out, gap,
  direct) and `bess_health` (thr, fade, cap, max_efc, max_efc_dc, max_c, life, cyc_share, repl, soh_end, over). The interface
  shows them as they come (`lib/sim-extra.js`); `replace_soh` is the one rule for the replacement threshold. A panic answers
  as a defect whose message ends with its source line, `(at engine/src/...rs:n)` (`jobs.rs`, `install_panic_hook`).
- The bug-report storage and its Markdown copy were ported with the storage (2.12a, `storage/reports.rs`).
- The version is `[workspace.package]` in the root Cargo.toml (`engine::api::VERSION`); src/version.hpp is gone.
