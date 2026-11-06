//! Updates from the project's GitHub releases through the Tauri updater. Each release carries `latest.json` (version,
//! notes, and per system the download and its minisign signature) next to the installers; see packaging/sign.sh.
//! An update is used only when its signature verifies with a release key and its signed trusted comment names the
//! version the manifest announces (`version:` field), so an older signed file cannot pose as a newer release.
//! Nothing is downloaded until the user confirms (ui/src/lib/update.svelte.js).

use crate::commands::ApiError;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The release keys (minisign public keys). The primary signs every release; the backup stays offline for the day the
/// primary is lost or leaks: the next release is then signed with the backup and leaves the primary out of this list.
pub const RELEASE_KEYS: &[&str] = &[
    "RWR6YPgDfnr/AvAU3ic9n0SV8Vl2uuwYdTnubgXNIgz2hU3GBtSHbTp1", // primary, key id 02FF7A7E03F8607A
    "RWSmvzlnQLjAxzvwW72sT00ANO32ly9wtiPeT93cMU4mJenihQuMN/ej", // backup, key id C7C0B8406739BFA6
];

/// A key for an update test server, built in only when SOLOPTIMA_TEST_RELEASE_KEY is set at build time (never for a
/// release). Such a build also reads the manifest address from SOLOPTIMA_UPDATE_URL and accepts plain http.
pub const TEST_KEY: Option<&str> = option_env!("SOLOPTIMA_TEST_RELEASE_KEY");

const MANIFEST: &str = "https://github.com/Marcel-Bonifacio/Soloptima/releases/latest/download/latest.json";
const RELEASE_PAGE: &str = "https://github.com/Marcel-Bonifacio/Soloptima/releases/latest";

fn keys() -> Vec<&'static str> {
    RELEASE_KEYS.iter().copied().chain(TEST_KEY).collect()
}

fn manifest_url() -> String {
    match (TEST_KEY, std::env::var("SOLOPTIMA_UPDATE_URL")) {
        (Some(_), Ok(u)) => u,
        _ => MANIFEST.into(),
    }
}

/// The 8-byte key id of a minisign key or signature line (algorithm, key id, then the key or signature)
fn key_id(line: &str) -> Option<[u8; 8]> {
    let b = B64.decode(line.trim()).ok()?;
    b.get(2..10)?.try_into().ok()
}

/// The key id a release signature (base64 of the .minisig file, as in latest.json) was made with
fn signature_key_id(sig: &str) -> Option<[u8; 8]> {
    let text = String::from_utf8(B64.decode(sig.trim()).ok()?).ok()?;
    key_id(text.lines().nth(1)?)
}

/// A release key in the updater's form: base64 of a minisign .pub file
fn updater_key(key: &str) -> String {
    B64.encode(format!("untrusted comment: minisign public key\n{key}\n"))
}

/// The latest release if it is newer, checked with the release key that signed it; an unknown key is refused before
/// anything is downloaded.
async fn latest(app: &AppHandle) -> Result<Option<Update>, ApiError> {
    let fail = |e: tauri_plugin_updater::Error| match e {
        // GitHub answered, but not with a manifest: the latest release has no latest.json (or GitHub failed)
        tauri_plugin_updater::Error::ReleaseNotFound => ApiError::new(
            "GitHub has no update information for the latest release (latest.json), so Soloptima cannot update itself \
             from it. Try again later, or download the new version from the releases page."),
        e => ApiError::new(e.to_string()),
    };
    let url: tauri::Url = manifest_url().parse().map_err(|_| ApiError::internal("Bad update address."))?;
    let keys = keys();
    let build = |key: &str| app.updater_builder().endpoints(vec![url.clone()])?.pubkey(updater_key(key)).build();
    let Some(update) = build(keys[0]).map_err(fail)?.check().await.map_err(fail)? else { return Ok(None) };
    let id = signature_key_id(&update.signature).ok_or_else(|| ApiError::new("The update's signature is unreadable."))?;
    match keys.iter().find(|k| key_id(k) == Some(id)) {
        None => Err(ApiError::new("The update is not signed with a Soloptima release key, so it was not used.")),
        Some(k) if *k == keys[0] => Ok(Some(update)),
        Some(k) => build(k).map_err(fail)?.restore_update(update.raw_json.clone()).map_err(fail),
    }
}

/// Whether this copy can replace itself: the macOS app bundle, the AppImage, the Windows installation
fn installable() -> bool {
    if cfg!(target_os = "macos") {
        std::env::current_exe().map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")).unwrap_or(false)
    } else if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        cfg!(target_os = "windows")
    }
}

/// The update found by the last check, its download, and the download's progress in bytes
#[derive(Default)]
pub struct Updates {
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    done: AtomicU64,
    total: AtomicU64,
}

