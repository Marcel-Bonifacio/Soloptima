#!/bin/bash
# dist/SHA256SUMS.txt for a release and its minisign signature, dist/SHA256SUMS.txt.minisig. An installed copy takes an
# update only when the list is signed with a release key (RELEASE_KEYS in src/update.cpp) for that version and the
# installer matches the list. The version is the one in src/version.hpp; tag the release v<version>.
#   SOLOPTIMA_MINISIGN_KEY=~/.minisign/soloptima-primary.key ./packaging/checksums.sh   (asks for the key's password)
#   ./packaging/checksums.sh --unsigned                                                    a local build, not for release
# Upload both files with the installers: Soloptima-mac.dmg, Soloptima-Setup-windows-x64.exe, Soloptima-windows-x64.zip,
# Soloptima-linux-x86_64.AppImage and Soloptima-linux-x86_64.tar.gz.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/.*define SOLOPTIMA_VERSION "\(.*\)"/\1/p' src/version.hpp)"
KEYS="$(grep -o '"RW[A-Za-z0-9+/]\{54\}"' src/update.cpp | tr -d '"')"
cd dist
FILES=()
for f in Soloptima-mac.dmg Soloptima-Setup-windows-x64.exe Soloptima-windows-x64.zip Soloptima-linux-x86_64.AppImage Soloptima-linux-x86_64.tar.gz; do [ -f "$f" ] && FILES+=("$f"); done
[ ${#FILES[@]} -gt 0 ] || { echo "No installers in dist/."; exit 1; }
rm -f SHA256SUMS.txt.minisig   # a signature of an earlier list must not ship with this one
(shasum -a 256 "${FILES[@]}" 2>/dev/null || sha256sum "${FILES[@]}") > SHA256SUMS.txt
cat SHA256SUMS.txt

if [ "${1:-}" = "--unsigned" ]; then
  echo "Not signed: installed copies will not install this build as an update."
  exit 0
fi
[ -n "${SOLOPTIMA_MINISIGN_KEY:-}" ] || { echo "Set SOLOPTIMA_MINISIGN_KEY to the release key's secret key file, or pass --unsigned for a local build."; exit 1; }
command -v minisign >/dev/null || { echo "minisign not found (macOS: brew install minisign)."; exit 1; }
minisign -S -s "$SOLOPTIMA_MINISIGN_KEY" -m SHA256SUMS.txt -t "soloptima $VERSION SHA256SUMS.txt"
for k in $KEYS; do
  if minisign -V -q -P "$k" -m SHA256SUMS.txt >/dev/null 2>&1; then
    echo "Signed for release $VERSION with release key $k."
    exit 0
  fi
done
rm -f SHA256SUMS.txt.minisig
echo "The signature does not verify with any release key in src/update.cpp, so it was deleted."
exit 1
