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
        finish_quit(&app);
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
        if wait(QUIT_ANSWER, true) && !acked.load(Ordering::SeqCst) { finish_quit(&app); return; }   // the page never took it
        if wait(QUIT_SAVE, false) { finish_quit(&app); }
    });
}

/// The page took the quit request and is saving
#[tauri::command]
pub fn quit_ack(q: tauri::State<'_, Quit>) {
    q.acked.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn quit_ready(app: AppHandle) {
    finish_quit(&app);
}

#[tauri::command]
pub fn quit_cancel(app: AppHandle, q: tauri::State<'_, Quit>) {
    q.pending.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    mac_quit::reply(&app, false);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The work is saved (or the page did not answer): exit. A quit that macOS asked for is answered instead, and macOS ends
/// the app.
fn finish_quit(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if mac_quit::reply(app, true) { return; }
    app.exit(0);
}

/// Quit from the system on macOS: the app menu's Quit (Cmd+Q), the Dock's Quit, logging out or shutting down. AppKit sends
/// these to the application delegate, which tao does not ask (it has no `applicationShouldTerminate:`), so the app ended
/// at once and changes not yet saved were lost. `install` gives tao's delegate that method: it answers "later", asks the
/// page to save (`request_quit`) and `reply` lets macOS go on once the page is done, or stops the quit when a save failed
/// and the user keeps the window.
#[cfg(target_os = "macos")]
pub mod mac_quit {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// macOS waits for an answer to its quit
    static WAITING: AtomicBool = AtomicBool::new(false);
    const NS_TERMINATE_NOW: usize = 1;
    const NS_TERMINATE_LATER: usize = 2;

    extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        let Some(app) = APP.get() else { return NS_TERMINATE_NOW };
        WAITING.store(true, Ordering::SeqCst);
        super::request_quit(app);
        NS_TERMINATE_LATER
    }

    /// Call once on the main thread, after the event loop exists (tao has set its delegate by then)
    pub fn install(app: &AppHandle) {
        if APP.set(app.clone()).is_err() { return; }
        let Some(cls) = AnyClass::get(c"TaoAppDelegateParent") else { return };
        unsafe {
            let imp: Imp = std::mem::transmute(should_terminate as extern "C-unwind" fn(_, _, _) -> _);
            let added = objc2::ffi::class_addMethod(cls as *const AnyClass as *mut AnyClass, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
            if !added.as_bool() { return; }
            // AppKit notes what a delegate can answer when it is set: set it again so the new method counts
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            let _: () = msg_send![ns_app, setDelegate: delegate];
        }
    }

    /// Answers a quit macOS is waiting for: `go` ends the app, otherwise it keeps running. False when macOS was not waiting.
    pub fn reply(app: &AppHandle, go: bool) -> bool {
        if !WAITING.swap(false, Ordering::SeqCst) { return false; }
        let _ = app.run_on_main_thread(move || unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, replyToApplicationShouldTerminate: Bool::new(go)];
        });
        true
    }
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

/// A new folder for one print under `base` (the system's temporary folder): a random name, created by this call and the owner's
/// alone (0700). A name that already exists is never used, so nobody else's folder or link there can receive the report.
pub(crate) fn private_print_dir(base: &Path) -> std::io::Result<PathBuf> {
    use std::hash::{BuildHasher, Hasher};
    for _ in 0..16 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();   // keys from the system's random source
        h.write_u32(std::process::id());
        let dir = base.join(format!("soloptima-print-{:016x}", h.finish()));
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        match b.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no free name for the print folder"))
}

/// Writes the report into a new private folder (`private_print_dir`); the file is created exclusively, 0600, never through a
/// link (the engine's `write_atomic`). Returns the folder and the file.
pub(crate) fn write_print_file(base: &Path, html: &str) -> Result<(PathBuf, PathBuf), ApiError> {
    let dir = private_print_dir(base).map_err(|e| ApiError::new(format!("Cannot prepare the report for printing: {e}")))?;
    let file = dir.join("report.html");
    let csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:\">";
    if let Err(e) = soloptima_engine::storage::write_atomic(&file, &format!("{csp}{html}")) {
        std::fs::remove_dir_all(&dir).ok();
        return Err(ApiError::new(e.0));
    }
    Ok((dir, file))
}

/// Prints a report: it is written to a folder of its own (`write_print_file`) and shown in a window that has no access to the
/// app, whose content policy forbids scripts and network and which cannot navigate anywhere else, then handed to the system's
/// print dialog. The folder goes as soon as the page has loaded, on every system.
#[tauri::command]
pub async fn print_report(app: AppHandle, html: String) -> Result<(), ApiError> {
    let (dir, file) = write_print_file(&std::env::temp_dir(), &html)?;
    if let Some(old) = app.get_webview_window("print") { old.destroy().ok(); }
    let url = match tauri::Url::from_file_path(&file) {
        Ok(u) => u,
        Err(_) => { std::fs::remove_dir_all(&dir).ok(); return Err(ApiError::internal("The report path is not valid.")); }
    };
    let own = url.clone();
    let loaded = dir.clone();
    let win = WebviewWindowBuilder::new(&app, "print", WebviewUrl::External(url))
        .title("Soloptima report").inner_size(900.0, 700.0).visible(false)
        // the report itself only: a link or a refresh in it does not load anything else in an app window
        .on_navigation(move |u| u.scheme() == "about" || (u.scheme() == "file" && u.path().eq_ignore_ascii_case(own.path())))
        .on_page_load(move |w, p| {
            if let tauri::webview::PageLoadEvent::Finished = p.event() {
                std::fs::remove_dir_all(&loaded).ok();   // the page is in the window now (its images are data URLs)
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
        .build();
    let win = match win {
        Ok(w) => w,
        Err(e) => { std::fs::remove_dir_all(&dir).ok(); return Err(ApiError::internal(e.to_string())); }
    };
    win.on_window_event(move |e| { if let tauri::WindowEvent::Destroyed = e { std::fs::remove_dir_all(&dir).ok(); } });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_print_gets_a_new_private_folder() {
        let base = std::env::temp_dir().join(format!("soloptima-print-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let (d1, f1) = write_print_file(&base, "<p>one</p>").unwrap();
        let (d2, _) = write_print_file(&base, "<p>two</p>").unwrap();
        assert_ne!(d1, d2);
        assert_eq!(f1, d1.join("report.html"));
        let text = std::fs::read_to_string(&f1).unwrap();
        assert!(text.starts_with("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';") && text.ends_with("<p>one</p>"));
        // the folder holds the report and nothing else (no temporary file left behind)
        assert_eq!(std::fs::read_dir(&d1).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!((mode(&d1), mode(&f1)), (0o700, 0o600));
        }
        // a base that cannot hold a folder is an error, not a write somewhere else
        assert!(write_print_file(&base.join("missing/deeper"), "x").is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
