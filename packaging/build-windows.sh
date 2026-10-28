#!/bin/bash
# Build the Windows x64 package: cross-compiled from macOS or Linux with mingw-w64 (brew install mingw-w64), or natively on
# Windows in an MSYS2 UCRT64 shell (pacman -S mingw-w64-ucrt-x86_64-gcc make python zip).
#   ./packaging/build-windows.sh [VERSION]    -> dist/windows/Soloptima/, dist/Soloptima-<VERSION>-windows-x64.zip
# The .exe is fully static (no MinGW DLLs) and uses WinHTTP instead of libcurl, so the folder runs as-is on
# Windows 10/11. It opens a console window that shows the address; closing that window stops the app.
set -euo pipefail
VERSION="${1:-1.0.0}"
cd "$(dirname "$0")/.."
ROOT="$PWD"
CXX="${MINGW_CXX:-x86_64-w64-mingw32-g++}"
WINDRES="${MINGW_WINDRES:-x86_64-w64-mingw32-windres}"
case "$(uname -s)" in   # native MSYS2: the compiler has no target prefix
  MINGW* | MSYS*) command -v "$CXX" >/dev/null || { CXX=g++; WINDRES=windres; } ;;
esac
OUT="$ROOT/dist/windows/Soloptima"
OBJ="$ROOT/build/windows"
ZIP="$ROOT/dist/Soloptima-$VERSION-windows-x64.zip"

command -v "$CXX" >/dev/null || { echo "$CXX not found. Install mingw-w64 (macOS: brew install mingw-w64)."; exit 1; }
rm -rf "$ROOT/dist/windows" "$OBJ" "$ZIP"
mkdir -p "$OUT" "$OBJ"

echo "==> Icon and version resource"
python3 packaging/make_icons.py "$OBJ" >/dev/null
IFS=. read -r V1 V2 V3 _ <<<"$VERSION.0.0"
cat > "$OBJ/app.rc" <<RC
1 ICON "Soloptima.ico"
1 VERSIONINFO
FILEVERSION ${V1:-1},${V2:-0},${V3:-0},0
PRODUCTVERSION ${V1:-1},${V2:-0},${V3:-0},0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "FileDescription", "Soloptima - PV, battery and diesel hybrid energy modelling"
      VALUE "ProductName", "Soloptima"
      VALUE "FileVersion", "$VERSION"
      VALUE "ProductVersion", "$VERSION"
      VALUE "OriginalFilename", "Soloptima.exe"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
RC
(cd "$OBJ" && "$WINDRES" app.rc -O coff -o app.res.o)

echo "==> Compiling (x86_64-w64-mingw32, static)"
FLAGS=(-std=c++17 -O3 -D_WIN32_WINNT=0x0A00 -DNOMINMAX "-DSOLOPTIMA_VERSION=\"$VERSION\"")
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
ls src/*.cpp | xargs -P "$JOBS" -I{} sh -c '"$0" "$@" -c "{}" -o "'"$OBJ"'/$(basename "{}" .cpp).o"' "$CXX" "${FLAGS[@]}"
"$CXX" "${FLAGS[@]}" "$OBJ"/*.o -o "$OUT/Soloptima.exe" \
  -static -static-libgcc -static-libstdc++ -lws2_32 -lwinhttp -lshell32 -s

echo "==> Bundling web interface"
cp -R web "$OUT/web"
cp LICENSE.md TERMS.md THIRD_PARTY_NOTICES.md "$OUT/"   # served by /api/legal from beside web/
find "$OUT" -name .DS_Store -delete
cat > "$OUT/README.txt" <<TXT
Soloptima $VERSION for Windows (64-bit)
=========================================

Start: double-click Soloptima.exe. Your browser opens the app at http://127.0.0.1:8080/
(the next free port up to 8099 if 8080 is busy). Keep the black console window open while you
work; close it, or choose "Quit Soloptima" in the user menu, to stop the app.

First run: Windows SmartScreen may say "Windows protected your PC" because the program is not
code-signed. Click "More info" and then "Run anyway". The Windows Firewall should not ask,
because Soloptima only listens on this computer (127.0.0.1).

Your profiles and projects are saved in %LOCALAPPDATA%\Soloptima
(open it by typing that into the Explorer address bar). Settings, in the user menu, can move
them to another folder. To keep them next to the program instead (e.g. on a USB stick),
create an empty folder named "data\users" beside Soloptima.exe.

Licence: PolyForm Noncommercial 1.0.0 (LICENSE.md). Commercial use needs a separate licence
(contact: marcel@tirtawijata.com); see TERMS.md. Keep LICENSE.md, TERMS.md and THIRD_PARTY_NOTICES.md next to Soloptima.exe.

Keep the "web" folder next to Soloptima.exe. Internet is only needed for weather data
(PVGIS, NASA POWER), weather forecasts (Open-Meteo, MET Norway), map tiles, address lookup and
place search (Esri, OpenStreetMap, Nominatim, Google Maps view); everything else runs offline. TERMS.md lists
what is sent.

Command line:  Soloptima.exe serve --port 8090 --data D:\my-projects --no-browser
               Soloptima.exe simulate project.json results.json
               Soloptima.exe optimize project.json results.json
TXT
perl -pi -e 's/\n/\r\n/' "$OUT/README.txt"

echo "==> Zip"
(cd "$ROOT/dist/windows" && zip -qr -X "$ZIP" Soloptima)

echo
file "$OUT/Soloptima.exe" 2>/dev/null || true
echo "Built $OUT"
echo "      $ZIP ($(du -h "$ZIP" | cut -f1))"
