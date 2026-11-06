# Desktop shell and IPC contract

The desktop app is a Tauri 2 shell (`src-tauri/`) around the engine. This file is the contract the rewrite sessions
follow: how the shell reaches the engine, and one Tauri command per `/api/*` route of `src/main.cpp`.

## How the engine is linked (phase 1)

The C++ engine is compiled into the shell binary by `src-tauri/build.rs` (the `cc` crate builds `src/*.cpp` without the
native windows `app_*`, with `SOLOPTIMA_EMBEDDED`). It is called through a small C interface, not run as a sidecar:

| C function | Rust wrapper (`src-tauri/src/engine.rs`) | Use |
|---|---|---|
| `soloptima_start(web, data, port)` | `engine::start` | runs the HTTP server on 127.0.0.1 for the window (until session 1.2) |
| `soloptima_call(method, path, query, body, len, &status)` | `engine::call` | any route in process, no socket, no session key |
| `soloptima_free(p)` | (inside `engine::call`) | frees what `soloptima_call` returned |
| `soloptima_set_quit_hook(fn)` | `engine::on_quit` | `app_quit()` of the engine closes the Tauri app |

Why FFI and not a sidecar process:

- One binary to sign, notarise and update (session 1.3). A sidecar is a second executable per platform and architecture.
- Commands call the routes directly (`HttpServer::call`), so session 1.2 can drop the socket, the session key and the
  launch code without inventing a stdin/stdout protocol, and long jobs keep their in-process job table.
- Phase 2 swaps engine modules one command at a time: a command body changes from `engine::call(...)` to the Rust
  function, and the interface does not notice. Session 2.12 deletes `build.rs`'s C++ part and `engine.rs`.

The standalone C++ build (`make`, `make test`, `./soloptima serve`) is unchanged; `src/embedded.cpp` is empty there.

## Phase 1 state (session 1.1)

- The shell starts the engine on port 47817 (next free one when taken), then opens `http://127.0.0.1:<port>/#launch=<code>`
  in its window. The page trades the code for the session key as a browser tab does (`Native.app` is false), so save,
  print and quit use their browser fallbacks. The fixed port keeps the page's browser storage between runs.
- `--data DIR` and `--web DIR` work as in `soloptima app`. The bundle carries `web/` and the legal files as resources.
- Not done yet: the native bridge (save, print, open link), saving before the window closes, single instance. Session 1.2.

## Rules for the commands (session 1.2 on)

- Name: the route path after `/api/`, with `/` and `-` as `_`: `/api/project/delete` is `project_delete`,
  `/api/forecast-weather` is `forecast_weather`. `GET /api/project` and `POST /api/project` become `project_load` and
  `project_save`; likewise `user_create`, `report_load`, `report_save`.
- Arguments: query parameters become named arguments (`user`, `id`, `doc`); a JSON body is passed as one argument `body`
  (`serde_json::Value`) unless the table below names its fields. The interface keeps sending the bodies it sends today.
- Result: `Result<serde_json::Value, ApiError>`. Routes that already answer raw JSON text (`project_load`, `report_load`,
  `job` when done) return `tauri::ipc::Response` with that text, so large projects are not parsed twice.
- Errors: `ApiError { error: String, internal: bool }`, serialised as today's `{"error": ..., "internal": true}` body.
  `internal` marks defects (the interface files a bug report), as in `server.cpp`.
- Long runs stay jobs: the command answers `{"job": id}` at once; the page polls `job` and may call `job_cancel`.
  (A Tauri `Channel` for progress is a later improvement, not part of the port.)
- Commands are `async` and run the engine on a blocking thread (`tauri::async_runtime::spawn_blocking`), so a long call
  never blocks the window.
- The interface reaches them through one function: `api(path, body)` in `web/js/util.js` maps the path to a command and
  calls `invoke`. Nothing else in `web/js` changes in 1.2.
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
| `POST /api/settings/pick-folder` | `settings_pick_folder` | | 1.2: Tauri dialog plugin instead of the engine's picker |
| `POST /api/cache/clear` | `cache_clear` | | |
| `GET /api/update/check` | `update_check` | | 1.3: Tauri updater replaces the three update commands |
| `POST /api/update/download` | `update_download` | | J |
| `POST /api/update/install` | `update_install` | | quits the app |
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

Routes that end with the HTTP server in session 1.2, with no command:

| Route | Replaced by |
|---|---|
| `POST /api/shutdown` | `app_quit` command: the shell exits after the page has saved |
| `GET /api/health` | nothing: it only proved an engine on a port was this user's |
| `POST /api/session` | nothing: there is no session key without the socket |

Native bridge messages of today's windows (`Native.call` in `web/js/util.js`: `save`, `print`, `open`, `quit-ready`,
`quit-cancel`) become the commands `save_file`, `print_report`, `open_url`, `quit_ready`, `quit_cancel` in session 1.2.

A sketch of one command in session 1.2, to copy for the rest:

```rust
#[tauri::command]
async fn simulate(body: serde_json::Value) -> Result<serde_json::Value, ApiError> {
    post("/api/simulate", "", body).await   // phase 2: the Rust engine's simulate(), same result
}
```
