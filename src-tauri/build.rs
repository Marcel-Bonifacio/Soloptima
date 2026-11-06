// Builds the C++ engine (src/*.cpp without the native windows, app_*) into this binary, with SOLOPTIMA_EMBEDDED: the
// engine's main() is left out and src/embedded.cpp answers the window functions. See docs/ipc.md.
use std::path::Path;

fn main() {
    tauri_build::build();

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
            println!("cargo:rustc-link-lib=framework=Security");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
        }
        "windows" => {
            for lib in ["ws2_32", "winhttp", "shell32", "ole32", "uuid", "advapi32", "wintrust", "crypt32"] {
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
