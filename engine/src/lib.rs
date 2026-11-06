//! The Soloptima engine in Rust (rewrite phase 2). Session 2.1: the project model, JSON in and out, and validation, ported
//! from src/model.{hpp,cpp} and src/json.hpp of the C++ engine, which they must agree with to the byte and to the message.
//! The desktop app still calls the C++ engine (docs/ipc.md); session 2.12 switches it over.
pub mod calendar;
pub mod json;
pub mod layout;
pub mod model;
pub mod parse;
pub mod pv;
pub mod series;
pub mod shading;
pub mod solar;
pub mod validate;

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
