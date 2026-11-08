//! The data folder against the C++ engine: tests/gen_storage_fixtures.cpp planted a data folder (some of it bad), ran Storage on it
//! step by step and wrote each answer (times and random ids normalised); the same folder and steps are run here. The safety cases
//! of tests/test_engine.cpp (planted links, device names, folder modes) and the folder change of Settings follow.
use soloptima_engine::storage::{change_data_dir, make_private_dirs, valid_id, write_atomic, DataDirState, Storage};
use soloptima_engine::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn put(p: &Path, text: &str) { fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, text).unwrap(); }
fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("soloptima-storage-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}
fn j(s: &str) -> Value { Value::parse(s).unwrap() }

/// Times as T, the random ids made so far as ID
fn norm(s: &str, ids: &[String]) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let t = b.get(i..i + 20).unwrap_or(&[]);
        let pat = |k: usize, c: u8| t.get(k).is_some_and(|x| *x == c);
        let digits = |r: std::ops::Range<usize>| r.into_iter().all(|k| t.get(k).is_some_and(u8::is_ascii_digit));
        if t.len() == 20 && digits(0..4) && pat(4, b'-') && digits(5..7) && pat(7, b'-') && digits(8..10) && pat(10, b'T') && digits(11..13) && pat(13, b':')
            && digits(14..16) && pat(16, b':') && digits(17..19) && pat(19, b'Z') {
            out.push('T');
            i += 20;
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    // (the text is ASCII here, or its bytes are pushed as they are)
    let mut s = String::from_utf8_lossy(&out.chars().map(|c| c as u32 as u8).collect::<Vec<u8>>()).into_owned();
    for id in ids { s = s.replace(id.as_str(), "ID"); }
    s.replace(&today(), "D")   // the index of the reports shows the day a report was created: the day the test runs
}

/// Today's UTC date as YYYY-MM-DD
fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (y, m, d) = soloptima_engine::calendar::civil_from_days((secs / 86400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}
fn sorted(v: &Value, ids: &[String]) -> String {
    let mut e: Vec<String> = v.arr().iter().map(|x| norm(&x.dump(), ids)).collect();
    e.sort();
    format!("[{}]", e.join(","))
}

/// Tests that change HOME, XDG_DATA_HOME or APPIMAGE take turns
static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn plant(root: &Path) {
    let a = root.join("users/alice-abc123/projects");
    put(&root.join("users/alice-abc123/profile.json"), r#"{"id":"alice-abc123","name":"Alice","organisation":"Org"}"#);
    put(&a.join("p1.json"), r#"{"id":"p1","name":"P one","a":1}"#);
    put(&a.join("p1.meta.json"), r#"{"id":"p1","name":"P one","updated":"2025-02-01T10:00:00Z","created":"2025-01-01T10:00:00Z"}"#);
    put(&a.join("p2.json"), r#"{"name":"P two"}"#);
    put(&a.join("p2.meta.json"), r#"{"id":"p2","name":"P two","updated":"evil<script>","created":"2025-01-02T10:00:00Z"}"#);
    put(&a.join("p3.meta.json"), r#"{"id":"other","name":"X"}"#);
    put(&a.join("notes.txt"), "hello");
    put(&root.join("users/bob-xyz789/profile.json"), r#"{"id":"bob-xyz789","name":"Bob"}"#);
    fs::create_dir_all(root.join("users/bob-xyz789/projects")).unwrap();
    put(&root.join("users/mismatch/profile.json"), r#"{"id":"other","name":"M"}"#);
    put(&root.join("users/COM1/profile.json"), r#"{"id":"COM1","name":"Dev"}"#);
    fs::create_dir_all(root.join("users/nofile")).unwrap();
    put(&root.join("reports/SOL-0001.json"), r#"{"kind":"bug","status":"new","severity":"low","title":"First | bug\nline","created":"2025-01-01T00:00:00Z","updated":"2025-01-01T00:00:00Z","count":2,"signature":"sig1","revision":1,"body":"x"}"#);
    put(&root.join("reports/SOL-0002.json"), &format!(r#"{{"kind":"feedback","status":"closed","severity":"high","title":"{}","created":"2025-01-02T00:00:00Z","updated":"2025-01-03T00:00:00Z","revision":3}}"#, "z".repeat(95)));
    put(&root.join("reports/SOL-12.json"), "{}");
    put(&root.join("reports/SOL-0003.txt"), "x");
    put(&root.join("reports/SOL-0004.json"), "{not json");
}

#[test]
fn a_scripted_run_gives_what_the_cpp_storage_gives() {
    let root = tmp("script");
    plant(&root);
    let st = Storage::new(&root).unwrap();
    let want = Value::parse(&fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/storage.json")).unwrap()).unwrap();
    let mut ids: Vec<String> = Vec::new();
    let mut steps = want.arr().iter();
    let a = root.join("users/alice-abc123/projects");
    let mut check = |name: &str, got: Result<String, soloptima_engine::Error>, id_key: &str, ids: &mut Vec<String>| {
        let w = steps.next().unwrap();
        assert_eq!(w.at("name").str(), name);
        let r = match got {
            Ok(text) => {
                if !id_key.is_empty() && !id_key.starts_with('*') { if let Ok(v) = Value::parse(&text) { ids.push(v.gets(id_key, "")); } }
                format!("OK {}", if id_key == "*sorted" { sorted(&Value::parse(&text).unwrap(), ids) } else { norm(&text, ids) })
            }
            Err(e) => format!("ERR {e}"),
        };
        assert_eq!(r, w.at("result").str(), "step {name}");
    };
    macro_rules! v { ($name:expr, $e:expr) => { check($name, $e.map(|v: Value| v.dump()), "", &mut ids) }; ($name:expr, $e:expr, $k:expr) => { check($name, $e.map(|v: Value| v.dump()), $k, &mut ids) }; }
    macro_rules! t { ($name:expr, $e:expr) => { check($name, $e, "", &mut ids) }; }
    let slurp = |p: PathBuf| Ok(fs::read_to_string(p).unwrap_or_default());
    let ok = || Ok::<Value, soloptima_engine::Error>(Value::Bool(true));
    v!("list users", st.list_users());
    v!("projects alice", st.list_projects("alice-abc123"));
    v!("projects bob", st.list_projects("bob-xyz789"));
    v!("projects nofile", st.list_projects("nofile"));
    v!("projects COM1", st.list_projects("COM1"));
    v!("projects dotdot", st.list_projects("../x"));
    t!("load p1", st.load_project("alice-abc123", "p1"));
    t!("load p9", st.load_project("alice-abc123", "p9"));
    t!("load bad id", st.load_project("alice-abc123", "a/b"));
    v!("save p4", st.save_project("alice-abc123", "p4", &j(r#"{"name":"Four","x":[1,2]}"#), &j(r#"{"tags":["a"]}"#)));
    t!("p4 file", slurp(a.join("p4.json")));
    t!("p4 meta file", slurp(a.join("p4.meta.json")));
    v!("save p1 again", st.save_project("alice-abc123", "p1", &j(r#"{"name":"P one v2"}"#), &j("{}")));
    v!("save bad id", st.save_project("alice-abc123", "bad id", &j("{}"), &j("{}")));
    v!("save nofile user", st.save_project("nofile", "q", &j("{}"), &j("{}")));
    v!("save non-object", st.save_project("alice-abc123", "p5", &j("[1]"), &j("5")));
    t!("p5 file", slurp(a.join("p5.json")));
    v!("save new id", st.save_project("alice-abc123", "", &j(r#"{"name":"Fresh Start!"}"#), &j("{}")), "id");
    v!("duplicate p1", st.duplicate_project("alice-abc123", "p1"), "id");
    v!("projects alice after", st.list_projects("alice-abc123"), "*sorted");
    v!("delete p2", st.delete_project("alice-abc123", "p2").and_then(|_| ok()));
    v!("delete p2 again", st.delete_project("alice-abc123", "p2").and_then(|_| ok()));
    v!("create user", st.create_user(&j(r#"{"name":"  Carol Ng ","organisation":"X","email":"c@x","terms_version":"1.3"}"#)), "id");
    v!("create blank", st.create_user(&j(r#"{"name":"   "}"#)));
    v!("create long name", st.create_user(&j(r#"{"name":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","terms_version":"12345678901234567890123"}"#)), "id");
    v!("accept terms", st.accept_terms("alice-abc123", "1.3"));
    v!("accept bad version", st.accept_terms("alice-abc123", ""));
    v!("update user", st.update_user("alice-abc123", &j(r#"{"name":"Alicia","organisation":"","email":"a@b","avatar":"data:image/png;base64,iVBOR="}"#)));
    v!("update bad avatar", st.update_user("alice-abc123", &j(r#"{"avatar":"data:text/html;base64,AAAA"}"#)));
    v!("update avatar removed", st.update_user("alice-abc123", &j(r#"{"avatar":""}"#)));
    v!("update blank name", st.update_user("alice-abc123", &j(r#"{"name":""}"#)));
    v!("update nobody", st.update_user("nobody-aaaaaa", &j("{}")));
    v!("delete nobody", st.delete_user("nobody-aaaaaa").and_then(|_| ok()));
    v!("list users after", st.list_users());
    v!("list reports", st.list_reports());
    t!("load report 1", st.load_report("SOL-0001"));
    t!("load report missing", st.load_report("SOL-9999"));
    t!("load report invalid", st.load_report("SOL-1"));
    v!("save report new", st.save_report(&j(r#"{"kind":"bug","status":"new","severity":"low","title":"New one","signature":"sigN"}"#), "# {{id}} title\n{{id}}\n"));
    t!("report 5 md", slurp(root.join("reports/SOL-0005.md")));
    t!("report index", slurp(root.join("reports/README.md")));
    v!("save report same signature", st.save_report(&j(r#"{"kind":"bug","status":"new","severity":"low","signature":"sigN"}"#), "x"));
    v!("save report update", st.save_report(&j(r#"{"id":"SOL-0005","revision":1,"kind":"bug","status":"fixed","severity":"low","title":"New | one\r\nx"}"#), "md"));
    v!("save report stale", st.save_report(&j(r#"{"id":"SOL-0005","revision":1,"kind":"bug","status":"fixed","severity":"low"}"#), "md"));
    v!("save report deleted", st.save_report(&j(r#"{"id":"SOL-0100","kind":"bug","status":"new","severity":"low"}"#), "md"));
    v!("save report bad id", st.save_report(&j(r#"{"id":"x","kind":"bug","status":"new","severity":"low"}"#), "md"));
    v!("save report bad kind", st.save_report(&j(r#"{"kind":"nope","status":"new","severity":"low"}"#), "md"));
    v!("save report not object", st.save_report(&j("[]"), "md"));
    v!("delete report 2", st.delete_report("SOL-0002").and_then(|_| ok()));
    v!("delete report invalid", st.delete_report("../x").and_then(|_| ok()));
    v!("list reports after", st.list_reports());
    t!("report index after", slurp(root.join("reports/README.md")));
    t!("last id", slurp(root.join("reports/.last-id")));
    assert!(steps.next().is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn ids_cannot_name_devices_or_paths() {
    for ok in ["alice-abc123", "A_b-9", &"a".repeat(64), "COM0", "COM10", "LPT0", "CONSOLE", "NULL"] { assert!(valid_id(ok), "{ok}"); }
    for bad in ["", &"a".repeat(65), "a/b", "..", "a b", "CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT5", "é", "a.b"] { assert!(!valid_id(bad), "{bad}"); }
}

#[cfg(unix)]
#[test]
fn planted_links_are_not_followed_and_modes_are_private() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tmp("links");
    fs::create_dir_all(root.join("outside")).unwrap();
    fs::create_dir_all(root.join("data")).unwrap();
    put(&root.join("outside/victim.txt"), "keep");
    symlink(root.join("outside/victim.txt"), root.join("data/p.json")).unwrap();
    symlink(root.join("outside/victim.txt"), root.join("data/p.json.tmp")).unwrap();
    write_atomic(&root.join("data/p.json"), "new").unwrap();
    assert_eq!(fs::read_to_string(root.join("outside/victim.txt")).unwrap(), "keep");
    assert_eq!(fs::read_to_string(root.join("data/p.json")).unwrap(), "new");
    assert!(!fs::symlink_metadata(root.join("data/p.json")).unwrap().file_type().is_symlink());
    let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    // a temporary file is the owner's alone
    write_atomic(&root.join("data/q.json"), "x").unwrap();
    assert_eq!(mode(&root.join("data/q.json")), 0o600);

    let st = Storage::new(root.join("data")).unwrap();
    fs::create_dir_all(root.join("data/users/u1")).unwrap();
    symlink(root.join("outside"), root.join("data/users/u1/projects")).unwrap();
    fs::create_dir_all(root.join("data/users/u2")).unwrap();
    put(&root.join("data/users/u2/profile.json"), r#"{"id":"u3","name":"Other"}"#);
    assert!(st.list_projects("u1").unwrap_err().0.contains("holds a link (projects)"));
    assert!(st.list_projects("COM1").is_err());
    assert!(st.list_users().unwrap().arr().is_empty());
    // a project file that is a link is not read
    put(&root.join("data/users/u4/profile.json"), r#"{"id":"u4","name":"Four"}"#);
    fs::create_dir_all(root.join("data/users/u4/projects")).unwrap();
    symlink(root.join("outside/victim.txt"), root.join("data/users/u4/projects/p.json")).unwrap();
    assert_eq!(st.load_project("u4", "p").unwrap_err().0, "Not found.");
    // a profile whose projects entry is not a folder counts no projects and hides no other profile
    put(&root.join("data/users/u5/profile.json"), r#"{"id":"u5","name":"Five"}"#);
    put(&root.join("data/users/u5/projects"), "not a folder");
    let users = st.list_users().unwrap();
    let ids: Vec<(String, f64)> = users.arr().iter().map(|u| (u.gets("id", ""), u.get("projects", -1.0))).collect();
    assert_eq!(ids, vec![("u5".to_string(), 0.0), ("u4".to_string(), 1.0)]);

    // folders Soloptima creates are the owner's alone, whatever the umask
    let old = unsafe { libc::umask(0o022) };
    make_private_dirs(&root.join("made/a/b")).unwrap();
    unsafe { libc::umask(old) };
    assert_eq!((mode(&root.join("made")), mode(&root.join("made/a/b")), mode(&root.join("data/users"))), (0o700, 0o700, 0o700));
    // a root has no parent to create: the walk up stops and the error is the system's
    assert!(make_private_dirs(Path::new("/proc/definitely/not/here")).is_err() || cfg!(not(target_os = "linux")));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn temporary_files_older_than_a_minute_are_removed() {
    let root = tmp("tmpfiles");
    let st = Storage::new(&root).unwrap();
    put(&root.join("users/x/.p.json.abc123.tmp"), "old");
    put(&root.join("users/x/.q.json.abc123.tmp"), "new");
    put(&root.join("users/x/keep.json"), "keep");
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(300);
    fs::File::options().write(true).open(root.join("users/x/.p.json.abc123.tmp")).unwrap().set_modified(old).unwrap();
    assert_eq!(st.remove_temp_files(), 1);
    assert!(!root.join("users/x/.p.json.abc123.tmp").exists() && root.join("users/x/.q.json.abc123.tmp").exists() && root.join("users/x/keep.json").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_data_folder_change_checks_what_it_is_given() {
    let base = tmp("change");
    let (from, to) = (base.join("from"), base.join("to"));
    plant(&from);
    let st = Storage::new(&from).unwrap();
    let state = DataDirState::default();
    let err = |path: &str, mode: &str| change_data_dir(&st, &state, path, mode).unwrap_err().0;
    assert_eq!(err("", "use"), "Enter the full path of a folder.");
    assert_eq!(err("relative/dir", "use"), "Enter the full path of a folder.");
    assert_eq!(err(to.to_str().unwrap(), "copy"), "Unknown folder change.");
    assert_eq!(err(from.to_str().unwrap(), "use"), "That is already the projects folder.");
    assert_eq!(err(from.join("users").to_str().unwrap(), "use"), "Choose a folder outside the current projects folder, and not one that contains it.");
    assert_eq!(err(base.to_str().unwrap(), "use"), "Choose a folder outside the current projects folder, and not one that contains it.");
    assert!(err(to.to_str().unwrap(), "use").starts_with("That folder holds no Soloptima profiles."));
    // a folder with a link in it is refused
    #[cfg(unix)]
    {
        let linked = base.join("linked");
        fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&from, linked.join("l")).unwrap();
        assert!(err(linked.to_str().unwrap(), "use").starts_with("That folder contains links"));
    }
    // a folder that already holds data is not a target of "move"
    let full = base.join("full");
    plant(&full);
    assert!(err(full.to_str().unwrap(), "move").starts_with("That folder already holds Soloptima data."));
    // a --data run cannot change it
    let fixed = find_given(&state);
    assert_eq!(change_data_dir(&st, &fixed, to.to_str().unwrap(), "move").unwrap_err().0, "Soloptima was started with --data, which sets the projects folder for this run.");
    let _ = fs::remove_dir_all(&base);
}

fn find_given(_: &DataDirState) -> DataDirState {
    let s = DataDirState::default();
    soloptima_engine::storage::find_data_dir("/some/where", &s);
    s
}

/// "move" copies the data and "use" opens a folder; the choice lands in the settings file, which is put in a temporary home here
#[cfg(unix)]
#[test]
fn moving_and_using_a_data_folder_work_and_are_remembered() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    use soloptima_engine::storage::{read_settings, settings_json, settings_update};
    let base = tmp("move");
    std::env::set_var("HOME", &base);
    std::env::set_var("XDG_DATA_HOME", base.join("xdg"));
    let (from, to) = (base.join("from"), base.join("to"));
    plant(&from);
    let st = Storage::new(&from).unwrap();
    let state = DataDirState::default();
    let r = change_data_dir(&st, &state, to.to_str().unwrap(), "move").unwrap();
    assert_eq!((r.get("profiles", -1.0), r.get("copied", -1.0)), (4.0, 15.0), "{}", r.dump());   // alice, bob, mismatch and COM1 have a profile file; 15 files under users and reports
    assert_eq!(st.root(), fs::canonicalize(&to).unwrap_or(to.clone()));
    assert!(to.join("users/alice-abc123/projects/p1.json").exists() && from.join("users/alice-abc123/projects/p1.json").exists());
    // the copied folders are the owner's alone, as every folder Soloptima makes
    {
        use std::os::unix::fs::PermissionsExt;
        for d in ["users", "users/alice-abc123", "users/alice-abc123/projects", "reports"] {
            assert_eq!(fs::metadata(to.join(d)).unwrap().permissions().mode() & 0o777, 0o700, "{d}");
        }
    }
    assert_eq!(state.source(), "setting");
    assert_eq!(read_settings().get("data_dir").map(|v| v.str().to_string()), Some(st.root().to_string_lossy().into_owned()));
    let s = settings_json(&st, &state, "9.9");
    assert_eq!((s.gets("source", ""), s.gets("version", "")), ("setting".into(), "9.9".into()));
    // back to the first folder, which holds profiles
    let r = change_data_dir(&st, &state, from.to_str().unwrap(), "use").unwrap();
    assert_eq!(r.get("profiles", -1.0), 4.0);
    // update preferences
    settings_update(&state, &j(r#"{"auto":false,"skip":"1.2.3","checked":"2026-01-01T00:00:00Z"}"#)).unwrap();
    let s = settings_json(&st, &state, "9.9");
    assert!(!s.getb("update_auto", true) && s.gets("update_skip", "") == "1.2.3");
    settings_update(&state, &j(r#"{"skip":""}"#)).unwrap();
    assert_eq!(settings_json(&st, &state, "9.9").gets("update_skip", "x"), "");
    let _ = fs::remove_dir_all(&base);
}

/// A copy upgraded from 1.x finds its profiles: same default folder per system, the 1.x settings file (same place, same
/// keys) and a portable data folder beside the AppImage are read as they are
#[cfg(unix)]
#[test]
fn a_1x_installation_is_found_unchanged() {
    let _env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    use soloptima_engine::storage::{read_settings, settings_json, user_data_dir};
    let base = tmp("upgrade");
    std::env::set_var("HOME", &base);
    std::env::set_var("XDG_DATA_HOME", base.join("xdg"));
    std::env::remove_var("APPIMAGE");
    let def = user_data_dir();
    #[cfg(target_os = "macos")]
    assert_eq!(def, base.join("Library/Application Support/Soloptima"));
    #[cfg(not(target_os = "macos"))]
    assert_eq!(def, base.join("xdg/Soloptima"));
    // 1.x data in the default folder, its settings file beside that folder under the 1.x keys
    plant(&def);
    fs::write(def.parent().unwrap().join("Soloptima-settings.json"),
        r#"{"update_auto":false,"update_skip":"1.9.0","update_checked":"2026-05-01T10:00:00Z","update_latest":"1.9.0"}"#).unwrap();
    let state = DataDirState::default();
    assert_eq!(soloptima_engine::storage::find_data_dir("", &state), def);
    assert_eq!(state.source(), "default");
    assert_eq!(read_settings().len(), 4);
    let st = Storage::new(&def).unwrap();
    let s = settings_json(&st, &state, "2.0.0");
    assert!(!s.getb("update_auto", true));
    assert_eq!((s.gets("update_skip", ""), s.gets("update_checked", ""), s.gets("update_latest", "")),
        ("1.9.0".into(), "2026-05-01T10:00:00Z".into(), "1.9.0".into()));
    assert!(st.list_users().unwrap().len() >= 1, "profiles of the 1.x folder");
    // a folder chosen in Settings (key data_dir) is used
    let chosen = base.join("elsewhere");
    plant(&chosen);
    fs::write(def.parent().unwrap().join("Soloptima-settings.json"), format!(r#"{{"data_dir":{:?}}}"#, chosen.to_string_lossy())).unwrap();
    let state = DataDirState::default();
    assert_eq!(soloptima_engine::storage::find_data_dir("", &state), chosen);
    assert_eq!(state.source(), "setting");
    fs::remove_file(def.parent().unwrap().join("Soloptima-settings.json")).unwrap();
    // a portable data folder beside the AppImage wins over the default folder
    let appdir = base.join("apps");
    plant(&appdir.join("data"));
    fs::write(appdir.join("Soloptima-linux-x86_64.AppImage"), b"").unwrap();
    std::env::set_var("APPIMAGE", appdir.join("Soloptima-linux-x86_64.AppImage"));
    let state = DataDirState::default();
    assert_eq!(soloptima_engine::storage::find_data_dir("", &state), appdir.join("data"));
    assert_eq!(state.source(), "portable");
    std::env::remove_var("APPIMAGE");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn write_errors_name_the_real_cause() {
    use std::io::{Error as IoError, ErrorKind as K};
    use soloptima_engine::storage::write_error;
    let msg = |k: K| write_error(&IoError::from(k)).0;
    assert!(msg(K::PermissionDenied).contains("permission denied"), "{}", msg(K::PermissionDenied));
    assert!(msg(K::ReadOnlyFilesystem).contains("read-only"));
    assert!(msg(K::StorageFull).contains("disk is full"));
    assert!(!msg(K::PermissionDenied).contains("disk is full"));
}

#[cfg(unix)]
#[test]
fn saving_into_a_read_only_folder_says_permission_not_disk_full() {
    use std::os::unix::fs::PermissionsExt;
    let root = tmp("readonly");
    fs::create_dir_all(root.join("data")).unwrap();
    fs::set_permissions(root.join("data"), fs::Permissions::from_mode(0o500)).unwrap();
    let r = write_atomic(&root.join("data/p.json"), "x");
    fs::set_permissions(root.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
    if unsafe { libc::geteuid() } == 0 { return; }   // root writes anywhere
    let e = r.unwrap_err().0;
    assert!(e.contains("permission denied") && !e.contains("disk is full"), "{e}");
}
