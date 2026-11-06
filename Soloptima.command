#!/bin/bash
# Double-click in Finder to build Soloptima from the source and open its window (the first build takes a few minutes).
# Needs Rust (https://rustup.rs) and Node.js 22 or later.
cd "$(dirname "$0")" || exit 1
command -v cargo >/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
if [ ! -f web/ui/app.js ] || [ -n "$(find ui/src -newer web/ui/app.js 2>/dev/null)" ]; then
  echo "Building the interface…"
  { npm --prefix ui ci --no-audit --no-fund && npm --prefix ui run build; } || { echo "Build failed. Install Node.js 22 or later."; read -r; exit 1; }
fi
cargo run --release -p soloptima-app || { echo "Build failed. Install Rust (https://rustup.rs) and the Xcode command line tools: xcode-select --install"; read -r; exit 1; }
