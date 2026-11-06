//! The engine as the app calls it (engine/src/api, the commands of docs/ipc.md): the routes answer what the C++ routes of
//! src/main.cpp answered, jobs run and report, and the command line's simulation is the app's.
use soloptima_engine::api::{forecast_days, run_simulation, ApiError, Engine};
use soloptima_engine::weather::{MockHttp, WeatherService};
use soloptima_engine::{parse_project, Error, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn repo() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }

fn engine(tag: &str) -> (Arc<Engine>, PathBuf) {
    let dir = std::env::temp_dir().join(format!("soloptima-api-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let e = Engine::with_weather(repo(), dir.to_str().unwrap(), WeatherService::new(Box::new(MockHttp::default()))).unwrap();
    (Arc::new(e), dir)
}

fn j(s: &str) -> Value { Value::parse(s).unwrap() }

fn wait(e: &Engine, started: &str) -> Value {
    let id = j(started).get("job", 0.0).to_string();
    let t0 = Instant::now();
    loop {
        let s = j(&e.job(&id).unwrap());
        if s.getb("done", false) { return s; }
        assert!(t0.elapsed() < Duration::from_secs(300), "job {id} did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn info_legal_and_methods() {
    let (e, dir) = engine("info");
    let info = j(&e.info().unwrap());
    assert_eq!(info.gets("data_dir", ""), dir.to_string_lossy());
    assert_eq!(info.gets("version", ""), env!("CARGO_PKG_VERSION"));
    assert!(info.getb("app", false));
    assert!(e.legal("terms").unwrap().starts_with("# Soloptima terms"));
    assert_eq!(e.legal("nope").unwrap_err(), ApiError::internal("unknown document"));
    let m = j(&e.forecast_methods().unwrap());
    assert!(m.at("pv").len() == 10 && m.at("load").len() == 11, "{}", m.dump());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn route_messages() {
    let (e, dir) = engine("msg");
    let err = |r: Result<String, Error>| r.unwrap_err().0;
    assert_eq!(err(e.import_series(&j("{}"))), "The file text is missing.");
    assert_eq!(err(e.data_qc(&j(r#"{"only": "wind and more than twenty"}"#))), "Unknown data set: wind and more than t.");
    assert_eq!(err(e.pv(&j("{}"))), "Fetch or upload weather data first.");
    assert_eq!(err(e.job("99")), "No such job.");
    assert_eq!(e.job_cancel("99").unwrap(), r#"{"ok":true}"#);
    let ex = j(&std::fs::read_to_string(repo().join("web/examples/example_study.json")).unwrap());
    let mut v = Value::object();
    v.set("project", ex.clone());
    v.set("source", "meteo");
    assert_eq!(err(e.resource_years(&v)), "Unknown weather source: meteo");
    v.set("source", "pvgis");
    v.set("from", 2010);
    v.set("to", 2010);
    assert_eq!(err(e.resource_years(&v)), "Choose at least two weather years.");
    v.set("to", 2012);
    v.set("budget", j(r#"{"dataset": 0.9, "model": 0.5}"#));
    assert_eq!(err(e.resource_years(&v)), "Uncertainties must be at least 0 % and together below 100 %.");
    // the job reports the download's failure (the mock answers nothing)
    v.set("budget", Value::Null);
    let s = wait(&e, &e.resource_years(&v).unwrap());
    assert!(s.at("error").is_string(), "{}", s.dump());
    assert_eq!(forecast_days(&j(r#"{"days": 40}"#)), 16);
    assert_eq!(forecast_days(&j(r#"{"days": 0.5}"#)), 1);
    assert_eq!(forecast_days(&j("{}")), 2);
    let big = "x".repeat((24 << 20) + 1);
    assert_eq!(err(e.report_save(&j("{}"), big.len())), "The report is too large (over 24 MB).");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn profiles_and_projects() {
    let (e, dir) = engine("store");
    let u = j(&e.user_create(&j(r#"{"name": "Test User", "terms_version": "1"}"#)).unwrap());
    let user = u.gets("id", "");
    assert_eq!(j(&e.users().unwrap()).len(), 1);
    let meta = j(&e.project_save(&user, "", &j(r#"{"project": {"name": "Site A"}, "meta": {"pv_kwp": 5}}"#)).unwrap());
    let id = meta.gets("id", "");
    assert_eq!(j(&e.project_load(&user, &id).unwrap()).gets("name", ""), "Site A");
    let dup = j(&e.project_duplicate(&user, &id).unwrap());
    assert_eq!(j(&e.projects(&user).unwrap()).len(), 2);
    assert_eq!(e.project_delete(&user, &dup.gets("id", "")).unwrap(), r#"{"ok":true}"#);
    assert_eq!(e.project_load(&user, "../x").unwrap_err().0, "Invalid project id.");
    let c = j(&e.cache_clear().unwrap());
    assert_eq!(c.dump(), r#"{"results":0,"temp_files":0,"weather_sets":0,"yield_checks":0}"#);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn simulate_and_optimize_through_the_api() {
    let (e, dir) = engine("run");
    let text = std::fs::read_to_string(repo().join("web/examples/example_study.json")).unwrap();
    let doc = j(&text);
    let sim = e.simulate(&doc).unwrap();
    assert_eq!(sim, run_simulation(&parse_project(&doc), &doc).unwrap().dump());
    let mut v = Value::object();
    v.set("project", doc.clone());
    v.set("optimizer", j(r#"{"algorithm": "grid", "pv_steps": 2, "bess_steps": 2, "refine": false}"#));
    let s = wait(&e, &e.optimize(&v).unwrap());
    assert!(s.at("result").is_object(), "{}", s.dump().chars().take(300).collect::<String>());
    assert_eq!(j(&e.cache_clear().unwrap()).get("results", -1.0), 0.0);   // finished less than 30 s ago
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn data_folder_errors_are_internal() {
    let e: ApiError = Error("Cannot use the data folder: Permission denied.".into()).into();
    assert!(e.internal);
    let e: ApiError = Error("Invalid user id.".into()).into();
    assert!(!e.internal);
}
