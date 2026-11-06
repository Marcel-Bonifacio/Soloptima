//! Soloptima desktop shell. Links the Rust engine (engine/) and shows the interface (web/) in a Tauri window; the
//! interface reaches the engine through the commands of commands.rs and the system through native.rs (docs/ipc.md).
//! Option: --data DIR (projects folder for this run; it also lets a second copy run next to a first).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod engine;
mod native;
mod update;

use commands::*;
use native::*;
use update::*;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

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

/// Pages of the interface stay in the window; any other address opens in the user's browser. The interface is served from
/// tauri://localhost (macOS, Linux) or http(s)://tauri.localhost (Windows); other local servers are not the app.
fn is_own(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// The Google Maps view of the site page (the only frame the content policy allows). The navigation handler also sees the
/// frames' loads and cannot tell them from the window's, so without this the view opened in the browser instead.
fn is_map_view(url: &tauri::Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("www.google.com") && url.port().is_none() && url.path().starts_with("/maps/embed")
}

/// The app's configuration; a build for an update test server (update::TEST_KEY) also takes plain http downloads
fn context() -> tauri::Context {
    let mut ctx = tauri::generate_context!();
    if update::TEST_KEY.is_some() {
        if let Some(u) = ctx.config_mut().plugins.0.get_mut("updater") {
            u["dangerousInsecureTransportProtocol"] = true.into();
        }
    }
    ctx
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Updates::default())
        .manage(Quit::default())
        .invoke_handler(tauri::generate_handler![
            info, legal, users, user_create, users_terms, users_update, users_delete, settings, settings_update,
            settings_data_dir, settings_pick_folder, cache_clear, update_check, update_download, update_progress, update_install, projects,
            project_load, project_save, project_delete, project_duplicate, reports, report_load, report_save,
            report_delete, weather, horizon, forecast_weather, import_series, data_qc, pv, pv_reference, tilt_scan,
            forecast_benchmark, forecast_methods, batch, simulate, ems_schedule, optimize, resource_years, job,
            job_cancel, save_file, print_report, open_url, open_folder, quit_ack, quit_ready, quit_cancel,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            engine::init(&legal_dir(&handle).to_string_lossy(), &arg("--data").unwrap_or_default())?;
            let nav = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Soloptima")
                .inner_size(1360.0, 860.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    if is_own(url) || is_map_view(url) { return true; }
                    let _ = open_external(&nav, url.as_str());
                    false
                })
                .build()?;
            #[cfg(target_os = "macos")]
            native::mac_quit::install(&handle);
            update::selftest(&handle);
            Ok(())
        })
        .build(context())
        .expect("Soloptima could not start");
    app.run(|app, event| match event {
        // closing the window and Quit both let the page save first (on macOS the system's Quit goes through native::mac_quit)
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


#[cfg(test)]
mod tests {
    #[test]
    fn only_the_interface_stays_in_the_window() {
        let own = |u: &str| super::is_own(&u.parse().unwrap());
        for u in ["tauri://localhost/index.html", "http://tauri.localhost/index.html", "https://tauri.localhost/x", "about:blank", "about:srcdoc"] {
            assert!(own(u), "{u}");
        }
        for u in ["http://localhost:8080/", "http://127.0.0.1:47817/", "https://example.com/", "http://tauri.localhost.evil.com/",
                  "file:///etc/passwd", "mailto:a@b.c"] {
            assert!(!own(u), "{u}");
        }
    }

    #[test]
    fn the_map_view_loads_in_its_frame() {
        let map = |u: &str| super::is_map_view(&u.parse().unwrap());
        assert!(map("https://www.google.com/maps/embed?origin=mfe&pb=!1m4!2m1!1s7,-1!5e1!6i17"));
        for u in ["http://www.google.com/maps/embed?pb=x", "https://www.google.com/maps/@7,-1,700m", "https://www.google.com/search?q=x",
                  "https://www.google.com.evil.com/maps/embed", "https://evil.com/maps/embed", "https://www.google.com:8443/maps/embed"] {
            assert!(!map(u), "{u}");
        }
    }
}
