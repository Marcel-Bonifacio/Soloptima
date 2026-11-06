//! Safe file access in the data folder (src/storage.cpp, src/platform.cpp): atomic writes through exclusive temporary files,
//! reads that never follow a link, folders only the owner can enter, ids that cannot name anything else.
use crate::json::Error;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_DATA_FILE: u64 = 256 << 20;   // a project with every hourly series is a few MiB

/// An OS error as the C++ engine words a filesystem error of the data folder
pub fn fs_error(e: &std::io::Error) -> Error {
    let mut m = e.to_string();
    if let Some(i) = m.find(" (os error") { m.truncate(i); }
    Error(format!("Cannot use the data folder: {m}."))
}

/// Six random characters of an alphabet without look-alikes, for names of temporary files and new ids
pub fn rand_suffix() -> String {
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut x = STATE.load(Ordering::Relaxed);
    if x == 0 {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64);
        x = t ^ (u64::from(std::process::id()) << 32) | 1;
    }
    const AL: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut s = String::new();
    for _ in 0..6 {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;   // xorshift64
        s.push(AL[((x >> 16) % 32) as usize] as char);
    }
    STATE.store(x, Ordering::Relaxed);
    s
}

/// Creates `p` and any missing folder above it; created folders are owner-only (0700) on POSIX, existing ones keep their modes
/// (a folder the user chose may be shared on purpose).
pub fn make_private_dirs(p: &Path) -> Result<(), Error> {
    if p.as_os_str().is_empty() || p.is_dir() { return Ok(()); }
    if let Some(parent) = p.parent() { if parent != p { make_private_dirs(parent)?; } }   // a root has no parent: creating it fails below
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);   // never readable by others, not even for a moment
    match b.create(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(fs_error(&e)),
    }
}

/// Writes to a new, exclusively created temporary file next to the target (never through a name or link placed there), then
/// renames it over the target. The .tmp ending lets Clear cache find leftovers.
pub fn write_atomic(p: &Path, text: &str) -> Result<(), Error> {
    let fail = || Error("Cannot write a file in the data folder (is the disk full?).".into());
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = p.parent().unwrap_or_else(|| Path::new(""));
    let mut attempt = 0;
    loop {
        let tmp = dir.join(format!(".{name}.{}.tmp", rand_suffix()));
        let mut o = fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
        #[cfg(windows)]
        { use std::os::windows::fs::OpenOptionsExt; o.share_mode(0); }
        let mut f = match o.open(&tmp) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => { attempt += 1; continue; }
            Err(_) => return Err(fail()),
        };
        let ok = f.write_all(text.as_bytes()).is_ok() && f.flush().is_ok();
        drop(f);
        if !ok {   // disk full or no access: keep the existing file
            let _ = fs::remove_file(&tmp);
            return Err(fail());
        }
        return fs::rename(&tmp, p).map_err(|e| { let _ = fs::remove_file(&tmp); fs_error(&e) });
    }
}

/// A file in the data folder: a regular file of sane size, never read through a link (the folder may come from elsewhere)
pub fn read_text(p: &Path) -> Result<String, Error> {
    let nf = || Error("Not found.".into());
    #[cfg(unix)]
    let mut f = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(p).map_err(|_| nf())?
    };
    #[cfg(not(unix))]
    let mut f = {
        let st = fs::symlink_metadata(p).map_err(|_| nf())?;
        if !st.is_file() { return Err(nf()); }
        fs::File::open(p).map_err(|_| nf())?
    };
    let st = f.metadata().map_err(|_| nf())?;
    if !st.is_file() || st.len() > MAX_DATA_FILE { return Err(nf()); }
    let mut b = Vec::with_capacity(st.len() as usize);
    f.read_to_end(&mut b).map_err(|_| nf())?;
    Ok(String::from_utf8(b).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// No folder between the data root and p may be a link: a folder opened from another computer must not point Soloptima's reads
/// and writes at the user's other files
pub fn no_link(root: &Path, p: &Path) -> Result<(), Error> {
    let mut cur: PathBuf = root.to_path_buf();
    let Ok(rel) = p.strip_prefix(root) else { return Ok(()) };
    for part in rel.components() {
        cur.push(part);
        if fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error(format!("The data folder holds a link ({}), which Soloptima does not follow.", part.as_os_str().to_string_lossy())));
        }
    }
    Ok(())
}

/// Lower-case letters and digits of a name joined by single dashes, at most 24 characters
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.bytes() {
        if c.is_ascii_alphanumeric() { s.push(c.to_ascii_lowercase() as char); }
        else if !s.is_empty() && !s.ends_with('-') { s.push('-'); }
        if s.len() >= 24 { break; }
    }
    while s.ends_with('-') { s.pop(); }
    if s.is_empty() { "item".into() } else { s }
}

/// The first `max_cp` code points of a UTF-8 string (never cuts inside a character)
pub fn utf8_prefix(s: &str, max_cp: usize) -> String { s.chars().take(max_cp).collect() }

/// An id that names a file: 1 to 64 letters, digits, '-' and '_', and not a name Windows reserves for devices
pub fn valid_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 64 || !s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') { return false; }
    let u = s.to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") { return false; }
    !(u.len() == 4 && (u.starts_with("COM") || u.starts_with("LPT")) && (b'1'..=b'9').contains(&u.as_bytes()[3]))
}

/// An "updated" or "created" time as the engine writes it (2026-01-31T12:00:00Z)
pub fn iso_time(s: &str) -> bool { s.len() <= 32 && s.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'-' | b':' | b'T' | b'Z' | b'.' | b'+')) }

/// std::atoi: leading white space, a sign, then digits; 0 when there are none
pub fn atoi(s: &str) -> i32 {
    let b = s.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']).as_bytes();
    let (neg, rest) = match b.first() { Some(b'-') => (true, &b[1..]), Some(b'+') => (false, &b[1..]), _ => (false, b) };
    let mut v: i64 = 0;
    for &c in rest.iter().take_while(|c| c.is_ascii_digit()) { v = (v * 10 + i64::from(c - b'0')).min(i64::from(i32::MAX) + 1); }
    (if neg { -v } else { v }).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}
