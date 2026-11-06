//! The engine as the desktop app calls it: one method per command of docs/ipc.md (the /api routes of the C++ engine's
//! src/main.cpp), each answering the JSON text of the route. The shell (src-tauri/src/commands.rs) runs them on a blocking thread;
//! the command line (src/bin/soloptima.rs) uses `run_simulation` and the optimiser directly.
mod compute;
mod jobs;

pub use compute::{forecast_days, pv_reference, run_simulation};
pub use jobs::{panic_message, Jobs};

use crate::json::{Error, Value};
use crate::resource::WeatherYearsCache;
use crate::storage::{change_data_dir, find_data_dir, settings_json, settings_update, DataDirState, Storage};
use crate::weather::WeatherService;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The version of this build (the workspace version in Cargo.toml)
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

type R = Result<String, Error>;

fn ok() -> R { Ok("{\"ok\":true}".into()) }
fn dump(v: Result<Value, Error>) -> R { v.map(|v| v.dump()) }
fn path_str(p: &Path) -> String { p.to_string_lossy().into_owned() }

/// An engine error as the interface receives it: `{"error": ..., "internal": bool}`. `internal` marks defects (the interface
/// files a bug report): failures of the data folder itself and panics, as the C++ router marked filesystem and logic errors.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ApiError {
    pub error: String,
    pub internal: bool,
}

impl ApiError {
    pub fn new(error: impl Into<String>) -> Self { ApiError { error: error.into(), internal: false } }
    pub fn internal(error: impl Into<String>) -> Self { ApiError { error: error.into(), internal: true } }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        let internal = e.0.starts_with("Cannot use the data folder: ");
        ApiError { error: e.0, internal }
    }
}

/// The engine's state for the app: the data folder, the weather services and their caches, and the running jobs
pub struct Engine {
    legal_dir: PathBuf,
    store: Storage,
    dirs: DataDirState,
    weather: WeatherService,
    years: WeatherYearsCache,
    jobs: Jobs,
}

impl Engine {
    /// `legal_dir` holds LICENSE, TERMS.md and THIRD_PARTY_NOTICES.md; an empty `data` takes the projects folder from Settings,
    /// a portable "data" folder or the default.
    pub fn new(legal_dir: impl Into<PathBuf>, data: &str) -> Result<Engine, Error> {
        Engine::with_weather(legal_dir, data, WeatherService::online())
    }

    /// As `new`, with another weather service (tests answer from saved responses)
    pub fn with_weather(legal_dir: impl Into<PathBuf>, data: &str, weather: WeatherService) -> Result<Engine, Error> {
        let dirs = DataDirState::default();
        let store = Storage::new(find_data_dir(data, &dirs))?;
        Ok(Engine { legal_dir: legal_dir.into(), store, dirs, weather, years: WeatherYearsCache::default(), jobs: Jobs::default() })
    }

    pub fn info(&self) -> R {
        let os = if cfg!(windows) { "Windows" } else if cfg!(target_os = "macos") { "macOS" } else { "Linux" };
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        let mut o = Value::object();
        o.set("data_dir", path_str(&self.store.root()));
        o.set("reports_dir", path_str(&self.store.reports_dir()?));
        o.set("version", VERSION);
        o.set("os", os);
        o.set("arch", arch);
        o.set("app", true);
        Ok(o.dump())
    }

    /// Licence (plain text), terms of use and third-party notices (Markdown), as text
    pub fn legal(&self, doc: &str) -> Result<String, ApiError> {
        let file = match doc { "license" => "LICENSE", "terms" => "TERMS.md", "notices" => "THIRD_PARTY_NOTICES.md", _ => return Err(ApiError::internal("unknown document")) };
        std::fs::read_to_string(self.legal_dir.join(file)).map_err(|_| ApiError::internal(format!("{file} is missing from the app")))
    }

    // Profiles
    pub fn users(&self) -> R { dump(self.store.list_users()) }
    pub fn user_create(&self, body: &Value) -> R { dump(self.store.create_user(body)) }
    pub fn users_terms(&self, id: &str, body: &Value) -> R { dump(self.store.accept_terms(id, &body.gets("version", ""))) }
    pub fn users_update(&self, id: &str, body: &Value) -> R { dump(self.store.update_user(id, body)) }
    pub fn users_delete(&self, id: &str) -> R { self.store.delete_user(id)?; ok() }

    // Settings: the projects folder, the update preferences and the caches
    pub fn settings(&self) -> R { Ok(settings_json(&self.store, &self.dirs, VERSION).dump()) }
    pub fn settings_update(&self, body: &Value) -> R { settings_update(&self.dirs, body)?; ok() }
    pub fn settings_data_dir(&self, body: &Value) -> R {
        dump(change_data_dir(&self.store, &self.dirs, &body.gets("path", ""), &body.gets("mode", "")))
    }
    /// Downloaded weather sets and PV yield checks, results of runs finished over 30 s ago, and leftovers of interrupted saves.
    /// Profiles, projects and reports are never touched.
    pub fn cache_clear(&self) -> R {
        let mut o = Value::object();
        o.set("weather_sets", self.years.clear() as f64);
        o.set("yield_checks", self.weather.clear_yield_cache() as f64);
        o.set("results", self.jobs.clear_finished() as f64);
        o.set("temp_files", self.store.remove_temp_files() as f64);
        Ok(o.dump())
    }

    // Projects
    pub fn projects(&self, user: &str) -> R { dump(self.store.list_projects(user)) }
    pub fn project_load(&self, user: &str, id: &str) -> R { self.store.load_project(user, id) }
    pub fn project_save(&self, user: &str, id: &str, body: &Value) -> R { dump(self.store.save_project(user, id, body.at("project"), body.at("meta"))) }
    pub fn project_delete(&self, user: &str, id: &str) -> R { self.store.delete_project(user, id)?; ok() }
    pub fn project_duplicate(&self, user: &str, id: &str) -> R { dump(self.store.duplicate_project(user, id)) }

    // Bug and feedback reports with their history (web/js/reports.js)
    pub fn reports(&self) -> R { dump(self.store.list_reports()) }
    pub fn report_load(&self, id: &str) -> R { self.store.load_report(id) }
    /// `size`: length of the request body as text (24 MB at most)
    pub fn report_save(&self, body: &Value, size: usize) -> R {
        if size > 24 << 20 { return Err(Error("The report is too large (over 24 MB).".into())); }
        dump(self.store.save_report(body.at("report"), &body.gets("markdown", "")))
    }
    pub fn report_delete(&self, id: &str) -> R { self.store.delete_report(id)?; ok() }

    // Jobs
    pub fn job(&self, id: &str) -> R { self.jobs.status(id) }
    pub fn job_cancel(&self, id: &str) -> R { self.jobs.cancel(id); ok() }
}
