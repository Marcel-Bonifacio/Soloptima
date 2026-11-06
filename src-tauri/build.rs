// Builds the C++ engine (src/*.cpp without the native windows, app_*) into this binary, with SOLOPTIMA_EMBEDDED: the
// engine's main() is left out and src/embedded.cpp answers the window functions. See docs/ipc.md.
use std::path::Path;

fn main() {
    tauri_build::build();

    // the Svelte interface is built by npm (ui/, docs/ui.md), not by cargo; without it the window shows no top bar
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/ui/app.js");
    println!("cargo:rerun-if-changed={}", ui.display());
    if !ui.exists() {
        println!("cargo:warning=web/ui/app.js is missing: run `make ui` (needs Node.js) before running or bundling the app");
    }

    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
    let mut files: Vec<_> = std::fs::read_dir(&src)
        .expect("src/ next to src-tauri/")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.ends_with(".cpp") && !name.starts_with("app_")
        })
        .collect();
    files.sort();

    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let mut b = cc::Build::new();
    b.cpp(true)
        .std("c++17")
        .opt_level(3)
        .define("SOLOPTIMA_EMBEDDED", None)
        .warnings(false)
        .files(&files);
    if target == "windows" {
        b.define("_WIN32_WINNT", "0x0A00").define("NOMINMAX", None);
    }
    b.compile("soloptima_engine");

    match target.as_str() {
        "macos" => {
            println!("cargo:rustc-link-lib=curl");
        }
        "windows" => {
            for lib in ["ws2_32", "winhttp", "shell32", "ole32", "uuid", "advapi32"] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        _ => {
            println!("cargo:rustc-link-lib=curl");
            println!("cargo:rustc-link-lib=dl");
        }
    }
    println!("cargo:rerun-if-changed=../src");
}
