//! The C++ engine linked into this binary (build.rs). `call` reaches any /api route in process, no socket and no key;
//! commands.rs wraps it into the Tauri commands of docs/ipc.md. Phase 2 replaces the bodies of those commands with the
//! Rust engine, one module at a time.

use std::ffi::{c_char, c_int, CStr, CString};

extern "C" {
    fn soloptima_init(legal_dir: *const c_char, data: *const c_char) -> *const c_char;
    fn soloptima_call(method: *const c_char, path: *const c_char, query: *const c_char, body: *const c_char,
                      body_len: usize, status: *mut c_int) -> *mut c_char;
    fn soloptima_free(p: *mut c_char);
}

/// Sets up the engine's routes. `legal_dir` holds LICENSE, TERMS.md and THIRD_PARTY_NOTICES.md; an empty `data` takes the
/// projects folder from Settings or the default (find_data_dir in src/main.cpp).
pub fn init(legal_dir: &str, data: &str) -> Result<(), String> {
    let (legal, data) = (cstr(legal_dir)?, cstr(data)?);
    // SAFETY: the engine copies both strings; the returned message is valid until the next call
    let err = unsafe { CStr::from_ptr(soloptima_init(legal.as_ptr(), data.as_ptr())) };
    if err.to_bytes().is_empty() { Ok(()) } else { Err(err.to_string_lossy().into_owned()) }
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

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "A path or argument contains a NUL character.".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn routes_answer_in_process() {
        let dir = std::env::temp_dir().join(format!("soloptima-ffi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        super::init(concat!(env!("CARGO_MANIFEST_DIR"), "/.."), dir.to_str().unwrap()).unwrap();

        let (status, body) = super::call("GET", "/api/forecast/methods", "", "").unwrap();
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("\"pv\"") && body.contains("\"load\""), "{body}");
        let (status, body) = super::call("GET", "/api/nope", "", "").unwrap();
        assert_eq!((status, body.contains("unknown endpoint")), (404, true));
        let (status, body) = super::call("POST", "/api/import-series", "", "{}").unwrap();
        assert_eq!((status, body.contains("file text is missing")), (400, true));
        let (status, body) = super::call("GET", "/api/legal", "doc=terms", "").unwrap();
        assert_eq!((status, body.starts_with("# ") || body.contains("Terms")), (200, true));
        for gone in ["/api/health", "/api/session", "/api/shutdown"] {
            assert_eq!(super::call("GET", gone, "", "").unwrap().0, 404, "{gone}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
