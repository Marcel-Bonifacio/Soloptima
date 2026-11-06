//! Local project store (src/storage.cpp): one folder per user profile, one JSON file per project plus a small metadata sidecar for
//! fast listing, and a reports folder with the bug and feedback reports. Every rule that keeps a data folder from elsewhere
//! harmless is kept: ids that match their file names, no links followed, exclusive temporary files, owner-only folders.
mod datadir;
mod files;
mod reports;

pub use datadir::{change_data_dir, find_data_dir, user_data_dir, read_settings, settings_json, settings_update, write_settings, DataDirState};
pub use files::{atoi, make_private_dirs, valid_id, write_atomic, write_error};

use crate::json::{Error, Value};
use crate::weather::iso_from_unix;
use files::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type R<T> = Result<T, Error>;
fn fail<T>(m: &str) -> R<T> { Err(Error(m.to_string())) }

pub(crate) fn now_iso() -> String {
    iso_from_unix(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64))
}

pub struct Storage {
    root: Mutex<PathBuf>,
}

/// A profile name: at most 60 characters, not blank
fn profile_name(v: &Value) -> R<String> {
    let name = utf8_prefix(&v.gets("name", ""), 60);
    if name.trim_matches([' ', '\t']).is_empty() { return fail("Enter a name."); }
    Ok(name)
}

/// A profile picture: a small PNG, JPEG or WebP data URL (the GUI scales it to 160 px)
fn valid_avatar(s: &str) -> bool {
    if s.len() > 400000 { return false; }
    for h in ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"] {
        if !s.starts_with(h) || s.len() == h.len() { continue; }
        let b = s.as_bytes();
        let mut i = h.len();
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'+' || b[i] == b'/') { i += 1; }
        while i < b.len() && b[i] == b'=' { i += 1; }
        return i == b.len();
    }
    false
}

fn ls(p: &Path) -> R<Vec<fs::DirEntry>> {
    fs::read_dir(p).map_err(|e| fs_error(&e))?.collect::<Result<Vec<_>, _>>().map_err(|e| fs_error(&e))
}
fn obj_of(v: Value) -> Value { if v.is_object() { v } else { Value::object() } }

impl Storage {
    pub fn new(root: impl Into<PathBuf>) -> R<Storage> {
        let root = root.into();
        make_private_dirs(&root.join("users"))?;
        Ok(Storage { root: Mutex::new(root) })
    }
    pub fn root(&self) -> PathBuf { self.root.lock().unwrap().clone() }
    /// Another data folder (Settings), used from the next request on
    pub fn set_root(&self, root: &Path) -> R<()> {
        make_private_dirs(&root.join("users"))?;
        *self.root.lock().unwrap() = root.to_path_buf();
        Ok(())
    }

    fn user_dir(&self, user: &str) -> R<PathBuf> {
        if !valid_id(user) { return fail("Invalid user id."); }
        let r = self.root();
        let d = r.join("users").join(user);
        no_link(&r, &d.join("projects"))?;
        Ok(d)
    }
    pub fn reports_dir(&self) -> R<PathBuf> {
        let r = self.root();
        let d = r.join("reports");
        no_link(&r, &d)?;
        Ok(d)
    }

