//! Soloptima desktop shell (rewrite phase 1). Links the C++ engine and shows the interface (web/) in a Tauri window; the
//! interface reaches the engine through the commands of commands.rs and the system through native.rs (docs/ipc.md).
//! Option: --data DIR (projects folder for this run; it also lets a second copy run next to a first).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod native;

use commands::*;
use native::*;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" fn quit() {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// The folder with LICENSE, TERMS.md and THIRD_PARTY_NOTICES.md: the bundle's resources, else the repository (development)
fn legal_dir(app: &AppHandle) -> PathBuf {
    match app.path().resource_dir() {
        Ok(r) if r.join("TERMS.md").is_file() => r,
        _ => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/..")),
    }
}

/// Pages of the interface stay in the window; any other address opens in the user's browser
fn is_own(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

fn main() {
    let mut app = tauri::Builder::default();
    // one copy per user, unless --data names another projects folder (tests, a second profile)
    #[cfg(desktop)]
    if arg("--data").is_none() {
        app = app.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    let app = app
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Quit::default())
        .invoke_handler(tauri::generate_handler![
            info, legal, users, user_create, users_terms, users_update, users_delete, settings, settings_update,
            settings_data_dir, settings_pick_folder, cache_clear, update_check, update_download, update_install, projects,
            project_load, project_save, project_delete, project_duplicate, reports, report_load, report_save,
            report_delete, weather, horizon, forecast_weather, import_series, data_qc, pv, pv_reference, tilt_scan,
            forecast_benchmark, forecast_methods, batch, simulate, ems_schedule, optimize, resource_years, job,
            job_cancel, save_file, print_report, open_url, open_folder, quit_ack, quit_ready, quit_cancel,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            APP.set(handle.clone()).ok();
            engine::on_quit(quit);
            engine::init(&legal_dir(&handle).to_string_lossy(), &arg("--data").unwrap_or_default())?;
            let nav = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Soloptima")
                .inner_size(1360.0, 860.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    if is_own(url) { return true; }
                    let _ = open_external(&nav, url.as_str());
                    false
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Soloptima could not start");
    app.run(|app, event| match event {
        // closing the window and Quit (Cmd+Q) both let the page save first
        RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
            api.prevent_close();
            request_quit(app);
        }
        RunEvent::ExitRequested { api, code: None, .. } => {
            api.prevent_exit();
            request_quit(app);
        }
        _ => {}
    });
}

