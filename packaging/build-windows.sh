#!/bin/bash
# Build the Windows x64 app and its setup program: cross-compiled from macOS or Linux with mingw-w64 and NSIS
# (brew install mingw-w64 makensis), or natively on Windows in an MSYS2 UCRT64 shell
# (pacman -S mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nsis make python zip unzip).
#   ./packaging/build-windows.sh [VERSION]
#     -> dist/windows/Soloptima/                  the program folder (Soloptima.exe, WebView2Loader.dll, web/)
#        dist/Soloptima-Setup-windows-x64.exe      setup program (per-user install, Start menu, uninstaller)
#        dist/Soloptima-windows-x64.zip            the same folder to run without installing (e.g. from a USB stick)
# Soloptima.exe is static (no MinGW DLLs) and shows the interface in Microsoft Edge WebView2, which Windows 11 and current
# Windows 10 include. Signing: SOLOPTIMA_SIGN_CMD is a command that signs the file given as its last argument, for
# example "signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /a" on Windows, or jsign/osslsigncode
# with a cloud key elsewhere; Soloptima.exe and the setup program are then signed. Without it they are unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp)}"
ROOT="$PWD"
CXX="${MINGW_CXX:-x86_64-w64-mingw32-g++}"
WINDRES="${MINGW_WINDRES:-x86_64-w64-mingw32-windres}"
case "$(uname -s)" in   # native MSYS2: the compiler has no target prefix
  MINGW* | MSYS*) command -v "$CXX" >/dev/null || { CXX=g++; WINDRES=windres; } ;;
esac
OUT="$ROOT/dist/windows/Soloptima"
OBJ="$ROOT/build/windows"
SETUP="$ROOT/dist/Soloptima-Setup-windows-x64.exe"
ZIP="$ROOT/dist/Soloptima-windows-x64.zip"
sign() { if [ -n "${SOLOPTIMA_SIGN_CMD:-}" ]; then echo "    signing $(basename "$1")"; $SOLOPTIMA_SIGN_CMD "$1"; fi; }

command -v "$CXX" >/dev/null || { echo "$CXX not found. Install mingw-w64 (macOS: brew install mingw-w64)."; exit 1; }
command -v makensis >/dev/null || { echo "makensis not found. Install NSIS (macOS: brew install makensis)."; exit 1; }
rm -rf "$ROOT/dist/windows" "$OBJ" "$SETUP" "$ZIP"
mkdir -p "$OUT" "$OBJ"
./packaging/windows/fetch-webview2.sh

echo "==> Icon, manifest and version resource"
MINGW_WINDRES="$WINDRES" ./packaging/windows/resources.sh "$VERSION" "$OBJ"

echo "==> Compiling (x86_64-w64-mingw32, static)"
FLAGS=(-std=c++17 -O3 -D_WIN32_WINNT=0x0A00 -DNOMINMAX "-DSOLOPTIMA_VERSION=\"$VERSION\"" -isystem build/webview2/include)
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
ls src/*.cpp | xargs -P "$JOBS" -I{} sh -c '"$0" "$@" -c "{}" -o "'"$OBJ"'/$(basename "{}" .cpp).o"' "$CXX" "${FLAGS[@]}"
"$CXX" "${FLAGS[@]}" "$OBJ"/*.o -o "$OUT/Soloptima.exe" \
  -mwindows -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32 -lole32 -luuid -ladvapi32 -lwintrust -lcrypt32 -s
sign "$OUT/Soloptima.exe"

echo "==> Bundling web interface"
cp build/webview2/WebView2Loader.dll "$OUT/"
cp -R web "$OUT/web"
cp LICENSE NOTICE TERMS.md THIRD_PARTY_NOTICES.md "$OUT/"   # served by /api/legal from beside web/
find "$OUT" -name .DS_Store -delete
cat > "$OUT/README.txt" <<TXT
Soloptima $VERSION for Windows (64-bit)
=========================================

Start Soloptima from the Start menu (after running the setup program) or by double-clicking
Soloptima.exe. It opens in its own window; close the window, or choose "Quit Soloptima" in the
user menu, to stop it. Soloptima tells you when a new version is out and installs it when you agree.

Soloptima uses the Microsoft Edge WebView2 Runtime, which Windows 11 and current Windows 10
include. If it is missing, Soloptima offers to open the download page.

Your profiles and projects are saved in %LOCALAPPDATA%\Soloptima
(open it by typing that into the Explorer address bar). Settings, in the user menu, can move
them to another folder. To keep them next to the program instead (e.g. on a USB stick),
create an empty folder named "data\users" beside Soloptima.exe. Uninstalling Soloptima
leaves them in place.

Licence: Apache License 2.0 (LICENSE, NOTICE); TERMS.md has the terms of use. Keep LICENSE, NOTICE,
TERMS.md, THIRD_PARTY_NOTICES.md, WebView2Loader.dll and the "web" folder next to Soloptima.exe.

Internet is only needed for weather data (PVGIS, NASA POWER), weather forecasts (Open-Meteo,
MET Norway), map tiles, address lookup and place search (Esri, OpenStreetMap, Nominatim, Google
Maps view) and update checks (GitHub); everything else runs offline. TERMS.md lists what is sent.

Command line:  Soloptima.exe serve --port 8090 --data D:\my-projects --no-browser
               Soloptima.exe simulate project.json results.json
               Soloptima.exe optimize project.json results.json
TXT
perl -pi -e 's/\n/\r\n/' "$OUT/README.txt"

echo "==> Setup program"
# an explicit UTF-8 locale: makensis from Homebrew stops with bad_alloc without one
LC_ALL=C.UTF-8 makensis -V2 -DVERSION="$VERSION" -DSRC="$OUT" -DOUT="$SETUP" -DICON="$OBJ/Soloptima.ico" packaging/windows/installer.nsi
sign "$SETUP"

echo "==> Zip"
(cd "$ROOT/dist/windows" && zip -qr -X "$ZIP" Soloptima)

echo
file "$OUT/Soloptima.exe" 2>/dev/null || true
echo "Built $OUT"
echo "      $SETUP ($(du -h "$SETUP" | cut -f1))"
echo "      $ZIP ($(du -h "$ZIP" | cut -f1))"
