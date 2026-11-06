//! One Tauri command per engine command of docs/ipc.md. Each runs the Rust engine (engine/src/api) on a blocking thread and
//! answers its JSON text as it is, so large results are not parsed twice. A panic in the engine becomes an internal error.
use crate::engine;
use soloptima_engine::api::{panic_message, Engine};
use soloptima_engine::Value;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use tauri::ipc::Response;

/// An engine error, serialised as `{"error": ..., "internal": bool}`; `internal` marks defects.
pub use soloptima_engine::api::ApiError;

/// Runs `f` on the engine in a blocking thread
pub async fn run(f: impl FnOnce(&Arc<Engine>) -> Result<String, ApiError> + Send + 'static) -> Result<String, ApiError> {
    let e = engine::get()?;
    tauri::async_runtime::spawn_blocking(move || std::panic::catch_unwind(AssertUnwindSafe(|| f(&e))))
        .await
        .map_err(|e| ApiError::internal(format!("The engine call failed: {e}")))?
        .unwrap_or_else(|p| Err(ApiError::internal(panic_message(p.as_ref()))))
}

/// A query argument as the page sends it: text, or a number (the Svelte screens pass job ids as they came, `{"job": 3}`)
#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum Arg {
    Text(String),
    Num(serde_json::Number),
}

impl Arg {
    fn text(self) -> String {
        match self { Arg::Text(s) => s, Arg::Num(n) => n.to_string() }
    }
}

/// The request body in the engine's JSON (null when the page sends none)
fn value(body: Option<serde_json::Value>) -> Value { body.map(Value::from).unwrap_or(Value::Null) }

/// `name [query arguments] |engine, body, body text length| call`: query arguments the page leaves out are "" (a new project
/// has no id); the body is the engine's JSON value. The text length is counted only for report_save (its 24 MB limit).
macro_rules! commands {
    ($($name:ident [$($q:ident),*] |$e:ident, $b:ident, $n:ident| $call:expr;)*) => {$(
        #[tauri::command]
        #[allow(unused_variables)]
        pub async fn $name($($q: Option<Arg>,)* body: Option<serde_json::Value>) -> Result<Response, ApiError> {
            $(let $q = $q.map(Arg::text).unwrap_or_default();)*
            let $n = if stringify!($name) == "report_save" { body.as_ref().map_or(0, |b| b.to_string().len()) } else { 0 };
            let $b = value(body);
            run(move |$e| Ok($call?)).await.map(Response::new)
        }
    )*};
}

commands! {
    info [] |e, b, n| e.info();
    users [] |e, b, n| e.users();
    user_create [] |e, b, n| e.user_create(&b);
    users_terms [id] |e, b, n| e.users_terms(&id, &b);
    users_update [id] |e, b, n| e.users_update(&id, &b);
    users_delete [id] |e, b, n| e.users_delete(&id);
    settings [] |e, b, n| e.settings();
    settings_update [] |e, b, n| e.settings_update(&b);
    settings_data_dir [] |e, b, n| e.settings_data_dir(&b);
    cache_clear [] |e, b, n| e.cache_clear();
    projects [user] |e, b, n| e.projects(&user);
    project_load [user, id] |e, b, n| e.project_load(&user, &id);
    project_save [user, id] |e, b, n| e.project_save(&user, &id, &b);
    project_delete [user, id] |e, b, n| e.project_delete(&user, &id);
    project_duplicate [user, id] |e, b, n| e.project_duplicate(&user, &id);
    reports [] |e, b, n| e.reports();
    report_load [id] |e, b, n| e.report_load(&id);
    report_save [] |e, b, n| e.report_save(&b, n);
    report_delete [id] |e, b, n| e.report_delete(&id);
    weather [] |e, b, n| e.weather(&b);
    horizon [] |e, b, n| e.horizon(&b);
    forecast_weather [] |e, b, n| e.forecast_weather(&b);
    import_series [] |e, b, n| e.import_series(&b);
    data_qc [] |e, b, n| e.data_qc(&b);
    pv [] |e, b, n| e.pv(&b);
    pv_reference [] |e, b, n| e.pv_reference(&b);
    tilt_scan [] |e, b, n| e.tilt_scan(&b);
    forecast_benchmark [] |e, b, n| e.forecast_benchmark(&b);
    forecast_methods [] |e, b, n| e.forecast_methods();
    batch [] |e, b, n| e.batch(&b);
    simulate [] |e, b, n| e.simulate(&b);
    ems_schedule [] |e, b, n| e.ems_schedule(&b);
    optimize [] |e, b, n| e.optimize(&b);
    resource_years [] |e, b, n| e.resource_years(&b);
    job [id] |e, b, n| e.job(&id);
    job_cancel [id] |e, b, n| e.job_cancel(&id);
}

