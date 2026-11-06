//! The Soloptima engine, ported from the C++ engine (v1) whose answers it gives to the byte (engine/tests). `api` is what the
//! desktop app calls (docs/ipc.md); the command line is src/bin/soloptima.rs.
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

pub fn project_from_text(text: &str) -> Result<Project, Error> {
    Ok(parse_project(&Value::parse(text)?))
}
