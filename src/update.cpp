#include "update.hpp"
#include "platform.hpp"
#include "sha256.hpp"
#include "signature.hpp"
#include "version.hpp"
#include "weather.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#include <softpub.h>
#include <wincrypt.h>
#include <wintrust.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif
#if defined(__APPLE__)
#include <Security/Security.h>
#endif

namespace fs = std::filesystem;

namespace {

#if defined(_WIN32)
const char* const ASSET = "Soloptima-Setup-windows-x64.exe";
#elif defined(__APPLE__)
const char* const ASSET = "Soloptima-mac.dmg";
#elif defined(__linux__) && defined(__x86_64__)
const char* const ASSET = "Soloptima-linux-x86_64.AppImage";
#else
const char* const ASSET = "";
#endif
const char* const SUMS = "SHA256SUMS.txt";
const char* const SUMS_SIG = "SHA256SUMS.txt.minisig";

// The release keys (minisign public keys). The primary signs every release; the backup stays offline for the day the
// primary is lost or leaks: the next release is then signed with the backup and leaves the primary out of this list.
const char* const RELEASE_KEYS[] = {
    "RWR6YPgDfnr/AvAU3ic9n0SV8Vl2uuwYdTnubgXNIgz2hU3GBtSHbTp1",   // primary, key id 02FF7A7E03F8607A
    "RWSmvzlnQLjAxzvwW72sT00ANO32ly9wtiPeT93cMU4mJenihQuMN/ej",   // backup, key id C7C0B8406739BFA6
#ifdef SOLOPTIMA_TEST_RELEASE_KEY
    SOLOPTIMA_TEST_RELEASE_KEY,   // builds for an update test server only; the release scripts never define it
#endif
};

// The releases API, or a test server given in SOLOPTIMA_UPDATE_URL (a URL returning the same JSON as GitHub's
// /releases/latest); only then may the downloads use plain http.
std::string releases_url() {
    if (const char* e = std::getenv("SOLOPTIMA_UPDATE_URL")) return e;
    return std::string("https://api.github.com/repos/") + SOLOPTIMA_REPO + "/releases/latest";
}
bool allowed_url(const std::string& u) { return u.rfind("https://", 0) == 0 || (std::getenv("SOLOPTIMA_UPDATE_URL") && u.rfind("http://", 0) == 0); }
const std::string& user_agent() { static const std::string ua = std::string("Soloptima/") + SOLOPTIMA_VERSION; return ua; }
// A release version as a tag can carry it: digits and dots, then an optional -suffix (it names a folder)
bool valid_version(const std::string& v) {
    if (v.empty() || v.size() > 40 || !std::isdigit(static_cast<unsigned char>(v[0]))) return false;
    bool suffix = false;
    for (char c : v) {
        if (c == '-' || c == '+') suffix = true;
        else if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '.' || (suffix && std::isalnum(static_cast<unsigned char>(c))))) return false;
    }
    return true;
}

struct Release {
    std::string version, name, notes, url, published, asset_url, sums_url, sig_url;
    long long asset_size = 0;
};
Release latest_release() {
    json::Value d;
    try { d = json::parse(http_get(releases_url(), user_agent())); }
    catch (const std::runtime_error& e) {   // a captive portal or proxy answers with a web page: a worded message, not a defect
        if (std::string(e.what()).rfind("JSON", 0) == 0) throw std::runtime_error("The release list could not be read; check the internet connection.");
        throw;
    }
    Release r;
    r.version = d.gets("tag_name", "");
    if (!r.version.empty() && (r.version[0] == 'v' || r.version[0] == 'V')) r.version.erase(0, 1);
    if (!valid_version(r.version)) throw std::runtime_error("The release list holds no valid version.");
    r.name = d.gets("name", "");
    r.notes = d.gets("body", "").substr(0, 20000);
    r.url = d.gets("html_url", "");
    r.published = d.gets("published_at", "");
    for (const auto& a : d["assets"].arr()) {
        const std::string n = a.gets("name", ""), u = a.gets("browser_download_url", "");
        if (!allowed_url(u)) continue;
        if (*ASSET && n == ASSET) { r.asset_url = u; r.asset_size = (long long)a.get("size", 0); }
        if (n == SUMS) r.sums_url = u;
        if (n == SUMS_SIG) r.sig_url = u;
    }
    return r;
}

std::mutex pending_m;
fs::path pending_file;   // a downloaded and verified installer, and its SHA-256
std::string pending_sha;
std::atomic<bool> downloading{false};

