//! What the page asks of the operating system: Save dialog, printing, opening links and folders, choosing a folder, and
//! quitting after the page has saved. Replaces the message bridge of the three C++ windows (docs/ipc.md).
use crate::commands::ApiError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// A page that has not taken the quit request within this time does not hold the window open; once it has, saving (or the
/// user's choice in a dialog) gets QUIT_SAVE.
const QUIT_ANSWER: Duration = Duration::from_secs(5);
const QUIT_SAVE: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct Quit {
    pending: AtomicBool,
    acked: Arc<AtomicBool>,
}

/// The window was closed or Quit was chosen: ask the page to save. It answers `quit_ready` (exit) or `quit_cancel` (a save
/// failed and the user keeps the window).
pub fn request_quit(app: &AppHandle) {
    let q = app.state::<Quit>();
    if q.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    q.acked.store(false, Ordering::SeqCst);
    if app.emit_to("main", "quit-request", ()).is_err() {
        app.exit(0);
        return;
    }
    let (app, acked) = (app.clone(), q.acked.clone());
    std::thread::spawn(move || {
        let wait = |limit: Duration, until_acked: bool| {
            let t0 = std::time::Instant::now();
            while t0.elapsed() < limit {
                if !app.state::<Quit>().pending.load(Ordering::SeqCst) { return false; }   // cancelled or done
                if until_acked && acked.load(Ordering::SeqCst) { return true; }
                std::thread::sleep(Duration::from_millis(100));
            }
            true
        };
        if wait(QUIT_ANSWER, true) && !acked.load(Ordering::SeqCst) { app.exit(0); return; }   // the page never took it
        if wait(QUIT_SAVE, false) { app.exit(0); }
    });
}

/// The page took the quit request and is saving
#[tauri::command]
pub fn quit_ack(q: tauri::State<'_, Quit>) {
    q.acked.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn quit_ready(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn quit_cancel(q: tauri::State<'_, Quit>) {
    q.pending.store(false, Ordering::SeqCst);
}

/// Save dialog, then the file. The bytes are the request body, the suggested name a header (URI-encoded).
#[tauri::command]
pub async fn save_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, ApiError> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err(ApiError::internal("No file data was sent.")) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(decode).unwrap_or_default();
    let name = name.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().set_file_name(if name.is_empty() { "soloptima.txt" } else { &name })
            .blocking_save_file() else { return Ok(json!({"cancelled": true})) };
        let path = path.into_path().map_err(|e| ApiError::new(e.to_string()))?;
        std::fs::write(&path, &data).map_err(|e| ApiError::new(format!("Cannot save {}: {e}", path.display())))?;
        Ok(json!({"path": path.to_string_lossy()}))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let (mut o, mut i) = (Vec::new(), 0);
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { o.push(v); i += 3; continue; }
        }
        o.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&o).into_owned()
}

/// Prints a report: it is written to a temporary file and shown in a window of its own that has no access to the app,
/// whose content policy forbids scripts and network, then handed to the system's print dialog.
#[tauri::command]
pub async fn print_report(app: AppHandle, html: String) -> Result<(), ApiError> {
    let dir = std::env::temp_dir().join(format!("soloptima-print-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::new(e.to_string()))?;
    let file = dir.join("report.html");
    let csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:\">";
    std::fs::write(&file, format!("{csp}{html}")).map_err(|e| ApiError::new(e.to_string()))?;
    if let Some(old) = app.get_webview_window("print") { old.destroy().ok(); }
    let url = tauri::Url::from_file_path(&file).map_err(|_| ApiError::internal("The report path is not valid."))?;
    let win = WebviewWindowBuilder::new(&app, "print", WebviewUrl::External(url))
        .title("Soloptima report").inner_size(900.0, 700.0).visible(false)
        .on_page_load(|w, p| {
            if let tauri::webview::PageLoadEvent::Finished = p.event() {
                let w = w.clone();
                // after layout; the print dialog belongs to the system, the window goes when it is done
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(400));
                    let _ = w.print();   // on macOS this returns when the dialog is done
                    #[cfg(target_os = "macos")]
                    let _ = w.destroy();
                });
            }
        })
        .build()
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let d = dir.clone();
    win.on_window_event(move |e| { if let tauri::WindowEvent::Destroyed = e { std::fs::remove_dir_all(&d).ok(); } });
    Ok(())
}

/// A web link in the user's browser. Only http(s) and mailto links.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), ApiError> {
    open_external(&app, &url)
}

pub fn open_external(app: &AppHandle, url: &str) -> Result<(), ApiError> {
    let u = tauri::Url::parse(url).map_err(|_| ApiError::new("That link is not valid."))?;
    if !matches!(u.scheme(), "http" | "https" | "mailto") { return Err(ApiError::new("Only web and e-mail links can be opened.")); }
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| ApiError::new(e.to_string()))
}

/// The projects or the reports folder in the file manager. Only the two folders the engine reports; no other path.
#[tauri::command]
pub async fn open_folder(app: AppHandle, which: String) -> Result<(), ApiError> {
    let info = crate::commands::run(|e| Ok(e.info()?)).await?;
    let info: Value = serde_json::from_str(&info).map_err(|e| ApiError::internal(e.to_string()))?;
    let key = match which.as_str() { "data" => "data_dir", "reports" => "reports_dir", _ => return Err(ApiError::new("Unknown folder.")) };
    let dir = PathBuf::from(info[key].as_str().unwrap_or(""));
    if !Path::new(&dir).is_dir() { return Err(ApiError::new("That folder does not exist yet.")); }
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| ApiError::new(e.to_string()))
}

/// The system's folder picker for the projects folder: `{"path": ...}`, empty when cancelled
#[tauri::command]
pub async fn settings_pick_folder(app: AppHandle) -> Result<Value, ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.dialog().file().set_title("Choose the folder for Soloptima projects").blocking_pick_folder();
        let path = match dir { Some(d) => d.into_path().map_err(|e| ApiError::new(e.to_string()))?.to_string_lossy().into_owned(), None => String::new() };
        Ok(json!({"path": path}))
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?
}
