//! Where the data lives and Settings: the projects folder (--data, the one chosen in Settings, a portable one, the default), moving
//! or opening another folder, and the update preferences kept beside it (src/main.cpp: find_data_dir, change_data_dir, settings).
use super::files::*;
use super::{fail, Storage, R};
use crate::json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Where the data folder came from: "option" (--data), "setting" (chosen in Settings), "portable" (a data folder next to the program
/// or in the working directory) or "default"; and a note when the chosen folder was not available. The lock also guards a folder
/// change in progress.
pub struct DataDirState {
    inner: Mutex<(String, String)>,
}

impl Default for DataDirState {
    fn default() -> Self { DataDirState { inner: Mutex::new(("default".into(), String::new())) } }
}

impl DataDirState {
    pub fn source(&self) -> String { self.inner.lock().unwrap().0.clone() }
    pub fn note(&self) -> String { self.inner.lock().unwrap().1.clone() }
}

/// macOS: ~/Library/Application Support/Soloptima, Windows: %LOCALAPPDATA%\Soloptima, Linux: $XDG_DATA_HOME or ~/.local/share
pub fn user_data_dir() -> PathBuf {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    #[cfg(windows)]
    if let Some(p) = env("LOCALAPPDATA").or_else(|| env("USERPROFILE")) { return p.join("Soloptima"); }
    #[cfg(target_os = "macos")]
    if let Some(h) = env("HOME") { return h.join("Library").join("Application Support").join("Soloptima"); }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(x) = env("XDG_DATA_HOME") { return x.join("Soloptima"); }
        if let Some(h) = env("HOME") { return h.join(".local").join("share").join("Soloptima"); }
    }
    std::env::current_dir().unwrap_or_default().join("data")
}

/// Beside the default folder, not in it: that folder may be deleted once the data has moved elsewhere
fn settings_file() -> PathBuf { user_data_dir().parent().map(Path::to_path_buf).unwrap_or_default().join("Soloptima-settings.json") }

/// The settings as an object (empty when there is no file)
pub fn read_settings() -> BTreeMap<String, Value> {
    fs::read_to_string(settings_file()).ok().and_then(|t| Value::parse(&t).ok()).and_then(|v| v.obj().cloned()).unwrap_or_default()
}

/// Written whole, and the file removed when nothing is left in it
pub fn write_settings(s: &BTreeMap<String, Value>) -> R<()> {
    if s.is_empty() { let _ = fs::remove_file(settings_file()); return Ok(()); }
    make_private_dirs(settings_file().parent().unwrap_or_else(|| Path::new("")))?;
    write_atomic(&settings_file(), &Value::Obj(s.clone()).dump())
}

/// Saved projects: `given` (--data), else the folder chosen in Settings, else a "data" folder next to the program or in the
/// working directory (portable / development use), else the per-user application data folder.
pub fn find_data_dir(given: &str, state: &DataDirState) -> PathBuf {
    let mut st = state.inner.lock().unwrap();
    if !given.is_empty() { st.0 = "option".into(); return PathBuf::from(given); }
    let set = Value::Obj(read_settings());
    let chosen = PathBuf::from(set.gets("data_dir", ""));
    if !chosen.as_os_str().is_empty() {
        if chosen.join("users").is_dir() { st.0 = "setting".into(); return chosen; }
        st.1 = format!("The projects folder chosen in Settings ({}) is not available, so another folder is used. Connect the drive that holds it, then restart Soloptima, or choose the folder again.", chosen.display());
    }
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    for c in [exe.join("data"), std::env::current_dir().unwrap_or_default().join("data")] {
        if c.join("users").exists() { st.0 = "portable".into(); return c; }
    }
    let dir = user_data_dir();
    let old = dir.parent().map(|p| p.join("SolarHybrid")).unwrap_or_default();   // folder name before the rename
    if !dir.exists() && old.exists() { let _ = fs::rename(&old, &dir); }
    dir
}

/// The GUI's Settings: folder, source, note and the update preferences
pub fn settings_json(store: &Storage, state: &DataDirState, version: &str) -> Value {
    let st = state.inner.lock().unwrap();
    let set = Value::Obj(read_settings());
    let mut o = Value::object();
    o.set("data_dir", store.root().to_string_lossy().into_owned());
    o.set("default_dir", user_data_dir().to_string_lossy().into_owned());
    o.set("source", st.0.clone());
    o.set("note", st.1.clone());
    o.set("update_auto", set.getb("update_auto", true));
    for k in ["skip", "checked", "latest"] { o.set(&format!("update_{k}"), set.gets(&format!("update_{k}"), "")); }
    o.set("version", version);
    o
}

/// Update preferences: automatic check on or off, a version the user chose to skip, the time of the last check
pub fn settings_update(state: &DataDirState, v: &Value) -> R<()> {
    let _g = state.inner.lock().unwrap();
    let mut set = read_settings();
    if v.has("auto") { set.insert("update_auto".into(), Value::Bool(v.getb("auto", true))); }
    for k in ["skip", "checked", "latest"] {
        if v.has(k) {
            let s: String = String::from_utf8_lossy(&v.gets(k, "").as_bytes()[..v.gets(k, "").len().min(40)]).into_owned();
            let key = format!("update_{k}");
            if s.is_empty() { set.remove(&key); } else { set.insert(key, Value::Str(s)); }
        }
    }
    write_settings(&set)
}

