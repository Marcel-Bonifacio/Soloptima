#!/bin/bash
# Windows resources of Soloptima.exe: the app icon, the manifest (per-monitor DPI, UTF-8, common controls) and the
# version information, compiled to OUTDIR/app.res.o for the link. Used by the Makefile and build-windows.sh.
#   ./packaging/windows/resources.sh VERSION OUTDIR
set -euo pipefail
VERSION="$1"
OUT="$2"
cd "$(dirname "$0")/../.."
if [ -n "${MINGW_WINDRES:-}" ]; then WINDRES="$MINGW_WINDRES"
elif command -v x86_64-w64-mingw32-windres >/dev/null; then WINDRES=x86_64-w64-mingw32-windres
else WINDRES=windres; fi
mkdir -p "$OUT"
python3 packaging/make_icons.py "$OUT" >/dev/null
IFS=. read -r V1 V2 V3 _ <<<"$VERSION.0.0"
sed "s/@VERSION@/${V1:-1}.${V2:-0}.${V3:-0}.0/" packaging/windows/app.manifest > "$OUT/app.manifest"
cat > "$OUT/app.rc" <<RC
1 ICON "Soloptima.ico"
1 24 "app.manifest"
1 VERSIONINFO
FILEVERSION ${V1:-1},${V2:-0},${V3:-0},0
PRODUCTVERSION ${V1:-1},${V2:-0},${V3:-0},0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Marcel Wijata"
      VALUE "FileDescription", "Soloptima"
      VALUE "ProductName", "Soloptima"
      VALUE "FileVersion", "$VERSION"
      VALUE "ProductVersion", "$VERSION"
      VALUE "LegalCopyright", "Copyright 2026 Marcel Wijata"
      VALUE "OriginalFilename", "Soloptima.exe"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
RC
(cd "$OUT" && "$WINDRES" app.rc -O coff -o app.res.o)
