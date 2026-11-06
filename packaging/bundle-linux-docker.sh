#!/bin/bash
# Builds the Linux installers (AppImage and .deb) in a linux/amd64 Ubuntu 22.04 container, for a build on a Mac or any
# machine with Docker. The source is copied in (the host's target/, node_modules and dist/ stay out); the compiled
# files are kept in Docker volumes, so a second run is quick. The result lands in dist/ under the release asset names.
#   ./packaging/bundle-linux-docker.sh
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=soloptima-linux-build
docker build --platform linux/amd64 -t "$IMAGE" packaging/linux
mkdir -p dist
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src:ro -v "$PWD/dist":/out \
  -v soloptima-linux-target:/work/target -v soloptima-linux-cargo:/opt/cargo/registry \
  "$IMAGE" bash -c '
    set -euo pipefail
    tar -C /src --exclude=./target --exclude=./dist --exclude=./.git --exclude=./ui/node_modules --exclude=./web/ui \
        --exclude=./src-tauri/gen -cf - . | tar -C /work -xf -
    ./packaging/bundle.sh
    cp dist/Soloptima-linux-x86_64.* /out/
  '
ls -l dist/Soloptima-linux-x86_64.*