/// std::filesystem::weakly_canonical: the existing part resolved, the rest only tidied
fn weakly_canonical(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(n), Some(par)) => { rest.push(n); existing = par; }
            _ => break,
        }
    }
    let mut out = fs::canonicalize(&existing).unwrap_or(existing);
    for part in rest.into_iter().rev() {
        match Path::new(&part).components().next() {
            Some(Component::ParentDir) => { out.pop(); }
            Some(Component::CurDir) | None => {}
            _ => out.push(part),
        }
    }
    out
}

/// Paths compared as the file system does: resolved, without a trailing separator, and without case on Windows
fn path_key(p: &Path) -> PathBuf {
    let c: PathBuf = weakly_canonical(p).components().collect();
    #[cfg(windows)]
    { return PathBuf::from(c.to_string_lossy().to_lowercase()); }
    #[cfg(not(windows))]
    c
}
fn path_within(a: &Path, b: &Path) -> bool { a.starts_with(b) }   // a is b or inside it

fn count_files(d: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![d.to_path_buf()];
    while let Some(x) = stack.pop() {
        let Ok(rd) = fs::read_dir(&x) else { continue };
        for e in rd.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(t) if t.is_file() || (t.is_symlink() && fs::metadata(e.path()).is_ok_and(|m| m.is_file())) => n += 1,
                _ => {}
            }
        }
    }
    n
}

/// Any link in the tree
fn has_link(d: &Path) -> bool {
    let mut stack = vec![d.to_path_buf()];
    while let Some(x) = stack.pop() {
        let Ok(rd) = fs::read_dir(&x) else { continue };
        for e in rd.flatten() {
            match e.file_type() { Ok(t) if t.is_symlink() => return true, Ok(t) if t.is_dir() => stack.push(e.path()), _ => {} }
        }
    }
    false
}

/// Recursive copy, existing files overwritten, links skipped
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        let dest = to.join(e.file_name());
        if t.is_dir() { copy_tree(&e.path(), &dest)?; } else if t.is_file() { fs::copy(e.path(), &dest)?; }
    }
    Ok(())
}

fn profiles(d: &Path) -> usize {
    fs::read_dir(d.join("users")).map_or(0, |rd| rd.flatten().filter(|e| e.path().join("profile.json").exists()).count())
}

/// Settings: another data folder. "move" copies the profiles, projects and reports there and keeps the old folder as it was (a
/// backup the user can delete); "use" opens the folder as it is. The choice is saved in Soloptima-settings.json.
pub fn change_data_dir(store: &Storage, state: &DataDirState, path: &str, mode: &str) -> R<Value> {
    let mut st = state.inner.lock().unwrap();
    if st.0 == "option" { return fail("Soloptima was started with --data, which sets the projects folder for this run."); }
    if mode != "move" && mode != "use" { return fail("Unknown folder change."); }
    let mut to = PathBuf::from(path);
    if path.is_empty() || !to.is_absolute() { return fail("Enter the full path of a folder."); }
    to = weakly_canonical(&to);
    let from = store.root();
    let (kt, kf) = (path_key(&to), path_key(&from));
    if kt == kf { return fail("That is already the projects folder."); }
    if path_within(&kt, &kf) || path_within(&kf, &kt) { return fail("Choose a folder outside the current projects folder, and not one that contains it."); }
    // links inside the folder would point Soloptima's reads and writes at other places of the user's account
    if has_link(&to) { return fail("That folder contains links to other places, which Soloptima does not follow. Remove them and choose the folder again."); }
    // opening a folder without profiles would leave nobody to sign in with
    if mode == "use" && profiles(&to) == 0 {
        return fail("That folder holds no Soloptima profiles. To take your profiles and projects there, choose \"Move my data there\".");
    }
    let probe = to.join(".soloptima-write-test");
    if make_private_dirs(&to).and_then(|_| write_atomic(&probe, "ok")).is_err() { return fail("Soloptima cannot create or write to that folder. Choose another one."); }
    let _ = fs::remove_file(&probe);
    let mut copied = 0;
    if mode == "move" {
        if profiles(&to) > 0 || count_files(&to.join("reports")) > 0 { return fail("That folder already holds Soloptima data. Choose an empty folder, or open the data in it instead."); }
        for sub in ["users", "reports"] {
            if from.join(sub).exists() { copy_tree(&from.join(sub), &to.join(sub)).map_err(|e| fs_error(&e))?; }
        }
        copied = count_files(&to.join("users")) + count_files(&to.join("reports"));
        if copied != count_files(&from.join("users")) + count_files(&from.join("reports")) {
            return fail("Not every file could be copied, so the projects folder was not changed. Check the free space in the new folder.");
        }
    }
    store.set_root(&to)?;
    let mut set = read_settings();
    if path_key(&user_data_dir()) == kt {   // the default folder needs no setting
        set.remove("data_dir");
        st.0 = "default".into();
    } else {
        set.insert("data_dir".into(), Value::Str(to.to_string_lossy().into_owned()));
        st.0 = "setting".into();
    }
    write_settings(&set)?;
    st.1.clear();
    let mut o = Value::object();
    o.set("data_dir", to.to_string_lossy().into_owned());
    o.set("previous", from.to_string_lossy().into_owned());
    o.set("copied", copied);
    o.set("profiles", profiles(&to));
    Ok(o)
}

