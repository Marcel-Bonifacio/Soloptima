//! One Tauri command per /api route of the engine (docs/ipc.md). Each runs the engine call on a blocking thread and answers
//! the route's JSON text as it is, so large results are not parsed twice. Phase 2 replaces a command's body with the Rust
//! engine, one module at a time; the interface does not notice.
use crate::engine;
use serde::Serialize;
use tauri::ipc::Response;

/// An engine error, serialised as the `{"error": ..., "internal": bool}` body of today's API. `internal` marks defects.
#[derive(Serialize, Debug)]
pub struct ApiError {
    pub error: String,
    pub internal: bool,
}

impl ApiError {
    pub fn new(error: impl Into<String>) -> Self {
        ApiError { error: error.into(), internal: false }
    }
    pub fn internal(error: impl Into<String>) -> Self {
        ApiError { error: error.into(), internal: true }
    }
}

/// Query parameters in the form the engine decodes (percent-encoded, as a browser sends them)
fn encode(v: &str) -> String {
    let mut o = String::new();
    for b in v.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { o.push(b as char) } else { o.push_str(&format!("%{b:02X}")) }
    }
    o
}

/// The engine's answer on success (a query argument the page leaves out is left out, e.g. the id of a new project); its error body (or the plain text of a non-JSON error) otherwise
pub async fn run(method: &'static str, path: &'static str, query: &[(&str, Option<String>)], body: Option<serde_json::Value>)
    -> Result<String, ApiError> {
    let query = query.iter().filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", encode(v)))).collect::<Vec<_>>().join("&");
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let (status, text) = tauri::async_runtime::spawn_blocking(move || engine::call(method, path, &query, &body))
        .await
        .map_err(|e| ApiError::internal(format!("The engine call failed: {e}")))?
        .map_err(ApiError::internal)?;
    if status == 200 {
        return Ok(text);
    }
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(j) if j.get("error").is_some() => Err(ApiError {
            error: j["error"].as_str().unwrap_or("Unknown error").to_string(),
            internal: j.get("internal").and_then(|i| i.as_bool()).unwrap_or(false) || status != 400,
        }),
        _ => Err(ApiError::internal(if text.is_empty() { format!("HTTP {status}") } else { text })),
    }
}

macro_rules! routes {
    ($($name:ident: $method:literal $path:literal [$($q:ident),*];)*) => {$(
        #[tauri::command]
        pub async fn $name($($q: Option<String>,)* body: Option<serde_json::Value>) -> Result<Response, ApiError> {
            run($method, $path, &[$((stringify!($q), $q)),*], body).await.map(Response::new)
        }
    )*};
}

routes! {
    info: "GET" "/api/info" [];
    users: "GET" "/api/users" [];
    user_create: "POST" "/api/users" [];
    users_terms: "POST" "/api/users/terms" [id];
    users_update: "POST" "/api/users/update" [id];
    users_delete: "POST" "/api/users/delete" [id];
    settings: "GET" "/api/settings" [];
    settings_update: "POST" "/api/settings/update" [];
    settings_data_dir: "POST" "/api/settings/data-dir" [];
    cache_clear: "POST" "/api/cache/clear" [];
    update_check: "GET" "/api/update/check" [];
    update_download: "POST" "/api/update/download" [];
    update_install: "POST" "/api/update/install" [];
    projects: "GET" "/api/projects" [user];
    project_load: "GET" "/api/project" [user, id];
    project_save: "POST" "/api/project" [user, id];
    project_delete: "POST" "/api/project/delete" [user, id];
    project_duplicate: "POST" "/api/project/duplicate" [user, id];
    reports: "GET" "/api/reports" [];
    report_load: "GET" "/api/report" [id];
    report_save: "POST" "/api/report" [];
    report_delete: "POST" "/api/report/delete" [id];
    weather: "POST" "/api/weather" [];
    horizon: "POST" "/api/horizon" [];
    forecast_weather: "POST" "/api/forecast-weather" [];
    import_series: "POST" "/api/import-series" [];
    data_qc: "POST" "/api/data-qc" [];
    pv: "POST" "/api/pv" [];
    pv_reference: "POST" "/api/pv-reference" [];
    tilt_scan: "POST" "/api/tilt-scan" [];
    forecast_benchmark: "POST" "/api/forecast/benchmark" [];
    forecast_methods: "GET" "/api/forecast/methods" [];
    batch: "POST" "/api/batch" [];
    simulate: "POST" "/api/simulate" [];
    ems_schedule: "POST" "/api/ems/schedule" [];
    optimize: "POST" "/api/optimize" [];
    resource_years: "POST" "/api/resource-years" [];
    job: "GET" "/api/job" [id];
    job_cancel: "POST" "/api/job/cancel" [id];
}

/// LICENSE, TERMS.md or THIRD_PARTY_NOTICES.md as text (not JSON)
#[tauri::command]
pub async fn legal(doc: String) -> Result<String, ApiError> {
    run("GET", "/api/legal", &[("doc", Some(doc))], None).await
}
