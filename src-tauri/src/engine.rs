//! The C++ engine linked into this binary (build.rs). Phase 1 keeps it whole: `start` runs its HTTP server for the
//! window, and `call` reaches any /api route in process, which the Tauri commands of docs/ipc.md wrap in session 1.2.
//! Phase 2 replaces the bodies of those commands with the Rust engine, one module at a time.

// `call` gets its commands in session 1.2
#![allow(dead_code)]

use std::ffi::{c_char, c_int, CStr, CString};

extern "C" {
    fn soloptima_start(web: *const c_char, data: *const c_char, port: c_int) -> *const c_char;
    fn soloptima_call(method: *const c_char, path: *const c_char, query: *const c_char, body: *const c_char,
                      body_len: usize, status: *mut c_int) -> *mut c_char;
    fn soloptima_free(p: *mut c_char);
    fn soloptima_set_quit_hook(hook: extern "C" fn());
}

/// Starts the engine on 127.0.0.1 from `port` up (the first free one). Returns the address to open with its one-time
/// launch code. Empty `web` or `data` take the engine's defaults (find_web_root, find_data_dir in src/main.cpp).
pub fn start(web: &str, data: &str, port: u16) -> Result<String, String> {
    let (web, data) = (cstr(web)?, cstr(data)?);
    // SAFETY: the engine copies both strings; the returned one lives as long as the process
    let url = unsafe { CStr::from_ptr(soloptima_start(web.as_ptr(), data.as_ptr(), c_int::from(port))) };
    let url = url.to_string_lossy().into_owned();
    if url.is_empty() { Err("The Soloptima engine did not start (see the log).".into()) } else { Ok(url) }
}

/// One API call without the socket: `call("POST", "/api/simulate", "", body)`. Returns the HTTP status the route
/// answers and its JSON body ({"error": ..., "internal": bool} on failure).
pub fn call(method: &str, path: &str, query: &str, body: &str) -> Result<(u16, String), String> {
    let (m, p, q) = (cstr(method)?, cstr(path)?, cstr(query)?);
    let mut status: c_int = 0;
    // SAFETY: body is passed with its length; the result is copied, then freed by the engine's allocator
    unsafe {
        let out = soloptima_call(m.as_ptr(), p.as_ptr(), q.as_ptr(), body.as_ptr().cast(), body.len(), &mut status);
        if out.is_null() { return Err("The engine is out of memory.".into()); }
        let text = CStr::from_ptr(out).to_string_lossy().into_owned();
        soloptima_free(out);
        Ok((u16::try_from(status).unwrap_or(500), text))
    }
}

/// What the engine runs when the page asks to quit (POST /api/shutdown, after an update install).
pub fn on_quit(hook: extern "C" fn()) {
    // SAFETY: a plain function pointer, called from an engine thread
    unsafe { soloptima_set_quit_hook(hook) }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "A path or argument contains a NUL character.".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn routes_answer_in_process() {
        let dir = std::env::temp_dir().join(format!("soloptima-ffi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let web = concat!(env!("CARGO_MANIFEST_DIR"), "/../web");
        let url = super::start(web, dir.to_str().unwrap(), 47900).unwrap();
        assert!(url.starts_with("http://127.0.0.1:") && url.contains("#launch="), "{url}");

        let (status, body) = super::call("GET", "/api/forecast/methods", "", "").unwrap();
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"pv\"") && body.contains("\"load\""), "{body}");
        let (status, body) = super::call("GET", "/api/nope", "", "").unwrap();
        assert_eq!((status, body.contains("unknown endpoint")), (404, true));
        let (status, body) = super::call("POST", "/api/import-series", "", "{}").unwrap();
        assert_eq!((status, body.contains("file text is missing")), (400, true));
        std::fs::remove_dir_all(&dir).ok();
    }
}
