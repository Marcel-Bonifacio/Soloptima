// The engine is the Rust crate engine/ (a normal dependency). The Svelte interface is built by npm (ui/, docs/ui.md), not by
// cargo; without it the window shows no top bar.
use std::path::Path;

fn main() {
    tauri_build::build();
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/ui/app.js");
    println!("cargo:rerun-if-changed={}", ui.display());
    if !ui.exists() {
        println!("cargo:warning=web/ui/app.js is missing: run `npm --prefix ui ci && npm --prefix ui run build` (needs Node.js) before running or bundling the app");
    }
}