#if defined(__APPLE__) || defined(__linux__)
// Runs `command "<file>"` once this process has ended: the new version would otherwise find this one still running and stop
void run_after_exit(const std::string& command, const fs::path& file) {
    spawn_program({"/bin/sh", "-c", "while kill -0 " + std::to_string(getpid()) + " 2>/dev/null; do sleep 0.2; done; " + command + " \"$0\"",
                   file.string()}, false);
}
#endif

#if defined(_WIN32)
// This copy is the one the setup program installed (a copy run from the zip, e.g. on a USB stick, is not: the setup
// program would install a second one elsewhere, and that one would not see the projects kept next to the zip copy)
bool installed_copy() {
    wchar_t buf[MAX_PATH * 4];
    DWORD size = sizeof buf;
    if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Soloptima", L"InstallLocation", RRF_RT_REG_SZ,
                     nullptr, buf, &size) != ERROR_SUCCESS)
        return false;
    std::error_code ec;
    const auto key = [&](const fs::path& p) {
        std::wstring w = fs::weakly_canonical(p, ec).wstring();
        for (auto& c : w) c = wchar_t(towlower(c));
        while (!w.empty() && (w.back() == L'\\' || w.back() == L'/')) w.pop_back();
        return w;
    };
    return key(fs::path(buf)) == key(exe_dir());
}
// The subject and issuer of the certificate that signed this file (full distinguished names), or "" when it carries no
// valid signature. A display name alone is not unique across certificate authorities.
std::wstring signer_of(const std::wstring& file) {
    WINTRUST_FILE_INFO fi{};
    fi.cbStruct = sizeof fi;
    fi.pcwszFilePath = file.c_str();
    WINTRUST_DATA wd{};
    wd.cbStruct = sizeof wd;
    wd.dwUIChoice = WTD_UI_NONE;
    wd.fdwRevocationChecks = WTD_REVOKE_NONE;
    wd.dwUnionChoice = WTD_CHOICE_FILE;
    wd.pFile = &fi;
    wd.dwStateAction = WTD_STATEACTION_VERIFY;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    std::wstring subject;
    if (WinVerifyTrust(nullptr, &action, &wd) == ERROR_SUCCESS) {
        CRYPT_PROVIDER_DATA* pd = WTHelperProvDataFromStateData(wd.hWVTStateData);
        CRYPT_PROVIDER_SGNR* sg = pd ? WTHelperGetProvSignerFromChain(pd, 0, FALSE, 0) : nullptr;
        CRYPT_PROVIDER_CERT* pc = sg ? WTHelperGetProvCertFromChain(sg, 0) : nullptr;
        wchar_t s[1024], i[1024];
        if (pc && pc->pCert &&
            CertNameToStrW(X509_ASN_ENCODING, &pc->pCert->pCertInfo->Subject, CERT_X500_NAME_STR, s, 1024) > 1 &&
            CertNameToStrW(X509_ASN_ENCODING, &pc->pCert->pCertInfo->Issuer, CERT_X500_NAME_STR, i, 1024) > 1)
            subject = std::wstring(s) + L"\n" + i;
    }
    wd.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &action, &wd);
    return subject;
}
#elif defined(__APPLE__)
bool installed_copy() { return true; }   // any bundle can be swapped; outside one the disk image opens

