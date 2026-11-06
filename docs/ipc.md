# Desktop shell and IPC contract

The desktop app is a Tauri 2 shell (`src-tauri/`) around the engine. This file is the contract the rewrite sessions
follow: how the shell reaches the engine, and one Tauri command per `/api/*` route of `src/main.cpp`.

## How the engine is linked

The C++ engine is compiled into the shell binary by `src-tauri/build.rs` (the `cc` crate builds `src/*.cpp` with
`SOLOPTIMA_EMBEDDED`, which leaves out the engine's own `main()`). It is called through a small C interface, not run as a
sidecar:

| C function | Rust wrapper (`src-tauri/src/engine.rs`) | Use |
|---|---|---|
| `soloptima_init(legal_dir, data)` | `engine::init` | builds the routes; `data` empty = Settings or default folder |
| `soloptima_call(method, path, query, body, len, &status)` | `engine::call` | any route in process: no socket, no key |
| `soloptima_free(p)` | (inside `engine::call`) | frees what `soloptima_call` returned |

Why FFI and not a sidecar process:

- One binary to sign, notarise and update (session 1.3). A sidecar is a second executable per platform and architecture.
- Commands call the routes directly (`Router::call`), and long jobs keep their in-process job table.
- Phase 2 swaps engine modules one command at a time: a command body changes from `engine::call(...)` to the Rust
  function, and the interface does not notice. Session 2.12 deletes `build.rs`'s C++ part and `engine.rs`.

The standalone C++ build (`make`, `make test`) is the command line (`./soloptima simulate|optimize`) and the tests. It has
no server and no window; the C interface is compiled in but unused there.

## State after session 1.2

- No HTTP server, no port, no session key, no launch code, no instance file, no `serve` command. `src/router.cpp` is a
  map from method and path to a handler. The window loads `web/` from Tauri's own asset protocol (`frontendDist`).
- The page (`web/js/util.js`) turns `api('/api/x?q=1', body)` into `invoke('x', {q: '1', body})` (`toCommand`); `Native`
  holds `invoke` and `listen` for the shell's own commands. Without Tauri (a plain browser) every call fails with a
  message to start the app.
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

## Rules for the commands

- Name: the route path after `/api/`, with `/` and `-` as `_`: `/api/project/delete` is `project_delete`,
  `/api/forecast-weather` is `forecast_weather`. `GET /api/project` and `POST /api/project` become `project_load` and
  `project_save`; likewise `user_create`, `report_load`, `report_save`.
- Arguments: query parameters become named arguments (`user`, `id`, `doc`), all optional (a new project has no `id`); a
  JSON body is passed as one argument `body` (`serde_json::Value`). The interface keeps sending the bodies it sends today,
  so `users_terms`, `settings_data_dir` and the like take their fields from `body`, not from the query.
- Result: `Result<tauri::ipc::Response, ApiError>`: the engine's JSON text as it is, so large results are not parsed twice
  (`legal` answers a plain string).
- Errors: `ApiError { error: String, internal: bool }`, serialised as today's `{"error": ..., "internal": true}` body.
  `internal` marks defects (the interface files a bug report), as in `server.cpp`.
- Long runs stay jobs: the command answers `{"job": id}` at once; the page polls `job` and may call `job_cancel`.
  (A Tauri `Channel` for progress is a later improvement, not part of the port.)
- Commands are `async` and run the engine on a blocking thread (`tauri::async_runtime::spawn_blocking`), so a long call
  never blocks the window.
- The interface reaches them through one function: `api(path, body, method)` in `web/js/util.js` maps the path to a command
  and calls `invoke`. The engine routes are `src-tauri/src/commands.rs` (one macro line each); the system's own features
  are in `src-tauri/src/native.rs`.
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
| `POST /api/update/install` | `update_install` | | shell; `{mode: replaced \| installer}`, then restarts |
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
| `POST /api/batch` | `batch` | body: `project`, `cases` | |
| `POST /api/simulate` | `simulate` | body (project) | |
| `POST /api/ems/schedule` | `ems_schedule` | body: `project`, `forecast`, `soc_now`, `load_scale`, `now_utc`, `days` | |
| `POST /api/optimize` | `optimize` | body: `project`, `optimizer` | J |
| `POST /api/resource-years` | `resource_years` | body: `project`, `source`, `from`, `to`, `budget` | J |
| `GET /api/job` | `job` | `id` | `{done, progress, total}` or `{done, result}` / `{done, error}` |
| `POST /api/job/cancel` | `job_cancel` | `id` | |

Routes that ended with the HTTP server in session 1.2: `POST /api/shutdown` (now `quit_ready`), `GET /api/health` and
`POST /api/session` (no equivalent: there is no socket and no key). The engine answers 404 for all three.

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
(`validate.rs`). The app does not use it yet; session 2.12 switches the commands over.

- A document is saved as `Value::dump()`: compact, keys sorted, numbers as the C++ writer prints them. Loading and saving
  the example project gives the bytes the C++ engine writes (`engine/tests/model.rs`).
- `validate_project` returns the C++ messages. Expected results come from the C++ engine itself:
  `engine/tests/fixtures/*.json` are written by `tests/gen_model_fixtures.cpp`.
- Known differences: a lone surrogate escape in a string is read as U+FFFD (C++ keeps invalid bytes); hexadecimal floats
  are not read; `serde` output of a layout area with an unset (NaN) tilt is `null`, which does not read back, so the
  document, not the struct, is what is saved.
