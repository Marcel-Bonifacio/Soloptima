#!/bin/bash
# Build the Linux x86_64 packages:
#   dist/Soloptima-linux-x86_64.AppImage   one file that runs on most distributions and updates itself
#   dist/Soloptima-linux-x86_64.tar.gz     the program folder, to unpack and run from anywhere
#   ./packaging/build-linux.sh [VERSION]
# On Linux x86_64 it builds directly (needs g++, make, libcurl4-openssl-dev, python3, curl). Elsewhere, for example on a
# Mac, it builds inside an Ubuntu 20.04 container with Docker, which also keeps the program running on older
# distributions (glibc 2.31 and later). The window uses the system's WebKitGTK (libwebkit2gtk-4.1 or -4.0), loaded at run
# time; without it, Soloptima shows the interface in the default browser. The AppImage tools are fetched at pinned
# versions and checked by SHA-256.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp)}"
ROOT="$PWD"

if [ -z "${SOLOPTIMA_IN_CONTAINER:-}" ] && { [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; }; then
  command -v docker >/dev/null || { echo "Linux packages build on Linux x86_64, or anywhere with Docker."; exit 1; }
  echo "==> Building in an Ubuntu 20.04 (x86_64) container"
  exec docker run --rm --platform linux/amd64 -e SOLOPTIMA_IN_CONTAINER=1 -v "$ROOT":/src -w /src ubuntu:20.04 bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq g++ make libcurl4-openssl-dev python3 curl ca-certificates file >/dev/null
    ./packaging/build-linux.sh '$VERSION'; rc=\$?
    chown -R $(id -u):$(id -g) dist build
    exit \$rc"
fi

APPIMAGETOOL_VERSION=1.9.1
APPIMAGETOOL_SHA256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_VERSION=20251108
RUNTIME_SHA256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
OBJ="$ROOT/build/linux"
TOOLS="$ROOT/build/linux-tools"
OUT="$ROOT/dist/linux/Soloptima"
APPDIR="$ROOT/build/linux/Soloptima.AppDir"
IMAGE="$ROOT/dist/Soloptima-linux-x86_64.AppImage"
TGZ="$ROOT/dist/Soloptima-linux-x86_64.tar.gz"
rm -rf "$ROOT/dist/linux" "$OBJ" "$IMAGE" "$TGZ"
mkdir -p "$OUT" "$OBJ" "$TOOLS"

echo "==> Compiling (x86_64, static libstdc++)"
FLAGS=(-std=c++17 -O3 "-DSOLOPTIMA_VERSION=\"$VERSION\"")
ls src/*.cpp | xargs -P "$(nproc)" -I{} sh -c 'g++ "$@" -c "{}" -o "'"$OBJ"'/$(basename "{}" .cpp).o"' _ "${FLAGS[@]}"
g++ "${FLAGS[@]}" "$OBJ"/*.o -o "$OUT/soloptima" -lcurl -lpthread -ldl -static-libstdc++ -static-libgcc -s

echo "==> Program folder"
python3 packaging/make_icons.py "$OBJ/icons" >/dev/null
cp -R web "$OUT/web"
cp LICENSE NOTICE TERMS.md THIRD_PARTY_NOTICES.md "$OUT/"   # served by /api/legal from beside web/
cp "$OBJ/icons/icon_256.png" "$OUT/soloptima.png"
cp packaging/linux/soloptima.desktop "$OUT/"
find "$OUT" -name .DS_Store -delete
cat > "$OUT/README.txt" <<TXT
Soloptima $VERSION for Linux (x86_64)
=====================================

Start: run ./soloptima in this folder. Soloptima opens in its own window when WebKitGTK is installed
(libwebkit2gtk-4.1 or libwebkit2gtk-4.0, part of most desktop installations; for example
"sudo apt install libwebkit2gtk-4.1-0" on Ubuntu 22.04 and later). Without it, Soloptima shows the same
interface in your default browser. Close the window, or choose "Quit Soloptima" in the user menu, to stop it.

To add it to your applications menu, edit the Exec and Icon lines of soloptima.desktop to the full paths of
soloptima and soloptima.png in this folder, then copy it to ~/.local/share/applications/.

This folder does not update itself: Soloptima tells you when a new version is out and links to the release
page. The AppImage version (Soloptima-linux-x86_64.AppImage) installs updates itself.

Your profiles and projects are saved in ~/.local/share/Soloptima (or \$XDG_DATA_HOME/Soloptima).
Settings, in the user menu, can move them to another folder.

Licence: Apache License 2.0 (LICENSE, NOTICE); TERMS.md has the terms of use. Keep LICENSE, NOTICE,
TERMS.md, THIRD_PARTY_NOTICES.md and the "web" folder next to the program.

Command line:  ./soloptima simulate project.json out.json
               ./soloptima simulate project.json results.json
               ./soloptima optimize project.json results.json
TXT

echo "==> tar.gz"
(cd "$ROOT/dist/linux" && tar -czf "$TGZ" Soloptima)

echo "==> AppImage"
fetch() {   # url file sha256
  [ -f "$2" ] && [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ] && return 0
  curl -fsSL -o "$2" "$1"
  [ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ] || { echo "Checksum mismatch: $2" >&2; rm -f "$2"; exit 1; }
}
fetch "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-x86_64.AppImage" "$TOOLS/appimagetool" "$APPIMAGETOOL_SHA256"
fetch "https://github.com/AppImage/type2-runtime/releases/download/$RUNTIME_VERSION/runtime-x86_64" "$TOOLS/runtime-x86_64" "$RUNTIME_SHA256"
# Run a copy without the AppImage marker in the ELF header padding (bytes 8 to 10): the x86_64 emulation that Docker
# uses on other machines does not recognise the file with it. The tool itself is unchanged.
cp "$TOOLS/appimagetool" "$OBJ/appimagetool"
printf '\0\0\0' | dd of="$OBJ/appimagetool" bs=1 seek=8 count=3 conv=notrunc 2>/dev/null
chmod +x "$OBJ/appimagetool"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/soloptima" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp "$OUT/soloptima" "$APPDIR/usr/bin/"
cp -R "$OUT/web" "$OUT/LICENSE" "$OUT/NOTICE" "$OUT/TERMS.md" "$OUT/THIRD_PARTY_NOTICES.md" "$APPDIR/usr/share/soloptima/"
cp packaging/linux/soloptima.desktop "$APPDIR/"
cp packaging/linux/soloptima.desktop "$APPDIR/usr/share/applications/"
cp "$OUT/soloptima.png" "$APPDIR/soloptima.png"
cp "$OUT/soloptima.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/"
cat > "$APPDIR/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/soloptima" "$@"
RUN
chmod +x "$APPDIR/AppRun"
ARCH=x86_64 "$OBJ/appimagetool" --appimage-extract-and-run --runtime-file "$TOOLS/runtime-x86_64" "$APPDIR" "$IMAGE" > "$OBJ/appimagetool.log" 2>&1 ||
  { cat "$OBJ/appimagetool.log" >&2; exit 1; }

echo
file "$OUT/soloptima" 2>/dev/null || true
echo "Built $IMAGE ($(du -h "$IMAGE" | cut -f1))"
echo "      $TGZ ($(du -h "$TGZ" | cut -f1))"
