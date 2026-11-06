//! The Rust engine (engine/, crate soloptima-engine) as one value for the whole app: the data folder, the weather caches and the
//! running jobs. commands.rs reaches it through `get`.
use soloptima_engine::api::{ApiError, Engine};
use std::sync::{Arc, OnceLock};

static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();

/// Opens the data folder. `legal_dir` holds LICENSE, TERMS.md and THIRD_PARTY_NOTICES.md; an empty `data` takes the projects
/// folder from Settings or the default.
pub fn init(legal_dir: &str, data: &str) -> Result<(), String> {
    let e = Engine::new(legal_dir, data).map_err(|e| e.0)?;
    ENGINE.set(Arc::new(e)).map_err(|_| "The engine was already started.".to_string())
}

pub fn get() -> Result<Arc<Engine>, ApiError> {
    ENGINE.get().cloned().ok_or_else(|| ApiError::internal("The engine is not running."))
}
