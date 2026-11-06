//! The Soloptima engine: the project model and its JSON, PV and wind, the hourly dispatch, finance, the optimiser, forecasting
//! and EMS, weather services, data import and checks, the variability run and the data folder. It was ported from the C++
//! engine (v1), whose answers it gives to the byte (engine/tests). `api` is what the desktop app calls (docs/ipc.md); the
//! command line is src/bin/soloptima.rs.
pub mod api;
pub mod calendar;
pub mod ems;
pub mod finance;
pub mod forecast;
pub mod json;
pub mod layout;
pub mod model;
pub mod optimizer;
pub mod parse;
pub mod resource;
pub mod pv;
pub mod series;
pub mod shading;
pub mod sim;
pub mod solar;
pub mod storage;
pub mod validate;
pub mod weather;

pub use json::{Error, Value};
pub use model::*;
pub use series::{data_qc, import_series};
pub use parse::{parse_project, parse_weather};
pub use layout::{layout_used, validate_layout};
pub use validate::validate_project;
pub use pv::{compute_pv_profile, compute_pv_profile_groups, LossStep, PVProfile};
pub use shading::{array_groups, ArrayGroup, NearShading};

/// Reads a project document (the text of a project file or of an API request) into the engine's model.
pub fn project_from_text(text: &str) -> Result<Project, Error> {
    Ok(parse_project(&Value::parse(text)?))
}
