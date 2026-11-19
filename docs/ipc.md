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
digits of some figures, see the series section below). `soloptima resilience project.json [out.json]` (added after the
port) runs the outage survival study with the project's `resilience` block and answers what the `resilience` job answers.

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
| `POST /api/weather` | `weather` | body: `source`, `lat`, `lon`, `year`, `snow_rh` | `snow_rh` true: also hourly `snow` (cm/h, a year with snow only) and `rh` (%) where the service publishes them (NASA POWER both, PVGIS typical year `rh`) |
| `POST /api/horizon` | `horizon` | body: `lat`, `lon` | |
| `POST /api/forecast-weather` | `forecast_weather` | body: `provider`, `lat`, `lon`, `days`, `api_key`; `met_weight` with provider `blend` | provider `blend` added after the port (Gaps 12 and 14 below) |
| `POST /api/import-series` | `import_series` | body: `text`, `options` | 64 MB limit stays |
| `POST /api/data-qc` | `data_qc` | body: `project`, `only` | |
| `POST /api/pv` | `pv` | body (project with weather) | |
| `POST /api/pv-reference` | `pv_reference` | body (project with weather) | |
| (none: added after the port) | `pv_reconcile` | body: `project` (with weather), `meter` {`kw`} | metered PV output against the yield model (see Gap 4 below) |
| `POST /api/tilt-scan` | `tilt_scan` | body (project with weather) | |
| (none: was interface code) | `electrical` | body: `action` (`study`, `autosize`, `apply`, `loadflow`, `buses`), `project`, `pvr`, `sim`, `lengths`; `rte_base` for `apply`, `t` for `buses` | `study` → `{design, protection}`, the design with `reactive` (kVA check) when `electrical.pf_poc` is below 1 `weakGrid` (short-circuit ratio, energising dip) when `electrical.grid_mva` is above 0, `unbalanced` (sequence voltages, unbalance factor and current split in an unbalanced fault) when `grid_mva` and `electrical.ubf_vpos` are above 0, and `islands` (the islanded N-1 screen: `rows`, `outages`, `noShed`, `worst`) when `electrical.n1_check` is set; the project may carry `load.critical_share` and `grid` `{enabled, import_kw}` for it; `autosize` → `{count, electrical}`; `apply` → `{rte_base, pv, bess, aux, electrical}`; `loadflow` → the year's load flow, with `reactive` `{pf, kvarh, shortH}` when `pf_poc` is below 1; `buses` → bus voltages at hour `t` |
| `POST /api/forecast/benchmark` | `forecast_benchmark` | body: `project`, `with_value`, `by_class` | `by_class` added after the port (Gaps 12 and 14 below) |
| `GET /api/forecast/methods` | `forecast_methods` | | |
| `POST /api/batch` | `batch` | body: `project`, `cases` | one case per `{overrides: {dotted path: value}}`; used by the operating options, the tornado, the design variants and the script console |
| `POST /api/simulate` | `simulate` | body (project) | `result.summary.reliability` and `result.summary.checks` always (see Gaps 22 and 25 below); `grid_extension` only with `grid_ext.cost_per_km` above 0 and no grid connection (see Gaps 7, 10 and 11 below) |
| `POST /api/ems/schedule` | `ems_schedule` | body: `project`, `forecast`, `soc_now`, `load_scale`, `now_utc`, `days` | |
| `POST /api/optimize` | `optimize` | body: `project`, `optimizer` | J; `optimizer.size_gensets`, `gen_units_min`, `gen_units_max` size the main genset group (see Optimiser below); `min_autonomy_days`, `autonomy_load_kw` and the two-way map `map_x`, `map_x_values`, `map_y`, `map_y_values`, `map_mode` (see Gaps 7, 10 and 11 below); `gen_ratings`, `repeat_runs`, `mo_second` lpsp and co2, `pareto_stats`, `mo_pick` (see Gaps 20 and 21 below) |
| `POST /api/resource-years` | `resource_years` | body: `project`, `source`, `from`, `to`, `budget` | J |
| (none: added after the port) | `resilience` | body: `project`, `resilience` {`stride`, `max_h`} | J; outage survival study (see Gaps 17 and 18 below); progress counts the start hours |
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

## 3D view commands (`src-tauri/src/view3d.rs`)

The 3D view of the Site & layout page is drawn on the GPU with wgpu: Metal on macOS, Direct3D 12 on Windows, Vulkan on
Linux. The shell draws each frame off screen and sends the pixels to the page's canvas. Tauri doesn't pass mouse or
keyboard events to the shell, so the page keeps everything you do with the mouse: turning, panning, zooming, picking and
the move, turn and size handles (which it draws on a second canvas on top). If either command fails, for example on a
machine with no usable graphics adapter, the page stops asking and draws the view itself on a 2D canvas, farthest face
first. Slower and rougher, but it works.

