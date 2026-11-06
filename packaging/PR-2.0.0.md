# Soloptima 2.0.0: Rust engine, Tauri shell, Svelte interface

Merges the rewrite into `main` and sets the version to 2.0.0.

## What it is

- The engine is Rust (`engine/`), linked into the application. It gives the results of the C++ engine to within rounding; the parity tests and tolerances are in `docs/VALIDATION.md`.
- The shell is Tauri 2 (`src-tauri/`). The local HTTP server of version 1 is gone; the interface calls the engine through Tauri commands.
- The interface is Svelte 5 (`ui/`), built into `web/ui/`.
- The installers come from `packaging/bundle.sh`, signed for the updater with `packaging/sign.sh`.

## Upgrade from 1.x

The 1.x updater downloads the asset, checks `SHA256SUMS.txt` and its minisign signature, then installs. These points keep that path working:

- Data folder, `Soloptima-settings.json` (location and keys), portable `data/` folder and profiles: unchanged. New test `a_1x_installation_is_found_unchanged` covers the lookup, the 1.x settings keys and a `data/` folder beside the AppImage (added to the lookup, because an AppImage runs from a temporary mount).
- Windows: `src-tauri/windows/installer.nsi` is the Tauri NSIS template with three changes (marked "Soloptima:" in the file). It installs into `%LOCALAPPDATA%\Programs\Soloptima`, finds a 1.x copy through its uninstall entry (the default of the stock template is `%LOCALAPPDATA%\Soloptima`, which holds the data), and treats the `/UPDATE` flag of the 1.x updater like passive mode (no questions, the app starts afterwards). The uninstall key `HKCU\...\Uninstall\Soloptima` is the same, so one entry remains. `src-tauri/windows/hooks.nsh` removes files that 1.x installed and 2.0 does not (`web`, `WebView2Loader.dll`, `README.txt`, `LICENSE.md`).
- macOS: bundle identifier `com.tirtawijata.soloptima`, binary `Contents/MacOS/Soloptima`, `Soloptima.app` at the root of the disk image. `signingIdentity` is set to `-` so the bundle always carries an ad-hoc signature; the 1.x updater refuses an unsigned bundle. It pins the team only when the running copy is team-signed, and releases so far are ad-hoc.
- Linux: the AppImage keeps the name `Soloptima-linux-x86_64.AppImage`.

## Tests

- `cargo test --release`
- `node tests/layout_geometry.test.js && node --test ui/tests/*.test.js`
- `npm --prefix ui ci && npm --prefix ui run build`

## Not tested here

The Windows setup program and the 1.x to 2.0 update on Windows, macOS and Linux need a run on those systems with a real 1.x copy: one copy left in Apps & features, the profiles still there, the app started after the update.

## Release

Tag `v2.0.0`. Upload the three installers, `latest.json`, the `.sig` files, `SHA256SUMS.txt` and `SHA256SUMS.txt.minisig`.