    /// Leftovers of interrupted saves (.tmp), older than a minute; returns how many were removed
    pub fn remove_temp_files(&self) -> usize {
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);   // a save may be writing a newer one
        let mut n = 0;
        let mut stack = vec![self.root()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() { stack.push(p); continue; }
                let regular = ft.is_file() || (ft.is_symlink() && fs::metadata(&p).is_ok_and(|m| m.is_file()));
                if regular && p.extension().is_some_and(|x| x == "tmp") && fs::metadata(&p).and_then(|m| m.modified()).is_ok_and(|t| t < old) && fs::remove_file(&p).is_ok() { n += 1; }
            }
        }
        n
    }

    pub fn list_users(&self) -> R<Value> {
        let mut v: Vec<Value> = Vec::new();
        let users = self.root().join("users");
        no_link(&self.root(), &users)?;
        for e in ls(&users)? {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() || !ft.is_dir() { continue; }
            // a profile counts only when its id is the folder's name: the GUI uses these ids in its pages
            let dir = e.file_name().to_string_lossy().into_owned();
            let Ok(text) = read_text(&e.path().join("profile.json")) else { continue };
            let Ok(mut u) = Value::parse(&text) else { continue };
            if !valid_id(&dir) || !u.is_object() || u.gets("id", "") != dir { continue; }
            // a projects entry that cannot be listed counts no projects; it must not hide every other profile
            let mut n = 0;
            for f in fs::read_dir(e.path().join("projects")).into_iter().flatten().flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if f.path().extension().is_some_and(|x| x == "json") && !name.contains(".meta.") { n += 1; }
            }
            u.set("projects", n);
            v.push(u);
        }
        v.sort_by(|a, b| a.gets("name", "").cmp(&b.gets("name", "")));
        Ok(Value::Arr(v))
    }

    /// name, organisation, email, terms_version (accepted now)
    pub fn create_user(&self, profile: &Value) -> R<Value> {
        let name = profile_name(profile)?;
        let id = format!("{}-{}", slug(&name), rand_suffix());
        let d = self.user_dir(&id)?;
        make_private_dirs(&d.join("projects"))?;
        let now = now_iso();
        let mut u = Value::object();
        u.set("id", id);
        u.set("name", name);
        u.set("created", now.clone());
        for k in ["organisation", "email"] {
            let v = utf8_prefix(&profile.gets(k, ""), 120);
            if !v.is_empty() { u.set(k, v); }
        }
        let tv = utf8_prefix(&profile.gets("terms_version", ""), 20);
        if !tv.is_empty() { u.set("terms_version", tv); u.set("terms_accepted", now); }
        write_atomic(&d.join("profile.json"), &u.dump())?;
        u.set("projects", 0);
        Ok(u)
    }

    pub fn accept_terms(&self, user: &str, version: &str) -> R<Value> {
        let f = self.user_dir(user)?.join("profile.json");
        if version.is_empty() || version.len() > 20 { return fail("Invalid terms version."); }
        let mut u = Value::parse(&read_text(&f)?)?;
        u.set("terms_version", version);
        u.set("terms_accepted", now_iso());
        write_atomic(&f, &u.dump())?;
        Ok(u)
    }

    /// name, organisation, email, avatar (Settings)
    pub fn update_user(&self, user: &str, ch: &Value) -> R<Value> {
        let f = self.user_dir(user)?.join("profile.json");
        if !f.exists() { return fail("No such user."); }
        let mut u = obj_of(Value::parse(&read_text(&f)?)?);
        if ch.has("name") { u.set("name", profile_name(ch)?); }
        for k in ["organisation", "email"] {
            if ch.has(k) {
                let v = utf8_prefix(&ch.gets(k, ""), 120);
                if v.is_empty() { remove(&mut u, k); } else { u.set(k, v); }
            }
        }
        if ch.has("avatar") {
            let a = ch.gets("avatar", "");
            if a.is_empty() { remove(&mut u, "avatar"); }
            else if !valid_avatar(&a) { return fail("The picture must be a PNG, JPEG or WebP image under 300 kB."); }
            else { u.set("avatar", a); }
        }
        write_atomic(&f, &u.dump())?;
        Ok(u)
    }

    pub fn delete_user(&self, user: &str) -> R<()> {
        let d = self.user_dir(user)?;
        if !d.exists() { return fail("No such user."); }
        fs::remove_dir_all(&d).map_err(|e| fs_error(&e))
    }

    pub fn list_projects(&self, user: &str) -> R<Value> {
        let d = self.user_dir(user)?.join("projects");
        let mut v: Vec<Value> = Vec::new();
        if d.exists() {
            for e in ls(&d)? {
                let fname = e.file_name().to_string_lossy().into_owned();
                let Some(id) = fname.strip_suffix(".meta.json").filter(|_| fname.len() >= 10) else { continue };
                let Ok(text) = read_text(&e.path()) else { continue };
                let Ok(mut m) = Value::parse(&text) else { continue };
                // only metas whose id is their file's name, with times as the engine writes them
                if !valid_id(id) || !m.is_object() || m.gets("id", "") != id { continue; }
                for k in ["updated", "created"] {
                    if m.has(k) && !iso_time(&m.gets(k, "")) { remove(&mut m, k); }
                }
                v.push(m);
            }
        }
        v.sort_by(|a, b| b.gets("updated", "").cmp(&a.gets("updated", "")));
        Ok(Value::Arr(v))
    }

    /// The raw JSON text of a project
    pub fn load_project(&self, user: &str, id: &str) -> R<String> {
        if !valid_id(id) { return fail("Invalid project id."); }
        read_text(&self.user_dir(user)?.join("projects").join(format!("{id}.json")))
    }

    /// An empty `id` makes a new project id
    pub fn save_project(&self, user: &str, id_in: &str, project: &Value, meta_in: &Value) -> R<Value> {
        let dir = self.user_dir(user)?;
        let d = dir.join("projects");
        if !dir.join("profile.json").exists() { return fail("No such user."); }
        make_private_dirs(&d)?;
        let id = if id_in.is_empty() { format!("{}-{}", slug(&project.gets("name", "project")), rand_suffix()) } else { id_in.to_string() };
        if !valid_id(&id) { return fail("Invalid project id."); }
        let now = now_iso();
        let created = read_text(&d.join(format!("{id}.meta.json"))).ok().and_then(|t| Value::parse(&t).ok()).map_or(now.clone(), |m| m.gets("created", &now));
        let mut p = obj_of(project.clone());
        p.set("id", id.clone());
        write_atomic(&d.join(format!("{id}.json")), &p.dump())?;
        let mut meta = obj_of(meta_in.clone());
        meta.set("id", id.clone());
        meta.set("name", project.gets("name", "Untitled"));
        meta.set("created", created);
        meta.set("updated", now);
        write_atomic(&d.join(format!("{id}.meta.json")), &meta.dump())?;
        Ok(meta)
    }

    pub fn delete_project(&self, user: &str, id: &str) -> R<()> {
        if !valid_id(id) { return fail("Invalid project id."); }
        let d = self.user_dir(user)?.join("projects");
        for f in [format!("{id}.json"), format!("{id}.meta.json")] {
            match fs::remove_file(d.join(f)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(fs_error(&e)),
            }
        }
        Ok(())
    }

    pub fn duplicate_project(&self, user: &str, id: &str) -> R<Value> {
        let mut p = Value::parse(&self.load_project(user, id)?)?;
        let meta = read_text(&self.user_dir(user)?.join("projects").join(format!("{id}.meta.json"))).ok()
            .and_then(|t| Value::parse(&t).ok()).unwrap_or_else(Value::object);
        p.set("name", format!("{} (copy)", p.gets("name", "Project")));
        self.save_project(user, "", &p, &meta)
    }
}

pub(crate) fn remove(v: &mut Value, k: &str) {
    if let Value::Obj(o) = v { o.remove(k); }
}

