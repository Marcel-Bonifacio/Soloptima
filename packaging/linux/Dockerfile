# Build image for the Linux installers (AppImage and .deb), linux/amd64, on Ubuntu 22.04, the oldest release that ships
# libwebkit2gtk-4.1 (what Tauri 2 needs). The AppImage then runs on that glibc and newer.
# Used by packaging/bundle-linux-docker.sh; see there.
FROM --platform=linux/amd64 ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11
ARG RUST_VERSION=1.99.1
ARG TAURI_CLI_VERSION=2.12.4
ARG NODE_VERSION=22.12.0
ENV DEBIAN_FRONTEND=noninteractive CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:/opt/node/bin:$PATH \
    APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates xz-utils file patchelf pkg-config git \
      libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev \
      libfuse2 desktop-file-utils squashfs-tools wget \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /opt/node && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt/node --strip-components=1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && cargo install tauri-cli --version "${TAURI_CLI_VERSION}" --locked
# The AppImage plugin of linuxdeploy (Tauri downloads it from an unpinned "continuous" URL): fetched here and pinned by
# hash. Its AppImage marker (bytes 8 to 10 of the ELF header) is zeroed, because the x86_64 emulation of a Mac refuses
# to execute a file that carries it ("Exec format error"); the file runs the same otherwise. Tauri uses the cached copy.
ARG APPIMAGE_PLUGIN_SHA256=49d6a17160675a6bd1781699aae6bdf7692d98552e02a3671d2183d10547842e
RUN mkdir -p /root/.cache/tauri && cd /root/.cache/tauri \
    && curl -fsSL -o linuxdeploy-plugin-appimage.AppImage https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage \
    && echo "${APPIMAGE_PLUGIN_SHA256}  linuxdeploy-plugin-appimage.AppImage" | sha256sum -c - \
    && dd if=/dev/zero of=linuxdeploy-plugin-appimage.AppImage bs=1 seek=8 count=3 conv=notrunc 2>/dev/null \
    && chmod +x linuxdeploy-plugin-appimage.AppImage
WORKDIR /work
