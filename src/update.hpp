// Updates from the project's GitHub releases. A release carries the installer of each system under a fixed name
// (Soloptima-Setup-windows-x64.exe, Soloptima-mac.dmg, Soloptima-linux-x86_64.AppImage), SHA256SUMS.txt and its minisign
// signature SHA256SUMS.txt.minisig; the version is the release tag (v1.2.0).
// Nothing is downloaded until the user confirms. The checksum list counts only when it is signed with a release key for
// that version, and a download is used only when its SHA-256 matches the list.
#pragma once
#include "json.hpp"
#include "optimizer.hpp"   // Progress
#include "signature.hpp"
#include <string>
#include <vector>

// The latest release against this build: {current, latest, newer, name, notes, url, published, asset, installable,
// downloading}.
// installable is false where this build cannot install updates itself (no installer for the system, or the browser mode).
json::Value update_check(bool app_mode);
// Downloads the installer of the latest release (progress in bytes) and checks it against SHA256SUMS.txt.
json::Value update_download(Progress& prog);
// Starts installing the downloaded update: {mode: "installer" | "replaced" | "opened"}. The app must quit right after.
json::Value update_install(bool app_mode);
// "1.10.0" > "1.9.2"; a leading "v" and anything after a "-" are ignored.
int compare_versions(const std::string& a, const std::string& b);
// The minisign keys a release's checksum list must be signed with
std::vector<MinisignKey> release_keys();
// Throws unless `sig` is a signature of `sums` by one of `keys` whose trusted comment names release `version`
// ("soloptima 1.2.0 SHA256SUMS.txt"), so the signed list of an older release cannot stand in for a newer one.
void check_release_signature(const std::string& sums, const std::string& sig, const std::string& version,
                             const std::vector<MinisignKey>& keys = release_keys());