/// The update found by the last check
fn checked(st: &Updates) -> Result<Update, ApiError> {
    st.update.lock().unwrap().clone().ok_or_else(|| ApiError::new("Check for updates first."))
}

/// {current, latest, newer, name, notes, url, published, installable}
#[tauri::command]
pub async fn update_check(app: AppHandle, st: State<'_, Updates>) -> Result<Value, ApiError> {
    let current = app.package_info().version.to_string();
    let found = latest(&app).await?;
    let info = match &found {
        None => json!({"current": current, "latest": current, "newer": false, "installable": installable()}),
        Some(u) => json!({
            "current": current, "latest": u.version, "newer": true, "installable": installable(),
            "name": format!("Soloptima {}", u.version), // not in latest.json: the updater reads "name" as the version
            "notes": u.body.clone().unwrap_or_default(),
            "url": RELEASE_PAGE,
            "published": u.raw_json.get("pub_date").and_then(Value::as_str).unwrap_or(""),
        }),
    };
    let mut slot = st.update.lock().unwrap();
    if found.as_ref().map(|u| &u.version) != slot.as_ref().map(|u| &u.version) {
        *st.bytes.lock().unwrap() = None; // a download of another version is no longer wanted
    }
    *slot = found;
    drop(slot);
    Ok(info)
}

/// Downloads the update of the last check and verifies its signature; update_progress reports meanwhile.
#[tauri::command]
pub async fn update_download(st: State<'_, Updates>) -> Result<Value, ApiError> {
    let update = checked(&st)?;
    st.done.store(0, Ordering::Relaxed);
    st.total.store(0, Ordering::Relaxed);
    let bytes = update
        .download(
            |n, total| {
                st.done.fetch_add(n as u64, Ordering::Relaxed);
                st.total.store(total.unwrap_or(0), Ordering::Relaxed);
            },
            || {},
        )
        .await
        .map_err(|e| ApiError::new(format!("The update could not be downloaded or did not verify: {e}")))?;
    *st.bytes.lock().unwrap() = Some(bytes);
    Ok(json!({}))
}

/// {progress, total} of the running download, in bytes
#[tauri::command]
pub fn update_progress(st: State<'_, Updates>) -> Value {
    json!({"progress": st.done.load(Ordering::Relaxed), "total": st.total.load(Ordering::Relaxed)})
}

/// Installs the verified download. The page has saved its work: macOS and Linux replace the app and restart it; on
/// Windows the setup program takes over and the app closes.
#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, Updates>) -> Result<Value, ApiError> {
    let update = checked(&st)?;
    let bytes = st.bytes.lock().unwrap().take().ok_or_else(|| ApiError::new("Download the update first."))?;
    update.install(&bytes).map_err(|e| ApiError::new(format!("The update could not be installed: {e}")))?;
    if cfg!(target_os = "windows") {
        return Ok(json!({"mode": "installer"}));
    }
    let restart = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800)); // the page shows that it restarts
        restart.restart();
    });
    Ok(json!({"mode": "replaced"}))
}

/// Test builds only (TEST_KEY): with SOLOPTIMA_UPDATE_SELFTEST=download or =install the app checks, downloads (and
/// installs) at start without the page, prints each step on stderr and exits. Drives the local fake-release test.
pub fn selftest(app: &AppHandle) {
    let Some(mode) = TEST_KEY.and(std::env::var("SOLOPTIMA_UPDATE_SELFTEST").ok()) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let step = |name: &str, r: Result<Value, ApiError>| match r {
            Ok(v) => eprintln!("selftest {name}: {v}"),
            Err(e) => eprintln!("selftest {name} failed: {}", e.error),
        };
        let info = update_check(app.clone(), app.state()).await;
        let newer = matches!(&info, Ok(v) if v["newer"] == true);
        step("check", info);
        if newer {
            let ok = update_download(app.state()).await;
            let downloaded = ok.is_ok();
            step("download", ok);
            eprintln!("selftest progress: {}", update_progress(app.state()));
            if downloaded && mode == "install" {
                step("install", update_install(app.clone(), app.state()).await);
                return; // restarts
            }
        }
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_keys_have_their_ids() {
        let hex = |k: &str| key_id(k).unwrap().iter().rev().map(|b| format!("{b:02X}")).collect::<String>();
        assert_eq!(hex(RELEASE_KEYS[0]), "02FF7A7E03F8607A");
        assert_eq!(hex(RELEASE_KEYS[1]), "C7C0B8406739BFA6");
        // a signature line: "ED", the key id, 64 signature bytes
        let id = key_id(RELEASE_KEYS[1]).unwrap();
        let line = B64.encode([&b"ED"[..], &id, &[0u8; 64]].concat());
        assert_eq!(signature_key_id(&B64.encode(format!("untrusted comment: x\n{line}\ntrusted comment: y\n"))), Some(id));
        assert_eq!(signature_key_id("not base64"), None);
    }
}