/// LICENSE, TERMS.md or THIRD_PARTY_NOTICES.md as text (not JSON)
#[tauri::command]
pub async fn legal(doc: String) -> Result<String, ApiError> {
    run(move |e| e.legal(&doc)).await
}

#[cfg(test)]
mod tests {
    //! The commands as the page invokes them (argument names and types, answers, errors), on Tauri's mock runtime
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn invoke(w: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
        let req = InvokeRequest {
            cmd: cmd.into(), callback: CallbackFn(0), error: CallbackFn(1), url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args), headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(w, req).map(|b| match b {
            InvokeResponseBody::Json(t) => serde_json::from_str(&t).unwrap_or(Value::String(t)),
            InvokeResponseBody::Raw(r) => {
                let t = String::from_utf8(r).unwrap();
                serde_json::from_str(&t).unwrap_or(Value::String(t))
            }
        })
    }

    #[test]
    fn commands_answer_as_the_page_calls_them() {
        let dir = std::env::temp_dir().join(format!("soloptima-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::engine::init(concat!(env!("CARGO_MANIFEST_DIR"), "/.."), dir.to_str().unwrap()).unwrap();
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![super::info, super::legal, super::user_create, super::projects, super::project_save,
                                                     super::project_load, super::import_series, super::simulate, super::optimize, super::job,
                                                     super::job_cancel, super::forecast_methods])
            .build(mock_context(noop_assets()))
            .unwrap();
        let w = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();

        let info = invoke(&w, "info", json!({})).unwrap();
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert!(invoke(&w, "legal", json!({"doc": "license"})).unwrap().as_str().unwrap().contains("Apache License"));
        assert_eq!(invoke(&w, "forecast_methods", json!({})).unwrap()["load"].as_array().unwrap().len(), 11);
        let e = invoke(&w, "import_series", json!({"body": {}})).unwrap_err();
        assert_eq!(e, json!({"error": "The file text is missing.", "internal": false}));

        let u = invoke(&w, "user_create", json!({"body": {"name": "Test", "terms_version": "1"}})).unwrap();
        let user = u["id"].as_str().unwrap().to_string();
        let meta = invoke(&w, "project_save", json!({"user": user, "body": {"project": {"name": "A"}, "meta": {}}})).unwrap();
        let id = meta["id"].as_str().unwrap();
        assert_eq!(invoke(&w, "project_load", json!({"user": user, "id": id})).unwrap()["name"], "A");
        assert_eq!(invoke(&w, "projects", json!({"user": user})).unwrap().as_array().unwrap().len(), 1);

        let ex: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/examples/example_study.json")).unwrap()).unwrap();
        let sim = invoke(&w, "simulate", json!({"body": ex})).unwrap();
        assert!(sim["result"]["re_fraction"].as_f64().unwrap() > 0.1);
        // the job id goes back as a number (Svelte) or as text (the old screens)
        let started = invoke(&w, "optimize", json!({"body": {"project": ex, "optimizer": {"pv_steps": 2, "bess_steps": 2, "refine": false}}})).unwrap();
        let job = started["job"].clone();
        assert!(job.is_number());
        let t0 = std::time::Instant::now();
        loop {
            let s = invoke(&w, "job", json!({"id": job})).unwrap();
            if s["done"] == true {
                assert!(s["result"].is_object(), "{s}");
                break;
            }
            assert!(t0.elapsed().as_secs() < 300);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(invoke(&w, "job", json!({"id": job.to_string()})).unwrap()["done"], true);
        assert_eq!(invoke(&w, "job_cancel", json!({"id": job})).unwrap(), json!({"ok": true}));
        assert_eq!(invoke(&w, "job", json!({"id": 999})).unwrap_err()["error"], "No such job.");
        std::fs::remove_dir_all(&dir).ok();
    }
}
