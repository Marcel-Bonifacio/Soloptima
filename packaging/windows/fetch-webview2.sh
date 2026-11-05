#!/bin/bash
# The Microsoft Edge WebView2 SDK for the Windows window (src/app_win.cpp): its headers to compile against and
# WebView2Loader.dll to ship next to Soloptima.exe. Fetched from NuGet at a pinned version and checked by SHA-256.
#   ./packaging/windows/fetch-webview2.sh   -> build/webview2/{include/WebView2.h, WebView2Loader.dll, LICENSE.txt}
set -euo pipefail
VERSION=1.0.4258.31
SHA256=56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9
cd "$(dirname "$0")/../.."
OUT=build/webview2
[ -f "$OUT/include/WebView2.h" ] && [ -f "$OUT/WebView2Loader.dll" ] && exit 0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> WebView2 SDK $VERSION"
curl -fsSL -o "$TMP/sdk.nupkg" "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$VERSION/microsoft.web.webview2.$VERSION.nupkg"
GOT="$( (shasum -a 256 "$TMP/sdk.nupkg" 2>/dev/null || sha256sum "$TMP/sdk.nupkg") | cut -d' ' -f1)"
[ "$GOT" = "$SHA256" ] || { echo "WebView2 SDK checksum mismatch: $GOT" >&2; exit 1; }
unzip -q "$TMP/sdk.nupkg" -d "$TMP/sdk"
mkdir -p "$OUT/include"
cp "$TMP/sdk/build/native/include/WebView2.h" "$TMP/sdk/build/native/include/WebView2EnvironmentOptions.h" "$OUT/include/"
cp "$TMP/sdk/runtimes/win-x64/native/WebView2Loader.dll" "$TMP/sdk/LICENSE.txt" "$OUT/"
