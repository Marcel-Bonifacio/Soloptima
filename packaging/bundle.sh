#!/bin/bash
# The installers of this system, built by Tauri (src-tauri/tauri.conf.json) and copied to dist/ under the release asset
# names that the README links and older copies use:
#   macOS    Soloptima-mac.dmg (universal: Apple silicon and Intel) and Soloptima-mac.app.tar.gz (the update)
#   Windows  Soloptima-Setup-windows-x64.exe (NSIS, per-user install, no administrator rights; also the update)
#   Linux    Soloptima-linux-x86_64.AppImage (also the update) and Soloptima-linux-x86_64.deb
#   ./packaging/bundle.sh
# Needs Rust (rustup), the Tauri CLI (cargo install tauri-cli --version "^2" --locked) and the system's build tools: the
# Xcode command line tools on macOS; Visual Studio Build Tools (C++) on Windows, run from Git Bash; on Linux the Tauri
# prerequisites (libwebkit2gtk-4.1-dev, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev, libcurl4-openssl-dev).
# The workflow .github/workflows/bundles.yml builds the Windows and Linux installers on GitHub's machines.
#
# Platform signing (optional; without it the installers are unsigned, the macOS app ad-hoc signed):
#   macOS    APPLE_SIGNING_IDENTITY="Developer ID Application: ..." (in the keychain); to notarise as well, APPLE_ID,
#            APPLE_PASSWORD (an app-specific password) and APPLE_TEAM_ID. Tauri reads these itself.
#   Windows  SOLOPTIMA_SIGN_CMD: a command that signs the file given as its last argument, for example
#            "signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a". The app and the setup program
#            are then signed.
# Then sign the release for the updater: packaging/sign.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
ENGINE="$(sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp)"
[ "$VERSION" = "$ENGINE" ] || { echo "Version mismatch: src-tauri/Cargo.toml has $VERSION, src/version.hpp $ENGINE."; exit 1; }
command -v cargo >/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
cargo tauri --version >/dev/null 2>&1 || { echo 'Tauri CLI not found: cargo install tauri-cli --version "^2" --locked'; exit 1; }
mkdir -p dist
echo "==> Soloptima $VERSION"
# the Svelte interface (ui/) into web/ui/, from the pinned packages of ui/package-lock.json
command -v npm >/dev/null || { echo 'npm not found: install Node.js 22 or later'; exit 1; }
npm --prefix ui ci --no-audit --no-fund
npm --prefix ui run build

case "$(uname -s)" in
  Darwin)
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
    cargo tauri build --target universal-apple-darwin --bundles app,dmg
    B=target/universal-apple-darwin/release/bundle
    cp "$B"/dmg/Soloptima_"$VERSION"_universal.dmg dist/Soloptima-mac.dmg
    COPYFILE_DISABLE=1 tar -czf dist/Soloptima-mac.app.tar.gz -C "$B/macos" Soloptima.app
    ls -l dist/Soloptima-mac.dmg dist/Soloptima-mac.app.tar.gz
    ;;
  MINGW* | MSYS* | CYGWIN*)
    ARGS=()
    if [ -n "${SOLOPTIMA_SIGN_CMD:-}" ]; then   # Tauri runs it with the file in place of %1
      CMD="$(printf '%s' "$SOLOPTIMA_SIGN_CMD %1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
      printf '{"bundle":{"windows":{"signCommand":"%s"}}}' "$CMD" > target/sign.json
      ARGS=(--config target/sign.json)
    fi
    cargo tauri build --bundles nsis ${ARGS[@]+"${ARGS[@]}"}
    cp target/release/bundle/nsis/Soloptima_"$VERSION"_x64-setup.exe dist/Soloptima-Setup-windows-x64.exe
    ls -l dist/Soloptima-Setup-windows-x64.exe
    ;;
  Linux)
    [ "$(uname -m)" = x86_64 ] || { echo "Linux installers are built on x86_64."; exit 1; }
    cargo tauri build --bundles appimage,deb
    cp target/release/bundle/appimage/Soloptima_"$VERSION"_amd64.AppImage dist/Soloptima-linux-x86_64.AppImage
    cp target/release/bundle/deb/Soloptima_"$VERSION"_amd64.deb dist/Soloptima-linux-x86_64.deb
    ls -l dist/Soloptima-linux-x86_64.*
    ;;
  *) echo "Unsupported system: $(uname -s)"; exit 1 ;;
esac
