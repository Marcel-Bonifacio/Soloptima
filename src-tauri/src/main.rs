//! Soloptima desktop shell (rewrite phase 1). Starts the linked C++ engine and shows its interface (web/) in a Tauri
//! window. Options: --data DIR (projects folder), --web DIR (interface folder).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Fixed, so the page's browser storage (its origin includes the port) stays between runs. One above the v1 app's 47816,
/// so both can run side by side; the engine takes the next free port when it is taken.
const PORT: u16 = 47817;

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

/// The interface folder: --web, else the bundled copy (Resources/web), else the repository's web/ (development builds)
fn web_root(app: &AppHandle) -> PathBuf {
    if let Some(w) = arg("--web") {
        return PathBuf::from(w);
    }
    match app.path().resource_dir() {
        Ok(r) if r.join("web/index.html").is_file() => r.join("web"),
        _ => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../web")),
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            APP.set(handle.clone()).ok();
            engine::on_quit(quit);
            let web = web_root(&handle);
            let url = engine::start(&web.to_string_lossy(), &arg("--data").unwrap_or_default(), PORT)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Soloptima")
                .inner_size(1360.0, 860.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Soloptima could not start");
}
