#define _CRT_RAND_S   // rand_s: the system generator
#include "platform.hpp"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#else
#include <cerrno>
#include <climits>
#include <fcntl.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

namespace fs = std::filesystem;

fs::path exe_dir() {
#if defined(_WIN32)
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(nullptr, buf, DWORD(sizeof buf / sizeof buf[0]));
    if (n > 0) return fs::path(std::wstring(buf, n)).parent_path();
#elif defined(__APPLE__)
    char buf[PATH_MAX * 2];
    uint32_t size = sizeof buf;
    if (_NSGetExecutablePath(buf, &size) == 0) {
        std::error_code ec;
        fs::path p = fs::canonical(buf, ec);
        return (ec ? fs::path(buf) : p).parent_path();
    }
#else
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (n > 0) return fs::path(std::string(buf, size_t(n))).parent_path();
#endif
    return fs::current_path();
}

fs::path user_data_dir() {
#if defined(_WIN32)
    if (const wchar_t* la = _wgetenv(L"LOCALAPPDATA")) return fs::path(la) / L"Soloptima";
    if (const wchar_t* up = _wgetenv(L"USERPROFILE")) return fs::path(up) / L"Soloptima";
#elif defined(__APPLE__)
    if (const char* h = std::getenv("HOME")) return fs::path(h) / "Library" / "Application Support" / "Soloptima";
#else
    if (const char* x = std::getenv("XDG_DATA_HOME")) return fs::path(x) / "Soloptima";
    if (const char* h = std::getenv("HOME")) return fs::path(h) / ".local" / "share" / "Soloptima";
#endif
    return fs::current_path() / "data";
}

#if defined(_WIN32)
std::wstring widen(const std::string& s) {
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), nullptr, 0);
    std::wstring w(size_t(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), w.data(), n);
    return w;
}
#else
int spawn_program(const std::vector<std::string>& args, bool wait) {
    std::vector<char*> argv;
    for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
    argv.push_back(nullptr);
    posix_spawnattr_t attr;
    posix_spawn_file_actions_t files;
    posix_spawnattr_init(&attr);
#if defined(__APPLE__)
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);   // nothing else open is inherited either
#endif
    posix_spawn_file_actions_init(&files);
    for (int fd = 0; fd < 3; ++fd) posix_spawn_file_actions_addopen(&files, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0);
    pid_t pid;
    const int rc = posix_spawnp(&pid, argv[0], &files, &attr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&files);
    posix_spawnattr_destroy(&attr);
    if (rc != 0) return -1;
    if (!wait) {   // reap it when it ends, so a long-running app does not collect zombies
        std::thread([pid] { waitpid(pid, nullptr, 0); }).detach();
        return 0;
    }
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return -1;
    return WIFEXITED(st) ? WEXITSTATUS(st) : -1;
}
#endif

void replace_file(const std::filesystem::path& from, const std::filesystem::path& to) {
#if defined(_WIN32)
    if (!MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::filesystem::filesystem_error("replace_file", from, to, std::error_code(int(GetLastError()), std::system_category()));
#else
    std::filesystem::rename(from, to);
#endif
}

void make_private_dirs(const std::filesystem::path& p) {
    std::error_code ec;
    if (p.empty() || std::filesystem::is_directory(p, ec)) return;
    if (p.parent_path() != p) make_private_dirs(p.parent_path());   // a root has itself as parent: creating it fails below
#if defined(_WIN32)
    std::filesystem::create_directory(p);   // under the user's profile the inherited ACL already keeps others out
#else
    if (::mkdir(p.c_str(), 0700) != 0 && errno != EEXIST)   // never readable by others, not even for a moment
        throw std::filesystem::filesystem_error("Cannot create a folder", p, std::error_code(errno, std::generic_category()));
#endif
}

std::string base64_decode(const std::string& in) {
    static const std::string digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto bad = [] { return std::runtime_error("Not valid base64."); };
    if (in.size() % 4 != 0) throw bad();
    const size_t pad = in.empty() ? 0 : in.size() - 1 - in.find_last_not_of('=');
    if (pad > 2) throw bad();
    std::string out;
    uint32_t acc = 0;
    for (size_t i = 0; i < in.size() - pad; ++i) {
        const size_t v = digits.find(in[i]);
        if (v == std::string::npos) throw bad();
        acc = acc << 6 | uint32_t(v);
        if (i % 4 == 3) {
            out += {char(acc >> 16), char(acc >> 8), char(acc)};
            acc = 0;
        }
    }
    if (pad == 1) out += {char(acc >> 10), char(acc >> 2)};   // 18 bits: two bytes
    if (pad == 2) out += char(acc >> 4);                       // 12 bits: one byte
    return out;
}

bool read_file(const std::filesystem::path& p, std::string& out) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

std::tm utc_tm(std::time_t t) {
    static std::mutex m;
    std::lock_guard<std::mutex> g(m);
    return *std::gmtime(&t);
}

std::string utc_now_iso() {
    const std::tm u = utc_tm(std::time(nullptr));
    char b[32];
    std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &u);
    return b;
}

std::string random_hex(size_t bytes) {
    std::string out;
    char b[3];
    for (size_t i = 0; i < bytes; ++i) {
        unsigned v = 0;
#if defined(_WIN32)
        if (rand_s(&v) != 0) throw std::runtime_error("No random numbers from the system.");
#else
        static std::FILE* f = std::fopen("/dev/urandom", "rb");
        unsigned char c = 0;
        if (!f || std::fread(&c, 1, 1, f) != 1) throw std::runtime_error("No random numbers from the system.");
        v = c;
#endif
        std::snprintf(b, sizeof b, "%02x", v & 0xffu);
        out += b;
    }
    return out;
}

void attach_console() {
#if defined(_WIN32)
    if (GetConsoleWindow() == nullptr && AttachConsole(ATTACH_PARENT_PROCESS)) {
        std::FILE* f = nullptr;
        freopen_s(&f, "CONOUT$", "w", stdout);
        freopen_s(&f, "CONOUT$", "w", stderr);
    }
#endif
}