// The running app bundle (…/Soloptima.app), or empty when the program runs outside one
fs::path app_bundle() {
    const fs::path macos = exe_dir();
    if (macos.filename() != "MacOS" || macos.parent_path().filename() != "Contents") return {};
    const fs::path b = macos.parent_path().parent_path();
    return b.extension() == ".app" ? b : fs::path();
}
// The Apple team that signed the running app, or "" (ad-hoc or unsigned)
std::string own_team() {
    std::string team;
    SecCodeRef self = nullptr;
    CFDictionaryRef info = nullptr;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &self) == errSecSuccess) {
        SecStaticCodeRef st = nullptr;
        if (SecCodeCopyStaticCode(self, kSecCSDefaultFlags, &st) == errSecSuccess) {
            if (SecCodeCopySigningInformation(st, kSecCSSigningInformation, &info) == errSecSuccess && info) {
                const void* t = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
                char buf[64];
                if (t && CFGetTypeID(t) == CFStringGetTypeID() && CFStringGetCString(static_cast<CFStringRef>(t), buf, sizeof buf, kCFStringEncodingUTF8)) team = buf;
                CFRelease(info);
            }
            CFRelease(st);
        }
        CFRelease(self);
    }
    return team;
}
// The new bundle's signature is intact, and when this app is signed by a team, it is signed by the same team
bool trusted_bundle(const fs::path& bundle, const std::string& team) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(nullptr, reinterpret_cast<const UInt8*>(bundle.c_str()), CFIndex(bundle.native().size()), true);
    SecStaticCodeRef code = nullptr;
    SecRequirementRef req = nullptr;
    bool ok = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess;
    if (ok && !team.empty()) {
        const std::string r = "anchor apple generic and certificate leaf[subject.OU] = \"" + team + "\"";
        CFStringRef s = CFStringCreateWithCString(nullptr, r.c_str(), kCFStringEncodingUTF8);
        ok = s && SecRequirementCreateWithString(s, kSecCSDefaultFlags, &req) == errSecSuccess;
        if (s) CFRelease(s);
    }
    ok = ok && SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate, req) == errSecSuccess;
    if (req) CFRelease(req);
    if (code) CFRelease(code);
    if (url) CFRelease(url);
    return ok;
}
// What happened to the update image: swapped in, refused (not intact, or not signed by this app's team), or verified but
// not swappable here (no bundle or no write access), when the user installs it from the opened image
enum class Swap { done, untrusted, manual };

// Mounts the image, checks the app in it, and swaps the installed bundle for it when it can; the new app starts once this
// process has ended. Nothing is changed unless the check passed.
Swap replace_bundle(const fs::path& dmg) {
    std::error_code ec;
    std::string t = (fs::temp_directory_path() / "soloptima-mount-XXXXXX").string();
    if (!mkdtemp(t.data())) return Swap::untrusted;
    const fs::path mnt = t, src = mnt / "Soloptima.app";
    if (spawn_program({"hdiutil", "attach", "-nobrowse", "-noautoopen", "-readonly", "-quiet", "-mountpoint", mnt.string(), dmg.string()}, true) != 0) {
        fs::remove(mnt, ec);
        return Swap::untrusted;
    }
    const auto detach = [&] {
        if (spawn_program({"hdiutil", "detach", "-quiet", mnt.string()}, true) != 0) spawn_program({"hdiutil", "detach", "-force", "-quiet", mnt.string()}, true);
        fs::remove(mnt, ec);
    };
    if (!fs::exists(src / "Contents" / "MacOS" / "Soloptima", ec) || !trusted_bundle(src, own_team())) { detach(); return Swap::untrusted; }
    const fs::path bundle = app_bundle();
    if (bundle.empty() || access(bundle.parent_path().c_str(), W_OK) != 0) { detach(); return Swap::manual; }
    const fs::path stage = bundle.parent_path() / ".Soloptima-update.app", old = bundle.parent_path() / ".Soloptima-old.app";
    fs::remove_all(stage, ec);
    fs::remove_all(old, ec);
    bool ok = spawn_program({"ditto", src.string(), stage.string()}, true) == 0 && trusted_bundle(stage, own_team());
    detach();
    if (ok) {
        fs::rename(bundle, old, ec);
        if (!ec) {
            fs::rename(stage, bundle, ec);
            if (ec) { std::error_code e2; fs::rename(old, bundle, e2); ok = false; }
        } else ok = false;
    }
    fs::remove_all(stage, ec);
    if (!ok) return Swap::untrusted;
    fs::remove_all(old, ec);
    run_after_exit("open", bundle);
    return Swap::done;
}
#elif defined(__linux__)
// Only an AppImage updates itself: the runtime gives its path in APPIMAGE (a copy from the .tar.gz uses the release page)
fs::path appimage() { const char* a = std::getenv("APPIMAGE"); return a && *a ? fs::path(a) : fs::path(); }
bool installed_copy() { return *ASSET && !appimage().empty() && access(appimage().parent_path().c_str(), W_OK) == 0; }
#else
bool installed_copy() { return false; }
#endif

