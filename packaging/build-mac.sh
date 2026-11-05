#!/bin/bash
# Build the macOS app: a universal (Apple silicon + Intel) Soloptima.app with its own window, in a drag-to-install .dmg.
#   ./packaging/build-mac.sh [VERSION]        -> dist/mac/Soloptima.app, dist/Soloptima-mac.dmg
# Needs only the Xcode command line tools (clang, libcurl, sips, iconutil, hdiutil, codesign) and python3.
# Signing: with SOLOPTIMA_SIGN_ID set to a "Developer ID Application: ..." identity in the keychain, the app and the image
# are signed with it (hardened runtime, secure timestamp); with SOLOPTIMA_NOTARY_PROFILE also set (a notarytool keychain
# profile), the image is notarised and stapled. Without them the app is ad-hoc signed and macOS asks once before opening it.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp)}"
ROOT="$PWD"
OUT="$ROOT/dist/mac"
APP="$OUT/Soloptima.app"
OBJ="$ROOT/build/mac"
DMG="$ROOT/dist/Soloptima-mac.dmg"
SIGN_ID="${SOLOPTIMA_SIGN_ID:-}"
NOTARY="${SOLOPTIMA_NOTARY_PROFILE:-}"

rm -rf "$OUT" "$OBJ" "$DMG"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OBJ"

echo "==> Compiling universal binary (arm64 + x86_64)"
FLAGS=(-std=c++17 -O3 -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 "-DSOLOPTIMA_VERSION=\"$VERSION\"")
ls src/*.cpp | xargs -P "$(sysctl -n hw.ncpu)" -I{} sh -c 'c++ "$@" -c "{}" -o "'"$OBJ"'/$(basename "{}" .cpp).o"' _ "${FLAGS[@]}"
c++ "${FLAGS[@]}" -fobjc-arc -x objective-c++ -c src/app_mac.mm -o "$OBJ/app_mac.o"
c++ "${FLAGS[@]}" "$OBJ"/*.o -o "$APP/Contents/MacOS/Soloptima" -lcurl -framework Security -framework CoreFoundation -framework Cocoa -framework WebKit
lipo -info "$APP/Contents/MacOS/Soloptima"

echo "==> Bundling web interface"
cp -R web "$APP/Contents/Resources/web"
cp LICENSE NOTICE TERMS.md THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/"   # served by /api/legal from beside web/
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
  <key>CFBundleIdentifier</key><string>com.tirtawijata.soloptima</string>
  <key>CFBundleExecutable</key><string>Soloptima</string>
  <key>CFBundleIconFile</key><string>Soloptima</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <!-- the window loads the interface from the engine on 127.0.0.1 -->
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHumanReadableCopyright</key><string>Copyright 2026 Marcel Wijata. Apache License 2.0.</string>
</dict>
</plist>
PLIST

if [ -n "$SIGN_ID" ]; then
  echo "==> Signing with $SIGN_ID"
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
else
  echo "==> Ad-hoc code signature (set SOLOPTIMA_SIGN_ID to sign with a Developer ID)"
  codesign --force --sign - "$APP"
fi
codesign --verify --strict "$APP"

echo "==> Disk image"
STAGE="$OBJ/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Soloptima $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  if [ -n "$NOTARY" ]; then
    echo "==> Notarising (several minutes)"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY" --wait
    xcrun stapler staple "$DMG"
  fi
fi

echo
echo "Built $APP"
echo "      $DMG ($(du -h "$DMG" | cut -f1))"
