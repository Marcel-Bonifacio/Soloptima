#!/bin/bash
# Signs a release in dist/ with a release key (RELEASE_KEYS in src-tauri/src/update.rs) and writes what the updaters read:
#   <file>.sig       for each update file: the minisign signature in base64, its trusted comment naming the version
#   latest.json      the update manifest of the Tauri updater: version, notes (dist/NOTES.md), each system's file and .sig
#   SHA256SUMS.txt   and SHA256SUMS.txt.minisig, for installed 1.x copies, which update through that signed list
#   SOLOPTIMA_MINISIGN_KEY=~/.minisign/soloptima-primary.key ./packaging/sign.sh   (asks the key's password per file)
# Run it after packaging/bundle.sh, with the installers of every system in dist/. Upload all of these files to the
# release tagged v<version>. SOLOPTIMA_RELEASE_URL replaces the download address in latest.json (a test server);
# SOLOPTIMA_TEST_RELEASE_KEY accepts one more public key (a test key, never for a release).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"   # [workspace.package]
[ -n "$VERSION" ] || { echo "No version in Cargo.toml ([workspace.package])."; exit 1; }
KEYS="$(grep -o '"RW[A-Za-z0-9+/]\{54\}"' src-tauri/src/update.rs | tr -d '"') ${SOLOPTIMA_TEST_RELEASE_KEY:-}"
URL="${SOLOPTIMA_RELEASE_URL:-https://github.com/Marcel-Bonifacio/Soloptima/releases/download/v$VERSION}"
[ -n "${SOLOPTIMA_MINISIGN_KEY:-}" ] || { echo "Set SOLOPTIMA_MINISIGN_KEY to the release key's secret key file."; exit 1; }
command -v minisign >/dev/null || { echo "minisign not found (macOS: brew install minisign)."; exit 1; }
cd dist

signed_by_release_key() {   # $1: file; its .minisig must verify with a release key
  for k in $KEYS; do minisign -V -q -P "$k" -m "$1" >/dev/null 2>&1 && return 0; done
  rm -f "$1.minisig"
  echo "The signature of $1 does not verify with any release key in src-tauri/src/update.rs, so it was deleted."
  exit 1
}

# The update files: macOS app archive, Windows setup program, Linux AppImage
UPDATES=()
for f in Soloptima-mac.app.tar.gz Soloptima-Setup-windows-x64.exe Soloptima-linux-x86_64.AppImage; do [ -f "$f" ] && UPDATES+=("$f"); done
[ ${#UPDATES[@]} -gt 0 ] || { echo "No update files in dist/: run packaging/bundle.sh first."; exit 1; }
rm -f ./*.sig ./*.minisig latest.json   # signatures of an earlier build must not ship with this one
for f in "${UPDATES[@]}"; do
  echo "==> Signing $f"
  minisign -S -s "$SOLOPTIMA_MINISIGN_KEY" -m "$f" -t "$(printf 'timestamp:%s\tfile:%s\tversion:%s' "$(date +%s)" "$f" "$VERSION")"
  signed_by_release_key "$f"
  base64 < "$f.minisig" | tr -d '\n' > "$f.sig"
  rm -f "$f.minisig"
done

# The checksum list of the 1.x updater: its installers, signed for this version
FILES=()
for f in Soloptima-mac.dmg Soloptima-Setup-windows-x64.exe Soloptima-linux-x86_64.AppImage Soloptima-linux-x86_64.deb; do [ -f "$f" ] && FILES+=("$f"); done
if [ ${#FILES[@]} -gt 0 ]; then
  (shasum -a 256 "${FILES[@]}" 2>/dev/null || sha256sum "${FILES[@]}") > SHA256SUMS.txt
  echo "==> Signing SHA256SUMS.txt"
  minisign -S -s "$SOLOPTIMA_MINISIGN_KEY" -m SHA256SUMS.txt -t "soloptima $VERSION SHA256SUMS.txt"
  signed_by_release_key SHA256SUMS.txt
else
  echo "No installers in dist/, so no SHA256SUMS.txt."
fi

python3 - "$VERSION" "$URL" "${UPDATES[@]}" <<'EOF'
import datetime, json, os, sys
version, url, files = sys.argv[1], sys.argv[2].rstrip('/'), sys.argv[3:]
targets = {'Soloptima-mac.app.tar.gz': ['darwin-aarch64', 'darwin-x86_64'],
           'Soloptima-Setup-windows-x64.exe': ['windows-x86_64'], 'Soloptima-linux-x86_64.AppImage': ['linux-x86_64']}
platforms = {}
for f in files:
    entry = {'url': f'{url}/{f}', 'signature': open(f + '.sig').read().strip()}
    for t in targets[f]:
        platforms[t] = entry
notes = open('NOTES.md').read().strip() if os.path.exists('NOTES.md') else ''
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
json.dump({'version': version, 'notes': notes, 'pub_date': now, 'platforms': platforms},
          open('latest.json', 'w'), indent=2)
EOF
echo "Signed release $VERSION: ${UPDATES[*]}, SHA256SUMS.txt and latest.json in dist/."