// A new folder only this user can write, under an unpredictable name, so nobody else can place, swap or link files where
// the update is downloaded, checked and installed from. This user's earlier ones go first (a setup program cannot delete
// itself).
fs::path private_update_dir() {
    const fs::path tmp = fs::temp_directory_path();
    std::error_code ec;
    for (auto it = fs::directory_iterator(tmp, ec); !ec && it != fs::directory_iterator(); it.increment(ec)) {
        if (it->path().filename().string().rfind("Soloptima-update", 0) != 0) continue;
#ifdef _WIN32
        std::error_code e2;
        if (it->is_symlink(e2) || !it->is_directory(e2)) continue;
#else
        struct stat st {};
        if (::lstat(it->path().c_str(), &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != ::geteuid()) continue;
#endif
        std::error_code e3;
        fs::remove_all(it->path(), e3);
    }
#ifdef _WIN32
    const fs::path d = tmp / ("Soloptima-update-" + random_hex(8));   // %TEMP% belongs to the user
    if (!fs::create_directory(d)) throw std::runtime_error("Cannot create a folder for the download.");
    return d;
#else
    std::string t = (tmp / "Soloptima-update-XXXXXX").string();   // mode 0700
    if (!mkdtemp(t.data())) throw std::runtime_error("Cannot create a folder for the download.");
    return fs::path(t);
#endif
}

} // namespace

std::vector<MinisignKey> release_keys() {
    std::vector<MinisignKey> keys;
    for (const char* k : RELEASE_KEYS) keys.push_back(minisign_key(k));
    return keys;
}

void check_release_signature(const std::string& sums, const std::string& sig, const std::string& version,
                             const std::vector<MinisignKey>& keys) {
    std::string comment;
    try { comment = minisign_verify(sums, sig, keys); }
    catch (const std::exception&) {
        throw std::runtime_error("Release " + version + " is not signed with the Soloptima release key, so it was not downloaded.");
    }
    if (comment != "soloptima " + version + " " + SUMS)
        throw std::runtime_error("The signature of release " + version + " was made for another release, so it was not downloaded.");
}

