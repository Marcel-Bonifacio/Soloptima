#!/bin/bash
# Build the macOS app: a universal (Apple silicon + Intel) Soloptima.app and a drag-to-install .dmg.
#   ./packaging/build-mac.sh [VERSION]        -> dist/mac/Soloptima.app, dist/Soloptima-<VERSION>-mac.dmg
# Needs only the Xcode command line tools (clang, libcurl, sips, iconutil, hdiutil, codesign) and python3.
# The app is ad-hoc signed, not notarised: first launch needs right-click > Open (see README).
set -euo pipefail
VERSION="${1:-1.0.0}"
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/dist/mac"
APP="$OUT/Soloptima.app"
OBJ="$ROOT/build/mac"
DMG="$ROOT/dist/Soloptima-$VERSION-mac.dmg"

rm -rf "$OUT" "$OBJ" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OBJ"

echo "==> Compiling universal binary (arm64 + x86_64)"
FLAGS=(-std=c++17 -O3 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 "-DSOLOPTIMA_VERSION=\"$VERSION\"")
ls src/*.cpp | xargs -P "$(sysctl -n hw.ncpu)" -I{} sh -c 'c++ "$@" -c "{}" -o "'"$OBJ"'/$(basename "{}" .cpp).o"' _ "${FLAGS[@]}"
c++ "${FLAGS[@]}" "$OBJ"/*.o -o "$APP/Contents/MacOS/Soloptima" -lcurl
lipo -info "$APP/Contents/MacOS/Soloptima"

echo "==> Bundling web interface"
cp -R web "$APP/Contents/Resources/web"
cp LICENSE.md TERMS.md THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"   # served by /api/legal from beside web/
find "$APP" -name .DS_Store -delete

echo "==> App icon"
python3 packaging/make_icons.py "$OBJ/icons" >/dev/null
SET="$OBJ/Soloptima.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$OBJ/icons/icon_1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$OBJ/icons/icon_1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/Soloptima.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Soloptima</string>
  <key>CFBundleDisplayName</key><string>Soloptima</string>
  <key>CFBundleIdentifier</key><string>local.soloptima.app</string>
  <key>CFBundleExecutable</key><string>Soloptima</string>
  <key>CFBundleIconFile</key><string>Soloptima</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- Background helper: the interface opens in the default browser; quit from the user menu there -->
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Soloptima $VERSION</string>
</dict>
</plist>
PLIST

echo "==> Ad-hoc code signature"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> Disk image"
STAGE="$OBJ/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
cp LICENSE.md "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Soloptima $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

echo
echo "Built $APP"
echo "      $DMG ($(du -h "$DMG" | cut -f1))"