| Command | Arguments | Notes |
|---|---|---|
| `view3d_scene` | raw bytes as the request body: the mesh of `meshOf` (ui/src/lib/layout/scene.js); empty clears it | keeps the mesh on the GPU and answers the graphics API in use (`"Metal"`, `"Direct3D 12"`, `"Vulkan"`) |
| `view3d_moving` | raw bytes as the request body: the mesh of the one item being dragged (`sceneOf` with `only`, on the scene's projector, no ground) | drawn with the scene until the next `view3d_scene`, which clears it. During a drag the page sends the rest of the layout once (`sceneOf` with `skip`) and then only this small mesh per step, so dragging a building stays smooth on a 30 000 table plant |
| `view3d_ground` | raw bytes as the request body: the satellite image under the scene (`groundBody` in ui/src/lib/layout/ground.js); empty clears it | a u32 width and height (1 to 2048), the corners of the quad it lies on (south-west, south-east, north-east, north-west; x, y, z f32 in scene metres), then width x height x 4 RGBA bytes, rows from the top. Width and height 0 with no pixels move the quad and keep the image. The page fetches the image (Esri World Imagery, a square round the scene of at most 6.4 km a side) and decodes it to RGBA itself, so the shell needs no image decoder. It is drawn under the scene, with the sun's shadows on it |
| `view3d_frame` | `w`, `h` (pixels, 1 to 4096); `az`, `el`, `dist`, `target` (the camera of `cameraOf`: turned to azimuth `az`, `el` above the horizon, `dist` metres from the point `target` it looks at); `sun` (unit vector towards the sun); `day` (sun above the horizon); `cells` (solar cells per module along a table and up it, for the panel drawing) | raw RGBA bytes, `w x h x 4`, rows from the top |

The mesh: a little-endian u32 with the number of triangle corners, an f32 with the radius of a sphere that holds the whole
scene (it sizes the sun's shadow map), then corners of 24 bytes each. A corner is x, y, z (metres east, north and up of the
centre of the drawn items), u, v (module coordinates on a table, else 0) as f32, then r, g, b and a flag as bytes. The flag
says how the sun lights the corner: 255 a plain solid, 200 a solar panel (cells, module frames, a glint, the backsheet from
behind), 150 glass (a glint), 100 leaves (a little noise so a crown doesn't look flat), 0 a line that keeps its own colour.
Triangles come first, then pairs of line ends (cable routes, then the mounting structure). The shell checks the sizes and
counts before it touches the GPU and refuses anything that doesn't add up.

A frame is at most 4.2 million pixels (the page asks for 2.5 million, 1 million while you drag). The shell draws a 4096 x
4096 shadow map from the sun (orthographic, over the scene's sphere) only when the sun or a mesh changed, so turning the
camera costs one pass, then the scene with 4x
multisampling, a reversed depth buffer (no z-fighting at plant scale) and a 3 x 3 filtered shadow lookup. On an M-series
Mac a 1600 x 1000 frame of a small plant takes about 2 ms on the GPU; the copy over IPC costs more than the drawing.

The ground image is checked the same way (its size, the byte count and finite corners) and kept as a texture with mip
levels the shell averages itself. It is not part of the shadow map: flat ground casts no shadow, it only takes them.

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
Weather imports also take the optional columns `snow` (with `snow_units`: `cm`, `mm` of snow or `mm_water` per interval, the
default `cm`) and `rh` (with `rh_units`: `pct` or `fraction`); the result holds `snow` (cm/h) and `rh` (%) only when they were chosen.

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
- Grid connection (`grid.rs`, project key `grid`: `enabled`, `import_kw`, `export_kw`, `tariff` flat | tou, `import_price`,
  `tou` (24 or 288 prices), `export_price`, `demand_charge`, `escalation`, `co2_kg_per_kwh`, `availability` always | pattern |
  random, `pattern` (24 or 8760 values, above 0.5 = up), `outages_per_year`, `outage_hours`, `seed`, `charge_bess`, `reserve_kw`,
  `reserve_min`, `reserve_price`). `grid_year` gives each
  project year's availability (random outages: a SplitMix64 draw per seed and year) and import prices; `GridHour` is one hour
  as the dispatch and the planner (`PlanInput::grid`, `Planner::hour_cost_grid`) see it. Only with `enabled` does a result carry
  `has_grid`, the year keys `grid_import`, `grid_export`, `pv_to_grid`, `wind_to_grid`, `grid_up_h`, `grid_outages`,
  `grid_peak_kw`, `c_grid_import`, `c_grid_demand`, `c_grid_export`, `c_grid` (in `c_total`), the hourly `grid_import`,
  `grid_export`, `grid_up`, and in `summary` the monthly `grid` and `export` and the flow's `grid_in` and `grid_out`; a project
  without a grid gives the same JSON to the byte. Battery charging from the grid (`charge_bess`; rule-based hours in
  `GridYear::charge_hours`, `PlanInput::grid_charge` for the EMS) and the frequency reserve (`reserve_kw` > 0; `PlanInput::fr_kw`,
  `fr_lo`, `fr_hi`) add, only when set and the grid is on, the year key `grid_to_bess` (also in `grid_import_val`, the import
  cost and the peaks; `grid_import` stays the import to the load), the hourly `grid_to_bess`, the monthly `grid_ch` and the
  flow's `grid_ch`; the reserve adds the year keys `fr_held_h`, `fr_spill`, `fr_shift` and `c_fr` (revenue, taken off `c_total`).
  The day-ahead schedule's `grid_kw` then includes grid charging. The interface sends these four keys only when they differ from
  their defaults (`leanGrid`), so results saved before keep their fingerprints. `SimResult::fin_sim` adds `c_grid` to `c_om_dg` and the grid import to
  `gen_kwh`, which the finance reads only as the running cost and energy of the conventional supply (the host's cost, the
  avoided cost per kWh of a diesel-discount tariff), so the finance module needs no change. The interface sends `grid` only while it is on.
- Mixed fleets (`fleet.rs`, `diesel.more_groups`: `name`, `units`, `unit_kw`, `min_load`, `fuel_model`, `fuel_intercept`,
  `fuel_slope`, `fuel_curve`, `capex_kw`, `om_kwh`, `om_unit_hour`; a missing value takes the main group's, a missing cost the
  econ value). `Fleet` sorts the groups by energy cost at 75 % loading and commits the first u units of that order; `cap(u)`,
  `gmin(u)`, `fuel_lh(u, gen)` (equal loading) and `online(u)` serve the dispatch, the planner (`Planner::with_fleet`; `new` keeps
  a single group) and the day-ahead schedule. With one group they compute as before, so old projects match to the byte. Only a
  mixed fleet's result carries `fleet` (the groups in merit order: `index`, `units`, `unit_kw`, `min_load`) and per year
  `groups` (`index`, `unit_hours`, `gen_kwh`, `fuel_l`, `starts`, `c_om`). The interface sends `more_groups` only when it has
  entries.
- `ems.reserve_energy` (`PlanInput::reserve_energy`): in `Planner::plan` a level change k -> m is costed with the battery reserve
  limited to `reserve_cap_step(e_k, e_m)` wherever that is below the spare power the tabulated cost assumes; off (the
  default) the plan is as before to the byte. The day-ahead schedule takes the same setting through `plan_input`.
- Time step (`sim.step_min` 60 | 30 | 15, `sim.subhourly` hold | interpolate; `SimOptions::steps_per_hour`). `simulate` runs
  8760 x k steps of dt = 1/k h; with k = 1 every product with dt is exact, so hourly projects match to the byte. A load given
  at the step (`load.kw` of 8760 x k values, 29 February dropped) is kept in `Project::load_sub` beside the hourly `load_kw`;
  `import_series` with `keep_sub` returns a 15 or 30 minute logger's `kw_sub` and `sub_min`. Only with k > 1 does a result
  carry `step_min` and `steps` (the year-1 series of every step, without the forecasts; fuel in litres per step); `hourly`
  then holds hourly means (SOC at the end of the hour, fuel summed).
- Genset ramps, start time, forced outages and N-1 (`diesel.ramp_pct_min`, `start_min`, `outage_rate`, `repair_h`,
  `outage_seed`, `n1_check`): `Fleet::outages` draws each unit's failures per year, `Fleet::with_available` is the fleet
  left; year keys `ramp_limited_h`, `unit_outages`, `unit_outage_h`, `n1_short_h`, `n1_short_max_kw` appear only when the
  matching input is used. The interface sends these inputs only when they differ from the defaults (`ui/src/lib/ws/lean.js`).
- Battery cycle-life curve (`bess.cycle_curve`: 2 to 4 `[DoD, cycles]` pairs, DoD a share of nameplate, rising, cycles not
  rising; absent or empty: the linear model of `cycle_life` at `cycle_life_dod`). `sim/ageing.rs` counts the stored energy of
  every step (share of nameplate) by rainflow (`Rainflow`, ASTM E1049-85 three-point method, residue as half cycles, O(n) per
  year) and sums Miner's damage (`Miner`) against `cycles_at` (log-log between points, the end points' cycles x depth held
  outside); `soh_loss_cyc` = damage x (1 - `eol_soh`). `plan_input` sets the wear cost to `wear_cost` (replacement cost over
  the energy to end of life at the SOC window's depth). With a curve the year keys `bess_damage`, `rf_cycles` and `rf_dod` appear.
- Minimum up and down times (`diesel.min_up_h`, `min_down_h`, hours, 0 to 168, 0 = none). The dispatch keeps the start and
  stop step of each unit, units alike (a stop takes the unit that has run longest, a start the one off longest): a unit within
  its up time stays online, one within its down time stays off unless the load would go unserved with the battery at full
  discharge and the grid at its limit. With a down time the year key `min_down_override` (units started early for the load)
  appears.
- Start cost in the plan (`ems.plan_starts`, off by default): `PlanInput::start_cost` = `econ.diesel_start_cost` and `u0` (units
  online before the plan, set by the dispatch; 0 in the day-ahead schedule). `Planner::plan_starts` runs the DP over (level,
  units before the hour). With a cost per start the year key `c_starts` (part of `c_om_dg`) appears. The interface sends
  `cycle_curve`, `min_up_h`, `min_down_h` and `plan_starts` only when set (`leanCurve`, `leanDiesel`, `leanEms`).
- Genset wear (`econ.diesel_overhaul_h`, `diesel_overhaul_kw`, `diesel_life_h`, `diesel_replace_kw`; per group `overhaul_h`,
  `overhaul_kw`, `life_h`, `replace_kw`, a missing value the econ one, a missing replacement cost the group's capex;
  `diesel_replace_kw` absent or null: `diesel_capex_kw`). Hours are 0 (none) or 100 to 1 000 000. `econ.rs` (`Wear`,
  `gen_wear`) spreads each group's unit-hours evenly over its units and books the overhauls and replacements due in each
  year but the last. With an interval set the year keys `gen_overhauls`, `gen_replacements`, `c_gen_overhaul`,
  `c_gen_replace` (both in `c_replace`) and `c_gen_salvage` (last year, in `c_salvage`) appear, and each mixed-fleet group
  gets `overhauls` and `replacements`. `SimResult::fin_sim` moves the three costs from `c_replace` and `c_salvage` to
  `c_om_dg`, since the gensets are the host's.
- Pollutants (`econ.pm25_g_per_l`, `co_g_per_l`, `nox_price_kg`, `sox_price_kg`, `pm25_price_kg`, `co_price_kg`,
  `pv_co2_kg_per_kwh`, all 0 by default). With PM2.5, CO or a price set, the year keys `pm25_t`, `co_t` and `c_pollutants`
  (in `c_total`) and `metrics.pm25_kg`, `metrics.co_kg` appear; `fin_sim` adds `c_pollutants` to `c_carbon`, and
  `GensetCost` adds the prices per litre to the genset cost the grid is weighed against. With an embodied PV factor the
  year key `co2_pv_t` (in `co2_t`) appears. The interface sends these econ keys only when set (`leanEcon`), and the group
  keys only when not blank (`engineGroups`).
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
inputs (`eval.rs`), the baseline and the grid with Hooke-Jeeves pattern search [1] (`search.rs`), PSO, MOPSO and SHO-QAO-GOA
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
- Genset sizing (after the port, no C++ counterpart): `optimizer.size_gensets` (default false) with `gen_units_min` and
  `gen_units_max` (default: the project's `diesel.units`; refused when negative, min above max or above 1000, only while
  sizing is on). `Sizing::gen_units` carries the count of the main group (None: the project's fleet); `simulate` runs the
  dispatch and the economics with `Sizing::diesel`, the project's `DieselParams` with that count. The grid varies the count
  slowest, so one count keeps the old order; the metaheuristics add it as the last dimension. With sizing on the answer
  also has `settings.size_gensets`, `settings.gen_units_min` / `gen_units_max`, `gen_units` in every candidate and in
  `best_detail.size`, `gen_max` / `gen_min` in `at_boundary`, and `architectures`: one row per system type among the
  evaluated candidates, `{label, pv, bess, wind, gensets, n_evaluated, n_feasible, best}` (`best` a candidate or null),
  feasible types first by objective. With sizing off none of these keys is written, so the answer is the same to the byte.
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

### Gaps 7, 10 and 11 of docs/LITERATURE.md (after the port)

Every new input is off or neutral by default, and with it the answers are the same to the byte (the parity tests pass with no
fixture change); `engine/tests/extension_autonomy_map.rs` tests them.

- Project inputs: `pv.irradiance_scale` and `wind.speed_scale` (default 1, above 0 and at most 2): the GHI and its diffuse part
  times the scale in `pv/pass.rs` before decomposition and transposition (the clear-sky reference keeps 1), and the wind speed
  times the scale in `wind_per_turbine` before shear and the power curve. `sim.low_pv_frac` (default 0.5, above 0 and below 1).
  `grid_ext` {`cost_per_km`, `connection_cost`, `om_per_km_yr`, `price`, `escalation`} (engine defaults 0, a new project's price
  0.10; off while `cost_per_km` is 0; costs non-negative, escalation above -100 % and at most 100 %). The interface leaves each out of
  the engine project at its default (`ui/src/lib/ws/lean.js`), so saved results keep their fingerprints; the tornado still
  treats the two scales as engine inputs.
- `simulate`: `result.summary.reliability` {`low_pv_frac`, `low_pv_days`, `low_pv_run_d`, `low_pv_run_start` (0-based day),
  `unmet_run_h`, `unmet_run_start` (0-based hour of year 1)} from `sim::reliability_json` on the PV output per kWp and the
  year-1 hourly series; the low-PV figures are null without PV yield, the starts null without a run. With `grid_ext` on and no
  grid connection, `grid_extension` {`cost_per_km`, `connection_cost`, `om_per_km_yr`, `price`, `escalation`, `energy_kwh`,
  `npc_plant`, `npc_fixed`, `npc_per_km`, `break_even_km`} from `sim::grid_extension`: NPC of grid supply = `npc_fixed` + L ×
  `npc_per_km`, break-even where it equals `npc_plant` (0 when `npc_fixed` is above it).
- `optimize`: `min_autonomy_days` (0 to 30, 0 = none) and `autonomy_load_kw` (0 = the year-1 mean load); with the constraint on,
  `settings` echoes both and every candidate has `autonomy_d` (days; null for an infinite value with no load). Sensitivity
  variables `irradiance_scale` and `wind_speed_scale` (above 0 and at most 2) multiply the project's scales, and the PV or
  turbine output is computed again for those cases. The map: `map_x` and `map_y` (two different sensitivity variables),
  `map_x_values` and `map_y_values` (1 to 10 finite numbers each, checked as sensitivity values), `map_mode` `optimize`
  (default: the whole search per cell) or `fixed` (the best design of each system type of the main search, simulated per
  cell). The answer then has `map` {`x`, `x_values`, `y`, `y_values`, `mode`, `designs` (fixed only: the candidates with their
  `type`), `cells`: one row per y value, one cell per x value, each {`best` (candidate or null), `type` (label or null),
  `baseline_npc`} and in fixed mode `npc` and `feasible` per design, or null when not reached after a cancel}. The map runs in
  the optimisation job after the sensitivity; the progress total counts its searches or simulations, and `job_cancel` stops it
  between cells (a cell whose search was cut short is null). With none of these keys the answer is the same to the byte.
- The version is `[workspace.package]` in the root Cargo.toml (`engine::api::VERSION`); src/version.hpp is gone.

### Gaps 17 and 18 of docs/LITERATURE.md (after the port)

Every new input is off by default and the answers are then the same to the byte (the parity tests pass with no fixture change);
`engine/tests/critical_resilience.rs` tests them.

- Project inputs: `load.critical_share` (default 1, 0 to 1), `grid.outage_critical_only` (default false), `ems.voll_nc` (absent
  or null: `ems.voll`; at least 0), `diesel.fail_start` (default 0, 0 to 1) and `diesel.mttf_h` (default 0 = 8760 ÷
  `outage_rate`, else 1 to 1 000 000 h). The last two are read by the resilience study only. The interface leaves each out of the
  engine project at its default (`ui/src/lib/ws/lean.js`).
- `simulate`, `batch`, `optimize`: with `critical_share` below 1 the result has `unmet_crit_fraction` and
  `unmet_crit_fraction_max`, and every year `load_crit`, `unmet_crit`, `unmet_nc` (with `unmet_crit` adding up to `unmet`),
  `lol_crit_h` and `lol_nc_h`, plus `nc_shed` with `outage_critical_only` on a grid connection. The optimiser's `max_unmet` and
  `max_lole_h` then hold for the critical load, and the candidates' `unmet` and `lole_h` are the critical figures.
- `resilience` (job): body `project` and `resilience` {`stride` (1 to 168 h, default 1), `max_h` (1 to 720 h, default 336)}; both
  are checked before the job starts. The answer: `stride`, `max_h`, `starts`, `critical_share`, `critical_kw_mean`, `units`,
  `fail_start`, `mttf_h` (null: units do not fail while running), `availability` (OA at the start), `unit_reliability` (R(d) of one
  unit, d = 1 to `max_h`), `cum` {`min`, `p5`, `mean`, `below90`} (cumulative survival over the start hours, each `max_h` long),
  `hourly` {`min`, `mean`} (the chance hour d itself is served), `served_mean` (share of the critical energy served over d hours)
  and `strip` {`durations` (1, 2, 4, 8, 12, 24, 48, 72, 96, 168, 240, 336, 504, 720 up to `max_h`, and `max_h`), `values` (per
  duration the cumulative survival of each start hour 0, `stride`, 2 × `stride` and so on, to three decimals)}. `job_cancel` stops
  it between start hours and the job answers the error "Cancelled.". The method is in the manual (Outage survival).

### Gaps 20 and 21 of docs/LITERATURE.md (genset unit rating, repeated runs, MOPSO front statistics)

Every new input is off by default and the answer is then the same to the byte (the parity tests pass with no fixture change);
`engine/tests/optimizer_ratings_runs.rs` tests them. All are in the `optimizer` block and checked by `parse_opt_settings`.

- `gen_ratings`: up to 12 objects {`kw` (above 0, at most 100 000), `min_load` (0 to below 1), `fuel_curve` ((load fraction, kWh
  per litre) points, at least 2), `capex_kw`, `om_unit_hour` (not negative), `name`, `id`}; every field but `kw` may be left out
  and then keeps the project's (the fuel model is per kW, so it scales with the rating). The list is sorted by `kw`. Each rating
  is a copy of the project with the main group's `unit_kw`, `min_load`, fuel curve and `econ.diesel_capex_kw` /
  `diesel_om_unit_hour` set (`optimizer::rated`), made again for each sensitivity run so its values carry over. The grid runs
  every rating, slowest of all; the metaheuristics add the index into the sorted list as the last dimension. The interface sends
  the typed kW values, or each genset datasheet of the library with its prime power, minimum load, fuel curve from the litres per
  hour at 25 to 100 %, price per kW (when above 0) and O&M per run hour. With ratings the answer has `settings.gen_ratings`
  {`kw`, `name`, `id`, `own_fuel_curve`, and `min_load`, `capex_kw`, `om_unit_hour` when given}, `gen_rating` (the index) and
  `gen_kw` in every candidate, and `architectures` (also without `size_gensets`). `best_detail` is simulated at the best rating;
  the baseline keeps the project's fleet.
- `repeat_runs` (1 to 50, a whole number, default 1): the metaheuristic runs that many times, run r (0-based) with seed
  `seed + r × 0x9E3779B9` (wrapping, so the first run is the single run of the same seed). The runs share the cache of simulated
  sizes and run one after another, each population in parallel, so the answer does not depend on threads. With more than one
  run the answer has `settings.repeat_runs` and `runs` {`n`, `metric` (`npc`, `lcoe`, `re` or `hypervolume` for MOPSO),
  `higher_is_better`, `n_with_value`, `best_run` (1-based, null when no run found a feasible design), `best`, `mean`, `worst`,
  `std` (sample, n − 1), `rows` [{`run`, `seed`, `evaluations` (positions evaluated), `simulations` (sizes simulated for the first
  time in that run), `value`, and for MOPSO `front` and `spacing`}]}. The best design is the best of all runs (PSO, SHO-QAO-GOA)
  or taken from the front of the run with the largest hypervolume (MOPSO); `history` is that run's. The grid search ignores it.
- `mo_second` also takes `lpsp` (the candidate's `unmet`, minimised) and `co2` (year-1 `metrics.co2_t`, minimised). With `co2`,
  or with `pareto_stats`, MOPSO candidates have `co2_t`. With `lpsp` or `co2` the `pareto` list is sorted by that objective.
- `pareto_stats` (MOPSO, default false): `pareto_quality` {`points`, `spacing`, `hypervolume`, `ref_cost`, `ref_second`} and
  `lpsp_table` [{`target` (0, 0.01, 0.02, 0.05, 0.10), `best` (the front design with `unmet` at most the target and the lowest
  cost objective, or null)}]. Both objectives are scaled 0 to 1 between their best and worst values on the fronts of all runs;
  the spacing (`optimizer::spacing`) is the sample standard deviation of each point's L1 distance to its nearest neighbour,
  and the hypervolume (`optimizer::hypervolume`) is taken against the point (1.1, 1.1) and divided by 1.21. `ref_second` is in
  the second objective's own units and sign (a renewable fraction for `re`).
- `mo_pick` (MOPSO): `knee` (default) or `fuzzy`, the design with the largest sum of linear memberships (1 at an objective's best
  on the front, 0 at its worst); with `fuzzy` the settings echo `mo_pick`.

### Gap 5 of docs/LITERATURE.md (deferrable load)

Off by default, and the answers are then the same to the byte; `engine/tests/deferrable.rs` tests it.

- Project input: `load.deferrable` {`kwh_day` (default 0 = off), `kw` (above 0 when on), `start_h` and `end_h` (0 to 23, local
  standard time; the window may wrap midnight, and equal hours are the whole day; default 8 and 17), `tank_kwh` (default 0),
  `tank_fill` (0 to 1, default 0.5), `first` (`battery`, the default, or `deferrable`: where PV and wind surplus goes first)}.
  `kw` × the window's hours must reach `kwh_day`. The interface keeps water inputs (m³ per day, kWh per m³, tank m³) and sends
  energy only, and leaves the block out while it is off (`ui/src/lib/ws/lean.js`).
- `simulate`, `batch`, `optimize`: with it on the result has `dl_unmet_fraction` and `dl_unmet_fraction_max` (unserved
  deferrable energy over its demand), every year `dl_demand` (`kwh_day` × 365), `dl_kwh` (energy it drew, also in `load`,
  `served` and `served_site`), `dl_re` (the part from PV and wind) and `dl_unmet` (not in `unmet`), and the hourly and step series
  `dl` (kW, also in `load`) and, with a store, `dl_tank` (kWh at the end of the hour). `unmet_fraction` is taken against the site
  load (`load` − `dl_kwh`). `simulate` adds `deferrable_ref` {`curtailed` (PV and wind, year 1), `curtail_fraction`, `fuel_l_y1`,
  `re_fraction`, and `grid_export` with a grid}: the same design without the deferrable load.
- `optimize`: `optimizer.max_dl_unmet` (absent or null: `max_unmet`) limits each candidate's `dl_unmet` (worst year), which
  candidates carry only with the load on; `settings` echoes the limit when it is set. A candidate that breaks it has `why`
  `deferrable load`.

### Gap 4 of docs/LITERATURE.md (metered PV output against the model)

Nothing changes without a meter: no engine input is new, and `engine/tests/pv_reconcile.rs` tests the import and the comparison.

- `import_series` with `kind` `pv` reads metered AC output as a load is read (`cols` summed, `units` `kw`, `w`, `mw`, `kwh_interval`
  or `mwh_interval`, any time basis, `year` or `last12`) into local standard time, the time base of the yield model. Nothing is
  filled: `kw` holds 8760 values, null for an hour less than half covered. It refuses a file with under 24 h of data, with no value
  above zero, or with an hour below -2 % of the peak; smaller negative hours become 0 and are counted in `report.negative_h`.
  `keep_sub` and `fill_long` do not apply. The 64 MB limit holds.
- `pv_reconcile`: `meter.kw` must have 8760 values, each null or a number from 0 to ten times the PV capacity (text, infinite or
  negative values are refused, naming the hour), and the project a PV capacity above 0 and an availability above 0 and at most 1.
  The answer: `hours` (present in the file), `daylight_h`, `running_h`, `outage_h` and `outages` (the first 20, as "3 Mar 12:00");
  `stats` {`running`, `all`}, each {`hours`, `meter_kwh`, `model_kwh`, `mbe_kw`, `mbe`, `rmse_kw`, `nrmse`, `r2`} with MBE and RMSE as
  model − meter and the shares of the mean metered output; `monthly` (12 × {`hours`, `outage_h`, `meter_kwh`, `model_kwh`,
  `fit_kwh`, `fit_monthly_kwh`, `dev`: model ÷ meter − 1 or null}); `fit` {`soiling`, `soiling_raw`, `at_bound`, `soiling_monthly`
  (12), `own_month` (12 booleans), `availability`, `after` and `after_monthly` (statistics over all daylight hours with the fitted
  values), `rmse_gain`, `rmse_gain_monthly` (1 − RMSE after ÷ RMSE before)}; `notes`; `project` {`soiling`, `soiling_monthly` or null,
  `availability`}. The method is in docs/MANUAL.md (*Measured PV output against the model*).
- The interface keeps the meter as `pv_meter` {`kw`, `import`, `applied`} at the top of the project, outside the engine project
  (`ui/src/lib/ws/core.js`), so it never reaches `simulate` and changes no fingerprint of a result.

### Gaps 12 and 14 of docs/LITERATURE.md (MPP tracking, forecast blend and weather classes)

Every new input is off by default and the answers are then the same to the byte (the parity tests pass with no fixture change);
`engine/tests/tracking_blend.rs` tests them.

- Project inputs: `pv.mppt_loss` (default 0, 0 to 0.1) multiplies the DC power of every hour by 1 − `mppt_loss` before the
  inverter, and the `pv` answer's `losses` then has the step "After MPP tracking" after "After mismatch, wiring, LID, quality";
  `monthly.earray` stays before it. `pv.mppt_local` (default false) acts only with `near_model` `bypass` and objects on the layout:
  the string's power is the maximum a perturb and observe tracker reaches from the full string voltage
  (`shading::bypass_power`), not the highest. The interface leaves both out of the engine project at their defaults
  (`ui/src/lib/ws/core.js`).
- `forecast_weather` with `provider` `blend`: fetches Open-Meteo and MET Norway with their usual requests (no other host) and
  answers one forecast document (`weather::blend_forecasts`): `provider` "Open-Meteo + MET Norway", `time_offset` 0.5, `times`
  (UTC start of each hour both providers forecast), `ghi`, `tamb`, `wind` (weighted means; null where a provider has none),
  `dhi` and `dni` (Open-Meteo's, scaled to the blended GHI), `weights` [{`provider`, `weight`}] summing to 1, `issued_utc`,
  `model_updated_utc` (MET Norway's) and `note`. `met_weight` (0 to 1, default 0.5) is MET Norway's weight. `ems_schedule`
  takes it like any forecast.
- `forecast_benchmark` with `by_class` true adds `weather_classes` {`thresholds` [0.3, 0.7], `classes`: clear, cloudy and
  overcast, each {`id`, `name`, `days`, `pv` and `load` {`hours`, `methods`: per method, in the order of the answer's methods,
  {`id`, `nmae`, `nrmse`, `skill`} at leads 1 to 48 h}}}. A day's class comes from its PV energy over its clear-sky PV energy
  (`ems::day_classes`); nMAE and nRMSE are divided by the year's mean, so hours × nMAE over the classes adds up to the year's,
  and skill is against persistence in the class. Without `by_class` the answer is the same to the byte.

### Gaps 22 and 25 of docs/LITERATURE.md (results check, load and reporting extras)

No input is added and no answer of an existing route changes: the parity tests hash `result_to_json`, and the check is added only
by `run_simulation`, beside the rest of `result.summary`. `engine/src/sim/checks.rs` and `engine/tests/result_checks.rs` test it.

- `simulate`: `result.summary.checks`, the results outside a plausible range, an empty list when every one is plausible. Each
  is {`id`, `label`, `value`, `lo`, `hi`, `unit`, `why`}: the value in the unit shown (a share as %), the range (`lo` or `hi`
  null for an open end) and a one-line reason. The ids are `pv_pr`, `pv_cf`, `wind_cf`, `gen_sfc`, `co2_per_l`, `nox_per_l`,
  `sox_per_l`, `pm25_per_l`, `co_per_l`, `balance`, `lcoe`, `lcoe_ratio`, `payback`, `bess_efc` and `bess_rte`; the ranges and
  why are in docs/MANUAL.md (*Results check*). `sim::result_checks` takes the result, the diesel-only case, the comparison and
  the PV model's plane-of-array and rear irradiation.
- The appliance load builder, the battery SOC by band and season, the genset table by month and the renewable fraction by
  capacity and by peak are interface code (`ui/src/lib/appliances.js`, `ui/src/lib/sim-tables.js`) on the hourly series the
  answers already have. The appliance list is kept in the project as `load.appliances` and is left out of the engine project
  (`leanLoad` sends only the hourly load), so it changes no fingerprint.

### Gap 15 of docs/LITERATURE.md (PV and wind ramp limit, coarse)

Off by default, and the answers are then the same to the byte; `engine/tests/re_ramp.rs` tests it.

- Project input: `sim.re_ramp_pct_min` (default 0 = off, 0 to 100): the most PV and wind output may change per minute, in % of
  the PV inverters' AC rating (kWp ÷ DC/AC ratio) plus the turbines' rated kW. It acts only in 15 and 30 minute steps, where a
  step may change by the limit × the step's minutes. The interface sends it only above 0 and with a step under an hour
  (`leanSim`).
- `simulate`, `batch`, `optimize`: with it on, every year has `re_ramp_viol` (steps in which PV and wind fell faster than the
  limit and the battery could not make up the rest), `re_ramp_viol_kwh` (that energy), `re_ramp_bess_ch` and
  `re_ramp_bess_dis` (battery energy charged and discharged to hold the limit, also in `bess_ch`, `pv_to_bess`, `wind_to_bess`
  and `bess_dis`) and `re_ramp_curtailed` (curtailed by the limit, also in `pv_curtailed` and `wind_curtailed`). `simulate` adds
  `re_ramp_ref` {`curtailed` (PV and wind, year 1), `curtail_fraction`, `bess_ch`, `bess_dis`, `fuel_l_y1`, `unmet_fraction`}:
  the same design without the limit. With the limit set at a 60 minute step nothing changes and `simulate` adds `re_ramp_note`
  (a sentence saying it is ignored).
- `optimize`: `optimizer.max_ramp_viol` (absent or null: no limit) caps each candidate's `ramp_viol` (the worst year's
  `re_ramp_viol`), which candidates carry only with the limit on; `settings` echoes it when set. A candidate that breaks it has
  `why` `ramp violations`.

## References

[1] R. Hooke and T. A. Jeeves, "'Direct search' solution of numerical and statistical problems," *J. ACM*, vol. 8, no. 2, pp. 212–229, Apr. 1961, doi: 10.1145/321062.321069.  