int compare_versions(const std::string& a, const std::string& b) {
    const auto parts = [](std::string s) {
        if (!s.empty() && (s[0] == 'v' || s[0] == 'V')) s.erase(0, 1);
        s = s.substr(0, s.find_first_of("-+"));
        std::vector<long> v;
        std::stringstream ss(s);
        std::string x;
        while (std::getline(ss, x, '.')) v.push_back(std::atol(x.c_str()));
        return v;
    };
    std::vector<long> x = parts(a), y = parts(b);
    x.resize(std::max(x.size(), y.size()));
    y.resize(x.size());
    for (size_t i = 0; i < x.size(); ++i)
        if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

json::Value update_check(bool app_mode) {
    const Release r = latest_release();
    const bool newer = compare_versions(r.version, SOLOPTIMA_VERSION) > 0;
    json::Value asset;
    if (!r.asset_url.empty()) asset = json::Value(json::Object{{"name", ASSET}, {"size", double(r.asset_size)}});
    return json::Value(json::Object{{"current", SOLOPTIMA_VERSION}, {"latest", r.version}, {"newer", newer}, {"name", r.name},
                                    {"notes", r.notes}, {"url", r.url}, {"published", r.published}, {"asset", asset},
                                    {"installable", app_mode && installed_copy() && !r.asset_url.empty() && !r.sums_url.empty() && !r.sig_url.empty()},
                                    {"downloading", downloading.load()}});
}

json::Value update_download(Progress& prog) {
    if (downloading.exchange(true)) throw std::runtime_error("A download of the update is already running.");
    struct Done { ~Done() { downloading = false; } } done;
    // the download address comes from the release list, never from the request
    const Release r = latest_release();
    if (compare_versions(r.version, SOLOPTIMA_VERSION) <= 0) throw std::runtime_error("Soloptima is up to date.");
    if (r.asset_url.empty() || r.sums_url.empty())
        throw std::runtime_error("Release " + r.version + " has no installer for this system or no checksum list. Download it from the release page.");
    if (r.sig_url.empty()) throw std::runtime_error("Release " + r.version + " is not signed, so it cannot be installed from the app. Download it from the release page.");
    const std::string list = http_get(r.sums_url, user_agent());
    check_release_signature(list, http_get(r.sig_url, user_agent()), r.version);
    std::string expected;
    std::istringstream sums(list);
    for (std::string line; std::getline(sums, line);) {
        std::istringstream ls(line);
        std::string hash, name;
        ls >> hash >> name;
        if (!name.empty() && name[0] == '*') name.erase(0, 1);   // "hash *name" (binary mode) as written by some tools
        if (name == ASSET) expected = hash;
    }
    for (auto& c : expected) c = char(std::tolower(static_cast<unsigned char>(c)));
    if (expected.size() != 64) throw std::runtime_error("The checksum list of release " + r.version + " does not cover " + ASSET + ".");
    const fs::path dir = private_update_dir(), file = dir / ASSET;
    std::error_code ec;
    const fs::path part = dir / (std::string(ASSET) + ".part");   // under its own name until it is verified
    prog.total = std::max(1LL, r.asset_size);
    http_download(r.asset_url, part, [&](long long d) { prog.done = d; return !prog.cancel; }, user_agent());
    const long long size = (long long)fs::file_size(part, ec);
    const std::string got = Sha256::of_file(part);
    if (got != expected || (r.asset_size > 0 && size != r.asset_size)) {
        fs::remove(part, ec);
        throw std::runtime_error("The downloaded installer does not match the release's checksum, so it was deleted. Try again later.");
    }
    fs::rename(part, file);
    std::lock_guard<std::mutex> g(pending_m);
    pending_file = file;
    pending_sha = got;
    return json::Value(json::Object{{"version", r.version}, {"size", double(size)}, {"sha256", got}});
}

json::Value update_install(bool app_mode) {
    if (!app_mode) throw std::runtime_error("Updates install from the desktop app. Download the new version from the release page.");
    if (!installed_copy()) throw std::runtime_error("This copy was not installed with the setup program. Download the new version from the release page.");
    fs::path file;
    std::string sha;
    {
        std::lock_guard<std::mutex> g(pending_m);
        file = pending_file;
        sha = pending_sha;
    }
    std::error_code ec;
    if (file.empty() || !fs::exists(file, ec)) throw std::runtime_error("Download the update first.");
    if (Sha256::of_file(file) != sha) throw std::runtime_error("The downloaded installer has changed since it was checked. Download it again.");
#if defined(_WIN32)
    // a signed copy of Soloptima runs only a setup program signed by the same publisher
    const std::wstring own = signer_of(exe_dir() / L"Soloptima.exe");
    if (!own.empty() && signer_of(file.wstring()) != own)
        throw std::runtime_error("The update's setup program is not signed by the publisher of this copy of Soloptima, so it was not started.");
    // the setup program waits until Soloptima has closed, installs over it and offers to start it again
    const auto rc = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", file.wstring().c_str(), L"/UPDATE", nullptr, SW_SHOWNORMAL));
    if (rc <= 32) throw std::runtime_error("The setup program could not be started (Windows error " + std::to_string(rc) + ").");
    return json::Value(json::Object{{"mode", "installer"}});
#elif defined(__APPLE__)
    switch (replace_bundle(file)) {
    case Swap::done:
        fs::remove_all(file.parent_path(), ec);
        return json::Value(json::Object{{"mode", "replaced"}});
    case Swap::untrusted:
        throw std::runtime_error("The update's app is damaged or not signed by the publisher of this copy of Soloptima, so it was not installed.");
    case Swap::manual: break;   // checked, but this copy cannot be replaced in place: the user drags it from the image
    }
    if (spawn_program({"open", file.string()}, true) != 0) throw std::runtime_error("The disk image could not be opened: " + file.u8string());
    return json::Value(json::Object{{"mode", "opened"}});
#elif defined(__linux__)
    // the new AppImage goes to a new file under an unused name beside the old one (created exclusively, never through a
    // name or link already there) and replaces it in one rename; the running one keeps its open copy
    const fs::path target = appimage();
    fs::path stage;
    int out = -1;
    for (int i = 0; i < 8 && out < 0; ++i) {
        stage = target.parent_path() / (".Soloptima-update-" + random_hex(6) + ".AppImage");
        out = ::open(stage.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0700);
    }
    const int in = ::open(file.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    bool ok = out >= 0 && in >= 0;
    char buf[1 << 16];
    for (ssize_t k; ok && (k = ::read(in, buf, sizeof buf)) != 0;) {
        if (k < 0) { ok = false; break; }
        for (ssize_t w = 0; ok && w < k;) { const ssize_t n = ::write(out, buf + w, size_t(k - w)); if (n <= 0) ok = false; else w += n; }
    }
    if (in >= 0) ::close(in);
    if (out >= 0) { ok = ::fchmod(out, 0755) == 0 && ok; ok = ::close(out) == 0 && ok; }
    if (ok) fs::rename(stage, target, ec);
    if (!ok || ec) { if (out >= 0) fs::remove(stage, ec); throw std::runtime_error("The new version could not be written next to the AppImage."); }
    fs::remove_all(file.parent_path(), ec);
    run_after_exit("exec", target);
    return json::Value(json::Object{{"mode", "replaced"}});
#else
    throw std::runtime_error("This system has no installer; build Soloptima from the source.");
#endif
}
