#!/bin/bash
# Double-click in Finder to build Soloptima from the source (on first run or after source changes) and open its window.
cd "$(dirname "$0")" || exit 1
if [ ! -x ./soloptima ] || [ -n "$(find src -newer ./soloptima \( -name '*.?pp' -o -name '*.mm' \) 2>/dev/null)" ]; then
  echo "Building Soloptima…"
  make -j4 || { echo "Build failed. Install the Xcode command line tools: xcode-select --install"; read -r; exit 1; }
fi
./soloptima
